"""달력에 올릴 것들 (요구사항 정의서 §16 CALENDAR-001~005).

## ⚠️ 달력은 **읽어서 만듭니다** — 베껴 두지 않습니다

정의서가 요구하는 다섯 중 넷은 이미 있는 행에서 나옵니다.

    CALENDAR-002  업무 시작일·마감일   → `tasks`
    CALENDAR-003  회의 일정            → `meetings.scheduled_at`
    CALENDAR-005  프로젝트 마감일      → `projects.deadline`

이걸 `calendar_events` 같은 표에 베껴 담으면, 업무 마감일을 고쳤을 때
달력만 옛 날짜를 말합니다. **두 벌이 있으면 한쪽만 고쳐집니다** — 이
저장소가 반복해서 당한 실패 ② 입니다.

## ⚠️ 시각을 **날짜로 자르지 않고** 그대로 보냅니다

어느 날에 놓을지는 화면이 팀 달력(`Asia/Seoul`)으로 정합니다
(`lib/time/calendar.ts` 의 `teamDateOf`, 테스트가 붙어 있습니다). 여기서
한 번 더 자르면 시간대 계산이 두 벌이 되고, 서버는 UTC 로 자르는데
화면은 서울로 잘라서 **밤에 잡힌 회의가 하루 어긋납니다.**
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from teamflow.clock import as_utc
from teamflow.db import assignees, live, vocab
from teamflow.db import models as m
from teamflow.services.naming import meeting_label

#: 달력에 놓이는 것의 종류.
#:
#: ⚠️ 지난 회의와 **예정된** 회의를 같은 종류로 두지 않습니다. 같으면
#: 화면이 "이미 한 것" 과 "앞으로 할 것" 을 같은 모양으로 그리고, 그건
#: 달력에서 제일 알고 싶은 것을 지우는 것입니다.
ItemKind = Literal[
    "task_start",  # 업무 시작일
    "task_due",  # 업무 마감일
    "meeting_planned",  # 예정된 회의 (아직 안 열림)
    "meeting_held",  # 이미 연 회의
    "project_due",  # 프로젝트 최종 마감일
]


@dataclass(frozen=True, slots=True)
class CalendarItem:
    kind: ItemKind
    #: ⚠️ **자르지 않은 순간**입니다. 어느 날인지는 화면이 정합니다.
    at: datetime
    title: str
    #: 눌러서 갈 곳의 근거. 종류에 따라 업무·회의 번호입니다.
    task_id: int | None = None
    meeting_id: int | None = None
    #: 담당자 이름. 없으면 `None` — ⚠️ **"미정" 같은 글자를 여기서 만들지
    #: 않습니다.** 그건 화면이 할 말이고, 여기서 만들면 그 말이 두 벌이 됩니다.
    who: str | None = None
    #: 이미 끝난 것인가. 마감일이 지났어도 끝났으면 빨갛게 그릴 일이 아닙니다.
    done: bool = False


class CalendarError(Exception):
    """부를 수 없는 요청. API 가 400/404 로 옮깁니다."""


def collect(
    session: Session, project_id: int, *, since: datetime, until: datetime
) -> list[CalendarItem]:
    """이 기간에 놓이는 것 전부. **이른 것부터.**

    ⚠️ 범위를 **넘겨 받습니다.** 전부 주면 3년치 업무가 한 번에 오고,
    화면은 그중 한 달만 씁니다.

    ⚠️ 날짜가 없는 업무는 **안 나옵니다.** 마감일이 없는 업무를 오늘에
    놓으면 "오늘까지" 라는 없던 사실이 생깁니다 (측정 불가 ≠ 0 과 같은 결).
    """
    # ⚠️ **요청으로 들어온 값도 같이 맞춥니다** (결함 330). 아래 `within` 은
    #    DB 에서 읽은 값만 `as_utc` 로 맞추고 이쪽은 그대로 썼습니다. 그래서
    #    시간대 없이 온 요청(`since=2026-09-01`)이 비교에서 터졌습니다 —
    #    `as_utc` 의 docstring 이 인용해 둔 바로 그 `TypeError` 이고, 사람에게는
    #    **500** 으로 나갑니다. 막으려고 만든 함수를 **한쪽 피연산자에만**
    #    걸어 둔 것입니다.
    since = as_utc(since)
    until = as_utc(until)

    if until < since:
        raise CalendarError("끝나는 날이 시작하는 날보다 앞섭니다")

    # ⚠️ SQLite 는 tzinfo 를 **잃고** 돌려주고 PostgreSQL 은 붙여서
    #    돌려줍니다. 아래에서 파이썬으로 비교하므로 한쪽으로 맞춥니다 —
    #    안 맞추면 테스트에서만 TypeError 가 납니다 (`clock.as_utc`).
    def within(at: datetime | None) -> bool:
        return at is not None and since <= as_utc(at) <= until

    items: list[CalendarItem] = []

    tasks = session.scalars(
        live.live_tasks().where(
            m.Task.project_id == project_id,
            or_(
                m.Task.start_date.between(since, until),
                m.Task.deadline.between(since, until),
            ),
        )
    ).all()
    # 담당자는 여럿일 수 있습니다 (`TASK-006`). 잇는 자리는
    # `db/assignees.py` 한 곳입니다 — 화면마다 다르게 이으면 같은 업무가
    # 달력과 검색에서 다르게 보입니다.
    who_of = assignees.names_of_tasks(session, [t.id for t in tasks])
    for task in tasks:
        who = who_of.get(task.id)
        done = task.status in vocab.TASK_FINISHED
        if within(task.start_date):
            items.append(
                CalendarItem(
                    kind="task_start",
                    at=task.start_date,
                    title=task.title,
                    task_id=task.id,
                    who=who,
                    done=done,
                )
            )
        if within(task.deadline):
            items.append(
                CalendarItem(
                    kind="task_due",
                    at=task.deadline,
                    title=task.title,
                    task_id=task.id,
                    who=who,
                    done=done,
                )
            )

    meetings = session.scalars(
        select(m.Meeting).where(
            m.Meeting.project_id == project_id,
            or_(
                m.Meeting.scheduled_at.between(since, until),
                m.Meeting.started_at.between(since, until),
            ),
        )
    ).all()
    for meeting in meetings:
        title = meeting_label(meeting.title, meeting.id)
        # ⚠️ **연 회의는 연 시각으로** 놓습니다. 예정 시각으로 놓으면
        #    30분 늦게 시작한 회의가 달력에서는 제때 열린 것으로 보입니다.
        if within(meeting.started_at):
            items.append(
                CalendarItem(
                    kind="meeting_held",
                    at=meeting.started_at,
                    title=title,
                    meeting_id=meeting.id,
                    done=True,
                )
            )
        elif within(meeting.scheduled_at):
            items.append(
                CalendarItem(
                    kind="meeting_planned",
                    at=meeting.scheduled_at,
                    title=title,
                    meeting_id=meeting.id,
                )
            )

    project = session.get(m.Project, project_id)
    if project is not None and within(project.deadline):
        items.append(
            CalendarItem(
                kind="project_due",
                at=project.deadline,
                title=project.title,
                # ⚠️ 예순네 줄 위의 **업무** 갈래에서 `"done"` 을 베껴 왔었습니다.
                # 프로젝트에는 그런 값이 없습니다 — 어휘를 쓰십시오.
                done=project.status in vocab.PROJECT_FINISHED,
            )
        )

    # ⚠️ 같은 시각이면 **종류 순**으로 고정합니다. 안 고정하면 새로고침할
    #    때마다 순서가 바뀌고, 사람은 그걸 뭔가 일어난 것으로 읽습니다.
    order = {
        "project_due": 0,
        "meeting_planned": 1,
        "meeting_held": 2,
        "task_due": 3,
        "task_start": 4,
    }
    items.sort(key=lambda i: (as_utc(i.at), order[i.kind], i.title))
    return items


def schedule_meeting(
    session: Session,
    project_id: int,
    *,
    title: str,
    at: datetime,
    created_by: int,
    channel_id: int | None = None,
) -> m.Meeting:
    """회의 일정을 잡는다 (CALENDAR-003).

    ⚠️ **아직 회의를 여는 것이 아닙니다.** `started_at` 은 비어 있고
    상태는 `pending` 입니다 — 녹음도 동의도 시작하지 않았습니다. 여기서
    녹음까지 열면 잡아만 둔 회의가 "진행 중" 으로 보입니다.
    """
    clean = title.strip()
    if not clean:
        raise CalendarError("회의 이름이 비어 있습니다")
    if len(clean) > 200:
        raise CalendarError("회의 이름은 200자까지입니다")

    if channel_id is not None:
        channel = session.get(m.Channel, channel_id)
        if channel is None or channel.project_id != project_id:
            raise CalendarError("채널을 찾을 수 없습니다")

    meeting = m.Meeting(
        project_id=project_id,
        title=clean,
        scheduled_at=at,
        channel_id=channel_id,
        status="pending",
        started_by=created_by,
        capture_mode="multitrack",
    )
    session.add(meeting)
    session.flush()
    return meeting


def reschedule_meeting(
    session: Session, meeting: m.Meeting, *, at: datetime | None, title: str | None
) -> m.Meeting:
    """CALENDAR-004 — 잡아 둔 일정을 고친다.

    ⚠️ **이미 연 회의의 시각은 못 고칩니다.** 열린 시각은 일어난 사실이고,
    그걸 고치면 녹음 트랙의 시각과 어긋납니다.
    """
    if meeting.started_at is not None and at is not None:
        raise CalendarError("이미 연 회의의 시각은 고칠 수 없습니다")

    if title is not None:
        clean = title.strip()
        if not clean:
            raise CalendarError("회의 이름이 비어 있습니다")
        if len(clean) > 200:
            raise CalendarError("회의 이름은 200자까지입니다")
        meeting.title = clean

    if at is not None:
        meeting.scheduled_at = at

    session.flush()
    return meeting


def cancel_meeting(session: Session, meeting: m.Meeting) -> None:
    """잡아 둔 일정을 무른다.

    ⚠️ **아직 안 연 회의만** 무를 수 있습니다. 연 회의에는 동의 기록과
    녹음 트랙이 딸려 있어서, 행을 지우면 그것들이 허공에 뜹니다.
    """
    if meeting.started_at is not None:
        raise CalendarError("이미 연 회의는 무를 수 없습니다")

    # ⚠️ **이 회의로 만든 회의록도 같이 지웁니다** (결함 359).
    #
    # 위 문장이 「행을 지우면 그것들이 허공에 뜹니다」라고 적어 두고 연
    # 회의를 막았는데, **안 연 회의에도 딸리는 것이 하나 있었습니다** —
    # 로비의 「회의록 만들기」는 잡아만 둔 회의에도 있습니다. 일정을
    # 무르면 회의는 홈·레일·달력에서 사라지는데 그 회의록만 보고서
    # 목록에 남았고, **지울 방법이 저장소 어디에도 없었습니다**
    # (`reports` 에는 DELETE 갈래가 0곳). 재서 확인했습니다.
    #
    # ⚠️ 「무르기」는 **없던 일로 하는 것**입니다. 남기려면 남기는 이유가
    # 있어야 하는데, 안 연 회의의 회의록에는 지킬 내용이 없습니다 —
    # 요약도 안건도 후보도 전부 「아직 처리하지 않았습니다」입니다.
    session.execute(delete(m.Report).where(m.Report.meeting_id == meeting.id))
    session.delete(meeting)
    session.flush()
