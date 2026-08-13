/**
 * 화면이 재우기 방지를 **언제 잡고 놓는가** (`docs/21` Phase 2).
 *
 * 데스크톱 셸에서만 뜻이 있습니다 — 브라우저에는 잡을 것이 없습니다.
 *
 * ## ⚠️ 항상 켜 두지 않습니다
 *
 * 앱이 떠 있는 내내 절전을 막으면 **아무도 안 재는데 켜져 있는 것**이
 * 됩니다(`electron/main` 머리말이 경고하는 그것) — 노트북 배터리를
 * 이유 없이 태우고, "이 앱은 켜 두면 배터리가 준다" 는 인상만 남깁니다.
 * 잡는 것은 **녹음이 사는 동안**뿐입니다.
 *
 * ## ⚠️ 판단은 여기, 손은 main 에
 *
 * 어느 국면에서 잡는지(`shouldHoldAwake`)는 여기 있고 테스트가 붙습니다.
 * 실제로 켜졌는지는 main 이 `powerSaveBlocker.isStarted` 로 재서
 * 돌려줍니다 — 화면이 "켰다" 고 믿는 것과 OS 가 켰다는 것은 다릅니다.
 */

/** 데스크톱 셸이 preload 로 내놓는 다리. `electron/preload` 와 짝. */
export interface AwakeBridge {
  /** 잡는다. **실제로 켜져 있으면** 참이 돌아옵니다 (main 이 잽니다). */
  hold(): Promise<boolean>;
  /** 놓는다. **아직 켜져 있으면** 참이 돌아옵니다. */
  release(): Promise<boolean>;
}

/**
 * 다리가 **두 칸 다** 있는지 본다. 없으면 `null`.
 *
 * `chunk-store.chunkBridge` 와 같은 원칙입니다 — 셸 판이 낮아 한 칸이
 * 없으면, 잡기만 하고 못 놓거나 그 반대가 됩니다.
 */
export function awakeBridge(bridge: unknown): AwakeBridge | null {
  if (typeof bridge !== 'object' || bridge === null) return null;
  const b = bridge as Record<string, unknown>;
  if (typeof b.hold !== 'function' || typeof b.release !== 'function') return null;
  return b as unknown as AwakeBridge;
}

/**
 * 이 국면에서 재우기를 막아야 하는가.
 *
 * ⚠️ **`interrupted` 도 잡습니다.** 화면이 가려져 잠깐 끊긴 상태인데,
 * 그때 절전 방지를 놓으면 기계가 잠들어 **되살아날 기회 자체가
 * 사라집니다.** `stopping` 도 잡습니다 — 남은 청크를 올리는 중입니다.
 */
export function shouldHoldAwake(phase: string): boolean {
  return phase === 'recording' || phase === 'interrupted' || phase === 'stopping';
}
