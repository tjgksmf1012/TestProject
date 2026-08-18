"""사용자 상태가 화면까지 오는가 (정의서 §4 `USER-005`).

⚠️ `test_presence.py` 는 순수 함수를 잽니다. 이 파일은 **경계**를 잽니다 —
서버가 무엇을 주고, 무엇을 **안 주는가.**

⚠️ 안 주는 쪽이 더 중요합니다. 상태 표시는 감시로 넘어가기 제일 쉬운
기능이고, 넘어간 뒤에는 화면에서 못 되돌립니다.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from teamflow.db import models as m
from teamflow.db import session as db_session

from .conftest import login_as
from .test_project_setup import (  # noqa: F401  (픽스처)
    client,
    create_project,
    engine,
    people,
)


@pytest.fixture
def team(client: TestClient, people: dict) -> dict:
    login_as(client, people["founder"])
    created = create_project(client)
    login_as(client, people["joiner"])
    assert (
        client.post(
            "/api/projects/join", json={"invite_code": created["invite_code"]}
        ).status_code
        == 200
    )
    login_as(client, people["founder"])
    return {"project_id": created["project_id"], **people}


def members(client: TestClient, project_id: int) -> dict[int, str]:
    rows = client.get(f"/api/projects/{project_id}/members").json()
    return {r["user_id"]: r["presence"] for r in rows}


def test_the_one_making_requests_is_online(client: TestClient, team: dict):
    assert members(client, team["project_id"])[team["founder"]] == "online"


def test_someone_who_has_gone_quiet_is_offline(client: TestClient, team: dict):
    """⚠️ **과거를 말하지 않습니다** — `마지막 접속 3일 전` 은 근태 기록입니다."""
    with db_session.session_scope() as s:
        for row in (
            s.query(m.UserSession).filter(m.UserSession.user_id == team["joiner"]).all()
        ):
            row.last_seen_at = datetime.now(UTC) - timedelta(days=3)

    assert members(client, team["project_id"])[team["joiner"]] == "offline"


def test_being_in_a_meeting_wins(client: TestClient, team: dict):
    """⭐ 회의 화면은 요청을 자주 안 보냅니다 — 시간만 보면 자리 비움으로 뜹니다."""
    with db_session.session_scope() as s:
        meeting = m.Meeting(
            project_id=team["project_id"],
            title="지금 하는 회의",
            started_by=team["founder"],
        )
        s.add(meeting)
        s.flush()
        s.add(
            m.MeetingTrack(
                meeting_id=meeting.id,
                user_id=team["joiner"],
                started_at=datetime.now(UTC) - timedelta(hours=2),
                ended_at=None,
            )
        )
        for row in (
            s.query(m.UserSession).filter(m.UserSession.user_id == team["joiner"]).all()
        ):
            row.last_seen_at = datetime.now(UTC) - timedelta(hours=2)

    assert members(client, team["project_id"])[team["joiner"]] == "in_meeting"


def test_a_finished_meeting_does_not_keep_someone_in_it(
    client: TestClient, team: dict
):
    """⭐ 끝난 트랙이 계속 회의 중으로 남으면 **표시가 영영 안 내려갑니다.**"""
    with db_session.session_scope() as s:
        meeting = m.Meeting(
            project_id=team["project_id"],
            title="끝난 회의",
            started_by=team["founder"],
        )
        s.add(meeting)
        s.flush()
        s.add(
            m.MeetingTrack(
                meeting_id=meeting.id,
                user_id=team["joiner"],
                started_at=datetime.now(UTC) - timedelta(hours=3),
                ended_at=datetime.now(UTC) - timedelta(hours=2),
            )
        )

    assert members(client, team["project_id"])[team["joiner"]] != "in_meeting"


# ══════════════════════════════════════════════════════════════
# ⭐ 여기서부터가 진짜 요구
# ══════════════════════════════════════════════════════════════


def test_nothing_is_stored(client: TestClient, team: dict):
    """⭐ 상태를 **행으로 쌓지 않습니다.**

    쌓으면 그 표는 곧 출퇴근부가 됩니다. 이 제품은 기여를 "무엇을
    했는가" 로 재기로 했는데, 옆에 "언제 앉아 있었는가" 가 쌓이면 사람은
    그 둘을 같이 봅니다 — 늦게 접속하는 사람이 일을 덜 한 것으로 읽히고,
    실제로는 아무 관계가 없습니다.
    """
    members(client, team["project_id"])
    members(client, team["project_id"])

    tables = set(m.Base.metadata.tables)
    for banned in ("presence", "user_presence", "presence_log", "attendance"):
        assert banned not in tables, f"상태를 쌓는 표가 생겼습니다: {banned}"


def test_the_server_never_sends_a_timestamp(client: TestClient, team: dict):
    """⭐ **언제 마지막으로 있었는지를 안 보냅니다.**

    보내면 화면이 `마지막 접속 3일 전` 을 그릴 수 있고, 그 순간 이것은
    상태 표시가 아니라 **근태 기록**이 됩니다. 눈금을 굵게 잡은 이유가
    사라집니다.
    """
    rows = client.get(f"/api/projects/{team['project_id']}/members").json()
    for row in rows:
        for key in row:
            assert "seen" not in key, f"마지막 접속 시각이 나갑니다: {key}"
            assert "last" not in key, f"마지막 접속 시각이 나갑니다: {key}"


def test_presence_is_one_of_the_four_words(client: TestClient, team: dict):
    allowed = {"online", "away", "offline", "in_meeting"}
    for value in members(client, team["project_id"]).values():
        assert value in allowed, value


def test_presence_never_reaches_contribution(client: TestClient, team: dict):
    """⭐ **접속 시간은 점수가 아닙니다.**

    기여도 코드가 `last_seen_at` 을 읽기 시작하면 오래 켜 둔 사람이
    점수를 받습니다. 그건 이 저장소가 조작 통로라고 부르는 것입니다.
    """
    from pathlib import Path

    root = Path(__file__).resolve().parents[2] / "backend" / "teamflow" / "contribution"
    for path in root.rglob("*.py"):
        body = path.read_text(encoding="utf-8")
        assert "last_seen" not in body, f"{path.name} 이 접속 시각을 읽습니다"
        assert "presence" not in body, f"{path.name} 이 상태를 읽습니다"


def test_someone_outside_the_project_sees_nothing(client: TestClient, team: dict):
    """⭐ 누가 지금 앉아 있는지는 **팀 내부 자료**입니다."""
    login_as(client, team["stranger"])
    assert (
        client.get(f"/api/projects/{team['project_id']}/members").status_code == 403
    )
