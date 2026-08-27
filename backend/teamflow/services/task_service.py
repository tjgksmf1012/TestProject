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
from teamflow.db import assignees, live, vocab
from teamflow.db import models as m

logger = logging.getLogger(__name__)

# 칸반 열. 순서가 곧 화면의 열 순서다.
#
# ⚠️ **여기서 정하지 않습니다.** 예전에는 이 튜플이 허용값의 유일한
#    출처였고 데이터베이스에는 제약이 없었습니다 — `db/vocab.py` 의
#    `TaskStatus` 머리말을 보십시오. 지금은 어휘에서 끌어옵니다.
STATUSES = tuple(str(s) for s in vocab.TASK_STATUSES)
#: 우선순위 허용값. 목록을 손으로 적지 않습니다 — `vocab.TaskPriority` 가 원본.
PRIORITIES = tuple(int(p) for p in vocab.TASK_PRIORITIES)
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

    # 담당자는 여럿일 수 있습니다 (`TASK-006`). 카드마다 물으면 N+1 이라
    # 한 번에 끌어옵니다. 순서는 이름 순이고 **화면은 그대로 그립니다.**
    who = assignees.of_tasks(session, [t.id for t in rows])

    return [
        {
            "id": task.id,
            "title": task.title,
            "assignee_ids": who.get(task.id, []),
            "status": task.status,
            #: 작을수록 급합니다 (`vocab.TaskPriority`). 화면은 이 값으로
            #: 정렬하지 않습니다 — 칸반 열 안 순서는 사람이 끌어 정합니다.
            "priority": task.priority,
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

    ⚠️ **`user_id` 까지 봐야 합니다.** 유니크 제약은 네 칸
    `(source_kind, source_id, event_type, user_id)` 인데 여기서 셋만 보면,
    담당자가 둘인 업무에서 **먼저 넣은 사람 하나만 기록되고 나머지는
    조용히 사라집니다.** DB 는 막지 않습니다 — 막을 이유가 없는 행이라
    통과시키는데, 이 확인이 먼저 걸러 버립니다. 담당자가 하나뿐이던
    시절에는 셋만 봐도 같은 결과라 아무 표시가 나지 않았습니다.
    """
    exists = session.scalar(
        select(m.ContributionEventRow.id).where(
            m.ContributionEventRow.source_kind == source_kind.value,
            m.ContributionEventRow.source_id == source_id,
            m.ContributionEventRow.event_type == event_type.value,
            m.ContributionEventRow.user_id == user_id,
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


def _completed_before(session: Session, task_id: int) -> bool:
    """이 업무가 **전에도** 완료된 적이 있는가."""
    return (
        session.scalar(
            select(m.ContributionEventRow.id).where(
                m.ContributionEventRow.source_kind == SourceKind.TASK.value,
                m.ContributionEventRow.source_id == task_id,
                m.ContributionEventRow.event_type == EventType.TASK_COMPLETED.value,
            )
        )
        is not None
    )


def _past_verdict(session: Session, task_id: int) -> EventType | None:
    """이 업무의 마감 준수를 **이미 판정했다면** 그 판정.

    판정은 업무 하나당 한 번입니다. 담당자가 나중에 늘어도 새로 판정하지
    않고 **먼저 내린 판정을 그대로** 씁니다 — 아래 `_record_completion`
    주석에 왜 그런지 적어 두었습니다.
    """
    row = session.scalar(
        select(m.ContributionEventRow.event_type).where(
            m.ContributionEventRow.source_kind == SourceKind.TASK.value,
            m.ContributionEventRow.source_id == task_id,
            m.ContributionEventRow.event_type.in_(
                (EventType.DEADLINE_MET.value, EventType.DEADLINE_MISSED.value)
            ),
        )
    )
    return EventType(row) if row else None


def _record_completion(
    session: Session, task: m.Task, completed_at: datetime, *, actor_id: int | None = None
) -> None:
    """완료가 기여도에 도달하는 유일한 경로.

    담당자가 없는 업무는 이벤트를 만들지 않습니다 — 누구의 기여인지 모르는
    완료를 아무에게나 붙일 수는 없습니다.

    `actor_id` 는 **누른 사람**입니다. 점수는 담당자에게 가지만, 누가
    눌렀는지를 이벤트에도 실어 둡니다 — 감사 로그와 기여 이벤트는 다른
    표라, 둘 중 하나만 보고 판단하는 사람이 반드시 생깁니다.

    ## 담당자가 여럿이면 (`TASK-006`)

    **전원에게 하나씩 만듭니다.** 그리고 그 몫은 `1/N` 이 됩니다 —
    나누는 자리는 여기가 아니라 산정할 때이고, 왜 그런지는
    `contribution/sharing.py` 에 있습니다. 여기서 몫을 계산해 메타데이터에
    적어 두면 담당자가 나중에 바뀌었을 때 **얼어붙은 옛 몫**이 남습니다.
    """
    who = assignees.of_task(session, task.id)
    if not who:
        logger.info(
            "task=%s 는 담당자가 없어 기여 이벤트를 만들지 않습니다", task.id
        )
        return

    # ⚠️ **완료 이벤트를 만들기 전에** 물어야 합니다. 만든 뒤에 물으면
    #    방금 만든 것이 잡혀서 언제나 "전에도 완료됐다" 가 됩니다.
    completed_before = _completed_before(session, task.id)

    for user_id in who:
        _emit(
            session,
            project_id=task.project_id,
            user_id=user_id,
            event_type=EventType.TASK_COMPLETED,
            source_id=task.id,
            occurred_at=completed_at,
            metadata={"completed_by": actor_id} if actor_id is not None else None,
        )

    # ⚠️ **마감 준수는 업무 하나당 딱 한 번만 판정한다.**
    #
    # `_emit` 의 멱등성은 `(source_kind, source_id, event_type, user_id)`
    # 기준이라 `DEADLINE_MET` 과 `DEADLINE_MISSED` 를 **서로 다른 행**으로
    # 본다. 그래서 여기서 막지 않으면 한 업무가 met 과 missed 를 동시에
    # 갖는다. `scoring._schedule_raw` 는 met/(met+missed) 를 쓰므로, 늦게
    # 끝낸 업무 하나가 준수율 0 에서 0.5 로 올라간다.
    #
    # 더 나쁜 경로도 있었다. 마감일 없이 완료한 업무(판정 없음)를 되돌린 뒤
    # 마감일을 미래로 넣고 다시 완료하면 **없던 met 이 생겼다.** 아무도
    # 마감일을 과거로 넣지는 않으므로 이 조작은 한쪽으로만 작동한다 —
    # 버튼 세 번으로 점수가 오르는 경로였다.
    #
    # ⚠️ 담당자가 여럿이 되면서 이 판정을 **사람별로** 두고 싶어집니다.
    # 두면 안 됩니다 — 나중에 담당자로 넣은 사람은 "아직 판정 안 됨" 이라
    # 지금 마감일로 새로 재게 되고, 위의 조작이 **사람을 한 명 추가하는
    # 것만으로** 다시 열립니다. 판정은 업무의 사실이지 사람의 사실이
    # 아닙니다. 나중에 합류한 담당자에게는 **먼저 내린 판정을 그대로**
    # 붙입니다.
    verdict = _past_verdict(session, task.id)

    if verdict is None:
        if completed_before:
            # 첫 완료 때 마감일이 없어 판정하지 않았다. 그 사실이 결론이다.
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
        verdict = EventType.DEADLINE_MET if met else EventType.DEADLINE_MISSED

    for user_id in who:
        _emit(
            session,
            project_id=task.project_id,
            user_id=user_id,
            event_type=verdict,
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
    priority: int | None = None,
    reason: str | None = None,
) -> m.Task:
    """상태·마감일·우선순위 변경.

    `deadline_provided` 를 따로 받는 이유: `deadline=None` 이 "마감일을
    지운다" 인지 "마감일은 안 건드린다" 인지 구분해야 하기 때문입니다.
    우선순위는 지울 수 있는 값이 아니라(언제나 넷 중 하나) 그 구분이
    필요 없습니다.

    ⛔ **우선순위는 기여도에 안 닿습니다.** 감사 로그도 남기지 않습니다 —
    상태·마감일·담당자는 기여 이벤트가 누구에게 언제 가는지를 바꾸지만,
    우선순위는 "무엇부터 볼까" 일 뿐입니다. 남기면 로그가 잡음으로
    가득 차고, 정작 중요한 변경이 그 속에 묻힙니다.
    """
    # ⚠️ **지운 업무도 여기서 막습니다.**
    #
    # 행은 남기 때문에(`delete_task` 참고) `session.get` 은 지운 것도
    # 돌려줍니다. 바로 옆 `set_assignees` 는 `deleted_at` 을 같이 보는데
    # 여기만 안 봤고, 그래서 **지운 업무의 상태가 바뀌었습니다.** 그러고
    # 나면 화면에 돌려줄 줄을 목록에서 못 찾아(`list_tasks` 는 지운 것을
    # 거릅니다) API 가 `StopIteration` 으로 터졌습니다 — 사람은 **500** 을
    # 봤고 서버 로그에는 트레이스백이 남았습니다.
    #
    # 베타에서 흔한 모양입니다: 둘이 같은 칸반을 보다 한 명이 카드를
    # 지우고, 다른 한 명이 그 카드를 옮기는 것.
    task = session.get(m.Task, task_id)
    if task is None or task.project_id != project_id or task.deleted_at is not None:
        raise TaskError("업무를 찾을 수 없습니다")

    if status is not None and status not in STATUSES:
        raise TaskError(f"알 수 없는 상태입니다: {status}")

    # ⚠️ 여기서 막지 않으면 DB 의 CHECK 제약이 `IntegrityError` 로 터지고,
    #    사용자는 500 을 봅니다. 아는 잘못은 아는 말로 돌려줍니다.
    if priority is not None and priority not in PRIORITIES:
        raise TaskError(f"알 수 없는 우선순위입니다: {priority}")

    if deadline_provided:
        _change_deadline(session, task, deadline, actor_id, reason)

    if status is not None and status != task.status:
        _change_status(session, task, status, actor_id)

    if priority is not None:
        task.priority = priority

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


def set_assignees(
    session: Session, *, project_id: int, task_id: int, user_ids: list[int], actor_id: int
) -> tuple[m.Task, list[int], list[int]]:
    """담당자를 바꾼다 (`TASK-006`). `(업무, 지금 담당자, 새로 들어온 사람)`.

    ## ⚠️ 이 함수가 없어서 요구가 반쪽이었습니다

    담당자는 **회의 업무 후보를 승인할 때 한 번** 정해지고 그 뒤로는 바꿀
    수가 없었습니다. 사람이 빠지거나 일을 넘겨받아도 칸반은 옛 이름을
    계속 말했고, 기여 이벤트는 계속 그 사람에게 갔습니다. "담당자를
    여럿" 만 만들고 **바꿀 자리를 안 주면** 이 저장소의 대표 실패 ③ 입니다.

    ## ⚠️ 팀원만 담당자가 될 수 있습니다

    안 막으면 프로젝트 밖의 사람에게 기여 이벤트가 쌓입니다. 그 사람은
    기여도 화면에 안 나오므로(명단 기준) **아무도 못 보는 점수**가 되고,
    프로젝트 합계만 조용히 커집니다.
    """
    task = session.get(m.Task, task_id)
    if task is None or task.project_id != project_id or task.deleted_at is not None:
        raise TaskError("업무를 찾을 수 없습니다")

    wanted = assignees.normalize(user_ids)
    if wanted:
        members = set(
            session.scalars(
                select(m.Member.user_id).where(
                    m.Member.project_id == project_id,
                    m.Member.user_id.in_(wanted),
                )
            ).all()
        )
        missing = [uid for uid in wanted if uid not in members]
        if missing:
            raise TaskError(
                "이 프로젝트의 팀원이 아닌 사람은 담당자로 지정할 수 없습니다"
            )

    before = assignees.of_task(session, task_id)
    added = assignees.replace(session, task_id, wanted)
    now = assignees.of_task(session, task_id)

    if set(before) != set(now):
        session.add(
            m.AuditLog(
                project_id=task.project_id,
                actor_id=actor_id,
                action="task_assignees_changed",
                target=f"task:{task.id}",
                before={"assignee_ids": before},
                after={"assignee_ids": now},
                at=_now(),
            )
        )
    session.flush()
    return task, now, added


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

    who = assignees.of_task(session, task.id)
    if not who:
        # 담당자가 없으면 흔들릴 준수율도 없다. 변경 이력은 위에서 이미 남겼다.
        return

    # `change.id` 가 있어야 변경마다 다른 근거를 가리킬 수 있다.
    session.flush()
    for user_id in who:
        _emit(
            session,
            project_id=task.project_id,
            # ⭐ **담당자**에게 붙인다. 바꾼 사람이 아니다.
            # `_detect_integrity_flags` 가 이 사람의 met/missed 건수와 비교하므로,
            # 바꾼 사람에게 붙이면 두 사람의 숫자를 섞은 비율이 된다.
            # 남이 바꿨다는 사실은 아래 `changed_by` 로 근거에 남는다.
            #
            # ⚠️ **몫을 안 나눕니다.** 이건 점수가 아니라 표시(`magnitude=0`)라
            # 나눌 것이 없습니다. 둘이 맡은 업무의 마감이 밀렸으면 둘 다
            # 그 사실 위에 있습니다.
            user_id=user_id,
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
