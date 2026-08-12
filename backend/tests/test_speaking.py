"""발언 비중 (정의서 §9 `AI-AUDIO-005` · §12 `AI-REVIEW-007`).

⚠️ 이 저장소에서 제일 위험한 값입니다. 정의서의 예시가 내림차순 목록
(= 리더보드)인데, 같은 문서의 다른 두 조항이 그걸 금지합니다
(`docs/20` §3). 여기서 지키는 것은 **값을 만들되 줄을 세우지 않는 것**
입니다.
"""

from __future__ import annotations

from teamflow.meeting.speaking import (
    MIN_TOTAL_MS,
    Span,
    measurable,
    merged_ms,
    shares,
    skewed,
)

MIN = 60 * 1000


def span(user_id: int, start_s: int, end_s: int) -> Span:
    return Span(user_id=user_id, start_ms=start_s * 1000, end_ms=end_s * 1000)


# ══════════════════════════════════════════════════════════════
# 겹치는 구간
# ══════════════════════════════════════════════════════════════


def test_touching_spans_are_added():
    assert merged_ms([span(1, 0, 10), span(1, 20, 30)]) == 20_000


def test_overlapping_spans_are_not_counted_twice():
    """⭐ 그냥 더하면 겹친 만큼 **말을 많이 한 것처럼** 보입니다."""
    assert merged_ms([span(1, 0, 10), span(1, 5, 15)]) == 15_000


def test_a_span_inside_another_adds_nothing():
    assert merged_ms([span(1, 0, 30), span(1, 10, 20)]) == 30_000


def test_spans_out_of_order_are_still_right():
    assert merged_ms([span(1, 20, 30), span(1, 0, 10)]) == 20_000


def test_a_backwards_span_does_not_go_negative():
    """⚠️ 끝이 시작보다 앞선 값이 들어오면 음수가 나옵니다 — 그러면 남의
    시간을 깎습니다."""
    assert merged_ms([Span(user_id=1, start_ms=5_000, end_ms=0)]) == 5_000


def test_nothing_is_zero():
    assert merged_ms([]) == 0


# ══════════════════════════════════════════════════════════════
# 몫
# ══════════════════════════════════════════════════════════════


def test_two_people_split_the_time():
    got = shares([span(1, 0, 60), span(2, 60, 120)], [1, 2])
    assert [s.ratio for s in got] == [0.5, 0.5]


def test_someone_who_said_nothing_stays_in_the_list():
    """⭐ 빼면 목록에 있는 사람이 곧 **말한 사람**이 되고, 없는 사람은
    조용히 지워집니다."""
    got = shares([span(1, 0, 60)], [1, 2])
    assert [s.user_id for s in got] == [1, 2]
    assert got[1].speaking_ms == 0
    assert got[1].ratio == 0.0


def test_a_silent_meeting_is_none_not_zero():
    """⭐ 분모가 0이면 **비중이라는 것이 존재하지 않습니다.**

    0.0 을 돌려주면 "다들 0% 말했다" 는 **잰 값**처럼 보입니다 —
    결함 121 이 정확히 그것이었습니다.
    """
    got = shares([], [1, 2])
    assert [s.ratio for s in got] == [None, None]


def test_the_order_is_the_one_we_were_given():
    """⭐ **정렬하지 않습니다.** 정렬하는 순간 그게 순위가 됩니다."""
    got = shares([span(1, 0, 10), span(2, 0, 120)], [1, 2])
    assert [s.user_id for s in got] == [1, 2]  # 말 많이 한 2번이 뒤에 그대로


def test_people_talking_at_once_both_count():
    """⚠️ 둘이 동시에 말했으면 **둘 다 말한 것**이 맞습니다.

    그래서 몫의 합이 1을 넘을 수 있고, 그건 틀린 게 아닙니다.
    """
    got = shares([span(1, 0, 60), span(2, 0, 60)], [1, 2])
    assert [s.speaking_ms for s in got] == [60_000, 60_000]


def test_spans_from_outside_the_list_are_dropped():
    """명단에 없는 사람의 발화가 분모를 부풀리면 남의 몫이 줄어듭니다."""
    got = shares([span(1, 0, 60), span(9, 0, 60)], [1])
    assert got[0].ratio == 1.0


# ══════════════════════════════════════════════════════════════
# ⭐ 잴 만한 회의인가
# ══════════════════════════════════════════════════════════════


def test_a_short_meeting_is_not_measurable():
    """⭐ 3분짜리 회의에서 한 사람이 70% 말한 것은 **아무 뜻이 없습니다.**

    짧은 표본에서 나온 비율을 보여 주면 사람은 그걸 경향으로 읽습니다.
    """
    got = shares([span(1, 0, 120), span(2, 120, 180)], [1, 2])
    assert measurable(got) is False


def test_a_long_enough_meeting_is_measurable():
    got = shares([span(1, 0, 400), span(2, 400, 700)], [1, 2])
    assert sum(s.speaking_ms for s in got) >= MIN_TOTAL_MS
    assert measurable(got) is True


# ══════════════════════════════════════════════════════════════
# ⭐ 편중 (AI-REVIEW-007)
# ══════════════════════════════════════════════════════════════


def test_an_even_meeting_is_not_skewed():
    got = shares([span(1, 0, 300), span(2, 300, 600)], [1, 2])
    assert skewed(got) is False


def test_one_person_dominating_is_skewed():
    got = shares([span(1, 0, 540), span(2, 540, 600)], [1, 2])
    assert skewed(got) is True


def test_a_short_meeting_is_never_skewed():
    """⭐ 잴 수 없는 것을 **쏠렸다**고 말하지 않습니다."""
    got = shares([span(1, 0, 100), span(2, 100, 110)], [1, 2])
    assert skewed(got) is False


def test_a_silent_meeting_is_never_skewed():
    assert skewed(shares([], [1, 2])) is False


def test_one_person_alone_is_never_skewed():
    """혼자 한 회의는 언제나 100% 입니다 — 그걸 편중이라 부르면 뜻이 없습니다."""
    got = shares([span(1, 0, 600)], [1])
    assert skewed(got) is False


def test_skew_does_not_say_who():
    """⭐ **누가 쏠렸는지는 안 돌려줍니다.**

    이름을 같이 돌려주면 부르는 쪽은 그걸 화면에 적고, 그 순간
    **"이 회의를 독점한 사람" 표시**가 됩니다. 회의에는 발제하는 사람이
    있고, 그 사람이 많이 말하는 것은 정상입니다.
    """
    got = shares([span(1, 0, 540), span(2, 540, 600)], [1, 2])
    assert skewed(got) is True
    assert isinstance(skewed(got), bool)
