/**
 * 통화 화면 — WebRTC 메시.
 *
 * ⚠️ 화면 코드라 자동 테스트가 없습니다. 판단은 전부
 * `src/lib/call/mesh.ts` 에 있고 24개 테스트로 검증됩니다.
 *
 * ⚠️⚠️ **이 파일은 실제 통화로 확인된 적이 없습니다.** 이 개발 환경에는
 * 네트워크가 없어 WebRTC 연결이 성립하지 않습니다. 서버 쪽 주선 규칙은
 * 테스트로 고정돼 있지만, 여기 `RTCPeerConnection` 배선이 맞는지는
 * `docs/09` 실험 6(사람 넷이 각자 PC 에서 30분)에서만 알 수 있습니다.
 */

import { bylineHtml } from '../lib/ui/byline.ts';
import { isSessionExpired, loginUrlFor, safeApiBase, type Me } from '../lib/auth/session.ts';
import {
  CALL_AUDIO_CONSTRAINTS,
  callWarnings,
  captureProblems,
  describeCall,
  describeMic,
  describeMyCapture,
  describePeer,
  needsRecvOnlyAudio,
  planPeers,
  type PeerState,
  type PeerView,
  type Roster,
  type RosterPeer,
} from '../lib/call/mesh.ts';
import { escapeHtml } from '../lib/html.ts';
import { tryGet, unreachableText } from '../lib/http/send.ts';
import { showNote } from '../lib/ui/failure.ts';
import { bootApp } from './pwa.ts';
import { plainText } from '../lib/ui/plain.ts';

const params = new URLSearchParams(location.search);
// ⚠️ 주소창의 `?api=` 를 그대로 쓰면 회의 음성이 어디로 가는지를 링크
// 하나로 바꿀 수 있다. safeApiBase 가 로컬에서만 통과시킨다.
const apiBase = safeApiBase(params.get('api'), location.origin);
const meetingId = Number(params.get('meeting') ?? '0');
// 헤드폰은 자기 신고다. 브라우저가 확인할 방법이 없다 (docs/15 §2.3).
const headphones = params.get('headphones') !== 'no';

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`요소 없음: ${id}`);
  return el;
};

let me = 0;
let roster: RosterPeer[] = [];
let serverWarnings: string[] = [];
let micReady = false;
/** 내가 껐는가. `micReady` 와 **다른 값**입니다 — 켰는데 끈 상태가 있습니다. */
let micMuted = false;
/** 내 트랙의 서버 상태. `undefined` 는 "아직 녹음 안 함" 입니다 (결함 216). */
let myTrackStatus: string | undefined;
/** 마이크 설정이 권장과 다른 것들. 토글할 때 다시 계산하지 않게 들고 있습니다. */
let micProblems: string[] = [];
let socket: WebSocket | null = null;
let localStream: MediaStream | null = null;

/** user_id → 연결. 메시라 사람 수만큼 있다. */
const peers = new Map<string, RTCPeerConnection>();
const states = new Map<number, PeerState>();

// 공개 STUN. 자체 호스팅이 아니라 비용 0원 (docs/15 §3.2).
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

function goToLogin(): void {
  location.href = loginUrlFor(location.pathname + location.search);
}

/**
 * 통화 상태 한 줄.
 *
 * ⚠️ 예전에는 여기서 `textContent` 와 `className` 을 손으로 같이 썼습니다 —
 * `showNote` 를 **다시 만든 것**이었습니다. 색과 글자를 한 자리에서 정하는
 * 것까지는 같았지만 `hidden` 을 안 걸어서, 할 말이 없을 때도 빈 `<p>` 가
 * 남아 위쪽 여백 12px 을 계속 차지했습니다.
 *
 * ⚠️⚠️ **가드 셋(결함 92·98·104)이 이걸 못 봤습니다.** 셋 다 실패 문구가
 * **쓰는 그 줄에** 있는 모양을 찾는데, 여기서는 문구가 부르는 쪽에
 * 있습니다(`say('…못했습니다', true)`). 감싸는 함수는 넷째 모양입니다.
 */
function say(text: string, bad = false): void {
  showNote($('status'), text, bad ? 'bad' : 'plain');
}

// ══════════════════════════════════════════════════════════════
// 그리기
// ══════════════════════════════════════════════════════════════

function render(): void {
  const views: PeerView[] = roster
    .filter((p) => p.user_id !== me)
    .map((p) => describePeer(p, states.get(p.user_id) ?? 'new'));

  $('summary').textContent = describeCall(views);

  const mine = roster.find((p) => p.user_id === me);
  const rows = [
    mine
      ? (() => {
          /* ⚠️ 여기 「이 기기에서 녹음됩니다」 가 **조건 없이** 박혀
             있었습니다 (결함 216). 통화에 있는 것과 녹음이 도는 것은 다른
             일이고, 아무것도 안 남는데 남는다고 말하고 있었습니다. */
          const capture = describeMyCapture(
            myTrackStatus === undefined ? undefined : { status: myTrackStatus },
          );
          return `<li><span class="face me">${escapeHtml(mine.name.slice(0, 1))}</span>
           <span class="who"><span class="name">${escapeHtml(mine.name)} (나)</span>
           <span class="state ${capture.tone}">${escapeHtml(capture.label)}</span></span>
           ${mine.headphones ? '' : '<span class="badge">헤드폰 없음</span>'}</li>`;
        })()
      : '',
    ...views.map(
      (p) => `<li><span class="face">${escapeHtml(p.name.slice(0, 1))}</span>
        <span class="who"><span class="name">${escapeHtml(p.name)}</span>
        <span class="state ${p.tone}">${escapeHtml(p.label)}</span></span>
        ${p.headphones ? '' : '<span class="badge">헤드폰 없음</span>'}</li>`,
    ),
  ];
  $('peers').innerHTML = rows.join('');

  const problems = callWarnings(serverWarnings, views, micReady);
  $('warnings').innerHTML = problems
    .map((w) => `<li>${escapeHtml(plainText(w))}</li>`)
    .join('');
}

// ══════════════════════════════════════════════════════════════
// 마이크
// ══════════════════════════════════════════════════════════════

async function openMic(): Promise<void> {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      // ⚠️ 같은 방에서 쓰던 설정과 두 개가 반대다 (docs/15 §2.2).
      audio: { ...CALL_AUDIO_CONSTRAINTS },
    });
  } catch {
    micReady = false;
    micMuted = false;
    // ⚠️ 빨강이 아니라 **흙빛 + 행동 버튼**입니다 (design/redesign §통화).
    // 권한을 아직 안 준 것은 잘못이 아니라 대기 상태라, 빨갛게 쓰면
    // 사람은 통화가 고장 났다고 읽습니다. 할 일을 버튼으로 줍니다.
    paintMic();
    $('mic-retry').hidden = false;
    render();
    return;
  }
  $('mic-retry').hidden = true;

  micReady = true;
  micMuted = false;
  // 마이크가 열려야 토글할 것이 생긴다 (v2 F2 — 하단 컨트롤 바).
  ($('mic-toggle') as HTMLButtonElement).disabled = false;
  const track = localStream.getAudioTracks()[0];
  micProblems = captureProblems((track?.getSettings() ?? {}) as Record<string, unknown>);
  paintMic();

  meterFrom(localStream);
  render();
}

/**
 * 마이크 칸과 토글 버튼을 **한 곳에서** 다시 그린다.
 *
 * ⚠️ 예전에는 상태줄을 `openMic()` 이 한 번 쓰고, 토글은 버튼 글자만
 * 바꿨습니다. 그래서 껐는데도 상태줄이 「마이크가 켜졌습니다」였습니다
 * (결함 216). 같은 사실을 두 곳에서 쓰면 반드시 갈라집니다.
 */
function paintMic(): void {
  const state = !micReady ? 'off' : micMuted ? 'muted' : 'on';
  const note = describeMic(state, micProblems);
  showNote($('mic'), note.text, note.tone);
  $('mic-toggle').textContent = micMuted ? '마이크 켜기' : '마이크 끄기';
  $('mic-toggle').setAttribute('aria-pressed', String(!micMuted));
}

/** ⚠️ 이게 없으면 마이크가 죽은 걸 회의가 끝난 뒤에 안다. */
function meterFrom(stream: MediaStream): void {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(stream).connect(analyser);
  const buffer = new Uint8Array(analyser.frequencyBinCount);

  const tick = (): void => {
    analyser.getByteTimeDomainData(buffer);
    let peak = 0;
    for (const value of buffer) peak = Math.max(peak, Math.abs(value - 128));
    $('level').style.width = `${Math.min(100, (peak / 128) * 240)}%`;
    requestAnimationFrame(tick);
  };
  tick();
}

// ══════════════════════════════════════════════════════════════
// 메시
// ══════════════════════════════════════════════════════════════

function send(body: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(body));
}

function connectionFor(userId: number, initiate: boolean): RTCPeerConnection {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  peers.set(String(userId), pc);
  states.set(userId, 'connecting');

  const localTracks = localStream?.getAudioTracks() ?? [];
  for (const track of localTracks) {
    pc.addTrack(track, localStream as MediaStream);
  }
  // ⚠️ **보낼 것이 없으면 협상 자체가 안 됩니다** (결함 221). 트랙 없이
  //    만든 offer 는 미디어 줄이 0개고 ICE 후보도 0개라 연결이 영영 안
  //    붙습니다 — 재서 확인했습니다(트랙 있으면 1개·2개). 받는 자리라도
  //    열어야 마이크 없는 사람이 **듣기는** 합니다.
  if (needsRecvOnlyAudio(localTracks.length)) {
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      send({ kind: 'ice', to: userId, payload: JSON.stringify(event.candidate) });
    }
  };
  pc.onconnectionstatechange = () => {
    states.set(userId, pc.connectionState as PeerState);
    render();
  };
  pc.ontrack = (event) => {
    // 소리는 화면에 안 보이는 <audio> 로 흘린다.
    const audio = new Audio();
    audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
    audio.autoplay = true;
    void audio.play().catch(() => undefined);
  };

  if (initiate) {
    // ⚠️ 둘 다 offer 를 만들면 협상이 멈춘다(glare). `planPeers` 가
    // user_id 로 한 쪽만 고른다.
    void (async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send({ kind: 'offer', to: userId, payload: JSON.stringify(offer) });
    })();
  }
  return pc;
}

function applyRoster(next: Roster): void {
  roster = next.peers;
  serverWarnings = next.warnings ?? [];

  const open = new Set([...peers.keys()].map(Number));
  for (const action of planPeers(roster, me, open)) {
    if (action.type === 'open') {
      connectionFor(action.user_id, action.initiate);
    } else {
      peers.get(String(action.user_id))?.close();
      peers.delete(String(action.user_id));
      states.delete(action.user_id);
    }
  }
  render();
}

async function onSignal(body: Record<string, unknown>): Promise<void> {
  const from = Number(body.from);
  const pc = peers.get(String(from)) ?? connectionFor(from, false);
  const payload = JSON.parse(String(body.payload));

  if (body.kind === 'offer') {
    await pc.setRemoteDescription(payload);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ kind: 'answer', to: from, payload: JSON.stringify(answer) });
  } else if (body.kind === 'answer') {
    await pc.setRemoteDescription(payload);
  } else if (body.kind === 'ice') {
    await pc.addIceCandidate(payload).catch(() => undefined);
  }
}

function openSocket(): void {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const base = apiBase || `${scheme}://${location.host}`;
  const wsBase = base.replace(/^http/, 'ws');
  socket = new WebSocket(
    `${wsBase}/api/meetings/${meetingId}/call?headphones=${headphones ? 'yes' : 'no'}`,
  );

  socket.onmessage = (event) => {
    const body = JSON.parse(event.data as string) as Record<string, unknown>;
    if (body.kind === 'roster') return applyRoster(body as unknown as Roster);
    if (body.kind === 'rejected') return say(String(body.reason ?? '통화에 들어가지 못했습니다'), true);
    if (body.kind === 'refused') return say(String(body.reason ?? ''), true);
    void onSignal(body);
  };
  socket.onclose = () => {
    // ⚠️ 조용히 닫히면 화면은 통화 중인 줄 안다.
    $('summary').textContent = '통화가 끊겼습니다.';
    say('연결이 닫혔습니다. 새로고침하면 다시 붙습니다.', true);
  };
}

// ══════════════════════════════════════════════════════════════
// 버튼
// ══════════════════════════════════════════════════════════════

$('record').addEventListener('click', () => {
  location.href = `/index.html?meeting=${meetingId}`;
});

// 권한 대기 상태의 행동 버튼 — 다시 getUserMedia 를 시도한다.
$('mic-retry').addEventListener('click', () => void openMic());

// 마이크 토글 (v2 F2). 트랙을 닫지 않고 `enabled` 만 뒤집는다 — 닫으면
// 다시 켤 때 권한 절차부터 다시 밟아야 하고, 통화 연결도 다시 협상한다.
$('mic-toggle').addEventListener('click', () => {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  micMuted = !track.enabled;
  // ⚠️ 버튼 글자만 바꾸지 않습니다 — 위 상태줄도 같은 사실을 말합니다.
  paintMic();
});

$('leave').addEventListener('click', () => {
  socket?.close();
  for (const pc of peers.values()) pc.close();
  for (const track of localStream?.getAudioTracks() ?? []) track.stop();
  location.href = `/lobby.html?meeting=${meetingId}`;
});

async function start(): Promise<void> {
  // ⚠️ 닿지 못한 것을 로그인 만료로 읽으면 안 됩니다 (결함 102).
  const response = await tryGet(`${apiBase}/api/auth/me`);
  if (response === null) {
    showNote($('mic'), unreachableText('통화에 들어가지 못했습니다'));
    return;
  }
  if (isSessionExpired(response.status) || !response.ok) {
    goToLogin();
    return;
  }
  const who = (await response.json()) as Me;
  me = who.user_id;
  $('sub').innerHTML = bylineHtml(who.name, '참여 중');
  $('sub').hidden = false;

  await openMic();
  openSocket();
  // 5초를 기다리지 않고 **처음부터** 사실을 말합니다.
  await pollMyTrack();
}

void start();

/**
 * 내 트랙이 서버에 있는가 — **물어봐야 압니다** (결함 216).
 *
 * ⚠️ 예전에는 안 묻고 「이 기기에서 녹음됩니다」 라고 단언했습니다. 통화에
 * 있는 것과 녹음이 도는 것은 다른 일이고, 녹음은 다른 화면에서 시작합니다.
 *
 * ⚠️ 로비와 같은 주기(5초)입니다 — 새 숫자를 지어내지 않습니다. 실패하면
 * **값을 안 바꿉니다**: 한 번 못 물어봤다고 「아직 녹음 안 함」 으로
 * 뒤집으면, 녹음 중인 사람에게 안 되고 있다고 말하게 됩니다.
 */
async function pollMyTrack(): Promise<void> {
  if (!meetingId || !me) return;
  const response = await tryGet(`${apiBase}/api/meetings/${meetingId}/tracks`);
  if (response === null || !response.ok) return;
  const body = (await response.json()) as { tracks?: { user_id: number; status: string }[] };
  const mine = (body.tracks ?? []).find((t) => t.user_id === me);
  const next = mine?.status;
  if (next === myTrackStatus) return;
  myTrackStatus = next;
  render();
}

// ⚠️ `me` 가 정해진 뒤에야 뜻이 있습니다. `start()` 가 채웁니다.
setInterval(() => void pollMyTrack(), 5000);

// v2 F2 — 컨텍스트 바와 레일을 회의로 잇는다 (index.html 의 짝과 같은 역할).
async function fillShellContext(): Promise<void> {
  if (!meetingId) return;
  const response = await tryGet(`${apiBase}/api/meetings/${meetingId}`);
  if (response === null || !response.ok) return;
  const meeting = (await response.json()) as { title: string | null; project_id: number };
  if (meeting.title) $('ctx-title').textContent = `통화 — ${meeting.title}`;
  ($('rail-kanban') as HTMLAnchorElement).href = `/app/project/${meeting.project_id}/kanban`;
  ($('rail-contrib') as HTMLAnchorElement).href = `/app/project/${meeting.project_id}/contributions`;
  ($('rail-settings') as HTMLAnchorElement).href = `/app/project/${meeting.project_id}/settings/role`;
}
void fillShellContext();

// 서비스 워커 등록 + 설치 안내. 안 부르면 sw.js 는 그냥 놓인 파일이다.
bootApp();
