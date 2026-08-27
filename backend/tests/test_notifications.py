"""알림 (요구사항 정의서 §19 NOTIFICATION-001~006).

⚠️ 여기서 제일 중요한 것은 **마감 알림이 저장되지 않는다**는 것입니다.
행으로 쌓으면 마감일을 미뤘을 때 "곧 마감" 이 남고, 업무를 끝냈을 때
"지연" 이 남습니다 — 알림이 사실이 아니라 **베낀 순간의 사실**을 가리키게
됩니다. 이 저장소가 반복해서 당한 실패 ② 입니다.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError

from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.db.vocab import NOTIFICATION_DERIVED, NOTIFICATION_STORED, NotificationKind
from teamflow.services.notification_service import MAX_ITEMS

from .conftest import assign, login_as
from .test_api import client, engine, seeded  # noqa: F401  (픽스처)

NOW = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)


@pytest.fixture
def channel(client: TestClient, seeded) -> int:
    return int(
        client.post(
            f"/api/projects/{seeded['project_id']}/channels",
            json={"kind": "text", "name": "일반"},
        ).json()["id"]
    )


def notices(client: TestClient, project_id: int) -> list[dict]:
    return client.get(f"/api/projects/{project_id}/notifications").json()


# ══════════════════════════════════════════════════════════════
# 어휘 — 무엇을 저장하고 무엇을 안 하는가
# ══════════════════════════════════════════════════════════════


def test_the_two_derived_kinds_are_not_storable():
    """⭐ 어휘가 경계를 말한다."""
    assert {
        NotificationKind.DUE_SOON,
        NotificationKind.OVERDUE,
    } == NOTIFICATION_DERIVED
    assert not (NOTIFICATION_STORED & NOTIFICATION_DERIVED)
    assert set(NotificationKind) == NOTIFICATION_STORED | NOTIFICATION_DERIVED


def test_the_database_refuses_a_derived_kind(engine, seeded):
    """⭐ 어휘가 말만 하는 것이 아니라 **DB 가 막습니다.**

    이게 없으면 누가 "쌓아 두면 편하지" 하고 한 줄 더했을 때 아무것도
    안 터집니다.
    """
    with pytest.raises(IntegrityError), db_session.session_scope() as session:
        session.add(
            m.Notification(
                user_id=seeded["user_ids"][0],
                project_id=seeded["project_id"],
                kind="overdue",
            )
        )


# ══════════════════════════════════════════════════════════════
# 멘션 (NOTIFICATION-001)
# ══════════════════════════════════════════════════════════════


def test_a_mention_notifies_the_person_called(client: TestClient, seeded, channel):
    client.post(f"/api/channels/{channel}/messages", json={"body": "@이하늘 봐주세요"})

    login_as(client, seeded["user_ids"][1])
    mine = notices(client, seeded["project_id"])
    assert [n["kind"] for n in mine] == ["mention"]
    # ⚠️ 예전에는 「김민수 님이 **대화**에서」였습니다 (결함 397) — 한 사람이
    #    나를 두 번 부르면 두 줄이 글자·링크까지 똑같았습니다.
    assert mine[0]["text"] == "김민수 님이 일반 채널에서 나를 불렀습니다"
    assert mine[0]["read"] is False


def test_calling_yourself_does_not_notify_you(client: TestClient, seeded, channel):
    """⚠️ `@내이름` 으로 자기 알림을 만드는 것은 뜻이 없습니다."""
    client.post(f"/api/channels/{channel}/messages", json={"body": "@김민수 메모"})
    assert notices(client, seeded["project_id"]) == []


def test_a_deleted_message_does_not_resurrect_its_text(
    client: TestClient, seeded, channel
):
    """⭐ 지운 글의 본문을 알림으로 되살리면 지운 것이 지운 것이 아닙니다."""
    message_id = client.post(
        f"/api/channels/{channel}/messages", json={"body": "@이하늘 비밀번호는"}
    ).json()["id"]
    client.delete(f"/api/messages/{message_id}")

    login_as(client, seeded["user_ids"][1])
    mine = notices(client, seeded["project_id"])
    # ⚠️ **이 갈래에도 자리를 적습니다** (결함 397). 안 적으면 지워진 부름이
    #    둘일 때 또 똑같은 두 줄이 됩니다 — 본문은 여전히 안 되살립니다.
    assert mine[0]["text"] == "일반 채널에서 나를 부른 메시지가 지워졌습니다"
    assert "비밀번호" not in mine[0]["text"]


# ══════════════════════════════════════════════════════════════
# 마감 (NOTIFICATION-003·004) — **저장하지 않습니다**
# ══════════════════════════════════════════════════════════════


def make_task(seeded, *, days: int, status: str = "todo", who: int = 0) -> int:
    with db_session.session_scope() as session:
        task = m.Task(
            project_id=seeded["project_id"],
            title="통합 테스트 작성",
            deadline=datetime.now(UTC) + timedelta(days=days),
            status=status,
        )
        session.add(task)
        session.flush()
        assign(session, task, seeded["user_ids"][who])
        session.flush()
        return task.id


def test_a_deadline_two_days_out_is_due_soon(client: TestClient, seeded):
    make_task(seeded, days=2)
    mine = notices(client, seeded["project_id"])
    assert [n["kind"] for n in mine] == ["due_soon"]
    assert mine[0]["text"] == "곧 마감입니다 — 통합 테스트 작성"
    # ⚠️ 파생이라 번호가 없습니다 — 읽을 수 있는 것이 아닙니다.
    assert mine[0]["notification_id"] is None


def test_a_deadline_far_out_says_nothing(client: TestClient, seeded):
    make_task(seeded, days=30)
    assert notices(client, seeded["project_id"]) == []


def test_a_passed_deadline_is_overdue(client: TestClient, seeded):
    make_task(seeded, days=-2)
    assert [n["kind"] for n in notices(client, seeded["project_id"])] == ["overdue"]


def test_a_finished_task_is_never_late(client: TestClient, seeded):
    """⭐ 끝냈으면 마감일이 지나도 지연이 아닙니다."""
    make_task(seeded, days=-2, status="done")
    assert notices(client, seeded["project_id"]) == []


def test_moving_the_deadline_moves_the_notice(client: TestClient, seeded):
    """⭐⭐ 이 검사가 "저장하지 않는다" 를 지킵니다.

    쌓아 뒀으면 옛 알림이 남아 있어서 두 건이 나오거나, 옮겼는데도
    "곧 마감" 이 그대로 남습니다.
    """
    task_id = make_task(seeded, days=1)
    assert [n["kind"] for n in notices(client, seeded["project_id"])] == ["due_soon"]

    with db_session.session_scope() as session:
        task = session.get(m.Task, task_id)
        assert task is not None
        task.deadline = datetime.now(UTC) + timedelta(days=60)

    assert notices(client, seeded["project_id"]) == []


def test_finishing_the_task_clears_the_overdue_notice(client: TestClient, seeded):
    task_id = make_task(seeded, days=-5)
    assert len(notices(client, seeded["project_id"])) == 1

    with db_session.session_scope() as session:
        task = session.get(m.Task, task_id)
        assert task is not None
        task.status = "done"

    assert notices(client, seeded["project_id"]) == []


def test_someone_elses_deadline_is_not_my_notice(client: TestClient, seeded):
    make_task(seeded, days=1, who=1)
    assert notices(client, seeded["project_id"]) == []


# ══════════════════════════════════════════════════════════════
# 읽음
# ══════════════════════════════════════════════════════════════


def test_reading_marks_it_and_drops_the_badge(client: TestClient, seeded, channel):
    client.post(f"/api/channels/{channel}/messages", json={"body": "@이하늘 확인 부탁"})
    login_as(client, seeded["user_ids"][1])

    assert client.get(f"/api/projects/{seeded['project_id']}/notifications/unread").json() == {
        "unread": 1
    }
    mine = notices(client, seeded["project_id"])
    marked = client.post(
        f"/api/projects/{seeded['project_id']}/notifications/read",
        json={"notification_ids": [mine[0]["notification_id"]]},
    )
    assert marked.json() == {"marked": 1}
    assert client.get(f"/api/projects/{seeded['project_id']}/notifications/unread").json() == {
        "unread": 0
    }
    # ⚠️ 읽어도 **사라지지 않습니다** — 행을 안 지웁니다.
    assert notices(client, seeded["project_id"])[0]["read"] is True


def test_the_badge_does_not_count_deadlines(client: TestClient, seeded):
    """⭐ 읽어도 안 없어지는 것을 배지에 세면 배지가 영영 안 줄어듭니다."""
    make_task(seeded, days=1)
    assert len(notices(client, seeded["project_id"])) == 1
    assert client.get(f"/api/projects/{seeded['project_id']}/notifications/unread").json() == {
        "unread": 0
    }


def test_i_cannot_read_someone_elses_notification(client: TestClient, seeded, channel):
    """⭐ 번호만 알면 남의 알림을 지울 수 있으면 안 됩니다."""
    client.post(f"/api/channels/{channel}/messages", json={"body": "@이하늘 확인 부탁"})

    login_as(client, seeded["user_ids"][1])
    theirs = notices(client, seeded["project_id"])[0]["notification_id"]

    login_as(client, seeded["user_ids"][2])
    marked = client.post(
        f"/api/projects/{seeded['project_id']}/notifications/read",
        json={"notification_ids": [theirs]},
    )
    assert marked.json() == {"marked": 0}

    login_as(client, seeded["user_ids"][1])
    assert notices(client, seeded["project_id"])[0]["read"] is False


def test_someone_outside_the_project_gets_nothing(client: TestClient, seeded):
    with db_session.session_scope() as session:
        outsider = m.User(name="남남", email="stranger@example.com")
        session.add(outsider)
        session.flush()
        outsider_id = outsider.id
    login_as(client, outsider_id)
    assert (
        client.get(f"/api/projects/{seeded['project_id']}/notifications").status_code == 403
    )


# ══════════════════════════════════════════════════════════════
# 회의 임박 (NOTIFICATION-005)
# ══════════════════════════════════════════════════════════════


def test_a_meeting_in_20_minutes_notifies_everyone(client: TestClient, seeded):
    """NOTIFICATION-005 — 팀원 **전원**에게. 회의는 같이 하는 것입니다."""
    from teamflow.services import notification_service as ns

    now = datetime.now(UTC)
    client.post(
        f"/api/projects/{seeded['project_id']}/scheduled-meetings",
        json={"title": "설계 리뷰", "at": (now + timedelta(minutes=20)).isoformat()},
    )
    with db_session.session_scope() as session:
        made = ns.announce_upcoming_meetings(session, now=now)
    assert made == 3  # 팀원 셋

    mine = notices(client, seeded["project_id"])
    assert [n["kind"] for n in mine] == ["meeting_soon"]
    assert mine[0]["text"] == "곧 회의가 시작됩니다 — 설계 리뷰"


def test_a_meeting_next_week_is_not_soon(client: TestClient, seeded):
    from teamflow.services import notification_service as ns

    now = datetime.now(UTC)
    client.post(
        f"/api/projects/{seeded['project_id']}/scheduled-meetings",
        json={"title": "다음 주", "at": (now + timedelta(days=7)).isoformat()},
    )
    with db_session.session_scope() as session:
        assert ns.announce_upcoming_meetings(session, now=now) == 0


def test_running_twice_does_not_notify_twice(client: TestClient, seeded):
    """⭐ 5분마다 도는 작업입니다 — 다시 알리면 30분에 여섯 개가 쌓입니다."""
    from teamflow.services import notification_service as ns

    now = datetime.now(UTC)
    client.post(
        f"/api/projects/{seeded['project_id']}/scheduled-meetings",
        json={"title": "설계 리뷰", "at": (now + timedelta(minutes=20)).isoformat()},
    )
    with db_session.session_scope() as session:
        assert ns.announce_upcoming_meetings(session, now=now) == 3
    with db_session.session_scope() as session:
        assert ns.announce_upcoming_meetings(session, now=now) == 0

    assert len(notices(client, seeded["project_id"])) == 1


def test_an_already_opened_meeting_is_not_about_to_start(client: TestClient, seeded):
    """⭐ `started_at` 이 있으면 벌써 시작한 것입니다."""
    from teamflow.services import notification_service as ns

    now = datetime.now(UTC)
    with db_session.session_scope() as session:
        meeting = session.get(m.Meeting, seeded["meeting_id"])
        assert meeting is not None
        meeting.scheduled_at = now + timedelta(minutes=10)
        # `started_at` 은 이미 있습니다 (픽스처가 연 회의입니다).

    with db_session.session_scope() as session:
        assert ns.announce_upcoming_meetings(session, now=now) == 0


def test_the_periodic_task_is_registered_and_frequent_enough():
    """⭐ 만들어 놓고 **부르는 곳이 없으면** 알림은 영영 안 옵니다.

    ⚠️ 하루 한 번이면 30분 전 알림은 대부분의 회의를 놓칩니다.
    """
    from teamflow.tasks import app as celery_app

    entry = celery_app.conf.beat_schedule["announce-upcoming-meetings"]
    assert entry["task"] == "teamflow.tasks.maintenance.announce_upcoming_meetings_task"
    assert str(entry["schedule"].minute) != "0", "하루 한 번이면 회의를 놓칩니다"


# ══════════════════════════════════════════════════════════════
# 결함 397 — 두 부름이 **서로 다른 줄**로 보이는가
# ══════════════════════════════════════════════════════════════


def test_two_mentions_in_different_channels_do_not_read_the_same(
    client: TestClient, seeded, channel
):
    """⭐ 한 사람이 나를 두 번 부르면 **두 줄이 서로 달라야** 합니다.

    ## ⚠️ 재현 (결함 397)

    예전 문장은 「김민수 님이 **대화**에서 나를 불렀습니다」였습니다. 부른
    사람이 같으면 글자가 똑같고, `hrefFor` 도 `message_id` 를 버리고
    `/chat.html?project=N` 만 만들어서 **링크까지 똑같았습니다.**

    ⚠️ 결함 396(GitHub 알림)과 **다른 점은 가리킬 것이 이미 있었다**는
    것입니다. 행에 `message_id` 가 들어 있는데 문장도 링크도 안 썼습니다 —
    같은 함수의 옆 갈래는 회의 번호를 `?meeting=N` 으로 들고 갑니다.
    """
    second = int(
        client.post(
            f"/api/projects/{seeded['project_id']}/channels",
            json={"kind": "text", "name": "개발"},
        ).json()["id"]
    )
    client.post(f"/api/channels/{channel}/messages", json={"body": "@이하늘 첫째"})
    client.post(f"/api/channels/{second}/messages", json={"body": "@이하늘 둘째"})

    login_as(client, seeded["user_ids"][1])
    texts = [n["text"] for n in notices(client, seeded["project_id"]) if n["kind"] == "mention"]
    assert len(texts) == 2, texts
    assert len(set(texts)) == 2, f"두 줄이 똑같습니다 — 어디서 불렀는지 알 수 없습니다: {texts}"
    assert any("일반" in t for t in texts), texts
    assert any("개발" in t for t in texts), texts


def test_the_mention_line_does_not_build_the_hash_itself(
    client: TestClient, seeded, channel
):
    """⛔ `#` 은 **서버가 붙이지 않습니다.**

    `@lib/chat/view.ts` 의 `channelTitle` 이 「`#` 은 **여기서** 붙입니다」
    라고 적어 두고 이유까지 답니다(이름에 넣어 저장하면 이름을 바꿀 때 `#`
    이 남거나 겹칩니다). 서버가 같은 규칙을 다시 적으면 **두 벌**이 되고,
    두 벌은 갈라집니다 — 이 저장소의 대표 실패 ②.

    그래서 서버 산문이 이미 쓰는 「이름 + 채널」을 씁니다
    (`channel_service` 의 「`{이름}` 채널이 이미 있습니다」와 같은 모양).
    """
    client.post(f"/api/channels/{channel}/messages", json={"body": "@이하늘 봐주세요"})

    login_as(client, seeded["user_ids"][1])
    (text,) = [n["text"] for n in notices(client, seeded["project_id"]) if n["kind"] == "mention"]
    assert "#" not in text, f"서버가 `#` 을 붙였습니다 — 규칙이 두 벌입니다: {text}"
    assert "일반 채널" in text, text


def test_a_mention_from_a_missing_channel_says_the_old_word(seeded):
    """⚠️ **모르면 지어내지 않습니다** — 채널을 못 찾으면 「대화」입니다.

    ⚠️ 이 갈래는 실기에서 잘 안 나옵니다(채널을 지워도 메시지는 남습니다).
    그래서 **손으로 만들어** 잽니다 — 안 그러면 「모를 때 무엇을 말하는가」가
    영영 미검증입니다.

    ⚠️ 처음에 이 검사는 이름과 **다른 것**을 재고 있었습니다(`message_id`
    가 없는 행). 이름이 재는 것과 다르면 다음 사람은 이 갈래가 검증됐다고
    믿습니다 — 이 저장소가 짝 검사에서 여러 번 당한 모양입니다.
    """
    from teamflow.services import notification_service

    with db_session.session_scope() as session:
        # 있지도 않은 채널을 가리키는 메시지. 세션에 넣지 않습니다 —
        # 재려는 것은 `_which_channel` 의 「못 찾으면」 갈래 하나입니다.
        orphan = m.Message(channel_id=999_999, author_id=seeded["user_ids"][0], body="x")
        assert notification_service._which_channel(session, orphan) == "대화"


def test_a_channel_with_a_blank_name_says_the_old_word(seeded):
    """⚠️ 이름이 비었으면 「 채널」이라고 적지 않습니다 — 「대화」입니다.

    서버가 빈 이름을 거절하므로 실기에서는 안 나옵니다. 그래도 재는 이유는
    **빈 글자를 문장에 끼우면 「김민수 님이  채널에서」**가 되기 때문입니다.
    """
    from teamflow.services import notification_service

    with db_session.session_scope() as session:
        channel = m.Channel(project_id=seeded["project_id"], kind="text", name="   ")
        session.add(channel)
        session.flush()
        message = m.Message(
            channel_id=channel.id, author_id=seeded["user_ids"][0], body="x"
        )
        assert notification_service._which_channel(session, message) == "대화"


# ══════════════════════════════════════════════════════════════
# 결함 398 — 목록이 꽉 차면 **마감·지연이 밀려나던 것**
# ══════════════════════════════════════════════════════════════


def test_a_noisy_channel_does_not_push_out_the_overdue_notice(
    client: TestClient, seeded, channel
):
    """⭐ 채팅이 아무리 와도 **지연 알림은 남습니다** (결함 398).

    ## ⚠️ 재현

    `collect` 는 저장된 사건과 마감 알림을 합쳐 시각 내림차순으로 정렬한
    뒤 `[:MAX_ITEMS]` 했습니다. 그런데 두 갈래의 `at` 은 **뜻이 다릅니다**
    (결함 331) — 저장된 사건은 「일어난 때」, 마감 알림은 **「마감일」**.
    지난 마감은 과거라 맨 아래로 가라앉고, 부름이 50통 오면 **통째로**
    잘려 나갔습니다. 실제로 재니 마감/지연이 **0줄**이었습니다.

    ## ⚠️ 왜 그냥 잘리면 안 되는가

    이 화면은 머리말에서 「다가오는 마감과 회의입니다」라고 **약속**하고,
    바로 다음 문장에서 「마감일을 미루거나 업무를 끝내면 그 자리에서
    사라집니다」라고 **사라지는 조건까지 가르칩니다.** 채팅 때문에
    사라지면 사람은 그 규칙을 믿고 「누가 끝냈나 보다」라고 읽습니다.
    """
    make_task(seeded, days=-3, who=1)  # 이하늘의 지난 마감

    login_as(client, seeded["user_ids"][0])
    for i in range(MAX_ITEMS + 10):
        client.post(f"/api/channels/{channel}/messages", json={"body": f"@이하늘 {i}"})

    login_as(client, seeded["user_ids"][1])
    mine = notices(client, seeded["project_id"])
    kinds = {n["kind"] for n in mine}
    assert "overdue" in kinds, (
        f"부름 {MAX_ITEMS + 10}통에 지연 알림이 밀려났습니다 — {sorted(kinds)}"
    )
    assert len(mine) == MAX_ITEMS, len(mine)


def test_the_list_still_stops_at_the_cap(client: TestClient, seeded, channel):
    """⚠️ 자리를 먼저 준다고 **상한이 늘어나면 안 됩니다.**

    마감에 자리를 주는 고침이 `MAX_ITEMS` 를 넘겨 버리면, 화면은 끝없이
    길어지고 이 상한을 둔 이유가 사라집니다.
    """
    make_task(seeded, days=-3, who=1)
    login_as(client, seeded["user_ids"][0])
    for i in range(MAX_ITEMS + 10):
        client.post(f"/api/channels/{channel}/messages", json={"body": f"@이하늘 {i}"})

    login_as(client, seeded["user_ids"][1])
    assert len(notices(client, seeded["project_id"])) == MAX_ITEMS


def test_when_deadlines_alone_overflow_the_most_overdue_survive(seeded):
    """⚠️ 마감만으로 넘칠 때는 **급한 것부터** 남깁니다.

    ⚠️ 그리는 순서(새것부터)와 **자르는 순서**(오래 지난 것부터)는 다릅니다.
    안 가르면 「가장 오래 지난 것」이 잘려 나갑니다 — 제일 급한 것입니다.
    """
    from teamflow.services import notification_service

    for days in range(1, MAX_ITEMS + 6):
        make_task(seeded, days=-days, who=1)

    with db_session.session_scope() as session:
        got = notification_service.collect(
            session, seeded["user_ids"][1], seeded["project_id"], now=datetime.now(UTC)
        )
    assert len(got) == MAX_ITEMS
    # ⚠️ 처음에 이 줄을 `n["kind"] if isinstance(...) else n.kind == "overdue"`
    #    로 썼습니다 — 우연히 맞았을 뿐 dict 갈래는 **글자를 돌려주는**
    #    참값이라 아무것도 안 잽니다. 자는 단순해야 읽힙니다.
    assert {n.kind for n in got} == {"overdue"}
    # 가장 오래 지난 것 = `at` 이 가장 작은 것. 남아 있어야 합니다.
    oldest = min(n.at for n in got)
    with db_session.session_scope() as session:
        every = notification_service.deadline_notices(
            session, seeded["user_ids"][1], seeded["project_id"], now=datetime.now(UTC)
        )
    assert oldest == min(n.at for n in every), "제일 오래 지난 마감이 잘려 나갔습니다"
