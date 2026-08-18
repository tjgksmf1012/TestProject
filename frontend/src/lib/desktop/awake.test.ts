import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AwakeLedger } from './awake.ts';

describe('재우기 방지 장부', () => {
  it('첫 hold 만 켜고, 마지막 release 만 끈다', () => {
    const ledger = new AwakeLedger();
    assert.equal(ledger.hold(), true, '첫 hold 는 켜야 합니다');
    assert.equal(ledger.hold(), false, '둘째 hold 는 이미 켜져 있습니다');
    assert.equal(ledger.release(), false, '하나 남았으면 못 끕니다');
    assert.equal(ledger.release(), true, '마지막 release 가 끕니다');
  });

  it('⭐ hold·hold·release 에서 꺼지지 않는다', () => {
    // ⚠️ 이게 이 장부가 존재하는 이유입니다. 호출 횟수에 그대로 묶으면
    //    여기서 꺼지고, **녹음이 도는데 절전 방지가 풀립니다.**
    const ledger = new AwakeLedger();
    ledger.hold();
    ledger.hold();
    ledger.release();
    assert.equal(ledger.held, true, '아직 잡고 있는데 풀렸습니다');
  });

  it('⭐ 잡은 적 없는 release 는 아무 일도 아니다', () => {
    // 음수로 내려가면 다음 hold 가 "첫 번째" 가 아니게 되어 안 켜집니다.
    const ledger = new AwakeLedger();
    assert.equal(ledger.release(), false);
    assert.equal(ledger.release(), false);
    assert.equal(ledger.hold(), true, 'release 남발 뒤에도 첫 hold 는 켜야 합니다');
  });

  it('놓았다 다시 잡으면 다시 켠다', () => {
    const ledger = new AwakeLedger();
    ledger.hold();
    ledger.release();
    assert.equal(ledger.hold(), true, '다 놓은 뒤의 hold 는 다시 첫 번째입니다');
  });
});
