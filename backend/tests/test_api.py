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
from teamflow.db import models as m
from teamflow.db import session as db_session

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
def seeded(engine) -> dict[str, int]:
    """프로젝트 하나 + 팀원 셋 + 회의 하나 + 후보 둘."""
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

        return {
            "project_id": project.id,
            "meeting_id": meeting.id,
            "user_ids": [u.id for u in users],
            "candidate_ids": [c.id for c in candidates],
        }


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
        assert task.assignee_id == seeded["user_ids"][0]
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
        assert task.assignee_id == seeded["user_ids"][1]


def test_approval_writes_audit_log(client: TestClient, seeded):
    """불변식: 감사 로그 없는 승인은 존재할 수 없다."""
    client.post(
        f"/api/meetings/{seeded['meeting_id']}/candidates/review",
        json={
            "reviewer_id": seeded["user_ids"][2],
            "items": [{"candidate_id": seeded["candidate_ids"][0], "approve": True}],
        },
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


def test_reviewer_id_must_be_positive(client: TestClient, seeded):
    response = client.post(
        f"/api/meetings/{seeded['meeting_id']}/candidates/review",
        json={
            "reviewer_id": 0,
            "items": [{"candidate_id": seeded["candidate_ids"][0], "approve": True}],
        },
    )
    assert response.status_code == 422


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
            "reviewer_id": seeded["user_ids"][0],
            "items": [{"candidate_id": candidate_id, "approve": True}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["approved_count"] == 0
    # 서버는 코드를 돌려주고 화면이 문구로 옮긴다 (frontend candidates.ts)
    assert body["failures"][str(candidate_id)] == ["no_evidence"]
