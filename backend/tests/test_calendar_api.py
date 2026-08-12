"""일정 (요구사항 정의서 §16 CALENDAR-001~005).

⚠️ 여기서 제일 중요한 것은 **달력이 베낀 자료를 안 본다**는 것입니다.
업무 마감일을 고치면 달력이 **그 자리에서** 따라와야 합니다 — 안 따라오면
두 벌이 있다는 뜻이고, 그건 이 저장소가 반복해서 당한 실패 ② 입니다.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from teamflow.db import models as m
from teamflow.db import session as db_session

from .conftest import assign
from .test_api import client, engine, seeded  # noqa: F401  (픽스처)

NOW = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)


def window(days: int = 30) -> dict[str, str]:
    return {
        "since": (NOW - timedelta(days=days)).isoformat(),
        "until": (NOW + timedelta(days=days)).isoformat(),
    }


@pytest.fixture
def dated_task(seeded) -> int:
    with db_session.session_scope() as session:
        task = m.Task(
            project_id=seeded["project_id"],
            title="로그인 API 구현",
            start_date=NOW + timedelta(days=1),
            deadline=NOW + timedelta(days=5),
            status="todo",
        )
        session.add(task)
        session.flush()
        assign(session, task, seeded["user_ids"][0])
        return task.id


# ══════════════════════════════════════════════════════════════
# 읽기 (CALENDAR-001·002·005)
# ══════════════════════════════════════════════════════════════


def test_a_task_shows_up_twice_once_per_date(client: TestClient, seeded, dated_task):
    """CALENDAR-002 — 시작일과 마감일은 **다른 날의 다른 일**입니다."""
    items = client.get(
        f"/api/projects/{seeded['project_id']}/calendar", params=window()
    ).json()
    mine = [i for i in items if i["task_id"] == dated_task]
    assert [i["kind"] for i in mine] == ["task_start", "task_due"]
    assert all(i["title"] == "로그인 API 구현" for i in mine)
    assert all(i["who"] == "김민수" for i in mine)


def test_a_task_with_no_dates_is_not_on_the_calendar(client: TestClient, seeded):
    """⭐ 마감일 없는 업무를 오늘에 놓으면 **없던 사실**이 생깁니다."""
    with db_session.session_scope() as session:
        session.add(
            m.Task(project_id=seeded["project_id"], title="날짜 없는 일", status="todo")
        )

    items = client.get(
        f"/api/projects/{seeded['project_id']}/calendar", params=window()
    ).json()
    assert [i for i in items if i["title"] == "날짜 없는 일"] == []


def test_moving_a_deadline_moves_the_calendar(client: TestClient, seeded, dated_task):
    """⭐ 베낀 자료를 보고 있으면 이 검사가 터집니다."""
    with db_session.session_scope() as session:
        task = session.get(m.Task, dated_task)
        assert task is not None
        task.deadline = NOW + timedelta(days=9)

    items = client.get(
        f"/api/projects/{seeded['project_id']}/calendar", params=window()
    ).json()
    due = next(i for i in items if i["kind"] == "task_due" and i["task_id"] == dated_task)
    assert due["at"].startswith("2026-09-10")


def test_the_project_deadline_is_on_the_calendar(client: TestClient, seeded):
    """CALENDAR-005."""
    items = client.get(
        f"/api/projects/{seeded['project_id']}/calendar",
        params={
            "since": datetime(2026, 11, 1, tzinfo=UTC).isoformat(),
            "until": datetime(2026, 12, 31, tzinfo=UTC).isoformat(),
        },
    ).json()
    assert [i["kind"] for i in items] == ["project_due"]
    assert items[0]["title"] == "TeamFlow 졸업작품"


def test_a_held_meeting_and_a_planned_one_are_not_the_same_thing(
    client: TestClient, seeded
):
    """⭐ 같은 종류로 두면 "이미 한 것" 과 "앞으로 할 것" 이 안 갈립니다."""
    client.post(
        f"/api/projects/{seeded['project_id']}/scheduled-meetings",
        json={"title": "다음 주 정기회의", "at": (NOW + timedelta(days=7)).isoformat()},
    )
    items = client.get(
        f"/api/projects/{seeded['project_id']}/calendar", params=window()
    ).json()
    kinds = {i["title"]: i["kind"] for i in items if i["meeting_id"] is not None}
    assert kinds["9월 1일 정기회의"] == "meeting_held"
    assert kinds["다음 주 정기회의"] == "meeting_planned"


def test_the_range_is_respected(client: TestClient, seeded, dated_task):
    """⚠️ 범위를 안 지키면 3년치가 한 번에 옵니다."""
    items = client.get(
        f"/api/projects/{seeded['project_id']}/calendar",
        params={
            "since": (NOW + timedelta(days=2)).isoformat(),
            "until": (NOW + timedelta(days=3)).isoformat(),
        },
    ).json()
    assert items == []


def test_a_backwards_range_is_refused(client: TestClient, seeded):
    response = client.get(
        f"/api/projects/{seeded['project_id']}/calendar",
        params={"since": NOW.isoformat(), "until": (NOW - timedelta(days=1)).isoformat()},
    )
    assert response.status_code == 400


def test_someone_outside_the_project_cannot_read_it(client: TestClient, seeded):
    from .conftest import login_as

    with db_session.session_scope() as session:
        outsider = m.User(name="남남", email="stranger@example.com")
        session.add(outsider)
        session.flush()
        outsider_id = outsider.id
    login_as(client, outsider_id)

    assert (
        client.get(
            f"/api/projects/{seeded['project_id']}/calendar", params=window()
        ).status_code
        == 403
    )


# ══════════════════════════════════════════════════════════════
# 일정 잡기 (CALENDAR-003·004)
# ══════════════════════════════════════════════════════════════


def test_scheduling_does_not_open_the_meeting(client: TestClient, seeded):
    """⭐ 잡아만 둔 회의가 "진행 중" 으로 보이면 안 됩니다."""
    response = client.post(
        f"/api/projects/{seeded['project_id']}/scheduled-meetings",
        json={"title": "설계 리뷰", "at": (NOW + timedelta(days=3)).isoformat()},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["started_at"] is None
    assert body["scheduled_at"].startswith("2026-09-04")

    with db_session.session_scope() as session:
        meeting = session.get(m.Meeting, body["meeting_id"])
        assert meeting is not None
        assert meeting.status == "pending"


def test_an_empty_title_is_refused(client: TestClient, seeded):
    response = client.post(
        f"/api/projects/{seeded['project_id']}/scheduled-meetings",
        json={"title": "   ", "at": NOW.isoformat()},
    )
    assert response.status_code == 400


def test_rescheduling_moves_it(client: TestClient, seeded):
    """CALENDAR-004."""
    meeting_id = client.post(
        f"/api/projects/{seeded['project_id']}/scheduled-meetings",
        json={"title": "설계 리뷰", "at": (NOW + timedelta(days=3)).isoformat()},
    ).json()["meeting_id"]

    moved = client.patch(
        f"/api/scheduled-meetings/{meeting_id}",
        json={"at": (NOW + timedelta(days=4)).isoformat(), "title": "설계 리뷰 (연기)"},
    )
    assert moved.status_code == 200
    assert moved.json()["scheduled_at"].startswith("2026-09-05")
    assert moved.json()["title"] == "설계 리뷰 (연기)"


def test_a_meeting_that_already_happened_cannot_be_moved(client: TestClient, seeded):
    """⭐ 열린 시각은 일어난 사실입니다 — 고치면 녹음 트랙과 어긋납니다."""
    response = client.patch(
        f"/api/scheduled-meetings/{seeded['meeting_id']}",
        json={"at": (NOW + timedelta(days=1)).isoformat()},
    )
    assert response.status_code == 400


def test_renaming_a_held_meeting_is_still_allowed(client: TestClient, seeded):
    """이름은 사람이 붙이는 것이라 나중에 고쳐도 사실이 안 바뀝니다."""
    response = client.patch(
        f"/api/scheduled-meetings/{seeded['meeting_id']}", json={"title": "9월 1일 킥오프"}
    )
    assert response.status_code == 200
    assert response.json()["title"] == "9월 1일 킥오프"


def test_cancelling_only_works_before_it_is_opened(client: TestClient, seeded):
    """⭐ 연 회의에는 동의 기록과 트랙이 딸려 있습니다."""
    meeting_id = client.post(
        f"/api/projects/{seeded['project_id']}/scheduled-meetings",
        json={"title": "무를 회의", "at": (NOW + timedelta(days=3)).isoformat()},
    ).json()["meeting_id"]

    assert client.delete(f"/api/scheduled-meetings/{meeting_id}").status_code == 204
    assert client.delete(f"/api/scheduled-meetings/{seeded['meeting_id']}").status_code == 400
