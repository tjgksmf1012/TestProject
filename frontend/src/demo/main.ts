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
import { describeTimeline } from '../lib/recording/timeline.ts';
import type { SyncTransport } from '../lib/recording/client.ts';
import type { PendingChunk, UploadTransport } from '../lib/recording/upload-queue.ts';

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
const apiBase = params.get('api');
const trackUrl = params.get('track');

const localUpload = new LocalUploadTransport();
const client = new RecordingClient({
  monotonic: () => performance.now(),
  media: new BrowserMediaAdapter(),
  sync: apiBase ? new HttpSyncTransport(apiBase) : new LocalSyncTransport(),
  upload: trackUrl ? new HttpUploadTransport(trackUrl) : localUpload,
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

  const blockers = blockerList(state);
  $('blockers').innerHTML = blockers.length
    ? blockers.map((b) => `<li>${escapeHtml(b)}</li>`).join('')
    : '<li class="ok">준비됐습니다</li>';

  ($('start') as HTMLButtonElement).disabled = state.phase !== 'ready';
  ($('stop') as HTMLButtonElement).disabled = !(
    state.phase === 'recording' || state.phase === 'interrupted'
  );

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

/** `session.blockers` 를 그대로 쓰되 여기서는 표시만 한다. */
function blockerList(state: typeof client.state): string[] {
  const out: string[] = [];
  if (!state.secureContext) out.push('HTTPS 연결이 필요합니다 (Cloudflare Tunnel 사용)');
  if (state.permission !== 'granted') out.push('마이크 권한이 필요합니다');
  if (state.consent !== 'all_confirmed') out.push('녹음 동의가 필요합니다');
  if (state.clock === 'unsynced') out.push('시각 동기화가 필요합니다');
  if (state.clock === 'poor') out.push('시각 오차가 큽니다 (네트워크 확인)');
  return out;
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ── 동작 ────────────────────────────────────────────────────

$('consent').addEventListener('click', () => {
  // 실험용이므로 로컬에서 동의를 확정한다.
  // 실제 서비스에서는 서버가 참여자 전원의 동의를 확인해야 한다 (docs/07 §1).
  client.setConsent('all_confirmed');
});

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
  // 회의 중 시계 드리프트를 흡수한다 (clock.ts: ±50ppm → 1시간에 180ms)
  resyncTimer = setInterval(() => void client.syncClock(), 5 * 60_000);
  const startedAt = Date.now();
  elapsedTimer = setInterval(() => {
    const sec = Math.floor((Date.now() - startedAt) / 1000);
    $('elapsed').textContent = `${Math.floor(sec / 60)}분 ${sec % 60}초`;
  }, 1000);
});

$('stop').addEventListener('click', async () => {
  if (resyncTimer) clearInterval(resyncTimer);
  if (elapsedTimer) clearInterval(elapsedTimer);
  wakeLock?.release();
  wakeLock = null;

  summary = await client.stop();
  showResult(summary);
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
