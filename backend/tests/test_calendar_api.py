"""일정 (요구사항 정의서 §16 CALENDAR-001~005).

⚠️ 여기서 제일 중요한 것은 **달력이 베낀 자료를 안 본다**는 것입니다.
업무 마감일을 고치면 달력이 **그 자리에서** 따라와야 합니다 — 안 따라오면
두 벌이 있다는 뜻이고, 그건 이 저장소가 반복해서 당한 실패 ② 입니다.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

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


def test_a_range_without_a_timezone_is_answered_not_crashed(
    client: TestClient, seeded, dated_task
):
    """⭐ 시간대 없이 온 범위에 **500 을 주면 안 됩니다** (결함 330).

    ## 왜 이 검사가 생겼나

    `collect()` 는 DB 에서 읽은 값만 `clock.as_utc` 로 맞추고 **요청으로 들어온
    `since`·`until` 은 그대로** 썼습니다. 그래서 시간대가 안 붙은 요청이
    비교에서 터졌습니다:

        GET /api/projects/1/calendar?since=2026-09-01&until=2026-09-30
        → 500  TypeError: can't compare offset-naive and offset-aware datetimes

    `as_utc` 의 docstring 이 **인용해 둔 바로 그 오류**입니다. 막으려고 만든
    함수를 **한쪽 피연산자에만** 걸어 둔 것입니다.

    ⚠️ **아무도 안 재고 있던 이유**: 이 파일의 `window()` 도 화면도 언제나
    `+00:00`/`Z` 를 붙여 보냅니다. 씨앗이 한 갈래만 만들면 다른 갈래는
    영영 안 그려집니다.

    ⚠️ 저장은 UTC 라는 것이 이 저장소의 규약이므로(`clock.as_utc`), 시간대가
    없는 값은 **UTC 로 읽는 것이 맞습니다** — 400 으로 거절하는 것이 아니라
    같은 답을 줘야 합니다.
    """
    aware = client.get(
        f"/api/projects/{seeded['project_id']}/calendar", params=window()
    )
    assert aware.status_code == 200, aware.text

    naive = client.get(
        f"/api/projects/{seeded['project_id']}/calendar",
        params={
            "since": (NOW - timedelta(days=30)).replace(tzinfo=None).isoformat(),
            "until": (NOW + timedelta(days=30)).replace(tzinfo=None).isoformat(),
        },
    )
    assert naive.status_code == 200, naive.text
    assert naive.json() == aware.json(), (
        "시간대만 뺐는데 답이 달라졌습니다 — 저장이 UTC 라는 규약과 어긋납니다"
    )
    assert [i["task_id"] for i in naive.json() if i["task_id"] == dated_task], (
        "범위 안의 업무가 안 나옵니다 — 이 검사가 헛돕니다"
    )


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


# ══════════════════════════════════════════════════════════════
# 일정을 잡아도 회의 목록이 살아 있어야 한다 (결함 287)
# ══════════════════════════════════════════════════════════════


def test_scheduling_a_meeting_does_not_break_the_meeting_list(
    client: TestClient, seeded
):
    """⭐ 일정을 **하나** 잡았다고 회의 목록이 통째로 죽으면 안 된다.

    ``MeetingSummary.started_at`` 이 비어 있을 수 없게 잡혀 있어서, 달력에서
    「회의 일정 잡기」를 한 번 누르는 순간 이 목록이 **500** 이 됐습니다.
    화면은 그 500 을 「회의를 열면 여기에 나옵니다」로 그렸습니다 — 회의
    다섯이 멀쩡히 있는 팀에서 다섯이 전부 사라진 것입니다.

    ⚠️ 씨앗 데이터에는 예정 회의가 **하나도 없어서** 여태 안 들켰습니다.
    """
    project_id = seeded["project_id"]
    before = client.get(f"/api/projects/{project_id}/meetings")
    assert before.status_code == 200
    held = len(before.json())
    assert held > 0, "씨앗에 회의가 없으면 이 검사는 아무것도 안 잽니다"

    made = client.post(
        f"/api/projects/{project_id}/scheduled-meetings",
        json={"title": "앞으로 할 회의", "at": (NOW + timedelta(days=7)).isoformat()},
    )
    assert made.status_code == 201

    after = client.get(f"/api/projects/{project_id}/meetings")
    assert after.status_code == 200, "일정을 잡았더니 회의 목록이 죽었습니다"
    rows = after.json()
    assert len(rows) == held + 1, "예정 회의가 목록에서 사라졌습니다"

    planned = next(r for r in rows if r["title"] == "앞으로 할 회의")
    # ⛔ 시작하지 않은 회의에 시각을 **지어 넣지 않습니다**.
    assert planned["started_at"] is None
    assert planned["scheduled_at"] is not None
    # 이미 연 회의는 그 반대입니다 — 두 칸이 서로를 배타로 말합니다.
    opened = next(r for r in rows if r["title"] != "앞으로 할 회의")
    assert opened["started_at"] is not None


def test_the_lobby_of_a_planned_meeting_opens(client: TestClient, seeded):
    """⭐ 잡아 둔 회의의 로비가 **열려야** 한다.

    달력이 그 회의를 로비로 이어 주는데, ``MeetingDetail.started_at`` 도
    비어 있을 수 없게 잡혀 있어 여기서도 500 이 났습니다.
    """
    made = client.post(
        f"/api/projects/{seeded['project_id']}/scheduled-meetings",
        json={"title": "앞으로 할 회의", "at": (NOW + timedelta(days=7)).isoformat()},
    ).json()
    got = client.get(f"/api/meetings/{made['meeting_id']}")
    assert got.status_code == 200, "잡아 둔 회의의 로비가 500 입니다"
    assert got.json()["started_at"] is None
    assert got.json()["scheduled_at"] is not None


def test_planned_and_held_meetings_share_one_timeline(client: TestClient, seeded):
    """⚠️ 안 연 회의는 `started_at` 이 없으니 **잡아 둔 시각**으로 줄을 선다.

    그것만으로 정렬하면 예정 회의가 NULL 자리에 몰려 시간 감각이 깨집니다.
    """
    project_id = seeded["project_id"]
    client.post(
        f"/api/projects/{project_id}/scheduled-meetings",
        json={"title": "아주 나중 회의", "at": (NOW + timedelta(days=365)).isoformat()},
    )
    rows = client.get(f"/api/projects/{project_id}/meetings").json()
    # 제일 나중 것이 맨 위 (최근 것부터).
    assert rows[0]["title"] == "아주 나중 회의"


def test_undoing_a_schedule_takes_its_minutes_with_it(client: TestClient, seeded):
    """⭐ 일정을 무르면 **그 회의로 만든 회의록도** 사라진다 (결함 359).

    `cancel_meeting` 은 「행을 지우면 그것들이 허공에 뜹니다」라고 적어 두고
    **연** 회의를 막았습니다. 그런데 안 연 회의에도 딸리는 것이 하나
    있었습니다 — 로비의 「회의록 만들기」는 잡아만 둔 회의에도 있습니다.

    무르면 회의는 홈·레일·달력에서 사라지는데 그 회의록만 보고서 목록에
    남았고, **지울 방법이 저장소 어디에도 없었습니다**(`reports` 에 DELETE
    갈래가 0곳). 재서 확인했습니다.
    """
    project_id = seeded["project_id"]
    made = client.post(
        f"/api/projects/{project_id}/scheduled-meetings",
        json={"title": "잘못 잡은 회의", "at": (NOW + timedelta(days=3)).isoformat()},
    )
    assert made.status_code == 201, made.text
    meeting_id = made.json()["meeting_id"]

    minutes = client.post(f"/api/meetings/{meeting_id}/minutes")
    assert minutes.status_code == 201, minutes.text

    # ⚠️ **만들어진 것을 먼저 확인합니다.** 안 하면 「지웠더니 없다」가
    #    「애초에 없었다」와 구별되지 않습니다.
    before = client.get(f"/api/projects/{project_id}/reports").json()
    assert any(r["meeting_id"] == meeting_id for r in before), (
        f"회의록이 안 만들어졌습니다 — 이 검사는 아무것도 안 재고 있습니다: {before}"
    )

    assert client.delete(f"/api/scheduled-meetings/{meeting_id}").status_code == 204

    after = client.get(f"/api/projects/{project_id}/reports").json()
    assert not any(r["meeting_id"] == meeting_id for r in after), (
        f"무른 회의의 회의록이 목록에 남았습니다 — 지울 방법이 없습니다: {after}"
    )


def test_no_report_points_at_a_meeting_that_is_gone(client: TestClient, seeded):
    """⭐ **요구**를 잽니다 — 보고서가 가리키는 회의는 반드시 있다.

    위 검사는 「무르기」 한 갈래만 봅니다. 회의 행이 사라지는 길이 하나 더
    생기면 그 자는 눈을 감습니다 — 그래서 남는 쪽을 직접 셉니다.
    """
    project_id = seeded["project_id"]
    # 살아남는 회의록 하나 — 없으면 아래 「고아 0건」이 거저 참입니다.
    client.post(f"/api/meetings/{seeded['meeting_id']}/minutes")

    made = client.post(
        f"/api/projects/{project_id}/scheduled-meetings",
        json={"title": "무를 회의", "at": (NOW + timedelta(days=4)).isoformat()},
    )
    meeting_id = made.json()["meeting_id"]
    client.post(f"/api/meetings/{meeting_id}/minutes")
    client.delete(f"/api/scheduled-meetings/{meeting_id}")

    with db_session.session_scope() as s:
        live_ids = set(s.scalars(select(m.Meeting.id)).all())
        pointing = [
            (r.id, r.meeting_id)
            for r in s.scalars(select(m.Report))
            if r.meeting_id is not None
        ]
        # ⚠️ **가리키는 보고서가 하나는 있어야** 이 검사가 뜻을 갖습니다.
        #    전부 지워 버리면 「고아 0건」은 거저 참입니다.
        assert pointing, "회의를 가리키는 보고서가 하나도 없습니다 — 아무것도 안 재고 있습니다"
        orphans = [(rid, mid) for rid, mid in pointing if mid not in live_ids]
        assert not orphans, f"없는 회의를 가리키는 보고서가 있습니다: {orphans}"
