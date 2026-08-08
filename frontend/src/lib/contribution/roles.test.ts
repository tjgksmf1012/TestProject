import { strictEqual } from 'node:assert';
import { deepStrictEqual } from 'node:assert';
import { describe, it } from 'node:test';

import { describeRoles, problemWith, sumOf, toPayload } from './roles.ts';

describe('역할 비중 검사', () => {
  it('합이 1 이면 통과', () => {
    strictEqual(problemWith({ developer: 0.7, planner: 0.3 }), null);
  });

  it('⭐ 합이 1 이 아니면 막는다 — 서버가 정규화해 "돌아가긴" 하기 때문', () => {
    strictEqual(problemWith({ developer: 0.9 })?.includes('합이 1'), true);
    strictEqual(problemWith({ developer: 5, planner: 5 })?.includes('합이 1'), true);
  });

  it('아무것도 안 고르면 막는다', () => {
    strictEqual(problemWith({ developer: 0, planner: 0 })?.includes('하나 이상'), true);
  });

  it('음수를 막는다', () => {
    strictEqual(problemWith({ developer: 1.5, planner: -0.5 })?.includes('음수'), true);
  });

  it('빈 칸(NaN)을 0 으로 치지 않고 말한다', () => {
    strictEqual(problemWith({ developer: Number.NaN })?.includes('숫자'), true);
  });

  it('부동소수 먼지는 통과시킨다 — 0.1 을 세 번 더하면 0.30000000000000004', () => {
    strictEqual(problemWith({ developer: 0.1 + 0.1 + 0.1, planner: 0.7 }), null);
  });

  it('합을 반올림해 돌려준다', () => {
    strictEqual(sumOf({ a: 0.1 + 0.2 }), 0.3);
  });
});

describe('보낼 모양', () => {
  it('⭐ 0 은 뺀다 — 겸직이 아니라 그냥 그 역할이다', () => {
    deepStrictEqual(toPayload({ developer: 1, planner: 0 }), { developer: 1 });
  });
});

describe('역할 문구', () => {
  it('단일 역할', () => {
    strictEqual(describeRoles({ planner: 1 }), '기획 100%');
  });

  it('겸직이면 둘 다 보인다', () => {
    strictEqual(describeRoles({ developer: 0.6, planner: 0.4 }), '개발 60% · 기획 40%');
  });

  it('⚠️ 비어 있으면 "0%" 가 아니라 "정해지지 않았습니다"', () => {
    strictEqual(describeRoles(undefined).includes('정해지지'), true);
    strictEqual(describeRoles({}).includes('정해지지'), true);
  });
});
