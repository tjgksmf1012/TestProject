"""API 통합 테스트.

SQLite 인메모리에 실제 스키마를 만들고 HTTP로 호출한다.
(개발 환경에 Docker 데몬이 없어 PostgreSQL을 띄울 수 없다. 모델에
with_variant 를 적용해 프로덕션 타입을 낮추지 않으면서 SQLite로 테스트한다.)
"""

from __future__ import annotations

import hashlib
import hmac
import inspect
import json
import time
from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from teamflow.config import Settings, get_settings
from teamflow.db import assignees, vocab
from teamflow.db import models as m
from teamflow.db import session as db_session

from .conftest import login_as

WEBHOOK_SECRET = "test-webhook-secret-do-not-use"
NOW = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)


@pytest.fixture
def engine():
    # StaticPool 필수 — SQLite 인메모리는 커넥션마다 별개 DB다.
    # 이게 없으면 시딩한 커넥션과 요청을 처리하는 커넥션이 서로 다른 DB를 본다.
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    m.Base.metadata.create_all(eng)
    db_session.configure(eng)
    yield eng
    m.Base.metadata.drop_all(eng)
    eng.dispose()


@pytest.fixture
def db(engine) -> Iterator[Session]:
    with db_session.session_scope() as session:
        yield session


@pytest.fixture
def client(engine) -> Iterator[TestClient]:
    from teamflow.api.main import app

    def _settings() -> Settings:
        return Settings(
            environment="test",
            github_webhook_secret=WEBHOOK_SECRET,
            database_url="sqlite://",
        )

    app.dependency_overrides[get_settings] = _settings
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def seeded(engine, client: TestClient) -> dict[str, int]:
    """프로젝트 하나 + 팀원 셋 + 회의 하나 + 후보 둘.

    **팀원 첫 사람으로 로그인까지 해 둔다.** 회의 내용·기여도는 팀 내부
    자료라 서버가 구성원인지 확인하고, 확인의 근거는 세션이다. 예전에는
    `reviewer_id` 를 요청 본문으로 받았고 그게 고친 결함이다.
    """
    with db_session.session_scope() as s:
        users = [
            m.User(name="김민수", email="minsu@example.com"),
            m.User(name="이하늘", email="haneul@example.com"),
            m.User(name="박지원", email="jiwon@example.com"),
        ]
        s.add_all(users)
        s.flush()

        project = m.Project(
            title="TeamFlow 졸업작품",
            started_at=datetime(2026, 8, 1, tzinfo=UTC),
            deadline=datetime(2026, 11, 30, tzinfo=UTC),
            github_repo="team/teamflow",
            github_connected_at=datetime(2026, 8, 1, tzinfo=UTC),
        )
        s.add(project)
        s.flush()

        logins = ["minsu-dev", "haneul-design", "jiwon-pm"]
        roles = [
            {"developer": 1.0},
            {"designer": 1.0},
            {"developer": 0.6, "planner": 0.4},
        ]
        for user, login, role in zip(users, logins, roles, strict=True):
            s.add(
                m.Member(
                    project_id=project.id,
                    user_id=user.id,
                    role_shares=role,
                    github_login=login,
                )
            )

        meeting = m.Meeting(
            project_id=project.id,
            title="9월 1일 정기회의",
            started_at=NOW,
            duration_sec=1800,
            status="needs_review",
            started_by=users[0].id,
        )
        s.add(meeting)
        s.flush()

        candidates = [
            m.MeetingTaskCandidate(
                meeting_id=meeting.id,
                title="로그인 API 구현",
                assignee_id=users[0].id,
                deadline=datetime(2026, 9, 4, tzinfo=UTC),
                confidence=0.94,
                evidence_utterance_ids=[101],
            ),
            m.MeetingTaskCandidate(
                meeting_id=meeting.id,
                title="통합 테스트 작성",
                assignee_id=None,  # 담당자 미확정
                deadline=None,
                confidence=0.55,
                evidence_utterance_ids=[105],
            ),
        ]
        s.add_all(candidates)
        s.flush()

        result = {
            "project_id": project.id,
            "meeting_id": meeting.id,
            "user_ids": [u.id for u in users],
            "candidate_ids": [c.id for c in candidates],
        }

    login_as(client, result["user_ids"][0])
    return result


def sign(body: bytes, secret: str = WEBHOOK_SECRET) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


# ══════════════════════════════════════════════════════════════
# 헬스체크
# ══════════════════════════════════════════════════════════════


def test_health(client: TestClient):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_health_does_not_leak_secrets(client: TestClient):
    """헬스체크로 시크릿이 새는 사고는 흔하다."""
    body = json.dumps(client.get("/health").json())
    assert WEBHOOK_SECRET not in body
    for key in ("secret", "token", "password", "private_key", "database_url"):
        assert key not in body.lower()


# ══════════════════════════════════════════════════════════════
# 시각 동기화
# ══════════════════════════════════════════════════════════════


def test_server_time_returns_epoch_millis(client: TestClient):
    body = client.get("/api/time").json()
    now_ms = time.time_ns() // 1_000_000
    # 2020년 이후이고 미래가 아니면 epoch 밀리초가 맞다
    assert 1_577_836_800_000 < body["t1"] <= now_ms + 1_000
    assert body["t2"] >= body["t1"]


def test_server_time_processing_is_near_zero(client: TestClient):
    """t2-t1 이 크면 클라이언트가 그만큼을 왕복에서 빼버려 추정이 흔들린다."""
    body = client.get("/api/time").json()
    assert body["t2"] - body["t1"] < 50


def test_server_time_is_never_cached(client: TestClient):
    """캐시되면 모든 기기가 같은 시각을 받아 동기화가 통째로 무의미해진다."""
    cache_control = client.get("/api/time").headers["cache-control"]
    assert "no-store" in cache_control


def test_server_time_advances(client: TestClient):
    first = client.get("/api/time").json()
    time.sleep(0.01)
    second = client.get("/api/time").json()
    assert second["t1"] >= first["t2"]


def test_server_time_touches_nothing(client: TestClient):
    """동기화는 회의마다 수십 번 불린다.

    DB 나 설정을 타면 그 지연이 t2-t1 로 잡히고, 왕복 추정이 흔들린다.
    의존성이 하나라도 붙는 순간 그렇게 되므로 시그니처로 못 박아 둔다.
    """
    from teamflow.api.main import server_time

    params = inspect.signature(server_time).parameters
    assert list(params) == ["response"]


# ══════════════════════════════════════════════════════════════
# GitHub 웹훅 — 서명 검증
# ══════════════════════════════════════════════════════════════


def pr_merged_payload(repo: str = "team/teamflow", login: str = "minsu-dev") -> dict:
    return {
        "action": "closed",
        "repository": {"full_name": repo},
        "pull_request": {
            "number": 42,
            "merged": True,
            "merged_at": "2026-09-01T12:00:00Z",
            "user": {"login": login},
            "head": {"ref": "feat/12-login"},
        },
    }


def post_webhook(
    client: TestClient,
    payload: dict,
    *,
    event: str = "pull_request",
    delivery: str = "delivery-1",
    secret: str | None = WEBHOOK_SECRET,
    signature: str | None = None,
):
    body = json.dumps(payload).encode()
    headers = {
        "X-GitHub-Event": event,
        "X-GitHub-Delivery": delivery,
        "Content-Type": "application/json",
    }
    if signature is not None:
        headers["X-Hub-Signature-256"] = signature
    elif secret is not None:
        headers["X-Hub-Signature-256"] = sign(body, secret)
    return client.post("/api/github/webhook", content=body, headers=headers)


def test_webhook_accepts_valid_signature(client: TestClient, seeded):
    response = post_webhook(client, pr_merged_payload())
    assert response.status_code == 202
    assert response.json()["status"] == "accepted"


def test_webhook_rejects_missing_signature(client: TestClient, seeded):
    """⚠️ 서명 없이 통과하면 누구나 기여도를 조작할 수 있다."""
    response = post_webhook(client, pr_merged_payload(), secret=None)
    assert response.status_code == 401


def test_webhook_rejects_wrong_secret(client: TestClient, seeded):
    response = post_webhook(client, pr_merged_payload(), secret="wrong-secret")
    assert response.status_code == 401


def test_webhook_rejects_tampered_body(client: TestClient, seeded):
    """서명은 맞지만 본문이 바뀐 경우 — 중간자 변조."""
    original = json.dumps(pr_merged_payload()).encode()
    tampered = json.dumps(pr_merged_payload(login="attacker")).encode()
    response = client.post(
        "/api/github/webhook",
        content=tampered,
        headers={
            "X-GitHub-Event": "pull_request",
            "X-GitHub-Delivery": "d1",
            "X-Hub-Signature-256": sign(original),  # 원본 기준 서명
            "Content-Type": "application/json",
        },
    )
    assert response.status_code == 401


@pytest.mark.parametrize("bad", ["", "sha1=abc", "abcdef", "sha256=", "sha256=zzzz"])
def test_webhook_rejects_malformed_signature(client: TestClient, seeded, bad: str):
    response = post_webhook(client, pr_merged_payload(), signature=bad)
    assert response.status_code == 401


def test_webhook_error_does_not_reveal_details(client: TestClient, seeded):
    """무엇이 틀렸는지 자세히 알려주면 공격자에게 힌트가 된다."""
    detail = post_webhook(client, pr_merged_payload(), secret="wrong").json()["detail"]
    assert detail == "서명 검증 실패"


# ══════════════════════════════════════════════════════════════
# GitHub 웹훅 — 정규화와 저장
# ══════════════════════════════════════════════════════════════


def test_webhook_stores_merged_pr(client: TestClient, seeded, engine):
    post_webhook(client, pr_merged_payload())
    with db_session.session_scope() as s:
        row = s.scalar(select(m.GithubEvent))
        assert row is not None
        assert row.event_type == "pull_request.merged"
        assert row.actor_login == "minsu-dev"
        assert row.ref == "feat/12-login"
        # github_login 으로 팀원과 연결되어야 한다
        assert row.actor_user_id == seeded["user_ids"][0]


def test_webhook_ignores_unmerged_pr(client: TestClient, seeded):
    """PR을 열기만 한 것은 기여가 아니다."""
    payload = pr_merged_payload()
    payload["action"] = "opened"
    payload["pull_request"]["merged"] = False
    response = post_webhook(client, payload)
    assert response.json()["status"] == "ignored"


def test_webhook_ignores_closed_without_merge(client: TestClient, seeded):
    payload = pr_merged_payload()
    payload["pull_request"]["merged"] = False
    assert post_webhook(client, payload).json()["status"] == "ignored"


def test_webhook_ignores_unlinked_repo(client: TestClient, seeded):
    response = post_webhook(client, pr_merged_payload(repo="stranger/other"))
    assert response.json() == {"status": "ignored", "reason": "unlinked_repo"}


def test_webhook_deduplicates_redelivery(client: TestClient, seeded):
    """웹훅은 재전송된다. 두 번 저장되면 점수가 부풀려진다."""
    first = post_webhook(client, pr_merged_payload(), delivery="same-id")
    second = post_webhook(client, pr_merged_payload(), delivery="same-id")
    assert first.json()["status"] == "accepted"
    assert second.json()["status"] == "duplicate"

    with db_session.session_scope() as s:
        assert s.scalar(select(m.GithubEvent).where(m.GithubEvent.delivery_id == "same-id"))
        count = len(s.scalars(select(m.GithubEvent.id)).all())
        assert count == 1


def test_webhook_ping_is_ignored(client: TestClient, seeded):
    response = post_webhook(
        client, {"repository": {"full_name": "team/teamflow"}}, event="ping"
    )
    assert response.json()["status"] == "ignored"


def test_webhook_unknown_user_still_stored(client: TestClient, seeded):
    """팀원이 아닌 사람의 활동도 기록은 한다. 다만 연결되지 않는다."""
    post_webhook(client, pr_merged_payload(login="outsider"))
    with db_session.session_scope() as s:
        row = s.scalar(select(m.GithubEvent))
        assert row.actor_login == "outsider"
        assert row.actor_user_id is None


# ══════════════════════════════════════════════════════════════
# 업무 후보 검토
# ══════════════════════════════════════════════════════════════


def test_list_candidates_sorted_by_confidence(client: TestClient, seeded):
    """확신도가 낮은 것부터 — 사람이 봐야 할 것을 먼저 보여준다."""
    response = client.get(f"/api/meetings/{seeded['meeting_id']}/candidates")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 2
    assert data[0]["confidence"] < data[1]["confidence"]
    assert data[0]["title"] == "통합 테스트 작성"


def test_list_candidates_404_for_unknown_meeting(client: TestClient, seeded):
    assert client.get("/api/meetings/99999/candidates").status_code == 404


def test_approve_creates_task(client: TestClient, seeded):
    cid = seeded["candidate_ids"][0]
    response = client.post(
        f"/api/meetings/{seeded['meeting_id']}/candidates/review",
        json={
            "reviewer_id": seeded["user_ids"][2],
            "items": [{"candidate_id": cid, "approve": True}],
        },
    )
    assert response.status_code == 200
    assert response.json()["approved_count"] == 1

    with db_session.session_scope() as s:
        task = s.scalar(select(m.Task).where(m.Task.origin_candidate_id == cid))
        assert task is not None
        assert task.title == "로그인 API 구현"
        assert assignees.of_task(s, task.id) == [seeded["user_ids"][0]]
        assert task.status == "todo"


def test_incomplete_candidate_cannot_be_approved(client: TestClient, seeded):
    """담당자·마감일이 없으면 사람이 채워야 승인된다."""
    cid = seeded["candidate_ids"][1]
    response = client.post(
        f"/api/meetings/{seeded['meeting_id']}/candidates/review",
        json={
            "reviewer_id": seeded["user_ids"][2],
            "items": [{"candidate_id": cid, "approve": True}],
        },
    )
    result = response.json()
    assert result["approved_count"] == 0
    assert str(cid) in {str(k) for k in result["failures"]}

    with db_session.session_scope() as s:
        assert s.scalar(select(m.Task).where(m.Task.origin_candidate_id == cid)) is None


def test_human_override_completes_candidate(client: TestClient, seeded):
    cid = seeded["candidate_ids"][1]
    response = client.post(
        f"/api/meetings/{seeded['meeting_id']}/candidates/review",
        json={
            "reviewer_id": seeded["user_ids"][2],
            "items": [
                {
                    "candidate_id": cid,
                    "approve": True,
                    "assignee_override": seeded["user_ids"][1],
                    "deadline_override": "2026-09-15",
                }
            ],
        },
    )
    assert response.json()["approved_count"] == 1

    with db_session.session_scope() as s:
        task = s.scalar(select(m.Task).where(m.Task.origin_candidate_id == cid))
        assert assignees.of_task(s, task.id) == [seeded["user_ids"][1]]


def test_approval_writes_audit_log(client: TestClient, seeded):
    """불변식: 감사 로그 없는 승인은 존재할 수 없다."""
    login_as(client, seeded["user_ids"][2])
    client.post(
        f"/api/meetings/{seeded['meeting_id']}/candidates/review",
        json={"items": [{"candidate_id": seeded["candidate_ids"][0], "approve": True}]},
    )
    with db_session.session_scope() as s:
        logs = s.scalars(select(m.AuditLog)).all()
        assert len(logs) == 1
        assert logs[0].action == "candidate_approved"
        assert logs[0].actor_id == seeded["user_ids"][2]


def test_double_approval_creates_one_task(client: TestClient, seeded):
    """승인 버튼 연타 방어."""
    cid = seeded["candidate_ids"][0]
    payload = {
        "reviewer_id": seeded["user_ids"][2],
        "items": [{"candidate_id": cid, "approve": True}],
    }
    url = f"/api/meetings/{seeded['meeting_id']}/candidates/review"
    client.post(url, json=payload)
    client.post(url, json=payload)

    with db_session.session_scope() as s:
        tasks = s.scalars(select(m.Task).where(m.Task.origin_candidate_id == cid)).all()
        assert len(tasks) == 1


def test_rejection_creates_no_task(client: TestClient, seeded):
    cid = seeded["candidate_ids"][0]
    client.post(
        f"/api/meetings/{seeded['meeting_id']}/candidates/review",
        json={
            "reviewer_id": seeded["user_ids"][2],
            "items": [{"candidate_id": cid, "approve": False, "note": "중복"}],
        },
    )
    with db_session.session_scope() as s:
        assert s.scalar(select(m.Task).where(m.Task.origin_candidate_id == cid)) is None
        row = s.get(m.MeetingTaskCandidate, cid)
        assert row.review_status == "rejected"


def test_partial_batch_failure_still_commits_successes(client: TestClient, seeded):
    response = client.post(
        f"/api/meetings/{seeded['meeting_id']}/candidates/review",
        json={
            "reviewer_id": seeded["user_ids"][2],
            "items": [
                {"candidate_id": seeded["candidate_ids"][0], "approve": True},
                {"candidate_id": seeded["candidate_ids"][1], "approve": True},
            ],
        },
    )
    result = response.json()
    assert result["approved_count"] == 1
    assert len(result["failures"]) == 1


def test_reviewer_cannot_be_chosen_by_the_request(client: TestClient, seeded):
    """⭐ 요청 본문에 `reviewer_id` 를 적어도 무시된다.

    예전에는 이 값을 그대로 믿었다. 승인은 이 시스템에서 사람이 개입하는
    유일한 지점이고 승인된 업무는 칸반에 올라 기여도에 들어가므로, 검토자를
    요청으로 정할 수 있으면 **남의 이름으로 승인 기록을 남길 수 있다.**

    필드를 지운 것만으로는 부족하다 — pydantic 은 모르는 필드를 조용히
    버리므로, 옛 클라이언트가 계속 보내도 200 이 나온다. 기록되는 검토자가
    **세션 사용자**인지를 확인해야 한다.
    """
    login_as(client, seeded["user_ids"][0])
    response = client.post(
        f"/api/meetings/{seeded['meeting_id']}/candidates/review",
        json={
            "reviewer_id": seeded["user_ids"][2],  # 사칭 시도
            "items": [{"candidate_id": seeded["candidate_ids"][0], "approve": True}],
        },
    )
    assert response.status_code == 200, response.text

    with db_session.session_scope() as s:
        log = s.scalars(select(m.AuditLog)).one()
        assert log.actor_id == seeded["user_ids"][0]


# ══════════════════════════════════════════════════════════════
# 기여도
# ══════════════════════════════════════════════════════════════


def add_contribution_events(project_id: int, user_id: int, count: int) -> None:
    from teamflow.contribution.events import Category, EventType, SourceKind

    with db_session.session_scope() as s:
        for i in range(count):
            s.add(
                m.ContributionEventRow(
                    project_id=project_id,
                    user_id=user_id,
                    occurred_at=NOW,
                    category=Category.TASK.value,
                    event_type=EventType.TASK_COMPLETED.value,
                    source_kind=SourceKind.TASK.value,
                    source_id=user_id * 1000 + i,
                    magnitude=1.0,
                    event_metadata={"difficulty": 2},
                )
            )


def test_contributions_shares_sum_to_100(client: TestClient, seeded):
    add_contribution_events(seeded["project_id"], seeded["user_ids"][0], 5)
    add_contribution_events(seeded["project_id"], seeded["user_ids"][1], 3)
    add_contribution_events(seeded["project_id"], seeded["user_ids"][2], 2)

    data = client.get(f"/api/projects/{seeded['project_id']}/contributions").json()
    total = sum(member["share"] for member in data["members"])
    assert total == pytest.approx(100.0, abs=0.1)


def test_contributions_include_all_members_even_with_no_events(
    client: TestClient, seeded
):
    """이벤트가 없는 팀원도 목록에 나와야 한다. 빠지면 '왜 내가 없냐'는 문의가 온다."""
    add_contribution_events(seeded["project_id"], seeded["user_ids"][0], 3)
    data = client.get(f"/api/projects/{seeded['project_id']}/contributions").json()
    assert len(data["members"]) == 3


def test_contributions_never_expose_ranking(client: TestClient, seeded):
    """⚠️ 순위·리더보드를 제공하지 않는다. docs/07 E2

    같은 데이터라도 순위로 보이는 순간 서비스의 성격이 바뀐다.
    """
    add_contribution_events(seeded["project_id"], seeded["user_ids"][0], 5)
    data = client.get(f"/api/projects/{seeded['project_id']}/contributions").json()
    assert "ranking" not in data
    assert "rank" not in json.dumps(data).lower()
    for member in data["members"]:
        assert "rank" not in member


def test_contributions_carry_evidence_and_notice(client: TestClient, seeded):
    """모든 점수에 근거가 붙고, 참고값이라는 고지가 함께 나간다."""
    add_contribution_events(seeded["project_id"], seeded["user_ids"][0], 4)
    data = client.get(f"/api/projects/{seeded['project_id']}/contributions").json()

    assert "최종 기여도는 팀이 합의하여 확정합니다" in data["notice"]
    scored = [mem for mem in data["members"] if mem["share"] > 0]
    assert scored
    for member in scored:
        for cat in member["categories"]:
            if cat["raw"] > 0:
                assert cat["evidence_ids"]


def test_contributions_expose_confidence_reasons(client: TestClient, seeded):
    """신뢰도가 낮으면 왜 낮은지 알려준다 — 그래야 사용자가 데이터를 채운다."""
    add_contribution_events(seeded["project_id"], seeded["user_ids"][0], 3)
    data = client.get(f"/api/projects/{seeded['project_id']}/contributions").json()
    member = data["members"][0]
    assert member["confidence_label"] in ("높음", "보통", "낮음", "매우 낮음")
    assert isinstance(member["confidence_reasons"], list)


def test_contributions_range_widens_with_low_confidence(client: TestClient, seeded):
    add_contribution_events(seeded["project_id"], seeded["user_ids"][0], 5)
    data = client.get(f"/api/projects/{seeded['project_id']}/contributions").json()
    member = next(mem for mem in data["members"] if mem["share"] > 0)
    assert member["range_low"] <= member["share"] <= member["range_high"]


def test_contributions_blended_role_is_supported(client: TestClient, seeded):
    """겸직(개발 60% + 기획 40%) 멤버도 처리된다."""
    add_contribution_events(seeded["project_id"], seeded["user_ids"][2], 4)
    data = client.get(f"/api/projects/{seeded['project_id']}/contributions").json()
    member = next(mem for mem in data["members"] if mem["user_id"] == seeded["user_ids"][2])
    assert member["role"] == "developer"  # 비중이 큰 쪽
    assert member["share"] > 0


# ══════════════════════════════════════════════════════════════
# 팀원 명단 (승인 화면용)
# ══════════════════════════════════════════════════════════════


def test_meeting_members_lists_the_project_roster(client: TestClient, seeded):
    body = client.get(f"/api/meetings/{seeded['meeting_id']}/members").json()

    assert [m["user_id"] for m in body] == seeded["user_ids"]
    assert [m["name"] for m in body] == ["김민수", "이하늘", "박지원"]


def test_meeting_members_includes_role_shares(client: TestClient, seeded):
    """겸직도 그대로 보여준다 — 역할이 가중치를 바꾸므로 승인자가 알아야 한다."""
    body = client.get(f"/api/meetings/{seeded['meeting_id']}/members").json()

    assert body[0]["role_shares"] == {"developer": 1.0}
    assert body[2]["role_shares"] == {"developer": 0.6, "planner": 0.4}


def test_meeting_members_404_for_unknown_meeting(client: TestClient, seeded):
    assert client.get("/api/meetings/99999/members").status_code == 404


# ══════════════════════════════════════════════════════════════
# 실패한 회의 다시 처리 (결함 114)
# ══════════════════════════════════════════════════════════════


def set_status(meeting_id: int, value: str) -> None:
    with db_session.session_scope() as s:
        s.get(m.Meeting, meeting_id).status = value


def test_a_failed_meeting_can_be_processed_again(client: TestClient, seeded, engine):
    """⭐ `failed` 는 **막다른 길이었다** (결함 114).

    회의 상태를 쓰는 곳은 다섯인데 아무도 `pending` 으로 되돌리지 않고,
    `try_finalize_meeting` 은 `status != "pending"` 이면 큐에 안 넣습니다.

    그런데 홈 화면은 &#34;처리에 실패했습니다 — 트랙이 온전한지 확인하세요&#34;
    를 **`actionable: true`** 로 보여주고 있었습니다. 가서 확인하고
    **트랙이 멀쩡해도 할 수 있는 일이 없었습니다.**
    """
    set_status(seeded["meeting_id"], "failed")

    response = client.post(f"/api/meetings/{seeded['meeting_id']}/reprocess")
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "queued"

    with db_session.session_scope() as s:
        assert s.get(m.Meeting, seeded["meeting_id"]).status == "queued"


def test_a_stuck_queued_meeting_can_be_pushed_again(client: TestClient, seeded, engine):
    """워커가 죽어 있던 동안 큐잉된 회의도 풀 수 있어야 한다.

    `queued` 인데 아무도 안 집어가면 그 회의는 영영 그대로입니다 —
    브로커가 죽었을 때 `enqueue_meeting_processing` 은 **조용히 None 을
    돌려주기** 때문입니다(요청을 실패시키지 않는 것이 그 함수의 규약).
    """
    set_status(seeded["meeting_id"], "queued")
    assert client.post(f"/api/meetings/{seeded['meeting_id']}/reprocess").status_code == 200


def test_a_meeting_that_did_not_fail_is_refused(client: TestClient, seeded, engine):
    """⚠️ 검토 중인 회의를 다시 돌리면 **사람이 보던 후보가 사라집니다.**"""
    set_status(seeded["meeting_id"], "needs_review")

    response = client.post(f"/api/meetings/{seeded['meeting_id']}/reprocess")
    assert response.status_code == 409
    assert "다시 처리할 수 있습니다" in response.json()["detail"]


def test_the_refusal_does_not_leak_the_internal_status_name(
    client: TestClient, seeded, engine
):
    """오류 문구에 `needs_review` 같은 내부 이름을 넣지 않는다 (결함 78·86)."""
    set_status(seeded["meeting_id"], "needs_review")
    detail = client.post(f"/api/meetings/{seeded['meeting_id']}/reprocess").json()["detail"]

    for internal in ("needs_review", "confirmed", "processing", "pending"):
        assert internal not in detail, detail


def test_a_reviewed_meeting_is_refused_with_the_count(
    client: TestClient, seeded, engine
):
    """⭐ 사람이 이미 판단한 회의는 **큐에 넣기 전에** 막는다.

    태스크도 `already_reviewed` 로 거절하지만 그건 큐에 들어간 **뒤**라,
    화면에는 &#34;다시 처리를 시작했습니다&#34; 로 보이고 아무 일도 안 일어납니다.
    """
    set_status(seeded["meeting_id"], "failed")
    with db_session.session_scope() as s:
        candidate = s.scalars(
            select(m.MeetingTaskCandidate).where(
                m.MeetingTaskCandidate.meeting_id == seeded["meeting_id"]
            )
        ).first()
        candidate.review_status = "approved"

    response = client.post(f"/api/meetings/{seeded['meeting_id']}/reprocess")
    assert response.status_code == 409
    assert "1건" in response.json()["detail"]

    with db_session.session_scope() as s:
        assert s.get(m.Meeting, seeded["meeting_id"]).status == "failed", (
            "거절했으면 상태도 그대로여야 한다"
        )


def test_asking_to_reprocess_is_always_logged(client: TestClient, seeded, engine):
    """누가 다시 돌렸는지 남는다 — 재처리는 앞판의 결과를 지운다."""
    set_status(seeded["meeting_id"], "failed")
    client.post(f"/api/meetings/{seeded['meeting_id']}/reprocess")

    with db_session.session_scope() as s:
        rows = s.scalars(
            select(m.AuditLog).where(
                m.AuditLog.action == "meeting_reprocess_requested"
            )
        ).all()
        assert len(rows) == 1
        assert rows[0].before == {"status": "failed"}
        assert rows[0].actor_id == seeded["user_ids"][0]


def test_an_outsider_cannot_reprocess_someone_elses_meeting(
    client: TestClient, seeded, engine
):
    set_status(seeded["meeting_id"], "failed")
    with db_session.session_scope() as s:
        outsider = m.User(name="외부인", email="out2@example.com")
        s.add(outsider)
        s.flush()
        outsider_id = outsider.id

    login_as(client, outsider_id)
    assert client.post(f"/api/meetings/{seeded['meeting_id']}/reprocess").status_code == 403


# ══════════════════════════════════════════════════════════════
# 내 GitHub 아이디 (결함 112)
# ══════════════════════════════════════════════════════════════


def gh(client: TestClient, board_or_seeded: dict, value):
    return client.patch(
        f"/api/projects/{board_or_seeded['project_id']}/members/me/github",
        json={"github_login": value},
    )


def test_i_can_connect_my_github_account(client: TestClient, seeded):
    """⭐ 이 칸에 값을 넣는 코드가 **저장소에 0곳**이었다 (결함 112).

    읽는 곳은 넷입니다 — 이벤트 배분·백필·업무↔PR·연결 진단. 쓰는 곳은
    시드와 테스트뿐이었습니다. 실제로 배포하면 이 칸은 영원히 NULL 이고,
    그러면 **아무의 PR 도 주인을 못 찾습니다.**

    연결 진단은 이미 "GitHub 계정을 연결하지 않은 팀원이 있습니다" 라고
    경고하고 있었는데, **연결할 자리가 없었습니다.**
    """
    response = gh(client, seeded, "https://github.com/NewName")
    assert response.status_code == 200, response.text
    assert response.json()["github_login"] == "NewName"

    with db_session.session_scope() as s:
        member = s.scalars(
            select(m.Member).where(
                m.Member.project_id == seeded["project_id"],
                m.Member.user_id == seeded["user_ids"][0],
            )
        ).one()
        assert member.github_login == "NewName"


def test_the_member_list_carries_the_login_back(client: TestClient, seeded):
    """저장한 것이 화면으로 돌아와야 한다 — 안 돌아오면 매번 다시 적는다."""
    body = client.get(f"/api/meetings/{seeded['meeting_id']}/members").json()
    assert [x["github_login"] for x in body] == [
        "minsu-dev",
        "haneul-design",
        "jiwon-pm",
    ]


def test_an_empty_value_disconnects(client: TestClient, seeded):
    """잘못 적었을 때 지울 방법이 있어야 한다."""
    assert gh(client, seeded, "").json()["github_login"] is None


def test_a_login_github_could_not_have_made_is_refused(client: TestClient, seeded):
    """400 이고, 문구는 한국어다 (결함 78·86 과 같은 규칙)."""
    response = gh(client, seeded, "min su")
    assert response.status_code == 400
    assert "GitHub 아이디" in response.json()["detail"]


def test_i_cannot_claim_a_teammates_login(client: TestClient, seeded):
    """⭐ 남의 아이디를 적으면 **그 사람의 PR 이 통째로 내 기여**가 된다.

    예의 문제가 아니라 점수 문제입니다. 한 프로젝트 안에서 같은 아이디를
    둘이 쓸 수 없습니다.
    """
    response = gh(client, seeded, "haneul-design")
    assert response.status_code == 409
    assert "이미 쓰고 있는 아이디입니다" in response.json()["detail"]

    with db_session.session_scope() as s:
        mine = s.scalars(
            select(m.Member).where(
                m.Member.project_id == seeded["project_id"],
                m.Member.user_id == seeded["user_ids"][0],
            )
        ).one()
        assert mine.github_login == "minsu-dev", "거절했으면 내 값도 그대로여야 한다"


def test_claiming_a_teammates_login_in_another_case_is_also_refused(
    client: TestClient, seeded
):
    """⚠️ **대소문자만 바꾸면 통과**하면 막은 것이 아니다.

    GitHub 은 대소문자를 보존하지만 비교는 무시합니다 — `Haneul-Design`
    으로 등록하면 같은 웹훅이 두 사람에게 걸립니다.
    """
    assert gh(client, seeded, "Haneul-Design").status_code == 409


def test_keeping_my_own_login_is_not_a_conflict(client: TestClient, seeded):
    """자기 것을 다시 저장하는 것은 충돌이 아니다 — 흔한 일이다."""
    assert gh(client, seeded, "minsu-dev").status_code == 200
    assert gh(client, seeded, "MinSu-Dev").status_code == 200


def test_two_members_without_a_login_do_not_collide(client: TestClient, seeded):
    """⚠️ 아직 안 이은 사람끼리 **중복으로 걸리면** 아무도 등록을 못 한다."""
    with db_session.session_scope() as s:
        for row in s.scalars(
            select(m.Member).where(m.Member.project_id == seeded["project_id"])
        ).all():
            row.github_login = None

    assert gh(client, seeded, "brand-new").status_code == 200


def test_changing_my_github_login_is_always_logged(client: TestClient, seeded):
    """⭐ 이 한 줄이 바뀌면 그 사람의 기여도가 통째로 바뀐다.

    기여도 분쟁에서 필요한 것은 지금 값이 아니라 **누가 언제 그렇게
    적었는가**입니다.
    """
    gh(client, seeded, "renamed-me")

    with db_session.session_scope() as s:
        rows = s.scalars(
            select(m.AuditLog).where(m.AuditLog.action == "github_login_changed")
        ).all()
        assert len(rows) == 1
        assert rows[0].before == {"github_login": "minsu-dev"}
        assert rows[0].after == {"github_login": "renamed-me"}
        assert rows[0].actor_id == seeded["user_ids"][0]


def test_an_outsider_cannot_set_a_login_in_someone_elses_project(
    client: TestClient, seeded, engine
):
    """구성원이 아니면 403. 이 프로젝트의 기여도에 손댈 수 없다."""
    with db_session.session_scope() as s:
        outsider = m.User(name="외부인", email="out@example.com")
        s.add(outsider)
        s.flush()
        outsider_id = outsider.id

    login_as(client, outsider_id)
    assert gh(client, seeded, "sneaky").status_code == 403


# ══════════════════════════════════════════════════════════════
# 회의록 — 요약 말고 나머지 (결함 110·111)
# ══════════════════════════════════════════════════════════════


def test_the_meeting_carries_its_next_agenda(client: TestClient, seeded, engine):
    """⭐ 다음 안건이 **DB 에만 남아 있었다** (결함 110).

    LLM 이 만들고 `validation` 이 통과시킨 산출물인데, 내보내는 코드가
    저장소 어디에도 없어서 **읽는 사람이 0명**이었습니다. 오류는 안
    납니다 — 회의록의 한 칸이 조용히 사라질 뿐입니다.

    `models.py` 의 그 칸에는 같은 일을 한 번 겪었다는 주석이 이미
    붙어 있었습니다(&#34;`_serialize` 에 없어서 파이프라인 밖으로 나온 적이
    없었다&#34;). 그때는 파이프라인 → DB 를 이었고, **DB → 화면이 그대로
    남아 있었습니다.**
    """
    with db_session.session_scope() as s:
        meeting = s.get(m.Meeting, seeded["meeting_id"])
        meeting.next_agenda = ["배포 방식 결정", "진행 상황 공유"]

    body = client.get(f"/api/meetings/{seeded['meeting_id']}").json()
    assert body["next_agenda"] == ["배포 방식 결정", "진행 상황 공유"]


def test_a_meeting_without_a_next_agenda_sends_an_empty_list(
    client: TestClient, seeded
):
    """없으면 빈 목록. `null` 을 보내면 화면이 매번 그것을 가려야 한다."""
    body = client.get(f"/api/meetings/{seeded['meeting_id']}").json()
    assert body["next_agenda"] == []
    assert body["unresolved_issues"] == []


def test_the_meeting_carries_its_unresolved_issues(client: TestClient, seeded, engine):
    """⭐ 미해결 사안도 **쓰기만 하고 읽는 곳이 0곳**이었다 (결함 111).

    `meeting_events` 표는 파이프라인이 채우는데, 저장소 전체에서
    그 표를 **읽는 코드가 하나도 없었습니다.**

    근거 발화를 같이 싣습니다 — 근거 없이 &#34;이게 미해결입니다&#34; 라고만
    하면 사람은 확인할 방법이 없습니다.
    """
    with db_session.session_scope() as s:
        s.add(
            m.MeetingEvent(
                meeting_id=seeded["meeting_id"],
                event_type="unanswered_question",
                severity="info",
                start_ms=32_000,
                end_ms=38_000,
                evidence_utterance_ids=[105],
                detail={"content": "배포 방식을 정하지 못했습니다"},
            )
        )
        # 다른 종류의 회의 이벤트는 이 칸에 섞이지 않는다.
        s.add(
            m.MeetingEvent(
                meeting_id=seeded["meeting_id"],
                event_type="topic_drift",
                severity="info",
                start_ms=1_000,
                end_ms=2_000,
                evidence_utterance_ids=[101],
                detail={"content": "딴 얘기"},
            )
        )

    body = client.get(f"/api/meetings/{seeded['meeting_id']}").json()

    assert [i["content"] for i in body["unresolved_issues"]] == [
        "배포 방식을 정하지 못했습니다"
    ]
    issue = body["unresolved_issues"][0]
    assert issue["start_ms"] == 32_000
    assert issue["evidence_utterance_ids"] == [105]


def test_unresolved_issues_come_back_in_the_order_they_were_said(
    client: TestClient, seeded, engine
):
    """회의 순서대로. 저장 순서로 나오면 사람이 회의를 되짚을 수 없다."""
    with db_session.session_scope() as s:
        for start in (30_000, 5_000, 18_000):
            s.add(
                m.MeetingEvent(
                    meeting_id=seeded["meeting_id"],
                    event_type="unanswered_question",
                    severity="info",
                    start_ms=start,
                    end_ms=start + 1_000,
                    evidence_utterance_ids=[101],
                    detail={"content": f"{start}"},
                )
            )

    body = client.get(f"/api/meetings/{seeded['meeting_id']}").json()
    assert [i["start_ms"] for i in body["unresolved_issues"]] == [5_000, 18_000, 30_000]


def test_candidate_without_evidence_cannot_be_approved(client: TestClient, seeded, engine):
    """⭐ 환각을 사람이 "고쳐서" 통과시키는 경로를 만들면 안 된다.

    담당자·마감일이 다 채워져 있어도 근거 발화가 없으면 승인할 수 없다.
    LLM 출력 단계에서 이미 막지만(schema min_length=1), 승인 단계에서
    한 번 더 본다 — 방어가 한 겹뿐이면 그 겹이 뚫렸을 때 끝이다.
    """
    with db_session.session_scope() as s:
        hallucinated = m.MeetingTaskCandidate(
            meeting_id=seeded["meeting_id"],
            title="회의에 없던 업무",
            assignee_id=seeded["user_ids"][0],
            deadline=datetime(2026, 9, 20, tzinfo=UTC),
            confidence=0.9,
            evidence_utterance_ids=[],  # 근거 없음
        )
        s.add(hallucinated)
        s.flush()
        candidate_id = hallucinated.id

    response = client.post(
        f"/api/meetings/{seeded['meeting_id']}/candidates/review",
        json={
                        "items": [{"candidate_id": candidate_id, "approve": True}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["approved_count"] == 0
    # 서버는 코드를 돌려주고 화면이 문구로 옮긴다 (frontend candidates.ts)
    assert body["failures"][str(candidate_id)] == ["no_evidence"]


# ══════════════════════════════════════════════════════════════
# 웹훅 → 기여 이벤트 큐잉
# ══════════════════════════════════════════════════════════════
#
# 이 구간이 생기기 전까지 웹훅은 `GithubEvent` 행만 남기고 끝났습니다.
# `github_ingest.pr_to_events` 는 완성돼 있었는데 **호출자가 0곳**이라,
# GitHub 활동이 기여도에 도달한 적이 없었습니다.


def test_merged_pr_is_queued_for_ingestion(client: TestClient, seeded, monkeypatch):
    """⭐ 웹훅이 저장만 하고 끝나면 GitHub 활동은 기여도에 영영 못 온다."""
    from teamflow.tasks import dispatch

    queued: list[int] = []
    monkeypatch.setattr(
        dispatch, "enqueue_github_ingest", lambda event_id: queued.append(event_id)
    )

    response = post_webhook(client, pr_merged_payload())
    assert response.status_code == 202
    assert response.json()["queued"] is True
    assert len(queued) == 1


def test_the_queued_event_row_is_already_committed(client: TestClient, seeded, monkeypatch):
    """⭐ 커밋보다 먼저 큐에 넣으면 워커가 없는 행을 찾는다.

    회의 처리에서 이미 한 번 당한 결함이다. 커밋은 엔드포인트 본문이 아니라
    FastAPI 의존성 teardown 에서 일어나므로, 본문에서 넣으면 **항상** 커밋보다
    먼저다. 워커가 그 사이에 도착하면 `not_found` 로 끝나고 — 예외도 로그도
    없이 그 PR 의 기여가 사라진다.

    여기서는 큐잉 시점에 **그 행이 이미 보이는가**를 재서 순서를 고정한다.
    """
    from teamflow.db import session as db_session
    from teamflow.tasks import dispatch

    seen: list[bool] = []

    def _spy(event_id: int) -> None:
        with db_session.session_scope() as s:
            seen.append(s.get(m.GithubEvent, event_id) is not None)

    monkeypatch.setattr(dispatch, "enqueue_github_ingest", _spy)
    post_webhook(client, pr_merged_payload())

    assert seen == [True], "큐잉 시점에 GithubEvent 행이 아직 커밋되지 않았습니다"


def test_an_unmerged_pr_is_not_queued(client: TestClient, seeded, monkeypatch):
    """열기만 한 PR 은 기여가 아니다. API 호출도 낭비다."""
    from teamflow.tasks import dispatch

    queued: list[int] = []
    monkeypatch.setattr(
        dispatch, "enqueue_github_ingest", lambda event_id: queued.append(event_id)
    )

    payload = pr_merged_payload()
    payload["pull_request"]["merged"] = False
    post_webhook(client, payload)

    assert queued == []


def test_a_review_event_is_stored_but_not_queued(client: TestClient, seeded, monkeypatch):
    """리뷰는 병합된 PR 을 훑을 때 같이 집계된다 — 따로 부르면 중복 호출이다."""
    from teamflow.tasks import dispatch

    queued: list[int] = []
    monkeypatch.setattr(
        dispatch, "enqueue_github_ingest", lambda event_id: queued.append(event_id)
    )

    response = post_webhook(
        client,
        {
            "action": "submitted",
            "repository": {"full_name": "team/teamflow"},
            "review": {"id": 1, "submitted_at": "2026-09-01T12:00:00Z", "state": "APPROVED"},
            "pull_request": {"number": 42, "user": {"login": "minsu-dev"}},
        },
        event="pull_request_review",
        delivery="delivery-review-1",
    )

    assert response.status_code == 202
    assert response.json()["queued"] is False
    assert queued == []


# ══════════════════════════════════════════════════════════════
# 최종 확정 — **사람이** 확정한다 (docs/05 §5)
# ══════════════════════════════════════════════════════════════


def _final_url(seeded) -> str:
    return f"/api/projects/{seeded['project_id']}/contributions/final"


def test_nothing_is_confirmed_until_a_person_confirms_it(client: TestClient, seeded):
    """⭐ 확정 전에는 확정값이 **없어야** 한다.

    시스템이 계산한 숫자를 확정값처럼 보여주면, `docs/05` §5 가 ❌ 로
    금지한 "최종 점수를 시스템이 확정" 이 그대로 일어납니다.
    """
    add_contribution_events(seeded["project_id"], seeded["user_ids"][0], 5)

    body = client.get(_final_url(seeded)).json()
    assert body["finals"] == []
    assert body["run_id"] == 0


def test_confirming_pins_the_calculation_it_was_based_on(client: TestClient, seeded):
    """⭐ 확정은 **그 순간의 계산**을 가리켜야 한다.

    기여도는 조회할 때마다 이벤트 로그에서 다시 계산합니다. 그래서 확정
    시점의 값을 못 박아 두지 않으면, 확정한 뒤에 이벤트가 하나 더
    들어오는 것만으로 확정값이 가리키던 근거가 달라집니다.

    `score_runs`·`score_results` 는 처음부터 스키마에 있었는데 **쓰는
    코드가 0곳**이었습니다.
    """
    users = seeded["user_ids"]
    add_contribution_events(seeded["project_id"], users[0], 5)
    add_contribution_events(seeded["project_id"], users[1], 3)

    response = client.post(
        _final_url(seeded), json={"finals": [{"user_id": u} for u in users[:2]]}
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["run_id"] > 0

    with db_session.session_scope() as s:
        runs = s.scalars(select(m.ScoreRun)).all()
        assert len(runs) == 1
        results = s.scalars(select(m.ScoreResult)).all()
        assert results, "카테고리별 결과가 하나도 안 남았습니다"
        assert all(r.run_id == runs[0].id for r in results)
        assert all(r.evidence_ids is not None for r in results), "근거 없는 점수 금지"


def test_the_system_value_is_kept_next_to_the_human_one(client: TestClient, seeded):
    """⭐ 조정해도 시스템 값을 **지우지 않는다.**

    둘을 나란히 남겨야 나중에 "왜 달랐나" 를 물을 수 있습니다. 덮어쓰면
    조정이 있었다는 사실 자체가 사라집니다.
    """
    users = seeded["user_ids"]
    add_contribution_events(seeded["project_id"], users[0], 5)
    add_contribution_events(seeded["project_id"], users[1], 3)

    body = client.post(
        _final_url(seeded),
        json={
            "finals": [
                {"user_id": users[0], "final_value": 40.0, "reason": "발표 준비를 도맡음"},
                {"user_id": users[1]},
            ]
        },
    ).json()

    adjusted = next(f for f in body["finals"] if f["user_id"] == users[0])
    assert adjusted["final_value"] == 40.0
    assert adjusted["system_value"] != 40.0, "시스템 값이 조정값으로 덮였습니다"
    assert adjusted["reason"] == "발표 준비를 도맡음"
    assert adjusted["adjusted_by"] == seeded["user_ids"][0] or adjusted["adjusted_by"]

    kept = next(f for f in body["finals"] if f["user_id"] == users[1])
    assert kept["final_value"] == kept["system_value"], "안 건드리면 시스템 값 그대로"


def test_changing_the_number_without_a_reason_is_refused(client: TestClient, seeded):
    """⚠️ 근거 없는 조정은 근거 없는 점수와 같다.

    이 프로젝트가 "모든 점수에 근거" 를 내세우면서 **사람의 조정만**
    근거 없이 통과시키면 앞뒤가 안 맞습니다.
    """
    users = seeded["user_ids"]
    add_contribution_events(seeded["project_id"], users[0], 5)

    response = client.post(
        _final_url(seeded), json={"finals": [{"user_id": users[0], "final_value": 99.0}]}
    )
    assert response.status_code == 400
    assert "이유" in response.json()["detail"]


def test_a_share_outside_zero_to_hundred_is_refused(client: TestClient, seeded):
    """⭐ 있을 수 없는 값은 확정되지 않는다 (결함 215).

    베타에서 `-5 · -894 · 999` 를 넣었더니 **201** 이 나왔습니다. 셋의
    합이 정확히 100 이라 화면의 합계 경고도 조용했고, 그 값이 그대로
    확정 기록이 됐습니다.

    ⛔ 이것은 불변식 넷째("시스템은 판정하지 않습니다")의 예외가 **아닙니다.**
    팀이 시스템 값과 다르게 정하는 것은 얼마든지 되고(사유로 남습니다),
    여기서 막는 것은 다른 의견이 아니라 **몫이 될 수 없는 값**입니다.
    """
    users = seeded["user_ids"]
    add_contribution_events(seeded["project_id"], users[0], 5)

    for bad in (-5.0, -894.0, 999.0, 100.001):
        response = client.post(
            _final_url(seeded),
            json={"finals": [{"user_id": users[0], "final_value": bad, "reason": "실험"}]},
        )
        assert response.status_code == 400, f"{bad} 이 통과했습니다: {response.text}"
        assert "0~100" in response.json()["detail"]

    # 경계는 **막지 않습니다** — 한 사람이 전부 한 경우가 실제로 있습니다.
    for ok_value in (0.0, 100.0):
        response = client.post(
            _final_url(seeded),
            json={"finals": [{"user_id": users[0], "final_value": ok_value, "reason": "실험"}]},
        )
        assert response.status_code == 201, f"{ok_value} 가 막혔습니다: {response.text}"


def test_a_sum_other_than_hundred_is_still_allowed(client: TestClient, seeded):
    """⚠️ 합계 100 은 **강제하지 않습니다.**

    팀 일부만 확정하는 경우가 있습니다. 위 범위 검사를 넣으면서 여기까지
    막으면, 두 사람만 확정하려던 팀이 갑자기 못 하게 됩니다.
    """
    users = seeded["user_ids"]
    add_contribution_events(seeded["project_id"], users[0], 5)
    add_contribution_events(seeded["project_id"], users[1], 3)

    response = client.post(
        _final_url(seeded),
        json={
            "finals": [
                {"user_id": users[0], "final_value": 10.0, "reason": "일부만 확정"},
                {"user_id": users[1], "final_value": 20.0, "reason": "일부만 확정"},
            ]
        },
    )
    assert response.status_code == 201, response.text


def test_confirming_leaves_an_audit_trail(client: TestClient, seeded):
    """조정은 판단이다. 판단에는 **주체**가 있어야 이의를 제기할 상대가 생긴다."""
    users = seeded["user_ids"]
    add_contribution_events(seeded["project_id"], users[0], 5)

    client.post(
        _final_url(seeded),
        json={"finals": [{"user_id": users[0], "final_value": 55.0, "reason": "합의"}]},
    )

    with db_session.session_scope() as s:
        log = s.scalars(
            select(m.AuditLog).where(m.AuditLog.action == "score_adjusted")
        ).one()
        assert log.actor_id is not None
        assert log.after["final_value"] == 55.0
        assert log.after["reason"] == "합의"


def test_removing_a_member_does_not_break_contributions(client: TestClient, seeded):
    """⭐ 팀원을 내보내도 기여도는 **계속 보여야** 한다 (결함 222).

    베타에서 「내보내기」를 한 번 누른 뒤로 기여도가 **영영 500** 이었습니다.
    보는 것도 확정하는 것도 안 됐습니다 — 이 제품의 한가운데가 버튼 하나로
    죽은 것입니다.

    원인은 `score_team` 이 **기여 기록이 있는 모든 사람**을 돌면서
    `profiles[uid]` 를 무조건 찾은 것입니다. 내보낸 사람은 기록은 남고
    (「그 사람이 한 일은 그대로 남습니다」 — 내보내기 확인 문구)
    프로파일만 사라지므로 `KeyError` 가 났습니다.
    """
    users = seeded["user_ids"]
    add_contribution_events(seeded["project_id"], users[0], 5)
    add_contribution_events(seeded["project_id"], users[1], 3)
    add_contribution_events(seeded["project_id"], users[2], 2)

    before = client.get(f"/api/projects/{seeded['project_id']}/contributions")
    assert before.status_code == 200
    assert len(before.json()["members"]) == 3

    # 내보내려면 권한이 있어야 합니다 — 첫 사람을 소유자로 올립니다.
    with db_session.session_scope() as s:
        me = s.scalars(
            select(m.Member).where(
                m.Member.project_id == seeded["project_id"],
                m.Member.user_id == users[0],
            )
        ).one()
        me.project_role = vocab.ProjectRole.OWNER

    removed = client.delete(f"/api/projects/{seeded['project_id']}/members/{users[2]}")
    assert removed.status_code == 204, removed.text

    after = client.get(f"/api/projects/{seeded['project_id']}/contributions")
    assert after.status_code == 200, after.text
    body = after.json()
    # ⛔ **계산에서 빠지지 않습니다.** 빼면 남은 사람들의 몫이 조용히
    #    부풀고, 그건 `remove_member` 가 기록을 남겨 두는 이유와 정면으로
    #    어긋납니다 — 그 엔드포인트 주석이 그렇게 적어 두고 있습니다.
    assert [mm["user_id"] for mm in body["members"]] == sorted(users)
    # 다만 **누가 나갔는지는 알려 줘야** 화면이 「사용자 #3」 을 안 띄웁니다.
    assert [f["user_id"] for f in body["former_members"]] == [users[2]]
    assert body["former_members"][0]["name"], "이름 없이 보내면 화면이 번호로 부릅니다"

    # 확정도 되어야 합니다 — 여기도 같은 계산을 부릅니다.
    confirmed = client.post(
        _final_url(seeded), json={"finals": [{"user_id": u} for u in users[:2]]}
    )
    assert confirmed.status_code == 201, confirmed.text


def test_an_outsider_cannot_confirm(client: TestClient, seeded):
    """기여도는 성적에 반영될 수 있는 값이다. 남의 팀 것을 확정할 이유가 없다."""
    add_contribution_events(seeded["project_id"], seeded["user_ids"][0], 5)

    with db_session.session_scope() as s:
        outsider = m.User(name="외부인", email="out@example.com")
        s.add(outsider)
        s.flush()
        outsider_id = outsider.id

    login_as(client, outsider_id)
    response = client.post(
        _final_url(seeded), json={"finals": [{"user_id": seeded["user_ids"][0]}]}
    )
    assert response.status_code in (403, 404)


def test_meeting_becomes_confirmed_when_every_candidate_is_decided(
    client: TestClient, seeded
):
    """⭐ **다 검토했는데도 "검토 필요" 였습니다** (결함 84).

    화면에는 `confirmed` 라벨("검토 완료")도, 그 상태의 "다음에 할 일"
    가지도, 승인 화면의 빈 상태 문구도 있었습니다. 그런데 **서버가 그 값을
    한 번도 넣지 않았습니다.** 그래서 사람이 후보를 전부 결정해도 회의는
    `needs_review` 로 남았고, 홈 화면은 남은 후보 0건을 보고 이렇게
    말했습니다 —

        검토 필요 — 검토할 업무 후보가 없습니다 — 회의에서 업무가 나오지 않았습니다

    업무는 나왔고, 사람이 전부 검토한 뒤였습니다. 브라우저에서 재현했습니다.
    """
    meeting_id = seeded["meeting_id"]
    with db_session.session_scope() as s:
        s.get(m.Meeting, meeting_id).status = m.MeetingStatus.NEEDS_REVIEW.value

    ids = seeded["candidate_ids"]
    # 마지막 하나만 남기고 결정한다 — 아직 끝난 게 아니다
    client.post(
        f"/api/meetings/{meeting_id}/candidates/review",
        json={
            "reviewer_id": seeded["user_ids"][2],
            "items": [{"candidate_id": cid, "approve": False} for cid in ids[:-1]],
        },
    )
    with db_session.session_scope() as s:
        assert s.get(m.Meeting, meeting_id).status == m.MeetingStatus.NEEDS_REVIEW.value

    client.post(
        f"/api/meetings/{meeting_id}/candidates/review",
        json={
            "reviewer_id": seeded["user_ids"][2],
            "items": [{"candidate_id": ids[-1], "approve": False}],
        },
    )
    with db_session.session_scope() as s:
        assert s.get(m.Meeting, meeting_id).status == m.MeetingStatus.CONFIRMED.value


def test_a_meeting_with_no_candidates_stays_in_needs_review(client: TestClient, seeded):
    """⚠️ 후보가 **처음부터 0건**이면 옮기지 않습니다.

    그 회의는 사람이 볼 것이 없었던 것이지 검토를 마친 것이 아닙니다.
    화면의 "회의에서 업무가 나오지 않았습니다" 가 그때는 **맞는 말**이고,
    두 상황을 가르는 것이 이 전이의 요점입니다. 뭉개면 결함 84 가
    반대 방향으로 되살아납니다.
    """
    meeting_id = seeded["meeting_id"]
    with db_session.session_scope() as s:
        for cid in seeded["candidate_ids"]:
            s.delete(s.get(m.MeetingTaskCandidate, cid))
        s.get(m.Meeting, meeting_id).status = m.MeetingStatus.NEEDS_REVIEW.value

    # ⚠️ **`items: []` 로는 이 자리를 못 밟습니다.** 엔드포인트가 `min_length=1`
    # 로 422 를 돌려주기 때문입니다. 처음 쓴 이 테스트가 그래서 **아무것도 안
    # 보고 통과했습니다** — 이 세션에서 "내 검사가 다른 이유로 통과 중" 을
    # 겪은 일곱 번째입니다. 실제로 닿는 길은 **이미 사라진 후보 번호**를
    # 보내는 것이고(재처리 뒤 옛 화면이 제출하면 그렇게 됩니다), 그때
    # 후보 수가 0 인 회의가 confirmed 로 넘어가면 안 됩니다.
    response = client.post(
        f"/api/meetings/{meeting_id}/candidates/review",
        json={
            "reviewer_id": seeded["user_ids"][2],
            "items": [{"candidate_id": seeded["candidate_ids"][0], "approve": False}],
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["failures"], "사라진 후보는 실패로 보고돼야 합니다"

    with db_session.session_scope() as s:
        assert s.get(m.Meeting, meeting_id).status == m.MeetingStatus.NEEDS_REVIEW.value


def test_confirming_does_not_run_over_a_failed_meeting(client: TestClient, seeded):
    """처리에 실패한 회의를 검토했다고 덮어쓰지 않습니다.

    `failed` 는 "트랙을 확인하세요" 를 띄우는 상태입니다. 남은 후보가
    없다는 이유로 `confirmed` 로 옮기면 그 안내가 사라집니다.
    """
    meeting_id = seeded["meeting_id"]
    with db_session.session_scope() as s:
        s.get(m.Meeting, meeting_id).status = m.MeetingStatus.FAILED.value

    client.post(
        f"/api/meetings/{meeting_id}/candidates/review",
        json={
            "reviewer_id": seeded["user_ids"][2],
            "items": [
                {"candidate_id": cid, "approve": False}
                for cid in seeded["candidate_ids"]
            ],
        },
    )
    with db_session.session_scope() as s:
        assert s.get(m.Meeting, meeting_id).status == m.MeetingStatus.FAILED.value


# ══════════════════════════════════════════════════════════════
# 근거 발화 역추적 (docs/19 §24)
# ══════════════════════════════════════════════════════════════


def _seed_utterances(engine, meeting_id: int, speaker_id: int) -> list[int]:
    """근거로 쓸 발화 셋. 화자 출처를 일부러 다르게 둔다."""
    with Session(engine) as s:
        rows = [
            m.Utterance(
                meeting_id=meeting_id,
                speaker_id=speaker_id,
                start_ms=32_000,
                end_ms=38_000,
                text="배포 방식은 다음 회의로 미룹시다",
                speaker_source="track",
                speaker_confidence=1.0,
            ),
            m.Utterance(
                meeting_id=meeting_id,
                speaker_id=None,
                start_ms=10_000,
                end_ms=14_000,
                text="로그인 API 는 제가 맡을게요",
                speaker_source="diarization",
                speaker_confidence=0.41,
            ),
        ]
        s.add_all(rows)
        s.commit()
        return [r.id for r in rows]


def test_utterances_returns_text_for_the_ids_asked(client: TestClient, engine, seeded):
    """⭐ 이 엔드포인트가 없는 동안 화면은 `근거 #5` 를 적어 놓고
    눌러도 아무 데도 못 갔다 — 말은 하고 그 말을 지킬 자리를 안 준 것."""
    ids = _seed_utterances(engine, seeded["meeting_id"], seeded["user_ids"][0])
    response = client.get(
        f"/api/meetings/{seeded['meeting_id']}/utterances?ids={ids[0]},{ids[1]}"
    )
    assert response.status_code == 200
    body = response.json()
    assert {r["id"] for r in body} == set(ids)
    texts = " ".join(r["text"] for r in body)
    assert "배포 방식은 다음 회의로" in texts
    assert "로그인 API 는 제가" in texts


def test_utterances_come_back_in_meeting_order(client: TestClient, engine, seeded):
    """근거 둘을 나란히 읽을 때 회의에서 말한 순서여야 한다 —
    id 순으로 주면 나중에 한 말이 위로 온다."""
    ids = _seed_utterances(engine, seeded["meeting_id"], seeded["user_ids"][0])
    body = client.get(
        f"/api/meetings/{seeded['meeting_id']}/utterances?ids={ids[0]},{ids[1]}"
    ).json()
    assert [r["start_ms"] for r in body] == sorted(r["start_ms"] for r in body)


def test_utterances_say_how_the_speaker_was_decided(client: TestClient, engine, seeded):
    """⭐ **화자 출처를 감추면 안 된다.**

    `track`(멀티트랙 확정)과 `diarization`(미매핑)은 "누가 말했다" 의
    무게가 완전히 다르다. 원문만 주고 출처를 빼면, 추측한 화자를
    사실처럼 읽게 된다."""
    ids = _seed_utterances(engine, seeded["meeting_id"], seeded["user_ids"][0])
    body = client.get(
        f"/api/meetings/{seeded['meeting_id']}/utterances?ids={ids[0]},{ids[1]}"
    ).json()
    by_id = {r["id"]: r for r in body}
    assert by_id[ids[0]]["speaker_source"] == "track"
    assert by_id[ids[0]]["speaker_name"] is not None
    assert by_id[ids[1]]["speaker_source"] == "diarization"
    assert by_id[ids[1]]["speaker_confidence"] == pytest.approx(0.41, abs=0.001)
    # 화자를 못 정한 발화에 이름을 지어내지 않는다
    assert by_id[ids[1]]["speaker_name"] is None


def test_utterances_do_not_leak_across_meetings(client: TestClient, engine, seeded):
    """⭐ 다른 회의의 발화를 이 회의 id 로 물으면 안 나와야 한다.

    나오면 후보가 남의 회의 발화를 근거로 달고 있어도 화면에서
    구분되지 않는다 — 게다가 그 회의의 내용이 새는 것이다."""
    with Session(engine) as s:
        other = m.Meeting(
            project_id=seeded["project_id"],
            title="다른 회의",
            started_at=NOW,
            duration_sec=600,
            status="needs_review",
            started_by=seeded["user_ids"][0],
        )
        s.add(other)
        s.flush()
        leak = m.Utterance(
            meeting_id=other.id,
            speaker_id=seeded["user_ids"][0],
            start_ms=0,
            end_ms=1000,
            text="이 문장은 새면 안 됩니다",
            speaker_source="track",
        )
        s.add(leak)
        s.commit()
        leak_id = leak.id

    body = client.get(
        f"/api/meetings/{seeded['meeting_id']}/utterances?ids={leak_id}"
    ).json()
    assert body == []


def test_utterances_need_membership(client: TestClient, engine, seeded):
    """회의 내용이다. 팀원이 아니면 원문을 볼 수 없어야 한다."""
    ids = _seed_utterances(engine, seeded["meeting_id"], seeded["user_ids"][0])
    with Session(engine) as s:
        outsider = m.User(name="남", email="outsider@example.com", password_hash="x")
        s.add(outsider)
        s.commit()
        outsider_id = outsider.id
    login_as(client, outsider_id)
    response = client.get(f"/api/meetings/{seeded['meeting_id']}/utterances?ids={ids[0]}")
    assert response.status_code in (403, 404)


def test_utterances_reject_garbage_ids(client: TestClient, seeded):
    """⚠️ 숫자가 아닌 것을 조용히 버리지 않는다. 오타 하나로 빈 목록을
    받아 들고 "근거가 없다" 로 읽으면 안 된다."""
    response = client.get(f"/api/meetings/{seeded['meeting_id']}/utterances?ids=5,abc")
    assert response.status_code == 400


def test_utterances_are_capped(client: TestClient, seeded):
    """대본 전체를 떠 가는 통로가 되면 안 된다. 그 화면은 아직 없다."""
    many = ",".join(str(i) for i in range(1, 60))
    response = client.get(f"/api/meetings/{seeded['meeting_id']}/utterances?ids={many}")
    assert response.status_code == 400


def test_utterances_with_no_ids_returns_empty(client: TestClient, seeded):
    """`ids` 없이 부르면 회의 전체 대본이 나오지 않는다."""
    assert client.get(f"/api/meetings/{seeded['meeting_id']}/utterances").json() == []
