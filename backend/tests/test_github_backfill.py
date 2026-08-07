"""백필이 무엇을 가져오고 무엇을 건너뛰는가.

여기 있는 것은 전부 순수 함수라 네트워크 없이 돕니다.

이 파일이 고정하는 것: **백필이 조용히 자르지 않는가.**
저장소가 크면 다 못 가져옵니다. 그때 아무 말 없이 자르면 사람은 "백필
했으니 이제 완전하다" 고 믿습니다 — **백필을 안 한 것보다 나쁩니다.**
안 한 줄 알면 최소한 의심은 하니까요.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from teamflow.github import backfill as bf

MERGED = datetime(2026, 5, 1, 12, 0, tzinfo=UTC)


def pull(number: int, *, days_ago: int = 0, merged: bool = True, **kw):
    return bf.PullRequestSummary(
        number=number,
        merged_at=MERGED - timedelta(days=days_ago) if merged else None,
        author_login=kw.get("author_login", "minsu"),
        title=kw.get("title", f"PR {number}"),
        body=kw.get("body"),
        head_ref=kw.get("head_ref"),
    )


# ══════════════════════════════════════════════════════════════
# 상한 — rate limit 을 한 팀이 다 먹으면 안 된다
# ══════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        (None, bf.DEFAULT_LIMIT),
        (10, 10),
        (0, 1),
        (-5, 1),
        (99_999, bf.MAX_LIMIT),
    ],
)
def test_limit_is_clamped(given, expected):
    """⚠️ 상한이 없으면 저장소 하나가 rate limit 창을 통째로 먹고,
    그동안 **다른 팀의 웹훅 처리가 전부 실패**합니다."""
    assert bf.clamp_limit(given) == expected


# ══════════════════════════════════════════════════════════════
# 무엇을 건너뛰는가
# ══════════════════════════════════════════════════════════════


def test_already_stored_pull_requests_are_skipped():
    """⭐ 이미 있는 것을 다시 만들면 업무 카드에 같은 PR 이 두 번 붙고
    진단의 배달 수가 부풀려집니다."""
    result = bf.plan(
        [pull(1), pull(2), pull(3)],
        known_numbers={2},
    )
    assert [p.number for p in result.fetch] == [1, 3]
    assert result.already_have == 1


def test_unmerged_pull_requests_are_not_contributions():
    """여는 것만으로는 기여가 아닙니다 (docs/05 §2.1)."""
    result = bf.plan([pull(1), pull(2, merged=False)], known_numbers=set())
    assert [p.number for p in result.fetch] == [1]
    assert result.not_merged == 1


def test_since_excludes_what_we_already_walked():
    """두 번째 백필이 지난번 구간을 다시 훑지 않게."""
    result = bf.plan(
        [pull(1, days_ago=0), pull(2, days_ago=10), pull(3, days_ago=30)],
        known_numbers=set(),
        since=MERGED - timedelta(days=20),
    )
    assert [p.number for p in result.fetch] == [1, 2]
    assert result.too_old == 1


def test_since_is_exclusive_at_the_boundary():
    """경계의 PR 을 다시 가져오면 그 하나만 매번 중복 처리됩니다."""
    edge = MERGED - timedelta(days=10)
    result = bf.plan([pull(2, days_ago=10)], known_numbers=set(), since=edge)
    assert result.fetch == ()
    assert result.too_old == 1


# ══════════════════════════════════════════════════════════════
# 잘리는 것 — 이 파일의 핵심
# ══════════════════════════════════════════════════════════════


def test_truncation_is_reported_not_hidden():
    """⭐ **조용히 자르면 백필을 안 한 것보다 나쁩니다.**"""
    result = bf.plan([pull(n, days_ago=n) for n in range(1, 11)], known_numbers=set(), limit=3)
    assert len(result.fetch) == 3
    assert result.truncated is True
    assert "상한" in bf.describe(result)
    assert "다시 실행" in bf.describe(result)


def test_not_truncated_when_everything_fits():
    result = bf.plan([pull(1), pull(2)], known_numbers=set(), limit=10)
    assert result.truncated is False
    assert "상한" not in bf.describe(result)


def test_the_newest_survive_truncation():
    """⭐ 상한에 걸리면 **최근 것이 남아야** 합니다.

    지금 진행 중인 일이 기여도에 보이는 쪽이 먼저입니다. 오래된 것부터
    채우면 상한에 걸렸을 때 이번 주 활동이 통째로 빠집니다.
    """
    result = bf.plan(
        [pull(1, days_ago=90), pull(2, days_ago=1), pull(3, days_ago=45)],
        known_numbers=set(),
        limit=2,
    )
    assert [p.number for p in result.fetch] == [2, 3]


def test_the_api_ordering_is_not_trusted():
    """목록 API 가 어떤 순서로 주든 우리가 다시 정렬합니다.

    정렬 파라미터가 바뀌면 조용히 오래된 것부터 채우게 되고, 그건 위
    테스트가 막는 것을 우회합니다.
    """
    oldest_first = [pull(1, days_ago=90), pull(2, days_ago=45), pull(3, days_ago=1)]
    result = bf.plan(oldest_first, known_numbers=set(), limit=1)
    assert [p.number for p in result.fetch] == [3]


def test_covered_since_is_the_oldest_we_actually_took():
    result = bf.plan(
        [pull(1, days_ago=1), pull(2, days_ago=30)], known_numbers=set()
    )
    assert result.covered_since == MERGED - timedelta(days=30)


def test_covered_since_is_none_when_nothing_is_taken():
    result = bf.plan([], known_numbers=set())
    assert result.covered_since is None


# ══════════════════════════════════════════════════════════════
# 배달 id — 두 번 돌려도 한 번만
# ══════════════════════════════════════════════════════════════


def test_the_delivery_id_is_deterministic():
    """⚠️ 무작위로 만들면 백필을 두 번 돌릴 때 유니크 제약이 안 막아 주고
    같은 PR 의 행이 둘이 됩니다."""
    assert bf.delivery_id_for("team/repo", 12) == bf.delivery_id_for("team/repo", 12)


def test_the_delivery_id_ignores_case_like_the_rest_of_the_system():
    """결함 34 와 같은 부류 — 표기가 다르면 같은 저장소가 다른 것이 됩니다."""
    assert bf.delivery_id_for("Team/Repo", 12) == bf.delivery_id_for("team/repo", 12)


def test_different_pull_requests_get_different_ids():
    assert bf.delivery_id_for("team/repo", 12) != bf.delivery_id_for("team/repo", 13)
    assert bf.delivery_id_for("a/b", 12) != bf.delivery_id_for("c/d", 12)


def test_backfilled_rows_are_recognizable():
    """로그에서 이 행이 웹훅이 아니라 백필에서 왔다는 걸 알아야 합니다."""
    assert bf.is_backfilled(bf.delivery_id_for("team/repo", 1))
    assert not bf.is_backfilled("8f3a1c2e-real-github-delivery")
    assert not bf.is_backfilled(None)


# ══════════════════════════════════════════════════════════════
# 웹훅과 같은 모양이어야 한다
# ══════════════════════════════════════════════════════════════


def test_the_payload_passes_through_the_real_webhook_normalizer():
    """⭐ **백필이 웹훅 경로를 그대로 재사용하는지**를 여기서 고정합니다.

    모양이 어긋나면 백필로 들어온 PR 은 업무 카드에 안 붙고 기여 이벤트도
    안 됩니다 — 그런데 행은 저장되므로 진단은 "배달 왔음" 이라고 말합니다.
    """
    from teamflow.github import webhook

    summary = pull(
        12, title="TASK-7 로그인", body="Closes #3", head_ref="feat/7-login"
    )
    payload = bf.to_webhook_payload(summary, repo="team/repo")

    event = webhook.normalize("pull_request", "backfill:team/repo:12", payload)

    assert event is not None
    assert event.event_type == "pull_request.merged"
    assert event.repo == "team/repo"
    assert event.actor_login == "minsu"
    assert event.ref == "feat/7-login"
    assert event.occurred_at == summary.merged_at


def test_the_payload_still_carries_what_task_linking_reads():
    """`link_pull_request` 는 제목·본문·브랜치를 봅니다. 하나라도 빠지면
    그 근거로 붙던 업무가 조용히 안 붙습니다."""
    from teamflow.github.linking import find_task_refs

    summary = pull(12, title="TASK-7 로그인", body=None, head_ref="feat/7-login")
    payload = bf.to_webhook_payload(summary, repo="team/repo")
    pr = payload["pull_request"]

    refs = find_task_refs(title=pr["title"], body=pr["body"], branch=pr["head"]["ref"])
    assert {ref.task_id for ref in refs} == {7}


def test_an_unmerged_summary_never_becomes_a_merged_payload():
    """⚠️ `plan` 이 먼저 거르지만, **여기서도 거짓을 만들면 안 됩니다.**

    `merged` 를 True 로 박아 두면 병합되지 않은 PR 이 병합된 것이 되고,
    거르는 쪽이 한 번 바뀌면 그 거짓이 그대로 기여도가 됩니다. 두 겹으로
    막습니다.

    `merged_at` 만 확인하는 것으로는 부족합니다 — 정규화기가 보는 것은
    `merged` 플래그입니다.
    """
    from teamflow.github import webhook

    payload = bf.to_webhook_payload(pull(1, merged=False), repo="team/repo")
    assert payload["pull_request"]["merged"] is False
    assert payload["pull_request"]["merged_at"] is None

    # 정규화기가 이것을 병합으로 받아들이면 안 됩니다.
    assert webhook.normalize("pull_request", "backfill:team/repo:1", payload) is None
