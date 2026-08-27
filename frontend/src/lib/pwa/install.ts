/**
 * 앱으로 설치하기 — 판단 부분.
 *
 * ## 왜 이게 로직인가
 *
 * "홈 화면에 추가" 는 브라우저마다 완전히 다릅니다.
 *
 *   · **안드로이드 크롬** — `beforeinstallprompt` 이벤트를 주고, 우리가
 *     붙잡아 뒀다가 원하는 순간에 `prompt()` 를 부를 수 있습니다.
 *   · **iOS 사파리** — 그런 이벤트가 **없습니다.** 사람이 공유 버튼 →
 *     "홈 화면에 추가" 를 직접 눌러야 합니다. 그래서 안내 문구를
 *     보여주는 것 말고 할 수 있는 게 없습니다.
 *   · **이미 설치된 상태** — 안내를 또 보여주면 안 됩니다. 이미 앱
 *     안에서 "앱으로 설치하세요" 를 읽는 셈입니다.
 *   · **안드로이드 셸(WebView)** — 여기서는 설치가 아예 뜻이 없습니다.
 *
 * 화면 코드에 `if (isIOS)` 를 흩뿌리면 넷 중 하나가 반드시 어긋납니다.
 * 어긋나도 예외가 안 나서 아무도 모릅니다 — 그냥 안내가 안 뜨거나
 * 엉뚱하게 뜹니다.
 */

export type InstallState =
  /** 이미 앱으로 실행 중. 아무것도 보여주지 않는다. */
  | 'installed'
  /** 안드로이드 셸 안. 설치라는 개념이 없다. */
  | 'in-shell'
  /** 브라우저가 설치를 제안할 수 있다. 버튼을 보여준다. */
  | 'promptable'
  /** iOS — 사람이 직접 해야 한다. 방법을 알려 준다. */
  | 'manual-ios'
  /** 설치할 방법이 없다(데스크톱 브라우저 등). 조용히 있는다. */
  | 'unavailable';

export interface InstallEnvironment {
  /** `navigator.userAgent` */
  userAgent: string;
  /** `matchMedia('(display-mode: standalone)').matches` */
  standalone: boolean;
  /** iOS 사파리만 쓰는 옛 신호. `navigator.standalone` */
  iosStandalone: boolean;
  /** `beforeinstallprompt` 를 받아 뒀는가 */
  hasPrompt: boolean;
  /** 안드로이드 셸이 심어 주는 표식 */
  inShell: boolean;
}

/** iOS 판별. iPad 는 iPadOS 13부터 맥이라고 말한다. */
export function isIOS(userAgent: string): boolean {
  if (/iPhone|iPod/.test(userAgent)) return true;
  // iPadOS 13+ 는 `Macintosh` 로 위장한다. 진짜 맥과 구분하려면
  // 터치를 봐야 하는데, 여기서는 순수 함수라 UA 만으로 판단한다.
  if (/iPad/.test(userAgent)) return true;
  return false;
}

export function installState(env: InstallEnvironment): InstallState {
  // 셸을 먼저 본다. 셸 안에서도 standalone 일 수 있는데, 그때
  // "설치됨" 이라고 하면 틀린 건 아니지만 할 말이 다르다.
  if (env.inShell) return 'in-shell';
  if (env.standalone || env.iosStandalone) return 'installed';
  if (env.hasPrompt) return 'promptable';
  if (isIOS(env.userAgent)) return 'manual-ios';
  return 'unavailable';
}

/**
 * 사람에게 할 말.
 *
 * ⭐ iOS 안내는 **어느 버튼인지** 말해야 합니다. "홈 화면에 추가하세요"
 * 만으로는 어디를 눌러야 할지 모릅니다 — 공유 버튼은 사파리 아래쪽에
 * 있고 크롬(iOS)에서는 주소창 옆에 있습니다.
 */
export function describeInstall(state: InstallState): string {
  switch (state) {
    case 'promptable':
      /* ⚠️ **폰 이야기를 하지 않습니다** (결함 422). 예전에는 「…홈 화면에서
         바로 들어옵니다」였습니다. 모바일은 2026-08-13 에 범위에서 뺐고
         셸은 PC 웹·PC 앱 둘뿐인데, PC 에는 홈 화면이 없습니다 — 데스크톱
         크롬도 「설치」라고 부릅니다. 실제로 데스크톱에서 재현했습니다. */
      return '앱으로 설치하면 브라우저 탭이 아니라 창 하나로 열리고, 다음부터 바로 들어옵니다.';
    case 'manual-ios':
      // ⚠️ 예전에는 `⬆️` 를 넣었습니다. 그건 **색 이모지**라 기기마다 다르게
      // 그려지고, 정작 iOS 의 공유 버튼과 모양이 다릅니다. 자리와 생김새를
      // 말로 적는 편이 실제로 찾는 데 낫습니다.
      return '아이폰에서는 화면 아래 가운데의 공유 버튼(상자에서 위로 나가는 화살표) → "홈 화면에 추가"를 누르면 앱처럼 쓸 수 있습니다.';
    case 'installed':
      return '';
    case 'in-shell':
      return '';
    case 'unavailable':
      return '';
  }
}

/**
 * 왜 설치를 권하는가 — 이 앱에서는 이유가 하나 더 있습니다.
 *
 * 설치한 PWA 는 **화면 꺼짐 방지(Wake Lock)** 가 브라우저 탭보다 잘
 * 듣습니다. 녹음이 끊기는 것이 이 프로젝트의 1순위 위험이라, 설치는
 * 겉모습 문제가 아닙니다.
 */
/**
 * 설치 단추 글자.
 *
 * ⚠️ `home.html` 이 이 글자를 **마크업에 그대로** 들고 있습니다(React 가
 * 그리기 전에도 보여야 하므로). 사본 둘이 갈라지지 않게 가드가 짝을
 * 잽니다 — 결함 421 이 정적 화면의 건너뛰기 링크에서 쓴 방법입니다.
 */
export function installButtonText(): string {
  return '앱으로 설치';
}

export function whyInstall(): string {
  return (
    '설치하면 녹음 중에 화면이 꺼지는 것을 더 잘 막습니다 — ' +
    '브라우저 탭에서는 화면 꺼짐 방지가 잘 듣지 않습니다.'
  );
}
