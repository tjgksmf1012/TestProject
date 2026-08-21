import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeMissingSummary, describeReviewDone, reviewPhase } from './phase.ts';

describe('⛔ 검토를 끝낸 회의가 「아직 아무것도 없다」고 말하던 것 (결함 232)', () => {
  it('⭐ 끝난 회의는 **끝났다고** 말하고, 업무가 간 곳을 가리킨다', () => {
    // 방금 업무 셋을 확정한 사람에게 「회의 처리가 끝나면 올라옵니다」는
    // 처리 **전** 회의에게 할 말입니다.
    const phase = reviewPhase('confirmed');
    strictEqual(phase.emptyNote.includes('검토를 마친'), true, phase.emptyNote);
    strictEqual(phase.emptyNote.includes('올라옵니다'), false, phase.emptyNote);
    strictEqual(phase.go?.screen, 'kanban');
    strictEqual(phase.canReview, false);
  });

  it('⭐ 처리 전이면 **기다리라고** 한다 — 그때는 맞는 말이다', () => {
    for (const status of ['queued', 'processing']) {
      const phase = reviewPhase(status);
      strictEqual(phase.emptyNote.includes('올라옵니다'), true, status);
      strictEqual(phase.go, null, status);
    }
  });

  it('⛔ 처리는 끝났는데 후보가 0건이면 **안 나왔다**고 한다', () => {
    // 「곧 올라옵니다」라고 하면 오지 않을 것을 기다립니다.
    const phase = reviewPhase('needs_review');
    strictEqual(phase.emptyNote.includes('나오지 않았습니다'), true, phase.emptyNote);
    strictEqual(phase.canReview, true);
  });

  it('⛔ 실패한 회의는 **다시 할 자리**를 가리킨다 (결함 231 과 같은 약)', () => {
    const phase = reviewPhase('failed');
    strictEqual(phase.go?.screen, 'lobby');
    strictEqual(phase.emptyNote.includes('실패'), true, phase.emptyNote);
  });

  it('⚠️ **모르는 상태는 「아직 안 왔다」로** — 반대로 하면 사람이 일찍 떠난다', () => {
    for (const status of [null, undefined, '', 'brand_new_status']) {
      const phase = reviewPhase(status);
      strictEqual(phase.emptyNote.includes('올라옵니다'), true, String(status));
      strictEqual(phase.canReview, false, String(status));
    }
  });

  it('⭐ 끝난 회의에서 「검토 끝내기」는 **막힌 게 아니라 끝난** 것이다', () => {
    strictEqual(describeReviewDone('confirmed'), '검토를 마쳤습니다');
    strictEqual(describeReviewDone('needs_review'), null);
  });
});

describe('describeMissingSummary — 요약이 왜 없는가 (결함 284)', () => {
  it('⛔ **끝난 회의에 「기다리면 온다」고 하지 않는다**', () => {
    /* 다섯 회의를 나란히 놓고 읽다가 잡았습니다. `confirmed`(검토까지
       끝남)와 `failed`(처리 실패)에도 「처리가 끝나면 여기 담깁니다」가
       떠 있었습니다 — 기다려도 아무것도 안 옵니다. */
    for (const status of ['confirmed', 'needs_review', 'failed']) {
      const text = describeMissingSummary(status);
      strictEqual(
        /처리가 끝나면/.test(text),
        false,
        `${status} 에게 기다리라고 합니다: ${text}`,
      );
    }
  });

  it('처리 실패는 **다시 할 자리**를 알려 준다', () => {
    strictEqual(/다시 처리/.test(describeMissingSummary('failed')), true);
  });

  it('아직 녹음도 안 한 회의에 「처리」 이야기를 하지 않는다', () => {
    const text = describeMissingSummary('pending');
    strictEqual(/녹음/.test(text), true, text);
  });

  it('⚠️ 모르는 상태는 「아직 올 것이 남았다」로 둔다', () => {
    // 새 상태가 생겼을 때 「다 끝났다」고 하면 사람이 일찍 떠납니다.
    for (const status of ['processing', 'queued', undefined, null, '새상태']) {
      strictEqual(/처리가 끝나면/.test(describeMissingSummary(status)), true, String(status));
    }
  });

  it('⛔ 「요약할 것이 없었다」고 단언하지 않는다 — 못 만든 것이지 없는 것이 아니다', () => {
    for (const status of ['confirmed', 'needs_review', 'failed', 'pending', 'processing']) {
      strictEqual(
        /없었습니다|없는 회의/.test(describeMissingSummary(status)),
        false,
        describeMissingSummary(status),
      );
    }
  });
});
