import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeInstall,
  installState,
  isIOS,
  whyInstall,
  type InstallEnvironment,
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
