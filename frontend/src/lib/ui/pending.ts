/**
 * 로딩 표시를 **늦게** 켠다.
 *
 * ## 왜 늦추는가
 *
 * 대부분의 요청은 순식간에 끝납니다. 그때 로딩 표시를 켜면 사람 눈에는
 * **깜빡임**만 남습니다. 화면이 한 번 떨리고 마는데, 그건 아무것도
 * 안 보여주는 것보다 나쁩니다 — 뭔가 잘못된 것처럼 보입니다.
 *
 * 그래서 200ms 를 기다립니다. 그 안에 끝나면 로딩 표시는 **한 번도
 * 만들어지지 않습니다** (지시서 §4.7 · §7).
 *
 *     0ms ─────────── 200ms ─────────────────────▶
 *     │                 │
 *     └ 요청 시작        └ 여기서도 안 끝났으면 그때 스켈레톤
 *
 * ## ⚠️ 여기가 거짓말이 생길 수 있는 지점이다
 *
 * **끝났는데 안 지우면 화면이 영원히 로딩 중입니다.** 이 저장소가
 * 반복해 당한 부류입니다 — 오류는 안 나고, 사람은 기다립니다.
 *
 * 실패했을 때가 특히 위험합니다. 오류 문구를 **다른 요소**에 쓰는
 * 화면이 여럿이라(`#result`·`#warnings`), 스켈레톤이 있던 자리는
 * 아무도 안 건드립니다. 그래서 `whileLoading` 이 성공·실패를 가리지
 * 않고 지웁니다. 호출하는 쪽이 잊을 수 없게 만드는 것이 요점입니다.
 *
 * ## 최소 노출 시간은 두지 않았습니다
 *
 * 205ms 에 끝나면 스켈레톤이 5ms 만 보이고 사라집니다 — 여전히
 * 깜빡임입니다. 흔한 해법은 "한 번 보였으면 최소 N ms 는 유지" 인데,
 * 지시서에 그 N 이 없습니다. **근거 없는 상수를 만들지 않기로** 했으므로
 * (`track/bar.ts` 에서 한 번 만들 뻔했습니다) 지연만 넣었습니다.
 * 실제로 깜빡이는 것이 관찰되면 그때 값을 정합니다.
 */

/** 로딩 표시를 켜기까지 기다리는 시간. 지시서 §4.7 · §7. */
export const LOADING_DELAY_MS = 200;

/**
 * 타이머. 테스트에서 가짜로 갈아 끼웁니다 — 실제로 200ms 를 기다리면
 * 테스트가 느려지고, 느린 테스트는 결국 안 돌립니다.
 */
export interface Timers {
  set(fn: () => void, ms: number): number;
  clear(id: number): void;
}

const browserTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clear: (id) => {
    clearTimeout(id);
  },
};

/**
 * `work` 가 오래 걸릴 때만 `show()` 를 부르고, 끝나면 반드시 `hide()`.
 *
 * - 200ms 안에 끝나면 `show()` 도 `hide()` 도 **안 부릅니다**.
 *   안 켠 것을 끄면, 끄는 쪽이 원래 있던 내용을 지울 수 있습니다.
 * - 실패해도 `hide()` 를 부른 뒤 **그대로 던집니다.** 오류 처리는
 *   화면의 몫이고, 여기서 삼키면 오류가 조용히 사라집니다.
 */
export async function whileLoading<T>(
  work: Promise<T>,
  show: () => void,
  hide: () => void,
  timers: Timers = browserTimers,
  delayMs: number = LOADING_DELAY_MS,
): Promise<T> {
  let shown = false;
  const timer = timers.set(() => {
    shown = true;
    show();
  }, delayMs);

  try {
    return await work;
  } finally {
    timers.clear(timer);
    if (shown) hide();
  }
}
