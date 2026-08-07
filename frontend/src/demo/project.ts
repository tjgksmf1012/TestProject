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
import { escapeHtml } from '../lib/html.ts';
import {
  confirmPrompt,
  describeOutcome,
  describeRequestFailure,
  whatGetsDeleted,
  whatHappensToMyScore,
  whatRemains,
  type RevokeResult,
} from '../lib/privacy/deletion.ts';
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

// ══════════════════════════════════════════════════════════════
// 내 녹음 지우기 (docs/07 P6)
//
// ⚠️ 엔드포인트를 만들고 **부르는 화면이 없었습니다.** 엔드포인트가 있는
// 것과 사람이 권리를 행사할 수 있는 것은 다릅니다 — 화면이 없으면 여전히
// 개발자에게 부탁해야 합니다.
//
// 판단은 전부 `src/lib/privacy/deletion.ts` 에 있고 20개 테스트가 붙습니다.
// ══════════════════════════════════════════════════════════════

function bullets(id: string, lines: string[]): void {
  $(id).innerHTML = lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('');
}

bullets('del-gone', whatGetsDeleted());
bullets('del-kept', whatRemains());
// 마크다운 강조(`**측정 불가**`)만 굵게 바꾼다. 문구 자체는 lib 이 정한다.
$('del-score').innerHTML = escapeHtml(whatHappensToMyScore()).replace(
  /\*\*([^*]+)\*\*/g,
  '<strong>$1</strong>',
);

$('del-run').addEventListener('click', () => {
  if (!confirm(confirmPrompt())) return;

  const button = $('del-run') as HTMLButtonElement;
  button.disabled = true;
  $('del-result').className = '';
  say('del-result', '지우는 중…');

  void call(`/api/projects/${projectId}/me/data`, { method: 'POST' })
    .then(async (response) => {
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { detail?: string };
        $('del-result').className = 'bad';
        say('del-result', describeRequestFailure(response.status, body.detail));
        button.disabled = false;
        return;
      }

      const outcome = describeOutcome((await response.json()) as RevokeResult);
      $('del-result').className = outcome.needsRetry ? 'bad' : '';
      say('del-result', outcome.text);

      // 다시 시도해야 하면 버튼을 살려 둔다. 성공했으면 되돌릴 수 없으므로
      // 다시 누를 이유가 없다 — 눌러도 "지울 녹음이 없습니다" 가 나온다.
      button.disabled = !outcome.needsRetry;
    })
    .catch(() => {
      $('del-result').className = 'bad';
      say('del-result', describeRequestFailure(0));
      button.disabled = false;
    });
});

renderNav('project');
void load();

// 서비스 워커 등록 + 설치 안내. 안 부르면 sw.js 는 그냥 놓인 파일이다.
bootApp();
