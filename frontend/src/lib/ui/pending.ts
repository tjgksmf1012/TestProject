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
 * (지금은 지운 `track/bar.ts` 에서 한 번 만들 뻔했습니다) 지연만 넣었습니다.
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

/** 누르는 동안 잠글 수 있는 것. 실제로는 `HTMLButtonElement` 입니다. */
export interface Pressable {
  disabled: boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/**
 * **누르는 동안 그 버튼을 잠근다.** 답이 오면 원래대로 돌린다.
 *
 * ## 왜 필요한가 (결함 89)
 *
 * 느린 망에서 &#34;만들기&#34; 를 눌렀는데 2초 동안 아무 일이 없으면 사람은
 * 한 번 더 누릅니다. 브라우저에서 세 번 눌러 보니 **프로젝트가 셋**
 * 생겼습니다 — 화면은 그중 하나로 들어가고, 나머지 둘은 같은 이름으로
 * 목록에 남습니다. 각자 **다른 초대 코드**를 가진 채로요.
 *
 * 그게 이 제품에서 특히 나쁜 이유: 초대 코드는 팀원이 들어오는 유일한
 * 통로입니다. 사람이 A 의 코드를 나눠 주고 나중에 B 를 열면, 팀이
 * 갈라지고 **기여도도 갈라집니다.**
 *
 * ## 이 함수가 못 하는 것
 *
 * ⚠️ **서버 쪽 멱등성이 아닙니다.** 탭 두 개에서 각각 누르거나, 이미
 * 나간 요청이 재전송되는 것은 못 막습니다. 진짜 해법은 요청에 키를
 * 붙여 서버가 같은 것을 두 번 만들지 않는 것인데, 그건 API 를 바꾸는
 * 일이라 이 범위에서 안 했습니다 — `docs/17` §C 에 그렇게 적어 뒀습니다.
 * 여기서 없애는 것은 **실제로 관찰된 실패**(사람이 같은 버튼을 두 번
 * 누르는 것) 하나입니다.
 *
 * ⚠️ **원래 상태로 되돌립니다.** `false` 로 풀어 버리면, 원래 잠겨
 * 있어야 할 버튼(승인 화면의 제출은 결정한 항목이 없으면 잠깁니다)이
 * 요청 한 번 뒤에 열립니다.
 */
export async function whilePressed<T>(
  button: Pressable,
  run: () => Promise<T>,
): Promise<T> {
  const was = button.disabled;
  button.disabled = true;
  // 눌린 채 기다리는 중임을 보조기술에도 알립니다.
  button.setAttribute('aria-busy', 'true');
  try {
    return await run();
  } finally {
    button.disabled = was;
    button.removeAttribute('aria-busy');
  }
}
