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

from .conftest import login_as
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
    assert mine[0]["text"] == "김민수 님이 대화에서 나를 불렀습니다"
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
    assert mine[0]["text"] == "나를 부른 메시지가 지워졌습니다"


# ══════════════════════════════════════════════════════════════
# 마감 (NOTIFICATION-003·004) — **저장하지 않습니다**
# ══════════════════════════════════════════════════════════════


def make_task(seeded, *, days: int, status: str = "todo", who: int = 0) -> int:
    with db_session.session_scope() as session:
        task = m.Task(
            project_id=seeded["project_id"],
            title="통합 테스트 작성",
            assignee_id=seeded["user_ids"][who],
            deadline=datetime.now(UTC) + timedelta(days=days),
            status=status,
        )
        session.add(task)
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
