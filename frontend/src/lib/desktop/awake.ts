/**
 * 재우기 방지의 **장부** (`docs/21` Phase 2) — 판단만.
 *
 * main 프로세스는 `powerSaveBlocker` 를 켜고 끄는 손이고, **언제 켜고
 * 끌지**는 여기서 정합니다. main 에는 자동 검사가 안 붙기 때문입니다
 * (`chunk-paths.ts` 와 같은 이유).
 *
 * ## 왜 장부가 필요한가
 *
 * 부르는 쪽은 **원격 코드**(서버가 준 화면)입니다. hold 를 두 번 부르고
 * release 를 한 번만 부를 수도, 그 반대일 수도 있습니다. 켜고 끄기를
 * 호출 횟수에 그대로 묶으면:
 *
 *   - hold·hold·release → 꺼짐: **녹음이 도는데 절전 방지가 풀립니다.**
 *     이 제품에서 제일 비싼 실패입니다
 *   - release 만 → 음수 계수: 다음 hold 가 안 켜집니다
 *
 * 그래서 참조 계수로 들되 **0 밑으로 안 내려가게** 합니다.
 *
 * ## ⚠️ 이 장부는 "켜야 하는가" 만 답합니다
 *
 * 실제로 켜졌는지(`powerSaveBlocker.isStarted`)는 main 이 재서
 * 돌려줍니다 — 장부가 "켰다" 고 믿는 것과 OS 가 켰다는 것은 다릅니다.
 */

export class AwakeLedger {
  #holds = 0;

  /** 잡는다. **이 호출로 켜야 하면** 참. */
  hold(): boolean {
    this.#holds += 1;
    return this.#holds === 1;
  }

  /**
   * 놓는다. **이 호출로 꺼야 하면** 참.
   *
   * ⚠️ 잡은 적이 없으면 아무 일도 아닙니다 — 음수로 내려가면 다음
   * hold 가 "첫 번째" 가 아니게 되어 안 켜집니다.
   */
  release(): boolean {
    if (this.#holds === 0) return false;
    this.#holds -= 1;
    return this.#holds === 0;
  }

  get held(): boolean {
    return this.#holds > 0;
  }
}
