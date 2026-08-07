import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeRecordingSafety,
  isInShell,
  isRiskyForRecording,
  recordingSafety,
  shellBridge,
  tellShellRecordingStarted,
  tellShellRecordingStopped,
} from './bridge.ts';

/** 셸이 심는 객체를 흉내 낸다. DOM 이 없어도 되도록 Window 를 가짜로 만든다. */
function fakeWindow(over: Record<string, unknown> | null = {}): Window {
  const calls: string[] = [];
  const bridge =
    over === null
      ? undefined
      : {
          isShell: () => true,
          version: () => '0.1.0',
          startRecording: () => calls.push('start'),
          stopRecording: () => calls.push('stop'),
          ...over,
        };
  return { TeamFlowShellBridge: bridge, __calls: calls } as unknown as Window;
}

const callsOf = (win: Window): string[] =>
  (win as unknown as { __calls: string[] }).__calls;

describe('shellBridge', () => {
  it('셸 안이면 객체를 준다', () => {
    strictEqual(shellBridge(fakeWindow()) !== null, true);
  });

  it('셸이 없으면 null — 오류가 아니라 정상이다', () => {
    strictEqual(shellBridge(fakeWindow(null)), null);
  });

  it('⭐ 함수 하나가 없으면 셸로 치지 않는다', () => {
    // 있는 줄 알고 부르면 **녹음 시작 직전에** 예외가 나고, 그러면
    // 녹음이 아예 시작되지 않는다. 셸 버전이 낮을 때 실제로 생긴다.
    for (const missing of ['isShell', 'version', 'startRecording', 'stopRecording']) {
      strictEqual(shellBridge(fakeWindow({ [missing]: undefined })), null, missing);
    }
  });

  it('함수가 아닌 값이 들어 있어도 셸로 치지 않는다', () => {
    strictEqual(shellBridge(fakeWindow({ startRecording: 'yes' })), null);
  });
});

describe('isInShell', () => {
  it('셸 유무를 답한다', () => {
    strictEqual(isInShell(fakeWindow()), true);
    strictEqual(isInShell(fakeWindow(null)), false);
  });
});

describe('tellShellRecordingStarted / Stopped', () => {
  it('셸이 있으면 알린다', () => {
    const win = fakeWindow();
    strictEqual(tellShellRecordingStarted(win), true);
    strictEqual(tellShellRecordingStopped(win), true);
    strictEqual(callsOf(win).join(','), 'start,stop');
  });

  it('셸이 없으면 아무 일도 하지 않는다', () => {
    strictEqual(tellShellRecordingStarted(fakeWindow(null)), false);
  });

  it('⭐ 셸이 예외를 던져도 녹음을 막지 않는다', () => {
    // 알림이 안 뜨는 것보다 녹음이 안 되는 것이 훨씬 나쁘다.
    const win = fakeWindow({
      startRecording: () => {
        throw new Error('셸 오류');
      },
    });
    strictEqual(tellShellRecordingStarted(win), false);
  });
});

describe('recordingSafety', () => {
  it('셸 안이 가장 안전하다', () => {
    strictEqual(recordingSafety(fakeWindow(), false), 'shell');
    // 셸이 standalone 여부보다 먼저다.
    strictEqual(recordingSafety(fakeWindow(), true), 'shell');
  });

  it('설치한 PWA 는 그다음', () => {
    strictEqual(recordingSafety(fakeWindow(null), true), 'installed-pwa');
  });

  it('브라우저 탭이 가장 위험하다', () => {
    strictEqual(recordingSafety(fakeWindow(null), false), 'browser-tab');
  });
});

describe('describeRecordingSafety', () => {
  it('⭐ 셸에서만 "화면을 꺼도 된다" 고 말한다', () => {
    // 이걸 잘못 말하면 사람이 화면을 끄고, 회의가 끝난 뒤에야
    // 트랙이 반쯤 비어 있다는 걸 알게 된다 — 그 회의는 다시 못 한다.
    strictEqual(describeRecordingSafety('shell').includes('꺼도'), true);
    strictEqual(describeRecordingSafety('installed-pwa').includes('켜 두세요'), true);
    strictEqual(describeRecordingSafety('browser-tab').includes('켜 두고'), true);
  });

  it('브라우저 탭에서는 무엇을 하면 나아지는지 말한다', () => {
    strictEqual(describeRecordingSafety('browser-tab').includes('홈 화면에 추가'), true);
  });

  it('전부 빈 문구가 아니다', () => {
    for (const safety of ['shell', 'installed-pwa', 'browser-tab'] as const) {
      strictEqual(describeRecordingSafety(safety).length > 10, true, safety);
    }
  });
});

describe('isRiskyForRecording', () => {
  it('셸만 안전하다', () => {
    strictEqual(isRiskyForRecording('shell'), false);
    strictEqual(isRiskyForRecording('installed-pwa'), true);
    strictEqual(isRiskyForRecording('browser-tab'), true);
  });
});
