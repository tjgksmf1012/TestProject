/**
 * 회의 로비 화면.
 *
 * 동의를 받고, 회의 중에 누구의 트랙이 망가지는지 보여주고, 브라우저를
 * 그냥 닫은 사람 때문에 회의가 안 끝날 때 풀어 줍니다.
 *
 * ⚠️ 화면 코드라 자동 테스트가 없습니다. **판단이 들어가는 것은 전부
 * `src/lib/lobby/room.ts` 에 있고 25개 테스트로 검증됩니다.** 여기는 DOM 에
 * 붙이는 배선일 뿐입니다 (`frontend/README.md` 의 경계 규칙).
 *
 * 폴링을 쓰는 이유: SSE·WebSocket 을 붙이면 서버에 상태가 생기고, 그건
 * 이 화면 하나 때문에 지불하기엔 비쌉니다. 3초 폴링이면 "폰이 잠겼다" 를
 * 알아채는 데 충분합니다 — 사람이 반응하는 데 어차피 몇 초 걸립니다.
 */

import {
  canStart,
  consentStateOf,
  describeConsent,
  memberStatuses,
  roomStatus,
  startBlockers,
  type MemberStatus,
  type RosterEntry,
  type TrackHealth,
} from '../lib/lobby/room.ts';
import { isSessionExpired, loginUrlFor, type Me } from '../lib/auth/session.ts';
import { escapeHtml } from '../lib/html.ts';

const params = new URLSearchParams(location.search);
const meetingId = Number(params.get('meeting') ?? '1');
const apiBase = params.get('api') ?? '';

// 내가 누구인지는 **서버가** 말해 준다. 예전에는 `?me=1` 을 읽었는데,
// 그건 사용자가 자기 신원을 스스로 선언하는 구조였다.
let meId = 0;
// 기여도 화면으로 넘어가려면 프로젝트 id 가 필요한데, 로비는 회의 id 만 안다.
let projectId = 0;

const POLL_MS = 3_000;

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`요소 없음: ${id}`);
  return el;
};

let roster: RosterEntry[] = [];
let tracks: TrackHealth[] = [];
let consentMessage = '';

function goToLogin(): void {
  location.href = loginUrlFor(location.pathname + location.search);
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${apiBase}${path}`, {
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (isSessionExpired(response.status)) {
    goToLogin();
    throw new Error('로그인이 필요합니다');
  }
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

async function refresh(): Promise<void> {
  try {
    const [consent, trackBody] = await Promise.all([
      getJson(`/api/meetings/${meetingId}/consent`) as Promise<{
        roster: RosterEntry[];
        message: string;
      }>,
      getJson(`/api/meetings/${meetingId}/tracks`) as Promise<{ tracks: TrackHealth[] }>,
    ]);
    roster = consent.roster;
    consentMessage = consent.message;
    tracks = trackBody.tracks;
    render();
  } catch (err) {
    $('sub').textContent = `불러오지 못했습니다: ${String(err)}`;
  }
}

async function submitConsent(consented: boolean): Promise<void> {
  try {
    const response = await fetch(`${apiBase}/api/meetings/${meetingId}/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `user_id` 를 보내지 않는다. **동의는 본인만 한다** — 서버가 세션에서
      // 읽으므로 남을 대신해 동의해 줄 방법이 없다.
      body: JSON.stringify({ consent_type: 'recording', consented }),
      credentials: 'same-origin',
    });
    if (isSessionExpired(response.status)) {
      goToLogin();
      return;
    }
    const body = await response.json();
    if (!response.ok) {
      $('consent-message').textContent = body.detail ?? '동의를 제출하지 못했습니다';
      return;
    }
    roster = body.roster;
    consentMessage = body.message;
    render();
  } catch (err) {
    $('consent-message').textContent = `전송 실패: ${String(err)}`;
  }
}

async function forceFinish(): Promise<void> {
  const ok = confirm(
    '참가하지 않은 사람을 기다리지 않고 회의를 끝냅니다.\n' +
      '그 사람의 발언은 기록되지 않습니다. 계속할까요?'
  );
  if (!ok) return;

  try {
    const response = await fetch(`${apiBase}/api/meetings/${meetingId}/finish`, {
      method: 'POST',
      credentials: 'same-origin',
    });
    const body = await response.json();
    $('room-message').textContent = body.message ?? '';
    await refresh();
  } catch (err) {
    $('room-message').textContent = `강제 종료 실패: ${String(err)}`;
  }
}

function renderRoster(): void {
  $('roster').innerHTML = roster
    .map((entry) => {
      const state = consentStateOf(entry);
      const mine = entry.user_id === meId ? ' (나)' : '';
      return (
        `<li><span class="name">${escapeHtml(entry.name)}${mine}</span>` +
        `<span class="state ${state}">${describeConsent(state)}</span></li>`
      );
    })
    .join('');

  const blockers = startBlockers(roster);
  const box = $('blockers');
  box.hidden = blockers.length === 0;
  box.innerHTML = blockers.map((b) => `<p>${escapeHtml(b)}</p>`).join('');
  $('consent-message').textContent = consentMessage;
}

function renderMembers(statuses: MemberStatus[]): void {
  $('members').innerHTML = statuses
    .map(
      (s) =>
        `<li class="${s.verdict}"><span class="name">${escapeHtml(s.name)}</span>` +
        `<span class="state">${escapeHtml(s.message)}</span></li>`
    )
    .join('');
}

function render(): void {
  const statuses = memberStatuses(roster, tracks);
  const room = roomStatus(statuses);

  renderRoster();
  renderMembers(statuses);

  $('sub').textContent = `회의 ${meetingId} · 팀원 ${roster.length}명`;
  $('room-message').textContent = room.message;

  const record = $('record') as HTMLButtonElement;
  record.disabled = !canStart(roster);
  record.textContent = record.disabled ? '전원 동의 후 시작할 수 있습니다' : '녹음 화면으로';

  $('finish').hidden = !room.needsForceFinish;
  // 처리가 끝나야 후보가 생긴다. 그 전에 눌러도 빈 화면이라 감춘다.
  $('review').hidden = room.recording > 0 || room.notJoined > 0 || tracks.length === 0;
}

$('agree').addEventListener('click', () => void submitConsent(true));
$('refuse').addEventListener('click', () => void submitConsent(false));
$('finish').addEventListener('click', () => void forceFinish());
$('record').addEventListener('click', () => {
  location.href = `/index.html?meeting=${meetingId}`;
});
$('review').addEventListener('click', () => {
  location.href = `/review.html?meeting=${meetingId}`;
});
$('contrib').addEventListener('click', () => {
  // 기여도는 프로젝트 단위지만 이름을 붙이려면 회의 단위 명단 API 가 필요하다.
  location.href = `/contributions.html?project=${projectId}&meeting=${meetingId}`;
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
  // 화면이 서버에 "나는 누구인가" 를 묻는다. 이 한 줄이 `?me=1` 을 대체한다.
  const response = await fetch(`${apiBase}/api/auth/me`, { credentials: 'same-origin' });
  if (!response.ok) {
    goToLogin();
    return;
  }
  const me = (await response.json()) as Me;
  meId = me.user_id;
  $('who').textContent = `${me.name} 님으로 로그인했습니다`;

  const meeting = (await getJson(`/api/meetings/${meetingId}`)) as { project_id: number };
  projectId = meeting.project_id;

  await refresh();
  setInterval(() => void refresh(), POLL_MS);
}

void start();
