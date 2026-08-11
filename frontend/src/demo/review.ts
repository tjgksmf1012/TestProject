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
  attentionReasons,
  blockerLine,
  buildReviewPayload,
  canSubmit,
  describeBlocker,
  describeSubmitResult,
  effectiveAssignee,
  effectiveDeadline,
  effectiveTitle,
  emptyDraft,
  laneCounts,
  reviewLane,
  sortForReview,
  summarize,
  type Candidate,
  type Decision,
  type Draft,
  type Lane,
  type ReviewContext,
} from '../lib/review/candidates.ts';
import { iconSvg } from '../lib/nav/icons.ts';
import { isSessionExpired, loginUrlFor, safeApiBase, type Me } from '../lib/auth/session.ts';
import { attr, escapeHtml } from '../lib/html.ts';
import { describeUnexpected, tryGet, trySend, unreachableText } from '../lib/http/send.ts';
import { emptyHtml, type EmptyState } from '../lib/ui/empty.ts';
import { bylineHtml } from '../lib/ui/byline.ts';
import { mountEvidence, openEvidence } from './evidence.tsx';
import { failureHtml } from '../lib/ui/failure.ts';
import { whileLoading, whilePressed } from '../lib/ui/pending.ts';
import {
  agendaItems,
  hasExtraMinutes,
  issueViews,
  type UnresolvedIssue,
} from '../lib/review/minutes.ts';
import { todayInTeamCalendar } from '../lib/time/calendar.ts';
import { clearSkeleton, rows, showSkeleton } from '../lib/ui/skeleton.ts';
import { renderNav } from './nav.ts';
import { bootApp } from './pwa.ts';

interface Member {
  user_id: number;
  name: string;
  role_shares: Record<string, number>;
}

interface MeetingInfo {
  title: string | null;
  status: string;
  summary: string | null;
  next_agenda: string[];
  unresolved_issues: UnresolvedIssue[];
}

const params = new URLSearchParams(location.search);
// ⚠️ 주소창의 `?api=` 를 그대로 쓰면 **비밀번호와 회의 음성이 어디로
// 가는지**를 링크 하나로 바꿀 수 있다. safeApiBase 가 진짜 도메인에서는
// 무시하고, 로컬 화면에서 로컬 서버일 때만 통과시킨다.
const apiBase = safeApiBase(params.get('api'), location.origin);
const meetingId = Number(params.get('meeting') ?? '1');

const drafts = new Map<number, Draft>();
let candidates: Candidate[] = [];
let members: Member[] = [];
let meeting: MeetingInfo | null = null;
let context: ReviewContext = { memberIds: [], today: todayInTeamCalendar() };

/**
 * 지금 보고 있는 갈래 (브리프 §8).
 *
 * ⚠️ `'all'` 로 시작합니다. 검토 필요한 것만 먼저 보여 주고 싶었지만,
 * 그러면 사람이 **아무것도 안 했는데 목록이 걸러진 채**로 시작합니다 —
 * 승인·거절한 것이 어디로 갔는지 찾게 됩니다.
 */
let lane: Lane | 'all' = 'all';

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`요소 없음: ${id}`);
  return el;
};

/** 명단에 없는 user_id 도 사람이 볼 수 있게 이름을 만든다. */
function memberName(userId: number): string {
  return members.find((m) => m.user_id === userId)?.name ?? `알 수 없는 사용자 #${userId}`;
}

function draftOf(id: number): Draft {
  return drafts.get(id) ?? emptyDraft();
}

function update(id: number, patch: Partial<Draft>): void {
  drafts.set(id, { ...draftOf(id), ...patch });
  render();
}

// ── 불러오기 ────────────────────────────────────────────────

function goToLogin(): void {
  location.href = loginUrlFor(location.pathname + location.search);
}

// ⚠️ **읽기도 `tryGet` 을 거칩니다** (결함 102). 여기는 유일하게 말을
// 하긴 했는데, `error.message` 를 그대로 붙여 화면에 **`Failed to fetch`**
// 가 나왔습니다 (결함 103).
const get = (path: string): Promise<Response | null> => tryGet(`${apiBase}${path}`);

/** 받아 오기만 한다. **그리지 않는다** — `load()` 의 주석 참고. */
async function fetchAll(): Promise<'expired' | 'unreachable' | 'ok'> {
  const [candidateRes, memberRes, meetingRes] = await Promise.all([
    get(`/api/meetings/${meetingId}/candidates`),
    get(`/api/meetings/${meetingId}/members`),
    get(`/api/meetings/${meetingId}`),
  ]);
  // 셋 중 하나라도 닿지 못했으면 그건 연결 문제입니다 (결함 102).
  if (candidateRes === null || memberRes === null || meetingRes === null) {
    return 'unreachable';
  }
  if ([candidateRes, memberRes, meetingRes].some((r) => isSessionExpired(r.status))) {
    return 'expired';
  }
  if (!candidateRes.ok) throw new Error(`후보 조회 실패 (HTTP ${candidateRes.status})`);
  if (!memberRes.ok) throw new Error(`팀원 조회 실패 (HTTP ${memberRes.status})`);
  if (!meetingRes.ok) throw new Error(`회의 조회 실패 (HTTP ${meetingRes.status})`);

  candidates = sortForReview((await candidateRes.json()) as Candidate[]);
  members = (await memberRes.json()) as Member[];
  meeting = (await meetingRes.json()) as MeetingInfo;
  context = { memberIds: members.map((m) => m.user_id), today: todayInTeamCalendar() };
  return 'ok';
}

async function load(): Promise<void> {
  // ⚠️ 받아 오기와 그리기를 나눕니다. 스켈레톤을 걷는 것은
  // `whileLoading` 의 `finally` 라, 그 안에서 그리면 방금 그린 것을
  // 곧바로 지울 수 있습니다.
  const result = await whileLoading(
    fetchAll(),
    () => showSkeleton($('list'), rows(3)),
    () => clearSkeleton($('list')),
  );

  if (result === 'expired') {
    goToLogin();
    return;
  }
  if (result === 'unreachable') {
    $('list').innerHTML = failureHtml({
      what: unreachableText('업무 후보를 불러오지 못했습니다.'),
      retry: true,
    });
    $('list')
      .querySelector<HTMLButtonElement>('.retry')
      ?.addEventListener('click', () => {
        void load();
      });
    return;
  }
  render();
}

// ── 그리기 ──────────────────────────────────────────────────

/**
 * 회의록의 나머지 — 다음 안건 · 미해결 사안 (결함 110·111).
 *
 * ⚠️ **처리 전과 "정말 안 나왔다" 를 섞지 않습니다.** 아직 처리 중인
 * 회의에 "다음 안건 없음" 을 띄우면 사람이 그걸 결과로 읽습니다. 그래서
 * 있는 것만 그리고, 없으면 그 칸을 통째로 감춥니다 — 회의 상태는 이미
 * 후보 목록 쪽이 말하고 있습니다.
 */
function renderMinutes(): { agenda: number; issues: number; any: boolean } {
  const agenda = agendaItems(meeting?.next_agenda ?? []);
  const issues = issueViews(meeting?.unresolved_issues ?? []);

  $('agenda-block').hidden = agenda.length === 0;
  $('agenda').innerHTML = agenda.map((item) => `<li>${escapeHtml(item)}</li>`).join('');

  $('issues-block').hidden = issues.length === 0;
  $('issues').innerHTML = issues
    .map((view) => {
      // 시각은 근거가 있을 때만. 없으면 `0:00` 을 지어내지 않습니다.
      const at = view.at === null ? '' : `<span class="at">${escapeHtml(view.at)}</span>`;
      // ⚠️ 근거 0건도 **적습니다.** 감추면 근거 없는 사안이 근거 있는
      // 것과 똑같아 보입니다.
      const why =
        view.evidenceCount === 0
          ? '<span class="why none">근거 발화 없음</span>'
          : `<span class="why">근거 발화 ${view.evidenceCount}건</span>`;
      return `<li>${at}<span class="what">${escapeHtml(view.content)}</span>${why}</li>`;
    })
    .join('');

  // ⚠️ 접힘 상자 자체는 **회의 요약만 있어도** 섭니다. 예전에는 안건과
  // 미해결 사안이 있을 때만 서는 `#minutes` 였는데, 이제 요약도 같은
  // 상자 안에 들어갑니다.
  const extra = hasExtraMinutes({
    next_agenda: meeting?.next_agenda ?? [],
    unresolved_issues: meeting?.unresolved_issues ?? [],
  });
  return { agenda: agenda.length, issues: issues.length, any: extra };
}

/**
 * 접힌 회의 상자에 적을 **한 줄 요약** (브리프 §6).
 *
 * ⚠️ 여기서 숫자를 **지어내지 않습니다.** 브리프의 예시는
 * `결정 3 · 미결정 1` 인데 이 화면에는 "결정" 이라는 값이 없습니다.
 * 있는 것만 셉니다 — 요약이 있는가, 다음 안건 몇 개, 답 안 난 것 몇 개.
 */
function briefLine(counts: { agenda: number; issues: number }): string {
  const parts: string[] = [];
  if ((meeting?.summary ?? '') !== '') parts.push('회의 요약');
  if (counts.agenda > 0) parts.push(`다음 안건 ${counts.agenda}`);
  if (counts.issues > 0) parts.push(`답 안 난 것 ${counts.issues}`);
  return parts.join(' · ');
}

/** 탭 하나. 개수가 0 이어도 적는다 — 없는 것도 정보다. */
function laneTabs(counts: Record<Lane | 'all', number>): string {
  const tabs: [Lane | 'all', string][] = [
    ['all', '전체'],
    ['pending', '검토 필요'],
    ['approve', '등록'],
    ['reject', '거절'],
  ];
  return tabs
    .map(
      ([key, label]) =>
        `<button type="button" role="tab" data-lane="${key}"` +
        ` aria-selected="${key === lane}">${label}<span class="n">${counts[key]}</span></button>`,
    )
    .join('');
}

function render(): void {
  const summary = summarize(candidates, drafts, context);

  // 요약은 후보를 판단하는 맥락이다. 후보만 보고 승인하면 회의에서
  // 무슨 얘기가 오갔는지 모른 채 제목만 보고 누르게 된다.
  const text = meeting?.summary ?? '';
  $('meeting-summary').hidden = text === '';
  $('meeting-summary').textContent = text;

  const counts = renderMinutes();
  // 회의록이 하나도 없으면 상자 자체가 없습니다 — 접힌 빈 상자는
  // 눌러 볼 때까지 비었는지 알 수 없습니다.
  $('brief').hidden = !counts.any && text === '';
  $('brief-line').textContent = briefLine(counts);

  // ⚠️ 제출을 막는 이유는 **막대 안에서 한 번만** 말합니다. 예전에는
  // 화면 위 배너와 카드 안 빨간 줄이 같은 말을 했습니다 (브리프 §17).
  ($('submit') as HTMLButtonElement).disabled = !canSubmit(summary);
  $('result').textContent =
    summary.blocked > 0 ? `${summary.blocked}건에 빠진 정보가 있어 제출할 수 없습니다` : '';

  // ⚠️ 후보가 0건이면 목록이 통째로 빕니다. 그 화면은 고장으로
  // 읽히는데, 실제로는 셋 중 하나입니다 — 아직 처리 중이거나, 처리를
  // 마쳤는데 뽑을 게 없었거나, 처리에 실패했거나. **사람이 할 일이
  // 각각 다릅니다.** 앞은 기다리면 되고, 가운데는 기다려도 안 바뀌고,
  // 뒤는 트랙을 봐야 합니다. 하나로 덮으면 영원히 새로고침합니다.
  if (candidates.length === 0) {
    $('lanes').innerHTML = '';
    $('lane-empty').hidden = true;
    $('list').innerHTML = emptyHtml(emptyReviewState());
    return;
  }

  $('lanes').innerHTML = laneTabs(laneCounts(candidates, drafts));
  wireLanes();

  const shown = candidates.filter(
    (candidate) => lane === 'all' || reviewLane(candidate, draftOf(candidate.id)) === lane,
  );

  // ⚠️ **거른 결과가 0건인 것과 후보가 0건인 것은 다릅니다.** 위쪽
  // `emptyHtml` 을 여기에 쓰면 "녹음을 처리하는 중입니다" 같은 말이
  // 나오는데, 실제로는 사람이 방금 `거절` 탭을 누른 것뿐입니다.
  $('lane-empty').hidden = shown.length > 0;
  $('lane-empty').textContent = '이 상태인 후보가 없습니다';

  $('list').innerHTML = shown.map(cardHtml).join('');
  wireCards();
}

function wireLanes(): void {
  for (const tab of $('lanes').querySelectorAll<HTMLButtonElement>('button[data-lane]')) {
    tab.addEventListener('click', () => {
      lane = tab.dataset.lane as Lane | 'all';
      render();
    });
  }
}

/** 후보가 0건일 때, **회의 상태에 따라** 다른 말을 한다. */
function emptyReviewState(): EmptyState {
  const status = meeting?.status ?? '';
  const what = '여기에는 회의에서 뽑은 업무 후보가 나옵니다.';

  if (status === 'queued' || status === 'processing') {
    return {
      what,
      why: '녹음을 아직 처리하는 중입니다.',
      how: '끝나면 여기에 후보가 나옵니다. 잠시 뒤에 새로고침하세요.',
    };
  }
  if (status === 'failed') {
    return {
      what,
      why: '녹음 처리에 실패해서 후보를 만들지 못했습니다.',
      how: '로비에서 트랙이 온전한지 확인하세요 — 끊긴 구간이 많으면 처리가 실패합니다.',
      action: { label: '트랙 상태 보기', href: `/lobby.html?meeting=${meetingId}` },
    };
  }
  if (status === 'confirmed') {
    return {
      what,
      why: '이 회의의 후보는 모두 검토를 마쳤습니다.',
      how: '승인한 업무는 칸반에 있습니다.',
      action: { label: '칸반 보기', href: `/kanban.html?meeting=${meetingId}` },
    };
  }
  // needs_review 인데 0건 — 처리는 끝났고 뽑을 게 없었습니다.
  // **고장이 아니라 결과입니다.** 그렇게 말해 줘야 합니다.
  return {
    what,
    why: '처리는 끝났는데 업무로 뽑을 만한 발언이 없었습니다 — 고장이 아닙니다.',
    how: '회의에서 누가·무엇을·언제까지 하기로 했는지 말하면 그 발언이 후보가 됩니다.',
    action: { label: '칸반 보기', href: `/kanban.html?meeting=${meetingId}` },
  };
}

function cardHtml(candidate: Candidate): string {
  const draft = draftOf(candidate.id);
  const blockers = approvalBlockers(candidate, draft, context);
  const reasons = attentionReasons(candidate);
  const decided = candidate.review_status !== 'pending';
  const low = candidate.confidence < LOW_CONFIDENCE;

  const assignee = effectiveAssignee(candidate, draft);
  const known = members.some((m) => m.user_id === assignee);
  const options = [
    `<option value=""${assignee === null ? ' selected' : ''}>담당자 미지정</option>`,
    // 팀에서 빠졌거나 잘못 들어온 담당자도 반드시 보여준다.
    // 명단에 없다고 조용히 "미지정" 으로 그리면, 사람은 비어 있는 줄 알고
    // 그냥 승인해 버린다 — 서버가 unknown_assignee 로 막긴 하지만 이유를
    // 화면에서 먼저 알아야 고칠 수 있다.
    ...(assignee !== null && !known
      ? [`<option value="${assignee}" selected>${escapeHtml(memberName(assignee))}</option>`]
      : []),
    ...members.map((m) => {
      const selected = assignee === m.user_id ? ' selected' : '';
      return `<option value="${m.user_id}"${selected}>${escapeHtml(m.name)}</option>`;
    }),
  ].join('');

  const deadline = effectiveDeadline(candidate, draft) ?? '';
  const check = blockerLine(blockers);
  const evidence = candidate.evidence_utterance_ids;

  return `
<article class="cand" data-id="${candidate.id}" data-decision="${draft.decision}"
         data-done="${decided ? '1' : '0'}">
  <div class="cand-top">
    <input class="title" type="text" value=${attr(effectiveTitle(candidate, draft))}
           aria-label="업무 제목" ${decided ? 'disabled' : ''} />
    <span class="badge ${low ? 'low' : ''}"
          title="AI 확신도">${(candidate.confidence * 100).toFixed(0)}%</span>
  </div>

  <div class="fields">
    <label class="field sel" data-empty="${assignee === null ? '1' : '0'}">
      <span class="ico">${iconSvg('person')}</span>
      <span class="visually-hidden">담당자</span>
      <select class="assignee" ${decided ? 'disabled' : ''}>${options}</select>
    </label>
    <label class="field" data-empty="${deadline === '' ? '1' : '0'}">
      <span class="ico">${iconSvg('calendar')}</span>
      <span class="visually-hidden">마감일</span>
      <input class="deadline" type="date" value="${deadline}" ${decided ? 'disabled' : ''} />
    </label>
    ${
      // ⭐ **누를 수 있게 됐습니다** (docs/19 §24). 오랫동안 이 자리는
      // `근거 #5` 라고 **적기만** 했습니다 — 그 번호로 원문을 가져올
      // 엔드포인트가 없어서, 이 제품의 대표 주장(역추적)이 화면에서
      // 끊겨 있었습니다.
      evidence.length === 0
        ? '<span class="src none">근거 없음</span>'
        : `<button type="button" class="src" data-evidence="${evidence.join(',')}"` +
          ` data-title=${attr(effectiveTitle(candidate, draft))}>` +
          `근거 #${evidence.join(', #')}</button>`
    }
  </div>

  ${
    // 회의에서 부른 이름을 명단에서 못 찾았을 때만 보여준다. 이미 풀린
    // 담당자 옆에 원문을 또 띄우면 읽을 게 늘 뿐이다.
    candidate.assignee_hint && assignee === null
      ? `<p class="hint">회의에서는 <strong>${escapeHtml(candidate.assignee_hint)}</strong>
           라고 했습니다 — 명단에서 찾지 못했습니다</p>`
      : ''
  }

  ${
    // ⭐ 막는 이유는 **한 줄**입니다 (브리프 §13). 안 채운 칸은 흙빛,
    // 실제로 잘못된 것만 빨강 — `blockerLine` 이 가릅니다.
    check.tone === 'none'
      ? ''
      : `<p class="check" data-tone="${check.tone}">${escapeHtml(check.text)}</p>`
  }

  ${
    // 서버가 무엇을 확신하지 못했는가. 사람이 화면에서 고쳐도 남는다 —
    // blockers 와 달리 이건 판정이 아니라 기록이다.
    //
    // ⚠️ **통째로 접습니다.** 승인을 막는 것이 아니므로 위의 한 줄보다
    // 조용해야 합니다. 접어도 **한 번의 클릭 안에** 있습니다.
    reasons.length
      ? `<details class="why-not"><summary>확신하지 못한 이유 ${reasons.length}건</summary>` +
        `<ul>${reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul></details>`
      : ''
  }

  ${
    decided
      ? `<p class="done">이미 ${candidate.review_status === 'approved' ? '등록' : '거절'}된 후보입니다</p>`
      : `<div class="acts">
           <button class="approve${draft.decision === 'approve' ? ' on' : ''}"
                   ${blockers.length ? 'disabled' : ''}>업무로 등록</button>
           <button class="clear${draft.decision === 'pending' ? ' on' : ''}">나중에 검토</button>
           <button class="reject${draft.decision === 'reject' ? ' on' : ''}">거절</button>
         </div>
         ${
           // ⭐ 메모는 **결정한 뒤에만** 나옵니다.
           //
           // 카드마다 빈 입력 상자가 하나씩 있으면 목록이 폼처럼 보이고
           // (브리프 §9), 후보 셋이면 아무도 안 쓴 상자가 셋입니다.
           // 게다가 이 칸의 placeholder 는 "왜 **이렇게 결정했는지**"
           // 입니다 — 결정하기 전에는 설명할 것이 없습니다.
           //
           // ⚠️ 없애는 게 아닙니다. 결정하는 순간 같은 자리에 나옵니다.
           draft.decision === 'pending'
             ? ''
             : `<input class="memo" type="text" placeholder="메모 (선택) — 왜 이렇게 결정했는지"
                aria-label="메모" value=${attr(draft.note ?? '')} />`
         }`
  }
</article>`;
}

function wireCards(): void {
  for (const card of document.querySelectorAll<HTMLElement>('.cand')) {
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
    on<HTMLInputElement>('.memo', 'change', (el) => update(id, { note: el.value }));

    on<HTMLButtonElement>('button.src', 'click', (el) => {
      const ids = (el.dataset.evidence ?? '')
        .split(',')
        .map(Number)
        .filter((n) => Number.isFinite(n));
      openEvidence(ids, el.dataset.title ?? '');
    });

    const decide = (decision: Decision) => () => update(id, { decision });
    card.querySelector('.approve')?.addEventListener('click', decide('approve'));
    card.querySelector('.reject')?.addEventListener('click', decide('reject'));
    card.querySelector('.clear')?.addEventListener('click', decide('pending'));
  }
}

// ── 제출 ────────────────────────────────────────────────────

$('submit').addEventListener('click', () => {
  // 누르는 동안 잠근다 (결함 89). ⚠️ 원래 상태로 되돌리므로, 결정한
  // 항목이 없어 잠겨 있어야 하는 경우가 요청 한 번에 풀리지 않는다.
  void whilePressed($('submit') as HTMLButtonElement, async () => {
    let payload;
    try {
      payload = buildReviewPayload(candidates, drafts, context);
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
      return;
    }

    const response = await trySend(() =>
      fetch(`${apiBase}/api/meetings/${meetingId}/candidates/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'same-origin',
      }),
    );

    if (response === null) {
      $('result').textContent = unreachableText('제출하지 못했습니다');
      $('result').className = 'bad';
      return;
    }

    if (isSessionExpired(response.status)) {
      goToLogin();
      return;
    }

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
      : describeSubmitResult(result.approved_count, result.approved_task_ids);

    drafts.clear();
    await load();
  });
});

async function start(): Promise<void> {
  const response = await get('/api/auth/me');
  // 닿지 못한 것을 만료로 읽으면 이유도 모른 채 로그아웃당합니다.
  if (response === null) {
    await load();
    return;
  }
  if (!response.ok) {
    goToLogin();
    return;
  }
  const me = (await response.json()) as Me;
  // ⭐ 검토자는 **문장이 아니라 꼬리표**입니다 (브리프 §5). "김민수 님이
  // 검토하고 있습니다" 는 바로 위 설명문과 같은 크기·같은 모양이라,
  // 화면 맨 위 넉 줄이 전부 같은 무게였습니다.
  //
  // ⚠️ 손으로 만들지 않습니다 — `bylineHtml` 이 머리글자를 `Array.from`
  // 으로 떼고(대리쌍) 이스케이프까지 합니다. 화면 넷이 같은 것을 그려서
  // lib 으로 옮겼습니다.
  $('who').innerHTML = bylineHtml(me.name, '검토 중');
  $('who').hidden = false;
  await load();
}

start().catch((error: unknown) => {
  // ⚠️ 목록 자리에 씁니다. 예전에는 화면 맨 아래 `#result` 에만 한 줄
  // 남겼는데, 그러면 목록은 **텅 빈 채**로 있고 사람은 후보가 0건인
  // 줄 압니다 — 실패와 0건이 같은 모양이 됩니다.
  // ⚠️ 예전에는 `error.message` 를 `help` 에 붙였습니다 (결함 103).
  // 연결이 끊기면 한글 화면에 **`Failed to fetch`** 가 그대로 나왔습니다 —
  // 결함 87 이 금지한 바로 그것인데, 그 가드는 `${String(err)}` 만 봐서
  // **변수에 담아 쓰는 이 모양을 놓쳤습니다.** 원문은 콘솔에 남깁니다.
  console.error('업무 후보 조회 실패', error);
  $('list').innerHTML = failureHtml({
    what: '업무 후보를 불러오지 못했습니다.',
    help: describeUnexpected(),
    retry: true,
  });
  $('list')
    .querySelector<HTMLButtonElement>('.retry')
    ?.addEventListener('click', () => {
      void load();
    });
});

// 근거 발화 상자를 한 번 붙인다. 카드마다 붙이지 않습니다 — 목록이
// 다시 그려질 때마다 React 루트가 늘어납니다.
mountEvidence(apiBase, meetingId);

renderNav('review');

// 서비스 워커 등록 + 설치 안내. 안 부르면 sw.js 는 그냥 놓인 파일이다.
bootApp();
