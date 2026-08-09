/**
 * 칸반 보드.
 *
 * ⚠️ 화면 코드라 자동 테스트가 없습니다. 판단이 들어가는 것은 전부
 * `src/lib/kanban/board.ts` 에 있고 테스트로 검증됩니다.
 */

import {
  describeLinkState,
  describePull,
  describeStatus,
  nextStatuses,
  sortLinks,
  statusPatch,
  summarize,
  taskWarnings,
  toColumns,
  type Task,
} from '../lib/kanban/board.ts';
import { isSessionExpired, loginUrlFor, safeApiBase, type Me } from '../lib/auth/session.ts';
import { escapeHtml } from '../lib/html.ts';
import { trySend, unreachableText } from '../lib/http/send.ts';
import { iconSvg } from '../lib/nav/icons.ts';
import { withJosa } from '../lib/text/josa.ts';
import { emptyHtml } from '../lib/ui/empty.ts';
import { describeHttpStatus, failureHtml } from '../lib/ui/failure.ts';
import { whileLoading, whilePressed } from '../lib/ui/pending.ts';
import { board as boardSkeleton, clearSkeleton, showSkeleton } from '../lib/ui/skeleton.ts';
import { renderNav } from './nav.ts';
import { bootApp } from './pwa.ts';

const params = new URLSearchParams(location.search);
// ⚠️ 주소창의 `?api=` 를 그대로 쓰면 **비밀번호와 회의 음성이 어디로
// 가는지**를 링크 하나로 바꿀 수 있다. safeApiBase 가 진짜 도메인에서는
// 무시하고, 로컬 화면에서 로컬 서버일 때만 통과시킨다.
const apiBase = safeApiBase(params.get('api'), location.origin);
const projectId = Number(params.get('project') ?? '1');

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`요소 없음: ${id}`);
  return el;
};

interface Member {
  user_id: number;
  name: string;
}

let tasks: Task[] = [];
let statuses: string[] = [];
let members: Member[] = [];

/** 로컬 자정 기준 오늘. `toISOString()` 은 UTC 라 한국에서 하루 어긋난다. */
function todayIso(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function goToLogin(): void {
  location.href = loginUrlFor(location.pathname + location.search);
}

const get = (path: string): Promise<Response> =>
  fetch(`${apiBase}${path}`, { credentials: 'same-origin', cache: 'no-store' });

function memberName(userId: number | null): string {
  if (userId === null) return '담당자 없음';
  return members.find((m) => m.user_id === userId)?.name ?? `사용자 #${userId}`;
}

function cardHtml(task: Task, today: string): string {
  const warnings = taskWarnings(task, today);
  const moves = nextStatuses(task, statuses)
    .map(
      (s) =>
        // ⚠️ `…로` 를 글자로 붙이면 안 된다. `진행 중` 은 받침이 있어
        // `진행 중으로` 다 — 붙여 놓은 동안 버튼에 **"진행 중로"** 가 떴다.
        `<button class="move" data-id="${task.id}" data-to="${escapeHtml(s)}">` +
        `${escapeHtml(withJosa(describeStatus(s), '으로로'))}</button>`,
    )
    .join('');

  return `
<article class="task" data-id="${task.id}">
  <p class="title">${escapeHtml(task.title)}</p>
  <p class="meta">
    ${escapeHtml(memberName(task.assignee_id))}
    ${task.deadline ? ` · 마감 ${escapeHtml(task.deadline)}` : ''}
  </p>
  ${
    // ⭐ 이 프로젝트의 주장이 화면에서 보이는 지점.
    // 이게 없으면 이 화면은 그냥 할 일 목록이다.
    task.origin
      ? `<p class="origin">${iconSvg('meeting')} ${escapeHtml(task.origin.meeting_title ?? '회의')}에서 나온 업무
           · 근거 발화 ${task.origin.evidence_utterance_ids.length}건</p>`
      : '<p class="origin manual">손으로 만든 업무</p>'
  }
  ${
    // ⭐ 대표 주장의 마지막 칸 — **이 업무가 어느 PR 로 끝났는가.**
    //
    // `task_github_links` 표는 처음부터 있었지만 잇는 코드가 0곳이라
    // 행이 한 번도 쓰인 적이 없었습니다. 여기가 그게 눈에 보이는 자리입니다.
    githubHtml(task)
  }
  ${
    warnings.length
      ? `<ul class="warn">${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`
      : ''
  }
  <div class="moves">${moves}</div>
</article>`;
}

function githubHtml(task: Task): string {
  const links = sortLinks(task.github ?? []);

  // ⚠️ 아무것도 안 붙었어도 침묵하지 않습니다. 빈 자리는 "PR 이 없구나" 가
  // 아니라 "연결이 고장났나" 로도 읽히고, 무엇보다 **표식을 안 알려주면
  // 아무도 안 적어서** 자동 연결이 영영 안 일어납니다.
  if (links.length === 0) {
    return `<p class="gh none">${escapeHtml(describeLinkState(task))}</p>`;
  }

  const items = links
    .map(
      (link) =>
        `<li class="${link.confirmed ? 'sure' : 'guess'}">` +
        `${escapeHtml(describePull(link))}` +
        `<span class="why">${escapeHtml(link.why)}</span></li>`,
    )
    .join('');

  return `<p class="gh">${escapeHtml(describeLinkState(task))}</p><ul class="gh-list">${items}</ul>`;
}

function render(): void {
  const today = todayIso();
  const summary = summarize(tasks, today);

  // 마지막 숫자가 이 프로젝트의 대표 주장이 **끝까지** 도는지를 봅니다 —
  // 회의에서 나온 업무가 실제 PR 로 이어진 건수.
  $('counts').textContent =
    `전체 ${summary.total} · 완료 ${summary.done} · 지연 ${summary.overdue} · ` +
    `회의에서 나온 업무 ${summary.fromMeetings} · PR이 붙은 업무 ${summary.withPulls}`;

  $('unassigned').hidden = summary.unassigned === 0;
  $('unassigned').textContent =
    `담당자가 없는 업무 ${summary.unassigned}건은 완료해도 기여도에 반영되지 않습니다.`;

  // ⚠️ 업무가 하나도 없으면 **열만 세 개** 서고 전부 "비어 있음" 입니다.
  // 그 화면은 아무것도 안 알려 주면서 고장처럼 보입니다 — 이 저장소가
  // 반복해 당한 "없는 것을 빈 것으로 답한다" 그대로입니다.
  if (summary.total === 0) {
    $('board').innerHTML = emptyHtml({
      what: '여기에는 팀의 업무 카드가 단계별로 놓입니다.',
      why: '아직 등록된 업무가 하나도 없습니다 — 고장이 아닙니다.',
      how: '회의를 열어 녹음하면 AI가 업무 후보를 뽑고, 승인한 것이 여기로 옵니다. 직접 만들 수도 있습니다.',
      action: { label: '회의 열기', href: `/project.html?project=${projectId}` },
    });
    return;
  }

  $('board').innerHTML = toColumns(tasks, statuses)
    .map(
      (column) => `
<section class="col">
  <h2>${escapeHtml(column.label)} <span class="n">${column.tasks.length}</span></h2>
  ${column.tasks.map((t) => cardHtml(t, today)).join('') || '<p class="empty">비어 있음</p>'}
</section>`,
    )
    .join('');

  for (const button of document.querySelectorAll<HTMLButtonElement>('.move')) {
    button.addEventListener('click', () => {
      void whilePressed(button, () => move(Number(button.dataset.id), button.dataset.to ?? ''));
    });
  }
}

async function move(taskId: number, to: string): Promise<void> {
  const response = await trySend(() =>
    fetch(`${apiBase}/api/projects/${projectId}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      // ⚠️ `statusPatch` 를 쓴다. 손으로 객체를 만들면서 `deadline: null` 을
      // 넣으면 서버가 마감일을 지운다.
      body: JSON.stringify(statusPatch(to)),
      credentials: 'same-origin',
    }),
  );

  if (response === null) {
    $('result').textContent = unreachableText('옮기지 못했습니다');
    return;
  }
  if (isSessionExpired(response.status)) {
    goToLogin();
    return;
  }
  if (!response.ok) {
    $('result').textContent = `옮기지 못했습니다 (HTTP ${response.status})`;
    return;
  }

  const updated = (await response.json()) as Task;
  tasks = tasks.map((t) => (t.id === updated.id ? updated : t));
  $('result').textContent = '';
  render();
}

/** 받아 오기만 한다. **그리지 않는다** — `load()` 의 주석 참고. */
async function fetchAll(): Promise<
  { kind: 'expired' } | { kind: 'failed'; status: number } | { kind: 'ok' }
> {
  // ⭐ 명단은 **프로젝트** 단위로 받는다.
  //
  // 예전에는 회의 단위 명단만 있어서, `?project=N` 만으로 이 화면을 열면
  // 명단을 받을 길이 없어 모든 이름이 `사용자 #3` 으로 떴다.
  const [boardRes, memberRes] = await Promise.all([
    get(`/api/projects/${projectId}/tasks`),
    get(`/api/projects/${projectId}/members`),
  ]);

  if (isSessionExpired(boardRes.status)) return { kind: 'expired' };
  if (!boardRes.ok) return { kind: 'failed', status: boardRes.status };

  const payload = (await boardRes.json()) as { statuses: string[]; tasks: Task[] };
  statuses = payload.statuses;
  tasks = payload.tasks;
  if (memberRes.ok) members = (await memberRes.json()) as Member[];
  return { kind: 'ok' };
}

async function load(): Promise<void> {
  // ⚠️ 받아 오기와 그리기를 나눕니다. 스켈레톤을 걷는 것은
  // `whileLoading` 의 `finally` 라, 그 안에서 그리면 방금 그린 것을
  // 곧바로 지울 수 있습니다.
  //
  // 열 수는 서버가 주는 상태 목록이 정하는데, 받기 전에는 모릅니다.
  // 셋으로 그립니다 — 지금까지 어느 팀도 셋이 아닌 적이 없고, 틀려도
  // 도착하는 순간 제 수로 맞춰집니다.
  const result = await whileLoading(
    fetchAll(),
    () => showSkeleton($('board'), boardSkeleton(3)),
    () => clearSkeleton($('board')),
  );

  if (result.kind === 'expired') {
    goToLogin();
    return;
  }
  if (result.kind === 'failed') {
    // ⚠️ 보드 자리에 씁니다. 예전에는 화면 맨 아래 `#result` 에 한 줄만
    // 남겼는데, 그러면 **보드는 텅 빈 채**로 있고 사람은 업무가 없는
    // 줄 압니다 — 실패와 0건이 같은 모양이 됩니다.
    $('board').innerHTML = failureHtml({
      what: '업무를 불러오지 못했습니다.',
      help: describeHttpStatus(result.status) ?? undefined,
      code: `HTTP ${result.status}`,
      retry: true,
    });
    wireRetry($('board'));
    return;
  }
  render();
}

/** 오류 화면의 [다시 불러오기] 를 잇는다. 안 이으면 그냥 놓인 버튼이다. */
function wireRetry(container: HTMLElement): void {
  container.querySelector<HTMLButtonElement>('.retry')?.addEventListener('click', () => {
    void load();
  });
}

async function start(): Promise<void> {
  const me = await get('/api/auth/me');
  if (!me.ok) {
    goToLogin();
    return;
  }
  $('who').textContent = `${((await me.json()) as Me).name} 님이 보고 있습니다`;
  await load();
}

void start();

renderNav('kanban');

// 서비스 워커 등록 + 설치 안내. 안 부르면 sw.js 는 그냥 놓인 파일이다.
bootApp();
