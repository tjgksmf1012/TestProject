/**
 * 첫 화면 — 로그인하면 여기로 옵니다.
 *
 * ⚠️ 화면 코드라 자동 테스트가 없습니다. 판단이 들어가는 것은 전부
 * `src/lib/home/next.ts` 에 있고 19개 테스트로 검증됩니다.
 */

import {
  describeMeetingStatus,
  describeProject,
  emptyProjectsMessage,
  formatMeetingTime,
  nextStepFor,
  orderProjects,
  type Meeting,
  type Project,
} from '../lib/home/next.ts';
import { isSessionExpired, loginUrlFor, type Me } from '../lib/auth/session.ts';
import { escapeHtml } from '../lib/html.ts';

const params = new URLSearchParams(location.search);
const apiBase = params.get('api') ?? '';

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`요소 없음: ${id}`);
  return el;
};

function goToLogin(): void {
  location.href = loginUrlFor(location.pathname + location.search);
}

const get = (path: string): Promise<Response> =>
  fetch(`${apiBase}${path}`, { credentials: 'same-origin', cache: 'no-store' });

function meetingHtml(meeting: Meeting): string {
  const step = nextStepFor(meeting);
  return `
<li class="meeting${step.actionable ? ' todo' : ''}">
  <div class="head">
    <span class="name">${escapeHtml(meeting.title ?? '제목 없는 회의')}</span>
    <span class="when">${escapeHtml(formatMeetingTime(meeting.started_at))}</span>
  </div>
  <p class="status">${escapeHtml(describeMeetingStatus(meeting.status))}
     — ${escapeHtml(step.reason)}</p>
  ${
    step.href
      ? `<a class="go${step.actionable ? ' primary' : ''}" href="${escapeHtml(step.href)}">
           ${escapeHtml(step.label)}</a>`
      : ''
  }
</li>`;
}

function projectHtml(project: Project, meetings: Meeting[]): string {
  const links =
    `<a href="/kanban.html?project=${project.project_id}">칸반</a>` +
    `<a href="/contributions.html?project=${project.project_id}">기여도</a>`;

  return `
<section class="project">
  <h2>${escapeHtml(project.title)}</h2>
  <p class="sub">${escapeHtml(describeProject(project))}</p>
  <div class="links">${links}</div>
  ${
    meetings.length
      ? `<ul class="meetings">${meetings.map(meetingHtml).join('')}</ul>`
      : '<p class="empty">회의를 열면 여기에 나옵니다.</p>'
  }
</section>`;
}

async function load(): Promise<void> {
  const response = await get('/api/projects');
  if (isSessionExpired(response.status)) {
    goToLogin();
    return;
  }
  if (!response.ok) {
    $('projects').textContent = `불러오지 못했습니다 (HTTP ${response.status})`;
    return;
  }

  const projects = orderProjects((await response.json()) as Project[]);
  if (projects.length === 0) {
    $('projects').innerHTML = `<p class="empty">${escapeHtml(emptyProjectsMessage())}</p>`;
    return;
  }

  // 프로젝트마다 회의를 받아 옵니다. 한 사람이 속한 프로젝트는 많아야
  // 몇 개라 병렬 요청으로 충분합니다 — 합쳐 주는 엔드포인트를 만들면
  // 그쪽이 또 화면 모양을 알아야 합니다.
  const meetings = await Promise.all(
    projects.map((p) =>
      get(`/api/projects/${p.project_id}/meetings`).then((r) =>
        r.ok ? (r.json() as Promise<Meeting[]>) : [],
      ),
    ),
  );

  $('projects').innerHTML = projects
    .map((project, index) => projectHtml(project, meetings[index] ?? []))
    .join('');
}

$('logout').addEventListener('click', () => {
  void fetch(`${apiBase}/api/auth/logout`, {
    method: 'POST',
    credentials: 'same-origin',
  }).then(() => {
    location.href = '/login.html';
  });
});

async function start(): Promise<void> {
  const me = await get('/api/auth/me');
  if (!me.ok) {
    goToLogin();
    return;
  }
  $('who').textContent = `${((await me.json()) as Me).name} 님`;
  await load();
}

void start();
