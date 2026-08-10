import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  emptyMembersNote,
  measureState,
  panelHeading,
  panelMembers,
  unmeasurableNote,
  type Member,
} from './panel.ts';
import { describeRoles, roleSummary } from '../contribution/roles.ts';

function member(over: Partial<Member> = {}): Member {
  return {
    user_id: 1,
    name: '김민수',
    role_shares: { backend: 1 },
    github_login: 'minsu-dev',
    ...over,
  };
}

// ══════════════════════════════════════════════════════════════
// 잴 수 있는가 — **못 재는 것은 나쁜 것이 아니다**
// ══════════════════════════════════════════════════════════════

describe('measureState', () => {
  it('GitHub 아이디가 있으면 잴 수 있다', () => {
    strictEqual(measureState('minsu-dev'), 'measured');
  });

  it('⭐ 없으면 `unmeasurable` — `bad` 라는 값은 아예 없다', () => {
    // 못 재는 것은 그 사람이 일을 안 한 게 아닙니다 (docs/05 §5).
    for (const nothing of [null, undefined, '', '   ']) {
      strictEqual(measureState(nothing), 'unmeasurable');
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 줄 만들기
// ══════════════════════════════════════════════════════════════

describe('panelMembers', () => {
  it('⚠️ 서버가 준 순서를 바꾸지 않는다 — 정렬은 줄 세우기다', () => {
    const rows = panelMembers([
      member({ user_id: 3, name: '박지원' }),
      member({ user_id: 1, name: '김민수' }),
      member({ user_id: 2, name: '이하늘' }),
    ]);
    deepStrictEqual(rows.map((r) => r.userId), [3, 1, 2]);
  });

  it('역할이 없으면 그 줄을 안 그린다 (null)', () => {
    const [row] = panelMembers([member({ role_shares: {} })]);
    strictEqual(row?.roles, null);
  });

  it('⭐ 역할 이름표를 여기서 새로 짓지 않고 roles.ts 에서 가져온다', () => {
    // 두 벌이 되면 `ROLE_OPTIONS` 에 항목이 늘었을 때 한쪽만 고쳐집니다.
    const shares = { backend: 0.6, frontend: 0.4 };
    const [row] = panelMembers([member({ role_shares: shares })]);
    strictEqual(row?.roles, roleSummary(shares));
  });

  it('못 재는 사람에게만 이유가 붙는다', () => {
    const [linked] = panelMembers([member({ github_login: 'minsu-dev' })]);
    strictEqual(linked?.note, null);

    const [loose] = panelMembers([member({ github_login: null })]);
    ok(loose?.note?.includes('GitHub'), String(loose?.note));
  });

  it('⭐ 눈으로만 읽히는 점을 낭독기용 글로도 남긴다', () => {
    const [row] = panelMembers([
      member({ name: '박지원', role_shares: { design: 1 }, github_login: null }),
    ]);
    ok(row);
    ok(row.ariaLabel.includes('박지원'), row.ariaLabel);
    ok(row.ariaLabel.includes('GitHub'), row.ariaLabel);
  });

  it('역할도 GitHub 도 없으면 이름만 읽는다 — 빈 쉼표를 만들지 않는다', () => {
    const [row] = panelMembers([
      member({ name: '이하늘', role_shares: {}, github_login: 'haneul' }),
    ]);
    strictEqual(row?.ariaLabel, '이하늘');
  });

  it('빈 목록은 빈 목록이다', () => {
    deepStrictEqual(panelMembers([]), []);
  });
});

// ══════════════════════════════════════════════════════════════
// 아래에 붙는 한 줄
// ══════════════════════════════════════════════════════════════

describe('unmeasurableNote', () => {
  it('전원 연결됐으면 아무 말도 하지 않는다 (null)', () => {
    strictEqual(unmeasurableNote(panelMembers([member(), member({ user_id: 2 })])), null);
  });

  it('⭐ 못 재는 사람 **수만** 말하고 이름은 나열하지 않는다', () => {
    // 이름을 늘어놓으면 그건 "누가 부족한가" 의 목록으로 읽힙니다.
    const rows = panelMembers([
      member({ user_id: 1, name: '김민수', github_login: 'minsu-dev' }),
      member({ user_id: 2, name: '이하늘', github_login: null }),
      member({ user_id: 3, name: '박지원', github_login: '' }),
    ]);
    const note = unmeasurableNote(rows);
    ok(note?.includes('2명'), String(note));
    ok(!note?.includes('이하늘'), String(note));
    ok(!note?.includes('박지원'), String(note));
  });

  it('무엇을 하면 되는지까지 말한다', () => {
    const note = unmeasurableNote(panelMembers([member({ github_login: null })]));
    ok(/설정/.test(String(note)), String(note));
  });
});

describe('panelHeading', () => {
  it('숫자를 배지가 아니라 글자로 말한다', () => {
    strictEqual(panelHeading(3), '팀원 3명');
  });
});

describe('emptyMembersNote', () => {
  it('⭐ 0명을 "혼자입니다" 가 아니라 "못 불러왔습니다" 로 읽는다', () => {
    // 프로젝트에는 최소한 만든 사람이 있습니다.
    ok(/불러오지 못했습니다/.test(emptyMembersNote()), emptyMembersNote());
  });
});

// ══════════════════════════════════════════════════════════════
// 갈라 놓은 두 함수가 여전히 같은 것을 말하는가
// ══════════════════════════════════════════════════════════════

describe('roleSummary ↔ describeRoles', () => {
  it('⭐ 역할이 있으면 둘이 같은 글자를 준다', () => {
    const shares = { backend: 0.7, design: 0.3 };
    strictEqual(describeRoles(shares), roleSummary(shares));
  });

  it('역할이 없을 때만 갈라진다 — 문장 대 null', () => {
    strictEqual(roleSummary({}), null);
    strictEqual(describeRoles({}), '역할이 정해지지 않았습니다.');
  });
});
