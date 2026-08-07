"""GitHub 연결이 살아 있는지 사람이 알 수 있는가.

이 파일이 고정하는 것은 docs/15 §4.2 의 1번입니다.

> 저장소를 적어 넣어도 웹훅이 오는지, 서명이 맞는지, 설치 id 가 유효한지
> 화면에 아무것도 안 나옵니다. **틀리면 오류 없이 기여도만 빕니다.**

여기서 재현한 결함 넷:

    34  저장소 표기의 대소문자가 다르면 배달이 전부 조용히 버려진다
    35  대소문자를 달리 적으면 두 프로젝트가 같은 저장소를 가질 수 있다
    36  구성원이 설치 id 에 아무 숫자나 써 넣을 수 있다
    37  이름을 적기만 하면 GitHub 이벤트 0건인데 신뢰도가 오른다
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from teamflow.config import Settings, get_settings
from teamflow.db import models as m
from teamflow.db import session as db_session

from .conftest import login_as
from .test_api import (  # noqa: F401
    WEBHOOK_SECRET,
    client,
    engine,
    post_webhook,
    pr_merged_payload,
    seeded,
)

NOW = datetime(2026, 9, 1, 12, 0, tzinfo=UTC)


@pytest.fixture
def configured_client(client: TestClient) -> Iterator[TestClient]:
    """GitHub App 자격 증명까지 갖춘 서버.

    기본 테스트 서버에는 앱 id·개인키가 없습니다. 그건 그것대로 진단해야
    할 상태이고(`test_health_says_the_server_cannot_call_github`), 여기서는
    **연결 자체**를 보고 싶으므로 갖춘 상태로 바꿉니다.
    """
    from teamflow.api.main import app

    app.dependency_overrides[get_settings] = lambda: Settings(
        environment="test",
        github_webhook_secret=WEBHOOK_SECRET,
        github_app_id="123456",
        github_private_key=(
            "-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----"
        ),
        database_url="sqlite://",
    )
    yield client


def ping_payload(repo: str = "team/teamflow", installation: int | None = 4242) -> dict:
    """App 을 설치하면 GitHub 이 **가장 먼저** 보내는 것."""
    body: dict = {
        "zen": "Non-blocking is better than blocking.",
        "hook_id": 1,
        "repository": {"full_name": repo},
    }
    if installation is not None:
        body["installation"] = {"id": installation}
    return body


def set_repo(project_id: int, repo: str) -> None:
    with db_session.session_scope() as s:
        s.get(m.Project, project_id).github_repo = repo


def project_row(project_id: int) -> m.Project:
    with db_session.session_scope() as s:
        s.get(m.Project, project_id)
        return s.get(m.Project, project_id)


# ══════════════════════════════════════════════════════════════
# 결함 34 — 대소문자
# ══════════════════════════════════════════════════════════════


def test_a_delivery_finds_the_project_even_when_the_case_differs(
    client: TestClient, seeded, engine
):
    """⭐ **결함 34.**

    사람은 설정 화면에 소문자로 적고(`team/teamflow`), GitHub 은 정식
    표기로 배달합니다(`Team/TeamFlow`). 예전에는 이 둘이 다른 문자열이라
    배달이 "연결되지 않은 저장소" 로 버려졌습니다. 팀은 PR 을 백 번
    병합해도 기여도가 0 이고, 아무 곳에도 오류가 남지 않았습니다.
    """
    set_repo(seeded["project_id"], "team/teamflow")

    response = post_webhook(client, pr_merged_payload(repo="Team/TeamFlow"))

    assert response.status_code == 202
    assert response.json()["status"] == "accepted"
    with db_session.session_scope() as s:
        stored = s.scalars(select(m.GithubEvent)).all()
        assert len(stored) == 1


def test_the_delivery_teaches_us_the_canonical_spelling(client: TestClient, seeded):
    """GitHub 이 쓰는 표기로 화면을 맞춰 줍니다 — 링크를 만들 때 필요합니다."""
    set_repo(seeded["project_id"], "team/teamflow")

    post_webhook(client, pr_merged_payload(repo="Team/TeamFlow"))

    with db_session.session_scope() as s:
        project = s.get(m.Project, seeded["project_id"])
        assert project.github_repo == "Team/TeamFlow"
        # 대조용 표기는 소문자 그대로여야 다음 배달도 붙습니다.
        assert project.github_repo_key == "team/teamflow"


def test_a_different_repository_still_does_not_match(client: TestClient, seeded):
    """느슨하게 만든 게 아니라 **대소문자만** 무시하는지 확인합니다."""
    set_repo(seeded["project_id"], "team/teamflow")

    response = post_webhook(client, pr_merged_payload(repo="team/teamflow-web"))

    assert response.json()["reason"] == "unlinked_repo"


# ══════════════════════════════════════════════════════════════
# 배달이 곧 증거
# ══════════════════════════════════════════════════════════════


def test_the_ping_is_what_proves_the_app_is_installed(client: TestClient, seeded):
    """⭐ `ping` 은 App 설치 직후 가장 먼저 오는 배달입니다.

    `normalize` 는 이걸 버립니다(저장할 이벤트가 아니므로). 그래서 예전에는
    방금 연결을 마친 팀에게도 "아직 아무 배달도 없습니다" 가 나갔습니다.
    연결 확인의 **가장 이른 신호**를 놓치고 있었습니다.
    """
    set_repo(seeded["project_id"], "team/teamflow")

    response = post_webhook(client, ping_payload(), event="ping")

    assert response.status_code == 202
    with db_session.session_scope() as s:
        project = s.get(m.Project, seeded["project_id"])
        assert project.github_verified_at is not None
        # ping 은 저장할 이벤트가 아닙니다 — 확인만 하고 지나갑니다.
        assert s.query(m.GithubEvent).count() == 0


def test_the_installation_id_comes_only_from_a_signed_delivery(
    client: TestClient, seeded
):
    """⭐ **결함 36.**

    이 값으로 워커가 그 설치의 액세스 토큰을 발급합니다. 요청 본문으로
    받으면 남의 설치 권한으로 GitHub API 를 부르게 만들 수 있습니다.
    """
    set_repo(seeded["project_id"], "team/teamflow")

    post_webhook(client, ping_payload(installation=4242), event="ping")

    with db_session.session_scope() as s:
        assert s.get(m.Project, seeded["project_id"]).github_installation_id == 4242


def test_an_unsigned_delivery_proves_nothing(client: TestClient, seeded):
    """서명이 틀리면 본문 전체를 믿을 수 없습니다 — 설치 id 도 마찬가지입니다."""
    set_repo(seeded["project_id"], "team/teamflow")

    response = post_webhook(client, ping_payload(), event="ping", secret="wrong")

    assert response.status_code == 401
    with db_session.session_scope() as s:
        project = s.get(m.Project, seeded["project_id"])
        assert project.github_verified_at is None
        assert project.github_installation_id is None


# ══════════════════════════════════════════════════════════════
# 안 붙은 배달 — 오타의 유일한 증거
# ══════════════════════════════════════════════════════════════


def test_an_unlinked_delivery_leaves_a_trace(client: TestClient, seeded):
    """⭐ 이게 없으면 저장소 이름 오타는 **증거를 남기지 않습니다.**"""
    set_repo(seeded["project_id"], "team/teamflow")

    post_webhook(client, pr_merged_payload(repo="tjgksmf1012/testproject"))

    with db_session.session_scope() as s:
        rows = s.scalars(select(m.GithubUnlinkedDelivery)).all()
        assert len(rows) == 1
        assert rows[0].repo == "tjgksmf1012/testproject"
        assert rows[0].delivery_count == 1


def test_repeat_deliveries_count_up_instead_of_piling_rows(client: TestClient, seeded):
    set_repo(seeded["project_id"], "team/teamflow")

    for n in range(3):
        post_webhook(
            client, pr_merged_payload(repo="other/repo"), delivery=f"delivery-{n}"
        )

    with db_session.session_scope() as s:
        rows = s.scalars(select(m.GithubUnlinkedDelivery)).all()
        assert len(rows) == 1
        assert rows[0].delivery_count == 3


def test_the_trace_keeps_nothing_but_the_name(client: TestClient, seeded):
    """어느 프로젝트에도 안 붙은 배달은 **우리 자료가 아닙니다.**

    저장소 이름과 횟수·시각만 남깁니다. 본문·작성자·PR 제목은 남기지
    않습니다 — 보관할 근거가 없습니다.
    """
    set_repo(seeded["project_id"], "team/teamflow")

    post_webhook(client, pr_merged_payload(repo="other/repo", login="someone-secret"))

    with db_session.session_scope() as s:
        row = s.scalars(select(m.GithubUnlinkedDelivery)).one()
        columns = {c.name for c in row.__table__.columns}
    assert columns == {
        "id",
        "repo_key",
        "repo",
        "delivery_count",
        "first_seen_at",
        "last_seen_at",
    }


# ══════════════════════════════════════════════════════════════
# 진단 화면
# ══════════════════════════════════════════════════════════════


def test_health_needs_membership(client: TestClient, seeded):
    """안 붙은 배달이 여기 섞여 나갑니다. 아무나 부를 수 있으면 **App 이
    설치된 저장소를 캐내는 도구**가 됩니다."""
    with db_session.session_scope() as s:
        outsider = m.User(name="남", email="outsider@example.com")
        s.add(outsider)
        s.flush()
        outsider_id = outsider.id

    login_as(client, outsider_id)
    response = client.get(f"/api/projects/{seeded['project_id']}/github")
    assert response.status_code == 403


def test_health_says_waiting_before_any_delivery(client: TestClient, seeded):
    set_repo(seeded["project_id"], "team/teamflow")

    body = client.get(f"/api/projects/{seeded['project_id']}/github").json()

    assert body["code"] == "waiting_for_delivery"
    assert body["verified_at"] is None
    assert body["next_step"]


def test_health_names_the_repository_to_fix(client: TestClient, seeded):
    """⭐ 가장 값어치 있는 진단 — 무엇을 무엇으로 고쳐야 하는지 말합니다.

    사람이 소유자를 잘못 적었고, 진짜 저장소에서는 배달이 오고 있습니다.
    예전에는 화면이 "아직 아무것도 안 왔습니다" 라고만 말했고, 사람은
    App 설치를 의심하며 엉뚱한 곳을 고쳤습니다.
    """
    set_repo(seeded["project_id"], "tjgksmf/testproject")

    post_webhook(client, pr_merged_payload(repo="tjgksmf1012/testproject"))

    body = client.get(f"/api/projects/{seeded['project_id']}/github").json()

    assert body["code"] == "repo_name_mismatch"
    assert body["severity"] == "bad"
    assert "tjgksmf1012/testproject" in body["next_step"]


def test_health_does_not_leak_unrelated_repositories(client: TestClient, seeded):
    """⚠️ 이게 새면 진단 화면이 저장소 목록 캐내기 도구가 됩니다."""
    set_repo(seeded["project_id"], "team/teamflow")

    post_webhook(client, pr_merged_payload(repo="somebody-else/private-thing"))

    body = client.get(f"/api/projects/{seeded['project_id']}/github").json()

    assert body["code"] != "repo_name_mismatch"
    assert "somebody-else" not in str(body)
    assert "private-thing" not in str(body)


def test_health_says_the_server_cannot_call_github(client: TestClient, seeded):
    """배달은 오는데 서버에 App 자격 증명이 없는 상태.

    이벤트는 저장되지만 PR 의 변경 파일을 조회할 수 없어 **기여 이벤트로
    바뀌지 않습니다.** 워커 로그에만 남고 화면은 조용했습니다 — 팀은
    저장소 설정을 몇 번이고 다시 확인하게 됩니다. 팀이 고칠 수 있는
    문제가 아닙니다.
    """
    set_repo(seeded["project_id"], "team/teamflow")
    post_webhook(client, ping_payload(), event="ping")

    body = client.get(f"/api/projects/{seeded['project_id']}/github").json()

    assert body["code"] == "server_missing_app_credentials"
    assert "관리자" in body["next_step"]


def test_health_is_ok_once_deliveries_land_on_a_known_member(
    configured_client: TestClient, seeded
):
    set_repo(seeded["project_id"], "team/teamflow")

    post_webhook(configured_client, pr_merged_payload(login="minsu-dev"))

    body = configured_client.get(f"/api/projects/{seeded['project_id']}/github").json()

    assert body["code"] == "connected"
    assert body["severity"] == "ok"
    assert body["delivery_count"] == 1
    assert body["verified_at"] is not None


def test_health_warns_about_members_without_a_github_account(
    configured_client: TestClient, seeded
):
    """계정을 안 건 팀원은 **조용히 0** 이 됩니다. 연결이 정상이어도 알려야 합니다."""
    with db_session.session_scope() as s:
        member = s.scalars(
            select(m.Member).where(m.Member.project_id == seeded["project_id"])
        ).all()[1]
        member.github_login = None

    set_repo(seeded["project_id"], "team/teamflow")
    post_webhook(configured_client, pr_merged_payload(login="minsu-dev"))

    body = configured_client.get(f"/api/projects/{seeded['project_id']}/github").json()

    assert body["code"] == "connected"
    assert any("이하늘" in w for w in body["warnings"])


def test_health_spots_a_repository_that_belongs_to_someone_else(
    configured_client: TestClient, seeded
):
    """활동하는 계정이 팀원과 하나도 안 겹치면 남의 저장소를 적었을 수 있습니다."""
    set_repo(seeded["project_id"], "team/teamflow")

    post_webhook(configured_client, pr_merged_payload(login="a-total-stranger"))

    body = configured_client.get(f"/api/projects/{seeded['project_id']}/github").json()

    assert body["code"] == "actors_do_not_match"
    assert body["severity"] == "bad"


# ══════════════════════════════════════════════════════════════
# 결함 37 — 신뢰도
# ══════════════════════════════════════════════════════════════


def test_typing_a_repository_name_does_not_raise_confidence(client: TestClient, seeded):
    """⭐ **결함 37.**

    예전에는 `github_connected_at`(이름을 적은 시각)으로 커버리지를
    계산했습니다. 그래서 오타를 적었든 App 을 설치하지 않았든,
    **GitHub 이벤트가 0건인 프로젝트가 `github_coverage: 1.0`** 이었습니다.
    신뢰도는 근거의 양인데 근거 없이 높게 나오면 그건 거짓말입니다.
    """
    from teamflow.contribution.confidence import compute_confidence
    from teamflow.services import scoring_service

    set_repo(seeded["project_id"], "team/teamflow")

    with db_session.session_scope() as s:
        assert s.query(m.GithubEvent).count() == 0
        stats = scoring_service.load_coverage(s, seeded["project_id"])

    assert stats.github_connected_days == 0
    assert compute_confidence(stats).components["github_coverage"] == 0.0


def test_confidence_rises_only_after_a_delivery_proves_the_link(
    client: TestClient, seeded
):
    from teamflow.services import scoring_service

    set_repo(seeded["project_id"], "team/teamflow")
    post_webhook(client, ping_payload(), event="ping")

    with db_session.session_scope() as s:
        stats = scoring_service.load_coverage(s, seeded["project_id"])

    assert stats.github_connected_days > 0
