import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeMissingSummary,
  describeReviewDone,
  reviewEmptyState,
  reviewPhase,
} from './phase.ts';

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
    // ⚠️ 예전에는 `['queued','processing']` 을 한 줄로 돌렸습니다. 그때는
    //    둘이 한 갈래였기 때문이지 **묶어 두기로 정한 것이 아닙니다** —
    //    결함 325 가 「줄에 서 있는 것과 하고 있는 것은 다릅니다」로 갈라
    //    놓았고, 이 파일만 그 표에서 빠져 있었습니다 (결함 346).
    //    「기다리라」는 요구는 그대로 지킵니다.
    for (const status of ['queued', 'processing']) {
      const phase = reviewPhase(status);
      strictEqual(phase.canReview, false, status);
      strictEqual(/올라옵니다|기다리는 중/.test(phase.emptyNote), true, status);
    }
    // 하고 있는 것에는 갈 곳이 없습니다 — 기다리면 옵니다.
    strictEqual(reviewPhase('processing').go, null);
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
    // ⚠️ `queued` 는 여기서 뺐습니다 — 「줄에 서 있다」는 자기 문장을
    //    받습니다(결함 346). 요구(「아직 올 것이 남았다고 말한다」)는
    //    그대로라, 그 문장도 같이 잽니다.
    for (const status of ['processing', undefined, null, '새상태']) {
      strictEqual(/처리가 끝나면/.test(describeMissingSummary(status)), true, String(status));
    }
    strictEqual(
      /아직 시작하지 않았습니다/.test(describeMissingSummary('queued')),
      true,
      describeMissingSummary('queued'),
    );
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


// ══════════════════════════════════════════════════════════════
// 줄에 서 있는 것과 하고 있는 것 (결함 325·346)
// ══════════════════════════════════════════════════════════════
//
// 결함 325 가 서버·홈·로비 셋에서 `queued` 와 `processing` 을 갈라놨는데,
// **검토 화면은 그 표에 없었습니다.** 그래서 큐에 걸린 회의를 열면
// 홈은 「처리 대기 — 아직 시작하지 않았습니다」, 검토는 「처리하는 중」
// 이었습니다 — 같은 사실을 두 자리가 다르게 말한 것입니다(결함 290).

describe('줄에 서 있는 회의를 「하고 있다」고 하지 않는다 (결함 346)', () => {
  it('⭐ `queued` 와 `processing` 이 **다른 말**을 받는다', () => {
    const q = reviewPhase('queued');
    const p = reviewPhase('processing');
    strictEqual(q.emptyNote === p.emptyNote, false, `둘이 같은 말입니다: ${q.emptyNote}`);
    strictEqual(q.emptyNote.includes('아직 시작하지 않았습니다'), true, q.emptyNote);

    const qe = reviewEmptyState('queued', 7);
    const pe = reviewEmptyState('processing', 7);
    strictEqual(qe.why === pe.why, false, `빈 상자도 둘이 같은 말입니다: ${qe.why}`);
  });

  it('⭐ 큐에 걸린 회의에는 **갈 곳**을 준다 — 워커가 죽으면 영영 안 옵니다', () => {
    // 서버가 `can_reprocess = status in ("failed","queued")` 로 열어 둔
    // 문입니다. 안 알려 주면 사람은 기다리기만 합니다 (실패 ③).
    strictEqual(reviewPhase('queued').go?.screen, 'lobby');
    strictEqual(reviewEmptyState('queued', 7).action?.href.includes('lobby.html'), true);
  });

  it('⛔ 「잠시 뒤에 새로고침하세요」는 **하고 있는 것**에만 붙는다', () => {
    // 시작도 안 한 일을 기다리게 하는 말입니다.
    strictEqual(reviewEmptyState('queued', 7).how.includes('새로고침'), false);
    strictEqual(reviewEmptyState('processing', 7).how.includes('새로고침'), true);
  });

  it('⭐ 옆 갈래(요약 칸)도 같이 간다 (결함 301)', () => {
    const q = describeMissingSummary('queued');
    strictEqual(q === describeMissingSummary('processing'), false, q);
    strictEqual(q.includes('아직 시작하지 않았습니다'), true, q);
  });

  /*
   * ⚠️ 두 함수는 **같은 표를 다른 모양으로** 내보냅니다. 한쪽에만 갈래가
   * 생기면 화면 둘이 갈라집니다 — 이 저장소가 아홉 번 겪은 모양입니다.
   * 그래서 「같은 상태 집합을 가르는가」를 잽니다.
   */
  it('⭐ 두 함수가 **같은 상태 집합**을 가른다', () => {
    const STATUSES = ['pending', 'queued', 'processing', 'needs_review', 'confirmed', 'failed'];

    // 같은 답을 주는 상태끼리 묶습니다. 두 함수의 묶음이 같아야 합니다.
    const group = (key: (s: string) => string): string => {
      const seen = new Map<string, string[]>();
      for (const s of STATUSES) {
        const k = key(s);
        seen.set(k, [...(seen.get(k) ?? []), s]);
      }
      return [...seen.values()].map((g) => g.join('+')).sort().join(' | ');
    };

    strictEqual(
      group((s) => reviewPhase(s).emptyNote),
      group((s) => reviewEmptyState(s, 1).why),
      '두 함수가 상태를 다르게 묶습니다 — 한쪽에만 갈래가 생기면 화면 둘이 갈라집니다',
    );
  });
});
