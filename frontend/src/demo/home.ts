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
import { isSessionExpired, loginUrlFor, safeApiBase, type Me } from '../lib/auth/session.ts';
import {
  CODE_LENGTH,
  codeProblem,
  formatCode,
  normalizeCode,
  titleProblem,
} from '../lib/project/setup.ts';
import { escapeHtml } from '../lib/html.ts';
import { renderNav } from './nav.ts';
import { bootApp } from './pwa.ts';

const params = new URLSearchParams(location.search);
// ⚠️ 주소창의 `?api=` 를 그대로 쓰면 **비밀번호와 회의 음성이 어디로
// 가는지**를 링크 하나로 바꿀 수 있다. safeApiBase 가 진짜 도메인에서는
// 무시하고, 로컬 화면에서 로컬 서버일 때만 통과시킨다.
const apiBase = safeApiBase(params.get('api'), location.origin);

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
      ? `<a class="btn btn-block${step.actionable ? ' btn-primary' : ''}"
             href="${escapeHtml(step.href)}">${escapeHtml(step.label)}</a>`
      : ''
  }
</li>`;
}

function projectHtml(project: Project, meetings: Meeting[]): string {
  const links =
    `<a class="btn" href="/kanban.html?project=${project.project_id}">칸반</a>` +
    `<a class="btn" href="/contributions.html?project=${project.project_id}">기여도</a>` +
    // 회의를 여는 곳·초대 코드를 보는 곳이 여기뿐이다. 이 링크가 없으면
    // 프로젝트를 만들어 놓고도 다음 단계로 갈 방법이 없다.
    `<a class="btn" href="/project.html?project=${project.project_id}">설정</a>`;

  return `
<section class="card project">
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

// ══════════════════════════════════════════════════════════════
// 시작하는 두 가지 방법
//
// ⭐ 이게 없던 동안 **가입한 첫 사용자는 할 수 있는 일이 없었습니다.**
// `POST /api/projects` 는 `member_ids: list[int]` 를 받는데 화면에서는
// 그걸 채울 수 없었고(남의 user_id 를 모릅니다), 그래서 첫 화면은
// "팀원이 넣어 주기를 기다리세요" 로 끝났습니다 — 그 팀원도 같은
// 화면을 보고 있었습니다.
// ══════════════════════════════════════════════════════════════

const input = (id: string): HTMLInputElement => $(id) as HTMLInputElement;

function say(text: string): void {
  $('start-error').textContent = text;
  $('start-error').hidden = text === '';
}

$('create').addEventListener('click', () => {
  const raw = input('new-title').value;
  const problem = titleProblem(raw);
  if (problem) return say(problem);

  say('');
  void fetch(`${apiBase}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ title: raw.trim() }),
  }).then(async (response) => {
    if (!response.ok) {
      if (isSessionExpired(response.status)) return goToLogin();
      const body = (await response.json().catch(() => ({}))) as { detail?: string };
      return say(body.detail ?? `만들지 못했습니다 (HTTP ${response.status})`);
    }
    // 만든 직후에는 혼자다. 목록으로 돌려보내면 초대 코드를 한 번 더
    // 찾아가야 하므로, 코드가 있는 화면으로 바로 보낸다.
    const created = (await response.json()) as { project_id: number };
    location.href = `/project.html?project=${created.project_id}`;
  });
});

$('join').addEventListener('click', () => {
  const raw = input('code').value;
  const problem = codeProblem(raw);
  if (problem) return say(problem);

  say('');
  void fetch(`${apiBase}/api/projects/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ invite_code: normalizeCode(raw) }),
  }).then(async (response) => {
    if (!response.ok) {
      if (isSessionExpired(response.status)) return goToLogin();
      const body = (await response.json().catch(() => ({}))) as { detail?: string };
      return say(body.detail ?? `참가하지 못했습니다 (HTTP ${response.status})`);
    }
    // 이미 구성원이어도 성공이다 — 그때는 그냥 그 프로젝트로 간다.
    const joined = (await response.json()) as { project_id: number };
    location.href = `/project.html?project=${joined.project_id}`;
  });
});

// 화면이 하이픈을 보여주므로 사람은 하이픈을 친다. 치는 대로 끊어 준다.
input('code').addEventListener('blur', () => {
  const clean = normalizeCode(input('code').value);
  if (clean.length === CODE_LENGTH) input('code').value = formatCode(clean);
});

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

// 홈은 프로젝트를 아직 안 고른 상태라 칸반·기여도·설정 탭이 흐리게 나옵니다.
// 그래도 **그려야** 합니다 — 안 그리면 `<nav id="tabs">` 가 빈 채로 남고,
// PC 에서는 그게 아무것도 없는 줄로 화면 위에 그어집니다.
renderNav('home');

// 서비스 워커 등록 + 설치 안내. 안 부르면 sw.js 는 그냥 놓인 파일이다.
bootApp();
