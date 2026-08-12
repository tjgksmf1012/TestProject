"""업무 ↔ PR 이 실제로 이어지는가.

`docs/08` §5.1 의 필수 경로에서 **끊겨 있던 곳**입니다.

    회의 → 업무 후보 → 승인 → 칸반 등록
        → ✂ **관련 PR 병합 → 업무 카드에 수행 근거 표시**
        → 기여도

`task_github_links` 표는 처음부터 있었고 `extract_task_refs` 도 있었는데
**둘을 잇는 코드가 0곳**이라 그 표에 행이 한 번도 쓰인 적이 없습니다.
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi.testclient import TestClient
from sqlalchemy import select

from teamflow.db import models as m
from teamflow.db import session as db_session

from .conftest import login_as
from .test_api import client, engine, post_webhook, seeded  # noqa: F401

NOW = datetime(2026, 9, 1, 12, 0, tzinfo=UTC)


def pr_payload(
    *,
    repo: str = "team/teamflow",
    login: str = "minsu-dev",
    number: int = 42,
    title: str = "로그인 API",
    body: str | None = None,
    branch: str = "feat/login",
) -> dict:
    return {
        "action": "closed",
        "repository": {"full_name": repo},
        "pull_request": {
            "number": number,
            "title": title,
            "body": body,
            "merged": True,
            "merged_at": "2026-09-01T12:00:00Z",
            "user": {"login": login},
            "head": {"ref": branch},
        },
    }


def make_task(project_id: int, title: str = "로그인 API 구현") -> int:
    with db_session.session_scope() as s:
        # ⚠️ 예전에는 `status="doing"` 이었습니다 — **어느 상태 목록에도 없는
        #    값**입니다(`todo`·`in_progress`·`review`·`done`). 그 열에는
        #    CHECK 제약이 없어서 몇 달 동안 아무도 몰랐고, 칸반은 이런
        #    카드를 "알 수 없는 상태" 열로 밀어냅니다. 제약을 걸자
        #    이 열네 개가 한꺼번에 터졌습니다 (결함 134).
        task = m.Task(project_id=project_id, title=title, status="in_progress")
        s.add(task)
        s.flush()
        return task.id


def board(client: TestClient, project_id: int) -> dict[int, dict]:
    body = client.get(f"/api/projects/{project_id}/tasks").json()
    return {task["id"]: task for task in body["tasks"]}


# ══════════════════════════════════════════════════════════════
# 이어지는가
# ══════════════════════════════════════════════════════════════


def test_a_merged_pr_with_the_marker_lands_on_the_task_card(client: TestClient, seeded):
    """⭐ **이 프로젝트의 대표 주장이 화면에서 확인되는 지점입니다.**"""
    task_id = make_task(seeded["project_id"])

    response = post_webhook(client, pr_payload(body=f"TASK-{task_id} 완료"))

    assert response.json()["linked_tasks"] == [task_id]
    card = board(client, seeded["project_id"])[task_id]
    assert len(card["github"]) == 1
    assert card["github"][0]["number"] == 42
    assert card["github"][0]["confirmed"] is True


def test_the_card_says_why_the_pr_is_attached(client: TestClient, seeded):
    """근거 없이 연결만 보여주면 틀린 연결을 고칠 수 없습니다."""
    task_id = make_task(seeded["project_id"])
    post_webhook(client, pr_payload(body=f"TASK-{task_id}"))

    link = board(client, seeded["project_id"])[task_id]["github"][0]
    assert "TASK" in link["why"]
    assert link["actor_login"] == "minsu-dev"


def test_the_card_shows_the_marker_people_must_write(client: TestClient, seeded):
    """⚠️ 이걸 안 보여주면 **아무도 안 적고 이 기능 전체가 죽은 코드**가 됩니다."""
    task_id = make_task(seeded["project_id"])

    card = board(client, seeded["project_id"])[task_id]

    assert card["marker"] == f"TASK-{task_id}"
    # 그리고 그 표식을 그대로 적으면 실제로 붙어야 합니다.
    post_webhook(client, pr_payload(body=card["marker"]))
    assert board(client, seeded["project_id"])[task_id]["github"]


def test_a_branch_name_links_but_only_as_a_guess(client: TestClient, seeded):
    task_id = make_task(seeded["project_id"])
    post_webhook(client, pr_payload(branch=f"feat/{task_id}-login"))

    link = board(client, seeded["project_id"])[task_id]["github"][0]
    assert link["confirmed"] is False
    assert "브랜치" in link["why"]


def test_a_hash_number_links_but_warns_it_may_be_an_issue(client: TestClient, seeded):
    task_id = make_task(seeded["project_id"])
    post_webhook(client, pr_payload(body=f"Closes #{task_id}"))

    link = board(client, seeded["project_id"])[task_id]["github"][0]
    assert link["confirmed"] is False
    assert "이슈" in link["why"]


def test_a_pr_that_refers_to_nothing_links_to_nothing(client: TestClient, seeded):
    make_task(seeded["project_id"])
    response = post_webhook(client, pr_payload(title="오타 수정", branch="fix/typo"))
    assert response.json()["linked_tasks"] == []


# ══════════════════════════════════════════════════════════════
# ⭐ 남의 업무에 붙으면 안 된다
# ══════════════════════════════════════════════════════════════


def test_a_pr_never_links_to_another_projects_task(client: TestClient, seeded):
    """⭐ `tasks.id` 는 **전역 시퀀스**입니다.

    프로젝트마다 1번부터 시작하지 않으므로, `TASK-12` 의 12번은 다른 팀의
    업무일 수 있습니다. 범위를 안 걸면 남의 업무 카드에 우리 PR 이 붙습니다.
    """
    with db_session.session_scope() as s:
        other = m.Project(title="다른 팀", started_at=NOW)
        s.add(other)
        s.flush()
        stranger = m.Task(project_id=other.id, title="남의 업무")
        s.add(stranger)
        s.flush()
        stranger_id = stranger.id

    response = post_webhook(client, pr_payload(body=f"TASK-{stranger_id}"))

    assert response.json()["linked_tasks"] == []
    with db_session.session_scope() as s:
        assert s.query(m.TaskGithubLink).count() == 0


def test_a_task_number_that_does_not_exist_is_dropped(client: TestClient, seeded):
    response = post_webhook(client, pr_payload(body="TASK-99999"))
    assert response.json()["linked_tasks"] == []


def test_the_board_only_shows_this_projects_links(client: TestClient, seeded):
    """다른 프로젝트 구성원이 이 보드를 못 읽는 것과 별개로, 카드에
    남의 PR 이 섞여서도 안 됩니다."""
    task_id = make_task(seeded["project_id"])
    post_webhook(client, pr_payload(body=f"TASK-{task_id}"))

    cards = board(client, seeded["project_id"])
    for card in cards.values():
        for link in card["github"]:
            assert link["repo"] == "team/teamflow"


# ══════════════════════════════════════════════════════════════
# 재전송 · 여러 건
# ══════════════════════════════════════════════════════════════


def test_a_redelivered_webhook_does_not_double_the_link(client: TestClient, seeded):
    """웹훅은 재전송됩니다. 카드에 같은 PR 이 두 번 뜨면 안 됩니다."""
    task_id = make_task(seeded["project_id"])
    for _ in range(3):
        post_webhook(client, pr_payload(body=f"TASK-{task_id}"), delivery="same")

    assert len(board(client, seeded["project_id"])[task_id]["github"]) == 1


def test_two_prs_can_finish_one_task(client: TestClient, seeded):
    task_id = make_task(seeded["project_id"])
    post_webhook(
        client, pr_payload(number=1, body=f"TASK-{task_id}"), delivery="d1"
    )
    post_webhook(
        client, pr_payload(number=2, body=f"TASK-{task_id}"), delivery="d2"
    )

    assert len(board(client, seeded["project_id"])[task_id]["github"]) == 2


def test_one_pr_can_finish_two_tasks(client: TestClient, seeded):
    first = make_task(seeded["project_id"], "A")
    second = make_task(seeded["project_id"], "B")

    post_webhook(client, pr_payload(body=f"TASK-{first} TASK-{second}"))

    cards = board(client, seeded["project_id"])
    assert cards[first]["github"] and cards[second]["github"]


def test_confirmed_links_come_before_guesses(client: TestClient, seeded):
    """화면은 위에서부터 읽습니다. 추정이 위에 있으면 그게 사실로 보입니다."""
    task_id = make_task(seeded["project_id"])
    post_webhook(
        client,
        pr_payload(number=1, branch=f"feat/{task_id}-x"),
        delivery="guess",
    )
    post_webhook(
        client, pr_payload(number=2, body=f"TASK-{task_id}"), delivery="sure"
    )

    links = board(client, seeded["project_id"])[task_id]["github"]
    assert [link["confirmed"] for link in links] == [True, False]


# ══════════════════════════════════════════════════════════════
# ⭐ 자격 증명 없이도 이어져야 한다
# ══════════════════════════════════════════════════════════════


def test_linking_works_without_github_app_credentials(client: TestClient, seeded):
    """⭐ **이것 때문에 워커가 아니라 웹훅에서 잇습니다.**

    `ingest_github_event_task` 는 App 자격 증명이 없으면 `not_configured` 로
    통째로 빠져나갑니다. 거기 두면 자격 증명을 갖추기 전까지 업무 카드에
    PR 이 영영 안 붙습니다 — 그런데 연결에는 API 도 자격 증명도 필요
    없습니다. 웹훅 본문에 제목·본문·브랜치가 이미 다 있습니다.

    이 테스트 서버에는 앱 id 도 개인키도 없습니다. 그래도 붙어야 합니다.
    """
    from teamflow.api.main import app
    from teamflow.config import get_settings

    settings = app.dependency_overrides[get_settings]()
    assert not settings.github_app_id

    task_id = make_task(seeded["project_id"])
    post_webhook(client, pr_payload(body=f"TASK-{task_id}"))

    assert board(client, seeded["project_id"])[task_id]["github"]


def test_only_merged_pull_requests_create_links(client: TestClient, seeded):
    """리뷰나 이슈는 "이 업무가 이 PR 로 끝났다" 가 아닙니다."""
    task_id = make_task(seeded["project_id"])

    payload = pr_payload(body=f"TASK-{task_id}")
    payload["pull_request"]["merged"] = False

    post_webhook(client, payload)

    with db_session.session_scope() as s:
        assert s.scalars(select(m.TaskGithubLink)).all() == []


def test_the_board_needs_membership(client: TestClient, seeded):
    with db_session.session_scope() as s:
        outsider = m.User(name="남", email="out@example.com")
        s.add(outsider)
        s.flush()
        outsider_id = outsider.id

    login_as(client, outsider_id)
    assert client.get(f"/api/projects/{seeded['project_id']}/tasks").status_code == 403
