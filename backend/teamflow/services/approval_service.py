"""승인 서비스 — 순수 도메인 로직과 DB를 잇는다.

도메인 로직(`meeting/approval.py`)은 순수 함수라 DB를 모른다.
이 계층이 읽고, 도메인에 넘기고, 결과를 반영한다.

트랜잭션 경계가 여기다. 승인 하나가 만드는 변화는 전부 한 트랜잭션에 들어간다:
    후보 상태 변경 + 업무 생성 + 감사 로그
셋 중 하나라도 실패하면 전부 롤백된다. 감사 로그 없는 승인은 존재할 수 없다.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from teamflow.db import models as m
from teamflow.meeting.approval import (
    ApprovalRequest,
    BatchOutcome,
    CandidateStatus,
    StoredCandidate,
    apply_batch,
)
from teamflow.services import notification_service


def _to_domain(row: m.MeetingTaskCandidate) -> StoredCandidate:
    deadline = row.deadline
    return StoredCandidate(
        id=row.id,
        meeting_id=row.meeting_id,
        title=row.title,
        assignee_id=row.assignee_id,
        deadline=deadline.date() if isinstance(deadline, datetime) else deadline,
        confidence=float(row.confidence),
        evidence_utterance_ids=tuple(row.evidence_utterance_ids or ()),
        status=CandidateStatus(row.review_status),
        reviewed_by=row.reviewed_by,
        created_task_id=row.created_task_id,
    )


def load_candidates(session: Session, meeting_id: int) -> dict[int, StoredCandidate]:
    rows = session.scalars(
        select(m.MeetingTaskCandidate).where(
            m.MeetingTaskCandidate.meeting_id == meeting_id
        )
    ).all()
    return {row.id: _to_domain(row) for row in rows}


def project_member_ids(session: Session, project_id: int) -> frozenset[int]:
    return frozenset(
        session.scalars(
            select(m.Member.user_id).where(m.Member.project_id == project_id)
        ).all()
    )


def review_candidates(
    session: Session,
    *,
    project_id: int,
    meeting_id: int,
    requests: list[ApprovalRequest],
    now: datetime | None = None,
    today: date | None = None,
) -> BatchOutcome:
    """후보들에 승인/거절을 적용하고 DB에 반영한다.

    실패한 항목이 있어도 나머지는 커밋된다 — 하나 때문에 전체를 막지 않는다.
    호출자가 `outcome.failures` 를 보고 해당 항목만 다시 요청하면 된다.
    """
    now = now or datetime.now(UTC)
    today = today or now.date()

    candidates = load_candidates(session, meeting_id)
    members = project_member_ids(session, project_id)

    outcome = apply_batch(
        candidates,
        requests,
        project_id=project_id,
        project_member_ids=members,
        now=now,
        today=today,
    )

    # 1) 후보 상태 반영
    by_id = {c.id: c for c in outcome.updated}
    if by_id:
        rows = session.scalars(
            select(m.MeetingTaskCandidate).where(
                m.MeetingTaskCandidate.id.in_(by_id.keys())
            )
        ).all()
        for row in rows:
            updated = by_id[row.id]
            row.title = updated.title
            row.assignee_id = updated.assignee_id
            row.deadline = (
                datetime.combine(updated.deadline, datetime.min.time(), tzinfo=UTC)
                if updated.deadline
                else None
            )
            row.review_status = updated.status.value
            row.reviewed_by = updated.reviewed_by

    # 2) 승인된 것만 업무로 만든다.
    #    승인 없이 tasks 에 쓰는 경로는 이 함수 어디에도 없다 — 그게 불변식이다.
    created: dict[int, m.Task] = {}
    for new_task in outcome.approved:
        task = m.Task(
            project_id=new_task.project_id,
            title=new_task.title,
            assignee_id=new_task.assignee_id,
            deadline=datetime.combine(new_task.deadline, datetime.min.time(), tzinfo=UTC),
            status="todo",
            origin_candidate_id=new_task.origin_candidate_id,
        )
        session.add(task)
        created[new_task.origin_candidate_id] = task

    session.flush()  # task.id 확보

    for candidate_id, task in created.items():
        row = session.get(m.MeetingTaskCandidate, candidate_id)
        if row is not None:
            row.created_task_id = task.id
        # NOTIFICATION-002 — 맡은 사람에게 알립니다.
        #
        # ⚠️ **여기가 업무가 만들어지는 유일한 자리입니다** (위 주석의
        #    불변식). 알림을 API 쪽에 붙이면 다른 경로가 생겼을 때 조용히
        #    빠집니다 — 이 저장소가 반복해 당한 "만들어 놓고 아무도 안 부름"
        #    의 반대 모양입니다.
        #
        # ⚠️ 승인한 사람은 방금 자기가 한 일이라 안 받습니다. 누가 승인했는지는
        #    후보 행에 이미 적혀 있으므로 거기서 가져옵니다 — 인자를 하나 더
        #    받으면 부르는 자리마다 넘겨야 하고, 그러면 한 곳이 빠집니다.
        reviewer_id = row.reviewed_by if row is not None else None
        notification_service.record_assignment(session, task, actor_id=reviewer_id)

    # 3) 감사 로그. 이게 없으면 승인도 없다.
    for entry in outcome.audit:
        session.add(
            m.AuditLog(
                project_id=project_id,
                actor_id=entry.actor_id,
                action=entry.action,
                target=entry.target,
                before=entry.before,
                after=entry.after,
                at=entry.at,
            )
        )

    session.flush()

    # 4) 남은 후보가 없으면 이 회의는 **검토가 끝난 것**이다.
    _confirm_if_all_reviewed(session, meeting_id)

    session.flush()
    return outcome


def _confirm_if_all_reviewed(session: Session, meeting_id: int) -> None:
    """후보를 전부 결정했으면 회의를 `confirmed` 로 옮긴다 (결함 84).

    ## 이걸 아무도 안 하고 있었다

    화면에는 `confirmed` 라벨("검토 완료")도 있고 그 상태의 "다음에 할 일"
    가지도 있었는데, **서버가 그 값을 한 번도 넣지 않았습니다.** 그래서
    사람이 후보를 전부 검토해도 회의는 `needs_review` 로 남았고, 홈 화면은
    남은 후보 0건을 보고 이렇게 말했습니다 —

        검토 필요 — 검토할 업무 후보가 없습니다 — 회의에서 업무가 나오지 않았습니다

    업무는 나왔고 사람이 전부 결정한 뒤입니다. 화면의 그 문장은 **후보가
    처음부터 0건이었을 때** 를 위한 것인데, 두 상황이 같은 값으로 뭉개져
    있었습니다.

    ⚠️ **후보가 처음부터 0건이면 옮기지 않습니다.** 그 회의는 사람이 볼
    것이 없었던 것이지 검토를 마친 것이 아니고, 화면의 "회의에서 업무가
    나오지 않았습니다" 가 그때는 **맞는 말**입니다. 두 상황을 가르는 것이
    이 함수의 요점입니다.

    ⚠️ **되돌아갈 수 있습니다.** 파이프라인이 회의를 다시 처리하면
    `needs_review` 로 되돌아가고, 새 후보가 생기면 다시 사람의 차례입니다.
    여기서 `confirmed` 를 최종 상태로 못 박지 않습니다.
    """
    total = session.scalar(
        select(func.count(m.MeetingTaskCandidate.id)).where(
            m.MeetingTaskCandidate.meeting_id == meeting_id
        )
    )
    if not total:
        return

    still_pending = session.scalar(
        select(func.count(m.MeetingTaskCandidate.id)).where(
            m.MeetingTaskCandidate.meeting_id == meeting_id,
            m.MeetingTaskCandidate.review_status == CandidateStatus.PENDING.value,
        )
    )
    if still_pending:
        return

    meeting = session.get(m.Meeting, meeting_id)
    if meeting is None:
        return
    if meeting.status == m.MeetingStatus.NEEDS_REVIEW.value:
        meeting.status = m.MeetingStatus.CONFIRMED.value


def pending_candidates(
    session: Session, meeting_id: int
) -> list[m.MeetingTaskCandidate]:
    """검토 대기 중인 후보. 확신도가 낮은 것부터 보여준다.

    사람이 검토해야 할 것을 먼저 보게 하는 정렬이다.
    """
    return list(
        session.scalars(
            select(m.MeetingTaskCandidate)
            .where(
                m.MeetingTaskCandidate.meeting_id == meeting_id,
                m.MeetingTaskCandidate.review_status == CandidateStatus.PENDING.value,
            )
            .order_by(m.MeetingTaskCandidate.confidence.asc())
        ).all()
    )
