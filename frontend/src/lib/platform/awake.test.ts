import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { awakeBridge, shouldHoldAwake } from './awake.ts';

describe('재우기 다리 판별', () => {
  it('두 칸 다 있으면 다리다', () => {
    assert.ok(awakeBridge({ hold: async () => true, release: async () => false }) !== null);
  });

  it('⭐ 한 칸이라도 빠지면 다리가 아니다', () => {
    // 잡기만 하고 못 놓으면 배터리를 태우고, 놓기만 있으면 못 잡습니다.
    assert.equal(awakeBridge({ hold: async () => true }), null);
    assert.equal(awakeBridge({ release: async () => false }), null);
    for (const junk of [undefined, null, 0, 'x', {}]) {
      assert.equal(awakeBridge(junk), null, String(junk));
    }
  });
});

describe('어느 국면에서 잡는가', () => {
  it('녹음이 사는 동안만 잡는다', () => {
    for (const phase of ['recording', 'interrupted', 'stopping']) {
      assert.equal(shouldHoldAwake(phase), true, phase);
    }
  });

  it('⭐ interrupted 에서도 잡는다', () => {
    // 화면이 가려져 잠깐 끊긴 상태에서 절전 방지를 놓으면 기계가 잠들어
    // **되살아날 기회 자체가 사라집니다.**
    assert.equal(shouldHoldAwake('interrupted'), true);
  });

  it('⭐ 녹음 전·후에는 안 잡는다 — 항상 켜 두면 배터리만 탄다', () => {
    for (const phase of ['idle', 'ready', 'completed', 'failed', '']) {
      assert.equal(shouldHoldAwake(phase), false, phase || '(빈 값)');
    }
  });
});
