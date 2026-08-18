"""GitHub 조회 피드 (요구사항 정의서 §17 GITHUB-003~005 · 008).

여기서 고정하는 판단 셋:

1. **`payload` 는 한 칸도 안 나간다** — 저장된 웹훅 본문에는 저장소 설정과
   사람 이메일까지 들어 있습니다. 비밀을 심어 넣고 응답 전문에서 찾습니다.
2. **집계는 어휘 순, 사람별 없음** — 건수 순 목록이 곧 순위표이고, 사람별
   집계는 기여도 화면이 이미 담당합니다(두 벌 금지).
3. **구성원만** — 팀의 저장소 활동이 그대로 나가는 자리입니다.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.db import vocab

from .conftest import login_as, logout
from .test_api import (  # noqa: F401
    client,
    engine,
    seeded,
)

NOW = datetime(2026, 9, 1, 12, 0, tzinfo=UTC)

#: ⚠️ 응답 전문에서 찾을 미끼. 실제 웹훅 본문에 들어 있는 부류의 값입니다.
SECRET_EMAIL = "leak-canary@example.com"
SECRET_SETTING = "secret-webhook-url-abc123"


def _event(
    project_id: int,
    *,
    kind: vocab.GithubEventKind = vocab.GithubEventKind.PR_MERGED,
    actor_login: str = "minsu-gh",
    actor_user_id: int | None = None,
    ref: str | None = "feat/login",
    minutes_ago: int = 0,
) -> m.GithubEvent:
    return m.GithubEvent(
        project_id=project_id,
        delivery_id=f"d-{kind}-{minutes_ago}",
        repo="team/demo",
        event_type=str(kind),
        actor_login=actor_login,
        actor_user_id=actor_user_id,
        ref=ref,
        # ⚠️ 일부러 비밀을 넣습니다 — 응답에 나오면 안 됩니다.
        payload={
            "sender": {"email": SECRET_EMAIL},
            "repository": {"hooks_url": SECRET_SETTING},
        },
        occurred_at=NOW - timedelta(minutes=minutes_ago),
    )


def test_the_feed_lists_events_newest_first(client, seeded):
    with db_session.session_scope() as s:
        s.add(_event(seeded["project_id"], minutes_ago=30))
        s.add(
            _event(
                seeded["project_id"],
                kind=vocab.GithubEventKind.ISSUE_CLOSED,
                ref=None,
                minutes_ago=5,
            )
        )

    body = client.get(f"/api/projects/{seeded['project_id']}/github/feed").json()
    kinds = [item["kind"] for item in body["items"]]
    assert kinds[0] == "issues.closed", "최근 것이 먼저 와야 합니다"
    assert "pull_request.merged" in kinds
    assert body["items"][0]["label"] == "이슈 닫힘"


def test_the_payload_never_leaks(client, seeded):
    """⭐ 저장된 웹훅 본문의 값이 응답 **전문**에 나오지 않는가.

    칸 이름을 검사하는 것으로는 부족합니다 — 누가 `detail` 같은 칸을
    더하면서 payload 를 요약해 넣으면 이름 검사는 통과합니다. **값을 심어
    넣고 값으로 찾습니다.**
    """
    with db_session.session_scope() as s:
        s.add(_event(seeded["project_id"]))

    response = client.get(f"/api/projects/{seeded['project_id']}/github/feed")
    assert response.status_code == 200
    assert SECRET_EMAIL not in response.text, "payload 의 이메일이 새어 나왔습니다"
    assert SECRET_SETTING not in response.text, "payload 의 설정값이 새어 나왔습니다"

    # 칸 자체도 정해진 것뿐이어야 합니다 — 늘리려면 출처부터 확인할 것.
    item = response.json()["items"][0]
    assert set(item) == {"id", "kind", "label", "who", "repo", "ref", "occurred_at"}


def test_who_prefers_the_team_name_but_keeps_the_login(client, seeded):
    """팀원과 이어졌으면 팀원 이름, 아니면 GitHub 로그인 **그대로**.

    로그인을 숨기면 "계정이 안 이어졌다" 는 사실이 같이 숨습니다 —
    연결 진단이 잡는 그 문제를 화면에서도 볼 수 있어야 합니다.
    """
    with db_session.session_scope() as s:
        s.add(
            _event(
                seeded["project_id"],
                actor_login="minsu-gh",
                actor_user_id=seeded["user_ids"][0],
                minutes_ago=1,
            )
        )
        s.add(_event(seeded["project_id"], actor_login="stranger-gh", minutes_ago=2))

    items = client.get(f"/api/projects/{seeded['project_id']}/github/feed").json()["items"]
    assert items[0]["who"] == "김민수"
    assert items[1]["who"] == "stranger-gh"


def test_counts_come_in_vocabulary_order_not_count_order(client, seeded):
    """⭐ 집계는 **어휘 선언 순**입니다. 건수 순이 아닙니다.

    ⚠️ 두 기준이 **갈라지는** 데이터로 잽니다(결함 163) — 이슈를 제일
    많게 만들어, 건수 순이라면 이슈가 맨 앞에 오게 해 둡니다.
    """
    with db_session.session_scope() as s:
        for i in range(3):
            s.add(
                _event(
                    seeded["project_id"],
                    kind=vocab.GithubEventKind.ISSUE_CLOSED,
                    minutes_ago=i + 1,
                )
            )
        s.add(_event(seeded["project_id"], minutes_ago=10))

    counts = client.get(f"/api/projects/{seeded['project_id']}/github/feed").json()["counts"]
    assert [c["kind"] for c in counts] == [str(k) for k in vocab.GithubEventKind], (
        "집계 순서가 어휘 선언 순이 아닙니다 — 건수 순이면 순위표입니다"
    )
    by_kind = {c["kind"]: c["count"] for c in counts}
    assert by_kind["issues.closed"] == 3
    assert by_kind["pull_request.merged"] == 1


def test_zero_kinds_stay_visible_as_zero(client, seeded):
    """0건인 종류도 **0으로** 내려갑니다.

    빼 버리면 화면은 그 종류가 존재하는지조차 모릅니다 — "리뷰 0건" 과
    "리뷰는 안 세어짐" 은 다른 말입니다.
    """
    counts = client.get(f"/api/projects/{seeded['project_id']}/github/feed").json()["counts"]
    assert len(counts) == len(vocab.GithubEventKind)
    assert all(c["count"] == 0 for c in counts)


def test_counts_carry_no_person(client, seeded):
    """⭐ 집계 줄에 **사람이 없습니다.**

    사람별 GitHub 집계는 기여도 화면이 근거와 함께 담당합니다. 여기 또
    만들면 두 벌이고, 건수와 이름이 나란히 서는 순간 순위표입니다.
    """
    with db_session.session_scope() as s:
        s.add(_event(seeded["project_id"]))

    counts = client.get(f"/api/projects/{seeded['project_id']}/github/feed").json()["counts"]
    for row in counts:
        assert set(row) == {"kind", "label", "count"}, (
            f"집계 줄에 정해진 것 밖의 칸이 생겼습니다: {sorted(set(row))}"
        )


def test_outsiders_get_403(client, seeded):
    with db_session.session_scope() as s:
        outsider = m.User(name="남남", email="out@example.com")
        s.add(outsider)
        s.flush()
        outsider_id = outsider.id

    login_as(client, outsider_id)
    response = client.get(f"/api/projects/{seeded['project_id']}/github/feed")
    assert response.status_code == 403
    login_as(client, seeded["user_ids"][0])


def test_logged_out_gets_401(client, seeded):
    logout(client)
    response = client.get(f"/api/projects/{seeded['project_id']}/github/feed")
    assert response.status_code == 401
    login_as(client, seeded["user_ids"][0])
