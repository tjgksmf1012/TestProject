"""채널 — 만들기·이름 바꾸기·지우기·순서 (CHANNEL-001~005).

여기가 **데이터베이스를 아는 쪽**입니다. 순수 판단은 `teamflow/chat/` 에
있습니다.

⚠️ **채널을 지울 때 행을 지우지 않습니다.** 채널에는 사람이 쓴 메시지가
딸려 있습니다. 채널을 지웠다고 남의 말이 같이 사라지면 안 됩니다 —
`archived_at` 을 찍고 목록에서만 뺍니다 (CHANNEL-004).
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from teamflow.db import models as m
from teamflow.db.vocab import CHANNEL_CARRIES_MESSAGES, ChannelKind

#: 채널 이름에 못 쓰는 것. `#` 은 화면이 붙이므로 이름에 또 있으면 `##일반`.
_BANNED = ("#", "\n", "\t")

MAX_NAME = 100


class ChannelError(Exception):
    """부를 수 없는 요청. API 가 400/404 로 옮깁니다."""


def normalize_name(raw: str) -> str:
    """이름을 다듬는다.

    ⚠️ 앞뒤 공백만 떼고 **가운데는 건드리지 않습니다.** `프론트 엔드` 를
    `프론트엔드` 로 바꾸면 사람이 적은 것과 화면에 뜨는 것이 달라집니다.
    """
    name = raw.strip()
    if not name:
        raise ChannelError("채널 이름이 비어 있습니다")
    if len(name) > MAX_NAME:
        raise ChannelError(f"채널 이름은 {MAX_NAME}자까지입니다")
    for bad in _BANNED:
        if bad in name:
            raise ChannelError("채널 이름에 `#` 이나 줄바꿈을 넣을 수 없습니다")
    return name


def list_channels(
    session: Session, project_id: int, *, include_archived: bool = False
) -> list[m.Channel]:
    """이 프로젝트의 채널. **자리 순, 같으면 만든 순.**

    ⚠️ 이름 순이 아닙니다 — 사람이 정한 순서가 있고(CHANNEL-005), 그걸
    무시하면 순서를 바꾼 사람은 아무 일도 안 일어난 줄 압니다.
    """
    stmt = select(m.Channel).where(m.Channel.project_id == project_id)
    if not include_archived:
        stmt = stmt.where(m.Channel.archived_at.is_(None))
    return list(
        session.scalars(stmt.order_by(m.Channel.position, m.Channel.id)).all()
    )


def create_channel(
    session: Session,
    project_id: int,
    *,
    kind: ChannelKind,
    name: str,
    created_by: int,
) -> m.Channel:
    clean = normalize_name(name)

    # ⚠️ 같은 이름이 이미 있으면 **되살립니다.** 지운 채널과 같은 이름으로
    #    새로 만들면 유일 제약에 걸리는데, 사용자에게는 "이미 있다" 가
    #    아니라 "왜 안 되지" 로 보입니다. 지워진 것이면 되살려 줍니다.
    existing = session.scalars(
        select(m.Channel).where(
            m.Channel.project_id == project_id,
            m.Channel.kind == str(kind),
            m.Channel.name == clean,
        )
    ).one_or_none()
    if existing is not None:
        if existing.archived_at is None:
            raise ChannelError(f"`{clean}` 채널이 이미 있습니다")
        existing.archived_at = None
        session.flush()
        return existing

    last = session.scalar(
        select(func.max(m.Channel.position)).where(m.Channel.project_id == project_id)
    )
    channel = m.Channel(
        project_id=project_id,
        kind=str(kind),
        name=clean,
        position=int(last or 0) + 1,
        created_by=created_by,
    )
    session.add(channel)
    session.flush()
    return channel


def rename_channel(session: Session, channel: m.Channel, name: str) -> m.Channel:
    """CHANNEL-003."""
    clean = normalize_name(name)
    if clean == channel.name:
        return channel

    taken = session.scalar(
        select(m.Channel.id).where(
            m.Channel.project_id == channel.project_id,
            m.Channel.kind == channel.kind,
            m.Channel.name == clean,
            m.Channel.id != channel.id,
        )
    )
    if taken is not None:
        raise ChannelError(f"`{clean}` 채널이 이미 있습니다")

    channel.name = clean
    session.flush()
    return channel


def archive_channel(session: Session, channel: m.Channel) -> m.Channel:
    """CHANNEL-004 — **행을 지우지 않습니다.**

    ⚠️ 메시지가 딸려 있습니다. 채널을 지웠다고 남이 쓴 말이 사라지면 안
    됩니다. 목록에서 빼고 기록은 남깁니다.
    """
    if channel.archived_at is None:
        channel.archived_at = datetime.now(UTC)
        session.flush()
    return channel


def reorder_channels(
    session: Session, project_id: int, ordered_ids: list[int]
) -> list[m.Channel]:
    """CHANNEL-005 — 목록 순서를 통째로 다시 정한다.

    ⚠️ **하나씩 위/아래로가 아니라 전체 순서를 받습니다.** 한 칸씩 바꾸면
    두 사람이 동시에 옮겼을 때 순서가 뒤엉키고, 어떻게 엉켰는지 되짚을
    방법이 없습니다.

    ⚠️ 받은 목록이 지금 채널 전부와 정확히 같은 집합이어야 합니다. 하나가
    빠진 목록을 받아들이면 그 채널은 **자리를 잃고 목록에서 사라집니다** —
    지우지도 않았는데.
    """
    channels = list_channels(session, project_id)
    have = {c.id for c in channels}
    want = list(dict.fromkeys(ordered_ids))

    if len(want) != len(ordered_ids):
        raise ChannelError("순서 목록에 같은 채널이 두 번 있습니다")
    if set(want) != have:
        missing = sorted(have - set(want))
        extra = sorted(set(want) - have)
        raise ChannelError(
            "순서 목록이 지금 채널과 다릅니다 — "
            f"빠진 것 {missing}, 없는 것 {extra}"
        )

    by_id = {c.id: c for c in channels}
    for index, channel_id in enumerate(want, start=1):
        by_id[channel_id].position = index
    session.flush()
    return list_channels(session, project_id)


def load_for_message(session: Session, channel_id: int) -> m.Channel:
    """메시지를 쓸 채널을 가져온다. **못 쓰는 곳이면 터집니다.**"""
    channel = session.get(m.Channel, channel_id)
    if channel is None:
        raise ChannelError("채널을 찾을 수 없습니다")
    if channel.archived_at is not None:
        raise ChannelError("지워진 채널에는 쓸 수 없습니다")
    if ChannelKind(channel.kind) not in CHANNEL_CARRIES_MESSAGES:
        # ⚠️ 음성 채널에 메시지를 쓰게 두면 "회의 중 채팅" 이 생기는데
        #    그건 정의서에 없는 기능입니다. 없는 것을 조용히 만들지 않습니다.
        raise ChannelError("이 채널에는 메시지를 쓸 수 없습니다")
    return channel
