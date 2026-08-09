/**
 * 프로젝트 설정 — 초대 코드·GitHub 연결·회의 열기.
 *
 * ⚠️ 화면 코드라 자동 테스트가 없습니다. 판단은 전부
 * `src/lib/project/setup.ts` 에 있고 22개 테스트로 검증됩니다.
 */

import {
  NO_CODE,
  codeToCopy,
  formatCode,
  nextStepAfterCreate,
  normalizeRepo,
  repoProblem,
  titleProblem,
} from '../lib/project/setup.ts';
import { isSessionExpired, loginUrlFor, safeApiBase } from '../lib/auth/session.ts';
import { copySucceeded, copyText, describeCopy } from '../lib/ui/copy.ts';
import {
  describeHealth,
  describeHealthFailure,
  type GithubHealth,
  type HealthView,
} from '../lib/github/health.ts';
import {
  describeRoles,
  problemWith,
  ROLE_OPTIONS,
  sumOf,
  toPayload as rolesToPayload,
} from '../lib/contribution/roles.ts';
import { escapeHtml } from '../lib/html.ts';
import { detailText } from '../lib/http/detail.ts';
import { trySend, unreachableText } from '../lib/http/send.ts';
import {
  confirmPrompt,
  describeOutcome,
  describeRequestFailure,
  whatGetsDeleted,
  whatHappensToMyScore,
  whatRemains,
  type RevokeResult,
} from '../lib/privacy/deletion.ts';
import { showNote } from '../lib/ui/failure.ts';
import { whileLoading, whilePressed } from '../lib/ui/pending.ts';
import { clearSkeleton, rows, showSkeleton } from '../lib/ui/skeleton.ts';
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

/**
 * `Content-Type` 을 붙이되 **겹치지 않게.**
 *
 * ⚠️ 예전에는 이랬습니다.
 *
 *     headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
 *
 * 자바스크립트 객체 키는 대소문자를 구분하고 **HTTP 헤더는 안 합니다.**
 * 호출부가 `content-type`(소문자)을 주면 두 키가 **둘 다 살아남아**
 *
 *     Content-Type: application/json, application/json
 *
 * 이 나갑니다. FastAPI 는 그걸 JSON 으로 안 보고 422 를 주는데, 화면에는
 * 그냥 "실패" 로만 보입니다. 브라우저에서 버튼을 눌러 보고 나서야
 * 찾았습니다.
 *
 * `Headers` 는 이름을 대소문자 무시로 다루므로 겹칠 수가 없습니다.
 */
function withJsonType(given: HeadersInit | undefined): Headers {
  const headers = new Headers(given);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return headers;
}

async function call(path: string, init?: RequestInit): Promise<Response | null> {
  // ⚠️ **닿지 못하면 `null`** (결함 102). 예전에는 맨 `fetch` 라 읽기가
  // 끊기면 던졌고, 그 뒤가 `void load…()` 면 거부가 아무 데도 안 걸려
  // 화면이 조용히 빈 채로 남았습니다.
  const response = await trySend(() =>
    fetch(`${apiBase}${path}`, {
      ...init,
      headers: withJsonType(init?.headers),
      credentials: 'same-origin',
      cache: 'no-store',
    }),
  );
  if (response !== null && isSessionExpired(response.status)) goToLogin();
  return response;
}

/**
 * `call` 과 같지만 **서버에 닿지 못하면 `null`.**
 *
 * 누르면 무언가 바뀌는 요청은 전부 이걸 쓴다. 예전에는 `void call(…)`
 * 뒤에 `.then` 만 달아 둬서, 연결이 끊기면 거부가 아무 데도 안 걸리고
 * 화면은 **아무 말도 안 했다** (결함 87).
 */
// ⚠️ `call` 이 이미 `null` 을 돌려줍니다 (결함 102) — 여기서 또 감싸지
// 않습니다. 이름은 남깁니다: 부르는 쪽이 "바꾸는 요청" 임을 읽습니다.
const send = (path: string, init?: RequestInit): Promise<Response | null> =>
  call(path, init);

function say(id: string, text: string): void {
  $(id).textContent = text;
  $(id).hidden = text === '';
}

/** 지금 초대 코드. **화면 글자가 아니라 데이터**에서 복사한다 (결함 71). */
let inviteCode: string | null = null;

function render(detail: Detail): void {
  $('title-heading').textContent = detail.title;
  input('title').value = detail.title;
  input('repo').value = detail.github_repo ?? '';
  // 네 글자마다 끊어 보여준다 — 여덟을 한 번에 읽으면 받아 적다 틀린다.
  // 서버가 하이픈·공백을 걷어내므로 이대로 복사해도 통한다.
  inviteCode = detail.invite_code || null;
  $('code').textContent = inviteCode ? formatCode(inviteCode) : NO_CODE;
  // ⚠️ **없는 것을 코드처럼 보이게 두지 않습니다.** `#code` 는 초대 코드용
  // 조판(굵은 고정폭 24px, 자간 넓힘)인데, `(없음)` 까지 그렇게 그리면
  // 그것도 코드로 읽힙니다 — 결함 71 이 고친 오해를 조판이 거들게 됩니다.
  $('code').classList.toggle('none', inviteCode === null);

  // ⚠️ 코드가 없으면 **누를 수 없게** 합니다. 예전에는 눌리는 채로 두고
  // 화면 글자를 복사했는데, 그러면 클립보드에 `(없음)` 이 들어가고 버튼은
  // "복사됨" 이라고 말했습니다. 그걸 카톡으로 받은 사람은 참가 칸에
  // `(없음)` 을 넣고 "코드가 없습니다" 를 보고 **자기를 의심합니다.**
  const button = $('copy') as HTMLButtonElement;
  button.disabled = inviteCode === null;
  button.title = inviteCode === null ? '초대 코드가 없습니다 — 새로 만들어 주세요' : '';
  $('members').textContent = `팀원 ${detail.member_count}명`;
  say('next', nextStepAfterCreate(detail.member_count));
}

// ══════════════════════════════════════════════════════════════
// GitHub 연결 진단 (docs/15 §4.2)
//
// ⚠️ 예전에는 이 자리에 한 줄이 있었습니다 — "설치 id 가 연결돼 있습니다".
// 그 설치 id 는 **화면에서 아무 숫자나 보내면 채워졌고**, 그래서 아무것도
// 확인하지 않은 채로 "연결됨" 을 보여주고 있었습니다.
//
// 지금은 서버가 실제 사실(배달이 왔는가·서명이 맞았는가·활동 계정이
// 팀원과 이어지는가)로 판단하고, 화면은 그 판단과 **지금 할 일**을
// 그대로 옮깁니다.
// ══════════════════════════════════════════════════════════════

/** 마크다운의 `백틱`만 굵게. 문구 자체는 서버가 정한다. */
function withCode(text: string): string {
  return escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>');
}

function renderHealth(view: HealthView): void {
  $('gh-health').className = `health ${view.tone}`;
  $('gh-headline').innerHTML = withCode(view.headline);
  $('gh-detail').innerHTML = withCode(view.detail);

  $('gh-next').innerHTML = view.nextStep ? withCode(view.nextStep) : '';
  $('gh-next').hidden = !view.nextStep;

  $('gh-warnings').innerHTML = view.warnings
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join('');

  $('gh-activity').textContent = view.activity;
  $('gh-activity').hidden = view.activity === '';

  // "이 수치는 언제부터의 활동인가". 범위를 안 밝힌 숫자는 **전부를 센
  // 것처럼** 읽힙니다.
  $('gh-coverage').textContent = view.coverage;
  $('gh-coverage').hidden = view.coverage === '';

  // ⚠️ 배달이 0건일 때는 안 보입니다. 연결도 안 됐는데 "가져오기" 를
  // 누르면 아무 일이 없고, 사람은 그게 고장인 줄 압니다.
  $('gh-backfill').hidden = !view.canBackfill;
}

async function startBackfill(): Promise<void> {
  const button = $('gh-backfill') as HTMLButtonElement;
  const status = $('gh-backfill-status');
  button.disabled = true;
  status.hidden = false;
  status.textContent = '가져오는 중…';

  // ⚠️ `headers` 를 다시 주지 않습니다. `call()` 이 이미
  // `Content-Type` 을 넣는데, 여기서 `content-type` 을 또 주면
  // **자바스크립트 객체 키는 대소문자를 구분하고 HTTP 헤더는 안
  // 하므로** 둘 다 살아남아 `application/json, application/json` 이
  // 나갑니다. FastAPI 는 그걸 JSON 으로 안 보고 422 를 줍니다.
  const response = await send(`/api/projects/${projectId}/github/backfill`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (response === null) {
    button.disabled = false;
    status.textContent = unreachableText('가져오지 못했습니다');
    return;
  }

  if (!response.ok) {
    button.disabled = false;
    // 409 는 "왜 안 되는지" 를 서버가 문장으로 줍니다 — 저장소가 없거나
    // App 자격 증명이 없거나. 그대로 보여 줍니다.
    const body = await response.json().catch(() => null);
    status.textContent = detailText(
      body,
      `가져오지 못했습니다 (HTTP ${response.status})`,
    );
    return;
  }

  // ⚠️ **"완료" 라고 말하지 않습니다.** 서버는 큐에 넣었을 뿐이고 워커가
  // 실제로 가져오는 데는 시간이 걸립니다. 여기서 완료라고 하면 사람은
  // 바로 기여도를 보러 가서 "안 늘었네" 라고 읽습니다.
  status.textContent =
    '가져오기를 시작했습니다. PR 수에 따라 몇 분 걸립니다 — ' +
    '잠시 뒤 이 화면을 새로고침하면 반영된 범위가 바뀝니다.';
}

/** 역할 칸을 그린다. 서버가 준 지금 값이 기본으로 들어간다. */
function renderRoles(shares: Record<string, number>): void {
  $('roles').innerHTML = ROLE_OPTIONS.map(
    (opt) => `<label>
      <span>${escapeHtml(opt.label)}</span>
      <input type="number" class="rshare" data-role="${opt.key}" step="0.1" min="0" max="1"
        value="${shares[opt.key] ?? 0}" aria-label="${escapeHtml(opt.label)} 비중" />
      <span class="hint">${escapeHtml(opt.hint)}</span>
    </label>`,
  ).join('');
  for (const input of $('roles').querySelectorAll<HTMLInputElement>('.rshare')) {
    input.addEventListener('input', showRoleSum);
  }
  showRoleSum();
}

function rolesFromScreen(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const input of $('roles').querySelectorAll<HTMLInputElement>('.rshare')) {
    // 빈 칸은 0 으로 친다 — 역할에서는 "안 적었다" 가 곧 "이 역할은 아니다" 다.
    // (확정 화면의 빈 칸과 다르다. 거기서는 빈 칸이 "안 건드렸다" 였다.)
    const raw = input.value.trim();
    out[input.dataset['role'] ?? ''] = raw === '' ? 0 : Number(raw);
  }
  return out;
}

function showRoleSum(): void {
  const total = sumOf(rolesFromScreen());
  const bad = Math.abs(total - 1) > 1e-6;
  $('role-sum').textContent = `합계 ${total}`;
  $('role-sum').classList.toggle('bad', bad);
}

async function loadRoles(): Promise<void> {
  const response = await call(`/api/projects/${projectId}/members`);
  if (response === null || !response.ok) return;
  const members = (await response.json()) as { user_id: number; role_shares?: Record<string, number> }[];
  const meRes = await call('/api/auth/me');
  if (meRes === null || !meRes.ok) return;
  const me = (await meRes.json()) as { user_id: number };
  const mine = members.find((entry) => entry.user_id === me.user_id);
  renderRoles(mine?.role_shares ?? {});
  // ⚠️ 상태·문제·실패·성공이 **한 자리**에 옵니다. 그래서 `showNote` 로
  // 색까지 같이 정합니다 — 글자만 바꾸면 실패가 상태처럼 보입니다 (결함 98).
  showNote($('role-message'), `지금 ${describeRoles(mine?.role_shares)}`, 'plain');
}

async function saveRoles(): Promise<void> {
  const shares = rolesFromScreen();
  const problem = problemWith(shares);
  if (problem !== null) {
    showNote($('role-message'), problem);
    return;
  }
  const response = await send(`/api/projects/${projectId}/members/me`, {
    method: 'PATCH',
    body: JSON.stringify({ role_shares: rolesToPayload(shares) }),
  });
  if (response === null) {
    showNote($('role-message'), unreachableText('역할을 저장하지 못했습니다'));
    return;
  }
  const body = await response.json();
  if (!response.ok) {
    showNote($('role-message'), detailText(body, '역할을 저장하지 못했습니다'));
    return;
  }
  showNote($('role-message'), `저장했습니다 — ${describeRoles(body.role_shares)}`, 'plain');
}

async function loadHealth(): Promise<void> {
  // ⚠️ 예전에는 HTML 에 "연결 상태를 확인하는 중…" 을 심어 뒀습니다.
  // 이 요청은 거의 언제나 200ms 안에 끝나므로, 그 문구는 **화면을 열
  // 때마다 한 번 깜빡이기만** 했습니다 (지시서 §4.7).
  const response = await whileLoading(
    call(`/api/projects/${projectId}/github`),
    () => showSkeleton($('gh-headline'), rows(1)),
    () => clearSkeleton($('gh-headline')),
  );
  // ⚠️ 여기서 조용히 넘어가면 진단 구역이 비고, **빈 구역은 사람 눈에
  // "문제 없음" 으로 보입니다.** 못 물어봤다는 것과 괜찮다는 것은 다릅니다.
  if (response === null) return renderHealth(describeHealthFailure(0));
  if (!response.ok) return renderHealth(describeHealthFailure(response.status));
  renderHealth(describeHealth((await response.json()) as GithubHealth, new Date()));
}

async function load(): Promise<void> {
  const response = await call(`/api/projects/${projectId}`);
  if (response === null) {
    // 빈 화면은 "설정할 게 없다" 로 읽힙니다 (결함 102).
    say('error', unreachableText('프로젝트를 불러오지 못했습니다'));
    return;
  }
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
  void whilePressed($('save-title') as HTMLButtonElement, async () => {
    const r = await send(`/api/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: input('title').value.trim() }),
    });
    if (r === null) return say('error', unreachableText('이름을 바꾸지 못했습니다'));
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

  void whilePressed($('save-repo') as HTMLButtonElement, async () => {
    const r = await send(`/api/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({ github_repo: repo }),
    });
    if (r === null) return say('error', unreachableText('저장하지 못했습니다'));
    if (r.status === 409) return say('error', '다른 프로젝트가 이미 이 저장소를 쓰고 있습니다.');
    say('error', r.ok ? '' : `저장하지 못했습니다 (HTTP ${r.status})`);
    if (!r.ok) return;
    render((await r.json()) as Detail);
    // 저장소를 바꿨으면 진단도 다시 봐야 합니다. 안 그러면 앞 저장소의
    // 상태가 남아 **방금 잘못 적은 이름이 정상으로 보입니다.**
    void loadHealth();
  });
});

$('gh-backfill').addEventListener('click', () => {
  void startBackfill();
});

$('rotate').addEventListener('click', () => {
  const ok = confirm(
    '초대 코드를 새로 만듭니다.\n지금 코드는 그 즉시 통하지 않습니다. 계속할까요?',
  );
  if (!ok) return;
  // ⚠️ 예전에는 `if (r.ok)` 하나뿐이었다. 실패하면 화면이 그대로라
  // 사람은 코드가 바뀐 줄 알고 **옛 코드를 다시 나눠 준다.**
  void whilePressed($('rotate') as HTMLButtonElement, async () => {
    const r = await send(`/api/projects/${projectId}/invite/rotate`, { method: 'POST' });
    if (r === null) return say('error', unreachableText('코드를 새로 만들지 못했습니다'));
    if (!r.ok) return say('error', `코드를 새로 만들지 못했습니다 (HTTP ${r.status})`);
    say('error', '');
    render((await r.json()) as Detail);
  });
});

$('copy').addEventListener('click', () => {
  // 표시용 문자열이 아니라 **데이터**에서 만든다. 없으면 아무 말도 하지
  // 않습니다 — 버튼이 이미 비활성이라 여기까지 오지 않습니다.
  const text = codeToCopy(inviteCode);
  if (text === null) return;
  // ⚠️ **안 됐을 때 그렇다고 말합니다** (결함 81). 폰에서 `http://` 로
  // 열면 `navigator.clipboard` 가 아예 없습니다. 예전에는 그 자리에서
  // 조용히 죽었고, 사람은 클립보드에 남아 있던 **다른 글**을 카톡으로
  // 보냈습니다.
  void copyText(text, navigator.clipboard).then((outcome) => {
    if (copySucceeded(outcome)) {
      showNote($('copy-note'), '');
      $('copy').textContent = describeCopy(outcome, '코드');
      setTimeout(() => ($('copy').textContent = '코드 복사'), 1500);
      return;
    }
    // 실패 이유는 버튼이 아니라 아래 줄에 적습니다 — 버튼 글자를 길게
    // 만들면 옆의 "코드 새로 만들기" 와 겹칩니다 (결함 77).
    showNote($('copy-note'), describeCopy(outcome, '코드'));
  });
});

$('open-meeting').addEventListener('click', () => {
  const title = input('meeting-title').value.trim();
  // ⚠️ 회의도 **누른 만큼 생긴다.** 답이 늦다고 두 번 누르면 빈 회의가
  // 하나 남고, 팀원이 어느 쪽에 들어갈지 갈린다 (결함 89).
  void whilePressed($('open-meeting') as HTMLButtonElement, async () => {
    const r = await send(`/api/projects/${projectId}/meetings`, {
      method: 'POST',
      body: JSON.stringify({ title: title || null }),
    });
    if (r === null) return say('error', unreachableText('회의를 열지 못했습니다'));
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      return say(
        'error',
        detailText(body, `회의를 열지 못했습니다 (HTTP ${r.status})`),
      );
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

  void send(`/api/projects/${projectId}/me/data`, { method: 'POST' })
    .then(async (response) => {
      if (response === null) {
        $('del-result').className = 'bad';
        say('del-result', describeRequestFailure(0));
        button.disabled = false;
        return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        $('del-result').className = 'bad';
        say(
          'del-result',
          describeRequestFailure(response.status, detailText(body, '') || undefined),
        );
        button.disabled = false;
        return;
      }

      const outcome = describeOutcome((await response.json()) as RevokeResult);
      $('del-result').className = outcome.needsRetry ? 'bad' : '';
      say('del-result', outcome.text);

      // 다시 시도해야 하면 버튼을 살려 둔다. 성공했으면 되돌릴 수 없으므로
      // 다시 누를 이유가 없다 — 눌러도 "지울 녹음이 없습니다" 가 나온다.
      button.disabled = !outcome.needsRetry;
    });
});

renderNav('project');
$('save-roles').addEventListener('click', () => {
  void whilePressed($('save-roles') as HTMLButtonElement, saveRoles);
});

void load();
void loadHealth();
void loadRoles();

// 서비스 워커 등록 + 설치 안내. 안 부르면 sw.js 는 그냥 놓인 파일이다.
bootApp();
