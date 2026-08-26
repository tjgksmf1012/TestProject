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

from teamflow import clock
from teamflow.contribution import events, profiles
from teamflow.db import models as m
from teamflow.db.vocab import REPORT_SCOPE, ReportScope, ReportType
from teamflow.people import labels as people_labels
from teamflow.reports import minutes as minutes_builder
from teamflow.reports import period as period_builder
from teamflow.reports import scope_key
from teamflow.services import scoring_service
from teamflow.services.naming import meeting_label

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
        meeting_title=meeting_label(meeting.title, meeting.id),
        status=meeting.status,
        capture_mode=meeting.capture_mode,
        started_at=meeting.started_at,
        # ⚠️ **잡아 둔 시각도 넘깁니다** (결함 358) — 안 넘기면 달력에서 잡은
        #    회의의 회의록이 「일시 못 쟀습니다」로 나갑니다.
        scheduled_at=meeting.scheduled_at,
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
        # ⚠️ **세어서 넘깁니다** (결함 369). 안 넘기면 builder 는 「모른다」로
        #    두고 옛 문장을 그대로 씁니다 — 소리가 하나도 안 잡힌 회의의
        #    회의록이 「미해결로 남은 사안이 없습니다」라고 단언합니다.
        utterance_count=session.scalar(
            select(func.count())
            .select_from(m.Utterance)
            .where(m.Utterance.meeting_id == meeting.id)
        )
        or 0,
        # ⚠️ **세어서 넘깁니다** (결함 369). 안 넘기면 builder 는 「모른다」로
        #    두고 옛 문장을 그대로 씁니다 — 소리가 하나도 안 잡힌 회의의
        #    회의록이 「미해결로 남은 사안이 없습니다」라고 단언합니다.
        # ⚠️ **세어서 넘깁니다** (결함 369). 안 넘기면 builder 는 「모른다」로
        #    두고 옛 문장을 그대로 씁니다 — 소리가 하나도 안 잡힌 회의의
        #    회의록이 「미해결로 남은 사안이 없습니다」라고 단언합니다.
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

    # ⚠️ 역할 비중도 같이 읽습니다 (결함 291). 예전에는 `score.role` 만
    #    실어서 「기획 60% · 개발 40%」 인 사람이 문서에 「기획」 하나로
    #    적혔고, 그나마도 `developer` 같은 **영어 식별자 그대로**였습니다.
    rows = session.execute(
        select(
            m.User.id, m.User.name, m.Member.role_shares, m.Member.github_login
        ).join(m.Member, m.Member.user_id == m.User.id).where(
            m.Member.project_id == project_id
        )
    ).all()
    shares = {user_id: share for user_id, _, share, _ in rows}

    # ⚠️ **같은 이름이 둘이면 갈라 부릅니다** (결함 345). 이 문서는 사람
    #    이름 옆에 기여 구간을 붙이므로, 이름이 같으면 두 항목이 누구
    #    것인지 알 수 없습니다 — 팀 **밖으로 나가는** 문서입니다.
    #
    # ⚠️ 화면이 아니라 **여기서** 붙입니다. `reports.body` 는 만든 순간의
    #    글자를 저장하고 화면은 그것을 그대로 그립니다(「글자로 복사」도
    #    같은 글자입니다). 화면에서 붙이면 저장된 기록과 사람이 읽는 글이
    #    갈라집니다. 두 벌인 것은 `people/label_cases.json` 짝 검사가
    #    지킵니다.
    refs = [
        people_labels.PersonRef(user_id=user_id, name=name, github_login=login)
        for user_id, name, _, login in rows
    ]
    names = {
        ref.user_id: people_labels.label_in_list(ref, refs) for ref in refs
    }

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
        #
        # ⚠️⚠️ **가르는 것은 범주 칸이 있는가 하나입니다** (결함 410).
        #    예전에는 `confidence > 0 and evidence_ids` 였습니다. 팀원 20명을
        #    실기 경로(가입 + 초대 코드)로 만들어 최종 보고서를 읽어 보니,
        #    막 들어와 활동이 0인 사람 열일곱에게 **「측정하지 못했습니다」**
        #    라고 적혀 나갔습니다. 같은 순간 기여도 화면은 같은 사람을
        #    **`0%`** 로 그립니다 — `@lib` 의 `nothingMeasured` 가 결함 191
        #    에서 「팀에 살아 있는 범주가 있고 이 사람만 0건인 것은 **쟀는데
        #    0건**」이라고 못 박았기 때문입니다.
        #
        #    「측정하지 못했습니다」는 불변식 ③(측정 불가 ≠ 0점)이 쓰는
        #    말입니다. 아는 값에 붙이면 그 말이 닳습니다(결함 358) — 그것도
        #    **팀 밖으로 나가는 문서**에서.
        #
        #    같은 판단이 파이썬·TS 두 벌이라 `contribution/measured_cases.json`
        #    을 두 검사가 같이 읽습니다(결함 345 의 방법).
        measured = bool(score.categories)
        people.append(
            period_builder.Person(
                name=names.get(user_id, f"#{user_id}"),
                role=profiles.describe_role_shares(shares.get(user_id), score.role),
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

    # ⚠️ 머리말이 「이 기간에 **일어난** 일」입니다. 잡아만 두고 아직 안
    #    연 회의는 일어나지 않았습니다 (결함 287·288) — 최종 보고서는
    #    기간을 안 받으므로 `_window` 가 아무것도 안 걸러 주고, 예정 회의가
    #    「회의 6건」에 섞여 들어갔습니다.
    meetings = session.scalars(
        _window(
            select(m.Meeting).where(
                m.Meeting.project_id == project_id,
                m.Meeting.started_at.is_not(None),
            ),
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
        # ⛔ 예전에는 `x.status == "done"` 이었습니다 (결함 288). `"done"` 은
        #    **업무** 상태라 어느 회의도 해당하지 않고, 이 값은 언제나 0
        #    이었습니다. 상태 어휘의 유일한 출처는 `MeetingStatus` 입니다.
        "meetings_processed": sum(
            1 for x in meetings if x.status in m.PROCESSED_MEETING_STATUSES
        ),
        # ⚠️ **실패한 것을 따로 셉니다** (결함 370). 안 세면 builder 가
        #    「나머지 = 아직 처리 전」으로 뭉개고, 팀이 제출하는 문서가
        #    「기다리면 들어옵니다」라고 거짓말을 합니다.
        "meetings_failed": sum(
            1 for x in meetings if x.status == m.MeetingStatus.FAILED.value
        ),
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
    elif report_type is ReportType.WEEKLY and period_start is None and period_end is None:
        # ⭐ **주간의 「이번 주」는 여기서 정합니다** (결함 296).
        #
        # 화면이 「지난 7일」을 만들어 보내고 있었습니다. 그 창은 누를 때마다
        # 굴러가므로 `scope_key` 가 날마다 달라지고, 하루에 한 벌씩 주간
        # 보고서가 쌓였습니다 — 바로 위 `_upsert` 가 「쌓으면 안 됩니다」
        # 라고 적어 둔 그것이 **아무것도 안 막고 있었습니다.**
        #
        # 팀 달력을 아는 곳은 서버입니다(`clock.team_zone`). 화면이 창을
        # 지으면 판단이 두 벌이 되고, 그중 한 벌에는 테스트가 없습니다.
        period_start, period_end = clock.team_week()

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
        # ⛔ 예전에는 `str(c)` 라 문서에 `document, schedule, peer` 가
        #    그대로 나갔습니다 (결함 291).
        skipped_categories=[events.describe_category(str(c)) for c in result.skipped_categories],
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
