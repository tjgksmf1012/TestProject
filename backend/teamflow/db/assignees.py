"""업무 담당자를 묻는 **유일한 자리** (`TASK-006`).

## ⚠️ 왜 한 곳이어야 하는가

담당자는 `tasks.assignee_id` 한 칸이었습니다. 여럿을 받으려면 표가 되어야
하는데, 그러면 "이 업무는 누구 것인가" 를 묻는 코드가 **아홉 군데**로
흩어집니다 — 칸반·달력·검색·알림·PR 연결·위험 신호·승인·기여 이벤트·
지켜진 약속.

각자 `select(TaskAssignee.user_id).where(...)` 를 적게 두면 그중 하나는
반드시 다르게 적히고, 다르게 적힌 곳이 조용히 틀립니다. `db/live.py` 와
같은 판단이고 같은 이유입니다 (대표 실패 ②).

## ⚠️ `tasks.assignee_id` 를 **남겨 두지 않았습니다**

"대표 담당자는 칸에, 나머지는 표에" 가 제일 손이 덜 가는 길인데, 그건
같은 사실을 두 벌로 두는 것입니다. 한쪽만 고쳐지는 것이 이 저장소의
대표 실패 ② 이고, 담당자는 **기여 이벤트가 누구에게 가는지**를 정하므로
갈라지면 점수가 갈라집니다.

## 읽을 때는 이름 순입니다

⚠️ 넣은 순서로 주면 화면은 **맨 앞을 주담당으로** 읽습니다. 그런 것은
없습니다 — 두 사람이 맡았으면 둘 다 담당자입니다. 그래서 사람 이름 순으로
돌려주고, 화면은 받은 순서를 그대로 그립니다
(`AGENTS.md` 불변식 1 — 목록은 이름 순).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence

from sqlalchemy import ColumnElement, Select, select
from sqlalchemy.orm import Session

from teamflow.db import models as m


def normalize(user_ids: Iterable[int]) -> list[int]:
    """중복을 걷어낸 담당자 목록.

    같은 사람을 두 번 넣는 것은 화면 실수이지 뜻이 있는 입력이 아닙니다.
    거절하지 않고 조용히 합칩니다 — 거절하면 사용자는 무엇이 잘못됐는지
    모른 채 저장 버튼만 다시 누릅니다.

    ⚠️ **여기서 정렬하지 않습니다.** 저장 순서는 뜻이 없고, 읽을 때
    이름 순으로 나갑니다. 여기서 번호 순으로 정렬해 두면 "번호가 작은
    사람이 먼저" 라는 없는 규칙이 생깁니다.
    """
    seen: list[int] = []
    for user_id in user_ids:
        if user_id not in seen:
            seen.append(user_id)
    return seen


def of_task(session: Session, task_id: int) -> list[int]:
    """업무 하나의 담당자. 이름 순."""
    return list(
        session.scalars(
            select(m.TaskAssignee.user_id)
            .join(m.User, m.User.id == m.TaskAssignee.user_id)
            .where(m.TaskAssignee.task_id == task_id)
            .order_by(m.User.name, m.TaskAssignee.user_id)
        ).all()
    )


def of_tasks(session: Session, task_ids: Sequence[int]) -> dict[int, list[int]]:
    """여러 업무의 담당자를 한 번에.

    ⚠️ **업무마다 `of_task` 를 부르지 마십시오.** 칸반은 카드가 수십
    장이라 그대로 N+1 이 됩니다. 담당자가 없는 업무는 키가 아예 없습니다 —
    부르는 쪽에서 `.get(task_id, [])` 로 받으십시오.
    """
    if not task_ids:
        return {}
    out: dict[int, list[int]] = {}
    rows = session.execute(
        select(m.TaskAssignee.task_id, m.TaskAssignee.user_id)
        .join(m.User, m.User.id == m.TaskAssignee.user_id)
        .where(m.TaskAssignee.task_id.in_(task_ids))
        .order_by(m.User.name, m.TaskAssignee.user_id)
    ).all()
    for task_id, user_id in rows:
        out.setdefault(task_id, []).append(user_id)
    return out


#: 담당자를 여럿 적을 때 이름 사이에 넣는 것.
#:
#: ⚠️ **한 곳에만 있어야 합니다.** 달력과 검색이 각자 이으면 한쪽은
#: 쉼표, 한쪽은 가운뎃점이 되고 같은 업무가 화면마다 다르게 보입니다.
NAME_JOIN = " · "


def names_of_tasks(session: Session, task_ids: Sequence[int]) -> dict[int, str]:
    """화면에 그대로 적는 담당자 이름. 이름 순.

    담당자가 없는 업무는 키가 없습니다 — 부르는 쪽에서 `.get(id)` 가
    `None` 이 되고, 그게 "담당자 없음" 입니다. 빈 문자열로 주면 화면이
    **이름 칸을 빈 채로 그립니다.**
    """
    if not task_ids:
        return {}
    out: dict[int, list[str]] = {}
    rows = session.execute(
        select(m.TaskAssignee.task_id, m.User.name)
        .join(m.User, m.User.id == m.TaskAssignee.user_id)
        .where(m.TaskAssignee.task_id.in_(task_ids))
        .order_by(m.User.name, m.TaskAssignee.user_id)
    ).all()
    for task_id, name in rows:
        out.setdefault(task_id, []).append(name)
    return {task_id: NAME_JOIN.join(names) for task_id, names in out.items()}


def joined_to_tasks() -> ColumnElement[bool]:
    """`tasks` 와 이어 붙이는 조건. 담당자마다 한 줄씩 나옵니다.

    업무와 담당자를 **한 질의에서 짝으로** 봐야 하는 곳이 있습니다
    (지켜진 약속 — 약속한 사람이 담당자인가). 거기서 조건을 손으로 적으면
    이 모듈을 안 거치게 되고, 그 순간 담당자를 묻는 자리가 두 벌이 됩니다.

    ⚠️ **inner join 입니다.** 담당자가 없는 업무는 아예 안 나옵니다 —
    바깥 조인이 필요하면 그 자리에서 `outerjoin` 에 이 조건을 쓰십시오.
    """
    return m.TaskAssignee.task_id == m.Task.id


def task_ids_of(user_id: int) -> Select:
    """이 사람이 맡은 업무 번호. 다른 질의에 `in_()` 으로 끼워 씁니다."""
    return select(m.TaskAssignee.task_id).where(m.TaskAssignee.user_id == user_id)


def replace(session: Session, task_id: int, user_ids: Iterable[int]) -> list[int]:
    """담당자를 이 목록으로 **바꿉니다.** 새로 추가된 사람을 돌려줍니다.

    돌려주는 것이 "지금 담당자" 가 아니라 **새로 들어온 사람**인 이유:
    부르는 쪽이 그 사람들에게만 알림을 보내야 합니다. 이미 담당자였던
    사람에게 다시 알리면, 마감일 한 번 고칠 때마다 알림이 갑니다.

    ⚠️ 지운 담당자에게는 아무 일도 하지 않습니다. 이미 쌓인 기여
    이벤트는 그대로 남습니다 — 기여 이벤트는 append-only 이고, 담당자에서
    빠졌다고 **했던 일이 없던 일이 되지는 않습니다.**
    """
    wanted = normalize(user_ids)
    current = set(
        session.scalars(
            select(m.TaskAssignee.user_id).where(m.TaskAssignee.task_id == task_id)
        ).all()
    )

    leaving = select(m.TaskAssignee).where(m.TaskAssignee.task_id == task_id)
    if wanted:
        leaving = leaving.where(m.TaskAssignee.user_id.notin_(wanted))
    for row in session.scalars(leaving).all():
        session.delete(row)

    added = [uid for uid in wanted if uid not in current]
    for user_id in added:
        session.add(m.TaskAssignee(task_id=task_id, user_id=user_id))
    session.flush()
    return added
