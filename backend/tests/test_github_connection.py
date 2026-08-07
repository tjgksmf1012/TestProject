"""GitHub 연결 표기·진단.

이 파일이 고정하는 것: **연결이 안 됐을 때 화면이 조용하지 않은가.**

`docs/15` §4.2 가 이 시스템의 가장 위험한 실패를 이렇게 적었습니다 —
"틀리면 오류 없이 기여도만 빕니다." 성적에 쓰일 수 있는 값이 조용히
0 이 되는 것은 버그가 아니라 오답입니다.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from teamflow.github.connection import (
    ConnectionFacts,
    NearMiss,
    diagnose,
    looks_like_typo_of,
    repo_key,
    same_repo,
    split_repo,
)

AT = datetime(2026, 9, 1, tzinfo=UTC)


# ══════════════════════════════════════════════════════════════
# 대조용 표기
# ══════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("team/teamflow", "team/teamflow"),
        ("Team/TeamFlow", "team/teamflow"),
        ("TJGKSMF1012/TestProject", "tjgksmf1012/testproject"),
        ("  team/teamflow  ", "team/teamflow"),
        ("", None),
        ("   ", None),
        (None, None),
    ],
)
def test_repo_key_normalizes(raw, expected):
    assert repo_key(raw) == expected


def test_the_case_a_human_types_and_the_case_github_sends_are_the_same_repo():
    """**이 한 줄이 결함 34 입니다.**

    사람은 손으로 소문자를 적고, GitHub 은 정식 표기로 배달합니다.
    이 둘이 다른 저장소로 취급되면 웹훅이 전부 조용히 버려집니다.
    """
    assert same_repo("tjgksmf1012/testproject", "tjgksmf1012/TestProject")


def test_different_repos_are_not_the_same():
    assert not same_repo("team/teamflow", "team/teamflow-web")
    assert not same_repo("team/teamflow", "other/teamflow")


def test_nothing_is_the_same_as_nothing():
    """빈 값 둘을 '같다' 로 보면 저장소를 안 적은 프로젝트 전부가 서로
    충돌하고, 웹훅이 아무 프로젝트에나 붙습니다."""
    assert not same_repo(None, None)
    assert not same_repo("", "")
    assert not same_repo(None, "team/teamflow")


def test_split_repo():
    assert split_repo("team/teamflow") == ("team", "teamflow")
    assert split_repo("garbage") == ("garbage", "")


# ══════════════════════════════════════════════════════════════
# 오타 후보 판정 — 캐내기 도구가 되면 안 된다
# ══════════════════════════════════════════════════════════════


def test_owner_typo_is_caught():
    assert looks_like_typo_of("tjgksmf/testproject", "tjgksmf1012/testproject")


def test_repo_name_typo_is_caught():
    assert looks_like_typo_of("team/teamflow", "team/team-flow")


def test_case_difference_is_not_a_typo_candidate():
    """대소문자는 이제 정상으로 붙습니다 — 오타 후보로 뜨면 안 됩니다."""
    assert not looks_like_typo_of("team/teamflow", "team/TeamFlow")


def test_a_completely_unrelated_repo_is_never_surfaced():
    """⚠️ 이게 느슨하면 **App 이 설치된 저장소 목록을 캐내는 도구**가 됩니다.

    프로젝트 구성원이면 누구나 진단을 볼 수 있으므로, 아무 이름이나 적어
    두고 무엇이 뜨는지 보는 방식으로 남의 저장소를 알아낼 수 있게 됩니다.
    """
    assert not looks_like_typo_of("mine/myrepo", "someoneelse/secret")
    assert not looks_like_typo_of("a/b", "c/d")


# ══════════════════════════════════════════════════════════════
# 진단
# ══════════════════════════════════════════════════════════════


def test_no_repo_says_what_is_lost():
    state = diagnose(ConnectionFacts())
    assert state.code == "no_repo"
    assert state.next_step is not None


def test_missing_webhook_secret_points_at_the_admin_not_the_team():
    """팀이 고칠 수 없는 것을 팀에게 시키면 영원히 안 고쳐집니다."""
    state = diagnose(ConnectionFacts(repo="team/teamflow", webhook_secret_present=False))
    assert state.code == "server_missing_webhook_secret"
    assert state.severity == "bad"
    assert "관리자" in (state.next_step or "")


def test_waiting_when_nothing_arrived_yet():
    state = diagnose(
        ConnectionFacts(repo="team/teamflow", webhook_secret_present=True)
    )
    assert state.code == "waiting_for_delivery"
    # 이름을 적은 것과 연결된 것이 다르다는 걸 말해야 합니다.
    assert "설치" in state.detail or "설치" in (state.next_step or "")


def test_deliveries_already_stored_count_as_proof():
    """⭐ 결함 48 — 화면이 스스로를 반박하던 것.

    `github_verified_at` 은 나중에 추가한 칸입니다. 그 전에 이벤트가
    쌓인 프로젝트는 `verified_at` 이 NULL 인데 배달은 수십 건입니다.
    `verified_at` 만 보면 진단이 "아직 배달이 온 적이 없습니다" 라고
    말하고, 같은 화면 아래 줄이 "배달 12건 · 마지막 3분 전" 이라고
    말합니다.

    나쁜 건 어색함이 아니라 **다음 할 일**입니다. 진단은 "GitHub App 이
    설치돼 있는지 확인하세요" 를 시킵니다. 가 보면 멀쩡히 설치돼
    있습니다 — 고칠 것이 없는 문제를 찾게 만듭니다.
    """
    state = diagnose(
        ConnectionFacts(
            repo="team/teamflow",
            webhook_secret_present=True,
            app_credentials_present=True,
            verified_at=None,  # 마이그레이션 전에 들어온 이벤트
            delivery_count=12,
            member_logins=frozenset({"minsu"}),
            actor_logins=frozenset({"minsu"}),
        )
    )
    assert state.code == "connected"
    assert state.code != "waiting_for_delivery"


def test_nothing_arrived_is_still_nothing_arrived():
    """위 완화가 '배달 0건' 까지 연결로 넘기면 안 됩니다."""
    state = diagnose(
        ConnectionFacts(
            repo="team/teamflow",
            webhook_secret_present=True,
            app_credentials_present=True,
            verified_at=None,
            delivery_count=0,
        )
    )
    assert state.code == "waiting_for_delivery"


def test_a_near_miss_names_the_repo_to_fix():
    """가장 값어치 있는 진단 — 무엇을 무엇으로 고쳐야 하는지 말합니다."""
    state = diagnose(
        ConnectionFacts(
            repo="tjgksmf/testproject",
            webhook_secret_present=True,
            near_misses=(NearMiss(repo="tjgksmf1012/testproject", last_seen_at=AT, count=7),),
        )
    )
    assert state.code == "repo_name_mismatch"
    assert state.severity == "bad"
    assert "tjgksmf1012/testproject" in (state.next_step or "")


def test_the_most_delivered_near_miss_wins():
    """여러 후보를 늘어놓으면 고르는 일이 사람에게 넘어갑니다."""
    state = diagnose(
        ConnectionFacts(
            repo="team/teamflow",
            webhook_secret_present=True,
            near_misses=(
                NearMiss(repo="team/teamflow-old", last_seen_at=AT, count=1),
                NearMiss(repo="team/teamflow-web", last_seen_at=AT, count=9),
            ),
        )
    )
    assert "team/teamflow-web" in (state.next_step or "")


def test_verified_but_no_app_credentials_is_not_silent():
    state = diagnose(
        ConnectionFacts(
            repo="team/teamflow",
            webhook_secret_present=True,
            verified_at=AT,
            app_credentials_present=False,
            delivery_count=3,
        )
    )
    assert state.code == "server_missing_app_credentials"
    assert state.severity == "bad"


def test_no_member_logins_means_everyone_scores_zero():
    """배달이 와도 사람과 이어지지 않으면 전원이 0 입니다. 조용하면 안 됩니다."""
    state = diagnose(
        ConnectionFacts(
            repo="team/teamflow",
            webhook_secret_present=True,
            verified_at=AT,
            app_credentials_present=True,
            delivery_count=12,
            member_logins=frozenset(),
        )
    )
    assert state.code == "no_member_logins"
    assert state.severity == "bad"


def test_actors_that_match_nobody_look_like_the_wrong_repo():
    state = diagnose(
        ConnectionFacts(
            repo="team/teamflow",
            webhook_secret_present=True,
            verified_at=AT,
            app_credentials_present=True,
            delivery_count=12,
            member_logins=frozenset({"minsu-dev"}),
            actor_logins=frozenset({"someone-else"}),
        )
    )
    assert state.code == "actors_do_not_match"
    assert "someone-else" in state.detail


def test_connected_is_the_only_ok_state():
    state = diagnose(
        ConnectionFacts(
            repo="team/teamflow",
            webhook_secret_present=True,
            verified_at=AT,
            app_credentials_present=True,
            delivery_count=12,
            member_logins=frozenset({"minsu-dev"}),
            actor_logins=frozenset({"minsu-dev"}),
        )
    )
    assert state.code == "connected"
    assert state.severity == "ok"
    assert state.next_step is None


def test_members_without_a_github_account_are_warned_about_even_when_connected():
    """연결이 정상이어도 계정을 안 건 사람은 **조용히 0** 이 됩니다."""
    state = diagnose(
        ConnectionFacts(
            repo="team/teamflow",
            webhook_secret_present=True,
            verified_at=AT,
            app_credentials_present=True,
            delivery_count=12,
            member_logins=frozenset({"minsu-dev"}),
            actor_logins=frozenset({"minsu-dev"}),
            members_without_login=("이하늘", "박지원"),
        )
    )
    assert state.code == "connected"
    assert any("이하늘" in w for w in state.warnings)
    assert any("기여도" in w for w in state.warnings)


def test_the_warning_travels_with_every_state():
    """상태가 나쁠 때도 이 경고는 사라지면 안 됩니다 — 둘 다 고쳐야 합니다."""
    state = diagnose(ConnectionFacts(members_without_login=("이하늘",)))
    assert state.code == "no_repo"
    assert state.warnings


def test_no_warning_when_everyone_is_linked():
    state = diagnose(
        ConnectionFacts(repo="team/teamflow", webhook_secret_present=True)
    )
    assert state.warnings == []
