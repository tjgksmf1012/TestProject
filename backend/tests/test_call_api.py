"""통화 시그널링 WebSocket.

이 파일이 고정하는 것: **소켓을 받기 전에 자격을 확인하는가.**

이 소켓이 붙자마자 받는 첫 메시지가 "지금 누가 회의에 있는가" 입니다.
받아 놓고 나중에 끊으면 그 사이에 **명단이 이미 샙니다.**

⚠️ 여기서 확인되는 것은 **주선 규칙까지**입니다. 실제 목소리가 오가는지는
이 환경에서 확인할 수 없습니다 — 네트워크가 없어 WebRTC 연결이 성립하지
않습니다. 그건 `docs/09` 실험 6 입니다.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from teamflow.call import rooms as call_rooms
from teamflow.call.signaling import MAX_PEERS
from teamflow.db import models as m
from teamflow.db import session as db_session

from .conftest import login_as
from .test_api import client, engine, seeded  # noqa: F401

NOW = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def empty_rooms():
    """방은 프로세스 메모리에 있어 테스트 사이에 남습니다."""
    call_rooms.rooms._states.clear()
    call_rooms.rooms._senders.clear()
    yield
    call_rooms.rooms._states.clear()
    call_rooms.rooms._senders.clear()


def url(meeting_id: int, **params) -> str:
    query = "".join(f"&{k}={v}" for k, v in params.items())
    return f"/api/meetings/{meeting_id}/call?x=1{query}"


def sdp(to: int, kind: str = "offer", payload: str = "v=0\r\n") -> dict:
    return {"kind": kind, "to": to, "payload": payload}


# ══════════════════════════════════════════════════════════════
# ⭐ 자격 — 받기 전에 확인한다
# ══════════════════════════════════════════════════════════════


def test_an_anonymous_socket_is_refused(client: TestClient, seeded):
    """⭐ 로그인 없이 붙으면 **명단을 그냥 받아 갑니다.**"""
    client.cookies.clear()
    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect(url(seeded["meeting_id"])) as ws,
    ):
        ws.receive_json()


def test_an_outsider_is_refused(client: TestClient, seeded):
    """⭐ 로그인만 확인하면 **가입만 하면 남의 팀 회의에 붙을 수 있습니다.**"""
    with db_session.session_scope() as s:
        outsider = m.User(name="남", email="out@example.com")
        s.add(outsider)
        s.flush()
        outsider_id = outsider.id

    login_as(client, outsider_id)
    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect(url(seeded["meeting_id"])) as ws,
    ):
        ws.receive_json()


def test_an_unknown_meeting_is_refused(client: TestClient, seeded):
    with pytest.raises(WebSocketDisconnect), client.websocket_connect(url(99999)) as ws:
        ws.receive_json()


def test_nothing_is_sent_before_the_check_passes(client: TestClient, seeded):
    """⭐ 거절당한 소켓은 **아무것도 못 받아야** 합니다."""
    client.cookies.clear()
    got = []
    try:
        with client.websocket_connect(url(seeded["meeting_id"])) as ws:
            got.append(ws.receive_json())
    except WebSocketDisconnect:
        pass
    assert got == [], f"거절 전에 이미 무언가를 보냈습니다: {got}"


# ══════════════════════════════════════════════════════════════
# 붙기
# ══════════════════════════════════════════════════════════════


def test_a_member_joins_and_gets_the_roster(client: TestClient, seeded):
    with client.websocket_connect(url(seeded["meeting_id"])) as ws:
        roster = ws.receive_json()

    assert roster["kind"] == "roster"
    assert [p["user_id"] for p in roster["peers"]] == [seeded["user_ids"][0]]


def test_the_roster_never_carries_connection_ids(client: TestClient, seeded):
    with client.websocket_connect(url(seeded["meeting_id"])) as ws:
        roster = ws.receive_json()
    assert "connection_id" not in str(roster)


def test_a_second_person_makes_everyone_see_the_new_roster(client: TestClient, seeded):
    """⭐ 명단을 다시 안 보내면 화면이 처음 붙을 때로 멈추고,
    **나간 사람에게 계속 offer 를 보냅니다.**"""
    first, second = seeded["user_ids"][0], seeded["user_ids"][1]

    with client.websocket_connect(url(seeded["meeting_id"])) as ws1:
        ws1.receive_json()

        login_as(client, second)
        with client.websocket_connect(url(seeded["meeting_id"])) as ws2:
            ws2.receive_json()
            updated = ws1.receive_json()

    assert {p["user_id"] for p in updated["peers"]} == {first, second}


def test_leaving_updates_the_roster_for_the_rest(client: TestClient, seeded):
    first, second = seeded["user_ids"][0], seeded["user_ids"][1]

    with client.websocket_connect(url(seeded["meeting_id"])) as ws1:
        ws1.receive_json()
        login_as(client, second)
        with client.websocket_connect(url(seeded["meeting_id"])) as ws2:
            ws2.receive_json()
            ws1.receive_json()
        after = ws1.receive_json()

    assert {p["user_id"] for p in after["peers"]} == {first}


# ══════════════════════════════════════════════════════════════
# 중계
# ══════════════════════════════════════════════════════════════


def test_an_offer_reaches_the_other_person(client: TestClient, seeded):
    first, second = seeded["user_ids"][0], seeded["user_ids"][1]

    with client.websocket_connect(url(seeded["meeting_id"])) as ws1:
        ws1.receive_json()
        login_as(client, second)
        with client.websocket_connect(url(seeded["meeting_id"])) as ws2:
            ws2.receive_json()
            ws1.receive_json()

            ws1.send_json(sdp(to=second))
            got = ws2.receive_json()

    assert got["kind"] == "offer"
    assert got["from"] == first


def test_the_sender_cannot_forge_who_it_is_from(client: TestClient, seeded):
    """⭐ 본문의 `from` 을 믿으면 **남의 이름으로 연결을 가로챕니다.**"""
    first, second = seeded["user_ids"][0], seeded["user_ids"][1]

    with client.websocket_connect(url(seeded["meeting_id"])) as ws1:
        ws1.receive_json()
        login_as(client, second)
        with client.websocket_connect(url(seeded["meeting_id"])) as ws2:
            ws2.receive_json()
            ws1.receive_json()

            forged = sdp(to=second)
            forged["from"] = 9999
            ws1.send_json(forged)
            got = ws2.receive_json()

    assert got["from"] == first


def test_a_refused_message_gets_told_so(client: TestClient, seeded):
    """⭐ 조용히 버리면 화면은 **상대가 안 받은 줄 모르고 기다립니다.**"""
    with client.websocket_connect(url(seeded["meeting_id"])) as ws:
        ws.receive_json()
        ws.send_json({"kind": "chat", "to": 2, "payload": "안녕"})
        answer = ws.receive_json()

    assert answer["kind"] == "refused"
    assert answer["code"] == "unknown_kind"


def test_targeting_someone_not_in_the_call_is_refused(client: TestClient, seeded):
    with client.websocket_connect(url(seeded["meeting_id"])) as ws:
        ws.receive_json()
        ws.send_json(sdp(to=seeded["user_ids"][2]))
        answer = ws.receive_json()

    assert answer["code"] == "not_in_room"


def test_a_garbage_message_does_not_kill_the_socket(client: TestClient, seeded):
    """소켓이 죽으면 통화가 끊깁니다. 나쁜 메시지 하나로 그러면 안 됩니다."""
    with client.websocket_connect(url(seeded["meeting_id"])) as ws:
        ws.receive_json()
        ws.send_json({})
        ws.receive_json()
        ws.send_json({"kind": "offer"})
        assert ws.receive_json()["kind"] == "refused"


# ══════════════════════════════════════════════════════════════
# 헤드폰 — 막지 않고 보이게 한다
# ══════════════════════════════════════════════════════════════


def test_declaring_no_headphones_warns_the_room(client: TestClient, seeded):
    """⭐ docs/15 §2.3 — 스피커로 들으면 **남의 발언이 내 기여가 됩니다.**"""
    with client.websocket_connect(url(seeded["meeting_id"], headphones="no")) as ws:
        roster = ws.receive_json()

    assert roster["peers"][0]["headphones"] is False
    assert any("기여" in w for w in roster["warnings"])


def test_headphones_are_assumed_when_not_declared(client: TestClient, seeded):
    with client.websocket_connect(url(seeded["meeting_id"])) as ws:
        roster = ws.receive_json()
    assert roster["peers"][0]["headphones"] is True
    assert roster["warnings"] == []


def test_no_headphones_does_not_block_joining(client: TestClient, seeded):
    """헤드폰이 없다고 자기 팀 회의에서 빼는 것은 더 나쁩니다."""
    with client.websocket_connect(url(seeded["meeting_id"], headphones="no")) as ws:
        assert ws.receive_json()["kind"] == "roster"


# ══════════════════════════════════════════════════════════════
# 정리
# ══════════════════════════════════════════════════════════════


def test_the_room_is_dropped_when_everyone_leaves(client: TestClient, seeded):
    """빈 방을 안 지우면 회의가 늘수록 쌓입니다."""
    with client.websocket_connect(url(seeded["meeting_id"])) as ws:
        ws.receive_json()

    assert call_rooms.rooms.state(seeded["meeting_id"]).peers == ()
    assert call_rooms.rooms._states == {}
    assert call_rooms.rooms._senders == {}


def test_the_mesh_limit_is_reported_to_the_one_who_is_turned_away(
    client: TestClient, seeded
):
    """⭐ 왜 못 들어가는지 모르면 계속 새로고침합니다."""
    from teamflow.call.signaling import Peer

    async def nowhere(_body):
        return None

    import asyncio

    for i in range(MAX_PEERS):
        asyncio.get_event_loop().run_until_complete(
            call_rooms.rooms.try_join(
                Peer(
                    user_id=1000 + i,
                    name=f"x{i}",
                    connection_id=f"c{i}",
                    joined_at=NOW,
                ),
                seeded["meeting_id"],
                nowhere,
            )
        )

    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect(url(seeded["meeting_id"])) as ws,
    ):
        answer = ws.receive_json()
        assert answer["kind"] == "rejected"
        assert answer["code"] == "room_full"
        ws.receive_json()
