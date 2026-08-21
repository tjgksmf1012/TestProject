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
  UploadFailed,
} from '../lib/recording/browser-adapter.ts';
import { RecordingClient, type RecordingSummary } from '../lib/recording/client.ts';
import {
  completeBody,
  completionView,
  describeCompletion,
  describeCompletionFailure,
  type TrackCompleteResult,
} from '../lib/recording/complete.ts';
import {
  blockers as sessionBlockers,
  consentForEntry,
  consentStateFrom,
  consentStep,
  consentStepLabel,
  permissionStepLabel,
  stepsDone,
  describeJoinFailure,
  describeResume,
  describeSoloEntry,
  describeStopReason,
  trackRefused,
} from '../lib/recording/session.ts';
import {
  describeRecordingSafety,
  isRiskyForRecording,
  recordingSafety,
} from '../lib/platform/recording.ts';
import { awakeBridge, shouldHoldAwake } from '../lib/platform/awake.ts';
import { describeGiveUp, describeReupload, openChunkStore } from '../lib/platform/chunk-store.ts';
import { describeGapReason, describeTimeline } from '../lib/recording/timeline.ts';
import { describeCaptureCheck } from '../lib/recording/capture.ts';
import { isSessionExpired, loginUrlFor, safeApiBase, type Me } from '../lib/auth/session.ts';
import { detailText } from '../lib/http/detail.ts';
import { tryGet, trySend, unreachableText } from '../lib/http/send.ts';
import { showNote } from '../lib/ui/failure.ts';
import { whilePressed } from '../lib/ui/pending.ts';
import { copySucceeded, copyText, describeCopy } from '../lib/ui/copy.ts';
import { escapeHtml } from '../lib/html.ts';
import { recomputeAfterRecovery, type SyncTransport } from '../lib/recording/client.ts';
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

/** 준비 단계 ①이 어디로 데려가는가. `render` 가 말을 바꿔 다는 자리 (결함 274). */
const entryStep = consentStep(meetingId);

// `?track=` 은 손으로 트랙 주소를 넣는 옛 경로다. `?meeting=` 이 있으면
// 아래 `joinMeeting()` 이 로그인한 사람의 트랙을 서버에서 받아 온다.
let trackUrl = params.get('track');

// 개발자 진단 패널 (R7) — 실험 조건·복사 한 줄은 사용자에게 하는 말이
// 아니라서 기본 숨김이고, `?debug=1` 로만 열린다.
if (params.get('debug') === '1') $('debug').hidden = false;

const localUpload = new LocalUploadTransport();
const httpUpload = new HttpUploadTransport('');

/**
 * `?meeting=` 없이 열면 **서버 없이도 끝까지 돈다.**
 *
 * 실험 5의 목적은 "폰이 한 시간을 버티는가" 이지 네트워크가 아니다.
 * 서버를 세워야만 돌아가는 실험은 결국 안 돌리게 된다.
 */
/**
 * 청크를 디스크에 붙잡아 두는 곳 (`docs/21` Phase 1).
 *
 * ⚠️ **브라우저에서는 `null` 입니다.** 붙잡아 둘 곳이 없으니까요 — 그때
 * 큐는 예전과 똑같이 동작합니다. 데스크톱 앱에서만 값이 생깁니다.
 */
const chunkStore = openChunkStore(window.teamflowDesktop?.chunks, meetingId ?? 'local');

/** 디스크에 못 적은 것. **조용히 넘어가면 "보관 중" 이 거짓말이 됩니다.** */
const storeErrors: string[] = [];

/**
 * 재우기 방지 (`docs/21` Phase 2). 브라우저에서는 `null` — 잡을 것이 없습니다.
 *
 * ⚠️ **국면으로 잡고 놓습니다.** 시작 버튼에 걸면 백프레셔·동의 철회처럼
 * 화면을 거치지 않고 멈추는 경로에서 **안 놓입니다** — 상태 변화는 전부
 * `onStateChange` 로 오므로 그 한 곳에서 정합니다. 어느 국면에서 잡는지는
 * `lib/platform/awake.ts` 의 `shouldHoldAwake` 가 정하고 테스트가 붙습니다.
 */
const awake = awakeBridge(window.teamflowDesktop?.awake);
let awakeHeld = false;

function syncAwake(phase: string): void {
  if (!awake) return;
  const want = shouldHoldAwake(phase);
  if (want === awakeHeld) return;
  awakeHeld = want;
  // 돌려받는 값은 main 이 powerSaveBlocker.isStarted 로 잰 것입니다.
  // 실패해도 녹음은 계속돼야 하므로 여기서 던지지 않습니다.
  void (want ? awake.hold() : awake.release()).catch(() => {});
}

const client = new RecordingClient({
  monotonic: () => performance.now(),
  media: new BrowserMediaAdapter(),
  sync: apiBase || meetingId ? new HttpSyncTransport(apiBase) : new LocalSyncTransport(),
  upload: {
    async send(chunk) {
      if (!trackUrl) return localUpload.send(chunk);
      try {
        return await httpUpload.send(chunk);
      } catch (error) {
        /* ⛔ **거절을 끊김으로 읽고 있었습니다** (결함 240). 서버는 청크마다
           동의를 다시 보므로, 회의 도중 누가 철회하면 그 순간부터 전부
           403 입니다. 큐는 여섯 번 다시 걸고 조용히 포기했고, 화면은 그
           동안 계속 「녹음 중」이었습니다.
           ⚠️ 여기서 화면이 「철회됐다」고 **단정하지 않습니다** — 서버
           명부를 다시 읽습니다(결함 229). 판단은 `@lib`. */
        if (meetingId !== null && error instanceof UploadFailed && trackRefused(error.status)) {
          void refreshConsent(meetingId);
        }
        throw error;
      }
    },
  },
  uploadOptions: {
    store: chunkStore,
    onStoreError: (seq, reason) => {
      storeErrors.push(`청크 ${seq}: ${reason}`);
      render();
    },
  },
  timesliceMs: 5_000,
  onStateChange: (state) => {
    syncAwake(state.phase);
    render();
    // 스스로 멈춘 경우(동의 철회·백프레셔)에도 마무리까지 갑니다 —
    // 「정지」가 이미 비활성이라 사람이 누를 것이 없습니다 (결함 240).
    if (state.phase === 'stopping' && state.stopReason !== null && state.stopReason !== 'user') {
      void finishRecording();
    }
  },
});

let wakeLock: { release: () => void } | null = null;
let resyncTimer: ReturnType<typeof setInterval> | null = null;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;
let summary: RecordingSummary | null = null;
/** 서버가 마지막으로 준 판정. 다시 올린 뒤에도 **이 값이 주인**입니다. */
let serverVerdict: TrackCompleteResult | null = null;

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

  // ⚠️ `disabled` 가 아니라 `aria-disabled` 입니다. 비활성 버튼은 초점을
  //    못 받아 **왜 시작할 수 없는지**(`#blockers` 목록)를 낭독기에 전할
  //    방법이 없습니다 — 하필 녹음은 못 하면 그 회의를 영영 못 잽니다.
  //    `정지` 는 그대로 둡니다: 녹음 중이 아닐 때 정지는 설명할 사유가
  //    있는 것이 아니라 **해당 없는** 것이라 진짜 비활성이 맞습니다.
  // 왜 멈췄는지. 사람이 스스로 멈춘 것은 아무 말도 안 합니다 (결함 240).
  const stopped = describeStopReason(state.stopReason);
  showNote($('stop-note'), stopped ?? '', 'bad');

  $('start').setAttribute('aria-disabled', String(state.phase !== 'ready'));
  ($('stop') as HTMLButtonElement).disabled = !(
    state.phase === 'recording' || state.phase === 'interrupted'
  );

  // ⭐ 이 환경에서 화면을 꺼도 되는지 **미리** 말한다. 회의가 끝난 뒤에
  // "그 폰은 화면을 켜 뒀어야 했다" 를 알게 되면 그 회의는 다시 못 한다.
  const safety = recordingSafety(window, matchMedia('(display-mode: standalone)').matches);
  $('safety').textContent = describeRecordingSafety(safety);
  $('safety').className = isRiskyForRecording(safety) ? 'banner' : 'banner ok-banner';

  // ⛔ **경고 0건을 「요청대로 적용됐습니다」로 읽지 않습니다** (결함 249).
  //    그 목록은 마이크를 얻은 뒤에야 채워집니다 — 거부당하면 빈 채로
  //    남고, 그때 초록 글씨는 **아무것도 안 재고 만점을 준 것**입니다.
  //    무엇을 말해도 되는지는 `@lib` 의 `describeCaptureCheck` 가 정합니다.
  // 끝난 단계를 **끝난 것으로** 그린다 (결함 274). 판단은 `@lib`.
  const done = stepsDone(state);
  $('step-consent').dataset.done = String(done.consent);
  $('step-permission').dataset.done = String(done.permission);
  $('consent').textContent = consentStepLabel(entryStep, done.consent);
  $('permission').textContent = permissionStepLabel(done.permission);

  const warnings = client.warnings;
  const note = describeCaptureCheck(client.appliedSettings, warnings);
  $('warnings').innerHTML = warnings.length
    ? warnings.map((w) => `<li class="${w.severity}">${escapeHtml(w.message)}</li>`).join('')
    : `<li class="${note?.tone ?? 'gap'}">${escapeHtml(note?.text ?? '')}</li>`;
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

/**
 * 동의 명부를 **서버에서 읽어** 세션에 넣는다.
 *
 * ⛔ 예전에는 `#consent` 를 누르면 화면이 스스로 `all_confirmed` 를
 * 넣었습니다 (결함 229). 서버에 명부가 이미 있는데 안 물어본 것입니다 —
 * 그래서 (a) 로비에서 진짜로 동의해도 이 화면은 「녹음 동의가
 * 필요합니다」였고, (b) **아무도 동의 안 한 회의**에서 혼자 그 단추를
 * 누르면 「준비됐습니다」가 되어 녹음이 실제로 돌았습니다.
 *
 * 판단은 `@lib` 의 `consentStateFrom` 이 합니다. 여기서는 **묻고 넣기만**.
 */
/** 지금 로그인한 사람. 동의 명부에서 **내 줄**을 찾는 데 씁니다. */
let myUserId: number | null = null;

async function refreshConsent(id: string): Promise<void> {
  const response = await tryGet(`${apiBase}/api/meetings/${id}/consent`);
  // ⚠️ 못 물어봤으면 **모르는 것**입니다. 모르는 것을 동의로 읽지 않습니다.
  if (response === null || !response.ok) return;
  client.setConsent(consentStateFrom(await response.json(), myUserId));
  // 로비에서 동의를 마치고 돌아온 자리입니다. 앞서 **동의가 없어서** 트랙을
  // 못 열었다면 지금이 다시 열 때입니다 — 안 그러면 조건은 다 찼는데
  // 올릴 자리만 없는 채로 남습니다 (결함 272).
  if (client.state.track === 'blocked') void joinMeeting(id);
}

/**
 * 회의에 트랙으로 참가한다.
 *
 * 트랙 주인은 **서버가 세션에서 정한다** — 예전에는 `?me=1` 로 화면이
 * 선언했고, 그래서 남의 트랙에 목소리를 올릴 수 있었다.
 */
async function joinMeeting(id: string): Promise<void> {
  // ⚠️ **지금 여는 중**이라고 먼저 적습니다 (결함 272). 두 가지를 합니다 —
  //    ① 다시 시도할 때 「못 열었다」가 남아 있지 않게 하고,
  //    ② 아래 `refreshConsent` 가 「막혔으면 다시 열어라」를 보고 여기로
  //       되돌아오는 **무한 재귀**를 끊습니다.
  client.setTrack('pending');
  // ⚠️ 읽기도 `tryGet` 을 거칩니다 (결함 102). 맨 `fetch` 는 닿지 못하면
  // 던지는데, 이 함수는 `void joinMeeting(…)` 으로 불려 거부가 아무 데도
  // 안 걸립니다 — 화면은 아무 말도 안 하고 녹음 버튼만 비활성입니다.
  const me = await tryGet(`${apiBase}/api/auth/me`);
  if (me === null) {
    client.setTrack('blocked');
    showNote($('join-note'), unreachableText('회의에 들어가지 못했습니다'));
    return;
  }
  if (!me.ok) {
    location.href = loginUrlFor(location.pathname + location.search);
    return;
  }
  const who = (await me.json()) as Me;
  myUserId = who.user_id;
  $('who').textContent = `${who.name} 님의 트랙으로 녹음합니다`;
  // ⚠️ **트랙 참가보다 먼저** 동의를 읽습니다 (결함 229). 참가가 403 으로
  //    막혀도 그 이유가 화면의 막는 목록에 서 있어야 합니다.
  await refreshConsent(id);
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
    client.setTrack('blocked');
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
    /* ⛔ **모든 실패를 빨강으로 말했습니다** (결함 237). 아직 동의하지
       않은 사람의 403 은 고장이 아니라 **순서**입니다 — 판단은 `@lib`. */
    const note = describeJoinFailure(
      response.status,
      detailText(body, `HTTP ${response.status}`),
      client.state.consent,
    );
    client.setTrack('blocked');
    showNote($('join-note'), note.text, note.tone);
    return;
  }

  const track = (await response.json()) as { track_id: number };
  trackUrl = `${apiBase}/api/meetings/${id}/tracks/${track.track_id}`;
  httpUpload.retarget(trackUrl);
  // ⚠️ **여기가 「올릴 자리가 생겼다」고 말하는 유일한 자리입니다** (결함 272).
  //    이 줄이 없으면 `blockers` 가 영원히 「여는 중」에 머뭅니다.
  client.setTrack('open');
  render();
}

// 준비 단계 ① — 말만 하고 갈 자리를 안 주면 안 됩니다.
// ⛔ 예전에는 이 두 줄이 `if (meetingId)` **안에** 있었습니다. 회의 없이
//    열면 `<a id="consent">` 가 href 없이 남아, 눈에는 단추인데 탭으로
//    닿지도 눌리지도 않았습니다 (결함 238).
($('consent') as HTMLAnchorElement).href = entryStep.href;
$('consent').textContent = entryStep.label;

// 회의가 없으면 동의를 물을 상대도 없습니다 — 판단은 `@lib`, 여기서는 넣기만.
client.setConsent(consentForEntry(meetingId));

if (meetingId) {
  void joinMeeting(meetingId);
  // 로비에서 동의하고 **돌아왔을 때** 다시 묻습니다.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshConsent(meetingId);
  });
} else {
  // 한 시간을 녹음하고 나서 "팀에 아무것도 안 올라갔다" 를 알면 늦습니다.
  const solo = describeSoloEntry();
  showNote($('join-note'), solo.text, solo.tone);
}

$('permission').addEventListener('click', async () => {
  await client.requestMicrophone();
  await client.syncClock();
  render();
});

$('start').addEventListener('click', async () => {
  // ⚠️ **잠금을 잡기 전에 막힌 국면부터 봅니다.** 순서가 반대였을 때는
  //    시작하지 못하는데도 화면 잠금을 잡고 끝났습니다 — 버튼이
  //    `aria-disabled` 라 눌리기 시작하면서 그 자리가 자주 지나갑니다.
  if (!client.start()) {
    // 사유는 `#blockers` 에 이미 서 있습니다 — 거기로 데려다 줍니다.
    $('blockers').scrollIntoView({ block: 'center' });
    alert('시작할 수 없습니다. 위 목록을 확인하세요.');
    return;
  }
  if (($('wakelock') as HTMLInputElement).checked) {
    wakeLock = await keepScreenAwake();
  }

  // ⚠️ **여기가 데스크톱 셸에게 "지금부터 녹음" 이라고 말할 자리입니다**
  //    (`docs/21` Phase 2). 셸은 마이크가 열린 것을 모릅니다 — 그건 창
  //    안에서 일어나는 일입니다. 알려 줘야 `powerSaveBlocker` 를 켜고,
  //    그래야 화면이 잠겨도 녹음이 안 끊깁니다.
  //
  //    지금은 **비어 있습니다.** 안드로이드 셸에게 말하던 코드가 있었는데
  //    그 셸을 접으면서 같이 걷어냈고, 데스크톱 쪽은 아직 받을 준비가
  //    안 됐습니다(preload 의 `keepsAwake` 가 거짓인 이유). 없는 것을
  //    부르는 척하지 않고 자리만 표시해 둡니다.
  // 회의 중 시계 드리프트를 흡수한다 (clock.ts: ±50ppm → 1시간에 180ms)
  resyncTimer = setInterval(() => void client.syncClock(), 5 * 60_000);
  const startedAt = Date.now();
  elapsedTimer = setInterval(() => {
    const sec = Math.floor((Date.now() - startedAt) / 1000);
    $('elapsed').textContent = `${Math.floor(sec / 60)}분 ${sec % 60}초`;
    // 트랙 리본 LG — 40분 축 위에서 채움이 자란다 (design/redesign §녹음).
    // 40분을 넘겨도 100% 에서 멈춘다 — 축 밖을 그리면 축이 거짓이 된다.
    $('ribbon-fill').style.width = `${Math.min((sec / 2400) * 100, 100)}%`;
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
  // ⭐ **결과 칸을 서버 값으로 다시 그립니다** (결함 220). 이 기기가 잰
  //    값만 보여주면, 서버가 「사용 불가 · 51.5%」 라고 답한 옆에서 칸은
  //    「사용 가능 · 100.0%」 라고 초록으로 서 있습니다. 사람은 크고
  //    초록인 쪽을 믿고 나갑니다.
  serverVerdict = done;
  applyServerVerdict(done, result);

  // 로비로 돌아갈 길을 만들어 준다. 여기가 끝이 아니라 다음이 있다는
  // 걸 화면이 말해 주지 않으면 사람은 여기서 멈춘다.
  if (meetingId) {
    $('finish-next').hidden = false;
    ($('finish-next') as HTMLAnchorElement).href = `/lobby.html?meeting=${meetingId}`;
  }
}

/**
 * 정지 뒤 마무리 — 큐를 닫고, 판정을 만들고, 서버에 끝났다고 말한다.
 *
 * ⛔ **버튼에만 매달려 있었습니다** (결함 240). 동의 철회·백프레셔로
 * 세션이 **스스로** 멈추면 `#halt()` 는 마이크만 끄고 큐는 안 닫습니다.
 * 그때 「정지」는 이미 비활성(국면이 `recording` 이 아니므로)이라 사람이
 * 누를 것이 없고, 화면은 **영영 「마무리 중」** 에 머뭅니다 — 결과도,
 * 커버리지도, "여기까지 저장됐다" 도 안 나옵니다. 대표 실패 ③ 입니다.
 *
 * ⚠️ 두 번 불려도 한 번만 먹습니다. `client.stop()` 자체는 멱등이지만
 * (레코더는 inactive 를 알아서 넘깁니다) 서버 왕복까지 두 번 할 이유가
 * 없습니다.
 */
let finishing = false;
async function finishRecording(): Promise<void> {
  if (finishing) return;
  finishing = true;

  if (resyncTimer) clearInterval(resyncTimer);
  if (elapsedTimer) clearInterval(elapsedTimer);
  wakeLock?.release();
  wakeLock = null;

  summary = await client.stop();
  // ⚠️ 짝이 되는 자리 — 여기서 `powerSaveBlocker` 를 내립니다(Phase 2).
  //    서버 왕복을 기다리는 동안 "녹음 중" 이 떠 있으면 사람은 아직
  //    듣고 있다고 생각하므로, **멈춤을 먼저** 알려야 합니다.

  showResult(summary);
  await tellServerWeAreDone(summary);
}

$('stop').addEventListener('click', () => {
  void finishRecording();
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

/**
 * 디스크에 남은 청크를 **다시 올린다.**
 *
 * ⚠️ 이 버튼이 이 기능의 절반입니다. "이 컴퓨터에 남아 있습니다" 라고
 * 적어 놓고 올릴 자리를 안 주면, 그 문장은 사람을 안심시키기만 하고
 * 소리는 그대로 안 올라갑니다 — 대표 실패 ③ 입니다.
 *
 * ⚠️ **성공한 것만 지웁니다.** 실패한 것은 디스크에 그대로 두고 다시
 * 누를 수 있게 합니다. 한 번 실패했다고 지우면 되찾을 길이 없어집니다.
 */
$('reupload').addEventListener('click', () => {
  const store = chunkStore;
  const done = summary;
  if (!store || !done) return;

  void whilePressed($('reupload') as HTMLButtonElement, async () => {
    const parked = new Set(done.parked);
    const still: number[] = [];

    // ⚠️ 디스크에서 `atMs` 를 같이 읽습니다. 서버가 `X-Client-At-Ms` 를
    //    요구하고, 그게 없으면 공백을 절대 시각으로 복원할 수 없습니다.
    //    파일 이름이 그 값을 들고 있는 이유가 정확히 이것입니다.
    for (const meta of await store.list()) {
      if (!parked.has(meta.seq)) continue;
      const bytes = await store.get(meta.seq);
      if (bytes === null) continue; // 이미 지워졌으면 올릴 것이 없습니다

      // ⚠️ **올리는 방법은 한 곳에만 둡니다.** 여기서 `fetch` 를 다시
      //    쓰면 헤더 하나가 갈라지는 순간 재업로드만 조용히 400 이 됩니다.
      try {
        await httpUpload.send({
          seq: meta.seq,
          atMs: meta.atMs,
          byteLength: meta.byteLength,
          payload: new Blob([bytes]),
        });
        await store.drop(meta.seq);
      } catch {
        still.push(meta.seq);
      }
    }

    const sent = parked.size - still.length;
    /* ⛔ 되찾은 조각을 반영해 **판정을 다시 만듭니다** (결함 244). 안 그러면
       화면이 들고 있는 정지 순간의 비관이 그대로 서버로 다시 가고, 서버는
       「클라이언트가 더 비관적이면 그쪽을 존중한다」는 규칙에 따라 그 값을
       저장합니다 — 소리는 다 돌아왔는데 기록은 계속 「사용 불가」입니다.
       판단은 `@lib` 의 `recomputeAfterRecovery`. */
    const recovered = [...parked].filter((seq) => !still.includes(seq));
    summary = recomputeAfterRecovery(done, recovered);
    const fixed = summary;
    fixed.parked = still;
    showResult(fixed);
    // ⚠️ `showResult` 는 **이 기기가 잰 값**으로 칸을 다시 씁니다. 서버
    //    판정을 안 덮어 주면 다시 올린 순간 「사용 가능 · 100%」 로
    //    되돌아갑니다 — 고친 것이 이 한 줄 때문에 풀립니다 (결함 220).
    if (serverVerdict !== null) applyServerVerdict(serverVerdict, fixed, true);

    // ⛔ **눌러도 아무 말이 없었습니다** (결함 245). 실패한 seq 를 조용히
    //    목록에 도로 넣기만 해서, 화면이 그대로였습니다.
    showNote($('parked-note'), describeReupload(sent, still.length), still.length > 0 ? 'bad' : 'plain');

    // ⛔ 다시 올렸으면 **판정도 다시 받아야 합니다** (결함 244). 서버는
    //    자기가 가진 조각으로 커버리지를 다시 계산합니다 — 안 물어보면
    //    되찾은 소리가 화면에서는 여전히 「사용 불가」입니다.
    if (sent > 0) await tellServerWeAreDone(fixed);
  });
});

document.addEventListener('visibilitychange', () => {
  client.setHidden(document.visibilityState === 'hidden');
});

/**
 * 끊겼다 이어지면 **서버에게 어디까지 받았는지 물어봅니다** (docs/21 Phase 4).
 *
 * ⚠️ 이 배선이 없어서, 서버의 `GET …/chunks` 도 `UploadQueue.resumeWith` 도
 * 만들어만 놓고 **아무도 안 부르고 있었습니다.** 그동안 재연결하면 큐가
 * 처음부터 다시 올렸고, 회의가 길수록 영영 못 따라잡습니다.
 *
 * ⚠️ **`online` 이 떴다고 서버가 살아난 것은 아닙니다** — 랜선이 꽂힌
 * 것뿐입니다. 그래서 물어보고 실패하면 조용히 넘어갑니다. 다음 청크
 * 업로드가 어차피 다시 시도합니다.
 *
 * 새로고침 뒤에는 seq 가 0부터 다시 시작하므로 그 목록을 그대로 건너뛰면
 * **새 소리를 버립니다.** 그 가름은 `client.resumeFrom` 이 합니다 —
 * 여기서 판단하면 판단이 두 벌이 됩니다.
 */
window.addEventListener('online', () => {
  void (async () => {
    if (trackUrl === null) return;
    const response = await tryGet(`${trackUrl}/chunks`);
    if (response === null || !response.ok) return;
    const body = (await response.json().catch(() => null)) as { seqs?: number[] } | null;
    if (body === null || !Array.isArray(body.seqs)) return;
    // ⚠️ 색조를 **반드시** 넘깁니다. `showNote` 의 기본값은 `bad` 라,
    //    안 넘기면 「연결이 돌아왔습니다」가 실패 빨강으로 뜹니다 (결함 243).
    const resumed = describeResume(client.resumeFrom(body.seqs));
    if (resumed !== null) showNote($('join-note'), resumed.text, resumed.tone);
  })();
});

/**
 * 서버가 답한 뒤, **결과 칸의 주인을 서버로 바꿉니다** (결함 220).
 *
 * ⚠️ 판단은 `@lib/recording/complete.ts` 의 `completionView` 가 합니다 —
 *    여기서는 붙이기만 합니다.
 */
function applyServerVerdict(
  done: TrackCompleteResult,
  local: RecordingSummary,
  reuploaded = false,
): void {
  const view = completionView(
    done,
    { coverage: local.timeline.coverage, headline: describeTimeline(local.timeline) },
    reuploaded,
  );
  $('verdict').textContent = view.headline;
  $('verdict').className = view.tone;
  $('coverage').textContent = view.coverageText;
  $('usable').textContent = view.usableText;
  $('disagree').textContent = view.disagreement ?? '';
  $('disagree').hidden = view.disagreement === null;
}

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
            `<li>${escapeHtml(describeGapReason(g.reason))} ${(g.durationMs / 1000).toFixed(1)}초 ` +
            `(${((g.startMs - result.timeline.startedAtMs) / 1000).toFixed(0)}초 지점)</li>`,
        )
        .join('')
    : '<li class="ok">공백 없음</li>';

  // ⭐ 못 올린 청크가 **되찾을 수 있는 것인지** 말합니다.
  //
  // ⚠️ 알려만 주고 되찾을 자리를 안 주면 대표 실패 ③ 입니다. 그래서
  //    버튼을 같이 켭니다 — 서버가 돌아왔을 때 누를 자리입니다.
  const parkedText = describeGiveUp(chunkStore ? 'parked' : 'lost', result.parked.length);
  $('parked').textContent = parkedText;
  $('parked').hidden = parkedText === '';
  ($('reupload') as HTMLButtonElement).hidden = result.parked.length === 0;

  $('store-errors').innerHTML = storeErrors.length
    ? storeErrors.map((e) => `<li class="bad">${escapeHtml(e)}</li>`).join('')
    : '';
  $('store-errors').hidden = storeErrors.length === 0;

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

// v2 F2 — 컨텍스트 바와 레일을 회의로 잇는다. 제목을 알면 바에 적고,
// 어느 프로젝트인지 알면 레일의 칸반·기여도·설정을 그 프로젝트로 보낸다.
// 실패해도 조용히 넘어간다 — 셸이 없다고 녹음을 막을 이유는 없다.
async function fillShellContext(id: string): Promise<void> {
  const response = await tryGet(`${apiBase}/api/meetings/${id}`);
  if (response === null || !response.ok) return;
  const meeting = (await response.json()) as { title: string | null; project_id: number };
  if (meeting.title) $('ctx-title').textContent = `녹음 — ${meeting.title}`;
  ($('rail-kanban') as HTMLAnchorElement).href = `/app/project/${meeting.project_id}/kanban`;
  ($('rail-contrib') as HTMLAnchorElement).href = `/app/project/${meeting.project_id}/contributions`;
  ($('rail-settings') as HTMLAnchorElement).href = `/app/project/${meeting.project_id}/settings/role`;
}
if (meetingId) void fillShellContext(meetingId);

// 서비스 워커 등록 + 설치 안내. 안 부르면 sw.js 는 그냥 놓인 파일이다.
bootApp();
