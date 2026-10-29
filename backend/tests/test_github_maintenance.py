"""GitHub 정합성 확인 유지보수 태스크 (`reconcile_github_task`).

웹훅 유실에 대비해 매일 05:00에 최근 lookback_days(기본 7일) 동안
병합된 PR을 REST API로 다시 훑어 빠진 이벤트를 채운다.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.pool import StaticPool

from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.github import backfill as bf
from teamflow.github.client import FakeGitHubClient, GitHubError, PullRequestDetails
from teamflow.tasks.maintenance import reconcile_github_task

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


def summary(number: int, *, days_ago: int = 0) -> bf.PullRequestSummary:
    return bf.PullRequestSummary(
        number=number,
        merged_at=NOW - timedelta(days=days_ago),
        title=f"PR #{number}",
        author_login="minsu",
    )


def details(number: int, *, days_ago: int = 0) -> PullRequestDetails:
    return PullRequestDetails(
        id=1000 + number,
        number=number,
        author_login="minsu",
        merged_at=(NOW - timedelta(days=days_ago)).isoformat(),
        body="설명",
    )


def test_reconcile_github_task_with_no_linked_projects(engine):
    """연결된 저장소가 없으면 backfilled 0건으로 정상 종료한다."""
    res = reconcile_github_task(lookback_days=7)
    assert res == {
        "repos": 0,
        "backfilled": 0,
        "events_written": 0,
        "tasks_linked": 0,
        "failed": 0,
        "skipped": 0,
        "implemented": True,
    }


def test_reconcile_github_task_skips_when_no_credentials(engine):
    """GitHub 자격 증명 또는 installation_id가 없으면 조용히 건너뛰고 skipped를 센다."""
    with db_session.session_scope() as s:
        p = m.Project(
            title="P1",
            started_at=NOW,
            deadline=NOW + timedelta(days=30),
            github_repo=REPO,
            github_installation_id=None,
        )
        s.add(p)

    res = reconcile_github_task(lookback_days=7)
    assert res["repos"] == 1
    assert res["backfilled"] == 0
    assert res["skipped"] == 1
    assert res["implemented"] is True


def test_reconcile_github_task_backfills_recent_pull_requests(engine):
    """lookback_days 이내의 병합 PR만 가져와 채운다."""
    with db_session.session_scope() as s:
        p = m.Project(
            title="P1",
            started_at=NOW,
            deadline=NOW + timedelta(days=30),
            github_repo=REPO,
            github_installation_id=123,
        )
        s.add(p)
        s.flush()
        u = m.User(name="민수", email="minsu@test.com")
        s.add(u)
        s.flush()
        s.add(m.Member(project_id=p.id, user_id=u.id, github_login="minsu"))

    # PR 1은 2일 전(이내), PR 2는 10일 전(이전)
    pr1_sum = summary(1, days_ago=2)
    pr2_sum = summary(2, days_ago=10)
    fake_client = FakeGitHubClient(
        responses={
            (REPO, 1): details(1, days_ago=2),
            (REPO, 2): details(2, days_ago=10),
        },
        listings={REPO: [pr1_sum, pr2_sum]},
    )

    res = reconcile_github_task(lookback_days=7, client=fake_client, now=NOW)
    assert res["repos"] == 1
    assert res["backfilled"] == 1
    assert res["skipped"] == 0
    assert res["failed"] == 0
    assert res["implemented"] is True

    # DB에 PR #1만 들어갔는지 확인
    with db_session.session_scope() as s:
        events = s.scalars(select(m.GithubEvent)).all()
        assert len(events) == 1
        assert "1" in events[0].delivery_id


def test_reconcile_github_task_continues_on_error(engine):
    """한 프로젝트의 조회가 실패해도 다음 프로젝트를 계속 진행한다."""
    with db_session.session_scope() as s:
        p1 = m.Project(
            title="P1",
            started_at=NOW,
            deadline=NOW + timedelta(days=30),
            github_repo="team/failing-repo",
            github_installation_id=111,
        )
        p2 = m.Project(
            title="P2",
            started_at=NOW,
            deadline=NOW + timedelta(days=30),
            github_repo="team/ok-repo",
            github_installation_id=222,
        )
        s.add_all([p1, p2])
        s.flush()

    class ErrorClient(FakeGitHubClient):
        def list_closed_pull_requests(self, repo: str, *, limit: int):
            if "failing" in repo:
                raise GitHubError("GitHub API rate limit or network error", status=500)
            return [summary(42, days_ago=1)]

    client = ErrorClient(
        responses={("team/ok-repo", 42): details(42, days_ago=1)},
    )

    res = reconcile_github_task(lookback_days=7, client=client, now=NOW)
    assert res["repos"] == 2
    assert res["failed"] == 1
    assert res["backfilled"] == 1
    assert res["implemented"] is True
