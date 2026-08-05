"""담당자·마감일 해석기 테스트.

한국어 회의에서 실제로 나오는 표현을 기준으로 잡았다.
ASR이 이름을 틀리는 상황, 상대 날짜, 모호한 표현을 모두 다룬다.
"""

from __future__ import annotations

from datetime import date

import pytest

from teamflow.meeting.resolve import (
    TeamMemberName,
    normalize_name_hint,
    resolve_assignee,
    resolve_deadline,
)

# 2026-09-01 은 화요일
TUE = date(2026, 9, 1)
FRI = date(2026, 9, 4)
SUN = date(2026, 9, 6)

TEAM = [
    TeamMemberName(user_id=1, name="김민수"),
    TeamMemberName(user_id=2, name="이하늘"),
    TeamMemberName(user_id=3, name="박지원"),
    TeamMemberName(user_id=4, name="남궁성현"),
]


# ══════════════════════════════════════════════════════════════
# 담당자
# ══════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("민수", "민수"),
        ("민수님", "민수"),
        ("민수 님", "민수"),
        ("민수씨", "민수"),
        ("김민수 씨", "김민수"),
        ("민수님이", "민수"),
        ("민수한테", "민수"),
        ("김민수가", "김민수"),
        ("민수야", "민수"),
        ("하늘이", "하늘"),
    ],
)
def test_normalize_strips_honorifics_and_particles(raw: str, expected: str):
    assert normalize_name_hint(raw) == expected


@pytest.mark.parametrize(
    ("hint", "expected_id"),
    [
        ("김민수", 1),
        ("민수", 1),
        ("민수님", 1),
        ("김민수 씨", 1),
        ("이하늘", 2),
        ("하늘", 2),
        ("박지원", 3),
        ("지원이", 3),
    ],
)
def test_exact_name_resolution(hint: str, expected_id: int):
    match = resolve_assignee(hint, TEAM)
    assert match.user_id == expected_id
    assert match.score == 1.0


def test_compound_surname_given_name():
    """두 글자 성씨는 이름 부분을 올바로 잘라야 한다."""
    member = TeamMemberName(user_id=4, name="남궁성현")
    assert member.given_name == "성현"
    assert resolve_assignee("성현", TEAM).user_id == 4


def test_asr_typo_still_resolves():
    """ASR이 이름을 살짝 틀려도 잡아야 한다. '김민수' → '김민서'"""
    match = resolve_assignee("김민서", TEAM)
    assert match.user_id == 1
    assert 0.65 <= match.score < 1.0


def test_unknown_name_is_not_forced():
    """모르는 이름을 억지로 팀원에 붙이지 않는다."""
    match = resolve_assignee("최영희", TEAM)
    assert match.user_id is None
    assert "일치하는 팀원 없음" in match.reason


def test_ambiguous_name_is_rejected():
    """두 팀원과 비슷하면 포기한다. 잘못 배정하느니 사람이 정하게 한다."""
    team = [
        TeamMemberName(user_id=1, name="김민수"),
        TeamMemberName(user_id=2, name="이민수"),
    ]
    match = resolve_assignee("민수님", team)
    # '민수'는 두 사람의 given_name 과 정확히 일치 — 첫 번째가 잡히면 안 된다
    assert match.user_id is None or match.reason.startswith("정확히 일치")


def test_similar_but_different_names_do_not_match():
    """'민수' 와 '민정' 은 다른 사람이다."""
    team = [TeamMemberName(user_id=1, name="김민정")]
    assert resolve_assignee("민수", team).user_id is None


@pytest.mark.parametrize(
    "hint", ["디자이너", "백엔드", "담당자", "팀장", "다같이", "각자", "누군가"]
)
def test_role_words_are_not_names(hint: str):
    """역할 표현을 이름으로 해석하면 안 된다."""
    match = resolve_assignee(hint, TEAM)
    assert match.user_id is None
    assert "역할 표현" in match.reason


def test_empty_hint():
    for hint in (None, "", "   "):
        match = resolve_assignee(hint, TEAM)
        assert match.user_id is None
        assert match.score == 0.0


def test_alias_resolution():
    team = [TeamMemberName(user_id=1, name="김민수", aliases=("민수형", "MS"))]
    assert resolve_assignee("민수형", team).user_id == 1
    assert resolve_assignee("MS", team).user_id == 1


# ══════════════════════════════════════════════════════════════
# 마감일
# ══════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    ("hint", "expected"),
    [
        ("2026-09-10", date(2026, 9, 10)),
        ("2026/09/10", date(2026, 9, 10)),
        ("9월 10일", date(2026, 9, 10)),
        ("9월10일까지", date(2026, 9, 10)),
    ],
)
def test_absolute_dates(hint: str, expected: date):
    match = resolve_deadline(hint, TUE)
    assert match.value == expected
    assert match.confidence == 1.0


@pytest.mark.parametrize(
    ("hint", "expected"),
    [
        ("오늘", TUE),
        ("내일", date(2026, 9, 2)),
        ("모레", date(2026, 9, 3)),
        ("글피", date(2026, 9, 4)),
    ],
)
def test_relative_days(hint: str, expected: date):
    assert resolve_deadline(hint, TUE).value == expected


def test_bare_weekday_resolves_to_next_occurrence():
    """화요일 회의에서 '금요일까지' → 같은 주 금요일"""
    match = resolve_deadline("금요일까지", TUE)
    assert match.value == FRI
    assert match.value.weekday() == 4


def test_bare_weekday_same_day_goes_to_next_week():
    """금요일 회의에서 '금요일까지' → 다음 주 금요일 (오늘은 아님)"""
    match = resolve_deadline("금요일까지", FRI)
    assert match.value == date(2026, 9, 11)


@pytest.mark.parametrize(
    ("hint", "expected"),
    [
        ("이번 주 금요일", FRI),
        ("이번주 금요일까지", FRI),
        ("금주 금요일", FRI),
        ("다음 주 월요일", date(2026, 9, 7)),
        ("다음주 월요일까지", date(2026, 9, 7)),
        ("담주 화요일", date(2026, 9, 8)),
        ("차주 수요일", date(2026, 9, 9)),
    ],
)
def test_qualified_weekdays(hint: str, expected: date):
    match = resolve_deadline(hint, TUE)
    assert match.value == expected
    assert match.confidence >= 0.9


def test_this_week_weekday_already_passed_is_low_confidence():
    """금요일 회의에서 '이번 주 월요일'은 이미 지났다. 다음 주로 해석하되 확신도를 낮춘다."""
    match = resolve_deadline("이번 주 월요일", FRI)
    assert match.value == date(2026, 9, 7)
    assert match.confidence < 0.7
    assert "이미 지나" in match.reason


@pytest.mark.parametrize(
    ("hint", "expected"),
    [
        ("이번 주까지", SUN),
        ("이번주까지", SUN),
        ("다음 주까지", date(2026, 9, 13)),
        ("담주까지", date(2026, 9, 13)),
    ],
)
def test_week_ranges(hint: str, expected: date):
    assert resolve_deadline(hint, TUE).value == expected


@pytest.mark.parametrize(
    ("hint", "expected"),
    [
        ("3일 안에", date(2026, 9, 4)),
        ("5일 이내", date(2026, 9, 6)),
        ("일주일 안에", date(2026, 9, 8)),
        ("2주 안에", date(2026, 9, 15)),
    ],
)
def test_durations(hint: str, expected: date):
    assert resolve_deadline(hint, TUE).value == expected


def test_end_of_month():
    assert resolve_deadline("이번 달 말까지", TUE).value == date(2026, 9, 30)
    assert resolve_deadline("월말까지", TUE).value == date(2026, 9, 30)


def test_day_only_this_month():
    assert resolve_deadline("10일까지", TUE).value == date(2026, 9, 10)


def test_day_only_already_passed_rolls_to_next_month():
    """9월 20일 회의에서 '5일까지' → 10월 5일"""
    match = resolve_deadline("5일까지", date(2026, 9, 20))
    assert match.value == date(2026, 10, 5)


def test_year_rollover():
    """12월 회의에서 '1월 5일' → 내년"""
    match = resolve_deadline("1월 5일", date(2026, 12, 20))
    assert match.value == date(2027, 1, 5)


@pytest.mark.parametrize(
    "hint", [None, "", "   ", "빨리", "가능한 한 빨리", "나중에", "적당히"]
)
def test_unparseable_returns_none(hint: str | None):
    """해석할 수 없으면 억지로 날짜를 만들지 않는다."""
    match = resolve_deadline(hint, TUE)
    assert match.value is None
    assert match.confidence == 0.0


def test_invalid_date_rejected():
    assert resolve_deadline("2월 30일", TUE).value is None


def test_reason_is_always_present():
    """실패했을 때 왜 실패했는지 설명할 수 있어야 한다."""
    for hint in ("금요일", "빨리", None, "9월 10일"):
        assert resolve_deadline(hint, TUE).reason
