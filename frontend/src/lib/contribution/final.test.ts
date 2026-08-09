import { deepStrictEqual, strictEqual } from 'node:assert';
import { describe, it } from 'node:test';

import {
  adjustmentsToRestore,
  describeFinals,
  problemsWith,
  toPayload,
  type Draft,
  type FinalRow,
} from './final.ts';

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

  it('그대로 확정해도 **누가** 했는지 말한다', () => {
    const text = describeFinals([row({ adjusted_by: 1 })], NAMES);
    strictEqual(text.includes('그대로'), true);
    strictEqual(text.includes('김민수님이 확정'), true, '그대로 두는 것도 사람의 확정이다');
  });

  it('⭐ 조정한 사람과 조정당한 사람을 **가른다** (결함 95)', () => {
    // ⚠️ 이 테스트는 전에 이랬습니다.
    //
    //     const text = describeFinals([row({ final_value: 50, … })], NAMES);
    //     strictEqual(text.includes('김민수'), true);
    //
    // `row()` 의 `user_id` 가 1(김민수)이고 `adjusted_by` 는 9 였습니다.
    // 화면은 **조정당한 사람**의 이름을 대고 있었는데, 그게 우연히
    // 김민수라서 "조정한 사람 이름을 말한다" 는 이름의 테스트가
    // 통과했습니다. **뜻은 맞고 자료가 그 뜻을 못 재는** 테스트입니다.
    //
    // 그래서 여기서는 **다른 사람**이 조정하게 둡니다.
    const text = describeFinals(
      [
        row({ user_id: 2, system_value: 30, final_value: 50, adjusted_by: 1, reason: '발표를 도맡음' }),
      ],
      NAMES,
    );
    strictEqual(text.includes('김민수님이 확정'), true, '주어는 **조정한** 사람이다');
    strictEqual(text.includes('이하늘님 50.0%'), true, '조정당한 사람은 대상으로 적는다');
    strictEqual(
      text.includes('이하늘님이 확정'),
      false,
      '조정당한 사람을 주어로 세우면 제 점수를 스스로 올린 것처럼 읽힌다',
    );
  });

  it('⭐ 조정 이유를 보여준다 (결함 96)', () => {
    // 이유가 없으면 `problemsWith` 와 서버가 둘 다 막습니다. 그렇게 받아
    // 낸 값을 아무 데도 안 보여주면 받은 뜻이 없습니다.
    const text = describeFinals(
      [row({ user_id: 2, system_value: 30, final_value: 50, adjusted_by: 1, reason: '발표를 도맡음' })],
      NAMES,
    );
    strictEqual(text.includes('발표를 도맡음'), true);
    strictEqual(text.includes('시스템 30.0%'), true, '시스템 값을 지우지 않는다');
  });

  it('누가 눌렀는지 기록이 없으면 **지어내지 않는다**', () => {
    const text = describeFinals([row({ adjusted_by: null })], NAMES);
    strictEqual(text.includes('기록에 없습니다'), true);
    strictEqual(text.includes('님이 확정'), false, '빈 자리를 아무 이름으로 메우지 않는다');
  });

  it('이유 없이 조정된 기록도 **0 이나 빈칸으로 말하지 않는다**', () => {
    // 서버가 막으므로 정상 경로로는 안 생깁니다. 그래도 옛 자료나 직접
    // 만진 DB 에서는 옵니다 — 그때 빈 괄호를 보여주면 "이유 없음" 인지
    // "안 읽은 것" 인지 사람이 구분 못 합니다.
    const text = describeFinals(
      [row({ user_id: 2, system_value: 30, final_value: 50, adjusted_by: 1, reason: null })],
      NAMES,
    );
    strictEqual(text.includes('이유가 남아 있지 않습니다'), true);
  });
});

describe('저장된 조정을 입력칸에 되돌려 놓기 (결함 97)', () => {
  const saved = (over: Partial<FinalRow> = {}): FinalRow => ({
    user_id: 1,
    system_value: 41.713,
    final_value: 41.713,
    adjusted_by: 1,
    reason: null,
    confirmed_at: '2026-09-01T12:00:00Z',
    ...over,
  });

  it('⭐ 사람이 조정한 칸은 값과 이유를 그대로 돌려준다', () => {
    const back = adjustmentsToRestore([
      saved(),
      saved({ user_id: 2, system_value: 33.552, final_value: 30, reason: '문서 작업이 많았습니다' }),
    ]);
    deepStrictEqual(back.get(2), { final_value: 30, reason: '문서 작업이 많았습니다' });
  });

  it('⭐ 안 건드린 칸은 **되돌리지 않는다** — 반올림이 새 조정으로 읽힌다', () => {
    // 시스템 값 41.713 을 `41.7` 로 적어 놓으면 다음 확정에서
    // `problemsWith` 가 "시스템 값과 다르니 이유를 적으라" 고 막습니다.
    // 빈 칸은 원래 "시스템 값 그대로" 라는 뜻이고, 그 뜻이 맞습니다.
    const back = adjustmentsToRestore([saved()]);
    strictEqual(back.has(1), false);
    strictEqual(back.size, 0);
  });

  it('이유 없이 조정된 옛 기록은 빈 문자열로 — `null` 을 입력칸에 넣지 않는다', () => {
    const back = adjustmentsToRestore([saved({ final_value: 30, reason: null })]);
    strictEqual(back.get(1)?.reason, '');
  });

  it('⭐ 되돌린 값을 그대로 다시 보내면 조정이 **유지된다**', () => {
    // 이게 이 함수의 존재 이유입니다. 김민수가 자기 값만 고쳐도
    // 이하늘의 30 이 살아남아야 합니다.
    const system = new Map([
      [1, 41.713],
      [2, 33.552],
    ]);
    const back = adjustmentsToRestore([
      saved(),
      saved({ user_id: 2, system_value: 33.552, final_value: 30, reason: '문서 작업이 많았습니다' }),
    ]);
    // 화면이 되돌려 놓은 그대로 읽어 낸 초안
    const drafts: Draft[] = [1, 2].map((id) => ({
      user_id: id,
      final_value: back.get(id)?.final_value ?? null,
      reason: back.get(id)?.reason ?? '',
    }));
    deepStrictEqual(problemsWith(drafts, system), []);
    deepStrictEqual(toPayload(drafts, system), [
      { user_id: 1 },
      { user_id: 2, final_value: 30, reason: '문서 작업이 많았습니다' },
    ]);
  });

  it('⚠️ 되돌려 놓지 않으면 **말없이 지워진다** — 고치기 전 모습', () => {
    // 입력칸이 비어 있으면 `toPayload` 는 값을 안 싣고, 서버는 안 실린
    // 칸에 시스템 값을 씁니다. 30 과 이유가 33.552 로 되돌아갑니다.
    const system = new Map([[2, 33.552]]);
    const blank: Draft[] = [{ user_id: 2, final_value: null, reason: '' }];
    deepStrictEqual(toPayload(blank, system), [{ user_id: 2 }]);
  });
});
