/**
 * 실기기 녹음 테스트 페이지.
 *
 * docs/09 실험 5 — "팀원 폰이 한 시간짜리 회의를 끝까지 녹음하는가?"
 *
 * 멀티트랙(모드 A)은 트랙이 살아 있어야 성립합니다. iOS Safari 는 화면이
 * 잠기면 마이크를 끄고, 안드로이드도 배터리 세이버가 공격적이면 비슷합니다.
 * **이 실험이 실패하면 모드 A 자체를 재검토해야 하므로 실험 2보다 먼저**
 * 돌려야 합니다.
 *
 * 이 페이지는 서버 없이도 동작합니다. 시각 동기화와 업로드를 로컬에서
 * 흉내 내므로, 폰만 있으면 **커버리지와 공백 원인을 바로 확인**할 수 있습니다.
 * 서버가 있으면 `?api=https://...` 로 붙일 수 있습니다.
 *
 * ⚠️ 화면 코드라 자동 테스트가 없습니다. 판단이 들어가는 로직은 전부
 * `src/lib/recording/` 에 있고 그쪽은 160개 테스트로 검증됩니다.
 * 여기는 버튼을 누르면 그 로직을 부르는 배선일 뿐입니다.
 */

import {
  BrowserMediaAdapter,
  HttpSyncTransport,
  HttpUploadTransport,
  keepScreenAwake,
} from '../lib/recording/browser-adapter.ts';
import { RecordingClient, type RecordingSummary } from '../lib/recording/client.ts';
import {
  completeBody,
  describeCompletion,
  describeCompletionFailure,
  type TrackCompleteResult,
} from '../lib/recording/complete.ts';
import { blockers as sessionBlockers } from '../lib/recording/session.ts';
import {
  describeRecordingSafety,
  isRiskyForRecording,
  recordingSafety,
  tellShellRecordingStarted,
  tellShellRecordingStopped,
} from '../lib/shell/bridge.ts';
import { describeTimeline } from '../lib/recording/timeline.ts';
import { isSessionExpired, loginUrlFor, safeApiBase, type Me } from '../lib/auth/session.ts';
import { escapeHtml } from '../lib/html.ts';
import { renderNav } from './nav.ts';
import type { SyncTransport } from '../lib/recording/client.ts';
import type { PendingChunk, UploadTransport } from '../lib/recording/upload-queue.ts';
import { bootApp } from './pwa.ts';

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`요소를 찾을 수 없습니다: ${id}`);
  return el;
};

/**
 * 서버 없이 시각 동기화를 흉내 낸다.
 *
 * 실험 5의 목적은 **폰이 녹음을 유지하는지**이지 네트워크가 아니다.
 * 서버를 세우지 않아도 실험이 돌아가야 실제로 돌리게 된다.
 */
class LocalSyncTransport implements SyncTransport {
  async probe(): Promise<{ t1: number; t2: number }> {
    const now = Date.now();
    return { t1: now, t2: now };
  }
}

/** 업로드를 흉내 낸다. 바이트는 메모리에만 쌓고 크기만 센다. */
class LocalUploadTransport implements UploadTransport {
  totalBytes = 0;
  count = 0;

  async send(chunk: PendingChunk): Promise<void> {
    this.totalBytes += chunk.byteLength;
    this.count += 1;
  }
}

const params = new URLSearchParams(location.search);
// ⚠️ 주소창의 `?api=` 를 그대로 쓰면 **비밀번호와 회의 음성이 어디로
// 가는지**를 링크 하나로 바꿀 수 있다. safeApiBase 가 진짜 도메인에서는
// 무시하고, 로컬 화면에서 로컬 서버일 때만 통과시킨다.
const apiBase = safeApiBase(params.get('api'), location.origin);
const meetingId = params.get('meeting');

// `?track=` 은 손으로 트랙 주소를 넣는 옛 경로다. `?meeting=` 이 있으면
// 아래 `joinMeeting()` 이 로그인한 사람의 트랙을 서버에서 받아 온다.
let trackUrl = params.get('track');

const localUpload = new LocalUploadTransport();
const httpUpload = new HttpUploadTransport('');

/**
 * `?meeting=` 없이 열면 **서버 없이도 끝까지 돈다.**
 *
 * 실험 5의 목적은 "폰이 한 시간을 버티는가" 이지 네트워크가 아니다.
 * 서버를 세워야만 돌아가는 실험은 결국 안 돌리게 된다.
 */
const client = new RecordingClient({
  monotonic: () => performance.now(),
  media: new BrowserMediaAdapter(),
  sync: apiBase || meetingId ? new HttpSyncTransport(apiBase) : new LocalSyncTransport(),
  upload: {
    async send(chunk) {
      if (!trackUrl) return localUpload.send(chunk);
      return httpUpload.send(chunk);
    },
  },
  timesliceMs: 5_000,
  onStateChange: () => render(),
});

let wakeLock: { release: () => void } | null = null;
let resyncTimer: ReturnType<typeof setInterval> | null = null;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;
let summary: RecordingSummary | null = null;

// ── 화면 ────────────────────────────────────────────────────

function render(): void {
  const state = client.state;
  $('phase').textContent = PHASE_LABEL[state.phase] ?? state.phase;
  $('phase').dataset.phase = state.phase;

  $('chunks').textContent = String(state.chunks.length);
  $('interruptions').textContent = String(state.interruptions);
  $('uploaded').textContent = trackUrl
    ? '서버로 전송'
    : `${(localUpload.totalBytes / 1024).toFixed(0)} KB (로컬)`;

  const blockers = sessionBlockers(state);
  $('blockers').innerHTML = blockers.length
    ? blockers.map((b) => `<li>${escapeHtml(b)}</li>`).join('')
    : '<li class="ok">준비됐습니다</li>';

  ($('start') as HTMLButtonElement).disabled = state.phase !== 'ready';
  ($('stop') as HTMLButtonElement).disabled = !(
    state.phase === 'recording' || state.phase === 'interrupted'
  );

  // ⭐ 이 환경에서 화면을 꺼도 되는지 **미리** 말한다. 회의가 끝난 뒤에
  // "그 폰은 화면을 켜 뒀어야 했다" 를 알게 되면 그 회의는 다시 못 한다.
  const safety = recordingSafety(window, matchMedia('(display-mode: standalone)').matches);
  $('safety').textContent = describeRecordingSafety(safety);
  $('safety').className = isRiskyForRecording(safety) ? 'banner' : 'banner ok-banner';

  const warnings = client.warnings;
  $('warnings').innerHTML = warnings.length
    ? warnings.map((w) => `<li class="${w.severity}">${escapeHtml(w.message)}</li>`).join('')
    : '<li class="ok">캡처 설정이 요청대로 적용됐습니다</li>';
}

const PHASE_LABEL: Record<string, string> = {
  idle: '준비 중',
  ready: '시작 가능',
  recording: '녹음 중',
  interrupted: '⚠️ 화면이 가려짐',
  stopping: '마무리 중',
  completed: '완료',
  failed: '오류',
};


// ── 동작 ────────────────────────────────────────────────────

$('consent').addEventListener('click', () => {
  // 실험용이므로 로컬에서 동의를 확정한다.
  // 실제 서비스에서는 서버가 참여자 전원의 동의를 확인해야 한다 (docs/07 §1).
  client.setConsent('all_confirmed');
});

/**
 * 회의에 트랙으로 참가한다.
 *
 * 트랙 주인은 **서버가 세션에서 정한다** — 예전에는 `?me=1` 로 화면이
 * 선언했고, 그래서 남의 트랙에 목소리를 올릴 수 있었다.
 */
async function joinMeeting(id: string): Promise<void> {
  const me = await fetch(`${apiBase}/api/auth/me`, { credentials: 'same-origin' });
  if (!me.ok) {
    location.href = loginUrlFor(location.pathname + location.search);
    return;
  }
  $('who').textContent = `${((await me.json()) as Me).name} 님의 트랙으로 녹음합니다`;

  const response = await fetch(`${apiBase}/api/meetings/${id}/tracks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      started_at: new Date().toISOString(),
      device_label: navigator.userAgent.slice(0, 100),
    }),
    credentials: 'same-origin',
  });

  if (isSessionExpired(response.status)) {
    location.href = loginUrlFor(location.pathname + location.search);
    return;
  }
  if (!response.ok) {
    const detail = await response.text();
    $('who').textContent = `트랙에 참가하지 못했습니다: ${detail}`;
    return;
  }

  const track = (await response.json()) as { track_id: number };
  trackUrl = `${apiBase}/api/meetings/${id}/tracks/${track.track_id}`;
  httpUpload.retarget(trackUrl);
  render();
}

if (meetingId) void joinMeeting(meetingId);

$('permission').addEventListener('click', async () => {
  await client.requestMicrophone();
  await client.syncClock();
  render();
});

$('start').addEventListener('click', async () => {
  if (($('wakelock') as HTMLInputElement).checked) {
    wakeLock = await keepScreenAwake();
  }
  if (!client.start()) {
    alert('시작할 수 없습니다. 위 목록을 확인하세요.');
    return;
  }

  // ⭐ 안드로이드 셸에게 알린다. 셸은 지금 녹음 중인지 **모른다** —
  // 마이크가 열린 것은 WebView 안 일이라 셸이 들여다볼 수 없다.
  // 알려 줘야 포그라운드 서비스가 올라가고, 그래야 화면이 꺼져도
  // 녹음이 끊기지 않는다. 셸이 없으면 아무 일도 하지 않는다.
  tellShellRecordingStarted(window);
  // 회의 중 시계 드리프트를 흡수한다 (clock.ts: ±50ppm → 1시간에 180ms)
  resyncTimer = setInterval(() => void client.syncClock(), 5 * 60_000);
  const startedAt = Date.now();
  elapsedTimer = setInterval(() => {
    const sec = Math.floor((Date.now() - startedAt) / 1000);
    $('elapsed').textContent = `${Math.floor(sec / 60)}분 ${sec % 60}초`;
  }, 1000);
});

/**
 * 서버에 "이 트랙 끝났다" 고 알린다.
 *
 * ⚠️ **이걸 부르는 코드가 없었습니다.** 정지 버튼은 요약을 화면에만 그리고
 * 끝났고, 그래서 트랙은 영원히 `recording` 으로 남았습니다. 회의는 큐에
 * 들어가지 않고, 로비에서는 강제 종료 버튼도 검토 버튼도 뜨지 않습니다 —
 * 오류 메시지 하나 없이 **이 프로젝트의 주장 전체가 첫 단계에서 멈춰**
 * 있었습니다.
 *
 * 실패해도 화면을 지우지 않습니다. 사람이 다시 누를 수 있어야 합니다.
 */
async function tellServerWeAreDone(result: RecordingSummary): Promise<void> {
  if (!trackUrl) return; // 서버 없이 도는 로컬 실험 — 알릴 곳이 없다

  $('finish-state').hidden = false;
  $('finish-state').textContent = '녹음 종료를 서버에 알리는 중…';
  $('finish-retry').hidden = true;

  const body = completeBody({
    timeline: result.timeline,
    verdict: result.verdict,
    captureConfidence: result.captureConfidence,
    warnings: result.warnings,
    timesliceMs: result.timesliceMs,
  });

  let response: Response;
  try {
    response = await fetch(`${trackUrl}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  } catch {
    $('finish-state').textContent = describeCompletionFailure(0);
    $('finish-retry').hidden = false;
    return;
  }

  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { detail?: string };
    $('finish-state').textContent = describeCompletionFailure(
      response.status,
      detail.detail,
    );
    // 401 은 다시 눌러도 똑같다 — 로그인 화면으로 보낸다.
    if (isSessionExpired(response.status)) {
      location.href = loginUrlFor(location.pathname + location.search);
      return;
    }
    $('finish-retry').hidden = false;
    return;
  }

  const done = (await response.json()) as TrackCompleteResult;
  $('finish-state').textContent = describeCompletion(done);
  $('finish-retry').hidden = true;

  // 로비로 돌아갈 길을 만들어 준다. 여기가 끝이 아니라 다음이 있다는
  // 걸 화면이 말해 주지 않으면 사람은 여기서 멈춘다.
  if (meetingId) {
    $('finish-next').hidden = false;
    ($('finish-next') as HTMLAnchorElement).href = `/lobby.html?meeting=${meetingId}`;
  }
}

$('stop').addEventListener('click', async () => {
  if (resyncTimer) clearInterval(resyncTimer);
  if (elapsedTimer) clearInterval(elapsedTimer);
  wakeLock?.release();
  wakeLock = null;

  summary = await client.stop();
  // 알림을 먼저 내린다. 서버 왕복을 기다리는 동안 "녹음 중" 이 떠
  // 있으면 사람은 아직 듣고 있다고 생각한다.
  tellShellRecordingStopped(window);

  showResult(summary);
  await tellServerWeAreDone(summary);
});

$('finish-retry').addEventListener('click', () => {
  if (summary) void tellServerWeAreDone(summary);
});

document.addEventListener('visibilitychange', () => {
  client.setHidden(document.visibilityState === 'hidden');
});

function showResult(result: RecordingSummary): void {
  $('result').hidden = false;
  $('verdict').textContent = describeTimeline(result.timeline);
  $('verdict').className = result.verdict.usable ? 'ok' : 'bad';

  $('coverage').textContent = `${(result.timeline.coverage * 100).toFixed(1)}%`;
  $('totalgap').textContent = `${(result.timeline.totalGapMs / 1000).toFixed(1)}초`;
  $('longestgap').textContent = `${(result.timeline.longestGapMs / 1000).toFixed(1)}초`;
  $('usable').textContent = result.verdict.usable ? '사용 가능' : '사용 불가';

  $('gaps').innerHTML = result.timeline.gaps.length
    ? result.timeline.gaps
        .map(
          (g) =>
            `<li><code>${g.reason}</code> ${(g.durationMs / 1000).toFixed(1)}초 ` +
            `(${((g.startMs - result.timeline.startedAtMs) / 1000).toFixed(0)}초 지점)</li>`,
        )
        .join('')
    : '<li class="ok">공백 없음</li>';

  // docs/09 실험 5 표에 그대로 붙여 넣을 수 있는 한 줄
  $('row').textContent =
    `| ${navigator.userAgent.slice(0, 40)} | ` +
    `${($('wakelock') as HTMLInputElement).checked ? '있음' : '없음'} | ` +
    `${(result.timeline.coverage * 100).toFixed(1)}% | ` +
    `${(result.timeline.longestGapMs / 1000).toFixed(1)}초 | ` +
    `${[...new Set(result.timeline.gaps.map((g) => g.reason))].join(', ') || '-'} |`;
}

$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('row').textContent ?? '');
  $('copy').textContent = '복사됨';
  setTimeout(() => ($('copy').textContent = '표에 붙일 한 줄 복사'), 1500);
});

render();

renderNav('record');

// 서비스 워커 등록 + 설치 안내. 안 부르면 sw.js 는 그냥 놓인 파일이다.
bootApp();
