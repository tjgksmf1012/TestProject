"""통화 시그널링 — 무엇을 중계하고 무엇을 막는가.

`docs/15` §3 의 WebRTC 메시를 위한 주선 통로입니다. **목소리는 여기를
지나가지 않습니다** — SDP 와 ICE 후보만 오갑니다.

    A ──(offer)──→ 서버 ──(offer)──→ B
    A ←─(answer)── 서버 ←─(answer)── B
    그 다음부터 목소리는 A ↔ B 직접

## ⚠️ 시그널링은 조용한 권한 통로다

이 채널은 세 가지를 새게 할 수 있습니다.

1. **명단** — 누가 회의에 있는지. 팀 밖 사람이 붙으면 그것만으로 샙니다
2. **주입** — 남의 이름으로 offer 를 보내 연결을 가로챌 수 있습니다
3. **기록 없는 통로** — 아무 JSON 이나 중계하면 팀원끼리 흔적 없는
   메신저가 됩니다. 이 시스템은 회의 내용을 기록해 기여도로 쓰는데,
   기록되지 않는 옆길이 생기면 그 주장이 무너집니다

그래서 이 모듈은 **막는 규칙**이 본체입니다. 중계 자체는 몇 줄입니다.

## 여기 없는 것

연결·소켓·상태 저장이 없습니다. 사실을 받아 판단만 돌려줍니다 —
그래야 네트워크 없이 테스트할 수 있고, 이 환경에는 네트워크가 없습니다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

# ══════════════════════════════════════════════════════════════
# 한계
# ══════════════════════════════════════════════════════════════

#: 메시 인원 상한 (docs/15 §3.1).
#:
#: 각자가 나머지 전원과 직접 연결하므로 업로드가 (n−1)배가 됩니다.
#: 5명이면 각자 4개 연결 — 가정용 업로드로 현실적인 마지막 지점입니다.
#: 넘으면 SFU(자체 호스팅)를 봐야 하고 그건 별개 작업입니다.
MAX_PEERS = 5

#: 한 사람이 열 수 있는 연결 수.
#:
#: 탭을 두 개 열면 마이크가 둘이 되고 **같은 사람의 목소리가 두 트랙에**
#: 들어갑니다. 그러면 발언량이 두 배로 잡힙니다. 하나만 허용하고 새
#: 연결이 오면 옛 것을 끊습니다 — 거절하면 새로고침 후에 못 들어옵니다.
MAX_CONNECTIONS_PER_USER = 1

#: 중계하는 메시지 종류. **여기 없는 것은 버립니다.**
#:
#: 허용 목록인 이유: 거부 목록은 새 종류가 생길 때마다 뚫립니다. 통화에
#: 필요한 것은 이 셋뿐이고, 늘어날 이유가 생기면 그때 근거와 함께 넣습니다.
RELAYED_KINDS = frozenset({"offer", "answer", "ice"})

#: 중계 본문 크기 상한(문자).
#:
#: SDP 는 보통 2~4KB, ICE 후보는 수백 바이트입니다. 상한이 없으면 이
#: 통로로 파일을 보낼 수 있고, 그건 기록되지 않는 전송 채널입니다.
MAX_PAYLOAD_CHARS = 16_000


# ══════════════════════════════════════════════════════════════
# 방과 사람
# ══════════════════════════════════════════════════════════════


@dataclass(frozen=True, slots=True)
class Peer:
    """통화에 붙어 있는 사람 하나."""

    user_id: int
    name: str
    #: 소켓 하나를 가리키는 값. 같은 사람이 새로고침하면 바뀝니다.
    connection_id: str
    joined_at: datetime
    # ⚠️ 헤드폰은 **자기 신고**입니다. 브라우저가 확인할 방법이 없습니다.
    #
    # 그래도 받는 이유: 스피커로 들으면 남의 목소리가 내 트랙에 섞여
    # **그 사람의 발언이 내 기여로 기록됩니다**(docs/15 §2.3). 막을 수는
    # 없지만 **팀이 지금 알 수 있게** 하고, 나중에 그 트랙의 신뢰도를
    # 낮추는 근거로 남깁니다.
    headphones: bool = True


@dataclass(frozen=True, slots=True)
class RoomState:
    """한 회의의 통화 상태."""

    meeting_id: int
    peers: tuple[Peer, ...] = ()

    def find(self, user_id: int) -> Peer | None:
        return next((p for p in self.peers if p.user_id == user_id), None)

    def by_connection(self, connection_id: str) -> Peer | None:
        return next((p for p in self.peers if p.connection_id == connection_id), None)

    @property
    def without_headphones(self) -> tuple[Peer, ...]:
        return tuple(p for p in self.peers if not p.headphones)


@dataclass(frozen=True, slots=True)
class Decision:
    """해도 되는가. 안 되면 왜 안 되는지."""

    allowed: bool
    #: 기계가 보는 값.
    code: str = "ok"
    #: 사람이 읽는 말. 화면에 그대로 나갑니다.
    reason: str = ""


OK = Decision(allowed=True)


def can_join(state: RoomState, user_id: int) -> Decision:
    """이 사람이 통화에 들어올 수 있는가.

    ⚠️ **구성원 확인은 여기서 하지 않습니다.** 그건 DB 를 봐야 하고,
    호출자(WS 엔드포인트)가 소켓을 받기 **전에** 끝내야 합니다. 팀 밖
    사람을 붙였다가 나중에 끊으면 그 사이에 명단이 이미 샙니다.
    """
    if state.find(user_id) is not None:
        # 같은 사람이 다시 들어오는 것은 새로고침입니다. 거절하면 새로고침
        # 한 번에 회의에서 밀려납니다 — 옛 연결을 끊고 받아 줍니다.
        return Decision(True, "rejoin", "이전 연결을 끊고 새로 붙습니다")

    if len(state.peers) >= MAX_PEERS:
        return Decision(
            False,
            "room_full",
            f"통화는 {MAX_PEERS}명까지입니다. "
            "메시 방식이라 인원이 늘면 각자의 업로드가 그만큼 늘어납니다.",
        )
    return OK


def join(state: RoomState, peer: Peer) -> RoomState:
    """사람을 넣는다. 같은 사람의 옛 연결은 밀어낸다."""
    others = tuple(p for p in state.peers if p.user_id != peer.user_id)
    return RoomState(meeting_id=state.meeting_id, peers=(*others, peer))


def leave(state: RoomState, connection_id: str) -> RoomState:
    """⚠️ **연결 id 로** 뺍니다.

    user_id 로 빼면, 새로고침해서 새 연결이 붙은 뒤에 옛 소켓이 닫힐 때
    **방금 들어온 자기 자신을 쫓아냅니다.**
    """
    return RoomState(
        meeting_id=state.meeting_id,
        peers=tuple(p for p in state.peers if p.connection_id != connection_id),
    )


# ══════════════════════════════════════════════════════════════
# 중계
# ══════════════════════════════════════════════════════════════


@dataclass(frozen=True, slots=True)
class Relay:
    """중계할 것. `allowed` 가 거짓이면 아무 데도 보내지 않습니다."""

    allowed: bool
    code: str = "ok"
    reason: str = ""
    #: 받을 사람의 연결 id. 없으면 보내지 않습니다.
    to_connection: str | None = None
    payload: dict | None = None


def plan_relay(state: RoomState, *, sender: Peer, message: dict) -> Relay:
    """보낸 사람이 이 메시지를 저 사람에게 보내도 되는가.

    ⚠️ **`from` 은 메시지에서 읽지 않습니다.** 인증된 소켓의 주인을
    서버가 찍습니다. 본문에서 읽으면 남의 이름으로 offer 를 보내 연결을
    가로챌 수 있습니다 — 요청 본문의 id 를 그대로 믿던 `member_ids` ·
    `github_installation_id` 결함과 같은 부류입니다.
    """
    kind = message.get("kind")
    if kind not in RELAYED_KINDS:
        # 허용 목록에 없으면 버립니다. 이 통로로 아무 JSON 이나 나르면
        # 기록되지 않는 메신저가 됩니다.
        return Relay(False, "unknown_kind", f"중계하지 않는 종류입니다: {kind!r}")

    target_id = message.get("to")
    if not isinstance(target_id, int):
        return Relay(False, "no_target", "받을 사람(`to`)이 없습니다")

    if target_id == sender.user_id:
        # 자기 자신에게 보내는 것은 의미가 없고, 반사 루프를 만듭니다.
        return Relay(False, "self_target", "자기 자신에게는 보낼 수 없습니다")

    target = state.find(target_id)
    if target is None:
        # ⚠️ 방에 없는 사람을 지정하면 **조용히 버립니다.** 방에 있는지
        # 없는지 알려 주면, 아무 user_id 나 넣어 보며 누가 회의에 있는지
        # 알아낼 수 있습니다.
        return Relay(False, "not_in_room", "받을 사람이 통화에 없습니다")

    body = message.get("payload")
    if not isinstance(body, str):
        return Relay(False, "bad_payload", "본문이 문자열이 아닙니다")
    if len(body) > MAX_PAYLOAD_CHARS:
        return Relay(
            False,
            "payload_too_large",
            f"본문이 {MAX_PAYLOAD_CHARS}자를 넘습니다",
        )

    return Relay(
        True,
        to_connection=target.connection_id,
        payload={
            "kind": kind,
            # 서버가 찍습니다. 보낸 쪽이 뭐라고 적었든 무시합니다.
            "from": sender.user_id,
            "from_name": sender.name,
            "payload": body,
        },
    )


# ══════════════════════════════════════════════════════════════
# 화면이 읽을 것
# ══════════════════════════════════════════════════════════════


@dataclass(frozen=True, slots=True)
class RoomView:
    """통화 화면이 그리는 데 필요한 것."""

    meeting_id: int
    peers: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def describe(state: RoomState) -> RoomView:
    """방을 화면이 쓸 모양으로.

    ⚠️ `connection_id` 는 **내보내지 않습니다.** 그건 소켓을 가리키는
    값이라 알면 특정 소켓을 겨냥할 수 있습니다. 화면이 쓰는 것은
    `user_id` 뿐입니다.
    """
    return RoomView(
        meeting_id=state.meeting_id,
        peers=[
            {
                "user_id": p.user_id,
                "name": p.name,
                "headphones": p.headphones,
                "joined_at": p.joined_at.isoformat(),
            }
            for p in sorted(state.peers, key=lambda p: p.user_id)
        ],
        warnings=warnings_for(state),
    )


def warnings_for(state: RoomState) -> list[str]:
    """지금 이 통화에서 팀이 알아야 하는 것.

    ⚠️ **헤드폰 경고가 여기 있는 이유** — 막을 수 없기 때문입니다.
    브라우저는 헤드폰 여부를 확인할 방법이 없고, 헤드폰이 없다고 회의에서
    빼는 것은 더 나쁩니다. 그래서 **지금 보이게** 합니다. 나중에 기여도
    화면에서 "이 사람 트랙에 남의 목소리가 섞였을 수 있습니다" 를 처음
    보면 늦습니다.
    """
    problems: list[str] = []

    bare = state.without_headphones
    if bare:
        names = ", ".join(p.name for p in sorted(bare, key=lambda p: p.user_id))
        problems.append(
            f"헤드폰을 쓰지 않는 사람이 있습니다: {names}. "
            "스피커로 들으면 남의 목소리가 그 사람 트랙에 섞이고, "
            "그러면 **다른 사람의 발언이 그 사람의 기여로 기록될 수 있습니다.**"
        )

    if len(state.peers) >= MAX_PEERS:
        problems.append(
            f"통화 인원이 상한({MAX_PEERS}명)에 찼습니다. "
            "더 들어오려면 메시 대신 미디어 서버가 필요합니다."
        )
    return problems


def connection_count(state: RoomState) -> int:
    return len(state.peers)
