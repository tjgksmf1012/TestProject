/**
 * 브라우저 통화 — 메시 연결을 누가 언제 만드는가.
 *
 * `docs/15` §3. 서버는 주선만 하고 목소리는 사람들끼리 직접 오갑니다.
 *
 * ```
 *     A ────── B      3명: 연결 3개
 *     │  ╲  ╱  │      4명: 연결 6개   ← 팀플 기본
 *     │   ╳    │      5명: 연결 10개
 *     C ────── D
 * ```
 *
 * ## 여기 있는 것과 없는 것
 *
 * `RTCPeerConnection` 은 여기 없습니다. **판단만** 있습니다 — 누가 먼저
 * 거는가, 명단이 바뀌면 무엇을 만들고 무엇을 닫는가, 지금 상태를 사람에게
 * 뭐라고 말하는가. 그래야 브라우저 없이 테스트할 수 있고, 이 환경에는
 * 브라우저도 네트워크도 없습니다.
 *
 * ⚠️ **이 로직은 실제 통화로 확인된 적이 없습니다.** 규칙이 맞는지는
 * `docs/09` 실험 6 에서 사람 넷이 붙어 봐야 압니다.
 */

/** 서버가 보내는 `roster` 메시지의 참가자 한 줄. */
export interface RosterPeer {
  user_id: number;
  name: string;
  headphones: boolean;
  joined_at: string;
}

export interface Roster {
  kind: 'roster';
  meeting_id: number;
  peers: RosterPeer[];
  warnings: string[];
}

/**
 * ⚠️ **둘 중 누가 offer 를 거는가 — 이걸 안 정하면 통화가 안 붙습니다.**
 *
 * A 와 B 가 서로를 보자마자 둘 다 offer 를 만들면 **glare** 라고 부르는
 * 충돌이 납니다. 양쪽 다 "내가 제안 중" 상태라 상대의 offer 를 받을 수
 * 없고, 협상이 그대로 멈춥니다. 화면에는 "연결 중…" 만 떠 있습니다.
 *
 * 규칙은 단순해야 하고 **양쪽이 같은 답을 내야** 합니다. user_id 가 작은
 * 쪽이 겁니다 — 서버가 주는 값이라 양쪽이 똑같이 보고, 한쪽만 참이 됩니다.
 */
export function shouldInitiate(me: number, other: number): boolean {
  return me < other;
}

export type PeerAction =
  | { type: 'open'; user_id: number; name: string; initiate: boolean }
  | { type: 'close'; user_id: number };

/**
 * 명단이 바뀌었을 때 무엇을 하는가.
 *
 * ⚠️ **나 자신은 빼야 합니다.** 서버 명단에는 내가 들어 있고, 그걸 걸러
 * 내지 않으면 자기 자신에게 연결을 겁니다.
 *
 * ⚠️ **이미 연 연결은 다시 열지 않습니다.** 명단은 사람이 하나 들어올
 * 때마다 전원에게 다시 갑니다. 매번 새로 열면 통화가 계속 끊기고 다시
 * 붙습니다.
 */
export function planPeers(
  roster: readonly RosterPeer[],
  me: number,
  open: ReadonlySet<number>,
): PeerAction[] {
  const wanted = new Map(
    roster.filter((p) => p.user_id !== me).map((p) => [p.user_id, p]),
  );

  const actions: PeerAction[] = [];
  for (const [userId, peer] of [...wanted].sort((a, b) => a[0] - b[0])) {
    if (!open.has(userId)) {
      actions.push({
        type: 'open',
        user_id: userId,
        name: peer.name,
        initiate: shouldInitiate(me, userId),
      });
    }
  }
  for (const userId of [...open].sort((a, b) => a - b)) {
    if (!wanted.has(userId)) actions.push({ type: 'close', user_id: userId });
  }
  return actions;
}

// ══════════════════════════════════════════════════════════════
// 사람에게 뭐라고 말할 것인가
// ══════════════════════════════════════════════════════════════

/** `RTCPeerConnection.connectionState` 와 같은 값. */
export type PeerState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed';

export interface PeerView {
  user_id: number;
  name: string;
  state: PeerState;
  headphones: boolean;
  /** 화면이 그대로 쓰는 말. */
  label: string;
  tone: 'ok' | 'warn' | 'bad';
}

const STATE_TEXT: Record<PeerState, { label: string; tone: PeerView['tone'] }> = {
  new: { label: '연결 준비 중', tone: 'warn' },
  connecting: { label: '연결 중…', tone: 'warn' },
  connected: { label: '연결됨', tone: 'ok' },
  // ⚠️ `disconnected` 는 **끊긴 게 아닙니다.** 네트워크가 잠깐 흔들리면
  // 여기 왔다가 스스로 돌아옵니다. "끊겼습니다" 라고 하면 사람이 통화를
  // 다시 걸고, 그러면 진짜로 끊깁니다.
  disconnected: { label: '신호가 불안정합니다', tone: 'warn' },
  failed: { label: '연결 실패 — 네트워크가 막고 있을 수 있습니다', tone: 'bad' },
  closed: { label: '나갔습니다', tone: 'bad' },
};

export function describePeer(
  peer: RosterPeer,
  state: PeerState,
): PeerView {
  const text = STATE_TEXT[state] ?? STATE_TEXT.new;
  return {
    user_id: peer.user_id,
    name: peer.name,
    state,
    headphones: peer.headphones,
    label: text.label,
    tone: text.tone,
  };
}

/**
 * 통화 전체를 한 줄로.
 *
 * ⚠️ 혼자 있을 때 "연결됨" 이라고 하면 안 됩니다 — 아무도 없는데 통화가
 * 되고 있다고 읽힙니다.
 */
export function describeCall(peers: readonly PeerView[]): string {
  if (peers.length === 0) return '혼자 있습니다. 다른 팀원이 들어오면 자동으로 연결됩니다.';
  const connected = peers.filter((p) => p.state === 'connected').length;
  if (connected === peers.length) return `${peers.length}명과 통화 중입니다.`;
  return `${peers.length}명 중 ${connected}명 연결됨 — 나머지는 연결 중입니다.`;
}

/**
 * 지금 이 통화에서 사람이 알아야 하는 것.
 *
 * 서버가 보내는 경고(헤드폰·인원 상한)에 **브라우저만 아는 것**을 더합니다.
 */
export function callWarnings(
  serverWarnings: readonly string[],
  peers: readonly PeerView[],
  micReady: boolean,
): string[] {
  const problems = [...serverWarnings];

  if (!micReady) {
    // ⚠️ 마이크가 없으면 남의 목소리는 들리는데 **내 발언은 하나도
    // 기록되지 않습니다.** 그러면 회의 기여도가 0이 됩니다.
    problems.push(
      '마이크가 켜지지 않았습니다 — 이 상태로는 내 발언이 하나도 기록되지 않습니다.',
    );
  }

  const failed = peers.filter((p) => p.state === 'failed');
  if (failed.length) {
    const names = failed.map((p) => p.name).join(', ');
    problems.push(
      `${names} 와 연결하지 못했습니다. 그 사람에게는 내 목소리가 가지 않습니다.`,
    );
  }
  return problems;
}

// ══════════════════════════════════════════════════════════════
// 통화 모드 캡처 설정 (docs/15 §2.2)
// ══════════════════════════════════════════════════════════════

/**
 * ⚠️ **같은 방에서 쓰던 설정과 두 개가 반대입니다.**
 *
 * | 설정 | 같은 방 | 통화 | 왜 |
 * |---|---|---|---|
 * | `echoCancellation` | 끔 | **켬** | 스피커로 들으면 남의 목소리가 내 트랙에 |
 * | `noiseSuppression` | 끔 | **켬** | 정렬 근거(누출)가 애초에 없어졌다 |
 * | `autoGainControl` | 끔 | **끔** | 여기만 안 바뀐다 ↓ |
 *
 * `autoGainControl` 만 양쪽에서 계속 끕니다. AGC 는 조용한 사람의 트랙을
 * 증폭해서 **듣고만 있던 사람이 말한 것으로 잡히게** 만듭니다 —
 * 배치와 무관하게 기여도를 왜곡합니다 (docs/05 §5).
 */
export const CALL_AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false,
} as const;

/**
 * 브라우저가 실제로 적용했는지 확인한다.
 *
 * `getUserMedia` 의 맨값 제약은 **요청일 뿐**이라 브라우저가 조용히
 * 무시할 수 있습니다. 특히 AGC 는 끄기를 거부하는 기기가 있고, 그러면
 * 그 트랙의 발언량이 부풀려집니다. 그 사실을 트랙 신뢰도로 넘기려면
 * 여기서 알아채야 합니다.
 */
export function captureProblems(settings: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (settings.autoGainControl === true) {
    problems.push(
      '자동 게인을 끄지 못했습니다 — 이 트랙의 발언량이 부풀려질 수 있습니다.',
    );
  }
  if (settings.echoCancellation === false) {
    problems.push(
      '에코 제거를 켜지 못했습니다 — 스피커로 들으면 남의 목소리가 내 트랙에 섞입니다.',
    );
  }
  return problems;
}
