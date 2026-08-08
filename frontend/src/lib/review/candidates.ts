
import { withJosa } from '../text/josa.ts';
/**
 * 업무 후보 검토 로직.
 *
 * docs/03-시스템-아키텍처.md §3, docs/04 §4.1
 *
 * ## 이 화면이 시스템의 안전장치다
 *
 * AI 가 뽑은 업무는 **후보**일 뿐이고, 사람이 승인해야 실제 `tasks` 가 된다.
 * 백엔드에는 AI → `tasks` 직행 경로가 아예 없다 (테스트로 고정돼 있다).
 * 그 승인을 사람이 실제로 **판단할 수 있게** 만드는 게 이 모듈이다.
 *
 * ## 클라이언트가 서버 규칙을 흉내 내는 이유
 *
 * 승인 가능 여부는 서버가 최종 판단한다 (`meeting/approval.py`).
 * 그런데 서버까지 갔다가 "담당자가 없습니다" 를 받으면 사용자는 무엇을
 * 고쳐야 하는지 한 번에 알 수 없다. 그래서 **같은 규칙을 여기서도 계산해
 * 미리 보여준다.** 동의 게이트와 같은 구조다 — 클라이언트는 UX, 서버는 권위.
 *
 * 대신 규칙이 갈라지면 위험하므로, 서버와 같은 오류 코드를 쓰고 그 대응을
 * 테스트로 못 박아 둔다.
 */

/** 서버 `CandidateOut` 과 같은 모양. */
export interface Candidate {
  id: number;
  title: string;
  /**
   * 회의에서 실제로 불린 이름. `assignee_id` 가 null 일 때 사람이 누구를
   * 골라야 하는지 아는 유일한 단서다 — 담당자 칸이 그냥 비어 있는 것과,
   * "회의에서는 '민수님' 이라고 했다" 를 아는 것은 전혀 다른 작업이다.
   */
  assignee_hint?: string | null;
  assignee_id: number | null;
  /** ISO 날짜 `YYYY-MM-DD`. 시각 성분이 없다. */
  deadline: string | null;
  confidence: number;
  /** 이 후보의 근거가 된 발화. 비어 있으면 환각이다 (docs/04 §4.1). */
  evidence_utterance_ids: number[];
  review_status: string;
  /**
   * 서버가 확신도를 깎은 이유. 숫자 0.34 만으로는 무엇을 확인해야 할지
   * 알 수 없다 — "담당자 미확정" 과 "마감일이 회의일보다 이전" 은 손봐야
   * 할 곳이 다르다.
   *
   * 선택 필드인 이유: 이 컬럼이 생기기 전에 저장된 후보는 빈 배열이다.
   */
  warnings?: string[];
}

export type Decision = 'pending' | 'approve' | 'reject';

/** 사람이 화면에서 만지는 값. 원본은 건드리지 않는다. */
export interface Draft {
  decision: Decision;
  titleOverride?: string;
  assigneeOverride?: number | null;
  deadlineOverride?: string | null;
  note?: string;
}

export function emptyDraft(): Draft {
  return { decision: 'pending' };
}

/** 서버 `ApprovalError` 와 같은 코드를 쓴다. 갈라지면 안 된다. */
export type BlockerCode =
  | 'missing_assignee'
  | 'missing_deadline'
  | 'deadline_in_past'
  | 'unknown_assignee'
  | 'already_approved'
  | 'already_rejected'
  | 'no_evidence';

export interface Blocker {
  code: BlockerCode;
  message: string;
}

const BLOCKER_TEXT: Record<BlockerCode, string> = {
  missing_assignee: '담당자를 지정해야 승인할 수 있습니다',
  missing_deadline: '마감일을 지정해야 승인할 수 있습니다',
  deadline_in_past: '마감일이 과거입니다',
  unknown_assignee: '담당자가 이 프로젝트의 팀원이 아닙니다',
  already_approved: '이미 승인된 후보입니다',
  already_rejected: '이미 거절된 후보입니다',
  no_evidence: '근거 발화가 없습니다 — 회의에 없던 내용일 수 있습니다',
};

/**
 * 서버가 돌려준 오류 **코드**를 사람이 읽을 문구로 옮긴다.
 *
 * 서버는 코드만 준다 (`meeting/approval.ApprovalError`). 문구를 서버에 두면
 * 다국어를 서버가 떠안게 되고, 화면 맥락에 맞게 다듬을 수도 없다.
 * 모르는 코드는 그대로 보여준다 — 삼키면 사용자가 원인을 영영 못 본다.
 */
export function describeBlocker(code: string): string {
  return BLOCKER_TEXT[code as BlockerCode] ?? code;
}

export interface ReviewContext {
  /** 이 프로젝트 팀원의 user_id 목록 */
  memberIds: number[];
  /** 오늘 날짜 `YYYY-MM-DD`. 주입받는다 — 테스트가 시간에 흔들리면 안 된다. */
  today: string;
}

export function effectiveTitle(candidate: Candidate, draft: Draft): string {
  return draft.titleOverride?.trim() || candidate.title;
}

export function effectiveAssignee(candidate: Candidate, draft: Draft): number | null {
  return draft.assigneeOverride !== undefined ? draft.assigneeOverride : candidate.assignee_id;
}

export function effectiveDeadline(candidate: Candidate, draft: Draft): string | null {
  return draft.deadlineOverride !== undefined ? draft.deadlineOverride : candidate.deadline;
}

/**
 * 승인을 막는 이유들. 빈 배열이면 승인 가능하다.
 *
 * **거절에는 적용하지 않는다.** 담당자가 없어서 승인 못 하는 후보라도
 * 거절은 언제나 할 수 있어야 한다 — 그게 "이건 업무가 아니다" 라는 판단이다.
 */
export function approvalBlockers(
  candidate: Candidate,
  draft: Draft,
  context: ReviewContext,
): Blocker[] {
  const blockers: Blocker[] = [];
  const add = (code: BlockerCode): void => {
    blockers.push({ code, message: BLOCKER_TEXT[code] });
  };

  if (candidate.review_status === 'approved') add('already_approved');
  if (candidate.review_status === 'rejected') add('already_rejected');

  if (candidate.evidence_utterance_ids.length === 0) add('no_evidence');

  const assignee = effectiveAssignee(candidate, draft);
  if (assignee === null) {
    add('missing_assignee');
  } else if (!context.memberIds.includes(assignee)) {
    add('unknown_assignee');
  }

  const deadline = effectiveDeadline(candidate, draft);
  if (deadline === null || deadline === '') {
    add('missing_deadline');
  } else if (isBeforeIsoDate(deadline, context.today)) {
    add('deadline_in_past');
  }

  return blockers;
}

/**
 * 사람이 이 후보를 왜 들여다봐야 하는지. 서버 경고를 그대로 쓴다.
 *
 * `approvalBlockers` 와 역할이 다르다. 저쪽은 **지금 승인이 되는가**를
 * 판정하고, 사람이 화면에서 담당자를 고르면 사라진다. 이쪽은 **서버가
 * 무엇을 확신하지 못했는가**의 기록이라 사람이 고쳐도 남아야 한다 —
 * 남지 않으면 "왜 이 후보만 확신도가 낮았는지" 를 나중에 되짚을 수 없다.
 *
 * 경고가 하나도 없는데 확신도만 낮은 경우가 있다 (LLM 자체 확신도가 낮음).
 * 그때도 빈손으로 두지 않는다 — 화면에 아무 설명 없이 빨간 표시만 뜨면
 * 사람은 그냥 무시하게 된다.
 */
export function attentionReasons(candidate: Candidate): string[] {
  const reasons = [...(candidate.warnings ?? [])];
  if (reasons.length === 0 && candidate.confidence < LOW_CONFIDENCE) {
    reasons.push(
      `AI 확신도가 낮습니다 (${Math.round(candidate.confidence * 100)}%) — 근거 발화를 확인하세요`,
    );
  }
  return reasons;
}

/**
 * ISO 날짜(`YYYY-MM-DD`) 는 **문자열 비교**로 대소를 판단한다.
 *
 * `new Date('2026-09-04')` 는 UTC 자정으로 해석되므로 한국(UTC+9)에서
 * 로컬 자정과 9시간 어긋난다. 마감일 하루 차이는 "지났다/안 지났다" 를
 * 뒤집으므로 Date 를 거치지 않는다.
 */
export function isBeforeIsoDate(a: string, b: string): boolean {
  return a < b;
}

export function canApprove(
  candidate: Candidate,
  draft: Draft,
  context: ReviewContext,
): boolean {
  return approvalBlockers(candidate, draft, context).length === 0;
}

// ══════════════════════════════════════════════════════════════
// 제출
// ══════════════════════════════════════════════════════════════

export interface ReviewItem {
  candidate_id: number;
  approve: boolean;
  title_override?: string;
  assignee_override?: number;
  deadline_override?: string;
  note?: string;
}

export interface ReviewPayload {
  // `reviewer_id` 는 없다. 검토자는 서버가 **세션에서** 읽는다 — 승인은
  // 이 시스템에서 사람이 개입하는 유일한 지점이고 승인된 업무는 칸반에
  // 올라 기여도에 들어가므로, 검토자를 요청으로 정할 수 있으면 남의
  // 이름으로 승인 기록이 남는다.
  items: ReviewItem[];
}

/**
 * 결정된 후보만 모아 제출 페이로드를 만든다.
 *
 * 두 가지를 보장한다.
 *
 * 1. **막힌 승인은 절대 보내지 않는다.** 서버가 어차피 거절하지만, 보내고
 *    실패를 받는 것보다 화면에서 먼저 막는 게 낫다. 실패 목록을 해석해
 *    되돌리는 코드가 필요 없어진다.
 * 2. **바뀌지 않은 값은 override 로 보내지 않는다.** 원본과 같은 값을
 *    override 로 보내면 감사 로그에 "사람이 바꿨다" 로 남는다. 안 바꿨는데
 *    바꿨다고 기록되면 나중에 분쟁의 근거가 뒤틀린다.
 *
 * @throws 결정된 항목이 없거나, 승인하려는 항목에 차단 사유가 있으면
 */
export function buildReviewPayload(
  candidates: readonly Candidate[],
  drafts: ReadonlyMap<number, Draft>,
  context: ReviewContext,
): ReviewPayload {
  const items: ReviewItem[] = [];

  for (const candidate of candidates) {
    const draft = drafts.get(candidate.id) ?? emptyDraft();
    if (draft.decision === 'pending') continue;

    if (draft.decision === 'approve') {
      const blockers = approvalBlockers(candidate, draft, context);
      if (blockers.length > 0) {
        throw new Error(
          `${withJosa(`후보 ${candidate.id}`, '을를')} 승인할 수 없습니다: ${blockers
            .map((b) => b.message)
            .join(', ')}`,
        );
      }
    }

    const item: ReviewItem = {
      candidate_id: candidate.id,
      approve: draft.decision === 'approve',
    };

    const title = effectiveTitle(candidate, draft);
    if (title !== candidate.title) item.title_override = title;

    const assignee = effectiveAssignee(candidate, draft);
    if (assignee !== null && assignee !== candidate.assignee_id) {
      item.assignee_override = assignee;
    }

    const deadline = effectiveDeadline(candidate, draft);
    if (deadline !== null && deadline !== candidate.deadline) {
      item.deadline_override = deadline;
    }

    const note = draft.note?.trim();
    if (note) item.note = note;

    items.push(item);
  }

  if (items.length === 0) {
    throw new Error('결정한 후보가 없습니다');
  }
  return { items };
}

// ══════════════════════════════════════════════════════════════
// 화면 보조
// ══════════════════════════════════════════════════════════════

/**
 * 검토 순서.
 *
 * **확신도가 낮은 것부터** 보여준다. 사람의 주의력은 유한하고, 위에 있는
 * 것부터 본다. 확신도 높은 것을 위에 두면 정작 사람이 봐야 할 항목이
 * 스크롤 아래로 밀린다.
 */
export function sortForReview(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => a.confidence - b.confidence || a.id - b.id);
}

/** 이 확신도 아래면 화면에서 눈에 띄게 표시한다. */
export const LOW_CONFIDENCE = 0.7;

export interface ReviewSummary {
  total: number;
  pending: number;
  approving: number;
  rejecting: number;
  /** 승인하려는데 막혀 있는 개수. 0 이어야 제출할 수 있다. */
  blocked: number;
  /** 아직 결정하지 않은 것 중 확신도가 낮은 개수 */
  needsAttention: number;
}

export function summarize(
  candidates: readonly Candidate[],
  drafts: ReadonlyMap<number, Draft>,
  context: ReviewContext,
): ReviewSummary {
  let pending = 0;
  let approving = 0;
  let rejecting = 0;
  let blocked = 0;
  let needsAttention = 0;

  for (const candidate of candidates) {
    const draft = drafts.get(candidate.id) ?? emptyDraft();
    if (draft.decision === 'approve') {
      approving += 1;
      if (!canApprove(candidate, draft, context)) blocked += 1;
    } else if (draft.decision === 'reject') {
      rejecting += 1;
    } else {
      pending += 1;
      if (candidate.confidence < LOW_CONFIDENCE) needsAttention += 1;
    }
  }

  return {
    total: candidates.length,
    pending,
    approving,
    rejecting,
    blocked,
    needsAttention,
  };
}

export function canSubmit(summary: ReviewSummary): boolean {
  return summary.blocked === 0 && summary.approving + summary.rejecting > 0;
}
