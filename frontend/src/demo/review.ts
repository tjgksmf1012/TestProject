/**
 * 업무 후보 승인 화면.
 *
 * docs/03 §3 — "AI가 만든 업무는 후보이고, 사람이 승인해야 실제 tasks 가 된다."
 * 이 화면이 그 안전장치의 사람 쪽 끝이다.
 *
 * ⚠️ 화면 코드라 자동 테스트가 없습니다. 판단이 들어가는 로직은 전부
 * `src/lib/review/candidates.ts` 에 있고 36개 테스트로 검증됩니다.
 * 여기는 DOM 에 붙이는 배선일 뿐입니다.
 */

import {
  LOW_CONFIDENCE,
  approvalBlockers,
  buildReviewPayload,
  canSubmit,
  describeBlocker,
  effectiveAssignee,
  effectiveDeadline,
  effectiveTitle,
  emptyDraft,
  sortForReview,
  summarize,
  type Candidate,
  type Decision,
  type Draft,
  type ReviewContext,
} from '../lib/review/candidates.ts';

interface Member {
  user_id: number;
  name: string;
  role_shares: Record<string, number>;
}

const params = new URLSearchParams(location.search);
const apiBase = params.get('api') ?? '';
const meetingId = Number(params.get('meeting') ?? '1');
const reviewerId = Number(params.get('reviewer') ?? '1');

const drafts = new Map<number, Draft>();
let candidates: Candidate[] = [];
let members: Member[] = [];
let context: ReviewContext = { memberIds: [], today: todayIso() };

/** 로컬 자정 기준 오늘. `toISOString()` 은 UTC 라 한국에서 하루 어긋난다. */
function todayIso(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`요소 없음: ${id}`);
  return el;
};

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function memberName(userId: number | null): string {
  if (userId === null) return '미지정';
  return members.find((m) => m.user_id === userId)?.name ?? `알 수 없음(${userId})`;
}

function draftOf(id: number): Draft {
  return drafts.get(id) ?? emptyDraft();
}

function update(id: number, patch: Partial<Draft>): void {
  drafts.set(id, { ...draftOf(id), ...patch });
  render();
}

// ── 불러오기 ────────────────────────────────────────────────

async function load(): Promise<void> {
  const [candidateRes, memberRes] = await Promise.all([
    fetch(`${apiBase}/api/meetings/${meetingId}/candidates`),
    fetch(`${apiBase}/api/meetings/${meetingId}/members`),
  ]);
  if (!candidateRes.ok) throw new Error(`후보 조회 실패 (HTTP ${candidateRes.status})`);
  if (!memberRes.ok) throw new Error(`팀원 조회 실패 (HTTP ${memberRes.status})`);

  candidates = sortForReview((await candidateRes.json()) as Candidate[]);
  members = (await memberRes.json()) as Member[];
  context = { memberIds: members.map((m) => m.user_id), today: todayIso() };
  render();
}

// ── 그리기 ──────────────────────────────────────────────────

function render(): void {
  const summary = summarize(candidates, drafts, context);

  $('counts').textContent =
    `전체 ${summary.total} · 승인 ${summary.approving} · 거절 ${summary.rejecting} · ` +
    `미결정 ${summary.pending}`;

  $('attention').hidden = summary.needsAttention === 0;
  $('attention').textContent =
    `확신도가 낮은 후보 ${summary.needsAttention}건이 아직 결정되지 않았습니다. ` +
    '근거 발화를 확인하세요.';

  $('blocked').hidden = summary.blocked === 0;
  $('blocked').textContent = `승인하려는 후보 ${summary.blocked}건에 빠진 정보가 있습니다.`;

  ($('submit') as HTMLButtonElement).disabled = !canSubmit(summary);
  $('list').innerHTML = candidates.map(cardHtml).join('');
  wireCards();
}

function cardHtml(candidate: Candidate): string {
  const draft = draftOf(candidate.id);
  const blockers = approvalBlockers(candidate, draft, context);
  const decided = candidate.review_status !== 'pending';
  const low = candidate.confidence < LOW_CONFIDENCE;

  const options = [
    `<option value="">담당자 미지정</option>`,
    ...members.map((m) => {
      const selected = effectiveAssignee(candidate, draft) === m.user_id ? ' selected' : '';
      return `<option value="${m.user_id}"${selected}>${escapeHtml(m.name)}</option>`;
    }),
  ].join('');

  return `
<article class="card" data-id="${candidate.id}" data-decision="${draft.decision}">
  <header>
    <input class="title" type="text" value="${escapeHtml(effectiveTitle(candidate, draft))}"
           ${decided ? 'disabled' : ''} />
    <span class="conf ${low ? 'low' : ''}">확신도 ${(candidate.confidence * 100).toFixed(0)}%</span>
  </header>

  <div class="row">
    <label>담당자 <select class="assignee" ${decided ? 'disabled' : ''}>${options}</select></label>
    <label>마감일 <input class="deadline" type="date"
           value="${effectiveDeadline(candidate, draft) ?? ''}" ${decided ? 'disabled' : ''} /></label>
  </div>

  <p class="evidence">
    근거 발화 ${candidate.evidence_utterance_ids.length}건
    ${
      candidate.evidence_utterance_ids.length
        ? `<code>#${candidate.evidence_utterance_ids.join(', #')}</code>`
        : '<strong class="bad">— 회의에 없던 내용일 수 있습니다</strong>'
    }
  </p>

  ${
    blockers.length
      ? `<ul class="blockers">${blockers
          .map((b) => `<li>${escapeHtml(b.message)}</li>`)
          .join('')}</ul>`
      : ''
  }

  ${
    decided
      ? `<p class="done">이미 ${candidate.review_status === 'approved' ? '승인' : '거절'}된 후보입니다</p>`
      : `<div class="actions">
           <button class="approve${draft.decision === 'approve' ? ' on' : ''}"
                   ${blockers.length ? 'disabled' : ''}>승인</button>
           <button class="reject${draft.decision === 'reject' ? ' on' : ''}">거절</button>
           <button class="clear">보류</button>
         </div>
         <input class="note" type="text" placeholder="메모 (선택) — 왜 이렇게 결정했는지"
                value="${escapeHtml(draft.note ?? '')}" />`
  }
</article>`;
}

function wireCards(): void {
  for (const card of document.querySelectorAll<HTMLElement>('.card')) {
    const id = Number(card.dataset.id);
    const on = <T extends HTMLElement>(sel: string, ev: string, fn: (el: T) => void): void => {
      const el = card.querySelector<T>(sel);
      el?.addEventListener(ev, () => fn(el));
    };

    on<HTMLInputElement>('.title', 'change', (el) => update(id, { titleOverride: el.value }));
    on<HTMLSelectElement>('.assignee', 'change', (el) =>
      update(id, { assigneeOverride: el.value === '' ? null : Number(el.value) }),
    );
    on<HTMLInputElement>('.deadline', 'change', (el) =>
      update(id, { deadlineOverride: el.value === '' ? null : el.value }),
    );
    on<HTMLInputElement>('.note', 'change', (el) => update(id, { note: el.value }));

    const decide = (decision: Decision) => () => update(id, { decision });
    card.querySelector('.approve')?.addEventListener('click', decide('approve'));
    card.querySelector('.reject')?.addEventListener('click', decide('reject'));
    card.querySelector('.clear')?.addEventListener('click', decide('pending'));
  }
}

// ── 제출 ────────────────────────────────────────────────────

$('submit').addEventListener('click', async () => {
  let payload;
  try {
    payload = buildReviewPayload(reviewerId, candidates, drafts, context);
  } catch (error) {
    alert(error instanceof Error ? error.message : String(error));
    return;
  }

  const response = await fetch(`${apiBase}/api/meetings/${meetingId}/candidates/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    $('result').textContent = `제출 실패 (HTTP ${response.status})`;
    $('result').className = 'bad';
    return;
  }

  const result = (await response.json()) as {
    approved_count: number;
    approved_task_ids: number[];
    failures: Record<string, string[]>;
  };

  const failed = Object.entries(result.failures);
  $('result').className = failed.length ? 'bad' : 'ok';
  $('result').textContent = failed.length
    ? `${result.approved_count}건 승인, ${failed.length}건 실패: ` +
      failed.map(([id, codes]) => `#${id} ${codes.map(describeBlocker).join('/')}`).join(' · ')
    : `${result.approved_count}건이 칸반에 등록됐습니다 (task ${result.approved_task_ids.join(', ')})`;

  drafts.clear();
  await load();
});

load().catch((error: unknown) => {
  $('result').className = 'bad';
  $('result').textContent = error instanceof Error ? error.message : String(error);
});
