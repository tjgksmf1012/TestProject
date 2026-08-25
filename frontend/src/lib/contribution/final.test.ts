import { deepStrictEqual, ok as ok2, strictEqual } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  adjustmentsToRestore,
  describeFinals,
  problemsWith,
  toPayload,
  firstGapOf,
  whyCannotConfirm,
  type Draft,
  type FinalRow,
  systemLabel,
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

  it('⭐ 몫이 될 수 없는 값은 막는다 — 음수도 100 초과도 (결함 215)', () => {
    // 베타에서 `-5 · -894 · 999` 를 넣었는데 **아무 경고가 없었습니다.**
    // 셋의 합이 정확히 100 이라 합계 경고까지 조용했습니다.
    for (const bad of [-5, -894, 999, 100.001]) {
      const problems = problemsWith([draft({ final_value: bad, reason: '실험' })], SYSTEM);
      strictEqual(problems.length, 1, `${bad} 이 통과했습니다`);
      strictEqual(problems[0]?.includes('0~100'), true);
    }
  });

  it('⚠️ 경계는 막지 않는다 — 한 사람이 전부 한 경우가 실제로 있다', () => {
    for (const okValue of [0, 100]) {
      deepStrictEqual(
        problemsWith([draft({ final_value: okValue, reason: '합의' })], SYSTEM),
        [],
        `${okValue} 가 막혔습니다`,
      );
    }
  });

  it('⛔ 합계가 100 이 아닌 것은 **여기서 막지 않는다** — 팀 일부만 확정할 수 있다', () => {
    // 범위 검사를 넣으면서 합계까지 막으면, 두 사람만 확정하려던 팀이
    // 갑자기 못 하게 됩니다. 합계는 화면이 경고만 합니다.
    deepStrictEqual(
      problemsWith(
        [
          draft({ final_value: 10, reason: '일부만' }),
          draft({ user_id: 2, final_value: 20, reason: '일부만' }),
        ],
        SYSTEM,
      ),
      [],
    );
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

describe('안 잰 사람은 「시스템 값 그대로」 확정할 수 없다 (결함 307)', () => {
  const draft = (userId: number, value: string, reason = ''): Draft => ({
    user_id: userId,
    final_value: value === '' ? null : Number(value),
    reason,
  });

  it('⭐ **확정 줄이 `0.0%` 라고 적지 않는다** — 카드는 같은 사람을 `—` 라고 그립니다', () => {
    /* 갓 만든 프로젝트에서 카드는 「— · 모르는 폭 100%p · 0 이라는 뜻이
       아니라 연결이 없다는 뜻입니다」인데, 여섯 줄 아래 확정 줄은
       「시스템 0.0%」였습니다. 한 화면이 같은 사실을 두고 서로 다른 말을
       하고 있었습니다. */
    strictEqual(systemLabel(0, false), '—');
    strictEqual(systemLabel(undefined, false), '—');
  });

  it('쟀으면 숫자를 그대로 적는다 — 결함 191 의 결정을 안 뒤집는다', () => {
    // 「쟀는데 0건」은 그대로 `0.0%` 입니다.
    strictEqual(systemLabel(0, true), '0.0%');
    strictEqual(systemLabel(31.25, true), '31.3%');
  });

  it('⭐ 안 잰 사람을 **빈 칸으로** 확정하려 하면 막고 이유를 말한다', () => {
    const problems = problemsWith([draft(7, '')], new Map([[7, 0]]), new Set([7]));
    strictEqual(problems.length, 1);
    strictEqual(problems[0]?.includes('잰 것이 없어'), true);
    strictEqual(problems[0]?.includes('직접 적고'), true);
  });

  it('⭐ 팀이 **직접 값을 적으면** 막지 않는다 — 시스템은 판정하지 않습니다(불변식 ④)', () => {
    const problems = problemsWith([draft(7, '0', '이번 스프린트는 휴학')], new Map([[7, 0]]), new Set([7]));
    strictEqual(problems.length, 0);
    // 값을 적었으면 「잰 것이 없어…」는 안 나옵니다.
    strictEqual(problems.some((t) => t.includes('잰 것이 없어')), false);
  });

  it('안 잰 사람이 아니면 빈 칸은 그대로 통과한다 — 「안 건드렸다」입니다', () => {
    strictEqual(problemsWith([draft(7, '')], new Map([[7, 12]]), new Set()).length, 0);
  });
});

describe('안 잰 사람이 직접 적은 값은 **접히지 않는다** (결함 307 회차)', () => {
  it('⭐ 시스템 값이 0 이라도 팀이 적은 0 은 그대로 실어 보낸다', () => {
    /* 고치면서 낸 것입니다. 안 잰 사람의 시스템 값은 0 으로 계산되므로
       팀이 일부러 0 을 적어도 `sameValue(0, 0)` 이 참이 되어 「안
       건드렸다」로 접혔고, 값이 안 실려 나가 서버가 400 을 줬습니다 —
       팀이 이유까지 적었는데도. 렌더해서 잡았습니다. */
    const drafts = [{ user_id: 7, final_value: 0, reason: '이번 스프린트는 휴학' }];
    const payload = toPayload(drafts, new Map([[7, 0]]), new Set([7]));
    strictEqual(payload[0]?.final_value, 0);
    strictEqual(payload[0]?.reason, '이번 스프린트는 휴학');
  });

  it('잰 사람은 그대로 — 시스템 값과 같으면 값을 안 보냅니다', () => {
    const drafts = [{ user_id: 7, final_value: 12, reason: '' }];
    const payload = toPayload(drafts, new Map([[7, 12]]), new Set());
    strictEqual(payload[0]?.final_value, undefined);
  });
});

describe('⛔ 빈 칸을 「시스템 값 그대로」로 확정할 수 있었습니다 (결함 372)', () => {
  /* v2 F1-4 — **확정값은 시스템이 아니라 팀이 적습니다.** 빈 칸은
     「아직 안 정함」이고, 다 정해야 확정이 열립니다. SPA 는 그 결정대로
     막고 있었는데 레거시는 게이트가 없어서, 손대지 않은 화면에서 한 번
     누르면 201 이 떨어지고 「시스템 값 그대로입니다」로 기록됐습니다. */

  const ok = { memberCount: 3, unfilled: 0, problems: [], blind: false };

  it('⭐ 빈 칸이 있으면 확정이 안 열린다', () => {
    strictEqual(whyCannotConfirm({ ...ok, unfilled: 3 }), '3칸 남음');
    strictEqual(whyCannotConfirm({ ...ok, unfilled: 1 }), '1칸 남음');
  });

  it('⭐ 다 적었고 문제가 없어야 열린다', () => {
    strictEqual(whyCannotConfirm(ok), null);
  });

  it('⭐ 막는 길마다 **다른** 말이 있다 — 하나도 빈 글자가 아니다', () => {
    const paths: Array<[string, Parameters<typeof whyCannotConfirm>[0]]> = [
      ['보내는 중', { ...ok, sending: true }],
      ['팀원 0명', { ...ok, memberCount: 0 }],
      ['빈 칸', { ...ok, unfilled: 2 }],
      ['합·안 잰 사람', { ...ok, problems: ['합이 100 이 아닙니다 (지금 90)'] }],
      ['저장된 확정을 못 읽음', { ...ok, blind: true }],
    ];
    /* ⚠️ 손으로 고른 목록은 **만들 때 있던 것만** 들어 있습니다(결함 329).
       그래서 소스에서 갈래 수를 세어 이 목록과 맞춥니다 — 여섯째 갈래를
       더하면 여기 한 줄을 쓰기 전까지 빨간불입니다(결함 351 의 방법). */
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'final.ts'),
      'utf8',
    );
    const body = src.slice(src.indexOf('export function confirmBlockOf'));
    const branches = body.slice(0, body.indexOf('return null')).match(/\breturn\b/g) ?? [];
    strictEqual(
      paths.length,
      branches.length,
      `막는 길이 ${branches.length} 인데 ${paths.length} 개만 재고 있습니다`,
    );

    const said = new Map<string, string>();
    for (const [name, gate] of paths) {
      const why = whyCannotConfirm(gate);
      ok2(why !== null && why.trim() !== '', `${name}: 막혔는데 아무 말도 안 합니다`);
      ok2(!said.has(why as string), `${name} 와 ${said.get(why as string)} 가 같은 말을 합니다`);
      said.set(why as string, name);
    }
  });

  it('⭐ 빈 칸이 **맨 앞**이다 — 안 적은 사람에게 「고쳐라」부터 시키지 않는다', () => {
    strictEqual(
      whyCannotConfirm({ ...ok, unfilled: 2, problems: ['합이 100 이 아닙니다'] }),
      '2칸 남음',
    );
  });

  /* 막힌 단추를 누르면 **할 일이 있는 자리로** 데려갑니다. 알려만 주고
     갈 곳이 없는 것이 이 저장소의 대표 실패 ③ 이고, 두 화면이 각자
     `find` 사슬을 짜면 그 순간 두 벌입니다. */
  const SYS = new Map([
    [1, 40],
    [2, 30],
    [3, 30],
  ]);

  it('⭐ 데려갈 자리는 **빈 값 칸이 먼저**다 — 막는 순서와 같다', () => {
    const drafts: Draft[] = [
      { user_id: 1, final_value: 55, reason: '' },
      { user_id: 2, final_value: null, reason: '' },
      { user_id: 3, final_value: 30, reason: '' },
    ];
    deepStrictEqual(firstGapOf(drafts, SYS, () => ''), { userId: 2, field: 'value' });
  });

  it('⭐ 값이 다 찼으면 **사유가 빈 조정**으로 데려간다', () => {
    const drafts: Draft[] = [
      { user_id: 1, final_value: 40, reason: '' },
      { user_id: 2, final_value: 45, reason: '' },
      { user_id: 3, final_value: 15, reason: '적었음' },
    ];
    deepStrictEqual(firstGapOf(drafts, SYS, (id) => drafts.find((d) => d.user_id === id)!.reason), {
      userId: 2,
      field: 'reason',
    });
  });

  it('⭐ 시스템 값 그대로면 사유를 안 물으니 데려갈 곳도 없다', () => {
    const drafts: Draft[] = [
      { user_id: 1, final_value: 40, reason: '' },
      { user_id: 2, final_value: 30, reason: '' },
      { user_id: 3, final_value: 30, reason: '' },
    ];
    strictEqual(firstGapOf(drafts, SYS, () => ''), null);
  });

  it('⭐ 「사유가 필요한가」를 두 자가 **같은 규칙**으로 본다', () => {
    /* ⚠️ `problemsWith`(무엇이 문제인가)와 `firstGapOf`(어디로 데려갈까)가
       갈라지면, 「이유를 적으라」고 해 놓고 엉뚱한 칸으로 데려갑니다. */
    for (const value of [40, 40.0000000001, 41, 0, 100]) {
      const draft: Draft = { user_id: 1, final_value: value, reason: '' };
      const complains = problemsWith([draft], SYS).some((p) => p.includes('이유를 적어야'));
      const leadsThere = firstGapOf([draft], SYS, () => '')?.field === 'reason';
      strictEqual(
        complains,
        leadsThere,
        `${value}: 문제는 ${complains} 인데 데려가기는 ${leadsThere} 입니다`,
      );
    }
  });
});
