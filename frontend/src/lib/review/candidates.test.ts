import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  approvalBlockers,
  attentionReasons,
  buildReviewPayload,
  canApprove,
  canSubmit,
  describeBlocker,
  effectiveDeadline,
  emptyDraft,
  isBeforeIsoDate,
  sortForReview,
  summarize,
  type Candidate,
  type Draft,
  type ReviewContext,
} from './candidates.ts';

const CONTEXT: ReviewContext = { memberIds: [1, 2, 3], today: '2026-09-01' };

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 10,
    title: '로그인 API 구현',
    assignee_id: 1,
    deadline: '2026-09-04',
    confidence: 0.94,
    evidence_utterance_ids: [101],
    review_status: 'pending',
    ...overrides,
  };
}

function drafts(...entries: Array<[number, Draft]>): Map<number, Draft> {
  return new Map(entries);
}

function codes(c: Candidate, d: Draft = emptyDraft()): string[] {
  return approvalBlockers(c, d, CONTEXT).map((b) => b.code);
}

// ══════════════════════════════════════════════════════════════
// 승인 차단 규칙 — 서버(meeting/approval.py)와 같아야 한다
// ══════════════════════════════════════════════════════════════

describe('approvalBlockers', () => {
  it('완전한 후보는 막히지 않는다', () => {
    assert.deepEqual(codes(candidate()), []);
    assert.equal(canApprove(candidate(), emptyDraft(), CONTEXT), true);
  });

  it('담당자가 없으면 막는다', () => {
    assert.deepEqual(codes(candidate({ assignee_id: null })), ['missing_assignee']);
  });

  it('마감일이 없으면 막는다', () => {
    assert.deepEqual(codes(candidate({ deadline: null })), ['missing_deadline']);
  });

  it('마감일이 과거면 막는다', () => {
    assert.deepEqual(codes(candidate({ deadline: '2026-08-31' })), ['deadline_in_past']);
  });

  it('오늘 마감은 허용한다', () => {
    assert.deepEqual(codes(candidate({ deadline: '2026-09-01' })), []);
  });

  it('팀원이 아닌 사람은 담당자가 될 수 없다', () => {
    assert.deepEqual(codes(candidate({ assignee_id: 99 })), ['unknown_assignee']);
  });

  it('⭐ 근거 발화가 없으면 막는다 — 환각일 수 있다', () => {
    // docs/04 §4.1: evidence_utterance_ids 가 비면 회의에 없던 내용이다.
    assert.deepEqual(codes(candidate({ evidence_utterance_ids: [] })), ['no_evidence']);
  });

  it('이미 처리된 후보는 다시 승인할 수 없다', () => {
    assert.deepEqual(codes(candidate({ review_status: 'approved' })), ['already_approved']);
    assert.deepEqual(codes(candidate({ review_status: 'rejected' })), ['already_rejected']);
  });

  it('여러 이유가 동시에 나온다 — 한 번에 다 고칠 수 있게', () => {
    assert.deepEqual(codes(candidate({ assignee_id: null, deadline: null })), [
      'missing_assignee',
      'missing_deadline',
    ]);
  });

  it('오버라이드로 막힌 이유를 해소할 수 있다', () => {
    const incomplete = candidate({ assignee_id: null, deadline: null });
    const fixed: Draft = {
      decision: 'approve',
      assigneeOverride: 2,
      deadlineOverride: '2026-09-10',
    };
    assert.deepEqual(codes(incomplete, fixed), []);
  });

  it('오버라이드로 오히려 막을 수도 있다', () => {
    const fixed: Draft = { decision: 'approve', assigneeOverride: 99 };
    assert.deepEqual(codes(candidate(), fixed), ['unknown_assignee']);
  });

  it('담당자를 명시적으로 null 로 지우면 막힌다', () => {
    // undefined(안 건드림)와 null(지움)은 다르다
    const cleared: Draft = { decision: 'approve', assigneeOverride: null };
    assert.deepEqual(codes(candidate(), cleared), ['missing_assignee']);
  });
});

describe('isBeforeIsoDate', () => {
  it('⭐ Date 를 거치지 않고 문자열로 비교한다', () => {
    // new Date('2026-09-04') 는 UTC 자정이라 한국에서 로컬 자정과 9시간
    // 어긋난다. 마감일 하루 차이는 "지났다/안 지났다"를 뒤집는다.
    assert.equal(isBeforeIsoDate('2026-08-31', '2026-09-01'), true);
    assert.equal(isBeforeIsoDate('2026-09-01', '2026-09-01'), false);
    assert.equal(isBeforeIsoDate('2026-09-02', '2026-09-01'), false);
  });

  it('연·월 경계에서도 맞다', () => {
    assert.equal(isBeforeIsoDate('2026-12-31', '2027-01-01'), true);
    assert.equal(isBeforeIsoDate('2026-09-09', '2026-09-10'), true);
  });
});

// ══════════════════════════════════════════════════════════════
// 제출 페이로드
// ══════════════════════════════════════════════════════════════

describe('buildReviewPayload', () => {
  it('결정한 것만 담는다', () => {
    const list = [candidate({ id: 1 }), candidate({ id: 2 }), candidate({ id: 3 })];
    const payload = buildReviewPayload(
      list,
      drafts([1, { decision: 'approve' }], [3, { decision: 'reject' }]),
      CONTEXT,
    );

    // ⭐ 검토자는 페이로드에 없다. 서버가 세션에서 읽는다 — 요청으로
    // 정할 수 있으면 남의 이름으로 승인 기록이 남는다.
    assert.equal('reviewer_id' in payload, false);
    assert.deepEqual(
      payload.items.map((i) => [i.candidate_id, i.approve]),
      [
        [1, true],
        [3, false],
      ],
    );
  });

  it('⭐ 안 바꾼 값은 override 로 보내지 않는다', () => {
    // 원본과 같은 값을 override 로 보내면 감사 로그에 "사람이 바꿨다"로
    // 남는다. 안 바꿨는데 바꿨다고 기록되면 분쟁의 근거가 뒤틀린다.
    const payload = buildReviewPayload(
      [candidate({ id: 1 })],
      drafts([
        1,
        {
          decision: 'approve',
          titleOverride: '로그인 API 구현', // 원본과 같음
          assigneeOverride: 1, // 원본과 같음
          deadlineOverride: '2026-09-04', // 원본과 같음
        },
      ]),
      CONTEXT,
    );

    assert.deepEqual(payload.items[0], { candidate_id: 1, approve: true });
  });

  it('실제로 바꾼 값만 override 로 나간다', () => {
    const payload = buildReviewPayload(
      [candidate({ id: 1 })],
      drafts([
        1,
        { decision: 'approve', assigneeOverride: 2, note: '민수가 더 적합' },
      ]),
      CONTEXT,
    );

    assert.deepEqual(payload.items[0], {
      candidate_id: 1,
      approve: true,
      assignee_override: 2,
      note: '민수가 더 적합',
    });
  });

  it('공백만 있는 메모는 보내지 않는다', () => {
    const payload = buildReviewPayload(
      [candidate({ id: 1 })],
      drafts([1, { decision: 'approve', note: '   ' }]),
      CONTEXT,
    );
    assert.equal('note' in payload.items[0]!, false);
  });

  it('⭐ 막힌 승인은 아예 보내지 않는다', () => {
    // 서버가 어차피 거절하지만, 실패 목록을 해석해 되돌리는 코드가
    // 필요 없어진다.
    assert.throws(
      () =>
        buildReviewPayload(
          [candidate({ id: 1, assignee_id: null })],
          drafts([1, { decision: 'approve' }]),
          CONTEXT,
        ),
      /담당자를 지정해야/,
    );
  });

  it('거절은 불완전해도 보낼 수 있다', () => {
    // "이건 업무가 아니다" 라는 판단은 담당자가 없어도 할 수 있어야 한다.
    const payload = buildReviewPayload(
      [candidate({ id: 1, assignee_id: null, deadline: null })],
      drafts([1, { decision: 'reject', note: '이미 완료된 일' }]),
      CONTEXT,
    );

    assert.deepEqual(payload.items[0], {
      candidate_id: 1,
      approve: false,
      note: '이미 완료된 일',
    });
  });

  it('아무것도 결정하지 않으면 던진다 — 서버가 빈 목록을 거부한다', () => {
    assert.throws(
      () => buildReviewPayload([candidate()], drafts(), CONTEXT),
      /결정한 후보가 없습니다/,
    );
  });

  it('제목만 바꿔도 반영된다', () => {
    const payload = buildReviewPayload(
      [candidate({ id: 1 })],
      drafts([1, { decision: 'approve', titleOverride: '  로그인 API + 소셜 로그인  ' }]),
      CONTEXT,
    );
    assert.equal(payload.items[0]!.title_override, '로그인 API + 소셜 로그인');
  });
});

// ══════════════════════════════════════════════════════════════
// 화면 보조
// ══════════════════════════════════════════════════════════════

describe('sortForReview', () => {
  it('⭐ 확신도가 낮은 것부터 보여준다', () => {
    // 사람의 주의력은 유한하고 위에서부터 본다. 확신도 높은 걸 위에 두면
    // 정작 봐야 할 항목이 스크롤 아래로 밀린다.
    const list = [
      candidate({ id: 1, confidence: 0.95 }),
      candidate({ id: 2, confidence: 0.42 }),
      candidate({ id: 3, confidence: 0.71 }),
    ];
    assert.deepEqual(
      sortForReview(list).map((c) => c.id),
      [2, 3, 1],
    );
  });

  it('확신도가 같으면 id 순으로 안정 정렬한다', () => {
    const list = [
      candidate({ id: 5, confidence: 0.5 }),
      candidate({ id: 2, confidence: 0.5 }),
    ];
    assert.deepEqual(
      sortForReview(list).map((c) => c.id),
      [2, 5],
    );
  });

  it('입력을 변형하지 않는다', () => {
    const list = [candidate({ id: 1, confidence: 0.9 }), candidate({ id: 2, confidence: 0.1 })];
    sortForReview(list);
    assert.equal(list[0]!.id, 1);
  });
});

describe('summarize', () => {
  it('결정 상태를 센다', () => {
    const list = [candidate({ id: 1 }), candidate({ id: 2 }), candidate({ id: 3 })];
    const summary = summarize(
      list,
      drafts([1, { decision: 'approve' }], [2, { decision: 'reject' }]),
      CONTEXT,
    );

    assert.equal(summary.total, 3);
    assert.equal(summary.approving, 1);
    assert.equal(summary.rejecting, 1);
    assert.equal(summary.pending, 1);
    assert.equal(summary.blocked, 0);
  });

  it('막힌 승인을 따로 센다', () => {
    const summary = summarize(
      [candidate({ id: 1, deadline: null })],
      drafts([1, { decision: 'approve' }]),
      CONTEXT,
    );
    assert.equal(summary.blocked, 1);
    assert.equal(canSubmit(summary), false);
  });

  it('확신도 낮은 미결정 후보를 세어 눈에 띄게 한다', () => {
    const list = [
      candidate({ id: 1, confidence: 0.42 }),
      candidate({ id: 2, confidence: 0.95 }),
    ];
    assert.equal(summarize(list, drafts(), CONTEXT).needsAttention, 1);
  });

  it('결정한 후보는 주의 대상에서 빠진다', () => {
    const list = [candidate({ id: 1, confidence: 0.42 })];
    const summary = summarize(list, drafts([1, { decision: 'reject' }]), CONTEXT);
    assert.equal(summary.needsAttention, 0);
  });
});

describe('canSubmit', () => {
  it('결정이 하나도 없으면 제출할 수 없다', () => {
    const summary = summarize([candidate()], drafts(), CONTEXT);
    assert.equal(canSubmit(summary), false);
  });

  it('결정이 있고 막힌 게 없으면 제출할 수 있다', () => {
    const summary = summarize([candidate()], drafts([10, { decision: 'approve' }]), CONTEXT);
    assert.equal(canSubmit(summary), true);
  });

  it('전부 거절이어도 제출할 수 있다', () => {
    const summary = summarize([candidate()], drafts([10, { decision: 'reject' }]), CONTEXT);
    assert.equal(canSubmit(summary), true);
  });
});

describe('effectiveDeadline', () => {
  it('건드리지 않으면 원본을 쓴다', () => {
    assert.equal(effectiveDeadline(candidate(), emptyDraft()), '2026-09-04');
  });

  it('null 오버라이드는 "지움"이지 "안 건드림"이 아니다', () => {
    assert.equal(effectiveDeadline(candidate(), { decision: 'approve', deadlineOverride: null }), null);
  });
});

// ══════════════════════════════════════════════════════════════
// 실제 흐름
// ══════════════════════════════════════════════════════════════

describe('실제 검토 시나리오', () => {
  it('⭐ 불완전한 후보를 고쳐 승인하는 전 과정', () => {
    // docs/04 §3: "담당자·마감일 없는 업무"는 규칙으로 표시되고,
    // 사람이 채워야 칸반에 올라간다.
    const list = [
      candidate({ id: 1, title: '통합 테스트 작성', assignee_id: null, deadline: null, confidence: 0.55 }),
      candidate({ id: 2, confidence: 0.94 }),
    ];

    // 1) 낮은 확신도부터 보인다
    assert.deepEqual(sortForReview(list).map((c) => c.id), [1, 2]);

    // 2) 처음엔 승인 못 한다
    assert.equal(canApprove(list[0]!, emptyDraft(), CONTEXT), false);

    // 3) 사람이 담당자와 마감일을 채운다
    const filled: Draft = {
      decision: 'approve',
      assigneeOverride: 3,
      deadlineOverride: '2026-09-15',
    };
    assert.equal(canApprove(list[0]!, filled, CONTEXT), true);

    // 4) 나머지 하나는 그대로 승인
    const state = drafts([1, filled], [2, { decision: 'approve' }]);
    const summary = summarize(list, state, CONTEXT);
    assert.equal(summary.blocked, 0);
    assert.equal(canSubmit(summary), true);

    // 5) 채운 값만 override 로 나간다
    const payload = buildReviewPayload(list, state, CONTEXT);
    assert.deepEqual(payload.items, [
      { candidate_id: 1, approve: true, assignee_override: 3, deadline_override: '2026-09-15' },
      { candidate_id: 2, approve: true },
    ]);
  });

  it('근거 없는 후보는 고쳐도 승인할 수 없다', () => {
    // 담당자·마감일을 채워도 근거가 없으면 여전히 막힌다.
    // 환각을 사람이 "고쳐서" 통과시키는 경로를 만들면 안 된다.
    const hallucinated = candidate({ id: 1, evidence_utterance_ids: [] });
    const filled: Draft = {
      decision: 'approve',
      assigneeOverride: 2,
      deadlineOverride: '2026-09-15',
    };
    assert.deepEqual(codes(hallucinated, filled), ['no_evidence']);
  });
});

describe('describeBlocker', () => {
  it('서버가 준 코드를 문구로 옮긴다', () => {
    // 서버는 코드만 돌려준다 (meeting/approval.ApprovalError).
    assert.equal(describeBlocker('no_evidence'), '근거 발화가 없습니다 — 회의에 없던 내용일 수 있습니다');
    assert.equal(describeBlocker('missing_assignee'), '담당자를 지정해야 승인할 수 있습니다');
  });

  it('모르는 코드는 삼키지 않고 그대로 보여준다', () => {
    // 삼키면 사용자가 원인을 영영 못 본다.
    assert.equal(describeBlocker('some_new_rule'), 'some_new_rule');
  });
});

// ══════════════════════════════════════════════════════════════
// 왜 이 후보를 봐야 하는가 — 서버 경고
// ══════════════════════════════════════════════════════════════
//
// 이 경고는 서버가 만들어 DB 에 저장한다. 오래도록 저장 단계에서 통째로
// 버려지고 있었고, 그동안 화면은 확신도 숫자만 보여줬다. 숫자만 보면
// 사람은 무엇을 확인해야 할지 모른 채 그냥 승인한다.

describe('attentionReasons', () => {
  it('서버가 준 이유를 그대로 보여준다', () => {
    const reasons = attentionReasons(
      candidate({ warnings: ['담당자 미확정 — 이름이 두 명과 일치'] }),
    );
    assert.deepEqual(reasons, ['담당자 미확정 — 이름이 두 명과 일치']);
  });

  it('여러 개면 전부 보여준다 — 하나만 고치고 넘어가면 안 된다', () => {
    const reasons = attentionReasons(
      candidate({ warnings: ['담당자 미확정', '마감일이 회의일보다 이전입니다'] }),
    );
    assert.equal(reasons.length, 2);
  });

  it('확신도가 높고 경고가 없으면 아무 말도 하지 않는다', () => {
    assert.deepEqual(attentionReasons(candidate({ confidence: 0.94 })), []);
  });

  it('⭐ 경고가 없는데 확신도만 낮으면 빈손으로 두지 않는다', () => {
    // 설명 없이 빨간 표시만 뜨면 사람은 그냥 무시하게 된다.
    const reasons = attentionReasons(candidate({ confidence: 0.34, warnings: [] }));
    assert.equal(reasons.length, 1);
    assert.ok(reasons[0]?.includes('34%'));
  });

  it('경고가 있으면 확신도 문구를 덧붙이지 않는다', () => {
    // 이미 구체적인 이유가 있는데 "확신도가 낮습니다" 를 더하면 잡음이다.
    const reasons = attentionReasons(candidate({ confidence: 0.2, warnings: ['담당자 미확정'] }));
    assert.deepEqual(reasons, ['담당자 미확정']);
  });

  it('⭐ warnings 가 없는 옛 데이터에서도 터지지 않는다', () => {
    // 이 컬럼이 생기기 전에 저장된 후보는 필드 자체가 없다.
    const old = candidate();
    delete (old as Partial<Candidate>).warnings;
    assert.deepEqual(attentionReasons(old), []);
  });

  it('원본을 건드리지 않는다', () => {
    const c = candidate({ confidence: 0.3, warnings: ['담당자 미확정'] });
    attentionReasons(c);
    assert.deepEqual(c.warnings, ['담당자 미확정']);
  });
});

describe('assignee_hint', () => {
  it('⭐ 담당자가 안 풀린 후보는 회의에서 부른 이름을 들고 있다', () => {
    // 이게 없으면 사람은 빈 담당자 칸만 보고 누구를 골라야 할지 모른다.
    const c = candidate({ assignee_id: null, assignee_hint: '민수님' });
    assert.equal(c.assignee_hint, '민수님');
    assert.ok(codes(c).includes('missing_assignee'));
  });

  it('원문이 있어도 승인 판정에는 쓰이지 않는다', () => {
    // 이름이 불렸다는 것과 그게 누구인지 아는 것은 다르다.
    // 원문만 보고 승인을 열어 주면 엉뚱한 사람에게 업무가 붙는다.
    const c = candidate({ assignee_id: null, assignee_hint: '민수님' });
    assert.equal(canApprove(c, emptyDraft(), CONTEXT), false);
  });
});
