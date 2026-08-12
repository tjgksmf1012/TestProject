import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeType,
  pendingNote,
  TYPE_LABEL,
  TYPE_ORDER,
  typeCounts,
} from './labels.ts';

describe('이름', () => {
  it('유형을 사람 말로', () => {
    strictEqual(describeType('objection'), '반대 의견');
    strictEqual(describeType('refinement'), '보완 의견');
  });

  it('⚠️ 모르는 값을 지어내지 않는다', () => {
    strictEqual(describeType('sarcasm'), 'sarcasm');
  });

  it('아직 분류 안 한 것은 아무 말도 안 한다', () => {
    strictEqual(describeType(null), null);
    strictEqual(describeType(''), null);
  });

  it('⭐ 요구 열 가지가 **각각 제 이름**을 가진다', () => {
    // 동의·반대·보완이 한 이름을 쓰면 회의 리뷰가 "의견 10" 만 말하게 된다.
    for (const type of [
      'question',
      'proposal',
      'answer',
      'agreement',
      'objection',
      'refinement',
      'decision',
      'request',
      'commitment',
      'confirmation',
    ]) {
      strictEqual(typeof TYPE_LABEL[type], 'string', type);
    }
    const spec = [
      'question',
      'proposal',
      'answer',
      'agreement',
      'objection',
      'refinement',
      'decision',
      'request',
      'commitment',
      'confirmation',
    ].map((t) => TYPE_LABEL[t]);
    strictEqual(new Set(spec).size, spec.length, `이름이 겹칩니다: ${spec.join(',')}`);
  });

  it('순서에 빠진 유형이 없다', () => {
    deepStrictEqual([...TYPE_ORDER].sort(), Object.keys(TYPE_LABEL).sort());
  });
});

describe('유형별 건수', () => {
  const meeting = { question: 2, agreement: 1, objection: 1, decision: 1, social: 1 };

  it('센다', () => {
    const counts = typeCounts(meeting);
    strictEqual(counts.find((c) => c.type === 'question')?.count, 2);
    strictEqual(counts.find((c) => c.type === 'objection')?.count, 1);
  });

  it('⭐ 순서는 고정 — 건수 순이 아니다', () => {
    // 건수 순이면 회의마다 자리가 바뀌고, 맨 위가 "제일 중요한 것" 으로 읽힌다.
    deepStrictEqual(
      typeCounts(meeting).map((c) => c.type),
      [...TYPE_ORDER],
    );
  });

  it('⭐ 0건도 남긴다 — "반대가 없었다" 는 말해 줄 것이 많다', () => {
    strictEqual(typeCounts({ question: 1 }).find((c) => c.type === 'objection')?.count, 0);
  });

  it('점수가 0인 것에 표시가 붙는다', () => {
    const counts = typeCounts(meeting);
    strictEqual(counts.find((c) => c.type === 'social')?.zero, true);
    strictEqual(counts.find((c) => c.type === 'decision')?.zero, false);
  });

  it('⚠️ 모르는 값이 와도 버리지 않는다 — 버리면 합이 안 맞는다', () => {
    strictEqual(typeCounts({ sarcasm: 1 }).find((c) => c.type === 'sarcasm')?.count, 1);
  });

  it('빈 회의도 열세 줄을 그린다', () => {
    strictEqual(typeCounts({}).length, TYPE_ORDER.length);
  });
});

describe('아직 분류 안 한 것', () => {
  it('⭐ 0건과 **섞지 않는다** — 안 잰 것과 재고 나서 모르는 것은 다르다', () => {
    // 섞으면 분석이 안 끝난 회의가 "분류가 안 되는 회의" 로 보인다 (불변식 3).
    strictEqual(pendingNote(3, 10), '3건은 아직 분류 전입니다 — 아래 숫자에 안 들어 있습니다.');
  });

  it('하나도 안 했으면 숫자를 앞세우지 않는다', () => {
    strictEqual(pendingNote(10, 10), '아직 분류하지 않았습니다 — 분석이 끝나면 나옵니다.');
  });

  it('다 했으면 조용하다', () => {
    strictEqual(pendingNote(0, 10), null);
  });
});

describe('REVIEW-005 — 동의 수 · 반대 의견 수', () => {
  it('⭐ 찬반 셋이 **나란히** 놓인다 — 그것이 곧 REVIEW-005 의 답이다', () => {
    // 따로 한 줄을 더 뽑았다가 목록과 같은 값이 두 줄로 나와서 걷어냈다.
    const at = (t: string): number => TYPE_ORDER.indexOf(t);
    strictEqual(at('objection'), at('agreement') + 1);
    strictEqual(at('refinement'), at('objection') + 1);
  });

  it('셋을 각각 셀 수 있다 — 뭉개져 있으면 이게 불가능하다', () => {
    const counts = typeCounts({ agreement: 2, objection: 1, refinement: 3 });
    deepStrictEqual(
      ['agreement', 'objection', 'refinement'].map(
        (t) => counts.find((c) => c.type === t)?.count,
      ),
      [2, 1, 3],
    );
  });
});
