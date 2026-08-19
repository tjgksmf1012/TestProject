import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PRIORITIES,
  PRIORITY_DEFAULT,
  describePriority,
  isPriority,
  priorityChoices,
  priorityTone,
  showsBadge,
} from './priority.ts';

describe('isPriority', () => {
  it('아는 넷만 통과한다', () => {
    for (const p of PRIORITIES) strictEqual(isPriority(p), true, String(p));
  });

  it('⚠️ 제약 밖 값은 거른다 — 제약을 걸기 전에 들어간 행이 남아 있을 수 있다', () => {
    for (const bad of [-1, 4, 99, 1.5]) strictEqual(isPriority(bad), false, String(bad));
  });

  it('숫자가 아닌 것도 거른다 — 서버가 문자열을 주면 화면이 빈 칸을 그린다', () => {
    for (const bad of ['1', null, undefined, {}, []]) strictEqual(isPriority(bad), false);
  });
});

describe('describePriority', () => {
  it('⭐ 작을수록 급하다 — 방향이 뒤집히면 정렬이 조용히 거꾸로 간다', () => {
    strictEqual(describePriority(0), '긴급');
    strictEqual(describePriority(1), '높음');
    strictEqual(describePriority(2), '보통');
    strictEqual(describePriority(3), '낮음');
  });

  it('모르는 값은 기본값의 이름으로 — 빈 칸을 그리지 않는다', () => {
    strictEqual(describePriority(99), '보통');
    strictEqual(describePriority(null), '보통');
  });
});

describe('showsBadge', () => {
  it('⭐ `보통` 은 안 그린다 — 넷 중 셋에 배지가 붙으면 배지가 배경이 된다', () => {
    strictEqual(showsBadge(PRIORITY_DEFAULT), false);
  });

  it('나머지 셋은 그린다', () => {
    strictEqual(showsBadge(0), true);
    strictEqual(showsBadge(1), true);
    strictEqual(showsBadge(3), true);
  });

  it('모르는 값은 안 그린다', () => {
    strictEqual(showsBadge(99), false);
    strictEqual(showsBadge(undefined), false);
  });
});

describe('priorityTone', () => {
  it('⭐ 색은 `긴급` 에만 — 넷을 네 색으로 칠하면 칸반이 신호등이 된다', () => {
    strictEqual(priorityTone(0), 'urgent');
    for (const p of [1, 2, 3]) strictEqual(priorityTone(p), 'plain', String(p));
  });
});

describe('priorityChoices', () => {
  it('⭐ 급한 것부터 넷 다 — 지금 값도 남긴다', () => {
    const choices = priorityChoices(1);
    deepStrictEqual(choices.map((c) => c.value), [0, 1, 2, 3]);
    deepStrictEqual(choices.map((c) => c.label), ['긴급', '높음', '보통', '낮음']);
    deepStrictEqual(choices.filter((c) => c.current).map((c) => c.value), [1]);
  });

  it('모르는 값이면 기본값이 지금 값이 된다', () => {
    deepStrictEqual(
      priorityChoices(99).filter((c) => c.current).map((c) => c.value),
      [PRIORITY_DEFAULT],
    );
  });
});

describe('백엔드 어휘와 짝', () => {
  it('⚠️ 값이 넷이고 기본값이 2 다 — vocab.TaskPriority 와 갈라지면 안 된다', () => {
    // 교차 검사는 `backend/tests/test_repo_integrity.py` 가 합니다.
    // 여기서는 이쪽 절반의 모양만 못 박습니다.
    deepStrictEqual([...PRIORITIES], [0, 1, 2, 3]);
    strictEqual(PRIORITY_DEFAULT, 2);
  });
});
