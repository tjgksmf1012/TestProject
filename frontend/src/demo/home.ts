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
import { detailText } from '../lib/http/detail.ts';
import { trySend, unreachableText } from '../lib/http/send.ts';
import { describeHttpStatus, failureHtml } from '../lib/ui/failure.ts';
import { whileLoading } from '../lib/ui/pending.ts';
import { clearSkeleton, projectCards, showSkeleton } from '../lib/ui/skeleton.ts';
import { renderNav } from './nav.ts';
import { wireLogout } from './logout.ts';
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

/** 받아 오기만 한다. **그리지 않는다** — 아래 주석 참고. */
async function fetchAll(): Promise<
  | { kind: 'expired' }
  | { kind: 'failed'; status: number }
  | { kind: 'ok'; html: string; hasProjects: boolean }
> {
  const response = await get('/api/projects');
  if (isSessionExpired(response.status)) return { kind: 'expired' };
  if (!response.ok) return { kind: 'failed', status: response.status };

  const projects = orderProjects((await response.json()) as Project[]);
  if (projects.length === 0) {
    return {
      kind: 'ok',
      hasProjects: false,
      html: `<p class="empty">${escapeHtml(emptyProjectsMessage())}</p>`,
    };
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

  return {
    kind: 'ok',
    hasProjects: true,
    html: projects.map((p, i) => projectHtml(p, meetings[i] ?? [])).join(''),
  };
}

async function load(): Promise<void> {
  // ⚠️ **받아 오기와 그리기를 나눕니다.** 스켈레톤을 걷는 것은
  // `whileLoading` 의 `finally` 이므로, 그 안에서 그리면 방금 그린
  // 것을 곧바로 지울 수 있습니다. 순서는 언제나
  // 받아 오기 → 스켈레톤 걷기 → 그리기 입니다.
  const result = await whileLoading(
    fetchAll(),
    () => showSkeleton($('projects'), projectCards()),
    () => clearSkeleton($('projects')),
  );

  if (result.kind === 'expired') {
    goToLogin();
    return;
  }
  if (result.kind === 'failed') {
    $('projects').innerHTML = failureHtml({
      what: '프로젝트 목록을 불러오지 못했습니다.',
      help: describeHttpStatus(result.status) ?? undefined,
      code: `HTTP ${result.status}`,
      retry: true,
    });
    $('projects')
      .querySelector<HTMLButtonElement>('.retry')
      ?.addEventListener('click', () => {
        void load();
      });
    return;
  }
  $('projects').innerHTML = result.html;

  // ⚠️ **한 화면에 주 버튼은 하나** (지시서 §8).
  //
  // 프로젝트가 이미 있으면 각 회의 카드의 "다음 할 일" 버튼이 주
  // 동작입니다 — 사람이 홈에 오는 이유가 그것입니다. 그때 "만들기"
  // 까지 청록으로 칠하면 **무엇부터 눌러야 하는지가 사라집니다.**
  //
  // 반대로 하나도 없으면 만들기가 유일한 길이므로 주 버튼이 맞습니다.
  $('create').classList.toggle('primary', !result.hasProjects);
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
  void trySend(() =>
    fetch(`${apiBase}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ title: raw.trim() }),
    }),
  ).then(async (response) => {
    if (response === null) return say(unreachableText('만들지 못했습니다'));
    if (!response.ok) {
      if (isSessionExpired(response.status)) return goToLogin();
      const body = await response.json().catch(() => null);
      return say(detailText(body, `만들지 못했습니다 (HTTP ${response.status})`));
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
  void trySend(() =>
    fetch(`${apiBase}/api/projects/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ invite_code: normalizeCode(raw) }),
    }),
  ).then(async (response) => {
    if (response === null) return say(unreachableText('참가하지 못했습니다'));
    if (!response.ok) {
      if (isSessionExpired(response.status)) return goToLogin();
      const body = await response.json().catch(() => null);
      return say(detailText(body, `참가하지 못했습니다 (HTTP ${response.status})`));
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

wireLogout({ button: $('logout'), note: $('logout-note'), apiBase });

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
