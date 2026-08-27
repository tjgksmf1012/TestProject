/**
 * 앱 껍데기 배선 — 서비스 워커 등록과 설치 안내.
 *
 * ⚠️ **이걸 부르지 않으면 서비스 워커는 아무 일도 하지 않습니다.**
 * `sw.js` 파일이 있는 것과 등록된 것은 다릅니다 — 이 저장소에서 가장
 * 자주 나온 결함이 "만들어 놓고 아무도 부르지 않은 것" 이라, 여기서도
 * 같은 일이 일어나지 않도록 `src/lib/guards.test.ts` 가 **모든 화면이
 * 이 모듈을 가져오는지** 확인합니다.
 *
 * 판단은 `src/lib/pwa/install.ts` 에 있고 11개 테스트가 붙습니다.
 */

import {
  describeInstall,
  installButtonText,
  installState,
  whyInstall,
} from '../lib/pwa/install.ts';
import { isDesktopApp } from '../lib/platform/recording.ts';

// ⚠️ 셸 판별은 `lib/platform/recording.ts` 한 곳에서만 합니다.
//
// 예전에 여기서 이름을 직접 봤는데 셸이 심는 이름과 한 글자가 달랐고,
// **이름이 어긋나면 조용히 "셸이 아니다" 가 됩니다** — 셸 안에서 설치
// 안내가 뜹니다. 오류는 하나도 안 납니다.

/** 브라우저가 준 설치 제안. 붙잡아 뒀다가 사람이 누를 때 쓴다. */
let deferredPrompt: (Event & { prompt: () => Promise<void> }) | null = null;

/**
 * 서비스 워커를 등록한다.
 *
 * 실패해도 앱은 정상 동작합니다 — 오프라인 안내가 없어질 뿐입니다.
 * 그래서 던지지 않고 로그만 남깁니다. 다만 **조용히** 넘어가지는
 * 않습니다. `http://` 로 열면 브라우저가 등록을 거부하는데
 * (localhost 는 예외), 그걸 모르면 "왜 오프라인이 안 되지" 로 몇 시간을
 * 씁니다.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) {
    console.info('[pwa] 이 브라우저는 서비스 워커를 지원하지 않습니다');
    return;
  }
  // ⚠️ **데스크톱 앱에서도 등록합니다.** 안드로이드 셸에서는 건너뛰었는데,
  //    그건 셸이 제 캐시를 따로 들고 있어서 어느 쪽 화면인지 알 수 없게
  //    되기 때문이었습니다. Electron 셸은 캐시를 따로 안 들고 서버 화면을
  //    그대로 띄우므로, 오프라인 대비는 브라우저에서와 똑같이 값이 있습니다.
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error) => {
    console.warn(
      '[pwa] 서비스 워커를 등록하지 못했습니다 — 오프라인 화면이 뜨지 않습니다.',
      'https:// 또는 localhost 에서만 등록됩니다.',
      error,
    );
  });
}

/**
 * 지금 이 환경에서 설치가 어떤 상태인가.
 *
 * `<p id="install">` 이 있는 화면이면 거기에 안내를 씁니다.
 * 없으면 아무 일도 하지 않습니다 — 화면마다 안내를 넣을지는 그 화면이
 * 정합니다.
 */
export function renderInstallHint(): void {
  const host = document.getElementById('install');
  if (!host) return;

  const state = installState({
    userAgent: navigator.userAgent,
    standalone: matchMedia('(display-mode: standalone)').matches,
    iosStandalone:
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
    hasPrompt: deferredPrompt !== null,
    inShell: isDesktopApp(window),
  });

  const text = describeInstall(state);
  host.textContent = text;
  host.hidden = text === '';

  // 카드 전체를 숨긴다. 안내가 비었는데 제목만 남으면 "앱으로 쓰기"
  // 밑에 아무것도 없는 빈 상자가 된다.
  const card = document.getElementById('install-card');
  if (card) card.hidden = text === '';

  const why = document.getElementById('install-why');
  if (why) why.textContent = text === '' ? '' : whyInstall();

  const button = document.getElementById('install-now');
  if (!button) return;
  /* ⚠️ 글자는 `@lib` 이 정합니다 (결함 422). 마크업에도 같은 글자가 있는데,
     그건 스크립트가 돌기 전에도 보여야 해서 둔 사본입니다 — 갈라지지 않게
     검사가 짝을 잽니다. 여기서 다시 쓰면 어휘를 고칠 때 화면이 따라옵니다. */
  button.textContent = installButtonText();
  button.hidden = state !== 'promptable';
  button.onclick = () => {
    void deferredPrompt?.prompt();
    // 제안은 한 번만 쓸 수 있다. 다시 쓰면 브라우저가 거부한다.
    deferredPrompt = null;
    button.hidden = true;
  };
}

addEventListener('beforeinstallprompt', (event) => {
  // 브라우저가 자기 배너를 띄우는 것을 막고, 우리가 원하는 자리에서
  // 보여준다. 막지 않으면 녹음 중에 배너가 튀어나온다.
  event.preventDefault();
  deferredPrompt = event as Event & { prompt: () => Promise<void> };
  renderInstallHint();
});

/** 모든 화면이 부르는 것. `nav.ts` 와 짝입니다. */
export function bootApp(): void {
  registerServiceWorker();
  renderInstallHint();
}
