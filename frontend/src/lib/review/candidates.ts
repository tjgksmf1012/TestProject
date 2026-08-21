
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

/**
 * 서버 `ApprovalError` 와 같은 코드를 쓴다. 갈라지면 안 된다.
 *
 * ⚠️ **서버가 낼 수 있는 코드를 하나도 빠짐없이** 적는다. 아래 일곱은
 * 이 화면이 스스로도 판정하는 것이고, 마지막 둘은 **서버만 낸다** —
 * 그래도 여기 있어야 한다. 없으면 `describeBlocker` 가 코드를 그대로
 * 흘려보내 사람이 `unknown_candidate` 같은 내부 이름을 읽게 된다.
 */
export type BlockerCode =
  | 'missing_assignee'
  | 'missing_deadline'
  | 'deadline_in_past'
  | 'unknown_assignee'
  | 'already_approved'
  | 'already_rejected'
  | 'no_evidence'
  | 'unknown_candidate'
  | 'no_reviewer';

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
  // 아래 둘은 화면이 만들지 않는다. 서버만 낸다.
  //
  // 서버 문구는 "이 회의에 없는 후보입니다" 인데, 그것만 읽으면 사람은
  // 무엇을 해야 할지 모른다. 이 코드가 나오는 경우는 하나뿐이다 —
  // 화면이 들고 있는 목록이 서버보다 낡았다. 그래서 할 일을 같이 적는다.
  unknown_candidate: '이 회의에 없는 후보입니다 — 목록이 오래됐습니다. 새로 고쳐 주세요',
  no_reviewer: '로그인 정보가 확인되지 않았습니다 — 다시 로그인해 주세요',
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

/** 승인 조건 칩 한 개. 화면의 `Conditions` 가 그대로 받습니다. */
export interface ApprovalCondition {
  label: string;
  met: boolean;
}

/**
 * 승인 조건 칩 — **막는 목록과 같은 곳에서** 만듭니다.
 *
 * ## ⛔ 두 벌이었고, 갈라졌습니다
 *
 * 화면이 칩을 따로 만들고 있었습니다 — "담당자가 비었나 · 마감이 비었나".
 * 그런데 승인을 막는 쪽(`approvalBlockers`)은 **마감이 과거인 것도** 막습니다.
 *
 * 그래서 지난 날짜를 고르면 이렇게 됐습니다 (페르소나 QA 에서 나왔습니다).
 *
 *     조건 칩   ● 근거 1  ● 담당자  ● 마감      ← 다 됐다고 말하고
 *     버튼 툴팁 "등록할 수 있습니다"            ← 대놓고 거짓말이고
 *     실제      aria-disabled=true, 눌러도 무반응
 *
 * 사람은 버튼을 누르고, 아무 일도 안 일어나고, 화면은 다 됐다고 합니다.
 * **고장으로 읽힙니다.** 게다가 카드 어디에도 "지난 날짜" 라는 말이
 * 없었습니다 (결함 193).
 *
 * ⚠️ 그래서 칩을 **막는 이유에서 파생**시킵니다. 한 벌이면 갈라질 수
 * 없습니다.
 *
 * ⚠️ 칩 셋으로 설명되지 않는 이유(이미 승인됨 · 로그인 풀림 …)가 있으면
 * **그 문구를 칩으로 하나 더 답니다.** 없으면 "칩은 전부 ● 인데 버튼은
 * 막힘" 이 다시 생깁니다 — 그게 이 결함의 모양입니다.
 */
export function approvalConditions(
  candidate: Candidate,
  draft: Draft,
  context: ReviewContext,
): ApprovalCondition[] {
  const codes = new Set(approvalBlockers(candidate, draft, context).map((b) => b.code));
  const conditions: ApprovalCondition[] = [
    { label: `근거 ${candidate.evidence_utterance_ids.length}`, met: !codes.has('no_evidence') },
    {
      label: codes.has('unknown_assignee') ? '담당자 확인' : '담당자',
      met: !codes.has('missing_assignee') && !codes.has('unknown_assignee'),
    },
    {
      // 비어 있는 것과 **지난 것**은 할 일이 다릅니다 — 칩이 그렇게 말합니다.
      label: codes.has('deadline_in_past') ? '마감 지남' : '마감',
      met: !codes.has('missing_deadline') && !codes.has('deadline_in_past'),
    },
  ];
  const covered = new Set<string>([
    'no_evidence',
    'missing_assignee',
    'unknown_assignee',
    'missing_deadline',
    'deadline_in_past',
  ]);
  for (const code of codes) {
    if (covered.has(code)) continue;
    conditions.push({ label: describeBlocker(code), met: false });
  }
  return conditions;
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
/**
 * 이 결정 단추가 **지금 고른 것**인가 (결함 267).
 *
 * 카드를 「등록 표시됨」으로 바꾼 뒤에도 「등록」 단추가 그대로 살아
 * 있었습니다. 재현했습니다 — 다시 눌러도 요청이 안 나가고 화면도 안
 * 바뀝니다. 사람은 눌렀는데 아무 일도 안 일어난 것을 보고 **고장인지
 * 이미 된 것인지** 알 수 없습니다.
 *
 * 지운다고 될 일이 아닙니다. 지우면 「거절로 바꿨다가 다시 등록으로」가
 * 막힙니다. 그래서 **고른 것으로 보이게** 합니다 — 화면은 이 값을
 * `aria-pressed` 로 옮기고, 낭독기도 「선택됨」으로 읽습니다.
 */
export function decisionPressed(
  draft: { decision?: Decision | null } | undefined,
  target: Decision,
): boolean {
  return (draft?.decision ?? null) === target;
}

/**
 * 그 이유 목록에 붙일 **정직한 제목** (결함 253).
 *
 * 화면은 이 팝오버를 「확신이 낮은 이유」라고 불렀습니다. 두 군데가
 * 틀렸습니다.
 *
 * 1. **줄들이 확신도 얘기가 아닙니다.** 대부분 서버 경고입니다 —
 *    「담당자 미확정 — '저' 는 명단의 누구와도 맞지 않습니다」.
 * 2. **확신이 낮지도 않습니다.** 재 보니 확신 71% 후보에 그 제목이 붙어
 *    있었습니다. 이 파일의 저확신 기준은 `LOW_CONFIDENCE = 0.7` 입니다.
 *
 * 이 함수의 머리말이 이미 답을 적어 두고 있었습니다 — 「사람이 이 후보를
 * **왜 들여다봐야 하는지**」. 제목도 그렇게 답니다.
 */
export function attentionAbout(candidate: Candidate): string {
  return `${candidate.title} — 살펴봐야 하는 이유`;
}

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

// ══════════════════════════════════════════════════════════════
// 갈래와 한 줄 검사 (디자인 브리프 §8·§13)
// ══════════════════════════════════════════════════════════════

/** 화면의 필터 탭 하나. */
export type Lane = 'pending' | 'approve' | 'reject';

/**
 * 이 후보가 지금 어느 갈래에 있는가.
 *
 * ⚠️ **`summarize` 로 갈래를 세면 안 됩니다.** 저쪽은 초안(`Draft`)만
 * 봅니다. 이미 승인·거절이 끝난 후보의 초안은 `pending` 이라, 저 숫자로
 * 탭을 그리면 **이미 승인된 것이 `검토 필요` 에 들어갑니다.** 사람은
 * 그걸 보고 아직 할 일이 남았다고 읽습니다.
 *
 * 그래서 **서버가 이미 내린 결정이 먼저**입니다. 그 위에서만 초안이
 * 갈래를 바꿉니다.
 */
export function reviewLane(candidate: Candidate, draft: Draft): Lane {
  if (candidate.review_status === 'approved') return 'approve';
  if (candidate.review_status === 'rejected') return 'reject';
  return draft.decision;
}

/**
 * 이 카드의 결정을 **되돌릴 수 있는가.**
 *
 * ## ⚠️ 「나중에」 는 이름이 약속하는 일을 하지 않았습니다
 *
 * 버튼이 하는 일은 `decision: 'pending'` 입니다. 그런데 아직 아무것도 안
 * 정한 카드는 **이미** `pending` 이라, 눌러도 **아무 일도 안 일어납니다** —
 * 레인 개수도 그대로고, 카드도 그대로입니다. 페르소나 QA 에서 팀장이
 * 후보 둘을 "나중에" 로 미루고 검토를 끝내려다 막혔습니다. 미룬 것이
 * 아니라 **아무 일도 안 한 것**이었기 때문입니다 (결함 194).
 *
 * 실제로 이 버튼이 쓸모 있는 자리는 하나뿐입니다 — **잘못 누른 것을
 * 되돌리기.** 이름과 자리를 그것에 맞춥니다.
 *
 * ⚠️ 서버가 이미 승인/거절한 후보는 되돌릴 수 없습니다. 화면의 초안만
 * 바꿔 봐야 `reviewLane` 이 서버 상태를 먼저 보므로 **또 아무 일도 안
 * 일어납니다** — 같은 결함을 다른 자리에 다시 만드는 셈입니다.
 */
export function canUndoDecision(candidate: Candidate, draft: Draft): boolean {
  if (candidate.review_status !== 'pending') return false;
  return draft.decision !== 'pending';
}

/** 탭에 적을 개수. 갈래마다 하나씩, 0 도 적는다. */
export function laneCounts(
  candidates: readonly Candidate[],
  drafts: ReadonlyMap<number, Draft>,
): Record<Lane | 'all', number> {
  const counts = { all: candidates.length, pending: 0, approve: 0, reject: 0 };
  for (const candidate of candidates) {
    counts[reviewLane(candidate, drafts.get(candidate.id) ?? emptyDraft())] += 1;
  }
  return counts;
}

/**
 * 승인을 막는 것들을 **한 줄**로.
 *
 * ⚠️ 예전에는 막는 이유를 한 줄에 하나씩, 전부 빨갛게 적었습니다. 후보
 * 하나에 두 줄이 뜨고 셋이면 여섯 줄인데, 그 여섯 줄이 전부 같은 빨강이라
 * **무엇이 진짜 문제인지가 안 보였습니다.**
 *
 * 그리고 대부분은 문제가 아닙니다 — 담당자·마감일이 비어 있는 것은
 * **아직 사람이 안 채운 것**이지 오류가 아닙니다. 회의에 없던 내용
 * (`no_evidence`)이나 팀원이 아닌 담당자와 같은 무게로 칠하면 안 됩니다.
 *
 * 그래서 두 가지를 가릅니다:
 *
 *   `missing`  아직 안 채운 칸. 흙빛 — 할 일이지 잘못이 아닙니다
 *   `error`    실제로 잘못된 것. 빨강
 *
 * 둘 다면 빨강이 이깁니다. 채우기 전에 고쳐야 할 것이 있으니까요.
 */
export type BlockerTone = 'none' | 'missing' | 'error';

export interface BlockerLine {
  tone: BlockerTone;
  text: string;
}

/** 비어 있을 뿐인 칸 — 이름만 모아 한 번에 말한다. */
const EMPTY_FIELD: Partial<Record<BlockerCode, string>> = {
  missing_assignee: '담당자',
  missing_deadline: '마감일',
};

export function blockerLine(blockers: readonly Blocker[]): BlockerLine {
  const empty: string[] = [];
  const hard: string[] = [];
  for (const blocker of blockers) {
    const field = EMPTY_FIELD[blocker.code];
    if (field === undefined) hard.push(blocker.message);
    else empty.push(field);
  }

  // ⚠️ `담당자을` 이 되지 않게 마지막 낱말에서 조사를 고릅니다.
  const need =
    empty.length === 0
      ? ''
      : `${[...empty.slice(0, -1), withJosa(empty[empty.length - 1] as string, '을를')].join(' · ')} 지정해야 등록할 수 있습니다`;

  if (hard.length === 0) {
    return empty.length === 0 ? { tone: 'none', text: '' } : { tone: 'missing', text: need };
  }
  return { tone: 'error', text: need === '' ? hard.join(' · ') : `${hard.join(' · ')} · ${need}` };
}

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

/**
 * 제출하고 나서 사람에게 할 말 (결함 85).
 *
 * 예전에는 한 줄이었습니다.
 *
 *     `${approved}건이 칸반에 등록됐습니다 (task ${ids.join(', ')})`
 *
 * 전부 거절하면 `approved` 가 0 이고 `ids` 가 빈 배열이라 화면에 이렇게
 * 나왔습니다 —
 *
 *     0건이 칸반에 등록됐습니다 (task )
 *
 * **꼬리표만 남고 안이 빈 것**은 결함 58(빈 `.note` 가 가로줄만 남김)과
 * 같은 부류입니다. 사람은 괄호 안이 비어 있는 것을 보고 앱이 무언가
 * 잃어버렸다고 읽습니다.
 *
 * 게다가 &#34;0건이 등록됐습니다&#34; 는 **한 일을 안 말합니다.** 그 사람은
 * 후보 셋을 읽고 셋 다 거절한 참입니다. 등록이 0건인 것은 결과이지
 * 아무 일도 안 일어난 것이 아닙니다.
 */
export function describeSubmitResult(
  approvedCount: number,
  taskIds: number[],
  /**
   * 내가 **승인 표시한** 건수. 서버의 답만으로는 「0건」의 뜻을 못 가릅니다.
   *
   * ⛔ 이것 없이는 **정반대 두 결과가 같은 문장**을 받습니다 (결함 233):
   *
   *   - 전부 거절해서 0건 → 「칸반에 등록된 업무는 없습니다」 (맞는 말)
   *   - 셋을 승인했는데 0건 → **같은 문장** ⛔
   *
   * 둘이 동시에 검토하면 뒤에 누른 사람이 그렇게 됩니다 — 서버는 멱등이라
   * 조용히 `approved_count: 0` 을 주고, 그 사람은 자기 승인 셋이 반영된
   * 줄 압니다. 재현했습니다: 둘이 같은 회의를 열고 A 가 먼저 끝내니
   * B 는 `{"approved_task_ids":[],"approved_count":0}` 을 받고도
   * A 와 **글자 하나 다르지 않은** 화면을 봤습니다.
   */
  requestedCount = 0,
): string {
  if (requestedCount > 0 && approvedCount === 0) {
    // ⚠️ "다른 사람이 먼저 했다" 고 **단정하지 않습니다.** 우리가 아는
    //    것은 "표시한 것이 안 들어갔다" 뿐입니다.
    return (
      `승인 표시한 ${requestedCount}건 중 새로 등록된 것이 없습니다 — ` +
      '이미 처리된 회의입니다. 새로고침해 지금 상태를 보세요'
    );
  }
  if (approvedCount === 0) {
    // ⚠️ 여기서 "실패" 라고 하지 않습니다. 거절은 정상적인 결정입니다.
    return '검토를 반영했습니다 — 칸반에 등록된 업무는 없습니다';
  }
  if (requestedCount > approvedCount) {
    const missed = requestedCount - approvedCount;
    return (
      `${approvedCount}건이 칸반에 등록됐습니다 — 표시한 ${requestedCount}건 중 ` +
      `${missed}건은 등록되지 않았습니다. 새로고침해 확인하세요`
    );
  }
  // 번호가 안 왔으면 지어내지 않고 건수만 말합니다.
  const numbers = taskIds.filter((id) => Number.isFinite(id));
  return numbers.length === 0
    ? `${approvedCount}건이 칸반에 등록됐습니다`
    : `${approvedCount}건이 칸반에 등록됐습니다 (task ${numbers.join(', ')})`;
}
