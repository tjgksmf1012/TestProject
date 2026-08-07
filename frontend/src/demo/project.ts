/**
 * 프로젝트 설정 — 초대 코드·GitHub 연결·회의 열기.
 *
 * ⚠️ 화면 코드라 자동 테스트가 없습니다. 판단은 전부
 * `src/lib/project/setup.ts` 에 있고 22개 테스트로 검증됩니다.
 */

import {
  formatCode,
  nextStepAfterCreate,
  normalizeRepo,
  repoProblem,
  titleProblem,
} from '../lib/project/setup.ts';
import { isSessionExpired, loginUrlFor, safeApiBase } from '../lib/auth/session.ts';
import { renderNav } from './nav.ts';
import { bootApp } from './pwa.ts';

const params = new URLSearchParams(location.search);
// ⚠️ 주소창의 `?api=` 를 그대로 쓰면 **비밀번호와 회의 음성이 어디로
// 가는지**를 링크 하나로 바꿀 수 있다. safeApiBase 가 진짜 도메인에서는
// 무시하고, 로컬 화면에서 로컬 서버일 때만 통과시킨다.
const apiBase = safeApiBase(params.get('api'), location.origin);
const projectId = Number(params.get('project') ?? '0');

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`요소 없음: ${id}`);
  return el;
};
const input = (id: string): HTMLInputElement => $(id) as HTMLInputElement;

interface Detail {
  project_id: number;
  title: string;
  github_repo: string | null;
  github_connected: boolean;
  invite_code: string;
  member_count: number;
}

function goToLogin(): void {
  location.href = loginUrlFor(location.pathname + location.search);
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (isSessionExpired(response.status)) goToLogin();
  return response;
}

function say(id: string, text: string): void {
  $(id).textContent = text;
  $(id).hidden = text === '';
}

function render(detail: Detail): void {
  $('title-heading').textContent = detail.title;
  input('title').value = detail.title;
  input('repo').value = detail.github_repo ?? '';
  // 네 글자마다 끊어 보여준다 — 여덟을 한 번에 읽으면 받아 적다 틀린다.
  // 서버가 하이픈·공백을 걷어내므로 이대로 복사해도 통한다.
  $('code').textContent = detail.invite_code ? formatCode(detail.invite_code) : '(없음)';
  $('members').textContent = `팀원 ${detail.member_count}명`;
  say('next', nextStepAfterCreate(detail.member_count));
  $('gh-state').textContent = detail.github_connected
    ? 'GitHub App 설치 id 가 연결돼 있습니다'
    : '설치 id 가 없습니다 — 저장소를 연결해도 PR 기여도는 수집되지 않습니다';
}

async function load(): Promise<void> {
  const response = await call(`/api/projects/${projectId}`);
  if (!response.ok) {
    say(
      'error',
      response.status === 403
        ? '이 프로젝트의 구성원만 볼 수 있습니다.'
        : `불러오지 못했습니다 (HTTP ${response.status})`,
    );
    return;
  }
  render((await response.json()) as Detail);
}

$('save-title').addEventListener('click', () => {
  const problem = titleProblem(input('title').value);
  if (problem) return say('error', problem);
  void call(`/api/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: input('title').value.trim() }),
  }).then(async (r) => {
    say('error', r.ok ? '' : `이름을 바꾸지 못했습니다 (HTTP ${r.status})`);
    if (r.ok) render((await r.json()) as Detail);
  });
});

$('save-repo').addEventListener('click', () => {
  const raw = input('repo').value;
  const problem = repoProblem(raw);
  if (problem) return say('error', problem);

  // 주소를 붙여넣었으면 고쳐서 보내고, 고친 결과를 칸에도 되돌려 준다 —
  // 무엇이 저장됐는지 보이지 않으면 다음에 또 주소를 넣는다.
  const repo = normalizeRepo(raw);
  input('repo').value = repo;

  void call(`/api/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify({ github_repo: repo }),
  }).then(async (r) => {
    if (r.status === 409) return say('error', '다른 프로젝트가 이미 이 저장소를 쓰고 있습니다.');
    say('error', r.ok ? '' : `저장하지 못했습니다 (HTTP ${r.status})`);
    if (r.ok) render((await r.json()) as Detail);
  });
});

$('rotate').addEventListener('click', () => {
  const ok = confirm(
    '초대 코드를 새로 만듭니다.\n지금 코드는 그 즉시 통하지 않습니다. 계속할까요?',
  );
  if (!ok) return;
  void call(`/api/projects/${projectId}/invite/rotate`, { method: 'POST' }).then(
    async (r) => {
      if (r.ok) render((await r.json()) as Detail);
    },
  );
});

$('copy').addEventListener('click', () => {
  void navigator.clipboard.writeText($('code').textContent ?? '').then(() => {
    $('copy').textContent = '복사됨';
    setTimeout(() => ($('copy').textContent = '코드 복사'), 1500);
  });
});

$('open-meeting').addEventListener('click', () => {
  const title = input('meeting-title').value.trim();
  void call(`/api/projects/${projectId}/meetings`, {
    method: 'POST',
    body: JSON.stringify({ title: title || null }),
  }).then(async (r) => {
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { detail?: string };
      return say('error', body.detail ?? `회의를 열지 못했습니다 (HTTP ${r.status})`);
    }
    const created = (await r.json()) as { meeting_id: number };
    location.href = `/lobby.html?meeting=${created.meeting_id}`;
  });
});

renderNav('project');
void load();

// 서비스 워커 등록 + 설치 안내. 안 부르면 sw.js 는 그냥 놓인 파일이다.
bootApp();
