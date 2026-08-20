/**
 * 검토하던 것을 **새로고침 한 번에 잃지 않게** (결함 217).
 *
 * ## 무슨 일이 있었나
 *
 * 검토 화면의 결정(승인/거절 · 담당자 · 마감일 · 제목 고침)은 `useState`
 * 안에만 있었습니다. 브라우저로 재서 확인한 것:
 *
 *     담당자를 「이하늘」로 고름 → 화면 반영됨 · **나간 요청 0건**
 *     새로고침                  → 「미지정」 · 경고 대화상자 **0건**
 *
 * 후보가 열셋인 회의에서 담당자와 마감일을 다 채운 뒤 실수로 새로고침하면
 * 그 몇 분이 통째로 사라집니다. 아무 말도 없이요.
 *
 * ## 왜 `sessionStorage` 인가
 *
 * ⚠️ **`localStorage` 가 아닙니다.** 검토 초안은 그 자리에서 끝나는
 * 일입니다. 영구 보관하면 몇 주 전 초안이 되살아나 **지금 화면과 다른
 * 세계**를 보여 주고, 그건 잃는 것보다 나쁩니다 — 사람은 그게 오래된
 * 값인 줄 모르고 그대로 확정합니다. 탭이 사는 동안만 남깁니다.
 *
 * ⚠️ **회의마다 따로 둡니다.** 한 칸에 몰아 두면 다른 회의를 열었을 때
 * 남의 후보 id 에 붙은 초안이 섞입니다.
 *
 * ⚠️ **지금 있는 후보에만 되살립니다.** 그 사이에 누가 승인해 버린 후보의
 * 초안이 남아 있으면, 그 초안은 이미 뜻이 없습니다. 되살릴 때 거릅니다.
 *
 * ## 왜 저장이 아니라 초안인가
 *
 * 서버에 부분 저장하지 않습니다. 검토는 **한 번에 확정**하는 절차이고
 * (`POST …/candidates/review`), 중간 상태를 서버에 두면 "누가 무엇을
 * 언제 정했나" 가 두 벌이 됩니다. 여기 있는 것은 어디까지나 **이 사람의
 * 손이 미끄러지지 않게** 하는 임시 기록입니다.
 */

import { type Draft } from './candidates.ts';

/** 회의 하나의 초안이 앉는 자리. */
export function draftStorageKey(meetingId: number): string {
  return `teamflow:review-drafts:${meetingId}`;
}

/** 아무것도 안 정한 초안인가 — 저장할 값어치가 없습니다. */
export function isBlankDraft(draft: Draft): boolean {
  return (
    draft.decision === 'pending' &&
    (draft.titleOverride ?? '') === '' &&
    draft.assigneeOverride === undefined &&
    draft.deadlineOverride === undefined &&
    (draft.note ?? '') === ''
  );
}

/**
 * 저장할 모양으로. **빈 초안은 뺍니다** — 후보를 스칠 때마다 빈 칸이
 * 쌓이면 저장소가 커지기만 하고 되살릴 것은 하나도 없습니다.
 */
export function serializeDrafts(drafts: ReadonlyMap<number, Draft>): string {
  const kept: Record<string, Draft> = {};
  for (const [id, draft] of drafts) {
    if (!isBlankDraft(draft)) kept[String(id)] = draft;
  }
  return JSON.stringify(kept);
}

/**
 * 저장된 것을 되살린다.
 *
 * ⚠️ **무엇이든 들어올 수 있습니다.** 사람이 개발자 도구로 고칠 수도 있고,
 * 옛 판이 남아 있을 수도 있습니다. 모양이 이상한 것은 **버립니다** —
 * 화면에 `[object Object]` 를 띄우는 것보다 안 되살리는 게 낫습니다.
 *
 * @param liveIds 지금 화면에 있는 후보 id. 여기 없는 초안은 버립니다.
 */
export function parseDrafts(
  raw: string | null,
  liveIds: readonly number[],
): Map<number, Draft> {
  const out = new Map<number, Draft>();
  if (raw === null || raw === '') return out;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return out;

  const live = new Set(liveIds);
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const id = Number(key);
    if (!Number.isInteger(id) || !live.has(id)) continue;
    const draft = sanitize(value);
    if (draft !== null) out.set(id, draft);
  }
  return out;
}

const DECISIONS = new Set(['pending', 'approve', 'reject']);

/** 모양이 맞는 것만 통과. 아니면 `null`. */
function sanitize(value: unknown): Draft | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;

  const decision = row['decision'];
  if (typeof decision !== 'string' || !DECISIONS.has(decision)) return null;

  const draft: Draft = { decision: decision as Draft['decision'] };
  if (typeof row['titleOverride'] === 'string') draft.titleOverride = row['titleOverride'];
  if (typeof row['note'] === 'string') draft.note = row['note'];

  const assignee = row['assigneeOverride'];
  if (assignee === null) draft.assigneeOverride = null;
  else if (typeof assignee === 'number' && Number.isInteger(assignee)) {
    draft.assigneeOverride = assignee;
  }

  const deadline = row['deadlineOverride'];
  if (deadline === null) draft.deadlineOverride = null;
  // ⚠️ 서버가 받는 모양(`YYYY-MM-DD`)만 통과시킵니다. 아무 글자나 되살리면
  //    확정할 때 400 이 나고, 사람은 자기가 안 적은 값 때문에 막힙니다.
  else if (typeof deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
    draft.deadlineOverride = deadline;
  }

  return draft;
}
