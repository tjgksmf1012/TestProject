/**
 * 칸반 보드.
 *
 * ⚠️ 화면 코드라 자동 테스트가 없습니다. 판단이 들어가는 것은 전부
 * `src/lib/kanban/board.ts` 에 있고 33개 테스트로 검증됩니다.
 */

import {
  describeStatus,
  nextStatuses,
  statusPatch,
  summarize,
  taskWarnings,
  toColumns,
  type Task,
} from '../lib/kanban/board.ts';
import { isSessionExpired, loginUrlFor, safeApiBase, type Me } from '../lib/auth/session.ts';
import { escapeHtml } from '../lib/html.ts';
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
        `<button class="move" data-id="${task.id}" data-to="${escapeHtml(s)}">` +
        `${escapeHtml(describeStatus(s))}로</button>`,
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
      ? `<p class="origin">🗣 ${escapeHtml(task.origin.meeting_title ?? '회의')}에서 나온 업무
           · 근거 발화 ${task.origin.evidence_utterance_ids.length}건</p>`
      : '<p class="origin manual">손으로 만든 업무</p>'
  }
  ${
    warnings.length
      ? `<ul class="warn">${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`
      : ''
  }
  <div class="moves">${moves}</div>
</article>`;
}

function render(): void {
  const today = todayIso();
  const summary = summarize(tasks, today);

  $('counts').textContent =
    `전체 ${summary.total} · 완료 ${summary.done} · 지연 ${summary.overdue} · ` +
    `회의에서 나온 업무 ${summary.fromMeetings}`;

  $('unassigned').hidden = summary.unassigned === 0;
  $('unassigned').textContent =
    `담당자가 없는 업무 ${summary.unassigned}건은 완료해도 기여도에 반영되지 않습니다.`;

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
      void move(Number(button.dataset.id), button.dataset.to ?? '');
    });
  }
}

async function move(taskId: number, to: string): Promise<void> {
  const response = await fetch(`${apiBase}/api/projects/${projectId}/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    // ⚠️ `statusPatch` 를 쓴다. 손으로 객체를 만들면서 `deadline: null` 을
    // 넣으면 서버가 마감일을 지운다.
    body: JSON.stringify(statusPatch(to)),
    credentials: 'same-origin',
  });

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

async function load(): Promise<void> {
  // ⭐ 명단은 **프로젝트** 단위로 받는다.
  //
  // 예전에는 회의 단위 명단만 있어서, `?project=N` 만으로 이 화면을 열면
  // 명단을 받을 길이 없어 모든 이름이 `사용자 #3` 으로 떴다.
  const [boardRes, memberRes] = await Promise.all([
    get(`/api/projects/${projectId}/tasks`),
    get(`/api/projects/${projectId}/members`),
  ]);

  if (isSessionExpired(boardRes.status)) {
    goToLogin();
    return;
  }
  if (!boardRes.ok) {
    $('result').textContent =
      boardRes.status === 403
        ? '이 프로젝트의 구성원만 볼 수 있습니다.'
        : `불러오지 못했습니다 (HTTP ${boardRes.status})`;
    return;
  }

  const board = (await boardRes.json()) as { statuses: string[]; tasks: Task[] };
  statuses = board.statuses;
  tasks = board.tasks;
  if (memberRes.ok) members = (await memberRes.json()) as Member[];
  render();
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
