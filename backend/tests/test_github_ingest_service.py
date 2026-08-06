"""GitHub 활동 → 기여 이벤트.

`contribution/github_ingest.pr_to_events` 는 완성돼 있었고 테스트도 있었는데
**호출자가 0곳**이었습니다. 부를 수가 없었기 때문입니다 — `pr_to_events` 는
diff 파일 목록과 리뷰 코멘트 수를 요구하는데 `pull_request` 웹훅 페이로드에는
**둘 다 없습니다.**

그래서 이 프로젝트의 대표 주장 중 하나 — "관련 PR 병합 → 기여도에 근거와
함께 반영" — 은 코드상 어디서도 일어나지 않았습니다. `contribution_events`
에 들어가는 경로는 손으로 넣는 것과 업무 완료뿐이었습니다.

이 파일은 **네트워크 없이** 그 연결을 검증합니다. HTTP 를 타는 부분은
`FakeGitHubClient` 로 바꿔 끼우고, 실제로 틀리기 쉬운 부분(로그인 매칭,
리뷰 코멘트 세기, 이슈 번호↔id, 멱등성)을 잽니다.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.pool import StaticPool

from teamflow.config import Settings, get_settings
from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.github import mapping
from teamflow.github.client import FakeGitHubClient, GitHubError, PullRequestDetails
from teamflow.services import github_ingest_service as svc

NOW = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)
MERGED_AT = "2026-09-02T10:00:00Z"


def source_file(name: str, added: int) -> dict:
    """diff 필터가 "실질 변경" 으로 셀 만한 파일 하나."""
    body = "\n".join(f"+    line {i}" for i in range(added))
    return {
        "filename": name,
        "status": "modified",
        "additions": added,
        "deletions": 0,
        "patch": f"@@ -1,1 +1,{added} @@\n{body}",
    }


def details(**over) -> PullRequestDetails:
    base = {
        "id": 900_001,
        "number": 42,
        "author_login": "minsu-dev",
        "merged_at": MERGED_AT,
        "body": None,
        "files": [source_file("backend/app.py", 120)],
        "reviews": [],
        "review_comments": [],
    }
    base.update(over)
    return PullRequestDetails(**base)


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
def project(engine) -> dict:
    """팀원 둘. GitHub 로그인은 **대문자가 섞여** 등록돼 있다."""
    with db_session.session_scope() as s:
        minsu = m.User(name="김민수", email="minsu@example.com")
        haneul = m.User(name="이하늘", email="haneul@example.com")
        s.add_all([minsu, haneul])
        s.flush()

        proj = m.Project(
            title="TeamFlow", started_at=NOW, github_repo="team/teamflow"
        )
        s.add(proj)
        s.flush()
        s.add_all(
            [
                m.Member(
                    project_id=proj.id,
                    user_id=minsu.id,
                    role_shares={},
                    github_login="MinSu-Dev",
                ),
                m.Member(
                    project_id=proj.id,
                    user_id=haneul.id,
                    role_shares={},
                    github_login="haneul-design",
                ),
            ]
        )
        s.flush()
        return {"project_id": proj.id, "minsu": minsu.id, "haneul": haneul.id}


def stored_events() -> list[dict]:
    with db_session.session_scope() as s:
        return [
            {
                "user_id": r.user_id,
                "event_type": r.event_type,
                "source_id": r.source_id,
                "magnitude": float(r.magnitude or 0),
            }
            for r in s.scalars(select(m.ContributionEventRow)).all()
        ]


def ingest(project: dict, pr: PullRequestDetails, **kwargs) -> dict:
    client = FakeGitHubClient({("team/teamflow", pr.number): pr})
    with db_session.session_scope() as s:
        return svc.ingest_merged_pull_request(
            s,
            client,
            project_id=project["project_id"],
            repo="team/teamflow",
            number=pr.number,
            **kwargs,
        )


# ══════════════════════════════════════════════════════════════
# 연결 자체
# ══════════════════════════════════════════════════════════════


def test_a_merged_pr_becomes_a_contribution_event(engine, project: dict):
    """⭐ 이 연결이 없어서 GitHub 활동이 기여도에 도달한 적이 없었다."""
    assert stored_events() == []

    result = ingest(project, details())
    assert result["status"] == "ok"

    events = stored_events()
    assert [e["event_type"] for e in events] == ["pr_merged"]
    assert events[0]["user_id"] == project["minsu"]
    assert events[0]["magnitude"] > 0


def test_login_matching_ignores_case(engine, project: dict):
    """⭐ `MinSu-Dev` 로 등록하고 `minsu-dev` 로 들어오면 못 찾는다.

    GitHub 로그인은 대소문자를 보존하지만 비교는 대소문자 무관이다. 못 찾으면
    그 사람의 PR 이 **통째로** 기여도에서 빠지고, 아무 오류도 안 난다.
    """
    ingest(project, details(author_login="MINSU-DEV"))
    assert [e["user_id"] for e in stored_events()] == [project["minsu"]]


def test_an_unmapped_author_creates_nothing(engine, project: dict):
    """⭐ 외부 기여자·봇의 PR 을 아무에게나 붙이지 않는다.

    0번 사용자로 만들거나 첫 팀원에게 붙이면 그게 곧 잘못된 기여도다.
    """
    result = ingest(project, details(author_login="dependabot[bot]"))

    assert result["status"] == "skipped"
    assert stored_events() == []


def test_an_unmerged_pr_creates_nothing(engine, project: dict):
    """열기만 해서는 기여가 아니다 (docs/05 §2.1)."""
    assert ingest(project, details(merged_at=None))["status"] == "skipped"
    assert stored_events() == []


def test_a_trivial_pr_creates_nothing(engine, project: dict):
    """lock 파일만 고친 PR 은 세지 않는다 — diff 필터가 이미 그렇게 판단한다."""
    ingest(project, details(files=[source_file("package-lock.json", 5000)]))
    assert stored_events() == []


# ══════════════════════════════════════════════════════════════
# 리뷰 — 승인 버튼만 누른 것을 세지 않기 위해
# ══════════════════════════════════════════════════════════════


def test_a_review_with_inline_comments_counts(engine, project: dict):
    ingest(
        project,
        details(
            reviews=[
                {
                    "id": 5001,
                    "user": {"login": "haneul-design"},
                    "submitted_at": MERGED_AT,
                    "state": "CHANGES_REQUESTED",
                    "body": "",
                }
            ],
            review_comments=[
                {"pull_request_review_id": 5001, "body": "여기 이름이 헷갈립니다"},
                {"pull_request_review_id": 5001, "body": "이 분기는 안 도는 것 같습니다"},
            ],
        ),
    )

    reviews = [e for e in stored_events() if e["event_type"] == "review_given"]
    assert len(reviews) == 1
    assert reviews[0]["user_id"] == project["haneul"]
    assert reviews[0]["magnitude"] == 2


def test_clicking_approve_without_saying_anything_is_not_a_review(engine, project: dict):
    """⭐ 승인 버튼만 누른 것은 리뷰가 아니다.

    이걸 세면 서로 무조건 승인해 주는 것이 가장 싼 점수 획득 경로가 된다.
    """
    ingest(
        project,
        details(
            reviews=[
                {
                    "id": 5002,
                    "user": {"login": "haneul-design"},
                    "submitted_at": MERGED_AT,
                    "state": "APPROVED",
                    "body": "",
                }
            ],
        ),
    )
    assert [e["event_type"] for e in stored_events()] == ["pr_merged"]


def test_a_review_body_without_inline_comments_still_counts(engine, project: dict):
    """글로 의견을 남긴 것은 승인 클릭과 다르다."""
    ingest(
        project,
        details(
            reviews=[
                {
                    "id": 5003,
                    "user": {"login": "haneul-design"},
                    "submitted_at": MERGED_AT,
                    "state": "COMMENTED",
                    "body": "인증 흐름을 다시 봐야 할 것 같습니다",
                }
            ],
        ),
    )
    assert any(e["event_type"] == "review_given" for e in stored_events())


def test_reviewing_your_own_pr_is_not_a_contribution(engine, project: dict):
    ingest(
        project,
        details(
            reviews=[
                {
                    "id": 5004,
                    "user": {"login": "minsu-dev"},
                    "submitted_at": MERGED_AT,
                    "state": "COMMENTED",
                    "body": "셀프 리뷰",
                }
            ],
        ),
    )
    assert [e["event_type"] for e in stored_events()] == ["pr_merged"]


def test_a_reviewer_outside_the_team_is_skipped(engine, project: dict):
    ingest(
        project,
        details(
            reviews=[
                {
                    "id": 5005,
                    "user": {"login": "외부인"},
                    "submitted_at": MERGED_AT,
                    "state": "COMMENTED",
                    "body": "좋네요",
                }
            ],
        ),
    )
    assert [e["event_type"] for e in stored_events()] == ["pr_merged"]


# ══════════════════════════════════════════════════════════════
# 멱등성 — 웹훅은 재전송된다
# ══════════════════════════════════════════════════════════════


def test_the_same_pr_twice_counts_once(engine, project: dict):
    """⭐ 막지 않으면 재전송 한 번에 그 사람 점수가 두 배가 된다.

    웹훅은 재전송되고, 백필과 겹치고, `task_acks_late` 라 워커가 죽으면
    같은 잡이 다시 돈다.
    """
    ingest(project, details())
    ingest(project, details())

    assert len(stored_events()) == 1


def test_reingesting_reports_zero_new(engine, project: dict):
    ingest(project, details())
    second = ingest(project, details())

    assert second["events"] == 1
    assert second["written"] == 0


# ══════════════════════════════════════════════════════════════
# 이슈 번호와 전역 id
# ══════════════════════════════════════════════════════════════


def test_issue_events_need_a_global_id(engine, project: dict):
    """⭐ 이슈 **번호**는 저장소 안에서만 유일하다.

    그대로 `source_id` 에 쓰면 저장소가 둘일 때 서로의 12번 이슈와
    충돌하고, 유니크 제약 때문에 뒤엣것이 조용히 사라진다. 번호를 id 로
    바꿔 줄 방법이 없으면 **아예 만들지 않는다.**
    """
    ingest(project, details(body="Closes #12"))
    assert [e["event_type"] for e in stored_events()] == ["pr_merged"]


def test_issue_events_appear_when_ids_can_be_resolved(engine, project: dict):
    ingest(
        project,
        details(body="This fixes #12 and closes #13"),
        resolve_issue_id=lambda _repo, number: 7_000_000 + number,
    )

    resolved = [e for e in stored_events() if e["event_type"] == "issue_resolved"]
    assert sorted(e["source_id"] for e in resolved) == [7_000_012, 7_000_013]


# ══════════════════════════════════════════════════════════════
# 웹훅 이벤트 행에서 시작하는 경로
# ══════════════════════════════════════════════════════════════


def test_ingesting_from_a_stored_webhook_event(engine, project: dict):
    with db_session.session_scope() as s:
        row = m.GithubEvent(
            project_id=project["project_id"],
            delivery_id="d-1",
            repo="team/teamflow",
            event_type="pull_request.merged",
            actor_login="minsu-dev",
            payload={"pull_request": {"number": 42}},
            occurred_at=NOW,
        )
        s.add(row)
        s.flush()
        event_id = row.id

    client = FakeGitHubClient({("team/teamflow", 42): details()})
    with db_session.session_scope() as s:
        result = svc.ingest_github_event(s, client, event_id)

    assert result["status"] == "ok"
    assert len(stored_events()) == 1


def test_a_non_merge_event_is_ignored(engine, project: dict):
    with db_session.session_scope() as s:
        row = m.GithubEvent(
            project_id=project["project_id"],
            delivery_id="d-2",
            repo="team/teamflow",
            event_type="pull_request_review.submitted",
            actor_login="haneul-design",
            payload={},
            occurred_at=NOW,
        )
        s.add(row)
        s.flush()
        event_id = row.id

    client = FakeGitHubClient()
    with db_session.session_scope() as s:
        assert svc.ingest_github_event(s, client, event_id)["status"] == "ignored"
    assert client.calls == [], "무시할 이벤트에 API 를 부르면 안 된다"


def test_a_missing_event_row_is_not_an_exception(engine, project: dict):
    """워커가 커밋보다 먼저 도착한 경우. 예외로 죽으면 재시도가 무한해진다."""
    with db_session.session_scope() as s:
        assert svc.ingest_github_event(s, FakeGitHubClient(), 99999)["status"] == "not_found"


def test_github_errors_are_not_swallowed(engine, project: dict):
    """⭐ 삼키면 rate limit 한 번에 그 PR 의 기여가 영영 사라진다."""
    with db_session.session_scope() as s:
        row = m.GithubEvent(
            project_id=project["project_id"],
            delivery_id="d-3",
            repo="team/teamflow",
            event_type="pull_request.merged",
            actor_login="minsu-dev",
            payload={"pull_request": {"number": 999}},
            occurred_at=NOW,
        )
        s.add(row)
        s.flush()
        event_id = row.id

    with db_session.session_scope() as s, pytest.raises(GitHubError):
        svc.ingest_github_event(s, FakeGitHubClient(), event_id)


# ══════════════════════════════════════════════════════════════
# 순수 매핑
# ══════════════════════════════════════════════════════════════


def test_parse_time_refuses_to_guess():
    """⭐ 읽지 못한 시각을 오늘로 대체하면 잘못된 기간에 귀속된다."""
    assert mapping.parse_time(None) is None
    assert mapping.parse_time("어제") is None
    assert mapping.parse_time(MERGED_AT) == datetime(2026, 9, 2, 10, 0, tzinfo=UTC)


def test_parse_time_always_returns_aware_datetimes():
    """naive 가 섞이면 나중에 비교에서 TypeError 가 난다."""
    assert mapping.parse_time("2026-09-02T10:00:00").tzinfo is not None


def test_missing_patch_is_not_an_empty_patch():
    """⭐ 빈 patch 는 "변경 없음" 으로 읽히는데 실제로는 "모른다" 다.

    GitHub 은 파일이 크거나 바이너리면 patch 를 생략한다.
    """
    files = mapping.to_changed_files([{"filename": "a.png", "additions": 0}])
    assert files[0].patch is None


def test_files_without_a_name_are_dropped():
    assert mapping.to_changed_files([{"additions": 5}]) == []


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ("Closes #12", [12]),
        ("fixes #7 and Resolved #8", [7, 8]),
        ("CLOSE #3", [3]),
        ("close: #4", [4]),
        ("#12 를 봅니다", []),  # 키워드가 없으면 닫는 게 아니다
        ("Closes #12 Closes #12", [12]),  # 중복 제거
        (None, []),
        ("", []),
    ],
)
def test_parse_closing_issue_numbers(body, expected):
    assert mapping.parse_closing_issue_numbers(body) == expected


def test_member_logins_are_lowercased(engine, project: dict):
    with db_session.session_scope() as s:
        logins = svc.member_logins(s, project["project_id"])
    assert "minsu-dev" in logins
    assert "MinSu-Dev" not in logins
