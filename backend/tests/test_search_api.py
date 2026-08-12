"""검색 (요구사항 정의서 §20 SEARCH-002~005).

⚠️ 여기서 제일 중요한 것은 **프로젝트 밖으로 안 샌다**는 것입니다. 검색은
회의 전사·팀 대화·기여 근거를 한 상자에서 꺼내는 문이라, 범위가 한 번
새면 남의 팀 회의록이 결과로 나옵니다. 종류마다 따로 잽니다.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.services import search_service

from .conftest import login_as
from .test_api import client, engine, seeded  # noqa: F401  (픽스처)

NOW = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)


def find(client: TestClient, project_id: int, **params) -> list[dict]:
    return client.get(f"/api/projects/{project_id}/search", params=params).json()


@pytest.fixture
def stuff(seeded) -> dict:
    """업무 둘 + 발화 하나 + GitHub 이벤트 하나."""
    with db_session.session_scope() as session:
        tasks = [
            m.Task(
                project_id=seeded["project_id"],
                title="로그인 API 구현",
                assignee_id=seeded["user_ids"][0],
                status="todo",
                priority=1,
            ),
            m.Task(
                project_id=seeded["project_id"],
                title="로그인 화면 접근성 점검",
                assignee_id=seeded["user_ids"][1],
                status="review",
                priority=3,
            ),
        ]
        session.add_all(tasks)
        session.add(
            m.Utterance(
                meeting_id=seeded["meeting_id"],
                speaker_id=seeded["user_ids"][0],
                start_ms=1000,
                end_ms=4000,
                text="로그인 토큰 만료를 30분으로 잡읍시다",
                speaker_source="track",
            )
        )
        session.add(
            m.GithubEvent(
                project_id=seeded["project_id"],
                delivery_id="d-1",
                repo="team/teamflow",
                event_type="pull_request",
                actor_login="minsu-dev",
                ref="feature/login-api",
                payload={"secret": "이건 검색에 안 나와야 합니다"},
                occurred_at=NOW,
            )
        )
        session.flush()
        return {"task_ids": [t.id for t in tasks]}


# ══════════════════════════════════════════════════════════════
# SEARCH-002 업무 — 이름·담당자·상태·우선순위
# ══════════════════════════════════════════════════════════════


def test_finding_a_task_by_name(client: TestClient, seeded, stuff):
    hits = find(client, seeded["project_id"], q="로그인", kind="task")
    assert {h["title"] for h in hits} == {"로그인 API 구현", "로그인 화면 접근성 점검"}


def test_finding_by_assignee(client: TestClient, seeded, stuff):
    hits = find(client, seeded["project_id"], kind="task", assignee_id=seeded["user_ids"][1])
    assert [h["title"] for h in hits] == ["로그인 화면 접근성 점검"]


def test_finding_by_status_and_priority(client: TestClient, seeded, stuff):
    hits = find(client, seeded["project_id"], kind="task", status="review")
    assert [h["title"] for h in hits] == ["로그인 화면 접근성 점검"]
    assert hits[0]["status"] == "검토 중"

    hits = find(client, seeded["project_id"], kind="task", priority=1)
    assert [h["title"] for h in hits] == ["로그인 API 구현"]


def test_conditions_stack(client: TestClient, seeded, stuff):
    """넷을 겹칠 수 있습니다."""
    hits = find(
        client,
        seeded["project_id"],
        kind="task",
        q="로그인",
        status="todo",
        priority=1,
    )
    assert [h["title"] for h in hits] == ["로그인 API 구현"]


def test_no_conditions_is_not_a_search(client: TestClient, seeded, stuff):
    """⚠️ 조건 없는 검색은 그냥 칸반입니다 — 칸반은 이미 있습니다."""
    assert find(client, seeded["project_id"], kind="task") == []


def test_an_unknown_status_is_refused(client: TestClient, seeded):
    response = client.get(
        f"/api/projects/{seeded['project_id']}/search",
        params={"kind": "task", "status": "doing"},
    )
    assert response.status_code == 400


# ══════════════════════════════════════════════════════════════
# SEARCH-003 회의 — 이름과 날짜
# ══════════════════════════════════════════════════════════════


def test_finding_a_meeting_by_name(client: TestClient, seeded):
    hits = find(client, seeded["project_id"], q="정기회의", kind="meeting")
    assert [h["title"] for h in hits] == ["9월 1일 정기회의"]


def test_finding_a_meeting_by_date(client: TestClient, seeded):
    inside = find(
        client,
        seeded["project_id"],
        kind="meeting",
        since=(NOW - timedelta(days=1)).isoformat(),
        until=(NOW + timedelta(days=1)).isoformat(),
    )
    assert len(inside) == 1

    outside = find(
        client,
        seeded["project_id"],
        kind="meeting",
        since=(NOW + timedelta(days=30)).isoformat(),
    )
    assert outside == []


def test_a_scheduled_meeting_is_findable_too(client: TestClient, seeded):
    """⚠️ 정의서는 "과거 회의" 라지만, 이름으로 찾는 사람은 그것이 이미
    열렸는지 모릅니다 — 안 나오면 "없다" 로 읽습니다."""
    client.post(
        f"/api/projects/{seeded['project_id']}/scheduled-meetings",
        json={"title": "다음 주 정기회의", "at": (NOW + timedelta(days=7)).isoformat()},
    )
    hits = find(client, seeded["project_id"], q="정기회의", kind="meeting")
    assert "다음 주 정기회의" in {h["title"] for h in hits}


# ══════════════════════════════════════════════════════════════
# SEARCH-004 회의 내용
# ══════════════════════════════════════════════════════════════


def test_finding_what_was_said(client: TestClient, seeded, stuff):
    hits = find(client, seeded["project_id"], q="토큰 만료", kind="utterance")
    assert len(hits) == 1
    assert hits[0]["body"] == "로그인 토큰 만료를 30분으로 잡읍시다"
    # ⚠️ 누가 한 말인지 없으면 회의록을 찾아도 **누구에게 물어야 할지** 모릅니다.
    assert hits[0]["who"] == "김민수"
    assert hits[0]["meeting_id"] == seeded["meeting_id"]


def test_a_deleted_utterance_disappears_from_search(client: TestClient, seeded, stuff):
    """⭐ 발화는 **동의의 산물**입니다 — 지우면 검색에서도 사라져야 합니다.

    베껴 둔 색인을 보고 있으면 이 검사가 터집니다.
    """
    with db_session.session_scope() as session:
        session.query(m.Utterance).delete()

    assert find(client, seeded["project_id"], q="토큰 만료", kind="utterance") == []


# ══════════════════════════════════════════════════════════════
# SEARCH-005 GitHub
# ══════════════════════════════════════════════════════════════


def test_finding_github_activity(client: TestClient, seeded, stuff):
    hits = find(client, seeded["project_id"], q="login-api", kind="github")
    assert len(hits) == 1
    assert hits[0]["body"] == "feature/login-api"
    assert hits[0]["who"] == "minsu-dev"


def test_the_raw_payload_is_not_searchable(client: TestClient, seeded, stuff):
    """⭐ `payload` 에는 저장소 설정과 사람 이메일까지 들어 있습니다.

    그걸 훑으면 **화면에 나올 일이 없는 것이 검색으로 새어 나옵니다.**
    """
    assert find(client, seeded["project_id"], q="이건 검색에", kind="github") == []


# ══════════════════════════════════════════════════════════════
# 경계
# ══════════════════════════════════════════════════════════════


def test_a_one_letter_query_is_not_a_search(client: TestClient, seeded, stuff):
    """⚠️ 한 글자면 사실상 전부가 나옵니다 — 결과가 아니라 목록입니다."""
    assert find(client, seeded["project_id"], q="로") == []


def test_wildcards_are_not_wildcards(client: TestClient, seeded, stuff):
    """⭐ `%` 와 `_` 를 그대로 두면 사용자가 적은 `_` 가 아무 글자가 됩니다."""
    assert find(client, seeded["project_id"], q="%%", kind="task") == []
    assert find(client, seeded["project_id"], q="로_인", kind="task") == []


def test_everything_at_once(client: TestClient, seeded, stuff):
    """`kind` 를 안 주면 전부 찾습니다.

    ⚠️ `로그인` 은 GitHub 쪽에 안 걸립니다 — 그쪽 참조는 `feature/login-api`
    라 영어입니다. 그게 정상이고, 한 종류가 비어도 나머지는 나와야 합니다.
    """
    kinds = {h["kind"] for h in find(client, seeded["project_id"], q="로그인")}
    assert kinds == {"task", "utterance"}

    # 영어로 찾으면 GitHub 쪽이 나옵니다.
    assert {h["kind"] for h in find(client, seeded["project_id"], q="login-api")} == {
        "github"
    }


def test_someone_outside_the_project_finds_nothing(client: TestClient, seeded, stuff):
    """⭐ 회의 전사는 팀 내부 자료입니다."""
    with db_session.session_scope() as session:
        outsider = m.User(name="남남", email="stranger@example.com")
        session.add(outsider)
        session.flush()
        outsider_id = outsider.id
    login_as(client, outsider_id)

    response = client.get(
        f"/api/projects/{seeded['project_id']}/search", params={"q": "로그인"}
    )
    assert response.status_code == 403


def test_the_service_does_not_count_people():
    """⭐ 검색은 "무엇이 있나" 를 찾는 곳이지 "누가 얼마나" 를 세는 곳이
    아닙니다.

    사람별 건수를 돌려주는 함수가 생기면 그 순간 "검색 결과 기준 발언
    순위" 가 만들어지고, 그건 이 저장소가 금지한 리더보드입니다.
    """
    counters = [
        name
        for name in dir(search_service)
        if any(word in name for word in ("count", "rank", "top", "tally", "by_user"))
    ]
    assert counters == []
