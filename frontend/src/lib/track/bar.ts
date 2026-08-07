/**
 * 트랙 막대 — 이 제품의 시그니처가 화면에 나타나는 형태.
 *
 * ## 무엇을 그리는가
 *
 * 이 제품의 고유 형태는 **시간축 위의 평행 트랙**입니다. 사람마다 한 줄,
 * 말한 구간은 차 있고 안 말한 구간은 비어 있고, 녹음이 끊긴 구간은
 * 구멍으로 남습니다. 근거는 Marey 의 1885년 열차 운행도표 — 시간축 위의
 * 평행선, 그리고 **빈 곳이 정보**라는 발상입니다 (docs/16).
 *
 * ## ⚠️ 두 종류가 있고, 섞으면 거짓말이 된다
 *
 *     구간 막대(range)     구간의 **위치**가 뜻을 가진다 (19%~29%)
 *     비율 막대(coverage)  **양**만 뜻을 가진다. 위치는 아무 뜻이 없다
 *
 * 비율 막대를 시간축처럼 보이게 그리면, 사람은 "12분쯤에 녹음이
 * 끊겼구나" 라고 읽습니다. **우리는 그걸 모릅니다.** 서버가 주는 것은
 * `coverage` 와 `total_gap_ms` — 총량뿐입니다.
 *
 * 모르는 것을 아는 것처럼 그리는 것은 이 프로젝트가 가장 피해야 하는
 * 일입니다. 기여도를 다루는 화면에서 위치를 지어내면, 그 화면의 모든
 * 숫자가 같이 의심받습니다.
 *
 * 그래서 두 함수를 나누고, 비율 막대에는 **눈금을 그리지 않습니다** —
 * 눈금이 있으면 시간축으로 읽힙니다.
 */

/** 막대 한 칸. `left`·`width` 는 백분율(0~100). */
export interface Segment {
  kind: 'talk' | 'gap' | 'fill';
  left: number;
  width: number;
}

const clamp = (value: number, lo = 0, hi = 100): number =>
  Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : lo;

/*
 * ⚠️ **구간 막대(`rangeBar`)는 여기 없습니다.**
 *
 * 처음에 여기에 만들었다가, `src/lib/contribution/view.ts` 에 **이미
 * 있고 테스트까지 붙어 있는** 것을 발견했습니다. 지시서 §0-6 이
 * 금지하는 바로 그것입니다 — 새 것을 만들기 전에 기존 것을 찾을 것.
 *
 * 둘의 동작이 같았으므로 제 것을 지웠습니다. 구간 막대가 필요하면
 * `contribution/view.ts` 의 `rangeBar(member)` 를 쓰세요.
 *
 * 이 파일에는 **없던 것만** 남깁니다 — 커버리지 비율 막대.
 */

/**
 * 녹음 커버리지 비율 막대. **양만 뜻을 가집니다.**
 *
 * `coverage` 는 0~1, `totalGapMs` 는 밀리초입니다. 둘 다 총량이라
 * 위치를 알 수 없습니다 — 그래서 채운 칸을 왼쪽에, 구멍을 오른쪽에
 * 붙여 **누적 막대**로 그립니다. 시간축이 아니라는 것이 모양에서
 * 드러나야 합니다.
 *
 * `coverage` 가 null 이면 아직 모르는 것입니다. 0 으로 넘기면
 * "하나도 녹음 안 됨" 이 되는데, **모르는 것과 0 은 다릅니다.**
 */
export function coverageBar(coverage: number | null | undefined): Segment[] {
  if (coverage === null || coverage === undefined || !Number.isFinite(coverage)) {
    return [];
  }
  const filled = clamp(coverage * 100);
  const missing = 100 - filled;
  const bars: Segment[] = [];
  if (filled > 0) bars.push({ kind: 'talk', left: 0, width: filled });
  if (missing > 0.5) bars.push({ kind: 'gap', left: filled, width: missing });
  return bars;
}

/**
 * 커버리지를 사람의 말로.
 *
 * ⚠️ **"0%" 와 "모름" 을 구분합니다.** 모르는 것을 0 으로 보여주면
 * 그 사람이 아무것도 안 한 것으로 읽힙니다 — 이 프로젝트에서 그건
 * 버그가 아니라 오답입니다 (docs/05 §5, 측정 불가 ≠ 0점).
 */
export function describeCoverage(coverage: number | null | undefined): string {
  if (coverage === null || coverage === undefined || !Number.isFinite(coverage)) {
    return '아직 모릅니다';
  }
  return `녹음 ${Math.round(clamp(coverage * 100))}%`;
}

/*
 * ⚠️ **"셀 수 있는가" 는 여기서 정하지 않습니다.**
 *
 * 처음에 이 파일에 `MIN_USABLE_COVERAGE = 0.6` 을 두고 "서버의
 * `confidence.py` 와 같은 값" 이라고 적었습니다. **틀렸습니다** —
 * `confidence.py` 의 0.60 은 커버리지가 아니라 **신뢰도 라벨** 경계
 * ("보통")입니다.
 *
 * 그래서 "서버는 커버리지를 기준선으로 안 쓴다" 고 결론지었는데,
 * **그것도 틀렸습니다.** `recording_service.py` 를 안 봤습니다.
 *
 *     recording_service.py         MIN_USABLE_COVERAGE = 0.8
 *     recording/timeline.ts        0.8
 *     lobby/room.ts                0.8
 *
 * **세 곳이 전부 일치합니다.** 사슬은 이렇습니다 —
 * `coverage >= 0.8` → `status = "completed"` → `tracks_usable` 에 셈.
 *
 * 즉 제가 **근거 없는 네 번째 값**을 만들 뻔했습니다. 이 파일은
 * **그리기만** 하고, 판정은 이미 그 일을 하는 `lobby/room.ts` 에
 * 맡깁니다.
 */
