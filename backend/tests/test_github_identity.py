"""GitHub 아이디를 사람에게 잇기 (결함 112).

`Member.github_login` 은 기여도의 GitHub 다리 전체가 서 있는 칸인데,
**이 칸에 값을 넣는 코드가 저장소에 0곳**이었습니다. 읽는 곳은 넷인데
쓰는 곳은 시드와 테스트뿐이었습니다.
"""

from __future__ import annotations

import pytest

from teamflow.github.identity import clean_github_login, same_login


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("minsu", "minsu"),
        ("  MinSu-Dev  ", "MinSu-Dev"),
        ("a", "a"),
        ("a" * 39, "a" * 39),
        ("a-b-c", "a-b-c"),
        ("0start", "0start"),
    ],
)
def test_a_normal_login_survives(raw: str, expected: str):
    assert clean_github_login(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "https://github.com/minsu",
        "http://github.com/minsu",
        "https://www.github.com/minsu",
        "github.com/minsu",
        "@minsu",
        "github.com/minsu/",
    ],
)
def test_pasting_the_profile_url_works(raw: str):
    """⭐ 사람은 주소를 통째로 붙여 넣습니다.

    거절하면 "형식이 틀렸습니다" 만 보이고 무엇이 틀렸는지는 안 보입니다.
    받아서 정리하는 편이 낫습니다 — 뜻이 분명하기 때문입니다.
    """
    assert clean_github_login(raw) == "minsu"


@pytest.mark.parametrize("raw", [None, "", "   "])
def test_an_empty_value_means_disconnect(raw: str | None):
    """⭐ 지울 방법이 있어야 합니다. 잘못 적으면 남의 PR 이 내게 옵니다."""
    assert clean_github_login(raw) is None


@pytest.mark.parametrize(
    "raw",
    [
        "-minsu",  # 하이픈으로 시작
        "minsu-",  # 하이픈으로 끝
        "min--su",  # 하이픈 연속
        "min su",  # 공백
        "min_su",  # 밑줄
        "민수",  # 한글
        "min.su",  # 점
        "a" * 40,  # 너무 김
    ],
)
def test_a_login_github_could_not_have_made_is_refused(raw: str):
    """GitHub 이 만들 수 없는 이름은 **영원히 아무 배달과도 안 맞습니다.**

    받아 두면 사람은 연결했다고 믿고, 기여도는 계속 빕니다.
    """
    with pytest.raises(ValueError):
        clean_github_login(raw)


def test_the_refusal_says_what_is_wrong_in_korean():
    """오류 문구는 그대로 화면에 나갑니다 (결함 78·86 과 같은 규칙)."""
    with pytest.raises(ValueError) as caught:
        clean_github_login("min su")
    message = str(caught.value)
    assert "GitHub 아이디" in message
    assert "Traceback" not in message and "ValueError" not in message


def test_case_is_ignored_when_comparing():
    """⭐ GitHub 은 대소문자를 **보존하지만 비교는 무시**합니다.

    `==` 로 비교하면 `MinSu` 와 `minsu` 가 다른 사람이 되어, 한 팀에서
    둘 다 등록됩니다 — 그러면 웹훅이 오는 대로 한쪽만 점수를 받습니다.
    """
    assert same_login("MinSu", "minsu")
    assert same_login("minsu", "MINSU")
    assert not same_login("minsu", "haneul")


def test_a_missing_login_is_not_the_same_as_anything():
    """⚠️ `None` 끼리도 같지 않습니다.

    같다고 하면 **아직 연결 안 한 사람 둘이 서로 중복**으로 걸려서,
    두 번째 사람이 아이디를 등록조차 못 합니다.
    """
    assert not same_login(None, None)
    assert not same_login(None, "minsu")
    assert not same_login("minsu", None)
