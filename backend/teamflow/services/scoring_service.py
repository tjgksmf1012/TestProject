"""기여도 서비스 — 이벤트 로그에서 점수를 재계산한다.

docs/05-기여도-산정-설계.md §1

점수를 조회하는 게 아니라 **매번 다시 계산한다.**
    점수 = f(불변 이벤트 로그, 가중치 버전, 역할)

그래야 가중치를 바꿔도 과거가 오염되지 않고, 모든 숫자에 근거 이벤트가 붙는다.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from teamflow.contribution.confidence import CoverageStats
from teamflow.contribution.events import (
    Category,
    ContributionEvent,
    EventType,
    SourceKind,
)
from teamflow.contribution.profiles import (
    DEFAULT_PROFILES,
    Role,
    ScoringProfile,
    blended_profile,
)
from teamflow.contribution.scoring import MeasurementGap, TeamScoreResult, score_team
from teamflow.db import models as m
from teamflow.jobs import retention


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

    # 녹음 트랙 품질. 이 신호가 없으면 망가진 녹음이 오히려 높은 신뢰도로
    # 보인다 — 멀티트랙에서는 화자 확정도가 항상 1.0 이기 때문이다.
    tracks_total = (
        session.scalar(
            select(func.count(m.MeetingTrack.id)).where(
                m.MeetingTrack.meeting_id.in_(meeting_ids),
                m.MeetingTrack.ended_at.is_not(None),
            )
        )
        or 0
    )
    tracks_usable = (
        session.scalar(
            select(func.count(m.MeetingTrack.id)).where(
                m.MeetingTrack.meeting_id.in_(meeting_ids),
                m.MeetingTrack.status == "completed",
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
        # ⚠️ `github_connected_at`(이름을 **적어 넣은** 시각)이 아니라
        # `github_verified_at`(서명된 배달이 **처음 도착한** 시각)입니다.
        #
        # 예전에는 앞엣것을 썼습니다. 그래서 저장소 이름을 적기만 하면 —
        # 오타여도, App 을 설치하지 않았어도 — `github_coverage` 가 1.0 이
        # 됐습니다. GitHub 이벤트가 **0건**인 프로젝트가 "신뢰도 보통" 으로
        # 나왔습니다.
        #
        # 신뢰도는 "얼마나 많은 근거로 계산했는가" 입니다. 근거가 없는데
        # 높게 나오면 그건 신뢰도가 아니라 거짓말이고, 이 시스템에서는
        # 성적에 쓰일 수 있는 값을 뒷받침하는 숫자입니다.
        if project.github_verified_at:
            github_days = max(0, (end - project.github_verified_at).days)

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
        tracks_total=tracks_total,
        tracks_usable=tracks_usable,
        project_days=project_days,
        github_connected_days=min(github_days, project_days) if project_days else 0,
        peer_reviews_expected=peer_expected,
        peer_reviews_submitted=peer_submitted,
    )


# 이 사람 트랙의 절반 넘게 못 쓰게 됐으면 회의 기여도를 "측정 불가"로 본다.
#
# 왜 0.5 인가: 회의 한 번 끊긴 걸로 회의 영역을 통째로 빼면 과잉 반응이다.
# 절반을 넘겨 잃으면 남은 데이터로 비교하는 게 더 위험해진다.
#
# ⚠️ 남는 한계: 5번 중 1번을 잃은 사람은 여전히 조금 불리하다. 그건
# 프로젝트 전체 신뢰도(track_quality)에 반영될 뿐 개인 보정은 하지 않는다.
# 근거 없이 보정하면 그게 또 다른 왜곡이다. (docs/05 §4.1)
MIN_MEASURABLE_TRACK_RATIO = 0.5


def load_measurement_gaps(
    session: Session, project_id: int
) -> dict[int, list[MeasurementGap]]:
    """녹음이 끊겨 발언량을 측정할 수 없는 사람을 찾는다.

    **0점을 주지 않기 위한 함수다.** 폰이 잠긴 사람을 "말을 안 한 사람"으로
    처리하면 측정이 아니라 오답이다 (docs/04 §2.6).
    """
    meeting_ids = select(m.Meeting.id).where(m.Meeting.project_id == project_id)
    rows = session.execute(
        select(
            m.MeetingTrack.user_id,
            func.count(m.MeetingTrack.id),
            func.sum(case((m.MeetingTrack.status == "completed", 1), else_=0)),
        )
        .where(
            m.MeetingTrack.meeting_id.in_(meeting_ids),
            m.MeetingTrack.ended_at.is_not(None),
        )
        .group_by(m.MeetingTrack.user_id)
    ).all()

    gaps: dict[int, list[MeasurementGap]] = {}
    for user_id, total, usable in rows:
        total = int(total or 0)
        usable = int(usable or 0)
        if total == 0 or usable / total >= MIN_MEASURABLE_TRACK_RATIO:
            continue
        gaps[user_id] = [
            MeasurementGap(
                category=Category.MEETING,
                reason=(
                    f"녹음 {total}건 중 {total - usable}건이 끊겼습니다. "
                    "발언량을 측정할 수 없어 회의 기여도를 계산에서 제외했습니다"
                ),
                detail={"tracks_total": total, "tracks_usable": usable},
            )
        ]

    for user_id, gap in _gaps_from_deleted_audio(session, project_id).items():
        # 녹음이 끊긴 사람이 삭제까지 했으면 둘 다 적는다. 둘은 다른
        # 사실이고, 화면이 한쪽만 보여주면 나머지 하나가 사라진다.
        gaps.setdefault(user_id, []).append(gap)
    return gaps


#: `deleted_reason` 별 문구.
#:
#: ⭐ **"녹음이 끊겼습니다" 와 같은 말을 쓰면 안 된다.** 끊긴 것은 다음 회의에
#: 화면을 켜 두면 고쳐지지만, 만료와 삭제 요청은 그렇지 않다. 같은 문구가
#: 나가면 팀이 엉뚱한 대응을 하고, 삭제를 요청한 사람은 자기 권리 행사가
#: 사고처럼 적힌 것을 보게 된다.
_DELETION_REASON_TEXT = {
    retention.REASON_USER_REQUEST: (
        "본인 요청으로 녹음 원본을 삭제했습니다 (개인정보 삭제 요청). "
        "발언량을 측정할 수 없어 회의 기여도를 계산에서 제외했습니다"
    ),
    retention.REASON_RETENTION_EXPIRED: (
        "보존기간이 지나 녹음 원본이 삭제됐습니다. "
        "발언량을 측정할 수 없어 회의 기여도를 계산에서 제외했습니다"
    ),
}

_DELETION_REASON_UNKNOWN = (
    "녹음 원본이 삭제됐습니다 (사유 미기록). "
    "발언량을 측정할 수 없어 회의 기여도를 계산에서 제외했습니다"
)


def _gaps_from_deleted_audio(
    session: Session, project_id: int
) -> dict[int, MeasurementGap]:
    """원본이 지워져 **다시는 잴 수 없는** 회의 기여를 찾는다.

    ## 왜 필요한가

    ⚠️ 원본을 지워도 트랙 행은 `status='completed'` 로 남습니다. 그래서
    위쪽 검사는 그걸 **정상 측정된 트랙으로 셉니다.** 아직 처리되지 않은
    회의였다면 그 사람의 발화는 0건이 되고, 결과는 측정 불가가 아니라
    **사실상 0점**입니다 — "말을 안 한 사람" 과 구분되지 않습니다.

    이건 이 시스템이 가장 하지 말아야 할 일입니다 (docs/04 §2.6,
    docs/05 §5 — 측정 불가는 0점이 아니다).

    ## 이미 처리된 회의는 건드리지 않는다

    전사 텍스트가 남아 있으면 회의 기여는 **측정된 것**입니다. 원본만
    없을 뿐입니다. 그걸 측정 불가로 만들면 정당하게 잰 값을 지우는 셈이고,
    그건 반대 방향의 오답입니다.

    그래서 **발화가 하나도 없는 트랙만** 대상입니다. 판단 기준을 "삭제
    여부" 가 아니라 "잴 수 있는 근거가 남아 있는가" 로 둡니다.

    ## 사유를 구분해서 돌려준다

    만료·삭제 요청·녹음 끊김은 사람이 할 일이 전부 다릅니다. `reason`
    문자열이 화면까지 그대로 갑니다 (`contribution/view.ts`).
    """
    deleted = session.execute(
        select(
            m.MeetingTrack.user_id,
            m.AudioAsset.track_id,
            m.AudioAsset.deleted_reason,
        )
        .join(m.MeetingTrack, m.MeetingTrack.id == m.AudioAsset.track_id)
        .join(m.Meeting, m.Meeting.id == m.MeetingTrack.meeting_id)
        .where(
            m.Meeting.project_id == project_id,
            m.AudioAsset.kind == "raw",
            m.AudioAsset.deleted_at.is_not(None),
        )
    ).all()
    if not deleted:
        return {}

    # 근거가 남아 있는 트랙(발화가 있는 트랙)은 제외한다.
    track_ids = {row.track_id for row in deleted}
    with_evidence = set(
        session.scalars(
            select(m.Utterance.track_id).where(m.Utterance.track_id.in_(track_ids))
        ).all()
    )

    #: 사람마다 사유가 섞일 수 있다(하나는 만료, 하나는 삭제 요청).
    #: 그때는 **본인 요청을 우선**한다 — 사람이 직접 한 일이 더 중요한
    #: 사실이고, 만료는 시간이 지나면 어차피 전부에게 일어난다.
    priority = {retention.REASON_USER_REQUEST: 0, retention.REASON_RETENTION_EXPIRED: 1}
    chosen: dict[int, tuple[int, str | None, int]] = {}
    for row in deleted:
        if row.track_id in with_evidence:
            continue
        rank = priority.get(row.deleted_reason or "", 2)
        current = chosen.get(row.user_id)
        count = (current[2] if current else 0) + 1
        if current is None or rank < current[0]:
            chosen[row.user_id] = (rank, row.deleted_reason, count)
        else:
            chosen[row.user_id] = (current[0], current[1], count)

    return {
        user_id: MeasurementGap(
            category=Category.MEETING,
            reason=_DELETION_REASON_TEXT.get(reason or "", _DELETION_REASON_UNKNOWN),
            detail={"tracks_deleted": count, "deleted_reason": reason or "unknown"},
        )
        for user_id, (_, reason, count) in chosen.items()
    }


def compute(session: Session, project_id: int) -> TeamScoreResult:
    """프로젝트 기여도를 재계산한다."""
    profiles = load_profiles(session, project_id)
    events = load_events(session, project_id)

    # 이벤트가 없는 멤버도 결과에 포함되어야 한다 (0%로 표시).
    # 빠뜨리면 "내가 왜 목록에 없냐"는 문의가 온다.
    for user_id in profiles:
        events.setdefault(user_id, [])

    return score_team(
        events,
        profiles,
        load_coverage(session, project_id),
        unmeasurable=load_measurement_gaps(session, project_id),
    )
