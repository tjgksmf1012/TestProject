import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { closeButtons, leavesOnAnswer, whenClosing } from './closing.ts';

describe('창을 닫을 때 (결함 342)', () => {
  it('⭐ 녹음 중이 아니면 그냥 닫는다', () => {
    deepStrictEqual(whenClosing(false), { kind: 'quit' });
  });

  it('⛔ 녹음 중이면 **묻고 나서** 닫는다', () => {
    const verdict = whenClosing(true);
    strictEqual(verdict.kind, 'confirm');
  });

  it('⭐ 되돌릴 수 없다는 것을 말한다', () => {
    const verdict = whenClosing(true);
    ok(verdict.kind === 'confirm');
    ok(/되돌릴 수 없습니다/.test(verdict.body), verdict.body);
  });

  it('⭐ 무엇을 하면 안전한지도 말한다 — 「알려 주고 할 자리를 안 주는」 것 금지', () => {
    // 이 저장소의 대표 실패 ③ 입니다. "닫지 마세요" 만 적으면 사람은
    // 어떻게 해야 안전하게 끝내는지 모릅니다.
    const verdict = whenClosing(true);
    ok(verdict.kind === 'confirm');
    ok(/정지/.test(verdict.body), verdict.body);
  });

  it('⭐ 머무르는 쪽이 **먼저**다 — 기본값이 안전한 쪽', () => {
    const verdict = whenClosing(true);
    ok(verdict.kind === 'confirm');
    deepStrictEqual(closeButtons(verdict), [verdict.stay, verdict.leave]);
    strictEqual(closeButtons(verdict)[0], verdict.stay);
  });

  it('⛔ 모르는 응답이면 **안 닫는다**', () => {
    // 대화상자가 X 로 닫히거나 OS 가 이상한 값을 주면 0 이 옵니다.
    // 되돌릴 수 없는 쪽으로 기울면 안 됩니다.
    strictEqual(leavesOnAnswer(0), false);
    strictEqual(leavesOnAnswer(1), true);
    strictEqual(leavesOnAnswer(-1), false);
    strictEqual(leavesOnAnswer(99), false);
  });

  it('⭐ 안 물을 때는 버튼이 없다', () => {
    deepStrictEqual(closeButtons(whenClosing(false)), []);
  });
});
