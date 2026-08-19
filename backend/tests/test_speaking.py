"""발언 비중 (정의서 §9 `AI-AUDIO-005` · §12 `AI-REVIEW-007`).

⚠️ 이 저장소에서 제일 위험한 값입니다. 정의서의 예시가 내림차순 목록
(= 리더보드)인데, 같은 문서의 다른 두 조항이 그걸 금지합니다
(`docs/20` §3). 여기서 지키는 것은 **값을 만들되 줄을 세우지 않는 것**
입니다.
"""

from __future__ import annotations

from itertools import pairwise

from teamflow.meeting.speaking import (
    MIN_MEETING_MS,
    MIN_TOTAL_MS,
    MIN_WINDOW_OVERLAP_MS,
    OVERLAP_RISE,
    WINDOW_MS,
    Span,
    measurable,
    merged_ms,
    overlap_ms,
    overlap_windows,
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


# ══════════════════════════════════════════════════════════════
# 동시 발언이 늘어난 구간 (`AI-REVIEW-008`)
# ══════════════════════════════════════════════════════════════


def test_overlap_counts_only_different_people():
    """⭐ 같은 사람의 조각끼리 겹친 것은 안 셉니다.

    한 사람이 자기 말을 끊을 수는 없습니다 — 그건 대개 분절이 잘게 난
    것뿐이고, 세면 겹침이 있지도 않은 회의에서 부풀어 오릅니다.
    """
    assert overlap_ms([Span(1, 0, 5_000), Span(1, 3_000, 8_000)]) == 0
    assert overlap_ms([Span(1, 0, 5_000), Span(2, 3_000, 8_000)]) == 2_000


def test_overlap_does_not_double_count_three_people():
    """⚠️ 셋이 동시에 말한 구간을 두 번 세면 안 됩니다.

    쌍을 세면 3초가 9초가 됩니다. "말하고 있는 사람이 둘 이상인 시간" 을
    셉니다.
    """
    got = overlap_ms([Span(1, 0, 3_000), Span(2, 0, 3_000), Span(3, 0, 3_000)])
    assert got == 3_000


def test_overlap_of_nothing():
    assert overlap_ms([]) == 0
    assert overlap_ms([Span(1, 0, 0)]) == 0


def _steady(minutes: int, *, gap_ms: int = 0) -> list[Span]:
    """분마다 한 사람이 50초씩 말하고, `gap_ms` 만큼 다음 사람과 겹친다."""
    spans: list[Span] = []
    for i in range(minutes):
        at = i * 60_000
        spans.append(Span(1, at, at + 50_000))
        spans.append(Span(2, at + 50_000 - gap_ms, at + 55_000))
    return spans


def test_a_short_meeting_says_nothing():
    """⚠️ 짧은 회의는 구간을 안 나눕니다 — 모르는 것을 '안 늘었다' 로 말하지 않습니다."""
    assert overlap_windows(_steady(3, gap_ms=500)) == []
    assert MIN_MEETING_MS == 6 * 60 * 1000


def test_a_meeting_with_no_overlap_says_nothing():
    """겹침이 0 이면 바탕이 0 이라 '몇 배' 를 말할 수 없습니다."""
    assert overlap_windows(_steady(20)) == []


def test_a_spike_is_found():
    """⭐ 바탕보다 확 늘어난 구간을 집어냅니다."""
    spans = _steady(20, gap_ms=200)
    # 12~13분 사이에 셋이 30초를 통째로 겹쳐 말한다.
    spans += [
        Span(1, 12 * 60_000, 12 * 60_000 + 30_000),
        Span(2, 12 * 60_000, 12 * 60_000 + 30_000),
        Span(3, 12 * 60_000, 12 * 60_000 + 30_000),
    ]
    windows = overlap_windows(spans)
    assert windows, "급증 구간을 못 찾았습니다"
    hit = [w for w in windows if w.start_ms <= 12 * 60_000 < w.end_ms]
    assert hit, f"12분 자리가 없습니다: {[(w.start_ms, w.end_ms) for w in windows]}"
    assert hit[0].overlap_ms >= 30_000
    assert hit[0].ratio >= hit[0].baseline * OVERLAP_RISE


def test_a_window_never_names_anyone():
    """⛔ **누가 겹쳤는지는 안 돌려줍니다.**

    이름을 같이 주면 부르는 쪽이 화면에 적고, 그 순간 **말 끊은 사람
    표시**가 됩니다. 겹침은 두 사람 사이의 일이지 한 사람의 잘못이
    아닙니다 — `skewed` 와 같은 원칙입니다.
    """
    spans = [
        *_steady(20, gap_ms=200),
        Span(1, 12 * 60_000, 12 * 60_000 + 30_000),
        Span(2, 12 * 60_000, 12 * 60_000 + 30_000),
    ]
    for window in overlap_windows(spans):
        fields = {f for f in dir(window) if not f.startswith("_")}
        assert "user_id" not in fields
        assert "user_ids" not in fields
        assert "speaker" not in fields


def test_a_tiny_ratio_rise_is_not_reported():
    """⚠️ 바탕이 0.5% 인데 2% 인 구간은 네 배지만 아무 일도 안 일어났습니다.

    절대량 바닥이 없으면 조용한 회의가 온통 '급증' 으로 뒤덮입니다.
    """
    spans = _steady(20, gap_ms=100)  # 바탕이 아주 낮다
    # 한 구간에만 3초 겹침 — 배수는 크지만 10초 바닥에 못 미친다.
    spans += [Span(1, 8 * 60_000, 8 * 60_000 + 3_000), Span(2, 8 * 60_000, 8 * 60_000 + 3_000)]
    hit = [w for w in overlap_windows(spans) if w.start_ms <= 8 * 60_000 < w.end_ms]
    assert hit == [], f"3초짜리를 급증으로 셌습니다: {hit}"
    assert MIN_WINDOW_OVERLAP_MS == 10_000


def test_a_meeting_that_overlaps_throughout_says_nothing():
    """⚠️ 회의 내내 겹쳤으면 '구간' 의 문제가 아닙니다.

    그건 회의 방식의 문제이고, 여기서 할 말이 아닙니다. 바탕이 이미
    높으면 '늘었다' 가 뜻을 잃습니다.
    """
    spans: list[Span] = []
    for i in range(20):
        at = i * 60_000
        spans.append(Span(1, at, at + 60_000))
        spans.append(Span(2, at, at + 60_000))
    assert overlap_windows(spans) == []


def test_windows_are_in_time_order_and_do_not_overlap():
    """구간이 뒤죽박죽이거나 겹치면 화면이 타임라인에 못 얹습니다."""
    spans = _steady(30, gap_ms=200)
    for i in (6, 12, 20):
        spans += [
            Span(1, i * 60_000, i * 60_000 + 40_000),
            Span(2, i * 60_000, i * 60_000 + 40_000),
        ]
    windows = overlap_windows(spans)
    assert len(windows) >= 2
    for a, b in pairwise(windows):
        assert a.end_ms <= b.start_ms
        assert a.start_ms < a.end_ms
    assert all(w.end_ms - w.start_ms <= WINDOW_MS for w in windows)


def test_the_baseline_comes_back_with_the_window():
    """⚠️ 배수만 주면 바탕이 얼마였는지 알 수 없습니다.

    "3배" 는 0.5%→1.5% 일 수도 10%→30% 일 수도 있고, 사람이 판단하려면
    둘을 다 알아야 합니다.
    """
    spans = [
        *_steady(20, gap_ms=200),
        Span(1, 12 * 60_000, 12 * 60_000 + 30_000),
        Span(2, 12 * 60_000, 12 * 60_000 + 30_000),
    ]
    for window in overlap_windows(spans):
        assert 0 < window.baseline < 0.5
        assert window.ratio > window.baseline
