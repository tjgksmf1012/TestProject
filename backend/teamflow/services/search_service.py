"""프로젝트 안에서 찾기 (요구사항 정의서 §20 SEARCH-001~005).

## ⚠️ **프로젝트 밖으로 새지 않습니다**

이 제품이 담고 있는 것은 회의 전사·팀 대화·기여 근거입니다. 검색은 그
전부를 한 상자에서 꺼내는 문이라, 범위가 한 번 새면 **남의 팀 회의록이
검색 결과로 나옵니다.** 모든 질의가 `project_id` 로 먼저 좁혀지고,
`test_search_api.py` 가 그것을 종류마다 다시 잽니다.

## ⚠️ 사람을 **세지 않습니다**

검색은 "무엇이 있나" 를 찾는 곳이지 "누가 얼마나" 를 세는 곳이 아닙니다.
결과에 사람 이름이 붙지만(누가 한 말인지 알아야 하니까), **사람별 건수를
집계해 돌려주는 함수가 여기 없습니다.** 그런 것이 생기면 그 순간
"검색 결과 기준 발언 순위" 가 만들어지고, 그건 이 저장소가 금지한
리더보드입니다 (`AGENTS.md` 불변식 1).

## ⚠️ 회의 내용 검색은 **동의의 산물**입니다

`utterances` 는 사람들이 녹음에 동의해서 생긴 것입니다(`docs/07`).
동의를 철회하면 그 행이 지워지고, 그러면 검색 결과에서도 사라집니다 —
따로 지울 것이 없게 **베껴 두지 않습니다.**
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from teamflow.clock import as_utc
from teamflow.db import assignees, live, vocab
from teamflow.db import models as m

#: 한 종류당 최대 건수.
#:
#: ⚠️ 상한이 없으면 흔한 낱말 하나가 회의 전사 전체를 실어 옵니다.
MAX_PER_KIND = 30

#: 이보다 짧은 질의는 **찾지 않습니다.**
#:
#: ⚠️ 한 글자로 찾으면 사실상 전부가 나옵니다 — 그건 결과가 아니라
#: 목록이고, 사람은 "검색이 고장 났다" 로 읽습니다.
MIN_QUERY = 2

Kind = Literal["task", "meeting", "utterance", "github"]


@dataclass(frozen=True, slots=True)
class Hit:
    kind: Kind
    #: 눌러서 갈 곳의 근거.
    task_id: int | None = None
    meeting_id: int | None = None
    #: 한 줄 제목.
    title: str = ""
    #: 찾은 낱말이 들어 있는 대목. 없으면 빈 글자.
    #: ⚠️ **잘라서 보내지 않습니다** — 어디를 잘라야 뜻이 사는지는 화면이
    #: 폭을 알아야 정할 수 있고, 여기서 자르면 그 판단이 두 벌이 됩니다.
    body: str = ""
    #: 언제. 정렬과 표시에 씁니다.
    at: datetime | None = None
    #: 누구. 없으면 `None` — ⚠️ "알 수 없음" 은 화면이 할 말입니다.
    who: str | None = None
    #: 업무 검색에서만. 상태를 사람 말로.
    status: str | None = None


class SearchError(Exception):
    """부를 수 없는 요청. API 가 400 으로 옮깁니다."""


def _like(query: str) -> str:
    # ⚠️ `%` 와 `_` 를 그대로 두면 사용자가 적은 `_` 가 **아무 글자**로
    #    동작합니다. 찾는 사람은 왜 엉뚱한 것이 나오는지 모릅니다.
    escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def search_tasks(
    session: Session,
    project_id: int,
    *,
    query: str = "",
    assignee_id: int | None = None,
    status: str | None = None,
    priority: int | None = None,
) -> list[Hit]:
    """SEARCH-002 — 업무명·담당자·상태·우선순위.

    ⚠️ **네 조건이 전부 선택입니다.** 하나만 줘도 되고 넷을 겹쳐도 됩니다.
    다 비어 있으면 빈 목록입니다 — 조건 없는 검색은 그냥 칸반이고,
    칸반은 이미 있습니다.
    """
    if status is not None and status not in {str(s) for s in vocab.TASK_STATUSES}:
        raise SearchError(f"알 수 없는 상태입니다: {status}")

    conditions = []
    if len(query.strip()) >= MIN_QUERY:
        conditions.append(m.Task.title.like(_like(query.strip()), escape="\\"))
    if assignee_id is not None:
        # 담당자가 여럿이면 **그 안에 있으면** 걸립니다 (`TASK-006`).
        conditions.append(m.Task.id.in_(assignees.task_ids_of(assignee_id)))
    if status is not None:
        conditions.append(m.Task.status == status)
    if priority is not None:
        conditions.append(m.Task.priority == priority)

    if not conditions:
        return []

    tasks = session.scalars(
        live.live_tasks()
        .where(m.Task.project_id == project_id, *conditions)
        .order_by(m.Task.id.desc())
        .limit(MAX_PER_KIND)
    ).all()
    who_of = assignees.names_of_tasks(session, [t.id for t in tasks])

    return [
        Hit(
            kind="task",
            task_id=task.id,
            title=task.title,
            at=as_utc(task.deadline) if task.deadline is not None else None,
            who=who_of.get(task.id),
            status=vocab.TASK_STATUS_LABEL[vocab.TaskStatus(task.status)],
        )
        for task in tasks
    ]


def search_meetings(
    session: Session,
    project_id: int,
    *,
    query: str = "",
    since: datetime | None = None,
    until: datetime | None = None,
) -> list[Hit]:
    """SEARCH-003 — 회의명과 날짜.

    ⚠️ **예정된 회의도 나옵니다.** 정의서는 "과거 회의" 라고 적었지만,
    이름으로 찾는 사람은 그것이 이미 열렸는지 모릅니다 — 안 나오면
    "없다" 로 읽습니다. 대신 언제인지를 같이 보냅니다.
    """
    conditions = []
    if len(query.strip()) >= MIN_QUERY:
        conditions.append(m.Meeting.title.like(_like(query.strip()), escape="\\"))
    if since is not None:
        conditions.append(
            or_(m.Meeting.started_at >= since, m.Meeting.scheduled_at >= since)
        )
    if until is not None:
        conditions.append(
            or_(m.Meeting.started_at <= until, m.Meeting.scheduled_at <= until)
        )

    if not conditions:
        return []

    rows = session.scalars(
        select(m.Meeting)
        .where(m.Meeting.project_id == project_id, *conditions)
        .order_by(m.Meeting.id.desc())
        .limit(MAX_PER_KIND)
    ).all()

    return [
        Hit(
            kind="meeting",
            meeting_id=meeting.id,
            title=(meeting.title or "").strip() or f"회의 {meeting.id}",
            at=as_utc(meeting.started_at or meeting.scheduled_at)
            if (meeting.started_at or meeting.scheduled_at) is not None
            else None,
        )
        for meeting in rows
    ]


def search_utterances(session: Session, project_id: int, query: str) -> list[Hit]:
    """SEARCH-004 — 회의에서 오간 말.

    ⚠️ **이 결과는 동의의 산물입니다** (`docs/07`). 사람들이 녹음에 동의해서
    생긴 행이고, 동의를 철회하면 지워집니다 — 그러면 여기서도 사라집니다.
    따로 베껴 두면 지워도 검색에 남습니다.

    ⚠️ 누가 한 말인지 같이 보냅니다. 그게 없으면 회의록을 찾아도 **누구에게
    물어야 할지** 알 수 없습니다. 다만 사람별 건수는 **세지 않습니다.**
    """
    if len(query.strip()) < MIN_QUERY:
        return []

    rows = session.execute(
        select(m.Utterance, m.Meeting.title, m.User.name)
        .join(m.Meeting, m.Meeting.id == m.Utterance.meeting_id)
        .outerjoin(m.User, m.User.id == m.Utterance.speaker_id)
        .where(
            m.Meeting.project_id == project_id,
            m.Utterance.text.like(_like(query.strip()), escape="\\"),
        )
        .order_by(m.Utterance.id.desc())
        .limit(MAX_PER_KIND)
    ).all()

    return [
        Hit(
            kind="utterance",
            meeting_id=utterance.meeting_id,
            title=(title or "").strip() or f"회의 {utterance.meeting_id}",
            body=utterance.text or "",
            who=who,
        )
        for utterance, title, who in rows
    ]


def search_github(session: Session, project_id: int, query: str) -> list[Hit]:
    """SEARCH-005 — 커밋·PR·이슈.

    ⚠️ **원문(`payload`)을 훑지 않습니다.** 저장된 JSON 에는 저장소 설정과
    사람의 이메일까지 들어 있어서, 그걸 그대로 검색하면 화면에 나올 일이
    없는 것이 검색으로 새어 나옵니다. 제목과 참조(`ref`)만 봅니다.

    ⚠️ 이 저장소는 **실제 GitHub 에 붙여 본 적이 없습니다** (`docs/20`).
    받아서 저장하는 경로는 테스트가 붙어 있지만, 실측은 못 했습니다.
    """
    if len(query.strip()) < MIN_QUERY:
        return []

    pattern = _like(query.strip())
    rows = session.scalars(
        select(m.GithubEvent)
        .where(
            m.GithubEvent.project_id == project_id,
            or_(
                m.GithubEvent.ref.like(pattern, escape="\\"),
                m.GithubEvent.repo.like(pattern, escape="\\"),
                m.GithubEvent.event_type.like(pattern, escape="\\"),
            ),
        )
        .order_by(m.GithubEvent.id.desc())
        .limit(MAX_PER_KIND)
    ).all()

    return [
        Hit(
            kind="github",
            title=f"{event.repo} · {event.event_type}",
            body=event.ref or "",
            at=as_utc(event.occurred_at) if event.occurred_at is not None else None,
            who=event.actor_login,
        )
        for event in rows
    ]
