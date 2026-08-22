"""활동 기록 (요구사항 정의서 §21 ACTIVITY-001).

⚠️ 이 표는 **쓰는 곳이 열한 곳이고 읽는 곳이 0곳**이던 자리입니다. 이
파일이 그 반대쪽을 지킵니다.
"""

from __future__ import annotations

from datetime import UTC, datetime

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


# ══════════════════════════════════════════════════════════════
# 「무엇을」 바꿨는지가 사람 말이어야 한다 (결함 293)
# ══════════════════════════════════════════════════════════════


def plant_target(seeded, action: str, target: str) -> None:
    with db_session.session_scope() as session:
        session.add(
            m.AuditLog(
                project_id=seeded["project_id"],
                actor_id=seeded["user_ids"][0],
                action=action,
                target=target,
                before={},
                after={},
            )
        )


def test_the_log_says_what_was_changed_not_its_id(client: TestClient, seeded):
    """⭐ 화면이 스스로 「누가 언제 **무엇을** 바꿨는지」라고 적어 둡니다.

    「누가」와 「언제」는 맞는데 「무엇」만 `task:4` 였습니다 — 그 업무 이름은
    「접근성 점검」입니다. 감사 기록은 사람의 숫자를 건드린 일을 **읽으라고**
    있는 화면이라, 거기서 식별자를 보여 주면 읽을 수가 없습니다.
    """
    project_id = seeded["project_id"]
    with db_session.session_scope() as session:
        task = m.Task(project_id=project_id, title="접근성 점검", status="todo")
        session.add(task)
        session.flush()
        task_id = task.id
    plant_target(seeded, "task_completed", f"task:{task_id}")

    rows = client.get(f"/api/projects/{project_id}/activity").json()
    assert rows[0]["target_label"] == "접근성 점검"
    # ⚠️ 참조는 **그대로 남습니다** — 감사 기록이라 가리키는 자리가 안 변해야 합니다.
    assert rows[0]["target"] == f"task:{task_id}"


def test_a_member_target_reads_as_a_person(client: TestClient, seeded):
    """⭐ `members/1` 은 「김민수」입니다.

    ⚠️ **`/` 와 `:` 를 둘 다 씁니다** — `members/1` · `task:4`. 한 구분자만
    보면 절반을 못 읽습니다.
    """
    plant_target(seeded, "weights_changed", f"members/{seeded['user_ids'][0]}")
    rows = client.get(f"/api/projects/{seeded['project_id']}/activity").json()
    assert rows[0]["target_label"] == "김민수"


def test_a_meeting_target_uses_the_one_naming(client: TestClient, seeded):
    """⭐ 회의 이름은 한 벌에서 옵니다 (결함 285) — 제목이 없어도 부릅니다."""
    project_id = seeded["project_id"]
    with db_session.session_scope() as session:
        meeting = m.Meeting(
            project_id=project_id,
            title=None,
            status="pending",
            started_by=seeded["user_ids"][0],
        )
        session.add(meeting)
        session.flush()
        meeting_id = meeting.id
    plant_target(seeded, "meeting_reprocessed", f"meetings/{meeting_id}")

    rows = client.get(f"/api/projects/{project_id}/activity").json()
    assert rows[0]["target_label"] == f"제목 없는 회의 #{meeting_id}"


def test_an_unresolvable_target_is_not_invented(client: TestClient, seeded):
    """⚠️ 지운 업무·모르는 종류는 **그대로** 둡니다.

    「(없음)」 같은 말을 지어내면 그건 감사 기록에서 제일 나쁜 짓입니다 —
    `describe_category`·`role_label` 과 같은 규칙입니다.
    """
    plant_target(seeded, "task_completed", "task:999999")
    plant_target(seeded, "task_completed", "무슨소린지모를값")
    rows = client.get(f"/api/projects/{seeded['project_id']}/activity").json()
    labels = {r["target"]: r["target_label"] for r in rows}
    assert labels["task:999999"] == "task:999999"
    assert labels["무슨소린지모를값"] == "무슨소린지모를값"


def test_the_log_does_not_query_once_per_row(client: TestClient, seeded):
    """⚠️ 줄마다 질의하면 기록이 쌓일수록 이 화면이 느려집니다.

    `_target_labels` 가 종류별로 **한 번씩만** 찾는지 봅니다 — 같은 업무를
    스무 번 건드린 기록이 있어도 질의는 하나입니다.
    """
    project_id = seeded["project_id"]
    with db_session.session_scope() as session:
        task = m.Task(project_id=project_id, title="여러 번 건드린 업무", status="todo")
        session.add(task)
        session.flush()
        task_id = task.id
    for _ in range(20):
        plant_target(seeded, "task_completed", f"task:{task_id}")

    with db_session.session_scope() as session:
        seen: list[str] = []
        from sqlalchemy import event

        engine_ = session.get_bind()

        def _watch(conn, cursor, statement, *rest):
            if "FROM tasks" in statement:
                seen.append(statement)

        event.listen(engine_, "before_cursor_execute", _watch)
        try:
            entries = activity_service.recent(session, project_id)
        finally:
            event.remove(engine_, "before_cursor_execute", _watch)

    assert len(entries) >= 20
    assert all(e.target_label == "여러 번 건드린 업무" for e in entries[:20])
    assert len(seen) <= 1, f"업무를 {len(seen)}번 찾았습니다 — 줄마다 질의합니다"


def test_a_deleted_task_does_not_come_back_by_name(client: TestClient, seeded):
    """⭐ 지운 업무의 이름은 **되살아나지 않습니다** (`TASK-003`).

    이름을 못 찾으면 `target` 이 그대로 남고, 그건 「그 업무는 지워졌다」는
    정직한 답입니다. ⚠️ 이 자리를 `db/live.py` 없이 짰다가
    `test_repo_integrity` 가 잡았습니다 — 업무를 읽는 일곱 곳 중 하나가 될
    뻔했습니다.
    """
    project_id = seeded["project_id"]
    with db_session.session_scope() as session:
        task = m.Task(project_id=project_id, title="지울 업무", status="todo")
        session.add(task)
        session.flush()
        task_id = task.id
    plant_target(seeded, "task_completed", f"task:{task_id}")

    rows = client.get(f"/api/projects/{project_id}/activity").json()
    assert rows[0]["target_label"] == "지울 업무"

    with db_session.session_scope() as session:
        from datetime import UTC, datetime

        gone = session.get(m.Task, task_id)
        gone.deleted_at = datetime.now(UTC)

    rows = client.get(f"/api/projects/{project_id}/activity").json()
    assert rows[0]["target_label"] == f"task:{task_id}", "지운 업무의 이름이 되살아났습니다"


# ══════════════════════════════════════════════════════════════
# 씨앗에 없던 종류들 (결함 297)
#
# 결함 293 은 **씨앗 데이터에 있던 넷**만 고쳤습니다. 실제로 「업무 후보
# 승인」을 눌러 보니 다섯째가 식별자 그대로 나왔습니다:
#
#     업무 후보 승인   김민수   meeting_task_candidates/1
#
# ⚠️ 「기능을 한 번 쓰고 *다른* 화면을 다시 열기」 — 제 고침에도 그대로
#    적용됩니다. 씨앗에 없는 상태는 아무도 안 재고 있습니다.
# ══════════════════════════════════════════════════════════════


def test_a_candidate_target_reads_as_its_title(client: TestClient, seeded):
    """⭐ 「업무 후보 승인」이 무엇을 승인했는지 보입니다."""
    project_id = seeded["project_id"]
    with db_session.session_scope() as session:
        meeting = m.Meeting(
            project_id=project_id,
            title="1주차 정기회의",
            status="pending",
            started_by=seeded["user_ids"][0],
        )
        session.add(meeting)
        session.flush()
        candidate = m.MeetingTaskCandidate(
            meeting_id=meeting.id,
            title="로그인 API 구현",
            confidence=0.9,
        )
        session.add(candidate)
        session.flush()
        candidate_id = candidate.id
    plant_target(
        seeded, "candidate_approved", f"meeting_task_candidates/{candidate_id}"
    )

    rows = client.get(f"/api/projects/{project_id}/activity").json()
    assert rows[0]["target_label"] == "로그인 API 구현"
    assert rows[0]["target"] == f"meeting_task_candidates/{candidate_id}"


def test_a_final_contribution_target_names_the_person(client: TestClient, seeded):
    """⭐ `final_contributions/3:7` — **번호가 둘**입니다.

    ⚠️ 하나짜리 자(`^kind[/:]\\d+$`)로는 이 모양을 아예 못 읽습니다. 하필
    「기여도 확정값 조정」 — 분쟁에서 제일 먼저 볼 줄입니다.
    """
    project_id = seeded["project_id"]
    user_id = seeded["user_ids"][0]
    plant_target(seeded, "score_adjusted", f"final_contributions/{project_id}:{user_id}")

    rows = client.get(f"/api/projects/{project_id}/activity").json()
    assert rows[0]["target_label"] == "김민수의 확정 기여도"


def test_a_voiceprint_target_names_whose_it_is(client: TestClient, seeded):
    """⭐ 성문 폐기는 **누구의** 성문인지가 전부입니다."""
    project_id = seeded["project_id"]
    user_id = seeded["user_ids"][0]
    with db_session.session_scope() as session:
        voiceprint = m.Voiceprint(user_id=user_id, project_id=project_id, embedding=[])
        session.add(voiceprint)
        session.flush()
        voiceprint_id = voiceprint.id
    plant_target(seeded, "voiceprint_revoked", f"voiceprints/{voiceprint_id}")

    rows = client.get(f"/api/projects/{project_id}/activity").json()
    assert rows[0]["target_label"] == "김민수의 성문"


def test_an_audio_target_names_its_meeting(client: TestClient, seeded):
    """⭐ 녹음 삭제는 **어느 회의의** 녹음인지가 전부입니다.

    ⚠️ 지운 뒤에도 행은 남습니다(`deleted_at` 만 찍습니다) — 그래서 이름을
    찾을 수 있습니다. 못 찾으면 지어내지 않고 식별자를 그대로 둡니다.
    """
    project_id = seeded["project_id"]
    with db_session.session_scope() as session:
        meeting = m.Meeting(
            project_id=project_id,
            title=None,
            status="pending",
            started_by=seeded["user_ids"][0],
        )
        session.add(meeting)
        session.flush()
        asset = m.AudioAsset(
            meeting_id=meeting.id,
            kind="chunk",
            storage_key="k",
            encryption_key_id="e",
            retention_until=datetime(2027, 1, 1, tzinfo=UTC),
        )
        session.add(asset)
        session.flush()
        asset_id, meeting_id = asset.id, meeting.id
    plant_target(seeded, "audio_deleted", f"audio_assets/{asset_id}")

    rows = client.get(f"/api/projects/{project_id}/activity").json()
    # 제목 없는 회의도 한 벌에서 이름을 받습니다 (결함 285).
    assert rows[0]["target_label"] == f"제목 없는 회의 #{meeting_id}의 녹음"


def test_an_unknown_pair_target_is_still_not_invented(client: TestClient, seeded):
    """⚠️ 못 찾으면 **지어내지 않습니다** — 결함 293 의 규칙 그대로."""
    project_id = seeded["project_id"]
    plant_target(seeded, "score_adjusted", f"final_contributions/{project_id}:99999")

    rows = client.get(f"/api/projects/{project_id}/activity").json()
    assert rows[0]["target_label"] == f"final_contributions/{project_id}:99999"
