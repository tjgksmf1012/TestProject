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
import { detailText } from '../lib/http/detail.ts';
import { tryGet, trySend, unreachableText } from '../lib/http/send.ts';
import { showNote } from '../lib/ui/failure.ts';
import { whilePressed } from '../lib/ui/pending.ts';
import { copySucceeded, copyText, describeCopy } from '../lib/ui/copy.ts';
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

/** 마지막으로 만든 실험 표 한 줄. **화면 글자가 아니라 여기서** 복사한다 (결함 71). */
let lastRow: string | null = null;

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
  interrupted: '화면이 가려짐',
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
  // ⚠️ 읽기도 `tryGet` 을 거칩니다 (결함 102). 맨 `fetch` 는 닿지 못하면
  // 던지는데, 이 함수는 `void joinMeeting(…)` 으로 불려 거부가 아무 데도
  // 안 걸립니다 — 화면은 아무 말도 안 하고 녹음 버튼만 비활성입니다.
  const me = await tryGet(`${apiBase}/api/auth/me`);
  if (me === null) {
    showNote($('join-note'), unreachableText('회의에 들어가지 못했습니다'));
    return;
  }
  if (!me.ok) {
    location.href = loginUrlFor(location.pathname + location.search);
    return;
  }
  $('who').textContent = `${((await me.json()) as Me).name} 님의 트랙으로 녹음합니다`;
  // 다시 들어올 때 지난 실패가 남아 있으면 안 된다.
  showNote($('join-note'), '');

  const response = await trySend(() =>
    fetch(`${apiBase}/api/meetings/${id}/tracks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        started_at: new Date().toISOString(),
        device_label: navigator.userAgent.slice(0, 100),
      }),
      credentials: 'same-origin',
    }),
  );

  if (response === null) {
    // 여기서 조용하면 녹음 버튼이 계속 비활성인 채로 남고, 사람은
    // **폰이 고장난 줄** 안다.
    // ⚠️ `#who` 를 덮지 않습니다 (결함 98). 거기는 **내가 누구인지**를
    // 말하는 자리고, 실패로 덮으면 이름이 사라진 채 부제색으로 앉습니다.
    showNote($('join-note'), unreachableText('트랙에 참가하지 못했습니다'));
    return;
  }
  if (isSessionExpired(response.status)) {
    location.href = loginUrlFor(location.pathname + location.search);
    return;
  }
  if (!response.ok) {
    // ⚠️ 예전에는 `await response.text()` 였습니다. 그러면 화면에
    // **본문 JSON 이 그대로** 나옵니다 —
    //
    //     트랙에 참가하지 못했습니다: {"detail":"녹음에 동의하지 않았습니다"}
    //
    // 결함 51 과 같은 부류인데 그때 안 잡혔습니다. 그 수색은 `.json()` 뒤에
    // 붙은 `as { detail?: string }` 를 찾았고, 여기는 `.text()` 라 안 걸렸습니다.
    // **같은 파일 아래쪽(`finish`)은 이미 `detailText` 를 쓰고 있었습니다.**
    const body = await response.json().catch(() => null);
    showNote(
      $('join-note'),
      `트랙에 참가하지 못했습니다: ${detailText(body, `HTTP ${response.status}`)}`,
    );
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

  showNote($('finish-state'), '녹음 종료를 서버에 알리는 중…', 'plain');
  $('finish-retry').hidden = true;

  const body = completeBody({
    timeline: result.timeline,
    verdict: result.verdict,
    captureConfidence: result.captureConfidence,
    warnings: result.warnings,
    timesliceMs: result.timesliceMs,
  });

  const response = await trySend(() =>
    fetch(`${trackUrl}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    }),
  );
  if (response === null) {
    // ⚠️ 여기가 회색이면 사람은 **녹음이 잘 끝난 줄 알고 나갑니다.**
    // 청크가 다 안 올라간 상태라 회의 녹음이 통째로 없어질 수 있습니다.
    showNote($('finish-state'), describeCompletionFailure(0));
    $('finish-retry').hidden = false;
    return;
  }

  if (!response.ok) {
    // `detail` 은 문자열일 수도 있고 422 의 **객체 배열**일 수도 있습니다.
    // 그대로 넘기면 화면에 `[object Object]` 가 나옵니다.
    const body = await response.json().catch(() => null);
    showNote(
      $('finish-state'),
      describeCompletionFailure(response.status, detailText(body, '')),
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
  showNote($('finish-state'), describeCompletion(done), 'plain');
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
  // 답이 늦으면 사람은 "다시 시도" 를 연달아 누른다 (결함 89).
  const done = summary;
  if (done) {
    void whilePressed($('finish-retry') as HTMLButtonElement, () =>
      tellServerWeAreDone(done),
    );
  }
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
  lastRow =
    `| ${navigator.userAgent.slice(0, 40)} | ` +
    `${($('wakelock') as HTMLInputElement).checked ? '있음' : '없음'} | ` +
    `${(result.timeline.coverage * 100).toFixed(1)}% | ` +
    `${(result.timeline.longestGapMs / 1000).toFixed(1)}초 | ` +
    `${[...new Set(result.timeline.gaps.map((g) => g.reason))].join(', ') || '-'} |`;
  $('row').textContent = lastRow;
}

$('copy').addEventListener('click', () => {
  // ⚠️ **화면 글자가 아니라 데이터에서 복사합니다** (결함 71 과 같은 자리).
  // `#row` 를 다시 읽으면, 화면이 아직 안 그려졌거나 다른 코드가 그 자리를
  // 건드린 순간 엉뚱한 것이 클립보드로 갑니다.
  if (lastRow === null) return;
  // ⚠️ 그리고 **안 됐을 때 그렇다고 말합니다** (결함 81). 이 화면은 실기기
  // 실험용이라 폰에서 `http://` 로 여는 경우가 많은데, 거기서는
  // `navigator.clipboard` 가 아예 없습니다.
  void copyText(lastRow, navigator.clipboard).then((outcome) => {
    if (copySucceeded(outcome)) {
      showNote($('copy-note'), '');
      $('copy').textContent = describeCopy(outcome, '한 줄');
      setTimeout(() => ($('copy').textContent = '표에 붙일 한 줄 복사'), 1500);
      return;
    }
    showNote($('copy-note'), describeCopy(outcome, '한 줄'));
  });
});

render();

renderNav('record');

// 서비스 워커 등록 + 설치 안내. 안 부르면 sw.js 는 그냥 놓인 파일이다.
bootApp();
