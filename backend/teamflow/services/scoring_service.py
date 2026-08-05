"""기여도 서비스 — 이벤트 로그에서 점수를 재계산한다.

docs/05-기여도-산정-설계.md §1

점수를 조회하는 게 아니라 **매번 다시 계산한다.**
    점수 = f(불변 이벤트 로그, 가중치 버전, 역할)

그래야 가중치를 바꿔도 과거가 오염되지 않고, 모든 숫자에 근거 이벤트가 붙는다.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from teamflow.contribution.confidence import CoverageStats
from teamflow.contribution.events import ContributionEvent, EventType, SourceKind
from teamflow.contribution.profiles import (
    DEFAULT_PROFILES,
    Role,
    ScoringProfile,
    blended_profile,
)
from teamflow.contribution.scoring import TeamScoreResult, score_team
from teamflow.db import models as m


def load_events(session: Session, project_id: int) -> dict[int, list[ContributionEvent]]:
    rows = session.scalars(
        select(m.ContributionEventRow).where(
            m.ContributionEventRow.project_id == project_id
        )
    ).all()

    by_user: dict[int, list[ContributionEvent]] = {}
    for row in rows:
        by_user.setdefault(row.user_id, []).append(
            ContributionEvent(
                user_id=row.user_id,
                event_type=EventType(row.event_type),
                occurred_at=row.occurred_at,
                source_kind=SourceKind(row.source_kind),
                source_id=row.source_id,
                magnitude=float(row.magnitude or 0.0),
                metadata=dict(row.event_metadata or {}),
            )
        )
    return by_user


def load_profiles(session: Session, project_id: int) -> dict[int, ScoringProfile]:
    """멤버의 역할 비중에서 가중치 프로파일을 만든다.

    겸직(개발 70% + 기획 30%)은 혼합 프로파일이 된다.
    """
    members = session.scalars(
        select(m.Member).where(m.Member.project_id == project_id)
    ).all()

    profiles: dict[int, ScoringProfile] = {}
    for member in members:
        shares_raw = member.role_shares or {}
        shares: dict[Role, float] = {}
        for key, value in shares_raw.items():
            try:
                shares[Role(key)] = float(value)
            except (ValueError, TypeError):
                continue

        if not shares or sum(shares.values()) <= 0:
            profiles[member.user_id] = DEFAULT_PROFILES[Role.DEVELOPER]
        elif len(shares) == 1:
            profiles[member.user_id] = DEFAULT_PROFILES[next(iter(shares))]
        else:
            profiles[member.user_id] = blended_profile(shares)
    return profiles


def load_coverage(session: Session, project_id: int) -> CoverageStats:
    """신뢰도 계산의 입력. 데이터가 얼마나 갖춰졌는지."""
    meetings_total = (
        session.scalar(
            select(func.count(m.Meeting.id)).where(m.Meeting.project_id == project_id)
        )
        or 0
    )
    meetings_recorded = (
        session.scalar(
            select(func.count(m.Meeting.id)).where(
                m.Meeting.project_id == project_id,
                m.Meeting.status.in_(("confirmed", "needs_review")),
            )
        )
        or 0
    )

    meeting_ids = select(m.Meeting.id).where(m.Meeting.project_id == project_id)
    utterances_total = (
        session.scalar(
            select(func.count(m.Utterance.id)).where(m.Utterance.meeting_id.in_(meeting_ids))
        )
        or 0
    )
    # 화자가 확정된 발화 — 멀티트랙(track)이거나 사람이 지정(manual)한 것.
    # diarization 은 SPEAKER_XX 미매핑이라 불확실로 본다. docs/06 §4
    utterances_certain = (
        session.scalar(
            select(func.count(m.Utterance.id)).where(
                m.Utterance.meeting_id.in_(meeting_ids),
                m.Utterance.speaker_source.in_(("track", "manual")),
            )
        )
        or 0
    )

    project = session.get(m.Project, project_id)
    project_days = 0
    github_days = 0
    if project and project.started_at:
        end = project.deadline or datetime.now(project.started_at.tzinfo)
        project_days = max(0, (end - project.started_at).days)
        if project.github_connected_at:
            github_days = max(0, (end - project.github_connected_at).days)

    member_count = (
        session.scalar(
            select(func.count(m.Member.id)).where(m.Member.project_id == project_id)
        )
        or 0
    )
    peer_expected = member_count * max(0, member_count - 1)
    peer_submitted = (
        session.scalar(
            select(func.count(m.PeerReview.id)).where(
                m.PeerReview.project_id == project_id
            )
        )
        or 0
    )

    return CoverageStats(
        meetings_total=meetings_total,
        meetings_recorded=meetings_recorded,
        utterances_total=utterances_total,
        utterances_speaker_certain=utterances_certain,
        project_days=project_days,
        github_connected_days=min(github_days, project_days) if project_days else 0,
        peer_reviews_expected=peer_expected,
        peer_reviews_submitted=peer_submitted,
    )


def compute(session: Session, project_id: int) -> TeamScoreResult:
    """프로젝트 기여도를 재계산한다."""
    profiles = load_profiles(session, project_id)
    events = load_events(session, project_id)

    # 이벤트가 없는 멤버도 결과에 포함되어야 한다 (0%로 표시).
    # 빠뜨리면 "내가 왜 목록에 없냐"는 문의가 온다.
    for user_id in profiles:
        events.setdefault(user_id, [])

    return score_team(events, profiles, load_coverage(session, project_id))
