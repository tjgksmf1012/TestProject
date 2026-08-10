"""통화 방 보관소 — 지금 누가 붙어 있는가.

판단은 `signaling.py` 에 있습니다. 여기는 소켓을 들고 있는 부분입니다.

## ⚠️ 이 보관소는 **프로세스 메모리**에 있습니다

즉 API 를 워커 여러 개로 띄우면 **같은 회의의 두 사람이 서로를 못
봅니다.** 각자 다른 워커에 붙으면 서로 다른 방에 들어가고, offer 를
보내도 상대가 그 워커에 없어서 조용히 버려집니다. **오류가 안 납니다.**

지금은 워커가 하나라 문제가 없고(`docker/Dockerfile.api` 의 CMD 에
`--workers` 가 없습니다), 그 사실을 테스트가 지킵니다
(`test_packaging.py`). 워커를 늘리려면 이 보관소를 Redis pub/sub 으로
옮겨야 합니다 — 그건 별개 작업이고, 늘리는 사람이 이 주석을 보게
하는 것이 여기서 할 수 있는 최선입니다.

⚠️ **이 환경에서는 실제 통화를 해 볼 수 없습니다.** 네트워크가 없어
WebRTC 연결이 성립하지 않습니다. 여기서 검증되는 것은 **주선 규칙**까지
이고, 목소리가 실제로 오가는지는 `docs/09` 실험 6 에서 확인합니다.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

from teamflow.call.signaling import (
    Decision,
    Peer,
    RoomState,
    can_join,
    describe,
    join,
    leave,
    plan_relay,
)

logger = logging.getLogger(__name__)

#: 소켓 하나에 보내는 함수. WebSocket 을 직접 들고 있지 않은 이유는
#: 테스트에서 가짜 소켓을 넣기 위해서입니다.
Send = Callable[[dict], Awaitable[None]]


class CallRooms:
    """회의별 통화 방.

    한 프로세스 안에서 여러 코루틴이 동시에 건드리므로 락을 씁니다.
    락 없이 dict 를 고치면 방 하나가 통째로 사라지는 경합이 납니다.
    """

    def __init__(self) -> None:
        self._states: dict[int, RoomState] = {}
        self._senders: dict[str, Send] = {}
        self._lock = asyncio.Lock()

    def state(self, meeting_id: int) -> RoomState:
        return self._states.get(meeting_id) or RoomState(meeting_id=meeting_id)

    async def try_join(self, peer: Peer, meeting_id: int, send: Send) -> Decision:
        """방에 넣는다. 못 들어가면 이유를 돌려준다.

        같은 사람의 옛 연결이 있으면 밀어냅니다 — 새로고침해도 회의에
        남아 있어야 하고, 탭 둘을 열면 같은 목소리가 두 트랙에 들어갑니다.
        """
        async with self._lock:
            state = self.state(meeting_id)
            decision = can_join(state, peer.user_id)
            if not decision.allowed:
                return decision

            stale = state.find(peer.user_id)
            self._states[meeting_id] = join(state, peer)
            self._senders[peer.connection_id] = send
            if stale is not None:
                self._senders.pop(stale.connection_id, None)
        return decision

    async def part(self, meeting_id: int, connection_id: str) -> None:
        async with self._lock:
            state = self.state(meeting_id)
            self._states[meeting_id] = leave(state, connection_id)
            self._senders.pop(connection_id, None)
            # 아무도 없으면 방을 지웁니다. 안 지우면 회의가 늘수록
            # 빈 방이 쌓입니다.
            if not self._states[meeting_id].peers:
                self._states.pop(meeting_id, None)

    async def relay(self, meeting_id: int, sender: Peer, message: dict) -> Decision:
        """한 사람에게 중계한다.

        ⚠️ 어디로 보낼지는 `plan_relay` 가 정합니다. 여기서 `to` 를 직접
        읽으면 그 검사들을 통째로 건너뜁니다.
        """
        state = self.state(meeting_id)
        plan = plan_relay(state, sender=sender, message=message)
        if not plan.allowed or plan.to_connection is None:
            return Decision(False, plan.code, plan.reason)

        send = self._senders.get(plan.to_connection)
        if send is None:
            # 계획을 세운 사이에 상대가 끊어졌습니다. 보낸 쪽에는 방에
            # 없다고만 답합니다 — 여기서도 존재 여부를 흘리지 않습니다.
            return Decision(False, "not_in_room", "받을 사람이 통화에 없습니다")

        await send(plan.payload or {})
        return Decision(True)

    async def announce(self, meeting_id: int) -> None:
        """방에 있는 **전원**에게 지금 명단을 보낸다.

        누가 들어오고 나갈 때마다 부릅니다. 이걸 안 하면 화면이 처음 붙을
        때의 명단으로 멈춰 있고, 나간 사람에게 계속 offer 를 보냅니다.
        """
        state = self.state(meeting_id)
        view = describe(state)
        body = {
            "kind": "roster",
            "meeting_id": view.meeting_id,
            "peers": view.peers,
            "warnings": view.warnings,
        }
        for peer in state.peers:
            send = self._senders.get(peer.connection_id)
            if send is None:
                continue
            try:
                await send(body)
            except Exception:
                # 한 사람에게 못 보낸다고 나머지에게도 안 보내면 안 됩니다.
                # 끊긴 소켓은 곧 part() 로 정리됩니다.
                logger.debug("명단 전송 실패 connection=%s", peer.connection_id)


#: 앱 하나가 쓰는 보관소. 프로세스 메모리라는 한계는 모듈 주석에.
rooms = CallRooms()
