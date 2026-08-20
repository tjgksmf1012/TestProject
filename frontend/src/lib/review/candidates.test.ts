import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  approvalBlockers,
  approvalConditions,
  canUndoDecision,
  attentionReasons,
  blockerLine,
  buildReviewPayload,
  canApprove,
  canSubmit,
  describeBlocker,
  describeSubmitResult,
  effectiveDeadline,
  emptyDraft,
  isBeforeIsoDate,
  laneCounts,
  reviewLane,
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

  it('화면이 만들지 않고 서버만 내는 코드도 한국어로 옮긴다 (결함 86)', () => {
    // 이 둘은 `approvalBlockers` 가 절대 만들지 않는다. 그래서 화면 사전에
    // 빠져 있었고, 목록이 낡은 채로 승인을 누르면 사람이 화면에서
    // `#999 unknown_candidate` 를 읽었다 — 한국어 화면에 내부 이름이다.
    for (const code of ['unknown_candidate', 'no_reviewer']) {
      assert.notEqual(describeBlocker(code), code, `${code} 가 그대로 나옵니다`);
    }
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

describe('제출 결과 문구 (결함 85)', () => {
  it('⭐ 등록이 0건이면 빈 꼬리표를 남기지 않는다', () => {
    // 예전에는 `0건이 칸반에 등록됐습니다 (task )` 였습니다 — 괄호 안이
    // 비어 사람은 앱이 뭔가 잃어버렸다고 읽습니다 (결함 58 과 같은 부류).
    const text = describeSubmitResult(0, []);
    assert.equal(text.includes('(task'), false, text);
    assert.equal(text.includes('()'), false, text);
    assert.equal(text.includes('반영'), true, text);
  });

  it('⭐ 거절을 실패라고 하지 않는다', () => {
    // 후보 셋을 읽고 셋 다 거절한 것은 **정상적인 결정**입니다.
    const text = describeSubmitResult(0, []);
    assert.equal(/실패|오류|잘못/.test(text), false, text);
  });

  it('등록된 것이 있으면 번호를 말한다', () => {
    assert.equal(describeSubmitResult(2, [7, 9]), '2건이 칸반에 등록됐습니다 (task 7, 9)');
  });

  it('⭐ 번호가 안 왔으면 지어내지 않고 건수만 말한다', () => {
    assert.equal(describeSubmitResult(2, []), '2건이 칸반에 등록됐습니다');
    assert.equal(describeSubmitResult(1, [Number.NaN]), '1건이 칸반에 등록됐습니다');
  });
});

// ══════════════════════════════════════════════════════════════
// 갈래와 한 줄 검사 (디자인 브리프 §8·§13)
// ══════════════════════════════════════════════════════════════

describe('reviewLane', () => {
  it('⭐ 이미 승인된 후보를 `검토 필요` 로 세지 않는다', () => {
    // ⚠️ `summarize` 는 초안만 봅니다. 결정이 끝난 후보의 초안은
    // `pending` 이라, 그 숫자로 탭을 그리면 **이미 끝난 일이 할 일로**
    // 올라옵니다. 사람은 그걸 보고 남은 검토가 있다고 읽습니다.
    const approved = candidate({ review_status: 'approved' });
    assert.equal(summarize([approved], drafts(), CONTEXT).pending, 1);
    assert.equal(reviewLane(approved, emptyDraft()), 'approve');
  });

  it('거절된 후보도 마찬가지다', () => {
    assert.equal(reviewLane(candidate({ review_status: 'rejected' }), emptyDraft()), 'reject');
  });

  it('아직 안 정해졌으면 초안이 갈래를 정한다', () => {
    const c = candidate();
    assert.equal(reviewLane(c, emptyDraft()), 'pending');
    assert.equal(reviewLane(c, { ...emptyDraft(), decision: 'approve' }), 'approve');
    assert.equal(reviewLane(c, { ...emptyDraft(), decision: 'reject' }), 'reject');
  });

  it('⭐ 서버가 내린 결정이 초안보다 세다', () => {
    // 이미 승인된 후보에는 결정 버튼이 없습니다. 그래도 초안이 어쩌다
    // `reject` 로 남아 있으면 화면과 서버가 다른 말을 하게 됩니다.
    const approved = candidate({ review_status: 'approved' });
    assert.equal(reviewLane(approved, { ...emptyDraft(), decision: 'reject' }), 'approve');
  });
});

describe('laneCounts', () => {
  it('갈래마다 세고 0 도 적는다', () => {
    const counts = laneCounts(
      [candidate({ id: 1 }), candidate({ id: 2 }), candidate({ id: 3, review_status: 'approved' })],
      drafts([2, { ...emptyDraft(), decision: 'reject' }]),
    );
    assert.deepEqual(counts, { all: 3, pending: 1, approve: 1, reject: 1 });
  });

  it('⭐ 갈래 합이 전체와 같다 — 어느 탭에도 없는 후보가 생기면 안 된다', () => {
    const list = [
      candidate({ id: 1 }),
      candidate({ id: 2, review_status: 'approved' }),
      candidate({ id: 3, review_status: 'rejected' }),
      candidate({ id: 4 }),
    ];
    const counts = laneCounts(list, drafts([4, { ...emptyDraft(), decision: 'approve' }]));
    assert.equal(counts.pending + counts.approve + counts.reject, counts.all);
  });
});

describe('blockerLine (브리프 §13)', () => {
  const line = (c: Candidate, d: Draft = emptyDraft()) =>
    blockerLine(approvalBlockers(c, d, CONTEXT));

  it('막는 것이 없으면 아무 말도 하지 않는다', () => {
    assert.deepEqual(line(candidate()), { tone: 'none', text: '' });
  });

  it('⭐ 안 채운 칸은 **빨강이 아니다**', () => {
    // 담당자가 비어 있는 것은 잘못이 아니라 아직 안 한 일입니다.
    // 회의에 없던 내용(`no_evidence`)과 같은 색으로 칠하면, 진짜 문제가
    // 있는 후보와 그냥 손이 안 간 후보를 구분할 수 없습니다.
    const result = line(candidate({ assignee_id: null, deadline: null }));
    assert.equal(result.tone, 'missing');
  });

  it('⭐ 안 채운 칸 둘이 한 줄로 합쳐진다', () => {
    const result = line(candidate({ assignee_id: null, deadline: null }));
    assert.equal(result.text, '담당자 · 마감일을 지정해야 등록할 수 있습니다');
    assert.equal(result.text.split('\n').length, 1);
  });

  it('⭐ 조사가 낱말에 맞는다 — `담당자을` 이 되지 않는다', () => {
    // `withJosa` 를 안 쓰면 받침 없는 낱말에 `을` 이 붙습니다.
    assert.equal(line(candidate({ assignee_id: null })).text, '담당자를 지정해야 등록할 수 있습니다');
    assert.equal(line(candidate({ deadline: null })).text, '마감일을 지정해야 등록할 수 있습니다');
  });

  it('⭐ 진짜 잘못은 빨강이고, 안 채운 칸보다 앞에 온다', () => {
    const result = line(candidate({ evidence_utterance_ids: [], assignee_id: null }));
    assert.equal(result.tone, 'error');
    assert.equal(result.text.startsWith('근거 발화가 없습니다'), true, result.text);
    assert.equal(result.text.includes('담당자를 지정해야'), true, result.text);
  });

  it('⭐ 안 채운 칸을 삼키지 않는다', () => {
    // 빨강이 이긴다고 해서 나머지를 지우면, 사람이 근거를 고친 뒤에
    // **또 막히는 이유**를 그때 처음 봅니다.
    const result = line(candidate({ evidence_utterance_ids: [], assignee_id: null, deadline: null }));
    assert.equal(result.text.includes('담당자 · 마감일을'), true, result.text);
  });

  it('과거 마감일은 안 채운 칸이 아니라 잘못이다', () => {
    assert.equal(line(candidate({ deadline: '2020-01-01' })).tone, 'error');
  });
});

describe('승인 조건 칩은 막는 목록에서 나온다 (결함 193)', () => {
  const 오늘 = '2026-08-19';
  const ctx: ReviewContext = { memberIds: [1, 2, 3], today: 오늘 };
  const base = (over: Partial<Candidate> = {}): Candidate => ({
    id: 1,
    title: '배포 방식 결정',
    assignee_id: null,
    assignee_hint: null,
    deadline: null,
    confidence: 0.34,
    review_status: 'pending',
    evidence_utterance_ids: [5],
    ...over,
  } as Candidate);

  it('⭐ 마감이 **지난 날짜**면 칩이 `○` 다 — 예전에는 `●` 인데 버튼만 막혔다', () => {
    const c = base({ assignee_id: 2, deadline: '2026-08-10' });
    const conds = approvalConditions(c, emptyDraft(), ctx);
    const 마감 = conds.find((x) => x.label.startsWith('마감'));
    assert.strictEqual(마감?.met, false);
    assert.strictEqual(마감?.label, '마감 지남', '왜 안 되는지 칩이 말해야 한다');
  });

  it('⭐ 칩이 전부 `●` 인데 막히는 상태가 **있을 수 없다**', () => {
    // 같은 목록에서 나오므로 구조적으로 불가능합니다. 여러 모양으로 확인합니다.
    const cases: Candidate[] = [
      base(),
      base({ assignee_id: 2 }),
      base({ assignee_id: 2, deadline: '2026-08-10' }),
      base({ assignee_id: 2, deadline: '2026-09-10' }),
      base({ assignee_id: 99, deadline: '2026-09-10' }),
      base({ evidence_utterance_ids: [], assignee_id: 2, deadline: '2026-09-10' }),
      base({ assignee_id: 2, deadline: '2026-09-10', review_status: 'approved' }),
    ];
    for (const c of cases) {
      const blocked = approvalBlockers(c, emptyDraft(), ctx).length > 0;
      const allMet = approvalConditions(c, emptyDraft(), ctx).every((x) => x.met);
      assert.strictEqual(
        allMet,
        !blocked,
        `칩과 버튼이 갈라졌습니다: ${JSON.stringify(c)}`,
      );
    }
  });

  it('칩 셋으로 설명 안 되는 이유는 **칩을 하나 더** 단다', () => {
    const c = base({ assignee_id: 2, deadline: '2026-09-10', review_status: 'approved' });
    const conds = approvalConditions(c, emptyDraft(), ctx);
    assert.strictEqual(conds.length, 4);
    assert.strictEqual(conds[3]?.met, false);
    assert.strictEqual(conds[3]?.label, '이미 승인된 후보입니다');
  });

  it('다 채우면 전부 `●` 다', () => {
    const c = base({ assignee_id: 2, deadline: '2026-09-10' });
    assert.strictEqual(approvalConditions(c, emptyDraft(), ctx).every((x) => x.met), true);
  });
});

describe('되돌리기는 되돌릴 수 있을 때만 (결함 194)', () => {
  const ctx: ReviewContext = { memberIds: [1, 2, 3], today: '2026-08-19' };
  void ctx;
  const c = (status: string): Candidate =>
    ({
      id: 1, title: 'x', assignee_id: null, assignee_hint: null, deadline: null,
      confidence: 0.5, review_status: status, evidence_utterance_ids: [1],
    }) as Candidate;

  it('⭐ 아직 아무것도 안 정했으면 되돌릴 것이 없다 — 눌러도 아무 일도 안 일어났다', () => {
    assert.strictEqual(canUndoDecision(c('pending'), emptyDraft()), false);
  });

  it('⭐ 등록·거절을 눌렀으면 되돌릴 수 있다', () => {
    assert.strictEqual(canUndoDecision(c('pending'), { decision: 'approve' }), true);
    assert.strictEqual(canUndoDecision(c('pending'), { decision: 'reject' }), true);
  });

  it('⚠️ 서버가 이미 정한 것은 화면에서 못 되돌린다 — 초안만 바꾸면 또 아무 일도 안 일어난다', () => {
    assert.strictEqual(canUndoDecision(c('approved'), { decision: 'pending' }), false);
    assert.strictEqual(canUndoDecision(c('rejected'), { decision: 'approve' }), false);
  });
});

describe('⛔ 둘이 동시에 검토하면 뒤에 누른 사람이 속았습니다 (결함 233)', () => {
  // ## 재현
  //
  // 브라우저 둘로 같은 회의의 검토 화면을 열었습니다.
  //   A 가 후보 셋을 승인 표시하고 「검토 끝내기」 → 200, approved_count 3
  //   B 는 낡은 화면 그대로. 같은 셋을 표시하고 「검토 끝내기」
  //     → 200 {"approved_task_ids":[],"approved_count":0}
  //
  // 서버는 멱등이라 정직하게 0건이라고 답했는데, B 의 화면은 A 와
  // **글자 하나 다르지 않았습니다.**
  it('⛔ 승인을 표시했는데 0건이면 **그렇게 말한다** — 거절과 같은 말을 하지 않는다', () => {
    const 남이먼저 = describeSubmitResult(0, [], 3);
    const 전부거절 = describeSubmitResult(0, [], 0);
    assert.equal(남이먼저 === 전부거절, false, '두 결과가 같은 문장입니다');
    assert.equal(남이먼저.includes('3건'), true, 남이먼저);
    assert.equal(남이먼저.includes('새로고침'), true, 남이먼저);
  });

  it('⭐ 전부 거절해서 0건인 것은 **실패가 아니다** — 그대로 둔다', () => {
    assert.equal(describeSubmitResult(0, [], 0), '검토를 반영했습니다 — 칸반에 등록된 업무는 없습니다');
  });

  it('⭐ 일부만 들어간 것도 말한다 — 표시한 3건 중 1건만 등록', () => {
    const note = describeSubmitResult(1, [5], 3);
    assert.equal(note.includes('1건이 칸반에'), true, note);
    assert.equal(note.includes('2건은 등록되지 않았습니다'), true, note);
  });

  it('⭐ 표시한 만큼 다 들어갔으면 **군말을 안 붙인다**', () => {
    const note = describeSubmitResult(3, [5, 6, 7], 3);
    assert.equal(note.includes('등록되지 않았습니다'), false, note);
    assert.equal(note.includes('3건이 칸반에 등록됐습니다'), true, note);
  });

  it('⚠️ 표시 건수를 안 주면 **예전과 같이** 답한다 — 옛 호출을 안 깨뜨린다', () => {
    assert.equal(describeSubmitResult(0, []), '검토를 반영했습니다 — 칸반에 등록된 업무는 없습니다');
    assert.equal(describeSubmitResult(2, [1, 2]).includes('2건이 칸반에 등록됐습니다'), true);
  });
});
