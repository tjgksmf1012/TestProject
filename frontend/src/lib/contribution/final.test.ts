import { deepStrictEqual, strictEqual } from 'node:assert';
import { describe, it } from 'node:test';

import { describeFinals, problemsWith, toPayload, type Draft } from './final.ts';

const SYSTEM = new Map([
  [1, 42.5],
  [2, 30.0],
]);
const NAMES = new Map([
  [1, '김민수'],
  [2, '이하늘'],
]);

const draft = (over: Partial<Draft> = {}): Draft => ({
  user_id: 1,
  final_value: null,
  reason: '',
  ...over,
});

describe('보내기 전 검사', () => {
  it('⭐ 값을 바꿨는데 이유가 없으면 막는다', () => {
    const problems = problemsWith([draft({ final_value: 50 })], SYSTEM);
    strictEqual(problems.length, 1);
    strictEqual(problems[0]?.includes('이유'), true);
  });

  it('이유를 적으면 통과한다', () => {
    deepStrictEqual(
      problemsWith([draft({ final_value: 50, reason: '발표를 도맡음' })], SYSTEM),
      [],
    );
  });

  it('공백만 적은 것은 이유가 아니다', () => {
    strictEqual(problemsWith([draft({ final_value: 50, reason: '   ' })], SYSTEM).length, 1);
  });

  it('⚠️ 안 건드린 칸은 이유가 필요 없다 — 그게 기본값이다', () => {
    deepStrictEqual(problemsWith([draft(), draft({ user_id: 2 })], SYSTEM), []);
  });

  it('시스템 값과 **같게** 적은 것도 조정이 아니다', () => {
    deepStrictEqual(problemsWith([draft({ final_value: 42.5 })], SYSTEM), []);
  });

  it('같은 문제를 여러 번 쌓지 않는다 — 사람이 읽을 목록이다', () => {
    const problems = problemsWith(
      [draft({ final_value: 50 }), draft({ user_id: 2, final_value: 10 })],
      SYSTEM,
    );
    strictEqual(problems.length, 1);
  });

  it('숫자가 아니면 막는다', () => {
    strictEqual(problemsWith([draft({ final_value: Number.NaN })], SYSTEM).length, 1);
  });
});

describe('보낼 모양', () => {
  it('⭐ 안 건드린 칸은 값을 **안 보낸다** — 서버가 시스템 값을 쓴다', () => {
    deepStrictEqual(toPayload([draft()], SYSTEM), [{ user_id: 1 }]);
  });

  it('시스템 값과 같게 적어도 안 보낸다', () => {
    deepStrictEqual(toPayload([draft({ final_value: 42.5 })], SYSTEM), [{ user_id: 1 }]);
  });

  it('바꾼 칸만 값과 이유를 싣는다', () => {
    deepStrictEqual(toPayload([draft({ final_value: 50, reason: ' 합의 ' })], SYSTEM), [
      { user_id: 1, final_value: 50, reason: '합의' },
    ]);
  });
});

describe('확정 상태 문구', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    user_id: 1,
    system_value: 42.5,
    final_value: 42.5,
    adjusted_by: 9,
    reason: null,
    confirmed_at: '2026-09-01T12:00:00Z',
    ...over,
  });

  it('⭐ 확정 전에는 **0 이라고 말하지 않는다**', () => {
    const text = describeFinals([], NAMES);
    strictEqual(text.includes('아직'), true);
    strictEqual(text.includes('0'), false, '"0" 은 "확정값이 0" 으로 읽힌다');
  });

  it('그대로 확정한 경우', () => {
    strictEqual(describeFinals([row()], NAMES).includes('그대로'), true);
  });

  it('조정한 사람 이름을 말한다 — 조정에는 주체가 있어야 한다', () => {
    const text = describeFinals([row({ final_value: 50, reason: '합의' })], NAMES);
    strictEqual(text.includes('김민수'), true);
  });
});
