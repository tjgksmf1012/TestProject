"""GitHub 사건을 사람 말로 옮기는 자리 (결함 347).

같은 사건을 활동 기록과 찾기가 각자 옮기고 있었고, 찾기 쪽만 원본을
그대로 내보냈습니다.

    활동 기록   PR 병합 · 박지원
    찾기        pull_request.merged · jiwon-db      ← 화면에 이렇게 떴습니다

내부 enum 을 그대로 띄우는 것은 결함 78·86 이 못 박은 것이고, `vocab.py` 는
`GITHUB_EVENT_LABEL` 옆에 「서버가 라벨을 만들어 내려보냅니다」라고 적어
뒀습니다.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.db import vocab
from teamflow.github import presenting
from teamflow.services import github_feed_service, search_service

from .test_api import client, engine, seeded  # noqa: F401  (픽스처)


def test_every_kind_has_a_korean_word():
    """⭐ 어휘의 값마다 사람 말이 있다 — 하나가 비면 그 값만 영어로 샙니다."""
    for kind in vocab.GithubEventKind:
        label = presenting.event_label(str(kind))
        assert label != str(kind), f"{kind} 에 사람 말이 없습니다"
        # ⚠️ 「영문이 없는가」로 재면 안 됩니다 — 「PR 병합」의 `PR` 은
        #    한국어에서 그대로 쓰는 말이고, 처음에 그 자로 재서 빨개졌습니다.
        #    요구는 **내부 식별자가 안 새는 것**입니다.
        assert "_" not in label and "." not in label, (
            f"{kind} 의 이름표에 내부 식별자가 남아 있습니다: {label}"
        )
        assert any("가" <= c <= "힣" for c in label), (
            f"{kind} 의 이름표에 한국어가 없습니다: {label}"
        )


def test_unknown_kind_is_returned_as_is():
    """모르는 종류는 **지어내지 않습니다** — 그대로 두면 화면에서 보입니다."""
    assert presenting.event_label("brand_new.kind") == "brand_new.kind"


@pytest.mark.parametrize(
    ("member_name", "login", "expected"),
    [
        ("박지원", "jiwon-db", "박지원"),
        (None, "dependabot[bot]", "dependabot[bot]"),
        ("", "outside-helper", "outside-helper"),
        # ⭐ 셋째 갈래 — GitHub 은 계정이 지워지면 `"user": null` 을 보내고
        #   `client.py` 가 빈 글자를 만듭니다. 빈 글자를 그대로 내보내면
        #   화면의 칸이 통째로 사라져 「고장」으로 읽힙니다.
        (None, "", presenting.UNKNOWN_ACTOR),
        (None, None, presenting.UNKNOWN_ACTOR),
        ("   ", "  ", presenting.UNKNOWN_ACTOR),
    ],
)
def test_actor_name_has_three_branches(member_name, login, expected):
    assert presenting.actor_name(member_name, login) == expected


def test_the_unknown_actor_is_not_an_empty_box():
    """⛔ 빈 글자는 「없음」이 아니라 「고장」으로 읽힙니다."""
    assert presenting.UNKNOWN_ACTOR.strip() != ""


@pytest.fixture
def gh_session(engine, seeded):  # noqa: F811
    """씨앗 프로젝트가 든 세션. 두 서비스가 **같은 데이터**를 봐야 합니다."""
    with db_session.session_scope() as s:
        yield s


def _seed(session, *, login: str, user_id: int | None) -> m.GithubEvent:
    row = m.GithubEvent(
        project_id=1,
        delivery_id=f"d-{login or 'blank'}-{user_id}",
        repo="owner/repo",
        event_type=str(vocab.GithubEventKind.ISSUE_CLOSED),
        actor_login=login,
        actor_user_id=user_id,
        ref=None,
        payload={},
        occurred_at=datetime(2026, 9, 5, 6, tzinfo=UTC),
    )
    session.add(row)
    session.flush()
    return row


def test_the_two_screens_say_the_same_words(gh_session):
    """⭐ **활동 기록과 찾기가 같은 사건을 같은 말로** 부른다 (결함 347).

    ⚠️ 낱말이 아니라 **두 자리를 나란히 놓고** 잽니다 — 한쪽만 고치면
    이 검사가 빨개집니다 (결함 290 의 방법).
    """
    session = gh_session
    _seed(session, login="jiwon-db", user_id=3)

    feed = {(i.repo, i.label, i.who) for i in github_feed_service.recent(session, 1)}
    hits = search_service.search_github(session, 1, "owner/repo")
    found = {(h.title.split(" · ")[0], h.title.split(" · ")[1], h.who) for h in hits}

    # ⚠️ **빈손이면 `⊆` 는 거저 참입니다.** 심어 보니 이 검사가 갈라짐을
    #    안 잡길래 세어 봤습니다 — 두 쪽이 실제로 그 사건을 봤는지 먼저.
    assert feed, "활동 기록이 그 사건을 못 읽었습니다"
    assert found, "찾기가 그 사건을 못 찾았습니다 — 이 검사는 아무것도 안 재고 있었습니다"

    assert found <= feed, (
        "찾기가 활동 기록과 다른 말을 합니다 — "
        f"찾기 {sorted(found)} vs 활동 {sorted(feed)}"
    )


def test_neither_screen_leaks_the_raw_enum(gh_session):
    """⛔ 내부 enum 이 사람에게 나가지 않는다 (결함 78·86)."""
    session = gh_session
    _seed(session, login="jiwon-db", user_id=3)

    raw = {str(k) for k in vocab.GithubEventKind}
    for item in github_feed_service.recent(session, 1):
        assert item.label not in raw, f"활동 기록에 원본 값이 샜습니다: {item.label}"
    for hit in search_service.search_github(session, 1, "owner/repo"):
        for piece in hit.title.split(" · "):
            assert piece not in raw, f"찾기에 원본 값이 샜습니다: {hit.title}"


def test_a_deleted_github_account_does_not_leave_an_empty_column(gh_session):
    """⭐ 로그인도 이름도 없으면 **모른다고 적는다** — 빈 칸으로 두지 않는다."""
    session = gh_session
    _seed(session, login="", user_id=None)

    feed = github_feed_service.recent(session, 1)
    assert feed, "이벤트를 못 읽었습니다 — 씨앗을 확인하세요"
    assert all(i.who.strip() != "" for i in feed), [i.who for i in feed]

    hits = search_service.search_github(session, 1, "owner/repo")
    assert hits, "검색이 그 이벤트를 못 찾았습니다"
    assert all(h.who.strip() != "" for h in hits), [h.who for h in hits]
