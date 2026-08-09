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
import { isSessionExpired, loginUrlFor, safeApiBase, type Me } from '../lib/auth/session.ts';
import { escapeHtml } from '../lib/html.ts';
import { axisTicks, buildDiagram, describeGap } from '../lib/track/diagram.ts';
import { detailText } from '../lib/http/detail.ts';
import { describeUnexpected, trySend, unreachableText } from '../lib/http/send.ts';
import { describeHttpStatus, failureHtml } from '../lib/ui/failure.ts';
import { whileLoading } from '../lib/ui/pending.ts';
import { clearSkeleton, rowItems, showSkeleton } from '../lib/ui/skeleton.ts';
import { renderNav } from './nav.ts';
import { wireLogout } from './logout.ts';
import { bootApp } from './pwa.ts';

const params = new URLSearchParams(location.search);
const meetingId = Number(params.get('meeting') ?? '1');
// ⚠️ 주소창의 `?api=` 를 그대로 쓰면 **비밀번호와 회의 음성이 어디로
// 가는지**를 링크 하나로 바꿀 수 있다. safeApiBase 가 진짜 도메인에서는
// 무시하고, 로컬 화면에서 로컬 서버일 때만 통과시킨다.
const apiBase = safeApiBase(params.get('api'), location.origin);

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

/** 체크박스의 지금 값. 요소가 없으면 **동의로 치지 않는다.** */
const checked = (id: string): boolean => {
  const el = document.getElementById(id);
  return el instanceof HTMLInputElement ? el.checked : false;
};

let roster: RosterEntry[] = [];
/** 처리 진행 문구. 서버가 만든 문장을 그대로 씁니다 (감사 #8). */
let progressLine = '';
let tracks: TrackHealth[] = [];
let consentMessage = '';

function goToLogin(): void {
  location.href = loginUrlFor(location.pathname + location.search);
}

/**
 * 상태 코드를 들고 다니는 오류.
 *
 * ⚠️ 예전에는 `new Error(`${status} ${await response.text()}`)` 였습니다.
 * 그러면 화면에 **서버 응답 본문이 통째로** 나옵니다 — 사람에게는
 * `Error: 500 {"detail":...}` 처럼 보이고, 무엇을 해야 하는지는 어디에도
 * 없습니다. 코드를 들고 다니면 `describeHttpStatus` 가 할 일을 말해 줍니다.
 */
class HttpError extends Error {
  // ⚠️ 생성자 매개변수 속성(`constructor(readonly status)`)은 못 씁니다 —
  // `erasableSyntaxOnly` 가 막습니다. 이 저장소는 타입을 **지우기만** 하고
  // 변환하지 않는 실행 방식이라, 코드를 만들어 내는 문법은 전부 금지입니다.
  status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
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
  if (!response.ok) throw new HttpError(response.status);
  return response.json();
}

async function refresh(): Promise<void> {
  // ⚠️ 이 함수는 `POLL_MS` 마다 다시 돕니다. 스켈레톤을 **매번** 켜면
  // 살아 있는 참가자 목록이 주기적으로 회색 막대로 바뀝니다 — 로딩
  // 표시가 오히려 화면을 망가뜨립니다. 그래서 **첫 번째만** 켭니다.
  const first = roster.length === 0;
  try {
    const [consent, trackBody] = await whileLoading(
      Promise.all([
        getJson(`/api/meetings/${meetingId}/consent`) as Promise<{
          roster: RosterEntry[];
          message: string;
        }>,
        getJson(`/api/meetings/${meetingId}/tracks`) as Promise<{ tracks: TrackHealth[] }>,
      ]),
      () => {
        // ⚠️ `#roster` 는 `<ul>` 입니다. `<div>` 를 넣으면 낭독기가 세는
        // 항목 수가 틀어집니다 — 그래서 `<li>` 판을 씁니다.
        if (first) showSkeleton($('roster'), rowItems(3));
      },
      () => {
        if (first) clearSkeleton($('roster'));
      },
    );
    roster = consent.roster;
    consentMessage = consent.message;
    tracks = trackBody.tracks;

    // ⚠️ **진행률은 보조 정보입니다.** 실패해도 로비는 그대로 돌아야
    // 하므로 위 `Promise.all` 에 넣지 않고 따로, 그리고 조용히 받습니다.
    //
    // 문구는 **서버가 만든 것을 그대로** 씁니다. 여기서 다시 만들면
    // "0%" 와 "모름" 을 가르는 규칙이 두 곳에 생기고, 한쪽만 고쳐집니다.
    progressLine = await getJson(`/api/meetings/${meetingId}/progress`)
      .then((body) => String((body as { message?: string }).message ?? ''))
      .catch(() => '');

    render();
  } catch (err) {
    // ⚠️ 목록 **바로 위**에도 씁니다. `#sub` 한 줄만 바꾸면 참가자
    // 목록은 텅 빈 채로 남고, 사람은 아무도 안 들어온 줄 압니다.
    //
    // `#roster` 가 아니라 `#blockers` 에 넣는 이유: `#roster` 는
    // `<ul>` 이라 `<div>` 오류 상자를 넣을 수 없습니다. `#blockers` 는
    // 바로 위에 있고, 다음 성공에서 `renderRoster` 가 덮어씁니다.
    $('sub').textContent = '불러오지 못했습니다';
    if (first) {
      clearSkeleton($('roster'));
      const box = $('blockers');
      box.hidden = false;
      box.innerHTML = failureHtml({
        what: '참가자 상태를 불러오지 못했습니다.',
        help:
          err instanceof HttpError
            ? (describeHttpStatus(err.status) ?? undefined)
            : '연결이 끊겼거나 서버에 닿지 못했습니다.',
        code: err instanceof HttpError ? err.message : undefined,
        retry: true,
      });
      box.querySelector<HTMLButtonElement>('.retry')?.addEventListener('click', () => {
        void refresh();
      });
    }
  }
}

async function postConsent(
  consentType: string,
  consented: boolean,
): Promise<Response | null> {
  // 서버에 닿지 못하면 `null`. 동의는 **누르면 바뀌는** 요청이라
  // 실패를 화면이 반드시 말해야 한다 (결함 87).
  return trySend(() =>
    fetch(`${apiBase}/api/meetings/${meetingId}/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `user_id` 를 보내지 않는다. **동의는 본인만 한다** — 서버가 세션에서
      // 읽으므로 남을 대신해 동의해 줄 방법이 없다.
      body: JSON.stringify({ consent_type: consentType, consented }),
      credentials: 'same-origin',
    }),
  );
}

async function submitConsent(consented: boolean): Promise<void> {
  try {
    const response = await postConsent('recording', consented);
    if (response === null) {
      $('consent-message').textContent = unreachableText('동의를 제출하지 못했습니다');
      return;
    }
    if (isSessionExpired(response.status)) {
      goToLogin();
      return;
    }
    const body = await response.json();
    if (!response.ok) {
      $('consent-message').textContent = detailText(
        body,
        '동의를 제출하지 못했습니다',
      );
      return;
    }

    // ②③ 을 같이 보낸다 (docs/07 §2.3).
    //
    // ⚠️ **녹음에 동의했을 때만** 보냅니다. 녹음 자체를 거부한 사람에게
    // "원본은 보관해도 되나요" 를 묻는 건 뜻이 없고, 거부 기록에 딸린
    // 응답이 남으면 나중에 그게 무슨 뜻인지 아무도 모릅니다.
    //
    // ⚠️ 이게 실패해도 녹음 동의는 이미 접수됐습니다. 되돌리지 않고
    // 사람에게 말합니다 — 조용히 넘어가면 화면의 체크박스와 서버의
    // 기록이 어긋난 채로 남습니다.
    if (consented) {
      const extras: [string, boolean][] = [
        ['raw_audio_retention', checked('keep-audio')],
        ['voiceprint_storage', checked('keep-voiceprint')],
      ];
      for (const [type, value] of extras) {
        const extra = await postConsent(type, value);
        if (extra === null || !extra.ok) {
          $('consent-message').textContent =
            '녹음 동의는 접수됐지만 아래 두 항목을 저장하지 못했습니다. 다시 눌러 주세요.';
          return;
        }
      }
    }

    roster = body.roster;
    consentMessage = body.message;
    render();
  } catch (err) {
    // 여기까지 오는 것은 응답을 읽다 깨진 경우뿐이다 — 보내는 실패는
    // 위에서 `null` 로 끝난다. 원문은 콘솔에만 남긴다.
    console.error(err);
    $('consent-message').textContent = describeUnexpected();
  }
}

async function forceFinish(): Promise<void> {
  const ok = confirm(
    '참가하지 않은 사람을 기다리지 않고 회의를 끝냅니다.\n' +
      '그 사람의 발언은 기록되지 않습니다. 계속할까요?'
  );
  if (!ok) return;

  try {
    const response = await trySend(() =>
      fetch(`${apiBase}/api/meetings/${meetingId}/finish`, {
        method: 'POST',
        credentials: 'same-origin',
      }),
    );
    if (response === null) {
      $('room-message').textContent = unreachableText('회의를 끝내지 못했습니다');
      return;
    }
    const body = await response.json();
    $('room-message').textContent = body.message ?? '';
    await refresh();
  } catch (err) {
    console.error(err);
    $('room-message').textContent = describeUnexpected();
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
  // ⭐ 운행도표 — 사람마다 한 줄, 구멍이 **제자리에** 찍힙니다.
  //
  // 축은 `buildDiagram` 이 정합니다. 트랙마다 녹음 시작 시각이 다르므로
  // 오프셋을 맞추지 않으면 늦게 들어온 사람의 구멍이 회의 앞쪽으로
  // 밀려옵니다 — 그러면 "그 결정이 나올 때 이 사람이 끊겨 있었다" 가
  // 통째로 거짓이 됩니다. 18개 테스트가 그 축을 고정합니다.
  const diagram = buildDiagram(
    tracks.map((t) => ({
      userId: t.user_id,
      startedAt: t.started_at ?? null,
      endedAt: t.ended_at ?? null,
      gaps: t.gaps ?? [],
    })),
  );

  const ticks = axisTicks(diagram.durationMs);
  $('axis').innerHTML = ticks.length
    ? `<span></span><span class="marks">${ticks
        .map((t) => `<span>${escapeHtml(t)}</span>`)
        .join('')}</span>`
    : '';
  $('axis').hidden = ticks.length === 0;

  $('members').innerHTML = statuses
    .map((s) => {
      // 축을 못 정했으면 트랙을 안 그립니다. 거짓 위치는 안 그리는
      // 것보다 나쁩니다.
      const spans = diagram.durationMs > 0 ? (diagram.gaps.get(s.userId) ?? []) : null;
      const bar =
        spans === null
          ? ''
          : `<span class="tl">${spans
              .map(
                (g) =>
                  `<i style="left:${g.left}%;width:${g.width}%" title="${escapeHtml(
                    describeGap(g, diagram.durationMs),
                  )}"></i>`,
              )
              .join('')}</span>`;
      return (
        `<li class="${s.verdict}"><span class="name">${escapeHtml(s.name)}</span>` +
        `<span class="state">${escapeHtml(s.message)}</span>${bar}</li>`
      );
    })
    .join('');
}

function render(): void {
  const statuses = memberStatuses(roster, tracks);
  const room = roomStatus(statuses);

  renderRoster();
  renderMembers(statuses);

  $('sub').textContent = `회의 ${meetingId} · 팀원 ${roster.length}명`;
  $('room-message').textContent = room.message;
  $('progress').textContent = progressLine;

  const record = $('record') as HTMLButtonElement;
  record.disabled = !canStart(roster);
  record.textContent = record.disabled ? '전원 동의 후 시작할 수 있습니다' : '녹음 화면으로';

  // 통화도 같은 게이트를 지납니다. 통화는 곧 녹음이고, 녹음은 전원의
  // 동의가 있어야 시작할 수 있습니다 (docs/07 L1).
  const call = $('call') as HTMLButtonElement;
  call.disabled = record.disabled;
  call.textContent = call.disabled ? '통화도 전원 동의 후에' : '통화로 회의하기';

  // ⚠️ **한 화면에 주 버튼은 하나** (지시서 §8).
  //
  // 내가 아직 동의를 안 했으면 "동의합니다" 가 주 동작입니다. 하고 나면
  // 주 동작은 "녹음 화면으로" 로 넘어갑니다 — 그때도 동의 버튼이 청록인
  // 채로 남아 있으면 **또 눌러야 하나** 싶게 만듭니다.
  const iAgreed = roster.some((e) => e.user_id === meId && consentStateOf(e) === 'granted');
  $('agree').classList.toggle('primary', !iAgreed);

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
$('call').addEventListener('click', () => {
  location.href = `/call.html?meeting=${meetingId}`;
});
$('review').addEventListener('click', () => {
  location.href = `/review.html?meeting=${meetingId}`;
});
$('kanban').addEventListener('click', () => {
  location.href = `/kanban.html?project=${projectId}&meeting=${meetingId}`;
});
$('contrib').addEventListener('click', () => {
  // 기여도는 프로젝트 단위지만 이름을 붙이려면 회의 단위 명단 API 가 필요하다.
  location.href = `/contributions.html?project=${projectId}&meeting=${meetingId}`;
});
wireLogout({ button: $('logout'), note: $('logout-note'), apiBase });

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

renderNav('lobby');

// 서비스 워커 등록 + 설치 안내. 안 부르면 sw.js 는 그냥 놓인 파일이다.
bootApp();
