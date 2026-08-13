import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeRecordingSafety,
  desktopBridge,
  isDesktopApp,
  isRiskyForRecording,
  recordingSafety,
  type RecordingSafety,
} from './recording.ts';

/** 데스크톱 셸이 preload 로 심는 것을 흉내 냅니다. */
const fakeWindow = (bridge: unknown = { shell: 1, platform: 'linux', electron: '43.4.0', keepsAwake: false }) =>
  ({ teamflowDesktop: bridge }) as unknown as Window;

const browser = () => ({}) as unknown as Window;

describe('데스크톱 셸 판별', () => {
  it('셸이 심은 것이 다 있으면 셸이다', () => {
    assert.ok(desktopBridge(fakeWindow()) !== null);
    assert.equal(isDesktopApp(fakeWindow()), true);
  });

  it('브라우저에는 없다', () => {
    assert.equal(desktopBridge(browser()), null);
    assert.equal(isDesktopApp(browser()), false);
  });

  it('⭐ 칸이 하나라도 빠지면 셸로 안 본다', () => {
    // ⚠️ 객체가 있는지만 보면, 셸 판이 낮아 칸이 빠졌을 때 `undefined` 를
    //    참으로 다루게 됩니다 — 그 자리가 하필 "재우기를 막는가" 입니다.
    for (const missing of ['shell', 'platform', 'keepsAwake']) {
      const bridge: Record<string, unknown> = {
        shell: 1,
        platform: 'linux',
        electron: '43.4.0',
        keepsAwake: false,
      };
      delete bridge[missing];
      assert.equal(desktopBridge(fakeWindow(bridge)), null, missing);
    }
  });

  it('⭐ `keepsAwake` 가 불리언이 아니면 셸로 안 본다', () => {
    // 문자열 `'false'` 는 참입니다. 그대로 믿으면 "화면을 꺼도 됩니다" 가
    // 뜨고, 사람은 화면을 끄고, 그 구간은 영영 못 잽니다.
    for (const bad of ['false', 0, null, undefined]) {
      assert.equal(
        desktopBridge(fakeWindow({ shell: 1, platform: 'linux', electron: 'x', keepsAwake: bad })),
        null,
        String(bad),
      );
    }
  });
});

describe('녹음 안전 — 셸 이름이 아니라 능력으로', () => {
  it('재우기를 막는 셸만 안전하다', () => {
    const awake = fakeWindow({ shell: 1, platform: 'linux', electron: 'x', keepsAwake: true });
    assert.equal(recordingSafety(awake, false), 'desktop-awake');
  });

  it('⭐ 데스크톱 앱이어도 못 막으면 안전하지 않다', () => {
    // ⚠️ 이것이 이 모듈이 존재하는 이유입니다. 지금 Phase 0 이 정확히
    //    이 상태입니다 — 창은 있는데 `powerSaveBlocker` 는 없습니다.
    assert.equal(recordingSafety(fakeWindow(), false), 'desktop-app');
    assert.equal(isRiskyForRecording('desktop-app'), true);
  });

  it('설치한 PWA 와 브라우저 탭', () => {
    assert.equal(recordingSafety(browser(), true), 'installed-pwa');
    assert.equal(recordingSafety(browser(), false), 'browser-tab');
  });

  it('⭐ 셸 안에서는 standalone 여부가 판정을 못 바꾼다', () => {
    // 데스크톱 앱은 `display-mode: standalone` 이 참일 수도 거짓일 수도
    // 있습니다. 그것으로 안전을 정하면 셸 밖의 우연이 판정을 흔듭니다.
    assert.equal(recordingSafety(fakeWindow(), true), 'desktop-app');
  });
});

describe('사람에게 하는 말', () => {
  const ALL: RecordingSafety[] = ['desktop-awake', 'desktop-app', 'installed-pwa', 'browser-tab'];

  it('넷 다 할 말이 있다', () => {
    for (const s of ALL) assert.ok(describeRecordingSafety(s).length > 0, s);
  });

  it('⭐ "꺼도 됩니다" 는 실제로 막을 때만 나온다', () => {
    // ⚠️ 이 말이 틀리면 사람은 화면을 끄고, 녹음은 끊기고, 그 구간은
    //    영영 못 잽니다. 이 저장소에서 제일 비싼 거짓말입니다.
    for (const s of ALL) {
      const text = describeRecordingSafety(s);
      const saysSafe = text.includes('꺼도');
      assert.equal(saysSafe, s === 'desktop-awake', `${s}: ${text}`);
    }
  });

  it('나머지 셋은 전부 켜 두라고 말한다', () => {
    for (const s of ALL.filter((x) => x !== 'desktop-awake')) {
      assert.ok(describeRecordingSafety(s).includes('켜 두'), s);
    }
  });

  it('위험 판정과 문구가 어긋나지 않는다', () => {
    for (const s of ALL) {
      assert.equal(isRiskyForRecording(s), !describeRecordingSafety(s).includes('꺼도'), s);
    }
  });

  it('⭐ 폰 이야기를 하지 않는다', () => {
    // 모바일을 범위에서 뺐습니다. "홈 화면에 추가" 같은 폰 안내가 남아
    // 있으면 PC 사용자에게 없는 길을 알려 주는 것입니다.
    for (const s of ALL) {
      const text = describeRecordingSafety(s);
      for (const word of ['폰', '홈 화면', '모바일']) {
        assert.ok(!text.includes(word), `${s} 에 "${word}" 가 남아 있습니다: ${text}`);
      }
    }
  });
});
