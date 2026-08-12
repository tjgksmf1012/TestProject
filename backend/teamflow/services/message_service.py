"""채팅 메시지 — 쓰기·고치기·지우기·반응·읽어 오기 (CHAT-001~010).

여기가 **데이터베이스를 아는 쪽**입니다. 순수 판정(`@이름` 뽑기)은
`teamflow/chat/mentions.py` 에 있습니다.

## ⚠️ 여기서 `contribution/` 을 부르지 마십시오

정의서 §7 머리말이 "채팅 내용에 대한 AI 분석, 업무 자동 생성, 프로젝트
분석 등의 기능은 제공하지 않는다" 고 못 박습니다. 그냥 안 만든 게 아니라
**만들면 안 되는** 것입니다 — 메시지가 기여로 세어지는 순간 **도배가
기여도를 올리는 방법**이 됩니다. `test_chat_is_not_measured.py` 가 이
파일을 포함해 경계를 다시 잽니다.

## ⚠️ 지우는 것이 행을 지우는 것이 아닙니다

메시지는 `deleted_at`, 채널은 `archived_at` 입니다. 답글이 달린 말을
행째로 지우면 남의 답글이 허공에 뜹니다.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from teamflow.chat.mentions import find_mentions, strip_mention_marks
from teamflow.db import models as m
from teamflow.db.vocab import REACTION_LABEL, ReactionMark

#: 한 번에 돌려주는 메시지 수의 최대치 (CHAT-009).
#:
#: ⚠️ 상한이 없으면 채널 하나에 만 건이 쌓였을 때 한 번의 요청이 그걸 다
#: 실어 옵니다. 화면은 멈추고 서버는 그동안 다른 사람을 못 받습니다.
MAX_PAGE = 50

#: 본문 길이 상한. 넘으면 거절합니다.
#:
#: ⚠️ `Text` 컬럼이라 데이터베이스는 안 막습니다. 안 막으면 한 사람이 붙여
#: 넣기 한 번으로 채널을 못 읽게 만들 수 있습니다.
MAX_BODY = 4000


class MessageError(Exception):
    """부를 수 없는 요청. API 가 400/403/404 로 옮깁니다."""


def _clean_body(raw: str) -> str:
    body = raw.strip()
    if not body:
        raise MessageError("빈 메시지는 보낼 수 없습니다")
    if len(body) > MAX_BODY:
        raise MessageError(f"메시지는 {MAX_BODY}자까지입니다")
    return body


def _member_names(session: Session, project_id: int) -> dict[str, int]:
    """이 프로젝트 팀원의 `이름 → user_id`.

    ⚠️ **프로젝트 안에서만** 찾습니다. 전체 사용자에서 찾으면 `@민수` 가
    남의 팀 민수에게 갑니다.
    """
    rows = session.execute(
        select(m.User.name, m.User.id)
        .join(m.Member, m.Member.user_id == m.User.id)
        .where(m.Member.project_id == project_id)
    ).all()
    return {str(name): int(user_id) for name, user_id in rows}


def send_message(
    session: Session,
    channel: m.Channel,
    *,
    author_id: int,
    body: str,
    reply_to_id: int | None = None,
) -> m.Message:
    """메시지를 쓴다 (CHAT-001·004·005).

    ⚠️ 멘션은 **본문에서 서버가 뽑습니다.** 화면이 보낸 목록을 믿으면
    본문에 없는 사람 스무 명에게 알림을 쏠 수 있습니다.
    """
    clean = _clean_body(body)

    parent: m.Message | None = None
    if reply_to_id is not None:
        parent = session.get(m.Message, reply_to_id)
        if parent is None or parent.channel_id != channel.id:
            # ⚠️ 다른 채널의 메시지에 답글을 달게 두면, 그 채널을 못 보는
            #    사람의 글이 여기 인용으로 끌려 나옵니다.
            raise MessageError("답글을 달 메시지를 찾을 수 없습니다")
        if parent.deleted_at is not None:
            raise MessageError("지워진 메시지에는 답글을 달 수 없습니다")

    message = m.Message(
        channel_id=channel.id,
        author_id=author_id,
        body=clean,
        reply_to_id=parent.id if parent is not None else None,
    )
    session.add(message)
    session.flush()

    names = _member_names(session, channel.project_id)
    for name in find_mentions(clean, list(names)):
        session.add(m.MessageMention(message_id=message.id, user_id=names[name]))
    session.flush()
    return message


def load_message(session: Session, message_id: int) -> m.Message:
    message = session.get(m.Message, message_id)
    if message is None:
        raise MessageError("메시지를 찾을 수 없습니다")
    return message


def edit_message(
    session: Session, message: m.Message, *, editor_id: int, body: str
) -> m.Message:
    """CHAT-002 — **쓴 사람만** 고칠 수 있습니다.

    ⚠️ `edited_at` 을 반드시 찍습니다. 고친 사실을 감추면 나중에 말이
    달라진 것을 아무도 모릅니다 — 회의에서 정한 일을 다루는 도구에서
    그건 기록을 못 믿게 만드는 것입니다.
    """
    if message.author_id != editor_id:
        raise MessageError("자기가 쓴 메시지만 고칠 수 있습니다")
    if message.deleted_at is not None:
        raise MessageError("지워진 메시지는 고칠 수 없습니다")

    clean = _clean_body(body)
    if clean == message.body:
        return message

    message.body = clean
    message.edited_at = datetime.now(UTC)

    # 본문이 바뀌었으면 부른 사람도 바뀝니다. 옛 멘션을 그대로 두면
    # 본문에서 지워진 사람이 계속 "불린 사람" 으로 남습니다.
    session.query(m.MessageMention).filter(
        m.MessageMention.message_id == message.id
    ).delete(synchronize_session=False)
    channel = session.get(m.Channel, message.channel_id)
    if channel is not None:
        names = _member_names(session, channel.project_id)
        for name in find_mentions(clean, list(names)):
            session.add(m.MessageMention(message_id=message.id, user_id=names[name]))
    session.flush()
    return message


def delete_message(
    session: Session, message: m.Message, *, actor_id: int
) -> m.Message:
    """CHAT-003 — **행을 지우지 않습니다.**

    ⚠️ 답글이 달린 말을 행째로 지우면 남의 답글이 허공에 뜹니다. 자리는
    남기고 본문만 가립니다.
    """
    if message.author_id != actor_id:
        raise MessageError("자기가 쓴 메시지만 지울 수 있습니다")
    if message.deleted_at is None:
        message.deleted_at = datetime.now(UTC)
        # 지운 글의 멘션은 남기지 않습니다 — 지웠는데 "불렸다" 는 기록만
        # 남으면 무엇 때문에 불렸는지 볼 방법이 없습니다.
        session.query(m.MessageMention).filter(
            m.MessageMention.message_id == message.id
        ).delete(synchronize_session=False)
        session.flush()
    return message


def set_reaction(
    session: Session, message: m.Message, *, user_id: int, mark: str | None
) -> None:
    """CHAT-008 — 반응을 달거나 뗀다. `mark=None` 이면 뗍니다.

    ⚠️ **한 사람당 하나**입니다. 이미 단 것이 있으면 갈아 끼웁니다 —
    표의 기본키가 (메시지, 사람) 이라 그것이 곧 규칙입니다.

    ⚠️ 지워진 메시지에는 못 답니다. 지운 글에 반응이 붙으면 목록에
    "지워진 메시지 · 동의해요 3" 이라는 읽을 수 없는 줄이 남습니다.
    """
    if message.deleted_at is not None:
        raise MessageError("지워진 메시지에는 반응할 수 없습니다")

    existing = session.get(m.MessageReaction, (message.id, user_id))
    if mark is None:
        if existing is not None:
            session.delete(existing)
            session.flush()
        return

    try:
        chosen = ReactionMark(mark)
    except ValueError:
        # ⚠️ 자유 입력이 아닙니다. 왜 그런지는 `db/vocab.py` 머리말에.
        raise MessageError("그런 반응은 없습니다") from None

    if existing is None:
        session.add(
            m.MessageReaction(message_id=message.id, user_id=user_id, mark=str(chosen))
        )
    else:
        existing.mark = str(chosen)
    session.flush()


def history(
    session: Session,
    channel_id: int,
    *,
    before_id: int | None = None,
    limit: int = MAX_PAGE,
) -> list[m.Message]:
    """CHAT-009 — 거슬러 올라가며 읽는다. **오래된 것 → 새것 순**으로 돌려줍니다.

    ⚠️ `before_id` 는 **번호**이지 시각이 아닙니다. 시각으로 자르면 같은
    초에 들어온 두 메시지 중 하나가 영영 안 보이거나 두 번 보입니다.

    ⚠️ 지워진 메시지도 돌려줍니다. 자리를 빼면 답글이 가리키는 곳이
    사라져서 "누구에게 한 말인지" 를 못 읽습니다 — 본문은 API 가 가립니다.
    """
    capped = max(1, min(int(limit), MAX_PAGE))
    stmt = select(m.Message).where(m.Message.channel_id == channel_id)
    if before_id is not None:
        stmt = stmt.where(m.Message.id < before_id)
    rows = list(
        session.scalars(stmt.order_by(m.Message.id.desc()).limit(capped)).all()
    )
    rows.reverse()
    return rows


def search(
    session: Session, project_id: int, query: str, *, limit: int = MAX_PAGE
) -> list[m.Message]:
    """CHAT-010 — 이 프로젝트의 채널에서 찾는다. **새것부터.**

    ⚠️ 프로젝트 안에서만 찾습니다. 채널을 안 걸고 찾으면 남의 팀 대화가
    검색 결과에 뜹니다.

    ⚠️ 지워진 메시지는 **안 나옵니다.** 지운 글이 검색으로 되살아나면
    지운 것이 지운 것이 아닙니다.
    """
    needle = strip_mention_marks(query).strip()
    if len(needle) < 2:
        # 한 글자로 찾으면 사실상 전부가 나옵니다 — 결과가 아니라 목록입니다.
        return []

    capped = max(1, min(int(limit), MAX_PAGE))
    pattern = f"%{needle}%"
    stmt = (
        select(m.Message)
        .join(m.Channel, m.Channel.id == m.Message.channel_id)
        .where(
            m.Channel.project_id == project_id,
            m.Message.deleted_at.is_(None),
            or_(m.Message.body.ilike(pattern), m.Message.body.like(pattern)),
        )
        .order_by(m.Message.id.desc())
        .limit(capped)
    )
    return list(session.scalars(stmt).all())


def reactions_for(
    session: Session, message_ids: list[int]
) -> dict[int, list[dict[str, Any]]]:
    """메시지별 반응 묶음.

    ⚠️ **정렬을 개수 순으로 하지 않습니다.** 개수 순은 곧 순위표이고,
    이 저장소는 값을 같은 축에 세우는 것을 금지합니다(`AGENTS.md`).
    어휘에 적힌 순서 그대로 둡니다 — 그래야 메시지마다 같은 자리에
    같은 표시가 옵니다.
    """
    if not message_ids:
        return {}

    rows = session.execute(
        select(
            m.MessageReaction.message_id,
            m.MessageReaction.mark,
            func.count(m.MessageReaction.user_id),
        )
        .where(m.MessageReaction.message_id.in_(message_ids))
        .group_by(m.MessageReaction.message_id, m.MessageReaction.mark)
    ).all()

    order = {str(r): i for i, r in enumerate(ReactionMark)}
    grouped: dict[int, list[dict[str, Any]]] = {}
    for message_id, mark, count in rows:
        grouped.setdefault(int(message_id), []).append(
            {
                "mark": str(mark),
                "label": REACTION_LABEL[ReactionMark(mark)],
                "count": int(count),
            }
        )
    for bucket in grouped.values():
        bucket.sort(key=lambda r: order.get(str(r["mark"]), 99))
    return grouped


def mine_for(
    session: Session, message_ids: list[int], user_id: int
) -> dict[int, str]:
    """내가 단 반응. 화면이 "내가 눌렀는가" 를 그릴 근거입니다.

    ⚠️ 이게 없으면 화면은 자기가 누른 것을 표시할 방법이 없어서, 누른
    사람이 다시 눌러 **자기 반응을 떼는 길**을 못 찾습니다.
    """
    if not message_ids:
        return {}
    rows = session.execute(
        select(m.MessageReaction.message_id, m.MessageReaction.mark).where(
            m.MessageReaction.message_id.in_(message_ids),
            m.MessageReaction.user_id == user_id,
        )
    ).all()
    return {int(message_id): str(mark) for message_id, mark in rows}


def mentioned_names(session: Session, message_ids: list[int]) -> dict[int, list[str]]:
    """메시지별로 부른 사람 이름. **이름 순**입니다."""
    if not message_ids:
        return {}
    rows = session.execute(
        select(m.MessageMention.message_id, m.User.name)
        .join(m.User, m.User.id == m.MessageMention.user_id)
        .where(m.MessageMention.message_id.in_(message_ids))
    ).all()
    grouped: dict[int, list[str]] = {}
    for message_id, name in rows:
        grouped.setdefault(int(message_id), []).append(str(name))
    for bucket in grouped.values():
        bucket.sort()
    return grouped


def unread_mentions(session: Session, user_id: int, project_id: int) -> int:
    """나를 부른 메시지가 몇 건인가 (CHAT-005 알림의 근거).

    ⚠️ **"안 읽음" 을 아직 기록하지 않습니다.** 읽음 표시는 표가 하나 더
    필요하고(사람×채널의 마지막 읽은 번호), 그건 별개 작업입니다. 지금
    돌려주는 것은 **지워지지 않은, 나를 부른 메시지 전부**이고, 이름이
    사실과 어긋나지 않게 API 는 이것을 `mention_total` 로 내보냅니다.
    """
    return int(
        session.scalar(
            select(func.count(m.MessageMention.message_id))
            .join(m.Message, m.Message.id == m.MessageMention.message_id)
            .join(m.Channel, m.Channel.id == m.Message.channel_id)
            .where(
                m.MessageMention.user_id == user_id,
                m.Channel.project_id == project_id,
                m.Message.deleted_at.is_(None),
            )
        )
        or 0
    )
