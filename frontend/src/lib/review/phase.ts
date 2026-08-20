/**
 * 검토 화면의 **국면** — 지금 이 회의는 어디에 있고, 후보 칸이 비었으면
 * 무슨 말을 해야 하는가.
 *
 * ## ⛔ 하나의 빈 상태로 **정반대 두 상황**을 말하고 있었습니다 (결함 232)
 *
 * 후보를 셋 다 처리하고 「검토 끝내기」를 누른 직후의 화면입니다.
 *
 *     1주차 정기회의 · 업무 후보 0건        결정한 후보가 없습니다  [검토 끝내기]
 *     검토할 후보가 없습니다 — 회의 처리가 끝나면 AI 초안이 여기 올라옵니다.
 *
 * 방금 업무 **3건을 확정한** 사람에게 하는 말입니다. 서버는 같은 순간에
 * `approved_task_ids: [5, 6, 7]` 을 돌려줬고 회의는 `confirmed` 입니다.
 *
 *   - 「결정한 후보가 없습니다」 — 결정을 **했습니다.** 셋이나.
 *   - 「회의 처리가 끝나면 … 올라옵니다」 — 처리는 **이미 끝났습니다.**
 *     이건 처리 **전** 회의에게 할 말입니다.
 *
 * 화면이 `candidates.length === 0` 만 보고 **회의 상태를 안 봤습니다.**
 * 「아직 아무것도 안 왔다」와 「다 처리했다」가 같은 문장을 받습니다 —
 * `main.tsx` 가 이미 적어 둔 병입니다("거절했을 때와 같은 문장이라 무슨
 * 일이 있었는지 알 수 없습니다").
 *
 * 그리고 **간 곳을 안 알려 줍니다.** 업무 셋은 칸반으로 갔는데 이 화면
 * 어디에도 그 말이 없습니다 — 실패 ③.
 *
 * ⚠️ `lobbyPhase`(결함 214)와 **같은 모양**입니다. 같은 물음이니까요.
 * ⚠️ **모르는 상태는 「아직 안 왔다」로 둡니다.** 새 상태가 생겼을 때
 * 「다 끝났다」고 말해 버리면, 아직 올 것이 남았는데 사람이 떠납니다.
 */
export interface ReviewPhase {
  /** 지금 후보를 결정할 수 있는 국면인가. */
  canReview: boolean;
  /** 후보 칸이 비었을 때 할 말. */
  emptyNote: string;
  /**
   * 검토 화면 말고 갈 곳. 여기서 할 일이면 `null`.
   *
   * ⚠️ 끝난 회의에서 이걸 안 주면, 방금 만든 업무가 **어디로 갔는지**
   * 모른 채 화면을 떠납니다.
   */
  go: { label: string; screen: 'kanban' | 'lobby' } | null;
}

export function reviewPhase(status: string | null | undefined): ReviewPhase {
  switch (status) {
    case 'confirmed':
      return {
        canReview: false,
        emptyNote: '검토를 마친 회의입니다. 결정한 업무는 칸반에 있습니다.',
        go: { label: '칸반에서 보기', screen: 'kanban' },
      };
    case 'needs_review':
      // 처리는 끝났는데 후보가 0건 — AI 가 **찾은 것이 없는** 경우입니다.
      // 「곧 올라옵니다」라고 하면 오지 않을 것을 기다리게 됩니다.
      return {
        canReview: true,
        emptyNote: '이 회의에서는 업무 후보가 나오지 않았습니다.',
        go: null,
      };
    case 'failed':
      return {
        canReview: false,
        emptyNote: '회의 처리에 실패해 후보가 없습니다. 로비에서 다시 처리할 수 있습니다.',
        go: { label: '회의 로비로', screen: 'lobby' },
      };
    default:
      // `queued`·`processing`·모르는 상태. 아직 올 것이 남았습니다.
      return {
        canReview: false,
        emptyNote: '검토할 후보가 없습니다 — 회의 처리가 끝나면 AI 초안이 여기 올라옵니다.',
        go: null,
      };
  }
}

/**
 * 「검토 끝내기」가 막힌 이유. 끝난 회의에서는 **막힌 게 아니라 끝난** 것입니다.
 *
 * ⚠️ 예전에는 후보가 0건이면 무조건 「결정한 후보가 없습니다」였습니다 —
 * 방금 셋을 확정한 사람에게도 그렇게 말했습니다 (결함 232).
 */
export function describeReviewDone(status: string | null | undefined): string | null {
  return status === 'confirmed' ? '검토를 마쳤습니다' : null;
}
