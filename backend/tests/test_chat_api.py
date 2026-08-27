"""채널과 채팅 API (요구사항 정의서 §6 · §7).

`test_api.py` 의 픽스처(`engine`·`client`·`seeded`)를 그대로 씁니다 —
프로젝트 하나 + 팀원 셋이 이미 있고 첫 사람으로 로그인돼 있습니다.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.db import vocab

from .conftest import login_as, logout
from .test_api import client, engine, seeded  # noqa: F401  (픽스처)


@pytest.fixture
def channel(client: TestClient, seeded) -> int:
    response = client.post(
        f"/api/projects/{seeded['project_id']}/channels",
        json={"kind": "text", "name": "일반"},
    )
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


# ══════════════════════════════════════════════════════════════
# 채널 (CHANNEL-001~005)
# ══════════════════════════════════════════════════════════════


def test_creating_a_channel_puts_it_in_the_list(client: TestClient, seeded, channel):
    listed = client.get(f"/api/projects/{seeded['project_id']}/channels").json()
    assert [c["name"] for c in listed] == ["일반"]
    assert listed[0]["kind"] == "text"


def test_a_voice_channel_is_a_room_not_a_meeting(client: TestClient, seeded):
    """CHANNEL-002 — 음성 채널은 *방 이름*이고 회의는 그 안의 사건입니다."""
    response = client.post(
        f"/api/projects/{seeded['project_id']}/channels",
        json={"kind": "voice", "name": "주간회의"},
    )
    assert response.status_code == 201
    assert response.json()["kind"] == "voice"


def test_an_unknown_kind_is_refused(client: TestClient, seeded):
    response = client.post(
        f"/api/projects/{seeded['project_id']}/channels",
        json={"kind": "video", "name": "화상"},
    )
    assert response.status_code == 400


def test_hash_in_the_name_is_refused(client: TestClient, seeded):
    """화면이 `#` 을 붙이므로 이름에 또 있으면 `##일반` 이 됩니다."""
    response = client.post(
        f"/api/projects/{seeded['project_id']}/channels",
        json={"kind": "text", "name": "#일반"},
    )
    assert response.status_code == 400


def test_renaming_keeps_the_messages(client: TestClient, seeded, channel):
    client.post(f"/api/channels/{channel}/messages", json={"body": "안녕하세요"})
    response = client.patch(f"/api/channels/{channel}", json={"name": "공지"})
    assert response.status_code == 200
    assert response.json()["name"] == "공지"

    kept = client.get(f"/api/channels/{channel}/messages").json()
    assert [msg["body"] for msg in kept] == ["안녕하세요"]


def test_deleting_a_channel_does_not_delete_the_messages(
    client: TestClient, seeded, channel, engine
):
    """⭐ CHANNEL-004 — 채널을 지웠다고 남이 쓴 말이 사라지면 안 됩니다."""
    client.post(f"/api/channels/{channel}/messages", json={"body": "기록으로 남을 말"})
    assert client.delete(f"/api/channels/{channel}").status_code == 200

    assert client.get(f"/api/projects/{seeded['project_id']}/channels").json() == []
    with db_session.session_scope() as session:
        rows = session.query(m.Message).all()
        assert [row.body for row in rows] == ["기록으로 남을 말"]


def test_a_deleted_channel_takes_no_new_messages(client: TestClient, channel):
    client.delete(f"/api/channels/{channel}")
    response = client.post(f"/api/channels/{channel}/messages", json={"body": "여보세요"})
    assert response.status_code == 400


def test_remaking_a_deleted_channel_revives_it(client: TestClient, seeded, channel):
    """지운 이름으로 다시 만들면 "이미 있다" 가 아니라 되살아납니다."""
    client.delete(f"/api/channels/{channel}")
    again = client.post(
        f"/api/projects/{seeded['project_id']}/channels",
        json={"kind": "text", "name": "일반"},
    )
    assert again.status_code == 201
    assert again.json()["id"] == channel


def test_reordering_needs_the_whole_list(client: TestClient, seeded, channel):
    """⭐ CHANNEL-005 — 하나가 빠진 목록을 받으면 그 채널이 자리를 잃습니다."""
    second = client.post(
        f"/api/projects/{seeded['project_id']}/channels",
        json={"kind": "text", "name": "공지"},
    ).json()["id"]

    partial = client.put(
        f"/api/projects/{seeded['project_id']}/channels/order",
        json={"channel_ids": [second]},
    )
    assert partial.status_code == 400

    whole = client.put(
        f"/api/projects/{seeded['project_id']}/channels/order",
        json={"channel_ids": [second, channel]},
    )
    assert whole.status_code == 200
    assert [c["name"] for c in whole.json()] == ["공지", "일반"]


def test_someone_outside_the_project_sees_nothing(client: TestClient, seeded, channel):
    """⚠️ 없는 채널과 남의 채널에 **같은 404** 를 줍니다."""
    with db_session.session_scope() as session:
        outsider = m.User(name="남남", email="stranger@example.com")
        session.add(outsider)
        session.flush()
        outsider_id = outsider.id
    login_as(client, outsider_id)

    assert client.get(f"/api/channels/{channel}/messages").status_code == 404
    assert client.get(f"/api/channels/{channel + 999}/messages").status_code == 404


def test_logged_out_cannot_read(client: TestClient, seeded, channel):
    logout(client)
    assert client.get(f"/api/channels/{channel}/messages").status_code == 401


# ══════════════════════════════════════════════════════════════
# 메시지 (CHAT-001~010)
# ══════════════════════════════════════════════════════════════


def test_sending_and_reading_back(client: TestClient, seeded, channel):
    sent = client.post(
        f"/api/channels/{channel}/messages", json={"body": "회의 5분 뒤에 시작합니다"}
    )
    assert sent.status_code == 201
    body = sent.json()
    assert body["author_name"] == "김민수"
    assert body["edited_at"] is None
    assert body["deleted"] is False


def test_an_empty_message_is_refused(client: TestClient, channel):
    """⚠️ **공백만 있는 것도** 빈 메시지입니다.

    Pydantic 의 `min_length` 는 글자 수만 봐서 `"   "` 를 통과시킵니다.
    걸러 내는 것은 `_clean_body` 이고, 그래서 답이 422 가 아니라 400 입니다.
    """
    blank = client.post(f"/api/channels/{channel}/messages", json={"body": ""})
    spaces = client.post(f"/api/channels/{channel}/messages", json={"body": "   "})
    assert blank.status_code == 422
    assert spaces.status_code == 400


def test_history_comes_oldest_first_and_pages_backwards(client: TestClient, channel):
    """CHAT-009."""
    for i in range(5):
        client.post(f"/api/channels/{channel}/messages", json={"body": f"{i}번"})

    page = client.get(f"/api/channels/{channel}/messages", params={"limit": 2}).json()
    assert [msg["body"] for msg in page] == ["3번", "4번"]

    older = client.get(
        f"/api/channels/{channel}/messages",
        params={"limit": 2, "before_id": page[0]["id"]},
    ).json()
    assert [msg["body"] for msg in older] == ["1번", "2번"]


def test_editing_marks_it_as_edited(client: TestClient, channel):
    """⭐ CHAT-002 — 고친 사실을 감추면 말이 달라진 것을 아무도 모릅니다."""
    message_id = client.post(
        f"/api/channels/{channel}/messages", json={"body": "3시에 봅시다"}
    ).json()["id"]

    edited = client.patch(f"/api/messages/{message_id}", json={"body": "4시에 봅시다"})
    assert edited.status_code == 200
    assert edited.json()["body"] == "4시에 봅시다"
    assert edited.json()["edited_at"] is not None


def test_only_the_author_can_edit(client: TestClient, seeded, channel):
    message_id = client.post(
        f"/api/channels/{channel}/messages", json={"body": "내 말"}
    ).json()["id"]

    login_as(client, seeded["user_ids"][1])
    assert client.patch(f"/api/messages/{message_id}", json={"body": "남의 말"}).status_code == 403
    assert client.delete(f"/api/messages/{message_id}").status_code == 403


def test_deleting_keeps_the_row_and_hides_the_body(client: TestClient, channel):
    """⭐ CHAT-003 — 답글이 가리키는 자리는 남고, 본문은 **서버가** 뺍니다."""
    parent = client.post(
        f"/api/channels/{channel}/messages", json={"body": "이 설계 어때요?"}
    ).json()["id"]
    client.post(
        f"/api/channels/{channel}/messages",
        json={"body": "좋습니다", "reply_to_id": parent},
    )

    client.delete(f"/api/messages/{parent}")
    rows = client.get(f"/api/channels/{channel}/messages").json()
    assert len(rows) == 2
    assert rows[0]["deleted"] is True
    assert rows[0]["body"] == ""
    assert rows[1]["reply_to_id"] == parent


def test_a_reply_cannot_reach_into_another_channel(client: TestClient, seeded, channel):
    """⚠️ 다른 채널의 글을 답글로 끌어오면 못 보는 사람의 말이 인용됩니다."""
    other = client.post(
        f"/api/projects/{seeded['project_id']}/channels",
        json={"kind": "text", "name": "비밀"},
    ).json()["id"]
    elsewhere = client.post(
        f"/api/channels/{other}/messages", json={"body": "저쪽 이야기"}
    ).json()["id"]

    response = client.post(
        f"/api/channels/{channel}/messages",
        json={"body": "인용해 봅니다", "reply_to_id": elsewhere},
    )
    assert response.status_code == 400


# ══════════════════════════════════════════════════════════════
# 멘션 (CHAT-005)
# ══════════════════════════════════════════════════════════════


def test_the_server_decides_who_was_mentioned(client: TestClient, seeded, channel):
    """⭐ 화면이 목록을 보내지 않습니다 — 본문에서만 나옵니다."""
    sent = client.post(
        f"/api/channels/{channel}/messages",
        json={"body": "@이하늘 님 이 화면 봐주세요"},
    ).json()
    assert sent["mentions"] == ["이하늘"]

    counted = client.get(f"/api/projects/{seeded['project_id']}/mentions").json()
    assert counted["mention_total"] == 0  # 나를 부른 것이 아닙니다

    login_as(client, seeded["user_ids"][1])
    assert client.get(f"/api/projects/{seeded['project_id']}/mentions").json() == {
        "mention_total": 1
    }


def test_someone_outside_the_project_is_not_mentioned(client: TestClient, channel):
    sent = client.post(
        f"/api/channels/{channel}/messages", json={"body": "@없는사람 확인해주세요"}
    ).json()
    assert sent["mentions"] == []


def test_editing_out_a_mention_removes_it(client: TestClient, seeded, channel):
    """⚠️ 본문에서 지운 사람이 계속 "불린 사람" 으로 남으면 안 됩니다."""
    message_id = client.post(
        f"/api/channels/{channel}/messages", json={"body": "@이하늘 봐주세요"}
    ).json()["id"]

    edited = client.patch(f"/api/messages/{message_id}", json={"body": "제가 하겠습니다"})
    assert edited.json()["mentions"] == []

    login_as(client, seeded["user_ids"][1])
    assert (
        client.get(f"/api/projects/{seeded['project_id']}/mentions").json()[
            "mention_total"
        ]
        == 0
    )


# ══════════════════════════════════════════════════════════════
# 반응 (CHAT-008)
# ══════════════════════════════════════════════════════════════


def test_one_reaction_per_person(client: TestClient, seeded, channel):
    """⭐ 갈아 끼웁니다 — 한 사람이 넷을 다 달아 수를 부풀릴 수 없습니다."""
    message_id = client.post(
        f"/api/channels/{channel}/messages", json={"body": "배포했습니다"}
    ).json()["id"]

    first = client.put(f"/api/messages/{message_id}/reaction", json={"mark": "ok"})
    assert first.json()["reactions"] == [
        {"mark": "ok", "label": "확인했어요", "count": 1}
    ]
    assert first.json()["my_reaction"] == "ok"

    swapped = client.put(f"/api/messages/{message_id}/reaction", json={"mark": "thanks"})
    assert swapped.json()["reactions"] == [
        {"mark": "thanks", "label": "고마워요", "count": 1}
    ]

    removed = client.put(f"/api/messages/{message_id}/reaction", json={"mark": None})
    assert removed.json()["reactions"] == []
    assert removed.json()["my_reaction"] is None


def test_a_made_up_reaction_is_refused(client: TestClient, channel):
    """⚠️ 자유 입력이 아닙니다 — 이유는 `db/vocab.py` 의 `ReactionMark` 에."""
    message_id = client.post(
        f"/api/channels/{channel}/messages", json={"body": "확인 부탁"}
    ).json()["id"]
    response = client.put(
        f"/api/messages/{message_id}/reaction", json={"mark": "\N{PILE OF POO}"}
    )
    assert response.status_code == 400


def test_reactions_keep_vocabulary_order_not_count_order(
    client: TestClient, seeded, channel
):
    """⭐ 개수 순으로 세우면 그건 순위표입니다 (`AGENTS.md` 불변식 1)."""
    message_id = client.post(
        f"/api/channels/{channel}/messages", json={"body": "리뷰 부탁드려요"}
    ).json()["id"]

    # `thanks` 를 둘, `ok` 를 하나 — 개수 순이면 thanks 가 앞에 옵니다.
    client.put(f"/api/messages/{message_id}/reaction", json={"mark": "thanks"})
    login_as(client, seeded["user_ids"][1])
    client.put(f"/api/messages/{message_id}/reaction", json={"mark": "thanks"})
    login_as(client, seeded["user_ids"][2])
    body = client.put(f"/api/messages/{message_id}/reaction", json={"mark": "ok"}).json()

    assert [r["mark"] for r in body["reactions"]] == ["ok", "thanks"]


def test_my_reaction_is_mine_alone(client: TestClient, seeded, channel):
    message_id = client.post(
        f"/api/channels/{channel}/messages", json={"body": "봐주세요"}
    ).json()["id"]
    client.put(f"/api/messages/{message_id}/reaction", json={"mark": "agree"})

    login_as(client, seeded["user_ids"][1])
    seen = client.get(f"/api/channels/{channel}/messages").json()[0]
    assert seen["reactions"][0]["count"] == 1
    assert seen["my_reaction"] is None


def test_a_deleted_message_takes_no_reactions(client: TestClient, channel):
    message_id = client.post(
        f"/api/channels/{channel}/messages", json={"body": "잘못 썼습니다"}
    ).json()["id"]
    client.delete(f"/api/messages/{message_id}")
    assert (
        client.put(f"/api/messages/{message_id}/reaction", json={"mark": "ok"}).status_code
        == 400
    )


# ══════════════════════════════════════════════════════════════
# 검색 (CHAT-010)
# ══════════════════════════════════════════════════════════════


def test_search_finds_it_and_says_which_channel(client: TestClient, seeded, channel):
    client.post(f"/api/channels/{channel}/messages", json={"body": "로그인 API 배포했습니다"})
    found = client.get(
        f"/api/projects/{seeded['project_id']}/messages/search", params={"q": "로그인"}
    ).json()
    assert len(found) == 1
    assert found[0]["channel_name"] == "일반"
    assert found[0]["message"]["body"] == "로그인 API 배포했습니다"


def test_search_does_not_resurrect_deleted_messages(client: TestClient, seeded, channel):
    message_id = client.post(
        f"/api/channels/{channel}/messages", json={"body": "지울 비밀번호 이야기"}
    ).json()["id"]
    client.delete(f"/api/messages/{message_id}")

    found = client.get(
        f"/api/projects/{seeded['project_id']}/messages/search", params={"q": "비밀번호"}
    ).json()
    assert found == []


def test_a_one_letter_search_is_not_a_search(client: TestClient, seeded, channel):
    client.post(f"/api/channels/{channel}/messages", json={"body": "가나다라"})
    found = client.get(
        f"/api/projects/{seeded['project_id']}/messages/search", params={"q": "가"}
    ).json()
    assert found == []


# ══════════════════════════════════════════════════════════════
# 채널 종류 — 화면이 고를 수 있어야 한다 (결함 360)
# ══════════════════════════════════════════════════════════════


def test_the_screen_can_ask_what_kinds_exist(client: TestClient, seeded):
    """⭐ 만들 수 있는 종류를 **서버가 내려보낸다** (CHANNEL-001·002).

    이 갈래가 없던 동안 화면에는 종류를 고를 자리가 아예 없었고
    `kind: 'text'` 가 박혀 있었습니다 (결함 360). 그런데 `vocab.py` 는
    「두 종류 다 **화면에서 만들 수 있고**」라고, `docs/20` 은 CHANNEL-002
    를 ✅ 라고 적어 두고 있었습니다 — 주석과 대조표가 코드보다 앞서
    있었습니다.
    """
    rows = client.get("/api/chat/channel-kinds").json()
    assert [r["kind"] for r in rows] == [str(k) for k in vocab.ChannelKind], rows


def test_every_kind_has_a_name_and_a_hint(client: TestClient, seeded):
    """⭐ 이름표와 설명이 **어휘의 값마다** 있다.

    ⚠️ 이름만 다르고 설명이 없으면 사람은 아무거나 고릅니다 — 텍스트와
    음성은 **되돌리기 어려운 차이**입니다(음성 채널에는 메시지를 못 씁니다).
    """
    rows = client.get("/api/chat/channel-kinds").json()
    for row in rows:
        assert row["label"].strip(), row
        assert row["hint"].strip(), row
        # 내부 식별자가 사람에게 나가지 않습니다 (결함 78·86).
        assert row["kind"] not in row["label"], row


def test_making_a_voice_channel_actually_works(client: TestClient, seeded):
    """⭐ 화면이 고른 종류가 **그대로 저장된다**.

    ⚠️ 서버는 처음부터 둘 다 받았습니다 — 없던 것은 **고를 자리**뿐이라,
    이 검사는 「받는가」가 아니라 「받은 대로 저장하는가」를 잽니다.
    """
    made = client.post(
        f"/api/projects/{seeded['project_id']}/channels",
        json={"kind": "voice", "name": "주간회의"},
    )
    assert made.status_code == 201, made.text
    assert made.json()["kind"] == "voice"

    listed = client.get(f"/api/projects/{seeded['project_id']}/channels").json()
    assert any(c["kind"] == "voice" and c["name"] == "주간회의" for c in listed), listed
