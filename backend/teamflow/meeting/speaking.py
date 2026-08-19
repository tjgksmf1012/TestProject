"""누가 얼마나 말했는가 (요구사항 정의서 §9 `AI-AUDIO-005` · §12 `AI-REVIEW-007`).

## ⚠️ 이 파일은 이 저장소에서 제일 위험한 값을 다룹니다

정의서 `AI-AUDIO-005` 의 예시가 이렇게 생겼습니다.

    윤식 32% / 민수 27% / 지연 25% / 철수 16%

**내림차순으로 늘어놓은 그 모양이 곧 리더보드입니다.** 그런데 같은 문서가
두 곳에서 반대로 말합니다 — `AI-REVIEW-007` 은 "발언 비중은 기여도를
판단하는 기준으로 **직접 사용하지 않는다**", `NFR-005` 는 단정적 평가를
금지하며 올바른 예로 "이번 회의에서 철수의 발언 비중은 전체 발언의
8%였다" 를 듭니다.

읽으면 뜻은 분명합니다. 요구는 **값을 만들라**는 것이지 **줄을 세우라**는
것이 아닙니다. 예시의 생김새만 리더보드였습니다 (`docs/20` §3).

그래서 여기서는 이렇게 합니다.

* **정렬하지 않습니다.** 받은 순서 그대로 돌려줍니다 — 정렬해서 주면
  부르는 쪽은 그게 뜻있는 순서라고 믿습니다
* **아무도 말하지 않은 회의는 `None`** 입니다. 0.0 이 아닙니다 — 분모가
  0이면 비중이라는 것이 존재하지 않고, 그때 0.0 을 돌려주면 "다들 0%
  말했다" 는 **잰 값**처럼 보입니다 (결함 121 이 정확히 그것이었습니다)
* **기여도 점수에 안 들어갑니다.** `docs/05` §5 가 "총 발언 시간 = 점수
  아님(참고 표시만)" 으로 이미 정해 뒀습니다

## ⚠️ 겹치는 구간을 두 번 세지 않습니다

한 사람의 발화 구간이 서로 겹칠 수 있습니다 — 트랙이 겹쳐 들어오거나
같은 말이 두 조각으로 잘리는 경우입니다. 그냥 더하면 **말 많이 한 것처럼
보입니다.** 사람마다 구간을 합쳐서 셉니다.

⚠️ 반대로 **사람끼리 겹치는 것은 그대로 둡니다.** 둘이 동시에 말했으면
둘 다 말한 것이 맞습니다. 그래서 몫의 합이 1을 넘을 수 있고, 그건
틀린 게 아닙니다 — 화면이 그 사실을 말해야 합니다.
"""

from __future__ import annotations

from dataclasses import dataclass

#: 이보다 한쪽으로 쏠리면 "한 사람이 많이 말했다" 고 볼 만한 선.
#:
#: ⚠️ **경고가 아닙니다.** 회의에는 발제하는 사람이 있고, 그 사람이 많이
#: 말하는 것은 정상입니다. 이 값은 "눈에 띈다" 는 뜻이지 "잘못됐다" 가
#: 아닙니다.
SKEW_SHARE = 0.6

#: 이보다 짧은 회의는 비중을 말하지 않습니다.
#:
#: ⚠️ 3분짜리 회의에서 한 사람이 70% 말한 것은 아무 뜻이 없습니다 —
#: 한 사람이 상황을 설명하고 끝난 것일 수 있습니다. 짧은 표본에서 나온
#: 비율을 보여 주면 사람은 그걸 경향으로 읽습니다.
MIN_TOTAL_MS = 5 * 60 * 1000


@dataclass(frozen=True, slots=True)
class Span:
    """한 사람의 발화 한 조각."""

    user_id: int
    start_ms: int
    end_ms: int


@dataclass(frozen=True, slots=True)
class Share:
    """이 사람이 말한 시간과 몫.

    ⚠️ `ratio` 가 `None` 이면 **못 잰 것**입니다. 0.0 과 다릅니다.
    """

    user_id: int
    speaking_ms: int
    ratio: float | None


def merged_ms(spans: list[Span]) -> int:
    """겹치는 구간을 합쳐서 잰 시간.

    ⚠️ 그냥 더하면 겹친 만큼 **말을 많이 한 것처럼** 보입니다.
    """
    if not spans:
        return 0
    ordered = sorted(
        ((min(s.start_ms, s.end_ms), max(s.start_ms, s.end_ms)) for s in spans),
    )
    total = 0
    cur_start, cur_end = ordered[0]
    for start, end in ordered[1:]:
        if start <= cur_end:
            cur_end = max(cur_end, end)
        else:
            total += cur_end - cur_start
            cur_start, cur_end = start, end
    return total + (cur_end - cur_start)


def shares(spans: list[Span], user_ids: list[int]) -> list[Share]:
    """사람별 발언 시간과 몫.

    `user_ids` 는 **부르는 쪽이 정한 순서**입니다. 여기서 다시 정렬하지
    않습니다 — 정렬하는 순간 그게 순위가 됩니다.

    ⚠️ **한마디도 안 한 사람을 빼지 않습니다.** 빼면 목록에 있는 사람이
    곧 "말한 사람" 이 되고, 없는 사람은 조용히 지워집니다. 0ms 로
    남기되 몫은 아래 규칙을 따릅니다.

    ⚠️ **아무도 말하지 않았으면 전원 `None`** 입니다 — 분모가 0이면
    비중이 존재하지 않습니다.
    """
    by_user: dict[int, list[Span]] = {uid: [] for uid in user_ids}
    for span in spans:
        if span.user_id in by_user:
            by_user[span.user_id].append(span)

    counted = {uid: merged_ms(items) for uid, items in by_user.items()}
    total = sum(counted.values())

    return [
        Share(
            user_id=uid,
            speaking_ms=counted[uid],
            ratio=(counted[uid] / total) if total > 0 else None,
        )
        for uid in user_ids
    ]


def measurable(shares_: list[Share]) -> bool:
    """비중을 말할 만한 회의인가.

    ⚠️ 짧은 표본에서 나온 비율을 보여 주면 사람은 그걸 **경향**으로
    읽습니다. 3분짜리 회의에서 한 사람이 70% 말한 것은 아무 뜻이 없습니다.
    """
    total = sum(s.speaking_ms for s in shares_)
    return total >= MIN_TOTAL_MS


def skewed(shares_: list[Share]) -> bool:
    """한쪽으로 쏠렸는가 (`AI-REVIEW-007`).

    ⚠️ **누가 쏠렸는지는 안 돌려줍니다.** 참/거짓 하나입니다.

    이름을 같이 돌려주면 부르는 쪽은 그걸 화면에 적고, 그 순간
    **"이 회의를 독점한 사람" 표시**가 됩니다. 회의에는 발제하는 사람이
    있고 그 사람이 많이 말하는 것은 정상입니다 — 사실은 목록에 이미
    다 있으니 사람이 보고 판단하면 됩니다.

    ⚠️ 잴 수 없는 회의는 **거짓**입니다. 모르는 것을 "쏠리지 않았다" 로
    말하는 것이 아니라, **말할 것이 없다**는 뜻입니다. 부르는 쪽은
    `measurable()` 을 먼저 봐야 합니다.
    """
    if not measurable(shares_):
        return False
    values = [s.ratio for s in shares_ if s.ratio is not None]
    if len(values) < 2:
        return False
    return max(values) >= SKEW_SHARE


# ══════════════════════════════════════════════════════════════
# 동시 발언이 늘어난 구간 (`AI-REVIEW-008`)
# ══════════════════════════════════════════════════════════════
#
# 겹침 자체는 진작 탐지하고 있었습니다(`multitrack.is_overlap`). 없던 것은
# **"늘었다" 는 판정**입니다 — 회의 내내 조금씩 겹치는 것은 정상적인
# 대화이고, 특정 구간에서 갑자기 늘어난 것이 볼 만한 신호입니다.
#
# ⚠️ **회의에 대해 말하고 사람을 지목하지 않습니다.** `skewed` 가 이름을
# 안 돌려주는 것과 같은 원칙입니다. "누가 말을 끊었나" 를 돌려주면 부르는
# 쪽이 그걸 화면에 적고, 그 순간 **말 끊은 사람 표시**가 됩니다.
# 겹침은 두 사람 사이의 일이지 한 사람의 잘못이 아닙니다.
#
# ⚠️ **비율만 보면 안 됩니다.** 바탕이 0.5% 인 회의에서 2% 인 구간은
# 네 배지만 아무 일도 안 일어난 것입니다. 절대량 바닥(`MIN_WINDOW_OVERLAP_MS`)
# 을 같이 봅니다.

#: 구간을 자르는 길이. 2분.
#:
#: ⚠️ 짧게 자르면 발화 하나가 구간 하나를 통째로 채워 "급증" 이 됩니다.
#: 길게 자르면 실제 급증이 평균에 묻힙니다.
WINDOW_MS = 2 * 60 * 1000

#: 바탕 대비 이만큼 이상이어야 "늘었다" 고 봅니다.
#:
#: ⚠️ **경고가 아닙니다.** 격론이 벌어진 구간은 회의에서 제일 중요한
#: 자리일 수 있습니다. 이 값은 "여기를 다시 들어 볼 만하다" 는 뜻입니다.
OVERLAP_RISE = 2.0

#: 구간 안 겹침이 이보다 적으면 비율이 아무리 높아도 안 셉니다. 10초.
MIN_WINDOW_OVERLAP_MS = 10 * 1000

#: 이보다 짧은 회의는 구간을 나누지 않습니다.
MIN_MEETING_MS = 6 * 60 * 1000


@dataclass(frozen=True, slots=True)
class OverlapWindow:
    """동시 발언이 바탕보다 늘어난 구간.

    ⚠️ **누가 겹쳤는지는 없습니다.** 일부러 뺐습니다 (위 머리말).
    """

    start_ms: int
    end_ms: int
    overlap_ms: int
    #: 이 구간에서 겹친 시간의 비율.
    ratio: float
    #: 회의 전체의 겹침 비율. 사람이 "얼마나 늘었나" 를 스스로 볼 수 있게
    #: 같이 줍니다 — 배수만 주면 바탕이 얼마였는지 알 수 없습니다.
    baseline: float


def overlap_ms(spans: list[Span]) -> int:
    """**서로 다른 사람**의 발화가 겹친 시간.

    ⚠️ 같은 사람의 조각끼리 겹친 것은 안 셉니다 — 한 사람이 자기 말을
    끊을 수는 없고, 그건 대개 분절이 잘게 난 것뿐입니다.

    스윕 라인으로 셉니다: 시각을 따라가며 **말하고 있는 사람 수**가 둘
    이상인 동안을 더합니다.
    """
    edges: list[tuple[int, int, int]] = []
    for s in spans:
        start, end = min(s.start_ms, s.end_ms), max(s.start_ms, s.end_ms)
        if start == end:
            continue
        edges.append((start, +1, s.user_id))
        edges.append((end, -1, s.user_id))
    if not edges:
        return 0

    edges.sort(key=lambda e: (e[0], -e[1]))
    live: dict[int, int] = {}
    total = 0
    at = edges[0][0]
    for time, delta, user_id in edges:
        if len(live) >= 2 and time > at:
            total += time - at
        at = time
        live[user_id] = live.get(user_id, 0) + delta
        if live[user_id] <= 0:
            live.pop(user_id, None)
    return total


def overlap_windows(spans: list[Span]) -> list[OverlapWindow]:
    """동시 발언이 **바탕보다 늘어난** 구간들 (`AI-REVIEW-008`).

    잴 수 없으면 빈 목록입니다 — 모르는 것을 "안 늘었다" 로 말하지
    않습니다. 부르는 쪽은 빈 목록을 "확인할 구간 없음" 으로 읽으면 됩니다.
    """
    if not spans:
        return []
    begin = min(min(s.start_ms, s.end_ms) for s in spans)
    finish = max(max(s.start_ms, s.end_ms) for s in spans)
    span_ms = finish - begin
    if span_ms < MIN_MEETING_MS:
        return []

    baseline_ms = overlap_ms(spans)
    baseline = baseline_ms / span_ms
    # 바탕이 이미 높으면 "늘었다" 가 뜻을 잃습니다 — 회의 내내 겹쳤다는
    # 것은 구간의 문제가 아니라 회의 방식의 문제이고, 여기서 할 말이
    # 아닙니다.
    if baseline <= 0 or baseline >= 0.5:
        return []

    out: list[OverlapWindow] = []
    at = begin
    while at < finish:
        end = min(at + WINDOW_MS, finish)
        width = end - at
        if width <= 0:
            break
        clipped = [
            Span(
                user_id=s.user_id,
                start_ms=max(min(s.start_ms, s.end_ms), at),
                end_ms=min(max(s.start_ms, s.end_ms), end),
            )
            for s in spans
            if min(s.start_ms, s.end_ms) < end and max(s.start_ms, s.end_ms) > at
        ]
        got = overlap_ms(clipped)
        ratio = got / width
        if got >= MIN_WINDOW_OVERLAP_MS and ratio >= baseline * OVERLAP_RISE:
            out.append(
                OverlapWindow(
                    start_ms=at,
                    end_ms=end,
                    overlap_ms=got,
                    ratio=ratio,
                    baseline=baseline,
                )
            )
        at = end
    return out
