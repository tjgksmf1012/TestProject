"""회의 개선 추세 (`REVIEW-006`) — 팀 단위 관찰, 판정 없음.

## ⚠️ 회의끼리 비교하지 않습니다

정의서의 요구는 「이전 회의 대비 개선 추세」 인데, 회의별 값을 늘어놓는
순간 **회의 순위표**가 됩니다 — "3주차 회의가 문제였네" 는 그 회의를
연 사람에 대한 판정으로 읽힙니다. 그래서 여기서 내는 것은 방향
하나입니다: **"이 팀에서 이런 구간이 줄고 있다 / 늘고 있다 / 비슷하다."**

- 회의별 값·회의 제목·회의 id 를 **싣지 않습니다.** 앞쪽 절반 평균과
  최근 절반 평균, 그 둘뿐입니다 — 어느 회의였는지 짚을 재료를 안 줍니다
- severity 없음 · 사람 없음 (탐지기와 같은 규칙)
- 값은 글자로 나갑니다 — 막대·점 찍기 없음 (`AGENTS.md` 불변식 1)

## ⚠️ 회의 셋 미만이면 말하지 않습니다

두 점 사이에는 언제나 선이 그어지지만 그것은 방향이 아니라 우연입니다.
짧은 회의에서 발언 비중을 말하지 않는 것과 같은 규칙입니다 —
못 재는 것은 **못 잰다고** 말합니다 (측정 불가 ≠ 0).

## 절반은 같은 크기로 자릅니다

회의가 홀수면 **가운데 하나를 버립니다.** 앞 2개 평균과 뒤 3개 평균을
비교하면 한쪽 표본이 크고, 그 차이가 방향처럼 보일 수 있습니다.
"""

from __future__ import annotations

from dataclasses import dataclass

from teamflow.db import vocab

#: 이보다 적으면 추세를 말하지 않는다.
MIN_MEETINGS = 3

#: 회의당 평균 건수 차가 이 미만이면 "비슷하다" — 탐지기는 규칙 기반이라
#: 반 건 수준의 흔들림은 방향이 아니라 잡음이다.
FLAT_BAND = 0.5


@dataclass(frozen=True, slots=True)
class KindTrend:
    """한 종류의 방향. 회의별 값은 여기 **없습니다** — 위 머리말 참고."""

    kind: str
    #: 앞쪽 절반의 회의당 평균 건수
    early_avg: float
    #: 최근 절반의 회의당 평균 건수
    late_avg: float
    #: 'falling' | 'rising' | 'flat'
    direction: str


def direction_of(early_avg: float, late_avg: float) -> str:
    delta = late_avg - early_avg
    if abs(delta) < FLAT_BAND:
        return "flat"
    return "rising" if delta > 0 else "falling"


def halves(series: list[int]) -> tuple[list[int], list[int]]:
    """앞쪽 절반과 최근 절반 — **같은 크기**, 홀수면 가운데를 버린다."""
    half = len(series) // 2
    return series[:half], series[len(series) - half :]


def kind_trends(series_by_kind: dict[str, list[int]]) -> list[KindTrend]:
    """종류별 방향. ⚠️ **어휘 선언 순입니다** — 건수 순으로 늘어놓으면
    "제일 많이 걸린 종류" 표가 됩니다 (GitHub 집계와 같은 규칙).
    """
    out: list[KindTrend] = []
    for kind in vocab.MeetingEventType:
        series = series_by_kind.get(str(kind), [])
        early, late = halves(series)
        if not early or not late:
            continue
        early_avg = sum(early) / len(early)
        late_avg = sum(late) / len(late)
        out.append(
            KindTrend(
                kind=str(kind),
                early_avg=round(early_avg, 2),
                late_avg=round(late_avg, 2),
                direction=direction_of(early_avg, late_avg),
            )
        )
    return out


def measurable(meeting_count: int) -> bool:
    """⚠️ 문장은 여기 없습니다 — 위험 신호와 같은 규칙입니다. 서버는
    숫자(`meetings_counted`·`needed`)만 내고 말은 화면이 만듭니다.
    """
    return meeting_count >= MIN_MEETINGS
