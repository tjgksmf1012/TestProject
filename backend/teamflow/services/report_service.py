"""보고서를 만들어 저장한다.

여기가 **데이터베이스를 아는 쪽**입니다. 내용을 만드는 판단은 전부
`teamflow/reports/` 의 순수 함수에 있고, 이 파일은 재료를 모아 넘기고
결과를 저장하는 일만 합니다 — `scoring_service` 와 `contribution/scoring`
의 관계와 같습니다.

⚠️ **기여도를 다시 계산하지 않습니다.** `scoring_service.compute` 를 그대로
부릅니다. 여기서 한 벌 더 만들면 보고서의 숫자와 화면의 숫자가 갈라지고,
갈라진 쪽이 제출물이 됩니다.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from teamflow.db import models as m
from teamflow.db.vocab import REPORT_SCOPE, ReportScope, ReportType
from teamflow.reports import minutes as minutes_builder
from teamflow.reports import period as period_builder
from teamflow.reports import scope_key
from teamflow.services import scoring_service

#: 트랙이 이 상태면 그 사람의 그 구간은 **못 잰** 것입니다.
_BROKEN_TRACK = {"unusable", "aborted"}


class ReportError(Exception):
    """부를 수 없는 요청. API 가 400/404 로 옮깁니다."""


# ══════════════════════════════════════════════════════════════
# 저장 — 다시 만들면 갈아끼운다
# ══════════════════════════════════════════════════════════════


def _upsert(
    session: Session,
    *,
    project_id: int,
    report_type: ReportType,
    key: str,
    content: dict,
    meeting_id: int | None = None,
    period_start: datetime | None = None,
    period_end: datetime | None = None,
) -> m.Report:
    """있으면 갈아끼우고 없으면 만든다.

    ⚠️ **쌓으면 안 됩니다.** 이 저장소는 그 결함을 이미 한 번 당했습니다 —
    미해결 사안이 재처리마다 한 벌씩 쌓였습니다. 보고서에서 그러면 "최종
    보고서" 가 여러 벌 생기고 어느 것이 진짜인지 아무도 모릅니다.

    데이터베이스에도 `uq_report_scope` 유일 제약이 있습니다. 여기가 유일한
    쓰기 경로여도 그렇게 둔 이유는, 다른 경로가 하나 생기는 순간(배치·재처리·
    수동 스크립트) 갈라지고 **쌓이기 시작해도 오류가 안 나기** 때문입니다.
    """
    existing = session.scalars(
        select(m.Report).where(
            m.Report.project_id == project_id,
            m.Report.report_type == str(report_type),
            m.Report.scope_key == key,
        )
    ).one_or_none()

    if existing is not None:
        existing.content = content
        existing.meeting_id = meeting_id
        existing.period_start = period_start
        existing.period_end = period_end
        existing.generated_at = datetime.now(existing.generated_at.tzinfo)
        session.flush()
        return existing

    report = m.Report(
        project_id=project_id,
        report_type=str(report_type),
        scope_key=key,
        meeting_id=meeting_id,
        period_start=period_start,
        period_end=period_end,
        content=content,
    )
    session.add(report)
    session.flush()
    return report


# ══════════════════════════════════════════════════════════════
# 회의록
# ══════════════════════════════════════════════════════════════


def generate_minutes(session: Session, meeting_id: int) -> m.Report:
    meeting = session.get(m.Meeting, meeting_id)
    if meeting is None:
        raise ReportError("회의를 찾을 수 없습니다")

    issues = session.scalars(
        select(m.MeetingEvent)
        .where(
            m.MeetingEvent.meeting_id == meeting.id,
            m.MeetingEvent.event_type == "unanswered_question",
        )
        .order_by(m.MeetingEvent.start_ms, m.MeetingEvent.id)
    ).all()

    candidates = session.scalars(
        select(m.MeetingTaskCandidate)
        .where(m.MeetingTaskCandidate.meeting_id == meeting.id)
        .order_by(m.MeetingTaskCandidate.id)
    ).all()

    tracks = session.scalars(
        select(m.MeetingTrack).where(m.MeetingTrack.meeting_id == meeting.id)
    ).all()

    data = minutes_builder.MinutesInput(
        meeting_title=meeting.title or f"회의 #{meeting.id}",
        status=meeting.status,
        capture_mode=meeting.capture_mode,
        started_at=meeting.started_at,
        summary=meeting.summary,
        next_agenda=list(meeting.next_agenda or []),
        unresolved=[
            minutes_builder.Issue(
                content=str(row.detail.get("content", "")),
                evidence_count=len(row.evidence_utterance_ids or []),
            )
            for row in issues
        ],
        candidates=[
            minutes_builder.Candidate(title=c.title, decision=c.review_status)
            for c in candidates
        ],
        tracks_total=len(tracks),
        tracks_broken=sum(1 for t in tracks if t.status in _BROKEN_TRACK),
    )

    return _upsert(
        session,
        project_id=meeting.project_id,
        report_type=ReportType.MEETING_MINUTES,
        key=scope_key(ReportType.MEETING_MINUTES, meeting_id=meeting.id),
        content=minutes_builder.build(data),
        meeting_id=meeting.id,
    )


# ══════════════════════════════════════════════════════════════
# 주간 · 최종
# ══════════════════════════════════════════════════════════════


def _people(session: Session, project_id: int) -> list[period_builder.Person]:
    """사람별 몫을 모은다.

    ⚠️ **정렬하지 않습니다.** 순서를 정하는 것은 `blocks.people()` 하나이고,
    거기서 이름 순으로 다시 세웁니다. 여기서도 정렬하면 판단이 두 곳이 되고,
    한쪽이 언젠가 점수 순이 됩니다.
    """
    result = scoring_service.compute(session, project_id)

    names = dict(
        session.execute(
            select(m.User.id, m.User.name).join(
                m.Member, m.Member.user_id == m.User.id
            ).where(m.Member.project_id == project_id)
        ).all()
    )

    finals = {
        row.user_id: row
        for row in session.scalars(
            select(m.FinalContribution).where(
                m.FinalContribution.project_id == project_id
            )
        ).all()
    }

    people: list[period_builder.Person] = []
    for user_id, score in result.members.items():
        final = finals.get(user_id)
        gaps = [g.reason for g in score.measurement_gaps]
        # ⚠️ 못 잰 영역이 있다고 "못 잰 사람" 이 되는 것은 아닙니다. 남은
        #    영역으로 재정규화해 구간을 냅니다 (docs/05). 아무것도 못 쟀을
        #    때만 구간을 비웁니다 — 그때 0 을 적으면 그건 오답입니다.
        measured = score.confidence.value > 0 and bool(score.evidence_ids)
        people.append(
            period_builder.Person(
                name=names.get(user_id, f"#{user_id}"),
                role=score.role,
                measured=measured,
                range_low=round(score.range_low, 1) if measured else None,
                range_high=round(score.range_high, 1) if measured else None,
                confidence=round(score.confidence.value, 2) if measured else None,
                confidence_label=score.confidence.label if measured else None,
                reasons=list(score.confidence.reasons),
                evidence_count=len(score.evidence_ids),
                gaps=gaps if measured else (gaps or ["활동 기록이 없어 잴 수 없었습니다"]),
                final_value=round(float(final.final_value), 1) if final else None,
                final_reason=final.reason if final else None,
            )
        )
    return people


def _counts(
    session: Session,
    project_id: int,
    start: datetime | None,
    end: datetime | None,
) -> dict[str, int]:
    def _window(stmt, column):
        if start is not None:
            stmt = stmt.where(column >= start)
        if end is not None:
            stmt = stmt.where(column <= end)
        return stmt

    meetings = session.scalars(
        _window(
            select(m.Meeting).where(m.Meeting.project_id == project_id),
            m.Meeting.started_at,
        )
    ).all()

    tasks_done = session.scalar(
        _window(
            select(func.count(m.Task.id)).where(
                m.Task.project_id == project_id,
                m.Task.completed_at.is_not(None),
            ),
            m.Task.completed_at,
        )
    )
    tasks_open = session.scalar(
        select(func.count(m.Task.id)).where(
            m.Task.project_id == project_id,
            m.Task.completed_at.is_(None),
        )
    )
    github = session.scalar(
        _window(
            select(func.count(m.GithubEvent.id)).where(
                m.GithubEvent.project_id == project_id
            ),
            m.GithubEvent.occurred_at,
        )
    )

    return {
        "meetings_total": len(meetings),
        "meetings_processed": sum(1 for x in meetings if x.status == "done"),
        "tasks_done": int(tasks_done or 0),
        "tasks_open": int(tasks_open or 0),
        "github_events": int(github or 0),
    }


def generate_period(
    session: Session,
    project_id: int,
    report_type: ReportType,
    *,
    period_start: datetime | None = None,
    period_end: datetime | None = None,
) -> m.Report:
    project = session.get(m.Project, project_id)
    if project is None:
        raise ReportError("프로젝트를 찾을 수 없습니다")
    if REPORT_SCOPE[report_type] is ReportScope.MEETING:
        raise ReportError("회의록은 회의에서 만듭니다")

    if report_type is ReportType.FINAL:
        # 최종은 프로젝트 전체입니다 — 기간을 안 받습니다. 받으면 "최종" 이
        # 여러 벌 생기고, 그건 최종이 아닙니다.
        period_start = period_end = None

    counts = _counts(session, project_id, period_start, period_end)
    confirmed = (
        session.scalar(
            select(func.count(m.FinalContribution.user_id)).where(
                m.FinalContribution.project_id == project_id
            )
        )
        or 0
    ) > 0

    result = scoring_service.compute(session, project_id)
    data = period_builder.PeriodInput(
        project_name=project.title,
        people=_people(session, project_id),
        period_start=period_start,
        period_end=period_end,
        github_backfilled=project.github_backfilled_to is not None,
        confirmed=confirmed,
        skipped_categories=[str(c) for c in result.skipped_categories],
        **counts,
    )

    return _upsert(
        session,
        project_id=project_id,
        report_type=report_type,
        key=scope_key(
            report_type, period_start=period_start, period_end=period_end
        ),
        content=period_builder.build(data, report_type),
        period_start=period_start,
        period_end=period_end,
    )


# ══════════════════════════════════════════════════════════════
# 읽기
# ══════════════════════════════════════════════════════════════


def list_reports(session: Session, project_id: int) -> list[m.Report]:
    """이 프로젝트의 보고서 전부. **새것부터.**"""
    return list(
        session.scalars(
            select(m.Report)
            .where(m.Report.project_id == project_id)
            .order_by(m.Report.generated_at.desc(), m.Report.id.desc())
        ).all()
    )
