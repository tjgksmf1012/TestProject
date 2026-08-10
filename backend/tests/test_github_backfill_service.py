"""백필이 실제로 DB 를 채우는가 — 그리고 **두 번 채우지 않는가.**

이 파일이 고정하는 것 둘.

  1. 백필이 웹훅 경로를 **그대로 재사용**한다 (업무 연결·기여 이벤트까지)
  2. 백필과 웹훅이 겹쳐도 **한 번만** 센다

2번이 어렵습니다. 배달 id 가 다르므로 `uq_github_delivery` 는 안 막아
줍니다. 막는 것은 "이미 있는 PR 번호는 건너뛴다" 뿐이고, 그게 빠지면
업무 카드에 같은 PR 이 두 번 붙고 진단의 배달 수가 두 배가 됩니다.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.pool import StaticPool

from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.github import backfill as bf
from teamflow.github import webhook
from teamflow.github.client import FakeGitHubClient, GitHubError, PullRequestDetails
from teamflow.services import github_backfill_service as svc
from teamflow.services import task_link_service

NOW = datetime(2026, 5, 1, 12, 0, tzinfo=UTC)
REPO = "team/teamflow"


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
def world(engine) -> dict:
    with db_session.session_scope() as s:
        project = m.Project(
            title="T",
            started_at=NOW,
            deadline=NOW + timedelta(days=30),
            github_repo=REPO,
        )
        s.add(project)
        s.flush()

        minsu = m.User(name="민수", email="minsu@e.com")
        s.add(minsu)
        s.flush()
        s.add(
            m.Member(
                project_id=project.id,
                user_id=minsu.id,
                role_shares={"developer": 1.0},
                github_login="minsu",
            )
        )
        task = m.Task(project_id=project.id, title="로그인 API", assignee_id=minsu.id)
        s.add(task)
        s.flush()
        return {"project_id": project.id, "user_id": minsu.id, "task_id": task.id}


def summary(number: int, *, days_ago: int = 0, **kw) -> bf.PullRequestSummary:
    return bf.PullRequestSummary(
        number=number,
        merged_at=NOW - timedelta(days=days_ago),
        author_login=kw.get("author_login", "minsu"),
        title=kw.get("title", f"PR {number}"),
        body=kw.get("body"),
        head_ref=kw.get("head_ref"),
    )


def details(number: int, **kw) -> PullRequestDetails:
    return PullRequestDetails(
        id=1000 + number,
        number=number,
        author_login=kw.get("author_login", "minsu"),
        merged_at=(NOW - timedelta(days=kw.get("days_ago", 0))).isoformat(),
        body=kw.get("body"),
        files=kw.get(
            "files",
            [{"filename": "src/login.py", "additions": 40, "deletions": 5, "status": "modified"}],
        ),
        reviews=kw.get("reviews", []),
        review_comments=kw.get("review_comments", []),
    )


def client_for(numbers: list[int], **kw) -> FakeGitHubClient:
    return FakeGitHubClient(
        responses={(REPO, n): details(n) for n in numbers},
        listings={REPO: [summary(n, days_ago=n, **kw) for n in numbers]},
    )


def run(world: dict, client, **kw):
    with db_session.session_scope() as s:
        return svc.run_backfill(s, client, project_id=world["project_id"], **kw)


def events(project_id: int) -> list[m.GithubEvent]:
    with db_session.session_scope() as s:
        return list(
            s.scalars(
                select(m.GithubEvent).where(m.GithubEvent.project_id == project_id)
            )
        )


def contribution_rows(project_id: int) -> list[m.ContributionEventRow]:
    with db_session.session_scope() as s:
        return list(
            s.scalars(
                select(m.ContributionEventRow).where(
                    m.ContributionEventRow.project_id == project_id
                )
            )
        )


# ══════════════════════════════════════════════════════════════
# 이어지는가
# ══════════════════════════════════════════════════════════════


def test_backfill_stores_events_that_look_like_webhooks(world):
    """⭐ 백필로 들어온 PR 도 웹훅으로 들어온 것과 **같은 행**이어야 합니다.

    모양이 다르면 그 뒤의 모든 코드를 백필용으로 한 벌 더 만들어야 하고,
    그러면 웹훅에서 고친 것이 백필에서는 안 고쳐집니다.
    """
    result = run(world, client_for([1, 2]))

    assert result.status == "ok"
    assert result.stored == 2

    rows = events(world["project_id"])
    assert {r.event_type for r in rows} == {"pull_request.merged"}
    assert all(bf.is_backfilled(r.delivery_id) for r in rows)
    # 사람과 이어져야 기여도가 됩니다.
    assert all(r.actor_user_id == world["user_id"] for r in rows)


def test_backfill_creates_contribution_events(world):
    """⭐ 이게 이 기능의 목적입니다 — 연결 전 활동이 기여도에 들어간다."""
    result = run(world, client_for([1]))

    assert result.events_written > 0
    rows = contribution_rows(world["project_id"])
    assert rows
    assert all(r.user_id == world["user_id"] for r in rows)


def test_backfill_links_tasks_like_the_webhook_does(world):
    """근거를 적어 둔 PR 은 백필로 들어와도 업무 카드에 붙어야 합니다."""
    task_id = world["task_id"]
    client = FakeGitHubClient(
        responses={(REPO, 5): details(5)},
        listings={REPO: [summary(5, title=f"TASK-{task_id} 로그인")]},
    )
    result = run(world, client)

    assert result.tasks_linked == 1
    with db_session.session_scope() as s:
        links = task_link_service.links_for_tasks(s, [task_id])
    assert len(links[task_id]) == 1


# ══════════════════════════════════════════════════════════════
# 두 번 세지 않는가 — 이 파일의 핵심
# ══════════════════════════════════════════════════════════════


def test_running_backfill_twice_changes_nothing(world):
    """⚠️ 두 번 누르는 것은 정상입니다 — 상한에 걸리면 다시 누르라고
    화면이 말하기까지 합니다."""
    client = client_for([1, 2, 3])
    first = run(world, client)
    second = run(world, client)

    assert first.stored == 3
    assert second.stored == 0
    assert second.already_have == 3
    assert len(events(world["project_id"])) == 3


def test_a_webhook_after_backfill_is_not_counted_twice(world):
    """⭐ **배달 id 가 달라서 유니크 제약이 안 막아 줍니다.**

    백필이 PR 7 을 채운 뒤 GitHub 이 같은 PR 의 웹훅을 보내면 그건 진짜
    배달 id 를 갖고 옵니다. `uq_github_delivery` 는 통과합니다.

    막는 것은 `known_pull_request_numbers` 입니다 — 아래
    `test_contribution_events_are_deduped_even_if_two_rows_exist` 가
    그것이 뚫렸을 때의 마지막 방어선을 따로 확인합니다.
    """
    run(world, client_for([7]))
    before = len(contribution_rows(world["project_id"]))
    assert before > 0

    # 진짜 웹훅이 뒤늦게 도착한다.
    payload = bf.to_webhook_payload(summary(7), repo=REPO)
    normalized = webhook.normalize("pull_request", "real-github-uuid-7", payload)
    assert normalized is not None
    with db_session.session_scope() as s:
        s.add(
            m.GithubEvent(
                project_id=world["project_id"],
                delivery_id=normalized.delivery_id,
                repo=normalized.repo,
                event_type=normalized.event_type,
                actor_login=normalized.actor_login,
                ref=normalized.ref,
                payload=normalized.payload,
                occurred_at=normalized.occurred_at,
            )
        )

    # 그 뒤 백필을 또 돌려도 그 PR 은 이미 있는 것으로 봅니다.
    result = run(world, client_for([7]))
    assert result.stored == 0
    assert result.already_have == 1
    assert len(contribution_rows(world["project_id"])) == before


def test_a_pull_request_already_known_from_a_webhook_is_skipped(world):
    """⭐ 웹훅이 **먼저** 들어온 경우. 반대 순서도 막혀야 합니다.

    이게 없으면 업무 카드에 같은 PR 이 두 번 붙고 진단의 배달 수가
    두 배가 됩니다.
    """
    payload = bf.to_webhook_payload(summary(9), repo=REPO)
    normalized = webhook.normalize("pull_request", "real-github-uuid-9", payload)
    assert normalized is not None
    with db_session.session_scope() as s:
        s.add(
            m.GithubEvent(
                project_id=world["project_id"],
                delivery_id=normalized.delivery_id,
                repo=normalized.repo,
                event_type=normalized.event_type,
                actor_login=normalized.actor_login,
                ref=normalized.ref,
                payload=normalized.payload,
                occurred_at=normalized.occurred_at,
            )
        )

    result = run(world, client_for([9]))

    assert result.stored == 0
    assert result.already_have == 1
    assert len(events(world["project_id"])) == 1


def test_contribution_events_are_deduped_even_if_two_rows_exist(world):
    """⭐ **마지막 방어선.**

    위 테스트들은 `github_events` 행이 둘이 되는 것을 막습니다. 그게
    뚫려도 — 저장소 이름을 바꿨다거나, 다른 경로가 생겼다거나 — **점수는
    두 배가 되면 안 됩니다.**

    행이 둘이면 업무 카드에 PR 이 두 번 보이는 건 못 막습니다. 그건
    보기 싫은 것이고, 점수가 두 배가 되는 것은 오답입니다. 둘 중
    반드시 막아야 하는 쪽을 여기서 고정합니다.
    """
    run(world, client_for([7]))
    before = len(contribution_rows(world["project_id"]))
    assert before > 0

    # 같은 PR 을 다른 배달 id 로 한 번 더 밀어 넣는다 (겹침 방어를 우회).
    with db_session.session_scope() as s:
        project = s.get(m.Project, world["project_id"])
        payload = bf.to_webhook_payload(summary(7), repo=REPO)
        normalized = webhook.normalize("pull_request", "another-delivery-7", payload)
        assert normalized is not None
        s.add(
            m.GithubEvent(
                project_id=project.id,
                delivery_id=normalized.delivery_id,
                repo=normalized.repo,
                event_type=normalized.event_type,
                actor_login=normalized.actor_login,
                ref=normalized.ref,
                payload=normalized.payload,
                occurred_at=normalized.occurred_at,
            )
        )

    # 그 두 번째 행을 실제로 수집해 본다.
    from teamflow.services import github_ingest_service

    with db_session.session_scope() as s:
        github_ingest_service.ingest_merged_pull_request(
            s,
            client_for([7]),
            project_id=world["project_id"],
            repo=REPO,
            number=7,
        )

    assert len(contribution_rows(world["project_id"])) == before


# ══════════════════════════════════════════════════════════════
# 어디까지 훑었는지
# ══════════════════════════════════════════════════════════════


def covered(project_id: int) -> tuple:
    with db_session.session_scope() as s:
        p = s.get(m.Project, project_id)
        return (p.github_backfilled_at, p.github_backfilled_to)


def test_a_complete_run_records_how_far_back_it_reached(world):
    run(world, client_for([1, 2, 3]))
    at, to = covered(world["project_id"])
    assert at is not None
    # 가장 오래된 것이 3일 전입니다.
    assert to is not None and to.replace(tzinfo=UTC) == NOW - timedelta(days=3)


def test_a_truncated_run_does_not_record_coverage(world):
    """⭐ **잘린 지점을 '여기까지 훑었다' 로 적으면 안 됩니다.**

    다음 실행이 그 앞을 안 보게 되고, 못 가져온 구간이 영구히 빈 채로
    굳습니다. 조용히 자르는 것보다 더 나쁜 형태입니다.
    """
    result = run(world, client_for([1, 2, 3, 4, 5]), limit=2)

    assert result.truncated is True
    at, to = covered(world["project_id"])
    assert at is not None  # 돌리기는 했다
    assert to is None  # 하지만 어디까지인지는 말하지 않는다


def test_coverage_only_widens(world):
    """이미 채운 구간을 안 채운 것으로 만들면 화면이 사실보다 나쁘게
    말합니다."""
    run(world, client_for([1, 2, 30]))
    _, deep = covered(world["project_id"])

    # 최근 것만 다시 훑는다.
    run(world, client_for([1]), since=NOW - timedelta(days=5))
    _, after = covered(world["project_id"])

    assert after == deep


def test_a_repo_with_nothing_to_fetch_still_counts_as_walked(world):
    """가져올 것이 없는 것과 안 훑어본 것은 다릅니다."""
    result = run(world, FakeGitHubClient(listings={REPO: []}))
    at, to = covered(world["project_id"])
    assert result.status == "ok"
    assert at is not None
    assert to is not None


# ══════════════════════════════════════════════════════════════
# 실패해도 나머지는 남는다
# ══════════════════════════════════════════════════════════════


def test_one_failing_pull_request_does_not_lose_the_others(world):
    """⚠️ 여기서 예외를 던지면 지금까지 채운 것이 **통째로 롤백**되고,
    다시 실행해도 같은 PR 에서 또 멈춥니다."""
    client = FakeGitHubClient(
        # 2번의 상세 응답만 없다 → GitHubError
        responses={(REPO, 1): details(1), (REPO, 3): details(3)},
        listings={REPO: [summary(n, days_ago=n) for n in (1, 2, 3)]},
    )
    result = run(world, client)

    assert result.failed == 1
    assert result.stored == 3
    # 실패한 것도 행은 남습니다 — 업무 연결은 API 가 필요 없으므로.
    assert len(events(world["project_id"])) == 3
    assert result.events_written > 0


def test_a_task_link_survives_a_failed_detail_fetch(world):
    """상세 조회는 실패해도 업무 연결은 남아야 합니다 — 그건 API 가
    필요 없는 일입니다."""
    task_id = world["task_id"]
    client = FakeGitHubClient(
        responses={},  # 전부 실패
        listings={REPO: [summary(5, title=f"TASK-{task_id} 로그인")]},
    )
    result = run(world, client)

    assert result.failed == 1
    assert result.tasks_linked == 1


# ══════════════════════════════════════════════════════════════
# 안 되는 경우
# ══════════════════════════════════════════════════════════════


def test_a_project_without_a_repo_says_so(world):
    with db_session.session_scope() as s:
        s.get(m.Project, world["project_id"]).github_repo = None

    result = run(world, FakeGitHubClient())
    assert result.status == "no_repo"


def test_a_missing_project_is_not_a_crash(engine):
    with db_session.session_scope() as s:
        result = svc.run_backfill(s, FakeGitHubClient(), project_id=9999)
    assert result.status == "not_found"


def test_unmerged_pull_requests_never_become_contributions(world):
    """⚠️ 거절된 PR 이 기여가 되면 안 됩니다.

    GitHub 목록 API 에는 merged 필터가 없어서 `state=closed` 로 받고,
    닫히기만 한 것이 섞여 옵니다.
    """
    client = FakeGitHubClient(
        responses={(REPO, 1): details(1)},
        listings={
            REPO: [
                summary(1),
                bf.PullRequestSummary(number=2, merged_at=None, author_login="minsu"),
            ]
        },
    )
    result = run(world, client)

    assert result.stored == 1
    assert [r.payload["pull_request"]["number"] for r in events(world["project_id"])] == [1]


def test_the_detail_call_is_only_made_for_what_we_keep(world):
    """⚠️ 건너뛸 PR 까지 상세를 부르면 **rate limit 을 건너뛰는 데 씁니다.**"""
    client = client_for([1, 2, 3])
    run(world, client)
    client.calls.clear()

    run(world, client)  # 두 번째 — 전부 이미 있음
    assert client.calls == []


def test_a_broken_github_error_is_not_swallowed_as_success(world):
    """상세 조회가 전부 실패하면 결과가 그걸 말해야 합니다."""
    client = FakeGitHubClient(responses={}, listings={REPO: [summary(1)]})
    result = run(world, client)
    assert result.failed == 1
    assert result.events_written == 0


def test_the_fake_client_raises_the_error_type_we_handle(world):
    """이 파일의 실패 테스트들이 진짜 오류 경로를 타는지 확인합니다."""
    with pytest.raises(GitHubError):
        FakeGitHubClient().pull_request_details(REPO, 1)
