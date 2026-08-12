"""칸반 업무 — 조회와 상태 변경.

이 모듈이 닫는 것은 **이 프로젝트의 대표 주장 중 마지막 연결**입니다.

    회의 결정 → 업무 후보 → 사람이 승인 → 칸반 업무 → ??? → 기여도
                                                    ↑ 여기가 끊겨 있었다

`approval_service` 가 `tasks` 행을 만드는 데까지는 갑니다. 그런데 그 업무를
**완료해도 기여도에 아무 일도 일어나지 않았습니다.** `scoring.py` 는
`TASK_COMPLETED` 와 `DEADLINE_MET` 을 점수로 바꾸는 법을 알고 있는데,
그 이벤트를 만드는 코드가 저장소 어디에도 없었습니다.

즉 기여도 화면의 숫자는 **손으로 넣은 이벤트가 아니면 영원히 0** 이었습니다.

## 완료를 되돌리면

이벤트는 INSERT 만 합니다 (`ContributionEventRow` 의 규약). 완료를 되돌려도
`task_completed` 이벤트는 남고, 되돌렸다는 사실이 감사 로그에 남습니다.

지우지 않는 이유: 지우면 "완료했다가 되돌렸다" 가 기록에서 사라지고, 점수는
조용히 내려갑니다. 기여도 분쟁에서 필요한 건 지금 상태가 아니라 **무슨 일이
있었는가**입니다.

다시 완료해도 중복으로 세지 않습니다. 유니크 제약
`(source_kind, source_id, event_type)` 이 같은 종류의 두 번째 INSERT 를
막습니다 — 그런데 **그것만으로는 부족합니다.** 유니크 키에 `event_type` 이
들어 있어서 `DEADLINE_MET` 과 `DEADLINE_MISSED` 는 서로 다른 행입니다.
그래서 마감 준수는 `_record_completion` 이 **업무 하나당 한 번만** 판정합니다
(거기 주석에 왜 그런지 적어 두었습니다).
"""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from teamflow.clock import local_date
from teamflow.contribution.events import CATEGORY_OF, EventType, SourceKind
from teamflow.db import live, vocab
from teamflow.db import models as m

logger = logging.getLogger(__name__)

# 칸반 열. 순서가 곧 화면의 열 순서다.
#
# ⚠️ **여기서 정하지 않습니다.** 예전에는 이 튜플이 허용값의 유일한
#    출처였고 데이터베이스에는 제약이 없었습니다 — `db/vocab.py` 의
#    `TaskStatus` 머리말을 보십시오. 지금은 어휘에서 끌어옵니다.
STATUSES = tuple(str(s) for s in vocab.TASK_STATUSES)
DONE = str(vocab.TaskStatus.DONE)


class TaskError(Exception):
    """호출자가 400/404 로 옮긴다."""


def _now() -> datetime:
    return datetime.now(UTC)


def _aware(value: datetime | None) -> datetime | None:
    """SQLite 는 tzinfo 를 잃는다. 비교 전에 되살린다."""
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def list_tasks(session: Session, project_id: int) -> list[dict]:
    """이 프로젝트의 업무 전부.

    **어느 회의에서 나왔는지를 같이 싣습니다.** 그게 없으면 이 화면은 그냥
    할 일 목록이고, "회의 결정이 업무가 됐다" 는 주장을 확인할 방법이 없습니다.
    """
    rows = session.scalars(
        live.live_tasks().where(m.Task.project_id == project_id).order_by(m.Task.id)
    ).all()

    # 후보 → 회의를 한 번에 끌어온다. 업무마다 조회하면 N+1 이다.
    candidate_ids = [t.origin_candidate_id for t in rows if t.origin_candidate_id]
    origins: dict[int, dict] = {}
    if candidate_ids:
        for candidate, meeting in session.execute(
            select(m.MeetingTaskCandidate, m.Meeting)
            .join(m.Meeting, m.Meeting.id == m.MeetingTaskCandidate.meeting_id)
            .where(m.MeetingTaskCandidate.id.in_(candidate_ids))
        ).all():
            origins[candidate.id] = {
                "candidate_id": candidate.id,
                "meeting_id": meeting.id,
                "meeting_title": meeting.title,
                "evidence_utterance_ids": list(candidate.evidence_utterance_ids or []),
            }

    return [
        {
            "id": task.id,
            "title": task.title,
            "assignee_id": task.assignee_id,
            "status": task.status,
            "deadline": task.deadline.date().isoformat() if task.deadline else None,
            "completed_at": (
                _aware(task.completed_at).isoformat() if task.completed_at else None
            ),
            # None 이면 사람이 손으로 만든 업무다. 화면이 그 둘을 구분한다.
            "origin": origins.get(task.origin_candidate_id or -1),
        }
        for task in rows
    ]


def _emit(
    session: Session,
    *,
    project_id: int,
    user_id: int,
    event_type: EventType,
    source_id: int,
    occurred_at: datetime,
    magnitude: float = 1.0,
    source_kind: SourceKind = SourceKind.TASK,
    metadata: dict | None = None,
) -> bool:
    """기여 이벤트 하나. 이미 있으면 아무 일도 하지 않는다.

    멱등성이 중요한 이유: 완료 → 되돌림 → 다시 완료가 실제로 일어납니다.
    그때마다 이벤트를 하나씩 더 넣으면 **버튼을 반복해서 눌러 점수를 올릴 수
    있습니다.** 유니크 제약이 DB 차원에서 막지만, 여기서 먼저 확인해
    IntegrityError 로 요청 전체가 실패하지 않게 합니다.
    """
    exists = session.scalar(
        select(m.ContributionEventRow.id).where(
            m.ContributionEventRow.source_kind == source_kind.value,
            m.ContributionEventRow.source_id == source_id,
            m.ContributionEventRow.event_type == event_type.value,
        )
    )
    if exists:
        return False

    session.add(
        m.ContributionEventRow(
            project_id=project_id,
            user_id=user_id,
            occurred_at=occurred_at,
            category=CATEGORY_OF[event_type].value,
            event_type=event_type.value,
            source_kind=source_kind.value,
            source_id=source_id,
            magnitude=magnitude,
            event_metadata=metadata or {},
        )
    )
    return True


def _record_completion(
    session: Session, task: m.Task, completed_at: datetime, *, actor_id: int | None = None
) -> None:
    """완료가 기여도에 도달하는 유일한 경로.

    담당자가 없는 업무는 이벤트를 만들지 않습니다 — 누구의 기여인지 모르는
    완료를 아무에게나 붙일 수는 없습니다.

    `actor_id` 는 **누른 사람**입니다. 점수는 담당자에게 가지만, 누가
    눌렀는지를 이벤트에도 실어 둡니다 — 감사 로그와 기여 이벤트는 다른
    표라, 둘 중 하나만 보고 판단하는 사람이 반드시 생깁니다.
    """
    if task.assignee_id is None:
        logger.info(
            "task=%s 는 담당자가 없어 기여 이벤트를 만들지 않습니다", task.id
        )
        return

    first_completion = _emit(
        session,
        project_id=task.project_id,
        user_id=task.assignee_id,
        event_type=EventType.TASK_COMPLETED,
        source_id=task.id,
        occurred_at=completed_at,
        metadata={"completed_by": actor_id} if actor_id is not None else None,
    )

    # ⚠️ **마감 준수는 업무 하나당 딱 한 번만 판정한다.**
    #
    # `_emit` 의 멱등성은 `(source_kind, source_id, event_type)` 기준이라
    # `DEADLINE_MET` 과 `DEADLINE_MISSED` 를 **서로 다른 행**으로 본다.
    # 그래서 여기서 막지 않으면 한 업무가 met 과 missed 를 동시에 갖는다.
    # `scoring._schedule_raw` 는 met/(met+missed) 를 쓰므로, 늦게 끝낸
    # 업무 하나가 준수율 0 에서 0.5 로 올라간다.
    #
    # 더 나쁜 경로도 있었다. 마감일 없이 완료한 업무(판정 없음)를 되돌린 뒤
    # 마감일을 미래로 넣고 다시 완료하면 **없던 met 이 생겼다.** 아무도
    # 마감일을 과거로 넣지는 않으므로 이 조작은 한쪽으로만 작동한다 —
    # 버튼 세 번으로 점수가 오르는 경로였다.
    #
    # 되돌리기 자체는 막지 않는다. 그건 정상적인 일이고, 되돌렸다는 사실은
    # 감사 로그에 남는다. 다시 판정하지 않을 뿐이다.
    if not first_completion:
        logger.info(
            "task=%s 는 이미 완료된 적이 있어 마감 준수를 다시 판정하지 않습니다",
            task.id,
        )
        return

    deadline = _aware(task.deadline)
    if deadline is None:
        # 마감일이 없으면 준수 여부를 물을 수 없다. **지켰다고 치지 않는다.**
        return

    # ⚠️ **팀이 사는 달력으로 봅니다** (결함 107). `.date()` 는 UTC
    # 달력일이라 한국(UTC+9)에서는 사람이 보는 날짜와 다릅니다.
    #
    #     완료 2026-09-04T16:00Z = KST 09-05 01:00   마감 09-04
    #     UTC 로 보면   09-04 <= 09-04  → 제때  ← 틀림
    #     KST 로 보면   09-05 >  09-04  → 늦음
    #
    # 칸반 화면(`kanban/board.ts` 의 `localDateOf`)은 이미 로컬 달력으로
    # 고쳐 놓고 그 이유를 주석에 길게 적어 뒀습니다. **서버만 안 고쳐져
    # 있었습니다** — 같은 업무를 칸반은 "늦음", 기여도는 "제때" 로
    # 말했습니다. 사람은 어느 쪽을 믿을지 모릅니다.
    met = local_date(completed_at) <= local_date(deadline)
    _emit(
        session,
        project_id=task.project_id,
        user_id=task.assignee_id,
        event_type=EventType.DEADLINE_MET if met else EventType.DEADLINE_MISSED,
        source_id=task.id,
        occurred_at=completed_at,
    )


def change_task(
    session: Session,
    *,
    project_id: int,
    task_id: int,
    actor_id: int,
    status: str | None = None,
    deadline: date | None = None,
    deadline_provided: bool = False,
    reason: str | None = None,
) -> m.Task:
    """상태·마감일 변경.

    `deadline_provided` 를 따로 받는 이유: `deadline=None` 이 "마감일을
    지운다" 인지 "마감일은 안 건드린다" 인지 구분해야 하기 때문입니다.
    """
    task = session.get(m.Task, task_id)
    if task is None or task.project_id != project_id:
        raise TaskError("업무를 찾을 수 없습니다")

    if status is not None and status not in STATUSES:
        raise TaskError(f"알 수 없는 상태입니다: {status}")

    if deadline_provided:
        _change_deadline(session, task, deadline, actor_id, reason)

    if status is not None and status != task.status:
        _change_status(session, task, status, actor_id)

    session.flush()
    return task


def delete_task(
    session: Session, *, project_id: int, task_id: int, actor_id: int
) -> m.Task:
    """업무를 지운다 (`TASK-003`).

    ⚠️ **행을 안 지웁니다.** `deleted_at` 만 적습니다. 기여 이벤트·PR
    연결·회의 후보가 이 업무를 가리키고 있어서, 진짜로 지우면 화면의
    `근거 업무 #7` 이 아무것도 안 가리키게 됩니다 (대표 실패 ③).

    ⚠️ **기여 이벤트를 안 지웁니다.** 지운 업무로 쌓인 기여까지 사라지면
    업무 하나를 지우는 것으로 남의 기여도를 깎을 수 있습니다 — 그건
    조작 통로입니다.

    ⚠️ 두 번 지워도 오류가 아닙니다. 이미 지워진 게 원하던 결과입니다.
    """
    task = session.get(m.Task, task_id)
    if task is None or task.project_id != project_id:
        raise TaskError("업무를 찾을 수 없습니다")

    if task.deleted_at is None:
        task.deleted_at = datetime.now(UTC)
        _log_deletion(session, task, actor_id)
        session.flush()
    return task


def _log_deletion(session: Session, task: m.Task, actor_id: int) -> None:
    """지웠다는 사실을 남깁니다.

    ⚠️ 안 남기면 카드가 조용히 사라지고, 남은 사람은 **누가 지웠는지도
    지워진 건지도** 모릅니다. 완료·되돌리기와 같은 표에 적습니다.
    """
    session.add(
        m.AuditLog(
            project_id=task.project_id,
            actor_id=actor_id,
            action="task_deleted",
            target=f"task:{task.id}",
            before={"status": task.status},
            after={"deleted": True},
            at=task.deleted_at,
        )
    )


def _change_deadline(
    session: Session,
    task: m.Task,
    deadline: date | None,
    actor_id: int,
    reason: str | None,
) -> None:
    """마감일 변경은 **반드시 기록에 남는다** (docs/05 §2.4).

    마감을 계속 뒤로 미루면 준수율이 저절로 올라갑니다. 점수를 깎지는
    않지만, 변경 횟수를 남기지 않으면 그 조작이 보이지 않습니다.

    ## ⚠️ 감사 표만으로는 탐지가 죽어 있었다

    `task_deadline_changes` 행은 처음부터 남고 있었습니다. 그런데
    `scoring._detect_integrity_flags` 는 그 표를 보지 않습니다 —
    `DEADLINE_CHANGED` **기여 이벤트**를 셉니다. 만드는 곳이 0곳이라
    `frequent_deadline_change` 플래그는 **한 번도 뜰 수 없었습니다.**
    `docs/09` 실험 4 가 검증하겠다고 적어 둔 바로 그 플래그입니다.

    둘 다 남깁니다. 목적이 다릅니다 — 감사 표는 **누가 언제 왜** 바꿨는지,
    기여 이벤트는 **그 사람의 준수율을 그대로 읽어도 되는가**입니다.
    """
    new_value = (
        datetime.combine(deadline, datetime.min.time(), tzinfo=UTC) if deadline else None
    )
    old_value = _aware(task.deadline)
    if (old_value.date() if old_value else None) == (deadline or None):
        return

    change = m.TaskDeadlineChange(
        task_id=task.id,
        changed_by=actor_id,
        old_deadline=old_value,
        new_deadline=new_value,
        reason=reason,
    )
    session.add(change)
    task.deadline = new_value

    if task.assignee_id is None:
        # 담당자가 없으면 흔들릴 준수율도 없다. 변경 이력은 위에서 이미 남겼다.
        return

    # `change.id` 가 있어야 변경마다 다른 근거를 가리킬 수 있다.
    session.flush()
    _emit(
        session,
        project_id=task.project_id,
        # ⭐ **담당자**에게 붙인다. 바꾼 사람이 아니다.
        # `_detect_integrity_flags` 가 이 사람의 met/missed 건수와 비교하므로,
        # 바꾼 사람에게 붙이면 두 사람의 숫자를 섞은 비율이 된다.
        # 남이 바꿨다는 사실은 아래 `changed_by` 로 근거에 남는다.
        user_id=task.assignee_id,
        event_type=EventType.DEADLINE_CHANGED,
        source_kind=SourceKind.DEADLINE_CHANGE,
        source_id=change.id,
        occurred_at=_now(),
        magnitude=0.0,
        metadata={"task_id": task.id, "changed_by": actor_id},
    )


def _change_status(session: Session, task: m.Task, status: str, actor_id: int) -> None:
    before = task.status
    task.status = status

    if status == DONE:
        completed_at = _now()
        task.completed_at = completed_at
        # ⭐ **점수가 생기는 순간**을 기록한다.
        #
        # 예전에는 되돌리기(아래)에만 감사 로그가 있었습니다. 그런데 이
        # 저장소는 아무나 남의 업무를 완료로 옮길 수 있는 것이 정상
        # 동작이고, 기여 이벤트는 **담당자** 앞으로 생깁니다. 그래서
        # 누가 눌렀는지가 어디에도 안 남았습니다 — 한 번도 되돌린 적이
        # 없는 프로젝트는 `audit_logs` 가 통째로 비어 있었습니다.
        #
        # 밀어주기·대리 완료 의심이 제기됐을 때 답할 재료가 필요합니다.
        # 시스템이 판정하지는 않습니다. 사람이 볼 수 있게만 합니다.
        session.add(
            m.AuditLog(
                project_id=task.project_id,
                actor_id=actor_id,
                action="task_completed",
                target=f"task:{task.id}",
                before={"status": before},
                after={"status": status},
                at=completed_at,
            )
        )
        _record_completion(session, task, completed_at, actor_id=actor_id)
        return

    if before == DONE:
        # 완료를 되돌린다. **이벤트는 지우지 않는다** — 지우면 "완료했다가
        # 되돌렸다" 가 기록에서 사라지고 점수만 조용히 내려간다. 기여도
        # 분쟁에서 필요한 건 지금 상태가 아니라 무슨 일이 있었는가다.
        task.completed_at = None
        session.add(
            m.AuditLog(
                project_id=task.project_id,
                actor_id=actor_id,
                action="task_reopened",
                target=f"task:{task.id}",
                before={"status": before},
                after={"status": status},
                at=_now(),
            )
        )
