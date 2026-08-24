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
  nothingMeasured,
  orderForDisplay,
  describeWidth,
  uncertaintyDots,
  uncertaintyDotsNote,
  uncertaintySpans,
  widthUnknown,
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

// 프로젝트를 막 만든 팀. 회의도 저장소도 아직 없습니다.
// 서버는 `categories: []` 에 `share/range_low/range_high` 를 전부 0 으로 줍니다
// (`adjustment_range` 의 폭이 `share` 에 비례하므로 0 에서는 0).
// ⚠️ 결함 226 의 검사도 이 사람을 씁니다 — describe 밖에 둡니다.
const 갓만든팀 = (userId: number): MemberScore => ({
  user_id: userId,
  role: 'developer',
  share: 0,
  range_low: 0,
  range_high: 0,
  confidence: 0,
  confidence_label: '매우 낮음',
  confidence_reasons: ['수집된 활동 데이터가 없습니다'],
  categories: [],
  integrity_flags: [],
  measurement_gaps: [],
});

describe('아무것도 안 잰 사람 (결함 191)', () => {
  // 활동 중인 팀에서 **이 사람만** 아직 아무것도 안 한 경우.
  // 팀에 살아 있는 범주가 있으므로 서버가 칸을 만들어 주고, 개수가 0 입니다.
  const 아직안한사람 = (userId: number): MemberScore => ({
    user_id: userId,
    role: 'developer',
    share: 0,
    range_low: 0,
    range_high: 0,
    confidence: 0.4,
    confidence_label: '낮음',
    confidence_reasons: [],
    categories: [
      { category: 'code', raw: 0, team_share: 0, weight: 1, event_count: 0, evidence_ids: [] },
    ],
    integrity_flags: [],
    measurement_gaps: [],
  });

  it('⭐ 잰 것이 없으면 `0%` 가 아니라 `—` 다 — 0% 는 가장 확신에 찬 단일 점수다', () => {
    strictEqual(nothingMeasured(갓만든팀(1)), true);
    strictEqual(describeRange(갓만든팀(1)), '—');
  });

  it('⭐ 쟀는데 0건인 것은 그대로 `0%` 다 — 이 둘을 같은 칸에 그리면 안 된다', () => {
    strictEqual(nothingMeasured(아직안한사람(2)), false);
    strictEqual(describeRange(아직안한사람(2)), '0%');
  });

  it('⭐ 잰 것이 없으면 모르는 폭은 0 이 아니라 **100**이다', () => {
    const [span] = uncertaintySpans([갓만든팀(1)]);
    strictEqual(span?.points, 100);
  });

  it('⛔ 쟀는데 0건이면 폭은 0 이 **아니라 `null`** 이다 (결함 226)', () => {
    // 191 이 절반만 고쳐져 있었습니다. 서버의 폭은 몫에 비례해서 접히므로
    // (`adjustment_range(0, c) == (0, 0)` — c 가 얼마든), 이 0 은 "확정"
    // 이 아니라 **계산이 접힌 것**입니다.
    const [span] = uncertaintySpans([아직안한사람(2)]);
    strictEqual(span?.points, null);
  });

  it('⚠️ `hasNoEvidence` 와 다르다 — 그쪽은 빈 배열도 참이라 "안 쟀다"를 못 묻는다', () => {
    strictEqual(hasNoEvidence(갓만든팀(1)), true);
    strictEqual(hasNoEvidence(아직안한사람(2)), true);
    // 같은 답을 주므로, **가르는 물음은 `nothingMeasured` 뿐**입니다.
    strictEqual(nothingMeasured(갓만든팀(1)) === nothingMeasured(아직안한사람(2)), false);
  });
});

describe('⛔ 신뢰도 「낮음」 옆에서 「확정적」이라고 말하던 것 (결함 226)', () => {
  // ## 재현
  //
  // 초대 코드로 이번 주에 막 들어온 사람. 팀에는 회의·업무·코드가 다 있어서
  // 서버가 칸 셋을 만들어 주고, 그 사람의 개수만 0 입니다. 서버의 폭은
  // **몫에 비례**하므로 `0.0 ~ 0.0`, 폭 0 — 신뢰도가 0.446 「낮음」 인데도.
  //
  //     0%
  //     신뢰도 낮음
  //     구간이 없습니다 — 이 값은 확정적입니다   ← 바로 윗줄과 정반대
  const 이번주에온사람 = (confidence: number): MemberScore => ({
    user_id: 7,
    role: 'developer',
    share: 0,
    range_low: 0,
    range_high: 0,
    confidence,
    confidence_label: confidence < LOW_CONFIDENCE ? '낮음' : '높음',
    confidence_reasons: ['GitHub 저장소가 연결되지 않았습니다'],
    categories: [
      { category: 'meeting', raw: 0, team_share: 0, weight: 0.4, event_count: 0, evidence_ids: [] },
      { category: 'task', raw: 0, team_share: 0, weight: 0.3, event_count: 0, evidence_ids: [] },
      { category: 'code', raw: 0, team_share: 0, weight: 0.3, event_count: 0, evidence_ids: [] },
    ],
    integrity_flags: [],
    measurement_gaps: [],
  });

  it('⭐ 화면이 지나는 길 전부를 통과시켜도 「확정적」이 안 나온다', () => {
    // ⚠️ 예전 검사는 `uncertaintyDotsNote(0)` 을 **직접** 불러서 통과했습니다.
    //    화면이 실제로 지나는 길은 `spans → points → note` 이고, 결함은
    //    그 사이에서 `null` 이 0 으로 접히는 데 있었습니다.
    const [span] = uncertaintySpans([이번주에온사람(0.446)]);
    // ⚠️ 검사가 `?? 0` 을 쓰면 **검사가 결함을 다시 만듭니다** — 실제로
    //    처음 이렇게 써서 「확정적」이 나왔습니다. 화면도 안 접습니다.
    strictEqual(span !== undefined, true);
    const note = uncertaintyDotsNote(span!.points);
    strictEqual(note.includes('확정'), true, note); // "확정이라는 뜻이 아닙니다"
    strictEqual(note.includes('확정적'), false, note);
  });

  it('⭐ 신뢰도 0.0 — "데이터가 없습니다" — 에서도 폭 0 을 말하지 않는다', () => {
    const [span] = uncertaintySpans([이번주에온사람(0)]);
    strictEqual(span?.points, null);
    strictEqual(describeWidth(span!.points), '?');
  });

  it('⭐ 신뢰도가 만점이면 폭 0 은 **진짜** 확정이다 — 그때는 그대로 말한다', () => {
    const [span] = uncertaintySpans([이번주에온사람(1)]);
    strictEqual(span?.points, 0);
    strictEqual(uncertaintyDotsNote(span!.points).includes('이 값은 확정적입니다'), true);
  });

  it('⭐ 잴 수 없는 폭은 **남의 막대를 길게 만들지 않는다**', () => {
    // `widest` 를 0 으로 세면 옆 사람의 ratio 가 그만큼 부풉니다.
    const 쟀고넓은사람: MemberScore = {
      ...이번주에온사람(0.446),
      user_id: 8,
      share: 30,
      range_low: 20,
      range_high: 40,
      categories: [
        { category: 'code', raw: 9, team_share: 1, weight: 1, event_count: 9, evidence_ids: [1] },
      ],
    };
    const spans = uncertaintySpans([이번주에온사람(0.446), 쟀고넓은사람]);
    strictEqual(spans[0]?.points, null);
    strictEqual(spans[0]?.ratio, 0);
    strictEqual(spans[1]?.points, 20);
    strictEqual(spans[1]?.ratio, 100);
  });

  it('⚠️ `nothingMeasured` 와 다른 물음이다 — 저쪽은 폭 100, 이쪽은 잴 수 없음', () => {
    strictEqual(widthUnknown(갓만든팀(1)), false);
    strictEqual(widthUnknown(이번주에온사람(0.446)), true);
    const [빈팀] = uncertaintySpans([갓만든팀(1)]);
    strictEqual(빈팀?.points, 100);
  });

  it('점은 지어내지 않는다 — 잴 수 없으면 0 개', () => {
    strictEqual(uncertaintyDots(null), 0);
  });
});

describe('⛔ 새 팀의 첫 화면이 「서로를 비교하지 마세요」라고 하던 것 (결함 228)', () => {
  // 프로젝트를 막 만들고 기여도를 열어 본 사람. 화면은 이랬습니다:
  //
  //   ⚠ 팀 전원의 신뢰도가 낮습니다. 이 수치로 서로를 비교하지 마세요
  //   김민수 · 개발 · — · 100%p 모름 · — 회의 · — 업무 · — 코드
  //
  // 비교할 「이 수치」가 한 개도 없고(전부 `—`), 혼자 만든 프로젝트에는
  // 「서로」도 없습니다.
  const 쟀고낮은사람 = (userId: number): MemberScore => ({
    ...갓만든팀(userId),
    confidence: 0.3,
    confidence_label: '낮음',
    categories: [
      { category: 'code', raw: 3, team_share: 1, weight: 1, event_count: 3, evidence_ids: [7] },
    ],
  });
  const team228 = (members: MemberScore[]): TeamScore => ({
    algo_version: 'v1',
    computed_at: '',
    members,
    skipped_categories: [],
    notice: '',
  });

  it('⭐ 아무도 안 재였으면 **원인**을 말한다 — 신뢰도는 그 그림자다', () => {
    const [line] = teamWarnings(team228([갓만든팀(1)]), PEOPLE);
    strictEqual(line?.includes('아직 이 팀에서 잰 활동이 없습니다'), true, String(line));
    // 있지도 않은 수치를 가리키지 않습니다.
    strictEqual(line?.includes('이 수치'), false, String(line));
    strictEqual(line?.includes('서로를 비교'), false, String(line));
  });

  it('⭐ 사람이 여럿이어도 같다 — 아무것도 안 이어진 팀은 비교할 게 없다', () => {
    const notes = teamWarnings(team228([갓만든팀(1), 갓만든팀(2), 갓만든팀(3)]), PEOPLE);
    strictEqual(notes.some((n) => n.includes('서로를 비교')), false, JSON.stringify(notes));
  });

  it('⛔ 혼자인데 신뢰도가 낮으면 「서로」라고 하지 않는다', () => {
    const [line] = teamWarnings(team228([쟀고낮은사람(1)]), PEOPLE);
    strictEqual(line?.includes('신뢰도가 낮습니다'), true, String(line));
    strictEqual(line?.includes('서로를 비교'), false, String(line));
  });

  it('⭐ 둘 이상이고 잰 것이 있으면 **예전 문장 그대로** — 그때는 맞는 말이다', () => {
    const notes = teamWarnings(team228([쟀고낮은사람(1), 쟀고낮은사람(2)]), PEOPLE);
    strictEqual(
      notes.some((n) => n.includes('팀 전원의 신뢰도가 낮습니다') && n.includes('서로를 비교하지 마세요')),
      true,
      JSON.stringify(notes),
    );
  });

  it('한 사람만 낮으면 아무 말도 안 한다 — 전원일 때만 팀의 문제다', () => {
    const 높은사람: MemberScore = { ...쟀고낮은사람(2), confidence: 0.9, confidence_label: '높음' };
    const notes = teamWarnings(team228([쟀고낮은사람(1), 높은사람]), PEOPLE);
    strictEqual(notes.some((n) => n.includes('신뢰도가 낮습니다')), false, JSON.stringify(notes));
  });
});

describe('떠난 사람의 기록 (결함 222)', () => {
  // ⚠️ **`PEOPLE` 에 없는 이름**을 씁니다. 예전에는 `박지원` 이었는데,
  //    그 이름은 지금 구성원(user_id 3)에도 있어서 결함 345 의 동명이인
  //    갈래로 떨어졌습니다 — 이 검사가 재려는 것은 「나간 사람도 이름으로
  //    부르는가」이지 동명이인이 아닙니다. 겹치는 경우는 아래에 따로 둡니다.
  const GONE: Person[] = [{ user_id: 9, name: '정우성', role_shares: { developer: 100 } }];

  it('⭐ 나간 사람이 목록에 있는 **이유를 말한다**', () => {
    // 그 사람의 기록은 계산에 그대로 들어갑니다 — 빼면 남은 사람들의 몫이
    // 조용히 부풀기 때문입니다. 말해 주지 않으면 "왜 나간 사람이 여기
    // 있지" 가 됩니다.
    const notes = teamWarnings(team({ former_members: GONE }), PEOPLE);
    const line = notes.find((n) => n.includes('떠났지만'));
    strictEqual(line !== undefined, true, '아무 말도 안 합니다');
    strictEqual(/정우성/.test(line as string), true, '이름을 안 부릅니다');
    strictEqual(/실제보다 커집니다/.test(line as string), true);
  });

  it('⛔ 옛 서버(칸이 없음)에서는 아무 말도 안 한다', () => {
    strictEqual(teamWarnings(team({}), PEOPLE).some((n) => n.includes('떠났지만')), false);
  });

  it('⭐ 나간 사람도 **이름으로** 부른다 — 「사용자 #9」 가 뜨면 안 된다', () => {
    // `people` 은 지금 구성원이라 나간 사람이 없습니다. 서버가 이름을
    // 같이 보내므로 두 명단을 합쳐 찾습니다.
    strictEqual(nameOf(9, PEOPLE), '사용자 #9');
    strictEqual(nameOf(9, PEOPLE, GONE), '정우성');
  });

  it('⭐ 나간 사람이 지금 구성원과 **이름이 같으면** 갈라 부른다 (결함 345)', () => {
    // 화면에는 둘이 **같이** 그려집니다. 지금 구성원끼리만 안 겹친다고
    // 안심하면, 나간 박지원과 남아 있는 박지원이 같은 줄로 읽힙니다.
    const 겹침: Person[] = [{ user_id: 9, name: '박지원', github_login: 'jiwon-old' }];
    strictEqual(nameOf(3, PEOPLE, 겹침), '박지원 · GitHub 미연결');
    strictEqual(nameOf(9, PEOPLE, 겹침), '박지원 · @jiwon-old');
  });

  it('아무 데도 없는 번호는 숨기지 않는다 — 번호라도 보여야 제보할 수 있다', () => {
    strictEqual(nameOf(404, PEOPLE, GONE), '사용자 #404');
  });
});
