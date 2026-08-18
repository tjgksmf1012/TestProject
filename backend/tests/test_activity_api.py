"""활동 기록 (요구사항 정의서 §21 ACTIVITY-001).

⚠️ 이 표는 **쓰는 곳이 열한 곳이고 읽는 곳이 0곳**이던 자리입니다. 이
파일이 그 반대쪽을 지킵니다.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.services import activity_service

from .conftest import login_as
from .test_api import client, engine, seeded  # noqa: F401  (픽스처)


def plant(seeded, action: str, *, actor: int | None = 0) -> None:
    with db_session.session_scope() as session:
        session.add(
            m.AuditLog(
                project_id=seeded["project_id"],
                actor_id=None if actor is None else seeded["user_ids"][actor],
                action=action,
                target="members/1",
                before={"role_shares": {"developer": 1.0}},
                after={"role_shares": {"developer": 0.5}},
            )
        )


def test_the_log_is_readable_at_all(client: TestClient, seeded):
    """⭐ 이게 없던 동안 열한 곳이 쌓기만 하고 있었습니다."""
    plant(seeded, "weights_changed")
    rows = client.get(f"/api/projects/{seeded['project_id']}/activity").json()
    assert len(rows) == 1
    assert rows[0]["label"] == "역할 비중 변경"
    assert rows[0]["who"] == "김민수"


def test_contribution_touching_actions_are_marked(client: TestClient, seeded):
    """⭐ 분쟁에서 제일 먼저 볼 기록을 화면이 알아볼 수 있어야 합니다."""
    plant(seeded, "weights_changed")
    plant(seeded, "task_completed")
    rows = client.get(f"/api/projects/{seeded['project_id']}/activity").json()
    marked = {r["action"]: r["touches_contribution"] for r in rows}
    assert marked == {"weights_changed": True, "task_completed": False}


def test_newest_first(client: TestClient, seeded):
    """⚠️ 오래된 것부터 두면 방금 일어난 일이 아래로 밀립니다."""
    plant(seeded, "task_completed")
    plant(seeded, "task_reopened")
    rows = client.get(f"/api/projects/{seeded['project_id']}/activity").json()
    assert [r["action"] for r in rows] == ["task_reopened", "task_completed"]


def test_a_system_action_has_no_person(client: TestClient, seeded):
    """보존기간 만료 삭제처럼 사람이 없는 기록이 있습니다.

    ⚠️ 서비스는 `None` 을 그대로 줍니다 — "알 수 없음" 같은 글자를 여기서
    만들면 그 말이 화면과 두 벌이 됩니다.
    """
    plant(seeded, "audio_deleted", actor=None)
    rows = client.get(f"/api/projects/{seeded['project_id']}/activity").json()
    assert rows[0]["who"] is None


def test_an_unknown_action_is_not_invented(client: TestClient, seeded):
    """⚠️ 감사 기록에서 그럴듯한 오역은 특히 나쁩니다."""
    assert activity_service.describe("deploy_rolled_back") == "deploy_rolled_back"


def test_someone_outside_the_project_cannot_read_it(client: TestClient, seeded):
    """⭐ 감사 기록에는 누가 무엇을 고쳤는지가 그대로 있습니다."""
    plant(seeded, "score_adjusted")
    with db_session.session_scope() as session:
        outsider = m.User(name="남남", email="stranger@example.com")
        session.add(outsider)
        session.flush()
        outsider_id = outsider.id
    login_as(client, outsider_id)
    assert client.get(f"/api/projects/{seeded['project_id']}/activity").status_code == 403


def test_the_service_has_no_way_to_change_a_record():
    """⭐ 고칠 수 있으면 감사 기록의 목적이 통째로 사라집니다."""
    forbidden = [
        name
        for name in dir(activity_service)
        if any(word in name for word in ("delete", "update", "edit", "remove", "write"))
    ]
    assert forbidden == []
