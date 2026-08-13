/**
 * 지금 이 환경에서 **화면을 꺼도 녹음이 이어지는가.**
 *
 * ⭐ 사람에게 **미리** 말해 줘야 합니다. 회의가 끝난 뒤에 "그 창은 켜
 * 뒀어야 했다" 를 알게 되면 그 회의는 다시 못 합니다. 이 제품에서 제일
 * 비싼 실패입니다.
 *
 * ## ⚠️ 셸 이름이 아니라 **능력**으로 판단합니다
 *
 * 예전에는 `isInShell()`(안드로이드 WebView 인가)로 갈랐습니다. 그러면
 * **셸이 있다는 것과 그 셸이 실제로 재우기를 막는다는 것**이 한 덩어리가
 * 됩니다. 둘은 다릅니다 — 지금 데스크톱 셸이 정확히 그 경우입니다.
 * 창은 있는데 `powerSaveBlocker` 는 아직 없습니다(`docs/21` Phase 2).
 *
 * 그래서 셸이 **자기가 재우기를 막는지**를 스스로 말하게 하고
 * (`window.teamflowDesktop.keepsAwake`), 여기서는 그 값만 봅니다.
 * Phase 2 가 붙는 날 preload 한 곳만 바꾸면 문구가 저절로 맞습니다 —
 * 두 곳을 같이 고쳐야 하면 한 곳은 반드시 잊습니다.
 */

/** 데스크톱 셸이 preload 로 내놓는 것. `electron/preload/index.ts` 와 짝. */
export interface DesktopBridge {
  shell: number;
  platform: string;
  electron: string;
  /**
   * 이 셸이 **재우기를 막고 있는가.**
   *
   * ⚠️ 창이 있다는 뜻이 아닙니다. `powerSaveBlocker` 가 실제로 켜져
   * 있어야 참입니다. Phase 0 에서는 언제나 거짓입니다.
   */
  keepsAwake: boolean;
  /**
   * 청크를 디스크에 붙잡아 두는 다리 (`docs/21` Phase 1).
   *
   * ⚠️ **선택입니다.** 셸 판이 낮으면 없을 수 있어, `desktopBridge()` 의
   * 필수 칸에 넣지 않았습니다. 있는지는 `openChunkStore` 가 따로 봅니다 —
   * `keepsAwake` 와 같은 원칙입니다. **셸이 있다는 것과 그 셸이 무엇을
   * 할 수 있는가는 다릅니다.**
   */
  chunks?: unknown;
}

declare global {
  interface Window {
    /** 데스크톱 셸 안에서만 있습니다. 브라우저에서는 `undefined`. */
    teamflowDesktop?: Partial<DesktopBridge>;
  }
}

/**
 * 데스크톱 셸 안인가.
 *
 * ⭐ 객체가 있는지만 보지 않고 **필요한 칸이 다 있는지** 봅니다. 셸 판이
 * 낮아 칸 하나가 없으면 있는 줄 알고 읽다가 `undefined` 를 참으로
 * 다루게 되고, 그 자리가 하필 "재우기를 막는가" 입니다.
 */
export function desktopBridge(win: Window): DesktopBridge | null {
  const bridge = win.teamflowDesktop;
  if (!bridge) return null;
  if (typeof bridge.shell !== 'number') return null;
  if (typeof bridge.platform !== 'string') return null;
  if (typeof bridge.keepsAwake !== 'boolean') return null;
  return bridge as DesktopBridge;
}

/** 지금 데스크톱 앱 안인가. 설치 안내를 띄울지 정하는 데 씁니다. */
export function isDesktopApp(win: Window): boolean {
  return desktopBridge(win) !== null;
}

/**
 * ⚠️ **`'desktop-app'` 은 "안전하다" 가 아닙니다.** 데스크톱 앱이라는
 * 사실일 뿐이고, 안전한지는 `keepsAwake` 가 정합니다.
 */
export type RecordingSafety = 'desktop-awake' | 'desktop-app' | 'installed-pwa' | 'browser-tab';

export function recordingSafety(win: Window, standalone: boolean): RecordingSafety {
  const desktop = desktopBridge(win);
  if (desktop) return desktop.keepsAwake ? 'desktop-awake' : 'desktop-app';
  if (standalone) return 'installed-pwa';
  return 'browser-tab';
}

/**
 * 사람에게 하는 말.
 *
 * ⚠️ **"꺼도 됩니다" 는 `desktop-awake` 에서만** 나옵니다. 그 말이
 * 틀리면 사람은 화면을 끄고, 녹음은 끊기고, 그 구간은 영영 못 잽니다.
 * 나머지 셋은 전부 "켜 두세요" 입니다 — 데스크톱 앱이어도요.
 */
export function describeRecordingSafety(safety: RecordingSafety): string {
  switch (safety) {
    case 'desktop-awake':
      return '화면을 꺼도 녹음이 이어집니다. 앱을 완전히 닫지만 마세요.';
    case 'desktop-app':
      return '창을 켜 두세요. 데스크톱 앱이지만 아직 절전 방지가 없어, 화면이 잠기면 녹음이 끊길 수 있습니다.';
    case 'installed-pwa':
      return '창을 켜 두세요. 앱으로 설치돼 있어 꺼짐 방지가 동작하지만, 화면이 잠기면 녹음이 끊길 수 있습니다.';
    case 'browser-tab':
      return '브라우저 탭입니다 — 창을 켜 두고 다른 앱으로 넘어가지 마세요. 데스크톱 앱으로 열면 더 안전합니다.';
  }
}

/** 이 환경이 얼마나 위험한가. 화면이 색을 정하는 데 씁니다. */
export function isRiskyForRecording(safety: RecordingSafety): boolean {
  return safety !== 'desktop-awake';
}
