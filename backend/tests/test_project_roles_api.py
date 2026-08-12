"""권한 3단계·팀원 관리·나가기·업무 삭제 (정의서 §5 · §15).

⚠️ `test_project_permissions.py` 는 표를 잽니다. 이 파일은 **배선**을
잽니다 — 표에 적힌 것이 실제로 문을 막는가.

⚠️ 이 구분이 중요합니다. 표만 맞고 엔드포인트가 안 물으면 권한은
**주석과 같습니다.** 이 저장소가 여러 번 당한 대표 실패 ① 이고,
권한에서 그러면 그건 열려 있는 것입니다.
"""

from __future__ import annotations

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


def join(client: TestClient, code: str) -> None:
    assert client.post("/api/projects/join", json={"invite_code": code}).status_code == 200


@pytest.fixture
def team(client: TestClient, people: dict) -> dict:
    """소유자 하나 + 코드로 들어온 팀원 하나."""
    login_as(client, people["founder"])
    created = create_project(client)
    login_as(client, people["joiner"])
    join(client, created["invite_code"])
    login_as(client, people["founder"])
    return {"project_id": created["project_id"], **people}


def role_of(project_id: int, user_id: int) -> str:
    with db_session.session_scope() as s:
        member = (
            s.query(m.Member)
            .filter(m.Member.project_id == project_id, m.Member.user_id == user_id)
            .one()
        )
        return member.project_role


# ══════════════════════════════════════════════════════════════
# 누가 무엇이 되는가
# ══════════════════════════════════════════════════════════════


def test_the_one_who_creates_it_is_the_owner(client: TestClient, team: dict):
    """⭐ 안 그러면 **주인 없는 프로젝트**가 됩니다.

    만든 사람이 기본값(`member`)이면 자기 프로젝트 설정을 자기가 못
    고치고, 소유자가 0명이라 아무도 못 고칩니다.
    """
    assert role_of(team["project_id"], team["founder"]) == "owner"


def test_someone_who_joins_by_code_is_a_plain_member(client: TestClient, team: dict):
    """⭐ 초대 코드만 알면 들어올 수 있습니다.

    기본이 그보다 크면 **코드가 새는 순간 팀이 열립니다.**
    """
    assert role_of(team["project_id"], team["joiner"]) == "member"


def test_the_member_list_says_who_is_what(client: TestClient, team: dict):
    rows = client.get(f"/api/projects/{team['project_id']}/members").json()
    by_id = {r["user_id"]: r["project_role"] for r in rows}
    assert by_id[team["founder"]] == "owner"
    assert by_id[team["joiner"]] == "member"


# ══════════════════════════════════════════════════════════════
# ⭐ 문이 실제로 막히는가
# ══════════════════════════════════════════════════════════════


def test_a_plain_member_cannot_rename_the_project(client: TestClient, team: dict):
    """⭐ 예전에는 **구성원이면 누구나** 이름과 저장소를 바꿨습니다."""
    login_as(client, team["joiner"])
    response = client.patch(
        f"/api/projects/{team['project_id']}", json={"title": "내 맘대로"}
    )
    assert response.status_code == 403


def test_a_plain_member_cannot_rotate_the_invite_code(client: TestClient, team: dict):
    """⭐ 코드를 새로 뽑으면 **옛 코드로 오려던 사람이 전부 막힙니다.**

    구성원이면 누구나 할 수 있게 두면 한 사람이 팀 합류를 끊을 수 있습니다.
    """
    login_as(client, team["joiner"])
    assert (
        client.post(f"/api/projects/{team['project_id']}/invite/rotate").status_code
        == 403
    )


def test_the_owner_still_can(client: TestClient, team: dict):
    assert (
        client.patch(
            f"/api/projects/{team['project_id']}", json={"title": "새 이름"}
        ).status_code
        == 200
    )
    assert (
        client.post(f"/api/projects/{team['project_id']}/invite/rotate").status_code
        == 200
    )


# ══════════════════════════════════════════════════════════════
# 권한 바꾸기
# ══════════════════════════════════════════════════════════════


def test_the_owner_can_promote_someone_to_admin(client: TestClient, team: dict):
    response = client.patch(
        f"/api/projects/{team['project_id']}/members/{team['joiner']}/role",
        json={"project_role": "admin"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["project_role"] == "admin"


def test_a_plain_member_cannot_promote_anyone(client: TestClient, team: dict):
    login_as(client, team["joiner"])
    assert (
        client.patch(
            f"/api/projects/{team['project_id']}/members/{team['founder']}/role",
            json={"project_role": "member"},
        ).status_code
        == 403
    )


def test_nobody_promotes_themselves(client: TestClient, team: dict):
    """⭐ 막지 않으면 권한 3단계가 **장식**입니다."""
    client.patch(
        f"/api/projects/{team['project_id']}/members/{team['joiner']}/role",
        json={"project_role": "admin"},
    )
    login_as(client, team["joiner"])
    response = client.patch(
        f"/api/projects/{team['project_id']}/members/{team['joiner']}/role",
        json={"project_role": "owner"},
    )
    assert response.status_code == 403
    assert role_of(team["project_id"], team["joiner"]) == "admin"


def test_an_admin_cannot_give_away_more_than_they_have(client: TestClient, team: dict):
    """⭐ 안 막으면 관리자가 팀원을 소유자로 만들어 놓고 **그 사람을 통해**
    자기를 올릴 수 있습니다."""
    client.patch(
        f"/api/projects/{team['project_id']}/members/{team['joiner']}/role",
        json={"project_role": "admin"},
    )
    with db_session.session_scope() as s:
        third = m.User(name="박지원", email="jiwon-roles@example.com")
        s.add(third)
        s.flush()
        third_id = third.id
        s.add(
            m.Member(
                project_id=team["project_id"],
                user_id=third_id,
                role_shares={"developer": 1.0},
            )
        )

    login_as(client, team["joiner"])  # 관리자
    response = client.patch(
        f"/api/projects/{team['project_id']}/members/{third_id}/role",
        json={"project_role": "owner"},
    )
    assert response.status_code == 403
    assert role_of(team["project_id"], third_id) == "member"


def test_an_unknown_role_is_refused(client: TestClient, team: dict):
    assert (
        client.patch(
            f"/api/projects/{team['project_id']}/members/{team['joiner']}/role",
            json={"project_role": "superuser"},
        ).status_code
        == 400
    )
    assert role_of(team["project_id"], team["joiner"]) == "member"


# ══════════════════════════════════════════════════════════════
# 내보내기 · 나가기
# ══════════════════════════════════════════════════════════════


def test_the_owner_can_remove_a_member(client: TestClient, team: dict):
    response = client.delete(
        f"/api/projects/{team['project_id']}/members/{team['joiner']}"
    )
    assert response.status_code == 204
    login_as(client, team["joiner"])
    assert client.get(f"/api/projects/{team['project_id']}").status_code == 403


def test_a_plain_member_cannot_remove_anyone(client: TestClient, team: dict):
    login_as(client, team["joiner"])
    assert (
        client.delete(
            f"/api/projects/{team['project_id']}/members/{team['founder']}"
        ).status_code
        == 403
    )


def test_removing_someone_keeps_what_they_did(client: TestClient, team: dict):
    """⭐ **한 일은 안 지웁니다.**

    나갔다고 그 사람이 한 일이 없던 일이 되면 남은 팀의 기여도 비율이
    조용히 부풀고 회의록에 구멍이 납니다. 지우는 것은 본인이 요청할 때
    `POST /me/data` 가 따로 합니다 — 그건 **동의 철회**라는 다른 일입니다.
    """
    with db_session.session_scope() as s:
        s.add(
            m.Task(
                project_id=team["project_id"],
                title="하늘이 만든 업무",
                assignee_id=team["joiner"],
                status="todo",
                priority=2,
            )
        )

    client.delete(f"/api/projects/{team['project_id']}/members/{team['joiner']}")

    with db_session.session_scope() as s:
        kept = s.query(m.Task).filter(m.Task.assignee_id == team["joiner"]).count()
    assert kept == 1


def test_leaving_does_not_need_permission(client: TestClient, team: dict):
    """⭐ 나가는 것은 **자기 일**입니다. 관리자 허락을 받아야 하면 팀이 아닙니다."""
    login_as(client, team["joiner"])
    assert (
        client.post(
            f"/api/projects/{team['project_id']}/members/me/leave"
        ).status_code
        == 204
    )
    assert client.get(f"/api/projects/{team['project_id']}").status_code == 403


def test_the_last_owner_cannot_leave(client: TestClient, team: dict):
    """⭐ 나가면 **아무도 팀원을 못 다루는** 프로젝트가 남습니다."""
    response = client.post(f"/api/projects/{team['project_id']}/members/me/leave")
    assert response.status_code == 409
    assert "마지막 소유자" in response.json()["detail"]


def test_the_owner_can_leave_after_handing_it_over(client: TestClient, team: dict):
    """넘긴 뒤에는 나갈 수 있어야 합니다 — 아니면 영영 못 나갑니다."""
    with db_session.session_scope() as s:
        member = (
            s.query(m.Member)
            .filter(
                m.Member.project_id == team["project_id"],
                m.Member.user_id == team["joiner"],
            )
            .one()
        )
        member.project_role = "owner"

    assert (
        client.post(
            f"/api/projects/{team['project_id']}/members/me/leave"
        ).status_code
        == 204
    )


def test_you_cannot_remove_yourself_through_the_other_door(
    client: TestClient, team: dict
):
    assert (
        client.delete(
            f"/api/projects/{team['project_id']}/members/{team['founder']}"
        ).status_code
        == 400
    )


# ══════════════════════════════════════════════════════════════
# 업무 삭제 (`TASK-003`)
# ══════════════════════════════════════════════════════════════


@pytest.fixture
def a_task(team: dict) -> int:
    with db_session.session_scope() as s:
        task = m.Task(
            project_id=team["project_id"],
            title="지워질 업무",
            assignee_id=team["founder"],
            status="todo",
            priority=2,
        )
        s.add(task)
        s.flush()
        return task.id


def test_a_plain_member_can_delete_a_task(client: TestClient, team: dict, a_task: int):
    """⭐ 관리자만 지울 수 있으면 사람들은 지우는 대신 **완료로 옮깁니다.**

    그러면 진행률이 거짓이 되고 그 숫자가 기여도와 보고서로 흘러갑니다.
    """
    login_as(client, team["joiner"])
    response = client.delete(
        f"/api/projects/{team['project_id']}/tasks/{a_task}"
    )
    assert response.status_code == 204


def test_a_deleted_task_leaves_the_board(client: TestClient, team: dict, a_task: int):
    client.delete(f"/api/projects/{team['project_id']}/tasks/{a_task}")
    board = client.get(f"/api/projects/{team['project_id']}/tasks").json()
    assert a_task not in [t["task_id"] for t in board["tasks"]]


def test_the_row_stays_so_evidence_still_points_somewhere(
    client: TestClient, team: dict, a_task: int
):
    """⭐ **행을 안 지웁니다.**

    기여 이벤트·PR 연결·회의 후보가 이 업무를 가리킵니다. 진짜로 지우면
    화면의 `근거 업무 #7` 이 빈손이 됩니다 (대표 실패 ③).
    """
    client.delete(f"/api/projects/{team['project_id']}/tasks/{a_task}")
    with db_session.session_scope() as s:
        row = s.get(m.Task, a_task)
        assert row is not None
        assert row.deleted_at is not None


def test_a_deleted_task_leaves_the_progress_count(
    client: TestClient, team: dict, a_task: int
):
    """⭐ 지운 업무가 진행률에 남아 있으면 **완료율이 조용히 낮아집니다.**"""
    before = client.get(f"/api/projects/{team['project_id']}/analytics").json()
    client.delete(f"/api/projects/{team['project_id']}/tasks/{a_task}")
    after = client.get(f"/api/projects/{team['project_id']}/analytics").json()
    assert after["progress"]["total"] == before["progress"]["total"] - 1


def test_deleting_twice_is_not_an_error(client: TestClient, team: dict, a_task: int):
    """이미 지워진 게 원하던 결과입니다."""
    path = f"/api/projects/{team['project_id']}/tasks/{a_task}"
    assert client.delete(path).status_code == 204
    assert client.delete(path).status_code == 204


def test_someone_outside_the_project_cannot_delete(
    client: TestClient, team: dict, a_task: int
):
    login_as(client, team["stranger"])
    assert (
        client.delete(
            f"/api/projects/{team['project_id']}/tasks/{a_task}"
        ).status_code
        == 403
    )


def test_the_deletion_is_written_down(client: TestClient, team: dict, a_task: int):
    """⭐ 안 남기면 카드가 조용히 사라지고 **누가 지웠는지** 모릅니다."""
    client.delete(f"/api/projects/{team['project_id']}/tasks/{a_task}")
    with db_session.session_scope() as s:
        logged = (
            s.query(m.AuditLog)
            .filter(m.AuditLog.action == "task_deleted")
            .one()
        )
        assert logged.actor_id == team["founder"]
        assert logged.target == f"task:{a_task}"
