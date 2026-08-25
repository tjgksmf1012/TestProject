"""알림 (요구사항 정의서 §19 NOTIFICATION-001~006).

## ⚠️ 여섯 중 넷만 **저장**합니다 — 둘은 읽어서 만듭니다

정의서가 요구하는 여섯을 두 종류로 갈랐습니다.

    001 멘션 · 002 업무 배정 · 005 회의 일정 · 006 GitHub
        → **일어난 사건**입니다. 그 순간이 아니면 다시 알 수 없으므로 저장합니다

    003 마감 임박 · 004 지연
        → **지금 상태에서 나옵니다.** 저장하면 안 됩니다

003·004 를 행으로 쌓으면 이렇게 됩니다 — 마감일을 미루면 "곧 마감" 알림이
남아 있고, 업무를 끝내면 "지연" 알림이 남아 있습니다. 알림은 사실을
가리켜야 하는데 **베낀 순간의 사실**을 가리키게 됩니다. 이 저장소가 반복해서
당한 실패 ② 입니다.

## ⚠️ 글자를 저장하지 않습니다

`notifications` 에는 **무엇을 가리키는지**(업무 번호·메시지 번호)만 있고
"…님이 회의록을 올렸습니다" 같은 문장은 없습니다. 문장을 저장하면 업무
이름을 고쳤을 때 알림만 옛 이름을 말합니다. 문장은 읽을 때 만듭니다.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from teamflow.clock import as_utc
from teamflow.db import assignees, live, vocab
from teamflow.db import models as m
from teamflow.db.vocab import NotificationKind
from teamflow.github import linking as gh_linking
from teamflow.github import presenting
from teamflow.services.naming import meeting_label

#: 마감이 **며칠 앞**이면 임박인가 (NOTIFICATION-003).
#:
#: ⚠️ 숫자를 여기 한 곳에만 둡니다. 화면이 자기 기준으로 또 세면 배지에
#: 뜨는 건수와 목록의 줄 수가 달라집니다.
SOON_DAYS = 3

#: 한 번에 돌려주는 최대 건수. 없으면 1년 치가 한 번에 옵니다.
MAX_ITEMS = 50


@dataclass(frozen=True, slots=True)
class Notice:
    kind: str
    #: 언제 생긴 일인가. 파생 알림은 **기준이 되는 날**입니다.
    at: datetime
    #: 사람이 읽을 문장. ⚠️ 저장된 것이 아니라 **지금 만든 것**입니다.
    text: str
    task_id: int | None = None
    meeting_id: int | None = None
    message_id: int | None = None
    channel_id: int | None = None
    #: 저장된 알림만 읽음 표시를 가집니다. 파생 알림은 `None` —
    #: ⚠️ 읽었다고 마감이 사라지지 않습니다.
    notification_id: int | None = None
    read: bool = False


def record(
    session: Session,
    *,
    user_id: int,
    project_id: int,
    kind: NotificationKind,
    task_id: int | None = None,
    meeting_id: int | None = None,
    message_id: int | None = None,
    github_event_id: int | None = None,
) -> m.Notification | None:
    """사건 하나를 남긴다.

    ⚠️ **자기가 한 일은 자기에게 안 알립니다.** 부르는 쪽에서 걸러도 되지만,
    부르는 자리가 늘수록 한 곳이 빠집니다. 여기서 막습니다.

    ⚠️ GitHub 알림은 `github_event_id` **까지** 넘겨야 합니다 (결함 396).
    `task_id` 만 넘기면 한 업무에 PR 이 둘 붙었을 때 두 줄이 글자·시각·
    링크까지 똑같아져 어느 PR 인지 알 방법이 없습니다.

    돌려주는 값이 `None` 이면 안 남긴 것입니다.
    """
    notice = m.Notification(
        user_id=user_id,
        project_id=project_id,
        kind=str(kind),
        task_id=task_id,
        meeting_id=meeting_id,
        message_id=message_id,
        github_event_id=github_event_id,
    )
    session.add(notice)
    session.flush()
    return notice


def record_mentions(
    session: Session, message: m.Message, *, project_id: int, author_id: int
) -> int:
    """NOTIFICATION-001 — 이 메시지가 부른 사람들에게.

    ⚠️ **자기가 자기를 부른 것은 안 알립니다.** `@내이름` 을 적어 자기
    알림을 만드는 것은 뜻이 없고, 목록만 지저분해집니다.
    """
    user_ids = list(
        session.scalars(
            select(m.MessageMention.user_id).where(
                m.MessageMention.message_id == message.id
            )
        ).all()
    )
    made = 0
    for user_id in user_ids:
        if user_id == author_id:
            continue
        record(
            session,
            user_id=user_id,
            project_id=project_id,
            kind=NotificationKind.MENTION,
            message_id=message.id,
        )
        made += 1
    return made


def record_assignment(
    session: Session, task: m.Task, user_ids: list[int], *, actor_id: int | None
) -> list[m.Notification]:
    """NOTIFICATION-002 — 새 담당자에게.

    ⚠️ 담당자가 없으면 알릴 사람이 없습니다. 자기가 자기에게 맡긴 것도
    안 알립니다 — 방금 자기가 한 일입니다.

    ⚠️ `user_ids` 는 **새로 들어온 사람**입니다 (`TASK-006`). 지금 담당자
    전원을 넘기면, 담당자를 한 명 더할 때마다 원래 있던 사람에게도
    "새 업무를 맡았습니다" 가 갑니다.
    """
    made: list[m.Notification] = []
    for user_id in user_ids:
        if user_id == actor_id:
            continue
        made.append(
            record(
                session,
                user_id=user_id,
                project_id=task.project_id,
                kind=NotificationKind.ASSIGNED,
                task_id=task.id,
            )
        )
    return made


#: 회의 **몇 분 전**에 알리는가 (NOTIFICATION-005).
#:
#: ⚠️ 너무 이르면 알림이 왔을 때 아직 할 일이 아니고, 너무 늦으면 이미
#: 늦은 뒤입니다. 30분은 "자리로 돌아갈 수 있는" 최소치입니다.
MEETING_SOON_MINUTES = 30


def announce_upcoming_meetings(session: Session, *, now: datetime) -> int:
    """NOTIFICATION-005 — 곧 시작할 회의를 팀원에게 알린다.

    주기 작업이 부릅니다 (`tasks/maintenance.py`).

    ⚠️ **두 번 알리지 않습니다.** 주기 작업은 몇 분마다 도는데, 그때마다
    같은 회의를 다시 알리면 30분 동안 알림이 여섯 개 쌓입니다. 이미
    남긴 것이 있으면 건너뜁니다.

    ⚠️ **이미 연 회의는 안 알립니다.** `started_at` 이 있으면 벌써
    시작한 것이고, "곧 시작합니다" 는 거짓말이 됩니다.
    """
    edge = now + timedelta(minutes=MEETING_SOON_MINUTES)
    meetings = session.scalars(
        select(m.Meeting).where(
            m.Meeting.scheduled_at.is_not(None),
            m.Meeting.started_at.is_(None),
        )
    ).all()

    made = 0
    for meeting in meetings:
        at = as_utc(meeting.scheduled_at) if meeting.scheduled_at is not None else None
        if at is None or not (now <= at <= edge):
            continue

        already = session.scalar(
            select(m.Notification.id).where(
                m.Notification.meeting_id == meeting.id,
                m.Notification.kind == str(NotificationKind.MEETING_SOON),
            )
        )
        if already is not None:
            continue

        member_ids = session.scalars(
            select(m.Member.user_id).where(m.Member.project_id == meeting.project_id)
        ).all()
        for user_id in member_ids:
            record(
                session,
                user_id=user_id,
                project_id=meeting.project_id,
                kind=NotificationKind.MEETING_SOON,
                meeting_id=meeting.id,
            )
            made += 1
    session.flush()
    return made


#: 어느 사건인지 **알 수 없을 때** 쓰는 뭉뚱그린 말.
#:
#: ⚠️ 지금은 안 쓰입니다 — `vocab.LINKED_TO_TASKS` 가 하나뿐이라
#: `github_event_word` 가 그 하나의 이름을 정확히 말합니다. 집합이 늘면
#: 여기로 떨어지고, 그때는 **알림 행이 사건을 가리키게** 만드는 것이
#: 맞습니다(`github_event_id`).
VAGUE_GITHUB_WORD = "연결된 PR 상태가 바뀌었습니다"


def github_event_word() -> str:
    """GitHub 알림이 **무슨 일**을 가리키는가.

    ## ⚠️ 왜 이런 모양인가 (결함 357)

    `notifications` 는 **글자를 저장하지 않습니다** — 무엇을 가리키는지만
    담습니다(이 모듈 머리말). 그래서 이 알림 행에는 「어느 GitHub
    사건인가」가 없고, 예전에는 그래서 문장이 「연결된 PR **상태가
    바뀌었습니다**」였습니다.

    그런데 이 알림을 만들 수 있는 사건은 지금 **하나뿐**입니다
    (`vocab.LINKED_TO_TASKS` — `task_link_service` 가 그 집합만 잇습니다).
    하나면 그 하나의 이름을 그대로 말할 수 있습니다.

    ⚠️ **낱말을 여기서 짓지 않습니다.** `presenting.event_label` 을
    거칩니다 — GitHub 피드와 찾기가 같은 사건을 「PR 병합」이라고 부르는데
    알림만 다른 말을 하고 있었습니다(결함 347 이 그 모듈을 만든 이유가
    정확히 이것이고, 이 자리를 빠뜨렸습니다).
    """
    kinds = vocab.LINKED_TO_TASKS
    if len(kinds) != 1:
        return VAGUE_GITHUB_WORD
    return presenting.event_label(str(next(iter(kinds))))


def mark_read(session: Session, user_id: int, notification_ids: list[int]) -> int:
    """읽음 표시.

    ⚠️ **남의 알림은 못 읽습니다.** `user_id` 로 한 번 더 거릅니다 —
    번호만 알면 남의 알림을 지울 수 있으면 안 됩니다.
    """
    if not notification_ids:
        return 0
    rows = list(
        session.scalars(
            select(m.Notification).where(
                m.Notification.id.in_(notification_ids),
                m.Notification.user_id == user_id,
                m.Notification.read_at.is_(None),
            )
        ).all()
    )
    now = datetime.now(UTC)
    for row in rows:
        row.read_at = now
    session.flush()
    return len(rows)


# ══════════════════════════════════════════════════════════════
# 읽기 — 저장된 것 + 지금 상태에서 나온 것
# ══════════════════════════════════════════════════════════════


def _text_for(session: Session, row: m.Notification) -> str:
    """저장된 알림을 **지금** 문장으로 만든다.

    ⚠️ 문장을 저장하지 않는 이유가 여기 있습니다 — 업무 이름을 고치면
    이 문장도 따라옵니다.
    """
    kind = row.kind
    if kind == NotificationKind.MENTION and row.message_id is not None:
        message = session.get(m.Message, row.message_id)
        if message is None:
            return "부른 메시지를 찾을 수 없습니다"
        where = _which_channel(session, message)
        if message.deleted_at is not None:
            # ⚠️ 지운 글의 본문을 알림으로 되살리면 지운 것이 지운 것이 아닙니다.
            #    ⚠️ **이 갈래에도 자리를 적습니다** (결함 397) — 안 적으면
            #    지워진 부름이 둘일 때 또 똑같은 두 줄이 됩니다.
            return f"{where}에서 나를 부른 메시지가 지워졌습니다"
        author = session.get(m.User, message.author_id)
        who = author.name if author is not None else "누군가"
        return f"{who} 님이 {where}에서 나를 불렀습니다"

    if kind == NotificationKind.ASSIGNED and row.task_id is not None:
        task = session.get(m.Task, row.task_id)
        return (
            f"업무를 맡았습니다 — {task.title}"
            if task is not None
            else "맡은 업무를 찾을 수 없습니다"
        )

    if kind == NotificationKind.MEETING_SOON and row.meeting_id is not None:
        meeting = session.get(m.Meeting, row.meeting_id)
        # ⚠️ 예전에는 여기만 「이름 없는 회의」였습니다 (결함 285) —
        #    화면은 「제목 없는 회의」라고 부릅니다. 낱말 하나가 달라도
        #    사람은 다른 것으로 읽습니다. 이름은 한 벌에서 옵니다.
        title = meeting_label(meeting.title, meeting.id) if meeting is not None else None
        return f"곧 회의가 시작됩니다 — {title or '회의를 찾을 수 없습니다'}"

    if kind == NotificationKind.GITHUB and row.task_id is not None:
        task = session.get(m.Task, row.task_id)
        if task is None:
            return "연결된 업무를 찾을 수 없습니다"
        return f"{github_event_word()} — {task.title}{_which_pull(session, row)}"

    # ⚠️ 모르는 종류를 그럴듯한 문장으로 지어내지 않습니다.
    return "알림"


def _which_channel(session: Session, message: m.Message) -> str:
    """이 부름이 **어느 채널**에서 왔는가 (결함 397).

    ## ⚠️ 왜 필요한가

    한 사람이 나를 두 번 부르면 알림이 두 줄인데 예전에는 글자가
    「김민수 님이 **대화**에서 나를 불렀습니다」로 **똑같았습니다.** 링크도
    둘 다 `/chat.html?project=N` 이라 **아무것도 안 갈렸습니다** — 결함 396
    이 GitHub 알림에서 겪은 그 모양입니다.

    ⚠️ 다른 점은 **가리킬 것이 이미 있었다**는 것입니다. 행에 `message_id`
    가 들어 있는데 문장도 링크도 그걸 안 썼습니다. `hrefFor` 의 옆 갈래는
    회의 번호를 `?meeting=N` 으로 **들고 가는데** 이 갈래만 버립니다.

    ## ⚠️ `#` 을 여기서 붙이지 않습니다

    `@lib/chat/view.ts` 의 `channelTitle` 이 「`#` 은 **여기서** 붙입니다」
    라고 적어 두고 그 이유까지 답니다. 서버가 같은 규칙을 다시 적으면
    두 벌이 되고, 두 벌은 갈라집니다(실패 ②). 그래서 이 제품의 **서버
    산문이 이미 쓰는 모양**을 그대로 씁니다 — `channel_service` 의
    「`{이름}` 채널이 이미 있습니다」와 같은 「이름 + 채널」입니다.

    ⚠️ **모르면 옛 낱말로 돌아갑니다.** 채널이 지워졌거나 못 찾으면
    「대화」입니다 — 없는 이름을 지어내지 않습니다.
    """
    channel = session.get(m.Channel, message.channel_id)
    if channel is None or not (channel.name or "").strip():
        return "대화"
    return f"{channel.name.strip()} 채널"


def _which_pull(session: Session, row: m.Notification) -> str:
    """어느 PR 인가, 그리고 그 연결이 **확정인가 추정인가** (결함 396).

    ## ⚠️ 왜 필요한가

    한 업무에 PR 이 둘 붙으면 알림이 두 줄인데, `task_id` 만 있으면
    글자·시각·링크가 **한 자도 안 달랐습니다.** 재현했습니다 — 서명한
    웹훅 둘(하나는 본문에 `TASK-4`, 하나는 브랜치 `chore/4-a11y`)을 보내니
    담당자 화면에 「PR 병합 — 접근성 점검」이 **두 번** 똑같이 나왔습니다.

    ## ⚠️ 추정을 확정처럼 말하지 않습니다

    둘 중 하나는 브랜치 이름의 숫자로 **추정**한 연결이었습니다
    (`link_source=branch` · `relevance=0.6`). 같은 저장소의 `sortLinks`
    주석이 그 해악을 이미 적어 뒀습니다 — 「추정이 위에 있으면 그게
    사실로 보이고, "이 업무는 이 PR 로 끝났다" 를 틀리게 믿습니다」.
    칸반은 「PR 1건 (전부 추정 — 확인 필요)」라고 말하는데 알림만
    안 말하고 있었습니다.

    ⚠️ **확정/추정을 알림 행에 적어 두지 않습니다.** 사람이 확인해서
    확정으로 바꾸면 그 글자만 옛말이 됩니다 — 지금 읽습니다.

    ⚠️ **옛 알림은 이 칸이 비어 있습니다.** 그때는 아무 말도 안 붙입니다.
    모르는 것을 지어내지 않습니다.
    """
    if row.github_event_id is None:
        return ""
    event = session.get(m.GithubEvent, row.github_event_id)
    if event is None:
        return ""
    pull = (event.payload or {}).get("pull_request") or {}
    number = pull.get("number")
    where = f"{event.repo}#{number}" if number is not None else event.repo

    link = session.get(m.TaskGithubLink, (row.task_id, row.github_event_id))
    if link is not None and float(link.relevance) < gh_linking.CONFIRMED_THRESHOLD:
        return f" · {where} (추정 — 확인 필요)"
    return f" · {where}"


def collect(
    session: Session, user_id: int, project_id: int, *, now: datetime
) -> list[Notice]:
    """이 사람이 지금 볼 알림 전부. **새것부터.**

    저장된 사건 + 지금 상태에서 나오는 마감 알림을 합칩니다.
    """
    notices: list[Notice] = []

    rows = session.scalars(
        select(m.Notification)
        .where(
            m.Notification.user_id == user_id,
            m.Notification.project_id == project_id,
        )
        .order_by(m.Notification.id.desc())
        .limit(MAX_ITEMS)
    ).all()
    for row in rows:
        notices.append(
            Notice(
                kind=row.kind,
                at=as_utc(row.created_at),
                text=_text_for(session, row),
                task_id=row.task_id,
                meeting_id=row.meeting_id,
                message_id=row.message_id,
                notification_id=row.id,
                read=row.read_at is not None,
            )
        )

    # ⚠️ **마감·지연에 자리를 먼저 줍니다** (결함 398).
    #
    # 예전에는 저장된 사건과 그냥 합쳐서 시각 내림차순으로 자른 뒤
    # `[:MAX_ITEMS]` 했습니다. 그런데 두 갈래의 `at` 은 **뜻이 다릅니다**
    # (결함 331 이 적어 둔 그것) — 저장된 사건은 「일어난 때」이고
    # 마감 알림은 **「마감일」**입니다. 지난 마감은 과거라 목록 맨 아래로
    # 가라앉고, 채팅이 50통 오면 **통째로 잘려 나갔습니다.**
    #
    # 재현: 조용할 때 「마감일이 지났습니다 — 접근성 점검」이 보이던 사람에게
    # 부름 60통을 보내니 마감/지연이 **0줄**이 됐습니다.
    #
    # ⚠️ 이 화면은 머리말에서 「다가오는 마감과 회의입니다」라고 약속하고,
    # 바로 다음 문장에서 **「마감일을 미루거나 업무를 끝내면 그 자리에서
    # 사라집니다」**라고 사라지는 조건까지 가르칩니다. 채팅 때문에 사라지면
    # 사람은 그 규칙을 믿고 **「누가 끝냈나 보다」**라고 읽습니다.
    #
    # 마감 알림의 개수는 **그 사람이 맡은, 안 끝난, 마감일 있는 업무**로
    # 묶여 있어 저절로 작습니다. 저장된 사건(채팅)만 무한히 늘어납니다.
    # 그러니 자리를 다투게 두지 않습니다.
    deadlines = deadline_notices(session, user_id, project_id, now=now)
    # ⚠️ 마감이 그 자체로 넘칠 때는 **급한 것부터** 남깁니다(오래 지난 것 =
    #    `at` 이 작은 것). 화면에 그리는 순서와 자르는 순서는 다릅니다.
    deadlines.sort(key=lambda n: as_utc(n.at))
    room = max(0, MAX_ITEMS - len(deadlines))
    merged = [*deadlines[:MAX_ITEMS], *notices[:room]]
    merged.sort(key=lambda n: as_utc(n.at), reverse=True)
    return merged


def deadline_notices(
    session: Session, user_id: int, project_id: int, *, now: datetime
) -> list[Notice]:
    """NOTIFICATION-003·004 — **저장하지 않고** 지금 상태에서 만든다.

    ⚠️ 이걸 행으로 쌓으면 마감일을 미뤘을 때 "곧 마감" 이 남고, 업무를
    끝냈을 때 "지연" 이 남습니다. 알림이 **베낀 순간의 사실**을 가리키게
    됩니다.

    ⚠️ 끝난 업무는 안 나옵니다. 마감일이 지났어도 끝냈으면 지연이 아닙니다.
    """
    tasks = session.scalars(
        live.live_tasks().where(
            m.Task.project_id == project_id,
            m.Task.id.in_(assignees.task_ids_of(user_id)),
            m.Task.deadline.is_not(None),
            m.Task.status != vocab.TaskStatus.DONE,
        )
    ).all()

    out: list[Notice] = []
    soon_edge = now + timedelta(days=SOON_DAYS)
    for task in tasks:
        due = as_utc(task.deadline) if task.deadline is not None else None
        if due is None:
            continue
        if due < now:
            out.append(
                Notice(
                    kind=str(NotificationKind.OVERDUE),
                    at=due,
                    text=f"마감일이 지났습니다 — {task.title}",
                    task_id=task.id,
                )
            )
        elif due <= soon_edge:
            out.append(
                Notice(
                    kind=str(NotificationKind.DUE_SOON),
                    at=due,
                    text=f"곧 마감입니다 — {task.title}",
                    task_id=task.id,
                )
            )
    return out


def unread_count(
    session: Session, user_id: int, project_id: int, *, now: datetime
) -> int:
    """배지에 쓸 수.

    ⚠️ **파생 알림은 안 셉니다.** 마감은 읽어도 안 없어지므로, 배지가
    영영 안 줄어드는 숫자가 됩니다 — 그러면 사람은 배지를 안 봅니다.
    자세한 것은 `docs/20`.
    """
    return int(
        session.scalar(
            select(func.count(m.Notification.id)).where(
                m.Notification.user_id == user_id,
                m.Notification.project_id == project_id,
                m.Notification.read_at.is_(None),
            )
        )
        or 0
    )
