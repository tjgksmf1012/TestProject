"""칸반 업무 API 테스트.

이 파일이 고정하는 것은 **마지막 연결**입니다.

    회의 결정 → 업무 후보 → 사람이 승인 → 칸반 업무 → 완료 → 기여도

`approval_service` 가 `tasks` 행을 만드는 데까지는 갔습니다. 그런데
**그 업무를 읽는 엔드포인트가 없었고**, 완료해도 기여도에 아무 일도
일어나지 않았습니다. `scoring.py` 는 `TASK_COMPLETED` 와 `DEADLINE_MET` 을
점수로 바꾸는 법을 알고 있는데 그 이벤트를 만드는 코드가 저장소 어디에도
없었습니다 — 즉 기여도 화면의 숫자는 **손으로 넣은 이벤트가 아니면 영원히
0** 이었습니다.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.pool import StaticPool

from teamflow.config import Settings, get_settings
from teamflow.db import models as m
from teamflow.db import session as db_session

from .conftest import login_as

NOW = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    m.Base.metadata.create_all(eng)
    db_session.configure(eng)
    yield eng
    m.Base.metadata.drop_all(eng)
    eng.dispose()


@pytest.fixture
def client(engine, tmp_path: Path) -> Iterator[TestClient]:
    from teamflow.api.main import app

    app.dependency_overrides[get_settings] = lambda: Settings(
        environment="test",
        github_webhook_secret="test-secret",
        database_url="sqlite://",
        audio_storage_root=tmp_path / "audio",
    )
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def board(engine, client: TestClient) -> dict:
    """회의에서 나온 업무 하나 + 손으로 만든 업무 하나 + 외부인."""
    with db_session.session_scope() as s:
        member = m.User(name="김민수", email="minsu@example.com")
        other = m.User(name="이하늘", email="haneul@example.com")
        outsider = m.User(name="외부인", email="out@example.com")
        s.add_all([member, other, outsider])
        s.flush()

        project = m.Project(title="TeamFlow", started_at=NOW)
        s.add(project)
        s.flush()
        for user in (member, other):
            s.add(m.Member(project_id=project.id, user_id=user.id, role_shares={}))

        meeting = m.Meeting(
            project_id=project.id, title="1주차", started_at=NOW, started_by=member.id
        )
        s.add(meeting)
        s.flush()

        utterance = m.Utterance(
            meeting_id=meeting.id,
            speaker_id=member.id,
            start_ms=0,
            end_ms=900,
            text="로그인은 제가 맡을게요",
            speaker_source="track",
            speaker_confidence=1.0,
            is_overlap=False,
        )
        s.add(utterance)
        s.flush()

        candidate = m.MeetingTaskCandidate(
            meeting_id=meeting.id,
            title="로그인 API 구현",
            assignee_id=member.id,
            deadline=NOW + timedelta(days=3),
            confidence=0.9,
            evidence_utterance_ids=[utterance.id],
            review_status="approved",
        )
        s.add(candidate)
        s.flush()

        from_meeting = m.Task(
            project_id=project.id,
            title="로그인 API 구현",
            assignee_id=member.id,
            deadline=NOW + timedelta(days=3),
            status="todo",
            origin_candidate_id=candidate.id,
        )
        by_hand = m.Task(
            project_id=project.id,
            title="개발 환경 문서 정리",
            assignee_id=other.id,
            deadline=None,
            status="todo",
        )
        orphan = m.Task(
            project_id=project.id,
            title="배포 방식 조사",
            assignee_id=None,
            deadline=NOW + timedelta(days=5),
            status="todo",
        )
        s.add_all([from_meeting, by_hand, orphan])
        s.flush()

        result = {
            "project_id": project.id,
            "meeting_id": meeting.id,
            "member": member.id,
            "other": other.id,
            "outsider": outsider.id,
            "from_meeting": from_meeting.id,
            "by_hand": by_hand.id,
            "orphan": orphan.id,
            "candidate_id": candidate.id,
        }

    login_as(client, result["member"])
    return result


def patch(client: TestClient, board: dict, task_id: int, body: dict):
    return client.patch(
        f"/api/projects/{board['project_id']}/tasks/{task_id}", json=body
    )


def events(user_id: int | None = None) -> list[m.ContributionEventRow]:
    with db_session.session_scope() as s:
        rows = s.scalars(select(m.ContributionEventRow)).all()
        return [
            {"user_id": r.user_id, "event_type": r.event_type, "source_id": r.source_id}
            for r in rows
            if user_id is None or r.user_id == user_id
        ]


# ══════════════════════════════════════════════════════════════
# 목록
# ══════════════════════════════════════════════════════════════


def test_board_lists_every_task(client: TestClient, board: dict):
    body = client.get(f"/api/projects/{board['project_id']}/tasks").json()
    assert len(body["tasks"]) == 3
    assert body["statuses"] == ["todo", "in_progress", "done"]


def test_task_from_a_meeting_carries_its_origin(client: TestClient, board: dict):
    """⭐ 이게 없으면 이 화면은 그냥 할 일 목록이다.

    "회의 결정이 실제 업무가 됐다" 가 이 프로젝트의 대표 주장인데, 업무에서
    회의로 거슬러 올라갈 수 없으면 그걸 확인할 방법이 없다.
    """
    body = client.get(f"/api/projects/{board['project_id']}/tasks").json()
    task = next(t for t in body["tasks"] if t["id"] == board["from_meeting"])

    assert task["origin"] is not None
    assert task["origin"]["meeting_id"] == board["meeting_id"]
    assert task["origin"]["meeting_title"] == "1주차"
    assert task["origin"]["evidence_utterance_ids"], "근거 발화까지 이어져야 한다"


def test_task_made_by_hand_has_no_origin(client: TestClient, board: dict):
    """손으로 만든 업무는 origin 이 없다 — 그게 정상이고, 화면이 구분한다."""
    body = client.get(f"/api/projects/{board['project_id']}/tasks").json()
    task = next(t for t in body["tasks"] if t["id"] == board["by_hand"])
    assert task["origin"] is None


def test_outsider_cannot_see_the_board(client: TestClient, board: dict):
    login_as(client, board["outsider"])
    assert client.get(f"/api/projects/{board['project_id']}/tasks").status_code == 403


def test_anonymous_cannot_see_the_board(client: TestClient, board: dict):
    client.cookies.clear()
    assert client.get(f"/api/projects/{board['project_id']}/tasks").status_code == 401


def test_unknown_project_is_404(client: TestClient, board: dict):
    assert client.get("/api/projects/99999/tasks").status_code == 404


# ══════════════════════════════════════════════════════════════
# 완료 → 기여도  (이 파일의 본론)
# ══════════════════════════════════════════════════════════════


def test_completing_a_task_creates_a_contribution_event(client: TestClient, board: dict):
    """⭐ 이 연결이 없어서 기여도가 손으로 넣은 이벤트로만 채워졌다."""
    assert events() == []

    response = patch(client, board, board["from_meeting"], {"status": "done"})
    assert response.status_code == 200, response.text
    assert response.json()["completed_at"] is not None

    kinds = {e["event_type"] for e in events(board["member"])}
    assert "task_completed" in kinds


def test_meeting_the_deadline_is_recorded(client: TestClient, board: dict):
    """마감 준수도 기여도 항목이다 (docs/05 §2.4)."""
    patch(client, board, board["from_meeting"], {"status": "done"})
    kinds = {e["event_type"] for e in events(board["member"])}
    assert "deadline_met" in kinds
    assert "deadline_missed" not in kinds


def test_missing_the_deadline_is_recorded_too(client: TestClient, board: dict):
    """⭐ 늦은 완료를 "완료" 로만 기록하면 마감 준수율이 의미를 잃는다."""
    patch(client, board, board["from_meeting"], {"deadline": "2020-01-01"})
    patch(client, board, board["from_meeting"], {"status": "done"})

    kinds = {e["event_type"] for e in events(board["member"])}
    assert "deadline_missed" in kinds
    assert "deadline_met" not in kinds


def test_a_task_without_a_deadline_claims_neither(client: TestClient, board: dict):
    """⭐ 마감일이 없으면 **지켰다고 치지 않는다.**

    없는 마감을 지킨 것으로 세면 마감일을 안 적는 게 이득이 된다.
    """
    patch(client, board, board["by_hand"], {"status": "done"})
    kinds = {e["event_type"] for e in events(board["other"])}

    assert kinds == {"task_completed"}


def test_a_task_without_an_assignee_creates_no_event(client: TestClient, board: dict):
    """⭐ 누구의 기여인지 모르는 완료를 아무에게나 붙일 수 없다."""
    response = patch(client, board, board["orphan"], {"status": "done"})
    assert response.status_code == 200
    assert events() == []


def test_completing_twice_does_not_count_twice(client: TestClient, board: dict):
    """⭐ 되돌렸다 다시 완료하면 점수가 두 번 오르면 안 된다.

    실제로 일어나는 경로다 — 잘못 옮겼다가 되돌리고 다시 옮긴다.
    막지 않으면 버튼을 반복해서 눌러 기여도를 올릴 수 있다.
    """
    patch(client, board, board["from_meeting"], {"status": "done"})
    patch(client, board, board["from_meeting"], {"status": "todo"})
    patch(client, board, board["from_meeting"], {"status": "done"})

    completions = [
        e for e in events(board["member"]) if e["event_type"] == "task_completed"
    ]
    assert len(completions) == 1


def test_reopening_clears_completed_at_but_keeps_the_record(
    client: TestClient, board: dict
):
    """⭐ 완료를 되돌려도 이벤트는 남고, 되돌렸다는 사실이 감사 로그에 남는다.

    이벤트를 지우면 "완료했다가 되돌렸다" 가 기록에서 사라지고 점수만
    조용히 내려간다. 기여도 분쟁에서 필요한 건 지금 상태가 아니라
    **무슨 일이 있었는가**다.
    """
    patch(client, board, board["from_meeting"], {"status": "done"})
    response = patch(client, board, board["from_meeting"], {"status": "todo"})

    assert response.json()["completed_at"] is None
    assert any(e["event_type"] == "task_completed" for e in events(board["member"]))

    with db_session.session_scope() as s:
        logs = s.scalars(
            select(m.AuditLog).where(m.AuditLog.action == "task_reopened")
        ).all()
        assert len(logs) == 1
        assert logs[0].target == f"task:{board['from_meeting']}"
        assert logs[0].actor_id == board["member"]


def test_events_point_back_at_the_task(client: TestClient, board: dict):
    """근거 없는 점수를 만들지 않는다 — 모든 이벤트는 원본을 가리킨다."""
    patch(client, board, board["from_meeting"], {"status": "done"})
    for event in events(board["member"]):
        assert event["source_id"] == board["from_meeting"]


# ══════════════════════════════════════════════════════════════
# 상태·마감일 변경
# ══════════════════════════════════════════════════════════════


def test_status_moves_between_columns(client: TestClient, board: dict):
    body = patch(client, board, board["from_meeting"], {"status": "in_progress"}).json()
    assert body["status"] == "in_progress"
    assert body["completed_at"] is None


def test_unknown_status_is_refused(client: TestClient, board: dict):
    response = patch(client, board, board["from_meeting"], {"status": "무엇"})
    assert response.status_code == 400
    assert "알 수 없는 상태" in response.json()["detail"]


def test_changing_the_deadline_is_always_logged(client: TestClient, board: dict):
    """⭐ 마감을 계속 뒤로 미루면 준수율이 저절로 올라간다 (docs/05 §2.4).

    점수를 깎지는 않지만, 변경 횟수를 남기지 않으면 그 조작이 보이지 않는다.
    """
    patch(
        client,
        board,
        board["from_meeting"],
        {"deadline": "2026-10-01", "reason": "설계가 바뀜"},
    )

    with db_session.session_scope() as s:
        changes = s.scalars(select(m.TaskDeadlineChange)).all()
        assert len(changes) == 1
        assert changes[0].task_id == board["from_meeting"]
        assert changes[0].changed_by == board["member"]
        assert changes[0].reason == "설계가 바뀜"


def test_setting_the_same_deadline_is_not_a_change(client: TestClient, board: dict):
    """같은 값을 다시 보내면 변경 이력이 늘지 않는다 — 노이즈가 기록을 덮는다.

    시드 마감일이 이미 2026-09-04 라, 그 값으로 보내는 첫 요청도 변경이
    아니다. 그것부터 확인한다.
    """
    patch(client, board, board["from_meeting"], {"deadline": "2026-09-04"})
    with db_session.session_scope() as s:
        assert s.scalars(select(m.TaskDeadlineChange)).all() == []

    patch(client, board, board["from_meeting"], {"deadline": "2026-10-01"})
    patch(client, board, board["from_meeting"], {"deadline": "2026-10-01"})
    with db_session.session_scope() as s:
        assert len(s.scalars(select(m.TaskDeadlineChange)).all()) == 1


def test_clearing_the_deadline_is_a_change(client: TestClient, board: dict):
    patch(client, board, board["from_meeting"], {"deadline": None})

    with db_session.session_scope() as s:
        change = s.scalars(select(m.TaskDeadlineChange)).one()
        assert change.new_deadline is None
    body = client.get(f"/api/projects/{board['project_id']}/tasks").json()
    task = next(t for t in body["tasks"] if t["id"] == board["from_meeting"])
    assert task["deadline"] is None


def test_changing_only_the_status_does_not_wipe_the_deadline(
    client: TestClient, board: dict
):
    """⭐ `deadline: null` 이 "안 건드림" 인지 "지움" 인지 구분해야 한다.

    pydantic 은 둘 다 None 으로 만든다. 구분하지 않으면 상태만 바꾸려는
    요청이 **마감일을 조용히 지운다** — 그러면 마감 준수 기록이 통째로
    사라지고 아무도 모른다.
    """
    before = patch(client, board, board["from_meeting"], {"status": "in_progress"}).json()
    assert before["deadline"] == "2026-09-04"

    with db_session.session_scope() as s:
        assert s.scalars(select(m.TaskDeadlineChange)).all() == []


def test_unknown_task_is_404(client: TestClient, board: dict):
    assert patch(client, board, 99999, {"status": "done"}).status_code == 404


def test_task_from_another_project_is_404(client: TestClient, board: dict):
    """다른 프로젝트의 업무를 이 프로젝트 주소로 옮길 수 없다."""
    with db_session.session_scope() as s:
        other_project = m.Project(title="남의 프로젝트", started_at=NOW)
        s.add(other_project)
        s.flush()
        stranger = m.Task(project_id=other_project.id, title="남의 업무", status="todo")
        s.add(stranger)
        s.flush()
        stranger_id = stranger.id

    assert patch(client, board, stranger_id, {"status": "done"}).status_code == 404


def test_outsider_cannot_move_tasks(client: TestClient, board: dict):
    login_as(client, board["outsider"])
    assert patch(client, board, board["from_meeting"], {"status": "done"}).status_code == 403


def test_anonymous_cannot_move_tasks(client: TestClient, board: dict):
    client.cookies.clear()
    assert patch(client, board, board["from_meeting"], {"status": "done"}).status_code == 401


def test_any_member_can_move_someone_elses_task(client: TestClient, board: dict):
    """칸반은 팀 도구다. 자기 카드만 옮길 수 있으면 회의 중에 정리를 못 한다.

    대신 **누가 옮겼는지**는 완료 취소 시 감사 로그에 남는다.
    """
    login_as(client, board["other"])
    assert patch(client, board, board["from_meeting"], {"status": "done"}).status_code == 200

    # 기여는 옮긴 사람이 아니라 **담당자**에게 붙는다.
    assert all(e["user_id"] == board["member"] for e in events())
