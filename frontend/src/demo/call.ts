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

import { isSessionExpired, loginUrlFor, safeApiBase, type Me } from '../lib/auth/session.ts';
import {
  CALL_AUDIO_CONSTRAINTS,
  callWarnings,
  captureProblems,
  describeCall,
  describePeer,
  planPeers,
  type PeerState,
  type PeerView,
  type Roster,
  type RosterPeer,
} from '../lib/call/mesh.ts';
import { escapeHtml } from '../lib/html.ts';
import { showNote } from '../lib/ui/failure.ts';
import { renderNav } from './nav.ts';
import { bootApp } from './pwa.ts';

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

function say(text: string, bad = false): void {
  $('status').textContent = text;
  $('status').className = bad ? 'bad' : '';
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
      ? `<li><span class="face me">${escapeHtml(mine.name.slice(0, 1))}</span>
           <span class="who"><span class="name">${escapeHtml(mine.name)} (나)</span>
           <span class="state ok">이 기기에서 녹음됩니다</span></span>
           ${mine.headphones ? '' : '<span class="badge">헤드폰 없음</span>'}</li>`
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
    .map((w) => `<li>${escapeHtml(w.replace(/\*\*/g, ''))}</li>`)
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
    // 실패는 **빨갛게** (결함 98). 이 자리는 평소 "마이크가 켜졌습니다"
    // 를 말하는 부제라, 같은 회색으로 쓰면 통화가 안 되는 이유를 놓칩니다.
    showNote($('mic'), '마이크를 열지 못했습니다. 브라우저 권한을 확인하세요.');
    render();
    return;
  }

  micReady = true;
  const track = localStream.getAudioTracks()[0];
  const settings = (track?.getSettings() ?? {}) as Record<string, unknown>;
  const problems = captureProblems(settings);
  showNote(
    $('mic'),
    problems.length ? problems.join(' ') : '마이크가 켜졌습니다 (에코 제거 켬 · 자동 게인 끔).',
    problems.length ? 'bad' : 'plain',
  );

  meterFrom(localStream);
  render();
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

  for (const track of localStream?.getAudioTracks() ?? []) {
    pc.addTrack(track, localStream as MediaStream);
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

$('leave').addEventListener('click', () => {
  socket?.close();
  for (const pc of peers.values()) pc.close();
  for (const track of localStream?.getAudioTracks() ?? []) track.stop();
  location.href = `/lobby.html?meeting=${meetingId}`;
});

async function start(): Promise<void> {
  const response = await fetch(`${apiBase}/api/auth/me`, {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (isSessionExpired(response.status) || !response.ok) {
    goToLogin();
    return;
  }
  const who = (await response.json()) as Me;
  me = who.user_id;
  $('sub').textContent = `${who.name} 님으로 참여 중`;

  await openMic();
  openSocket();
}

void start();

renderNav('lobby');

// 서비스 워커 등록 + 설치 안내. 안 부르면 sw.js 는 그냥 놓인 파일이다.
bootApp();
