/**
 * 안드로이드 셸에게 말 걸기 — 판단 부분.
 *
 * ## 왜 웹이 셸에게 알려야 하는가
 *
 * 셸은 지금 녹음 중인지 **모릅니다.** 마이크가 열린 것은 WebView 안에서
 * 일어나는 일이고, 셸이 그걸 들여다볼 방법이 없습니다.
 *
 * 그런데 셸이 알아야 하는 이유가 있습니다. 화면이 꺼지면 안드로이드가
 * 백그라운드 프로세스를 조이고, 그러면 `MediaRecorder` 가 멈춥니다.
 * 포그라운드 서비스만이 그 조임을 면제받는데, 그걸 올리는 건 셸만
 * 할 수 있습니다. 그래서 **웹이 "지금부터 녹음"이라고 말해 줘야**
 * 합니다.
 *
 * ## 왜 앱을 켤 때 올리지 않는가
 *
 * 녹음도 안 하는데 "녹음 중" 알림이 계속 떠 있으면, 사람은 그 알림을
 * **무시하는 법을 배웁니다.** 그러면 진짜 녹음 중일 때도 안 봅니다.
 * 녹음 사실이 보여야 한다는 것이 `docs/07` §1 의 요구인데, 늘 떠 있는
 * 알림은 그 요구를 형식적으로만 만족시킵니다.
 *
 * ## 셸이 없으면
 *
 * 전부 아무 일도 하지 않습니다. 브라우저·PWA 에서는 셸이 없고, 그때는
 * 화면 꺼짐 방지(Wake Lock)가 할 수 있는 만큼만 합니다. **던지지
 * 않습니다** — 셸이 없는 것은 오류가 아니라 정상입니다.
 */

/** 셸이 `addJavascriptInterface` 로 심는 객체. */
export interface ShellBridge {
  isShell: () => boolean;
  version: () => string;
  startRecording: () => void;
  stopRecording: () => void;
}

declare global {
  interface Window {
    /**
     * 셸이 `addJavascriptInterface(…, "TeamFlowShellBridge")` 로 심습니다.
     *
     * ⚠️ 이 이름은 `android/…/ShellBridge.kt` 의 `NAME` 과 **글자까지
     * 같아야** 합니다. 어긋나면 조용히 "셸이 아니다" 가 되고, 셸 안인데
     * 설치 안내가 뜨고 서비스 워커가 셸 캐시와 겹칩니다. 오류는 하나도
     * 나지 않습니다. `backend/tests/test_repo_integrity.py` 가 두 이름을
     * 대조합니다.
     */
    TeamFlowShellBridge?: Partial<ShellBridge>;
  }
}

/**
 * 지금 셸 안인가.
 *
 * ⭐ 객체가 있는지만 보지 않고 **필요한 함수가 다 있는지** 봅니다.
 * 셸 버전이 낮아 함수 하나가 없으면, 있는 줄 알고 부르다가 그 자리에서
 * 예외가 납니다 — 그게 녹음 시작 직전이면 녹음이 아예 시작되지
 * 않습니다.
 */
export function shellBridge(win: Window): ShellBridge | null {
  const bridge = win.TeamFlowShellBridge;
  if (!bridge) return null;

  for (const name of ['isShell', 'version', 'startRecording', 'stopRecording'] as const) {
    if (typeof bridge[name] !== 'function') return null;
  }
  return bridge as ShellBridge;
}

export function isInShell(win: Window): boolean {
  return shellBridge(win) !== null;
}

/**
 * 녹음이 시작됐다고 알린다.
 *
 * 셸이 없으면 아무 일도 하지 않습니다. 있어도 실패할 수 있는데
 * (셸이 예외를 던지는 경우), **그 실패로 녹음을 막지 않습니다** —
 * 알림이 안 뜨는 것보다 녹음이 안 되는 것이 훨씬 나쁩니다.
 */
export function tellShellRecordingStarted(win: Window): boolean {
  const bridge = shellBridge(win);
  if (!bridge) return false;
  try {
    bridge.startRecording();
    return true;
  } catch (error) {
    console.warn('[shell] 녹음 시작을 알리지 못했습니다', error);
    return false;
  }
}

export function tellShellRecordingStopped(win: Window): boolean {
  const bridge = shellBridge(win);
  if (!bridge) return false;
  try {
    bridge.stopRecording();
    return true;
  } catch (error) {
    console.warn('[shell] 녹음 종료를 알리지 못했습니다', error);
    return false;
  }
}

/**
 * 이 환경에서 화면을 꺼도 녹음이 이어지는가.
 *
 * ⭐ 사람에게 **미리** 말해 줘야 합니다. 회의가 끝난 뒤에 "그 폰은
 * 화면을 켜 뒀어야 했다" 고 알게 되면 그 회의는 다시 못 합니다.
 */
export type RecordingSafety = 'shell' | 'installed-pwa' | 'browser-tab';

export function recordingSafety(
  win: Window,
  standalone: boolean,
): RecordingSafety {
  if (isInShell(win)) return 'shell';
  if (standalone) return 'installed-pwa';
  return 'browser-tab';
}

export function describeRecordingSafety(safety: RecordingSafety): string {
  switch (safety) {
    case 'shell':
      return '화면을 꺼도 녹음이 이어집니다. 앱을 완전히 닫지만 마세요.';
    case 'installed-pwa':
      return '화면을 켜 두세요. 앱으로 설치돼 있어 꺼짐 방지가 동작하지만, 화면이 잠기면 녹음이 끊길 수 있습니다.';
    case 'browser-tab':
      return '브라우저 탭입니다 — 화면을 켜 두고 다른 앱으로 넘어가지 마세요. 홈 화면에 추가하면 더 안전합니다.';
  }
}

/** 이 환경이 얼마나 위험한가. 로비 화면이 색을 정하는 데 씁니다. */
export function isRiskyForRecording(safety: RecordingSafety): boolean {
  return safety !== 'shell';
}
