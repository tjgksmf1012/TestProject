import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LOW_CONFIDENCE,
  categoriesForDisplay,
  describeCategory,
  describeRange,
  hasNoEvidence,
  integrityNotes,
  nameOf,
  orderForDisplay,
  uncertaintyDots,
  uncertaintyDotsNote,
  uncertaintySpans,
  readBeforeTheNumber,
  roleOf,
  teamWarnings,
  type Category,
  type MemberScore,
  type Person,
  type TeamScore,
} from './view.ts';

const PEOPLE: Person[] = [
  { user_id: 1, name: '김민수' },
  { user_id: 2, name: '이하늘' },
  { user_id: 3, name: '박지원' },
];

function category(over: Partial<Category> = {}): Category {
  return {
    category: 'code',
    raw: 100,
    team_share: 0.4,
    weight: 0.5,
    event_count: 3,
    evidence_ids: [1, 2, 3],
    ...over,
  };
}

function member(over: Partial<MemberScore> = {}): MemberScore {
  return {
    user_id: 1,
    role: 'developer',
    share: 40,
    range_low: 36,
    range_high: 44,
    confidence: 0.9,
    confidence_label: '높음',
    confidence_reasons: [],
    categories: [category()],
    integrity_flags: [],
    measurement_gaps: [],
    ...over,
  };
}

function team(over: Partial<TeamScore> = {}): TeamScore {
  return {
    algo_version: 'scoring-v1',
    computed_at: '2026-09-01T10:00:00Z',
    members: [member()],
    skipped_categories: [],
    notice: '참고값입니다',
    ...over,
  };
}

// ══════════════════════════════════════════════════════════════
// 순위를 만들지 않는다 (docs/07 E2)
// ══════════════════════════════════════════════════════════════

describe('orderForDisplay', () => {
  it('⭐ 점수 순으로 정렬하지 않는다', () => {
    // 리더보드 위젯을 안 만들어도, 목록이 점수 순이면 사람들은 1등과
    // 꼴찌를 읽는다. 금지된 건 위젯이 아니라 그 읽기다.
    const members = [
      member({ user_id: 3, share: 10 }), // 박지원
      member({ user_id: 1, share: 60 }), // 김민수
      member({ user_id: 2, share: 30 }), // 이하늘
    ];
    const ordered = orderForDisplay(members, PEOPLE);

    deepStrictEqual(ordered.map((m) => m.user_id), [1, 3, 2]); // 김민수·박지원·이하늘
    strictEqual(ordered[0]?.share === 60 && ordered[1]?.share === 10, true);
  });

  it('⭐ 순서가 매번 같다 — 자리가 바뀌면 그것도 변화로 읽힌다', () => {
    const members = [member({ user_id: 2 }), member({ user_id: 1 })];
    const first = orderForDisplay(members, PEOPLE).map((m) => m.user_id);
    const second = orderForDisplay([...members].reverse(), PEOPLE).map((m) => m.user_id);
    deepStrictEqual(first, second);
  });

  it('동명이인도 순서가 흔들리지 않는다', () => {
    const people: Person[] = [
      { user_id: 5, name: '김민수' },
      { user_id: 4, name: '김민수' },
    ];
    const ordered = orderForDisplay([member({ user_id: 5 }), member({ user_id: 4 })], people);
    deepStrictEqual(ordered.map((m) => m.user_id), [4, 5]);
  });

  it('원본 배열을 바꾸지 않는다', () => {
    const members = [member({ user_id: 2 }), member({ user_id: 1 })];
    orderForDisplay(members, PEOPLE);
    deepStrictEqual(members.map((m) => m.user_id), [2, 1]);
  });

  it('명단에 없는 사람도 사라지지 않는다', () => {
    const ordered = orderForDisplay([member({ user_id: 99 })], PEOPLE);
    strictEqual(ordered.length, 1);
    strictEqual(nameOf(99, PEOPLE), '사용자 #99');
  });
});

// ══════════════════════════════════════════════════════════════
// 단일 점수를 띄우지 않는다 (docs/05 §5)
// ══════════════════════════════════════════════════════════════

describe('describeRange', () => {
  it('⭐ 구간으로 말한다', () => {
    strictEqual(describeRange(member({ range_low: 18.2, range_high: 26.4 })), '18~26%');
  });

  it('구간이 좁아도 구간이다', () => {
    strictEqual(describeRange(member({ range_low: 39.6, range_high: 40.4 })), '40%');
  });
});

describe('uncertaintySpans', () => {
  it('⭐ 폭은 구간의 너비다 — 값이 아니라 **모르는 양**', () => {
    const spans = uncertaintySpans([
      member({ user_id: 1, range_low: 32, range_high: 52 }),
      member({ user_id: 2, range_low: 26, range_high: 41 }),
    ]);
    deepStrictEqual(spans.map((s) => s.points), [20, 15]);
  });

  it('⭐ 길이는 **팀에서 가장 넓은 구간** 기준이다', () => {
    // 0~100 을 쓰면 12%p 와 20%p 가 둘 다 짧은 막대가 되어 차이가 안 보입니다.
    const spans = uncertaintySpans([
      member({ user_id: 1, range_low: 32, range_high: 52 }),
      member({ user_id: 2, range_low: 19, range_high: 31 }),
    ]);
    deepStrictEqual(spans.map((s) => s.ratio), [100, 60]);
  });

  it('⚠️ 전원이 폭 0 이면 전부 0 이다 — 100 을 주면 정반대로 읽힌다', () => {
    // 폭 0 은 완전히 확정된 이상적인 경우입니다. "다 모른다" 가 아닙니다.
    const spans = uncertaintySpans([
      member({ user_id: 1, range_low: 40, range_high: 40 }),
      member({ user_id: 2, range_low: 20, range_high: 20 }),
    ]);
    deepStrictEqual(spans.map((s) => s.ratio), [0, 0]);
  });

  it('빈 팀은 빈 배열', () => {
    deepStrictEqual(uncertaintySpans([]), []);
  });

  it('⚠️ 뒤집힌 구간도 폭을 낸다 — 지운 `rangeBar` 가 알던 것', () => {
    const [only] = uncertaintySpans([member({ range_low: 50, range_high: 30 })]);
    strictEqual(only?.points, 20);
  });

  it('⚠️ 0~100 밖의 값은 잘라낸다 — 지운 `rangeBar` 가 알던 것', () => {
    const [only] = uncertaintySpans([member({ range_low: -5, range_high: 140 })]);
    strictEqual(only?.points, 100);
  });

  it('⚠️ 이 막대는 사람을 비교하지 않는다 — 가장 긴 쪽이 가장 모르는 쪽이다', () => {
    // 기여가 가장 적은 사람이 가장 긴 막대를 가질 수 있어야 합니다.
    const [small, big] = uncertaintySpans([
      member({ user_id: 1, range_low: 5, range_high: 45 }),   // 작은 값, 넓은 구간
      member({ user_id: 2, range_low: 60, range_high: 65 }),  // 큰 값, 좁은 구간
    ]);
    strictEqual(small?.ratio, 100);
    strictEqual(big?.ratio, 13);
  });
});

// ══════════════════════════════════════════════════════════════
// 측정 불가는 0점이 아니다 (docs/04 §2.6)
// ══════════════════════════════════════════════════════════════

describe('readBeforeTheNumber', () => {
  it('⭐ 측정 불가를 "0" 이라고 쓰지 않는다', () => {
    const lines = readBeforeTheNumber(
      member({
        measurement_gaps: [{ category: 'meeting', reason: '트랙 커버리지 42%' }],
      }),
    );

    strictEqual(lines.length, 1);
    strictEqual(lines[0]?.includes('측정하지 못했습니다'), true);
    strictEqual(lines[0]?.includes('회의'), true);
    strictEqual(/0 점|0점|말.*안 한|하지 않았/.test(lines[0] ?? ''), false);
  });

  it('⭐ 측정 불가가 신뢰도 사유보다 먼저 나온다', () => {
    // 이 숫자를 얼마나 믿을지 결정하는 가장 큰 요인이라 맨 앞이어야 한다.
    const lines = readBeforeTheNumber(
      member({
        confidence_reasons: ['GitHub 연동 기간이 짧습니다'],
        measurement_gaps: [{ category: 'meeting', reason: '폰이 잠김' }],
      }),
    );
    strictEqual(lines[0]?.includes('측정하지 못했습니다'), true);
    strictEqual(lines[1], 'GitHub 연동 기간이 짧습니다');
  });

  it('사유가 없어도 측정 불가 사실은 말한다', () => {
    const lines = readBeforeTheNumber(member({ measurement_gaps: [{}] }));
    strictEqual(lines.length, 1);
    strictEqual(lines[0]?.includes('측정하지 못했습니다'), true);
  });

  it('필드가 아예 없는 옛 응답에서도 터지지 않는다', () => {
    const old = member();
    delete (old as Partial<MemberScore>).measurement_gaps;
    deepStrictEqual(readBeforeTheNumber(old), []);
  });
});

// ══════════════════════════════════════════════════════════════
// 시스템은 판정하지 않는다 (docs/05 §5)
// ══════════════════════════════════════════════════════════════

describe('integrityNotes', () => {
  it('신호를 문장으로 보여준다', () => {
    const notes = integrityNotes(
      member({
        integrity_flags: [{ code: 'burst_commits', message: '마감 직전에 커밋이 몰렸습니다' }],
      }),
    );
    deepStrictEqual(notes, ['마감 직전에 커밋이 몰렸습니다']);
  });

  it('문구가 없으면 코드라도 보여준다 — 삼키지 않는다', () => {
    deepStrictEqual(integrityNotes(member({ integrity_flags: [{ code: 'unknown' }] })), [
      'unknown',
    ]);
  });

  it('빈 항목은 버린다', () => {
    deepStrictEqual(integrityNotes(member({ integrity_flags: [{}] })), []);
  });
});

// ══════════════════════════════════════════════════════════════
// 팀 전체 경고
// ══════════════════════════════════════════════════════════════

describe('teamWarnings', () => {
  it('정상이면 아무 말도 하지 않는다', () => {
    deepStrictEqual(teamWarnings(team(), PEOPLE), []);
  });

  it('⭐ 측정 불가는 개인 카드가 아니라 위에서도 말한다', () => {
    // 개인 카드에만 적으면 자기 것만 보고 넘어간다.
    const warnings = teamWarnings(
      team({
        members: [
          member({ user_id: 1, measurement_gaps: [{ category: 'meeting', reason: 'x' }] }),
          member({ user_id: 2 }),
        ],
      }),
      PEOPLE,
    );
    strictEqual(warnings.some((w) => w.includes('김민수')), true);
    strictEqual(warnings.some((w) => w.includes('이하늘')), false);
  });

  it('⭐ 전원의 신뢰도가 낮으면 비교하지 말라고 말한다', () => {
    const warnings = teamWarnings(
      team({
        members: [
          member({ user_id: 1, confidence: 0.3 }),
          member({ user_id: 2, confidence: 0.2 }),
        ],
      }),
      PEOPLE,
    );
    strictEqual(warnings.some((w) => w.includes('비교하지 마세요')), true);
  });

  it('한 사람만 낮으면 그 문구는 띄우지 않는다', () => {
    const warnings = teamWarnings(
      team({
        members: [
          member({ user_id: 1, confidence: 0.3 }),
          member({ user_id: 2, confidence: 0.9 }),
        ],
      }),
      PEOPLE,
    );
    strictEqual(warnings.some((w) => w.includes('비교하지 마세요')), false);
  });

  it('⭐ 빠진 카테고리를 **한글로** 말한다', () => {
    // 서버가 실제로 보내는 값이어야 한다. 라벨 표에 없는 값을 넣으면
    // `describeCategory` 가 그대로 돌려주므로, 예외도 경고도 없이
    // "schedule, peer 활동은 이번 계산에서 빠졌습니다" 가 찍힌다.
    const warnings = teamWarnings(
      team({ skipped_categories: ['schedule', 'peer'] }),
      PEOPLE,
    );
    const text = warnings.join(' ');
    strictEqual(text.includes('일정 준수'), true);
    strictEqual(text.includes('동료 평가'), true);
    strictEqual(/schedule|peer/.test(text), false, text);
  });

  it('⭐ 팀원이 0명이면 "전원 0점" 이 아니라 "기록이 없다" 다', () => {
    const warnings = teamWarnings(team({ members: [] }), PEOPLE);
    strictEqual(warnings.length, 1);
    strictEqual(warnings[0]?.includes('활동 기록이 없습니다'), true);
  });

  it('신뢰도 경계 바로 위는 낮음이 아니다', () => {
    const warnings = teamWarnings(
      team({ members: [member({ confidence: LOW_CONFIDENCE })] }),
      PEOPLE,
    );
    strictEqual(warnings.some((w) => w.includes('비교하지 마세요')), false);
  });
});

// ══════════════════════════════════════════════════════════════
// 근거
// ══════════════════════════════════════════════════════════════

describe('categoriesForDisplay', () => {
  it('⭐ 0 인 카테고리를 버리지 않는다', () => {
    // 빼 버리면 "이 사람은 동료 평가를 안 받았다" 가 화면에서 사라진다.
    // 그건 팀이 이야기해야 할 것이지 숨길 것이 아니다.
    const shown = categoriesForDisplay(
      member({
        categories: [
          category({ category: 'code', weight: 0.5, event_count: 3 }),
          category({ category: 'peer', weight: 0.3, event_count: 0, raw: 0 }),
        ],
      }),
    );
    strictEqual(shown.length, 2);
    strictEqual(shown.some((c) => c.category === 'peer'), true);
  });

  it('가중치가 큰 것부터 — 이 역할에서 무엇이 중요한가', () => {
    const shown = categoriesForDisplay(
      member({
        categories: [
          category({ category: 'code', weight: 0.2 }),
          category({ category: 'meeting', weight: 0.6 }),
        ],
      }),
    );
    deepStrictEqual(shown.map((c) => c.category), ['meeting', 'code']);
  });

  it('가중치가 같으면 이름 순 — 순서가 흔들리면 안 된다', () => {
    const shown = categoriesForDisplay(
      member({
        categories: [
          category({ category: 'schedule', weight: 0.5 }),
          category({ category: 'code', weight: 0.5 }),
        ],
      }),
    );
    deepStrictEqual(shown.map((c) => c.category), ['code', 'schedule']);
  });
});

describe('hasNoEvidence', () => {
  it('⭐ 근거가 하나도 없으면 화면이 그렇게 말해야 한다', () => {
    strictEqual(hasNoEvidence(member({ categories: [category({ event_count: 0 })] })), true);
  });

  it('하나라도 있으면 근거가 있는 것이다', () => {
    strictEqual(
      hasNoEvidence(
        member({
          categories: [category({ event_count: 0 }), category({ event_count: 1 })],
        }),
      ),
      false,
    );
  });

  it('카테고리가 아예 없어도 근거 없음이다', () => {
    strictEqual(hasNoEvidence(member({ categories: [] })), true);
  });
});

describe('describeCategory', () => {
  it('아는 것은 한국어로', () => {
    strictEqual(describeCategory('code'), '코드');
  });

  it('모르는 것은 그대로 — 삼키면 원인을 못 본다', () => {
    strictEqual(describeCategory('brand_new'), 'brand_new');
  });
});

describe('카드에 적을 역할', () => {
  it('⭐ 겸직이면 **둘 다** 보인다 — 서버의 `role` 은 주 역할 하나뿐이다', () => {
    const people = [{ user_id: 1, name: '김민수', role_shares: { developer: 0.4, planner: 0.6 } }];
    strictEqual(roleOf(member(), people), '기획 60% · 개발 40%');
  });

  it('⚠️ 동률이면 서버의 `max` 는 사전 순에 달린다 — 비중을 그대로 보여준다', () => {
    const people = [{ user_id: 1, name: '김민수', role_shares: { developer: 0.5, planner: 0.5 } }];
    const text = roleOf(member(), people);
    strictEqual(text.includes('개발 50%'), true);
    strictEqual(text.includes('기획 50%'), true);
  });

  it('단일 역할은 이름만', () => {
    const people = [{ user_id: 1, name: '김민수', role_shares: { planner: 1 } }];
    strictEqual(roleOf(member(), people), '기획');
  });

  it('⚠️ 비중을 모르면 서버가 준 것을 그대로 쓴다 — **지어내지 않는다**', () => {
    strictEqual(roleOf(member(), [{ user_id: 1, name: '김민수' }]), '개발');
    strictEqual(roleOf(member(), []), '개발');
  });

  it('⚠️ 모르는 역할은 **그대로** 둔다 — 지어낸 한국어보다 영어 식별자가 정직하다', () => {
    const people = [{ user_id: 1, name: '김민수', role_shares: { tester: 1 } }];
    strictEqual(roleOf(member(), people), 'tester');
  });

  it('0 인 역할은 안 보인다', () => {
    const people = [{ user_id: 1, name: '김민수', role_shares: { developer: 1, planner: 0 } }];
    strictEqual(roleOf(member(), people), '개발');
  });
});

// ══════════════════════════════════════════════════════════════
// 모르는 폭을 셀 수 있는 점으로 (docs/19 §25)
// ══════════════════════════════════════════════════════════════

describe('uncertaintyDots', () => {
  it('점 하나가 4%p 다', () => {
    strictEqual(uncertaintyDots(20), 5);
    strictEqual(uncertaintyDots(12), 3);
    strictEqual(uncertaintyDots(4), 1);
  });

  it('⭐ **0 으로 내림하지 않는다**', () => {
    // 폭이 1%p 라도 "모르는 게 있다" 는 사실입니다. 점이 0 개면 화면에서
    // 그것이 **완전히 확정** 으로 보이는데, 그건 다른 말입니다.
    strictEqual(uncertaintyDots(1), 1);
    strictEqual(uncertaintyDots(0.3), 1);
  });

  it('폭이 0 이면 점도 0 — 확정된 것에 점을 찍지 않는다', () => {
    strictEqual(uncertaintyDots(0), 0);
  });

  it('이상한 값에 점을 찍지 않는다', () => {
    strictEqual(uncertaintyDots(Number.NaN), 0);
    strictEqual(uncertaintyDots(-5), 0);
  });

  it('⭐ 구간은 0~100 이라 점이 스물다섯을 넘지 않는다', () => {
    // 넘으면 한 줄이 화면 밖으로 나가고, 그건 값이 아니라 고장으로 보입니다.
    strictEqual(uncertaintyDots(100), 25);
    strictEqual(uncertaintyDots(9999), 25);
  });

  it('⭐ 개수가 **절대량**이다 — 팀 구성에 따라 안 변한다', () => {
    // 예전 막대는 팀에서 가장 넓은 구간 대비 길이였습니다. 그러면 같은
    // 20%p 라도 팀에 따라 길이가 달라지고, 긴 막대가 "남보다 더 모른다"
    // 로 읽힙니다 — 그건 사람을 비교하는 그림입니다.
    strictEqual(uncertaintyDots(20), uncertaintyDots(20));
    strictEqual(uncertaintyDots(20) > uncertaintyDots(8), true);
  });
});

describe('uncertaintyDotsNote', () => {
  it('점 하나가 몇 %p 인지 말한다 — 안 말하면 셀 이유가 없다', () => {
    const note = uncertaintyDotsNote(20);
    strictEqual(note.includes('20%p'), true, note);
    strictEqual(note.includes('4%p'), true, note);
  });

  it('확정된 값에는 다른 말을 한다', () => {
    strictEqual(uncertaintyDotsNote(0).includes('확정적'), true);
  });
});
