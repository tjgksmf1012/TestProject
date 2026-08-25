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
import type { EmptyState } from '../ui/empty.ts';
import { canSubmit, type Lane, type ReviewSummary } from './candidates.ts';

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
    case 'pending':
      // ⛔ **녹음도 안 한 회의입니다** (결함 346). 「처리가 끝나면」은
      //    처리가 시작될 것을 전제하는데, 아직 녹음조차 안 했습니다.
      //    바로 옆 요약 칸(`describeMissingSummary`)은 결함 284 에서
      //    이 갈래를 이미 갈라 놨습니다 — 후보 칸만 남아 있었습니다.
      return {
        canReview: false,
        emptyNote: '아직 녹음하지 않은 회의입니다 — 녹음을 마치면 후보가 만들어집니다.',
        go: { label: '회의 로비로', screen: 'lobby' },
      };
    case 'queued':
      // ⛔ **줄에 서 있는 것과 하고 있는 것은 다릅니다** (결함 325·346).
      //
      // 예전에는 이 갈래가 `processing` 과 한 `default` 에 묶여 있어서,
      // 큐에 걸린 회의에게도 「처리가 끝나면 올라옵니다」라고 했습니다.
      // 워커가 안 돌면 **영영 시작되지 않는데** 사람은 기다립니다 —
      // 결함 325 가 홈·로비 셋을 고치면서 이 화면만 표에서 빠졌습니다.
      //
      // ⚠️ **갈 곳을 줍니다.** 서버는 `queued` 를 다시 처리할 수 있게
      // 열어 두었고(`can_reprocess = status in ("failed","queued")`),
      // 그 단추는 로비에 있습니다. 여기서 안 알려 주면 실패 ③ 입니다.
      return {
        canReview: false,
        emptyNote:
          '처리 차례를 기다리는 중입니다 — 아직 시작하지 않았습니다. ' +
          '오래 걸리면 로비에서 다시 처리할 수 있습니다.',
        go: { label: '회의 로비로', screen: 'lobby' },
      };
    default:
      // `processing`·모르는 상태. 아직 올 것이 남았습니다.
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

/**
 * 「검토 끝내기」가 **지금 안 되는 이유** — 하나도 남기지 않고 다 처리해야
 * 열리는 SPA 쪽 규칙입니다.
 *
 * ## ⛔ 후보가 **처음부터 0건**인 회의에게 「결정한 후보가 없습니다」 (결함 366)
 *
 * 회의에서 아무도 일을 맡지 않으면 파이프라인이 후보를 하나도 안 만듭니다
 * (`validate_analysis` 가 `candidates = []`). 그 회의의 검토 화면이
 * 이랬습니다 —
 *
 *     스프린트 2 계획 · 업무 후보 0건    결정한 후보가 없습니다  [검토 끝내기]
 *     …
 *     이 회의에서는 업무 후보가 나오지 않았습니다.
 *
 * **같은 화면이 같은 사실을 두 번 말하는데 위엣것은 사람을 탓합니다.**
 * 결정을 안 한 것이 아니라 **결정할 것이 없었습니다.** 아래 문장은
 * `reviewPhase` 가 이미 정확히 갈라 놓은 것이고, 위 문장만 그 판단을
 * 안 물었습니다 — 결함 290 의 「같은 사실을 말하는 두 자리를 나란히
 * 놓으십시오」입니다.
 *
 * ⚠️ 결함 232 는 `confirmed` 갈래만 갈랐습니다(`describeReviewDone`).
 * `needs_review` + 0건은 **일반 문장으로 떨어졌습니다.**
 *
 * ⚠️ 그리고 그 상태는 **영영 안 바뀝니다.** 서버는 후보가 처음부터 0건인
 * 회의를 **일부러** `confirmed` 로 안 옮깁니다(결함 84 —
 * `_confirm_if_all_reviewed` 의 `if not total: return`). 즉 「없는 것을
 * 결정하라」고 시키는 문장이고, 시키는 대로 할 자리가 화면에 없습니다
 * (실패 ③).
 *
 * ⚠️ **레거시의 `whyCannotSubmitBatch` 와 규칙이 다릅니다** — 그쪽은
 * 「정한 것만 올리고 나머지는 나중에」라 하나만 정해도 열립니다. 합치면
 * 없던 요구가 생깁니다(결함 353·365).
 */
export function whyCannotFinishReview(input: {
  status: string | null | undefined;
  lanes: Record<Lane | 'all', number>;
  summary: ReviewSummary;
}): string | null {
  const { status, lanes, summary } = input;
  if (lanes.pending > 0) {
    return `${lanes.all}건 중 ${lanes.pending}건이 아직 처리되지 않았습니다`;
  }
  if (canSubmit(summary)) return null;
  if (summary.blocked > 0) return '승인 표시된 후보 중 조건이 안 채워진 것이 있습니다';
  // 끝난 회의에서는 **막힌 게 아니라 끝난** 것입니다 (결함 232).
  const done = describeReviewDone(status);
  if (done !== null) return done;
  /* ⛔ **목록이 통째로 비었으면 「결정한 후보가 없습니다」가 아닙니다**
     (결함 366). 왜 비었는지는 `reviewPhase` 가 상태별로 갈라 뒀습니다 —
     그것을 그대로 씁니다. 서버(`pending_candidates`)가 대기 중인 것만
     내려보내므로 `lanes.all === 0` 은 실제로 「지금 결정할 것이 없다」와
     같은 뜻입니다. */
  if (lanes.all === 0) return reviewPhase(status).emptyNote;
  return '결정한 후보가 없습니다';
}

/**
 * 「검토 끝내기」를 **그릴 것인가.**
 *
 * ⚠️ **결함 316 과 다른 경우입니다** (결함 366). 저기는 「할 수 있는 일이
 * 막힌 것」이라 단추를 두고 이유를 말해야 하고, 이쪽은 **처음부터 없는
 * 것**입니다 — 결함 362 가 등급 선택칸에서 내린 판단과 같습니다.
 *
 * 후보가 하나도 없는 회의에서는 끝낼 검토가 없습니다. 서버도 그 회의를
 * **일부러** `confirmed` 로 안 옮기므로(결함 84), 단추를 그려 두면 눌러도
 * 영영 아무 일이 안 일어납니다. 게다가 그 단추의 사유(`aria-describedby`)와
 * 후보 칸의 빈 상자가 **같은 문장을 두 번** 그리게 됩니다 — 렌더해서
 * 보고 알았습니다.
 *
 * 왜 비었는지는 후보 칸의 빈 상자가 말합니다(`reviewPhase` ·
 * `reviewEmptyState`). 단추만 안 그립니다 — **말은 그대로 남습니다.**
 */
export function showsFinishReview(lanes: Record<Lane | 'all', number>): boolean {
  return lanes.all > 0;
}

/**
 * 요약이 **왜** 없는지.
 *
 * ⚠️ 예전에는 화면이 「요약이 아직 없습니다 — 처리가 끝나면 여기
 * 담깁니다」 한 문장을 들고 있었습니다 (결함 284). 검토까지 끝난
 * `confirmed` 에게도, 처리에 **실패한** `failed` 에게도 "기다리세요" 라고
 * 했습니다. 바로 옆 후보 칸은 같은 병을 이미 고쳐 뒀는데(`reviewPhase`)
 * 요약 칸만 남아 있던 것입니다.
 */
export function describeMissingSummary(status: string | null | undefined): string {
  switch (status) {
    case 'pending':
      return '아직 녹음하지 않은 회의입니다 — 녹음을 마치면 요약이 만들어집니다.';
    case 'needs_review':
    case 'confirmed':
      return '처리는 끝났는데 요약이 만들어지지 않았습니다 — 소리가 짧거나 알아듣지 못했을 수 있습니다.';
    case 'failed':
      return '회의 처리에 실패해 요약이 없습니다. 로비에서 다시 처리할 수 있습니다.';
    case 'queued':
      // 옆 갈래도 같이 갑니다 (결함 301). 후보 칸만 고치고 요약 칸을 두면
      // 한 화면이 같은 회의를 두고 서로 다른 말을 합니다.
      return '처리 차례를 기다리는 중입니다 — 아직 시작하지 않았습니다.';
    default:
      return '요약이 아직 없습니다 — 처리가 끝나면 여기 담깁니다.';
  }
}

/**
 * 후보 칸이 비었을 때의 **빈 상자 한 덩어리** — 레거시 검토 화면이 씁니다.
 *
 * ## ⚠️ 왜 화면에서 옮겨 왔나 (결함 346)
 *
 * 이 판단은 `demo/review.tsx` 안에 있었습니다. 화면 코드에는 자동 검사가
 * 없으므로, 결함 325 가 서버와 홈·로비에서 `queued` 를 갈라놓는 동안 이
 * 함수만 **묶인 채로 남았습니다.** 같은 물음(`상태 → 무슨 말을 하나`)이
 * 두 곳에 있었고, 한쪽만 고쳐졌습니다 — 대표 실패 ②.
 *
 * ⚠️ `reviewPhase` 와 **나란히 둡니다.** 둘은 같은 표를 다른 모양으로
 * 내보내는 것이라, 한쪽에만 갈래가 생기는 순간 화면 둘이 갈라집니다.
 * `phase.test.ts` 가 **두 함수가 같은 상태 집합을 가르는지** 잽니다.
 *
 * ## ⚠️ `projectId` 를 받는 이유 (결함 355)
 *
 * 칸반 링크가 `/kanban.html?meeting=6` 이었습니다. 레거시 칸반은
 * `params.get('project') ?? '1'` 이라 **없으면 1번 프로젝트**를 엽니다 —
 * 같은 화면의 왼쪽 열 링크는 `?project=2&meeting=6` 으로 제대로 달고
 * 있었으니, **한 화면 안에서 같은 모양 둘 중 하나만** 맞았습니다
 * (결함 298·301 과 같은 자리). `home/next.ts` 의 `nextStepFor` 도 같은
 * 병이었습니다.
 */
export function reviewEmptyState(
  status: string | null | undefined,
  meetingId: number,
  projectId: number,
): EmptyState {
  const what = '여기에는 회의에서 뽑은 업무 후보가 나옵니다.';
  const lobby = `/lobby.html?meeting=${meetingId}`;
  const kanban = `/kanban.html?project=${projectId}&meeting=${meetingId}`;

  switch (status) {
    case 'pending':
      // ⛔ 결함 346 — 이 갈래가 없어서 `needs_review` 와 같은 `default` 로
      //    떨어졌고, **녹음도 안 한 회의**가 「처리는 끝났는데 뽑을 만한
      //    발언이 없었습니다」를 받았습니다. 결함 289 가 회의록에서 잡은
      //    바로 그 모양(녹음도 안 한 회의를 「처리를 마친 것」으로)입니다.
      return {
        what,
        why: '아직 녹음하지 않은 회의입니다 — 녹음을 마치면 후보가 만들어집니다.',
        how: '로비에서 동의를 받고 녹음을 시작하세요.',
        action: { label: '회의 로비로', href: lobby },
      };
    case 'queued':
      // ⛔ 결함 325·346 — `processing` 과 한 갈래였습니다. 「잠시 뒤에
      //    새로고침하세요」는 시작도 안 한 일을 기다리게 하는 말입니다.
      return {
        what,
        why: '처리 차례를 기다리는 중입니다 — 아직 시작하지 않았습니다.',
        how: '오래 걸리면 로비에서 다시 처리할 수 있습니다.',
        action: { label: '회의 로비로', href: lobby },
      };
    case 'processing':
      return {
        what,
        why: '녹음을 처리하는 중입니다.',
        how: '끝나면 여기에 후보가 나옵니다. 잠시 뒤에 새로고침하세요.',
      };
    case 'failed':
      return {
        what,
        why: '녹음 처리에 실패해서 후보를 만들지 못했습니다.',
        how: '로비에서 트랙이 온전한지 확인하세요 — 끊긴 구간이 많으면 처리가 실패합니다.',
        action: { label: '트랙 상태 보기', href: lobby },
      };
    case 'confirmed':
      return {
        what,
        why: '이 회의의 후보는 모두 검토를 마쳤습니다.',
        how: '승인한 업무는 칸반에 있습니다.',
        action: { label: '칸반 보기', href: kanban },
      };
    default:
      // needs_review 인데 0건 — 처리는 끝났고 뽑을 게 없었습니다.
      // **고장이 아니라 결과입니다.**
      return {
        what,
        why: '처리는 끝났는데 업무로 뽑을 만한 발언이 없었습니다 — 고장이 아닙니다.',
        how: '회의에서 누가·무엇을·언제까지 하기로 했는지 말하면 그 발언이 후보가 됩니다.',
        action: { label: '칸반 보기', href: kanban },
      };
  }
}
