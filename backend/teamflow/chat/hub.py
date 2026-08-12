"""채널에 붙어 있는 소켓들 — 새 메시지를 실시간으로 흘려보내는 곳.

## ⚠️ 여기는 **판정하지 않습니다**

누가 쓸 수 있는지·무엇이 유효한지는 전부 `services/message_service.py` 와
`services/channel_service.py` 가 정합니다. 여기는 **이미 저장된 것**을
지금 보고 있는 사람들에게 밀어 주기만 합니다.

이 순서가 중요합니다. 소켓으로 받은 것을 그대로 남에게 뿌리면, 저장은
안 됐는데 화면에만 뜬 메시지가 생깁니다 — 새로고침하면 사라지고, 쓴
사람은 자기 말이 갔다고 믿습니다. 그래서 **글은 HTTP 로 쓰고, 소켓은
읽기 전용**입니다.

## ⚠️ 이 보관소는 프로세스 메모리에 있습니다

`call/rooms.py` 와 같은 한계입니다 — 워커를 여럿 띄우면 같은 채널의 두
사람이 서로의 메시지를 실시간으로 못 봅니다. **오류는 안 납니다.**
지금은 워커가 하나이고(`test_packaging.py` 가 그 사실을 지킵니다),
늘리려면 여기를 Redis pub/sub 으로 옮겨야 합니다.

새로고침하면 HTTP 로 다시 읽어 오므로 **메시지가 사라지지는 않습니다.**
잃는 것은 "지금 즉시" 뿐입니다.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any

logger = logging.getLogger(__name__)

#: 소켓 하나에 보내는 함수. WebSocket 을 직접 들고 있지 않은 이유는
#: 테스트에서 가짜 소켓을 넣기 위해서입니다.
Send = Callable[[dict[str, Any]], Awaitable[None]]


class ChatHub:
    """채널별 구독자.

    한 프로세스 안에서 여러 코루틴이 동시에 건드리므로 락을 씁니다.
    """

    def __init__(self) -> None:
        self._subs: dict[int, dict[str, Send]] = {}
        self._lock = asyncio.Lock()

    async def join(self, channel_id: int, connection_id: str, send: Send) -> None:
        """구독한다.

        ⚠️ 키가 **연결**이지 사람이 아닙니다. 사람으로 키를 잡으면 탭 두
        개를 연 사람이 한쪽에서만 메시지를 받고, 새로고침이 자기 자신을
        내쫓습니다 — `call/rooms.py` 의 `part()` 가 같은 이유로 연결
        번호를 씁니다.
        """
        async with self._lock:
            self._subs.setdefault(channel_id, {})[connection_id] = send

    async def part(self, channel_id: int, connection_id: str) -> None:
        async with self._lock:
            room = self._subs.get(channel_id)
            if room is None:
                return
            room.pop(connection_id, None)
            # 아무도 없으면 지웁니다. 안 지우면 채널이 늘수록 빈 방이 쌓입니다.
            if not room:
                self._subs.pop(channel_id, None)

    def watcher_count(self, channel_id: int) -> int:
        return len(self._subs.get(channel_id, {}))

    async def publish(self, channel_id: int, body: dict[str, Any]) -> None:
        """이 채널을 보고 있는 **전원**에게 보낸다.

        ⚠️ 보낸 사람에게도 보냅니다. 빼면 화면 둘을 띄운 사람의 한쪽만
        갱신되고, 무엇보다 "내가 쓴 것이 서버에 닿았다" 는 확인이
        사라집니다 — 화면이 자기가 그린 것을 서버가 받은 증거로 삼게 됩니다.
        """
        async with self._lock:
            targets = list(self._subs.get(channel_id, {}).items())

        for connection_id, send in targets:
            try:
                await send(body)
            except Exception:
                # ⚠️ 한 사람에게 못 보냈다고 나머지에게도 안 보내면 안 됩니다.
                #    끊긴 소켓은 곧 part() 로 정리됩니다.
                logger.debug("채팅 전송 실패 connection=%s", connection_id)


#: 앱 하나가 쓰는 보관소. 프로세스 메모리라는 한계는 모듈 주석에.
hub = ChatHub()
