"""통화 시그널링 — 무엇을 막는가.

이 파일이 고정하는 것: **시그널링이 조용한 권한 통로가 되지 않는가.**

이 채널은 세 가지를 새게 할 수 있습니다 — 회의 참석자 명단, 남의 이름으로
보내는 offer, 그리고 기록되지 않는 옆길 통로. 마지막이 특히 나쁩니다.
이 시스템은 회의 내용을 기록해 기여도로 쓰는데, 기록 안 되는 통로가
생기면 그 주장이 무너집니다.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from teamflow.call.signaling import (
    MAX_PAYLOAD_CHARS,
    MAX_PEERS,
    RELAYED_KINDS,
    Peer,
    RoomState,
    can_join,
    describe,
    join,
    leave,
    plan_relay,
    warnings_for,
)

NOW = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)


def peer(user_id: int, *, conn: str | None = None, headphones: bool = True) -> Peer:
    return Peer(
        user_id=user_id,
        name=f"팀원{user_id}",
        connection_id=conn or f"c{user_id}",
        joined_at=NOW,
        headphones=headphones,
    )


def room(*peers: Peer) -> RoomState:
    return RoomState(meeting_id=1, peers=tuple(peers))


# ══════════════════════════════════════════════════════════════
# 들어오기
# ══════════════════════════════════════════════════════════════


def test_an_empty_room_accepts():
    assert can_join(room(), 1).allowed


def test_the_mesh_limit_is_enforced():
    """docs/15 §3.1 — 메시는 인원이 늘면 각자의 업로드가 (n−1)배."""
    full = room(*[peer(i) for i in range(1, MAX_PEERS + 1)])
    decision = can_join(full, 99)
    assert not decision.allowed
    assert decision.code == "room_full"
    # 왜 막혔는지 사람이 알아야 합니다.
    assert str(MAX_PEERS) in decision.reason


def test_rejoining_is_allowed_because_refresh_must_not_lock_you_out():
    """⭐ 거절하면 **새로고침 한 번에 자기 회의에서 밀려납니다.**"""
    full = room(*[peer(i) for i in range(1, MAX_PEERS + 1)])
    decision = can_join(full, 1)
    assert decision.allowed
    assert decision.code == "rejoin"


def test_joining_twice_leaves_one_connection():
    """⭐ 탭을 둘 열면 **같은 사람의 목소리가 두 트랙에** 들어갑니다.

    그러면 발언량이 두 배로 잡힙니다.
    """
    state = join(room(), peer(1, conn="old"))
    state = join(state, peer(1, conn="new"))

    assert len(state.peers) == 1
    assert state.peers[0].connection_id == "new"


# ══════════════════════════════════════════════════════════════
# ⭐ 나가기 — 연결 id 로 빼야 한다
# ══════════════════════════════════════════════════════════════


def test_leaving_uses_the_connection_not_the_user():
    """⭐ user_id 로 빼면 **새로고침한 자기 자신을 쫓아냅니다.**

    새 연결이 붙은 뒤에 옛 소켓의 close 가 도착하는 순서가 흔합니다.
    """
    state = join(room(), peer(1, conn="old"))
    state = join(state, peer(1, conn="new"))

    state = leave(state, "old")

    assert len(state.peers) == 1, "새로고침으로 들어온 연결이 사라졌습니다"
    assert state.peers[0].connection_id == "new"


def test_leaving_an_unknown_connection_changes_nothing():
    state = join(room(), peer(1))
    assert leave(state, "그런거 없음").peers == state.peers


# ══════════════════════════════════════════════════════════════
# ⭐ 중계 — 막는 것이 본체
# ══════════════════════════════════════════════════════════════


def msg(**over) -> dict:
    base = {"kind": "offer", "to": 2, "payload": "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n"}
    base.update(over)
    return base


def test_a_normal_offer_is_relayed():
    state = room(peer(1), peer(2))
    plan = plan_relay(state, sender=peer(1), message=msg())
    assert plan.allowed
    assert plan.to_connection == "c2"


def test_the_sender_is_stamped_by_the_server_not_read_from_the_message():
    """⭐ **본문의 `from` 을 믿으면 남의 이름으로 연결을 가로챕니다.**

    요청 본문의 id 를 그대로 믿던 `member_ids`·`github_installation_id`
    결함과 같은 부류입니다.
    """
    state = room(peer(1), peer(2))
    plan = plan_relay(
        state, sender=peer(1), message=msg(**{"from": 999, "from_name": "관리자"})
    )
    assert plan.payload["from"] == 1
    assert plan.payload["from_name"] == "팀원1"


@pytest.mark.parametrize("kind", ["chat", "file", "eval", "", None, 1, "OFFER"])
def test_only_the_allowed_kinds_are_relayed(kind):
    """⭐ 아무 JSON 이나 나르면 **기록되지 않는 메신저**가 됩니다.

    이 시스템은 회의 내용을 기록해 기여도로 쓰는데, 기록 안 되는 옆길이
    생기면 그 주장이 무너집니다.
    """
    state = room(peer(1), peer(2))
    plan = plan_relay(state, sender=peer(1), message=msg(kind=kind))
    assert not plan.allowed
    assert plan.code == "unknown_kind"


def test_the_allowed_kinds_are_exactly_what_webrtc_needs():
    assert {"offer", "answer", "ice"} == RELAYED_KINDS


def test_you_cannot_target_someone_outside_the_room():
    """⭐ 방에 없는 사람을 지정하면 조용히 버립니다.

    "있다/없다" 를 다르게 답하면 아무 user_id 나 넣어 보며 **누가 회의에
    있는지 알아낼 수 있습니다.**
    """
    state = room(peer(1), peer(2))
    plan = plan_relay(state, sender=peer(1), message=msg(to=3))
    assert not plan.allowed
    assert plan.to_connection is None


def test_you_cannot_target_yourself():
    state = room(peer(1), peer(2))
    assert not plan_relay(state, sender=peer(1), message=msg(to=1)).allowed


@pytest.mark.parametrize("target", [None, "2", 2.0, [2], {"user_id": 2}])
def test_a_malformed_target_is_refused(target):
    state = room(peer(1), peer(2))
    assert not plan_relay(state, sender=peer(1), message=msg(to=target)).allowed


def test_an_oversized_payload_is_refused():
    """⭐ 상한이 없으면 이 통로로 **파일을 보낼 수 있습니다.**"""
    state = room(peer(1), peer(2))
    plan = plan_relay(
        state, sender=peer(1), message=msg(payload="x" * (MAX_PAYLOAD_CHARS + 1))
    )
    assert not plan.allowed
    assert plan.code == "payload_too_large"


def test_a_payload_at_the_limit_passes():
    state = room(peer(1), peer(2))
    assert plan_relay(
        state, sender=peer(1), message=msg(payload="x" * MAX_PAYLOAD_CHARS)
    ).allowed


@pytest.mark.parametrize("payload", [None, 123, {"sdp": "v=0"}, ["v=0"]])
def test_a_non_string_payload_is_refused(payload):
    state = room(peer(1), peer(2))
    assert not plan_relay(state, sender=peer(1), message=msg(payload=payload)).allowed


def test_an_empty_message_does_not_crash():
    state = room(peer(1), peer(2))
    assert not plan_relay(state, sender=peer(1), message={}).allowed


# ══════════════════════════════════════════════════════════════
# 화면이 읽을 것
# ══════════════════════════════════════════════════════════════


def test_the_view_never_exposes_connection_ids():
    """⭐ 연결 id 를 알면 **특정 소켓을 겨냥할 수 있습니다.**"""
    view = describe(room(peer(1, conn="secret-socket"), peer(2)))
    assert "secret-socket" not in str(view)


def test_the_view_is_sorted_so_the_screen_does_not_jump():
    view = describe(room(peer(3), peer(1), peer(2)))
    assert [p["user_id"] for p in view.peers] == [1, 2, 3]


# ══════════════════════════════════════════════════════════════
# ⭐ 헤드폰 — 막을 수 없으니 보이게 한다
# ══════════════════════════════════════════════════════════════


def test_no_warning_when_everyone_wears_headphones():
    assert warnings_for(room(peer(1), peer(2))) == []


def test_someone_without_headphones_is_named_now_not_later():
    """⭐ docs/15 §2.3 — 스피커로 들으면 남의 목소리가 내 트랙에 섞이고,
    **그 사람의 발언이 내 기여로 기록됩니다.**

    기여도 화면에서 처음 보면 늦습니다. 통화 중에 말해야 고칠 수 있습니다.
    """
    problems = warnings_for(room(peer(1), peer(2, headphones=False)))
    assert len(problems) == 1
    assert "팀원2" in problems[0]
    assert "기여" in problems[0]


def test_the_headphone_warning_does_not_block_joining():
    """헤드폰이 없다고 자기 팀 회의에서 빼는 것은 더 나쁩니다."""
    assert can_join(room(peer(1, headphones=False)), 2).allowed


def test_a_full_room_says_so_in_the_warnings():
    full = room(*[peer(i) for i in range(1, MAX_PEERS + 1)])
    assert any("상한" in w for w in warnings_for(full))
