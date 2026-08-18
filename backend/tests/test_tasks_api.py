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
from teamflow.services import scoring_service

from .conftest import assign, login_as

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
        # ⚠️ **이름 순이 번호 순과 달라야 합니다.** 셋 다 이름과 번호가 같은
        #    순서면, 담당자 목록이 번호 순으로 나가도 이름 순처럼 보입니다 —
        #    순서를 재는 검사가 **아무것도 못 재게** 됩니다. 실제로 그렇게
        #    만들었다가 위반을 심어 보고 알았습니다(결함 163).
        #    "강보람" 은 이름으로는 맨 앞, 번호로는 맨 뒤입니다.
        boram = m.User(name="강보람", email="boram@example.com")
        s.add_all([member, other, outsider, boram])
        s.flush()

        project = m.Project(title="TeamFlow", started_at=NOW)
        s.add(project)
        s.flush()
        for user in (member, other, boram):
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
            deadline=NOW + timedelta(days=3),
            status="todo",
            origin_candidate_id=candidate.id,
        )
        by_hand = m.Task(
            project_id=project.id,
            title="개발 환경 문서 정리",
            deadline=None,
            status="todo",
        )
        orphan = m.Task(
            project_id=project.id,
            title="배포 방식 조사",
            deadline=NOW + timedelta(days=5),
            status="todo",
        )
        s.add_all([from_meeting, by_hand, orphan])
        s.flush()
        assign(s, from_meeting, member.id)
        assign(s, by_hand, other.id)
        # `orphan` 은 담당자가 없는 업무입니다 — 일부러 안 붙입니다.

        result = {
            "project_id": project.id,
            "meeting_id": meeting.id,
            "member": member.id,
            "other": other.id,
            "outsider": outsider.id,
            "boram": boram.id,
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
    assert body["statuses"] == ["todo", "in_progress", "review", "done"]


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


@pytest.mark.parametrize(
    ("completed_utc", "expected"),
    [
        # KST 09-04 23:00 — 아직 마감일 안. 제때.
        (datetime(2026, 9, 4, 14, 0, tzinfo=UTC), "deadline_met"),
        # KST 09-05 01:00 — 날짜가 넘어갔다. 늦음.
        # UTC 달력으로 보면 09-04 라 "제때" 가 된다. 그게 결함 107 이었다.
        (datetime(2026, 9, 4, 16, 0, tzinfo=UTC), "deadline_missed"),
    ],
)
def test_the_deadline_is_judged_on_the_team_calendar(
    client: TestClient,
    board: dict,
    monkeypatch: pytest.MonkeyPatch,
    completed_utc: datetime,
    expected: str,
):
    """⭐ 마감 준수는 **팀이 사는 달력**으로 판정한다 (결함 107).

    한국(UTC+9)에서 밤 9시 이후에 끝낸 업무는 UTC 로는 아직 어제입니다.
    `completed_at.date()` 로 재면 하루를 벌어 줍니다 — 마감 당일 밤에
    끝낸 업무가 **하루 늦게 끝내도 "제때"** 로 기록됐습니다.

    반대 방향은 없습니다. UTC 는 KST 보다 항상 뒤이므로 이 오차는 늘
    한쪽으로만, **늦은 쪽을 봐주는 쪽으로만** 작동했습니다.

    칸반 화면(`kanban/board.ts` 의 `isOverdue`)은 이미 로컬 달력으로
    비교하고 있었습니다. 그래서 같은 업무를 두고 **칸반은 "지연",
    기여도는 "제때"** 라고 말했습니다. 사람은 어느 쪽을 믿을지 모릅니다.
    """
    from teamflow.services import task_service

    assert patch(
        client, board, board["from_meeting"], {"deadline": "2026-09-04"}
    ).status_code == 200
    monkeypatch.setattr(task_service, "_now", lambda: completed_utc)
    patch(client, board, board["from_meeting"], {"status": "done"})

    kinds = {e["event_type"] for e in events(board["member"])}
    assert expected in kinds, kinds
    other = "deadline_met" if expected == "deadline_missed" else "deadline_missed"
    assert other not in kinds, kinds


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


def test_one_task_cannot_hold_both_a_met_and_a_missed_deadline(
    client: TestClient, board: dict
):
    """⭐ 한 업무가 마감 준수와 미준수를 동시에 가질 수 없다.

    `_emit` 의 멱등성은 `(source_kind, source_id, event_type)` 기준이라
    `deadline_met` 과 `deadline_missed` 를 **서로 다른 행**으로 본다.
    그래서 늦게 완료 → 되돌리기 → 마감일을 미래로 → 다시 완료 하면 둘 다
    남았다. `scoring._schedule_raw` 는 met/(met+missed) 를 쓰므로
    준수율이 0 에서 0.5 로 올라간다 — 버튼 세 번으로 점수가 오르는 경로다.
    """
    task_id = board["from_meeting"]

    # 마감일을 과거로 옮겨 놓고 완료 → 미준수.
    # 완료 시각은 실제 현재 시각이라 픽스처의 NOW 와 무관하다. 그래서
    # 시간이 흘러도 뜻이 변하지 않는 날짜를 쓴다.
    assert patch(client, board, task_id, {"deadline": "2020-01-01"}).status_code == 200
    assert patch(client, board, task_id, {"status": "done"}).status_code == 200

    kinds = [e["event_type"] for e in events(board["member"])]
    assert "deadline_missed" in kinds

    # 되돌리고 마감일을 미래로 옮긴 뒤 다시 완료
    assert patch(client, board, task_id, {"status": "todo"}).status_code == 200
    assert patch(client, board, task_id, {"deadline": "2099-12-31"}).status_code == 200
    assert patch(client, board, task_id, {"status": "done"}).status_code == 200

    kinds = [e["event_type"] for e in events(board["member"])]
    assert "deadline_met" not in kinds, kinds
    assert kinds.count("deadline_missed") == 1, kinds


def test_a_deadline_added_after_completion_does_not_create_a_met(
    client: TestClient, board: dict
):
    """⭐ 마감일 없이 끝낸 업무에 나중에 마감일을 붙여 준수를 만들 수 없다.

    마감일이 없으면 준수 여부를 물을 수 없고, **지켰다고 치지도 않는다**
    (docs/05 §5 — 측정 불가는 0점이 아니다). 그런데 완료를 되돌리고
    마감일을 미래로 넣은 뒤 다시 완료하면 **없던 준수 기록이 생겼다.**
    아무도 마감일을 과거로 넣지는 않으므로 이 조작은 한쪽으로만 작동한다.
    """
    task_id = board["by_hand"]  # 마감일 없음, 담당자 other
    owner = board["other"]

    assert patch(client, board, task_id, {"status": "done"}).status_code == 200
    kinds = [e["event_type"] for e in events(owner)]
    assert kinds == ["task_completed"], kinds

    assert patch(client, board, task_id, {"status": "todo"}).status_code == 200
    assert patch(client, board, task_id, {"deadline": "2099-12-31"}).status_code == 200
    assert patch(client, board, task_id, {"status": "done"}).status_code == 200

    kinds = [e["event_type"] for e in events(owner)]

    # 이 테스트가 막는 것은 **없던 준수 기록**이다. 마감일을 붙였다는 사실
    # 자체는 남아야 한다 — 그게 바로 이 조작을 보이게 하는 기록이고,
    # 지우면 `frequent_deadline_change` 가 셀 것이 없어진다.
    assert "deadline_met" not in kinds, kinds
    assert "deadline_missed" not in kinds, kinds
    assert kinds == ["task_completed", "deadline_changed"], kinds


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


def test_changing_the_deadline_reaches_the_contribution_events(
    client: TestClient, board: dict
):
    """⭐ 변경 이력만 남기면 조작 탐지는 **죽어 있다.**

    `scoring._detect_integrity_flags` 는 `DEADLINE_CHANGED` **기여 이벤트**를
    셉니다 — `task_deadline_changes` 테이블은 쳐다보지도 않습니다. 그래서
    감사 로그만 남기던 동안 `frequent_deadline_change` 플래그는 **한 번도
    뜰 수 없었습니다.** 위 테스트가 통과하고 있었던 이유이기도 합니다:
    그 테스트는 감사 표를 보고 이 테스트는 기여 이벤트를 봅니다.
    """
    patch(client, board, board["from_meeting"], {"deadline": "2026-10-01"})
    patch(client, board, board["from_meeting"], {"deadline": "2026-10-08"})

    changed = [e for e in events() if e["event_type"] == "deadline_changed"]

    # 업무당 하나가 아니라 **변경마다 하나**다. 업무 id 를 source_id 로 쓰면
    # 두 번째가 멱등성에 막혀 "3회 이상" 문턱을 영원히 못 넘는다.
    assert len(changed) == 2
    assert len({e["source_id"] for e in changed}) == 2

    # 준수율이 흔들리는 사람은 **담당자**다. 바꾼 사람이 아니다 —
    # `_detect_integrity_flags` 가 이 사람의 met/missed 와 비교하기 때문에,
    # 다른 사람에게 붙이면 두 사람의 숫자를 섞은 비율이 된다.
    assert {e["user_id"] for e in changed} == {board["member"]}


def test_the_change_lands_on_the_assignee_not_on_whoever_moved_it(
    client: TestClient, board: dict
):
    """⚠️ 담당자와 바꾼 사람이 **다를 때**만 이 구분이 드러난다.

    위 테스트의 업무는 담당자도 로그인 사용자도 김민수라, 행위자에게
    붙여도 그대로 통과합니다. 그래서 남의 업무를 옮기는 경우를 따로 씁니다 —
    이 저장소는 "아무나 남의 업무를 옮길 수 있다" 가 정상 동작입니다
    (`test_any_member_can_move_someone_elses_task`).
    """
    patch(client, board, board["by_hand"], {"deadline": "2026-12-01"})  # 담당자 other

    changed = [e for e in events() if e["event_type"] == "deadline_changed"]
    assert [e["user_id"] for e in changed] == [board["other"]]

    # 누가 바꿨는지는 근거에 남는다 — 사라지면 사보타주와 자기 조작을
    # 구분할 수 없다. 플래그는 판정이 아니라 "해석에 주의" 이므로,
    # 판정에 쓸 재료는 사람이 볼 수 있어야 한다.
    with db_session.session_scope() as s:
        row = s.scalars(
            select(m.ContributionEventRow).where(
                m.ContributionEventRow.event_type == "deadline_changed"
            )
        ).one()
        assert row.event_metadata["changed_by"] == board["member"]
        assert row.event_metadata["task_id"] == board["by_hand"]
        assert row.source_kind == "deadline_change"


def test_completing_a_task_records_who_pressed_it(client: TestClient, board: dict):
    """⭐ 점수가 **생기는** 순간에 기록이 없으면 분쟁 때 답할 수 없다.

    되돌리기에는 `task_reopened` 감사 로그가 있었는데 완료에는 없었습니다.
    이 저장소는 **아무나 남의 업무를 완료로 옮길 수 있는 것이 정상 동작**
    이라(`test_any_member_can_move_someone_elses_task`), 기여 이벤트는
    담당자 앞으로 생기고 **누가 눌렀는지는 어디에도 안 남았습니다.**
    한 번도 되돌린 적이 없는 프로젝트는 `audit_logs` 가 아예 비어 있어,
    밀어주기·대리 완료 의심이 제기되면 재구성할 방법이 없었습니다.
    """
    login_as(client, board["other"])  # 담당자(김민수)가 아닌 사람이 누른다
    assert patch(client, board, board["from_meeting"], {"status": "done"}).status_code == 200

    with db_session.session_scope() as s:
        log = s.scalars(
            select(m.AuditLog).where(m.AuditLog.action == "task_completed")
        ).one()
        assert log.actor_id == board["other"], "누른 사람"
        assert log.target == f"task:{board['from_meeting']}"
        assert log.before == {"status": "todo"}
        assert log.after == {"status": "done"}

    # 점수는 담당자 앞으로 간다 — 그건 그대로다.
    done = [e for e in events() if e["event_type"] == "task_completed"]
    assert [e["user_id"] for e in done] == [board["member"]]

    # 이벤트 자체에도 누가 눌렀는지 실린다. 감사 로그와 기여 이벤트는
    # 다른 표라, 하나만 보고 판단하는 사람이 생긴다.
    with db_session.session_scope() as s:
        row = s.scalars(
            select(m.ContributionEventRow).where(
                m.ContributionEventRow.event_type == "task_completed"
            )
        ).one()
        assert row.event_metadata["completed_by"] == board["other"]


def test_pushing_the_deadline_back_raises_the_integrity_flag(
    client: TestClient, board: dict
):
    """⭐ 끝에서 끝까지 — 버튼을 누르면 `frequent_deadline_change` 가 실제로 뜬다.

    이게 이 결함의 본체입니다. 순수 산정 테스트(`test_anti_gaming`)는
    처음부터 통과하고 있었고, 감사 표 테스트도 통과하고 있었습니다.
    **둘을 잇는 코드만 없었습니다.** 그러니 이 사슬 전체를 도는 테스트가
    아니면 같은 일이 또 벌어집니다 (결함 47·감사 #8 과 같은 부류).
    """
    task_id = board["from_meeting"]  # 담당자 member, 마감 있음
    for day in ("2026-10-01", "2026-10-08", "2026-10-15"):
        assert patch(client, board, task_id, {"deadline": day}).status_code == 200
    assert patch(client, board, task_id, {"status": "done"}).status_code == 200

    with db_session.session_scope() as s:
        result = scoring_service.compute(s, board["project_id"])

    codes = [f.code for f in result.members[board["member"]].integrity_flags]
    assert "frequent_deadline_change" in codes, codes


def test_a_task_without_an_assignee_logs_the_change_but_makes_no_event(
    client: TestClient, board: dict
):
    """담당자가 없으면 누구의 준수율도 안 흔들린다 — 이벤트를 만들지 않는다.

    변경 이력 자체는 남습니다. 둘은 다른 목적입니다.
    """
    patch(client, board, board["orphan"], {"deadline": "2026-11-01"})

    with db_session.session_scope() as s:
        assert len(s.scalars(select(m.TaskDeadlineChange)).all()) == 1
    assert [e for e in events() if e["event_type"] == "deadline_changed"] == []


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


# ══════════════════════════════════════════════════════════════
# 담당자 바꾸기 (`TASK-006`)
# ══════════════════════════════════════════════════════════════
#
# ⚠️ 이 엔드포인트가 없던 동안 담당자는 **회의 후보를 승인할 때 한 번**
#    정해지고 그 뒤로 못 바꿨습니다. 사람이 빠지거나 일을 넘겨받아도
#    칸반은 옛 이름을 말했고, 기여 이벤트는 계속 그 사람에게 갔습니다.


def put_assignees(client: TestClient, board: dict, task_id: int, user_ids: list[int]):
    return client.put(
        f"/api/projects/{board['project_id']}/tasks/{task_id}/assignees",
        json={"user_ids": user_ids},
    )


def test_a_task_can_have_two_assignees(client: TestClient, board: dict):
    response = put_assignees(
        client, board, board["by_hand"], [board["member"], board["other"]]
    )
    assert response.status_code == 200
    assert sorted(response.json()["assignee_ids"]) == sorted(
        [board["member"], board["other"]]
    )


def test_the_list_comes_back_by_name_not_by_the_order_i_sent(
    client: TestClient, board: dict
):
    """⚠️ 넣은 순서로 돌려주면 화면이 맨 앞을 **주담당**으로 그립니다.

    ⚠️ `강보람` 을 쓰는 이유: 이름으로는 맨 앞인데 번호로는 맨 뒤입니다.
    이름 순과 번호 순이 같은 사람들로 재면 **아무것도 안 재는 검사**가
    됩니다 (결함 163).
    """
    boram, minsu, haneul = board["boram"], board["member"], board["other"]

    got = put_assignees(client, board, board["by_hand"], [haneul, minsu, boram])
    assert got.json()["assignee_ids"] == [boram, minsu, haneul]


def test_the_board_lists_assignees_by_name_too(client: TestClient, board: dict):
    """⚠️ 칸반이 읽는 질의는 **다른 함수**입니다 (`of_tasks`).

    한쪽만 이름 순이면 담당자 순서가 화면마다 달라집니다. 실제로 이
    자리가 한동안 안 재지고 있었습니다 (결함 163).
    """
    boram, minsu, haneul = board["boram"], board["member"], board["other"]
    put_assignees(client, board, board["by_hand"], [haneul, minsu, boram])

    tasks = client.get(f"/api/projects/{board['project_id']}/tasks").json()["tasks"]
    card = next(t for t in tasks if t["id"] == board["by_hand"])
    assert card["assignee_ids"] == [boram, minsu, haneul]


def test_an_empty_list_means_nobody(client: TestClient, board: dict):
    assert put_assignees(client, board, board["by_hand"], []).json()["assignee_ids"] == []


def test_someone_outside_the_project_cannot_be_assigned(client: TestClient, board: dict):
    """⚠️ 안 막으면 **아무도 못 보는 점수**가 쌓입니다 — 기여도 화면은
    명단 기준이라 그 사람이 안 나옵니다."""
    response = put_assignees(client, board, board["by_hand"], [board["outsider"]])
    assert response.status_code == 400
    assert "팀원이 아닌" in response.json()["detail"]


def test_changing_assignees_is_written_down(client: TestClient, board: dict):
    """⚠️ 담당자는 기여 이벤트가 누구에게 가는지를 정합니다 — 조용히
    바뀌면 안 됩니다."""
    put_assignees(client, board, board["by_hand"], [board["member"]])

    with db_session.session_scope() as s:
        logs = s.scalars(
            select(m.AuditLog).where(m.AuditLog.action == "task_assignees_changed")
        ).all()
        assert len(logs) == 1
        assert logs[0].after == {"assignee_ids": [board["member"]]}


def test_setting_the_same_people_again_writes_nothing(client: TestClient, board: dict):
    """⚠️ 안 바뀐 것을 기록하면 활동 화면이 같은 줄로 메워집니다."""
    put_assignees(client, board, board["by_hand"], [board["member"]])
    put_assignees(client, board, board["by_hand"], [board["member"]])

    with db_session.session_scope() as s:
        logs = s.scalars(
            select(m.AuditLog).where(m.AuditLog.action == "task_assignees_changed")
        ).all()
    assert len(logs) == 1


def test_only_the_newcomer_hears_about_it(client: TestClient, board: dict):
    """⚠️ 지금 담당자 전원에게 보내면, 한 명 더할 때마다 원래 있던
    사람에게도 "새 업무를 맡았습니다" 가 갑니다."""
    login_as(client, board["outsider"])  # 알림을 받을 사람과 누른 사람을 가릅니다
    login_as(client, board["member"])

    put_assignees(client, board, board["orphan"], [board["other"]])
    put_assignees(client, board, board["orphan"], [board["other"], board["member"]])

    with db_session.session_scope() as s:
        notices = s.scalars(
            select(m.Notification).where(m.Notification.kind == "assigned")
        ).all()
    # `other` 한 번만. 누른 사람(`member`)은 자기 일이라 안 받습니다.
    assert [n.user_id for n in notices] == [board["other"]]


def test_the_completion_splits_between_them(client: TestClient, board: dict):
    """⭐ 둘이 맡은 업무를 끝내면 완료 이벤트가 **둘 다** 생깁니다."""
    put_assignees(client, board, board["by_hand"], [board["member"], board["other"]])
    assert patch(client, board, board["by_hand"], {"status": "done"}).status_code == 200

    done = [e for e in events() if e["event_type"] == "task_completed"]
    assert sorted(e["user_id"] for e in done) == sorted(
        [board["member"], board["other"]]
    )


def test_an_outsider_cannot_change_assignees(client: TestClient, board: dict):
    login_as(client, board["outsider"])
    assert put_assignees(client, board, board["by_hand"], []).status_code == 403


def test_unknown_task_is_404_for_assignees(client: TestClient, board: dict):
    assert put_assignees(client, board, 9999, []).status_code == 404
