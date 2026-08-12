"""`@이름` 을 뽑는 판정 (CHAT-005).

⚠️ **서버만 판정합니다.** 화면이 "누구를 멘션했다" 는 목록을 보내면 그걸
믿는 서버는 아무나 아무에게나 알림을 쏘게 됩니다 — 본문에는 없는데 목록
에만 스무 명을 적어 보내면 그만입니다.
"""

from __future__ import annotations

from teamflow.chat.mentions import find_mentions, strip_mention_marks

TEAM = ["윤식", "민수", "지연", "hong7"]


def test_a_plain_mention_is_found():
    assert find_mentions("@윤식 로그인 화면 확인해주세요.", TEAM) == ["윤식"]


def test_someone_not_on_the_team_is_dropped():
    """⚠️ 이름을 **지어내지 않습니다.**

    후보에 없는 `@아무개` 를 남기면 알림이 갈 곳이 없는데도 "불렀다" 는
    기록만 남습니다.
    """
    assert find_mentions("@없는사람 안녕", TEAM) == []
    assert find_mentions("@윤식 @없는사람", TEAM) == ["윤식"]


def test_no_candidates_means_nobody_was_called():
    assert find_mentions("@윤식 안녕", []) == []


def test_a_korean_particle_after_the_name_does_not_break_it():
    """`@윤식은` 은 `윤식` + 조사 `은` 입니다."""
    assert find_mentions("@윤식은 어떻게 생각해요?", TEAM) == ["윤식"]
    assert find_mentions("@민수씨 확인 부탁드려요", TEAM) == ["민수"]


def test_the_longer_name_wins():
    """⚠️ 이름이 `윤식은` 인 사람이 있으면 그 사람입니다.

    짧은 것부터 맞추면 `윤식은` 을 부른 글이 영영 `윤식` 에게 갑니다.
    """
    team = [*TEAM, "윤식은"]
    assert find_mentions("@윤식은 어떻게 생각해요?", team) == ["윤식은"]
    assert find_mentions("@윤식 어떻게 생각해요?", team) == ["윤식"]


def test_order_is_the_order_they_appear_not_sorted():
    """먼저 부른 사람을 알 수 있어야 합니다."""
    assert find_mentions("@지연 그리고 @민수 봐주세요", TEAM) == ["지연", "민수"]
    assert find_mentions("@민수 그리고 @지연 봐주세요", TEAM) == ["민수", "지연"]


def test_the_same_person_twice_is_once():
    assert find_mentions("@윤식 @윤식 급해요", TEAM) == ["윤식"]


def test_numbers_and_latin_names_work():
    """GitHub 아이디 같은 이름도 팀원 이름일 수 있습니다."""
    assert find_mentions("@hong7 PR 봐주세요", TEAM) == ["hong7"]


def test_an_email_in_the_body_is_not_a_mention():
    """⚠️ `a@b.com` 의 `@b` 를 멘션으로 잡으면 안 됩니다.

    후보에 `b.com` 이 없으므로 걸러집니다 — 그게 "후보에 있는 것만" 규칙이
    지켜 주는 것 중 하나입니다.
    """
    assert find_mentions("minsu@example.com 으로 보내주세요", TEAM) == []


def test_stripping_marks_is_for_search_only():
    assert strip_mention_marks("@윤식 확인 부탁") == "윤식 확인 부탁"
    assert strip_mention_marks("멘션 없음") == "멘션 없음"
