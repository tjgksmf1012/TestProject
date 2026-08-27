import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  describeInstall,
  installButtonText,
  installState,
  isIOS,
  whyInstall,
  type InstallEnvironment,
  type InstallState,
} from './install.ts';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const DESKTOP =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function env(over: Partial<InstallEnvironment> = {}): InstallEnvironment {
  return {
    userAgent: ANDROID,
    standalone: false,
    iosStandalone: false,
    hasPrompt: false,
    inShell: false,
    ...over,
  };
}

describe('isIOS', () => {
  it('아이폰을 알아본다', () => {
    strictEqual(isIOS(IPHONE), true);
  });

  it('안드로이드와 데스크톱은 아니다', () => {
    strictEqual(isIOS(ANDROID), false);
    strictEqual(isIOS(DESKTOP), false);
  });
});

describe('installState', () => {
  it('⭐ 이미 앱으로 열려 있으면 설치를 권하지 않는다', () => {
    // 앱 안에서 "앱으로 설치하세요" 를 읽는 셈이 된다.
    strictEqual(installState(env({ standalone: true })), 'installed');
    strictEqual(installState(env({ iosStandalone: true })), 'installed');
  });

  it('⭐ 안드로이드 셸 안에서는 설치라는 개념이 없다', () => {
    // 셸이 곧 앱이다. standalone 이든 아니든 셸이 먼저다.
    strictEqual(installState(env({ inShell: true })), 'in-shell');
    strictEqual(installState(env({ inShell: true, standalone: true })), 'in-shell');
  });

  it('브라우저가 제안할 수 있으면 버튼을 보여준다', () => {
    strictEqual(installState(env({ hasPrompt: true })), 'promptable');
  });

  it('⭐ iOS 는 제안 이벤트가 없어서 방법을 알려 줘야 한다', () => {
    // `beforeinstallprompt` 가 없다. 버튼을 만들어도 누를 게 없다.
    strictEqual(installState(env({ userAgent: IPHONE })), 'manual-ios');
  });

  it('설치할 방법이 없으면 조용히 있는다', () => {
    strictEqual(installState(env({ userAgent: DESKTOP })), 'unavailable');
  });
});

describe('describeInstall', () => {
  it('⭐ iOS 안내는 **어느 버튼인지** 말한다', () => {
    // "홈 화면에 추가하세요" 만으로는 어디를 눌러야 할지 모른다.
    const text = describeInstall('manual-ios');
    strictEqual(text.includes('공유'), true);
    strictEqual(text.includes('홈 화면에 추가'), true);
  });

  it('설치됐거나 셸 안이면 아무 말도 하지 않는다', () => {
    strictEqual(describeInstall('installed'), '');
    strictEqual(describeInstall('in-shell'), '');
    strictEqual(describeInstall('unavailable'), '');
  });

  it('제안 가능하면 무엇이 좋아지는지 말한다', () => {
    strictEqual(describeInstall('promptable').length > 0, true);
  });
});

describe('whyInstall', () => {
  it('⭐ 겉모습이 아니라 녹음 이야기를 한다', () => {
    // 화면이 꺼져서 녹음이 끊기는 것이 이 프로젝트의 1순위 위험이다.
    // "예쁘게 열립니다" 로는 사람이 설치할 이유가 없다.
    const text = whyInstall();
    strictEqual(text.includes('녹음'), true);
    strictEqual(text.includes('화면'), true);
  });
});


describe('PC 전용 제품이 **폰 이야기를 하지 않는다** (결함 422)', () => {
  /*
   * 모바일은 2026-08-13 에 범위에서 뺐습니다 — 셸은 PC 웹·PC 앱 둘뿐입니다.
   * 그런데 홈 화면의 설치 카드는 데스크톱 크롬에서 이렇게 그려졌습니다:
   *
   *     앱으로 설치하면 주소창 없이 전체 화면으로 열리고, **홈 화면에서**
   *     바로 들어옵니다.            [ 홈 화면에 추가 ]
   *
   * PC 에는 홈 화면이 없습니다. 데스크톱 크롬 자신도 「설치」라고 부릅니다.
   * `beforeinstallprompt` 를 흘려보내 리눅스 데스크톱에서 재현했습니다.
   *
   * ⚠️ **막으라고 둔 가드가 이미 있었습니다** — `platform/recording.test.ts`
   * 의 「⭐ 폰 이야기를 하지 않는다」. 그 자가 걷는 자리는
   * `describeRecordingSafety` **한 함수**뿐이라 설치 어휘는 통째로 눈
   * 밖이었습니다(결함 286 의 모양 — 자가 아니라 **걷는 자리**가 좁았습니다).
   *
   * ⛔ **`manual-ios` 는 뺍니다.** 그 갈래는 아이폰 사용자에게 **일부러**
   * 폰 이야기를 하는 자리입니다. 모바일이 범위 밖이므로 그 갈래를 아예
   * 없앨지는 **결정이 필요한 자리**로 `docs/24` 에 적었습니다 — 재현할 수
   * 있는 결함이 아니라 정책 문제입니다.
   */
  const PHONE_WORDS = ['폰', '홈 화면', '모바일'];

  /** PC 에서 볼 수 있는 갈래. `manual-ios` 는 위 주석대로 뺍니다. */
  const ON_PC: InstallState[] = ['promptable', 'installed', 'in-shell', 'unavailable'];

  it('⭐ PC 에서 볼 수 있는 설치 안내에 폰 낱말이 없다', () => {
    for (const state of ON_PC) {
      const text = describeInstall(state);
      for (const word of PHONE_WORDS) {
        strictEqual(
          text.includes(word),
          false,
          `${state} 에 "${word}" 가 남아 있습니다: ${text}`,
        );
      }
    }
  });

  it('⭐ 「왜 설치하나」와 단추 글자에도 없다', () => {
    for (const text of [whyInstall(), installButtonText()]) {
      for (const word of PHONE_WORDS) {
        strictEqual(text.includes(word), false, `"${word}" 가 남아 있습니다: ${text}`);
      }
    }
  });

  it('⭐ 마크업의 **사람에게 보이는 글**에도 폰 낱말이 없다', () => {
    /*
     * ⚠️ **걷는 자리를 넓힌 것이 이 회차의 핵심입니다.** 「폰 이야기 금지」를
     * 재는 자가 오래도록 `describeRecordingSafety` **한 함수**뿐이었고,
     * 그래서 설치 어휘와 마크업이 통째로 눈 밖이었습니다(결함 422 ·
     * 결함 286 의 모양). 넓히자마자 제 census 가 한 번도 안 연 화면이
     * 나왔습니다 — `offline.html` 이 「올리지 못한 조각은 **폰**에 남아
     * 있고」·「**폰**에 사본이 남아 있으면」이라고 하고 있었습니다.
     *
     * ⚠️ **주석부터 걷습니다** (결함 238). 이 저장소의 마크업 주석은
     * 「예전에는 이랬다」를 그대로 인용하므로, 안 걷으면 규칙이 자기
     * 설명에 걸립니다 — 바로 위 `⚠️ 폰 이야기를 쓰지 마십시오` 가 그렇습니다.
     */
    const here = dirname(fileURLToPath(import.meta.url));
    const pub = join(here, '..', '..', '..', 'public');
    const files = readdirSync(pub).filter((n) => n.endsWith('.html'));
    strictEqual(files.length > 0, true, '`public/*.html` 이 0개입니다 — 자가 낡았습니다');
    const bad: string[] = [];
    for (const name of files) {
      const visible = readFileSync(join(pub, name), 'utf8')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ');
      for (const word of PHONE_WORDS) {
        if (visible.includes(word)) bad.push(`${name}: "${word}"`);
      }
    }
    deepStrictEqual(bad, [], 'PC 전용 제품인데 폰 이야기가 남아 있습니다');
  });

  it('⛔ 마크업의 사본이 `installButtonText()` 와 **같은 글자**다', () => {
    /* `home.html` 은 React 가 그리기 전에도 보여야 해서 단추 글자를 그대로
       들고 있습니다. 사본 둘은 갈라지므로 짝을 잽니다(결함 421 의 방법). */
    const here = dirname(fileURLToPath(import.meta.url));
    const html = readFileSync(join(here, '..', '..', '..', 'public', 'home.html'), 'utf8');
    const m = /<button id="install-now"[^>]*>\s*([^<]+?)\s*<\/button>/.exec(html);
    strictEqual(m !== null, true, '`#install-now` 단추를 못 찾았습니다 — 자가 낡았습니다');
    strictEqual((m as RegExpExecArray)[1], installButtonText());
  });
});
