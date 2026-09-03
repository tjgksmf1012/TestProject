
import { isSilentTooLong, type TrackHealth } from '../lobby/room.ts';
import { withJosa } from '../text/josa.ts';
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
  // ⚠️ **정상 종료를 오류색으로 칠하고 있었습니다.** `closed` 는 사람이
  // 스스로 나간 것이지 실패가 아닙니다. `failed`("연결 실패")와 같은
  // 빨강을 주면 그 둘이 화면에서 구분되지 않고, 빨강은 "네가 뭘
  // 잘못했다" 로 읽힙니다 (불변식 ③ · 바로 위 `disconnected` 와 같은 이유).
  //
  // ⚠️⚠️ 그리고 **이 줄은 화면에 나올 수 없습니다.** `connectionState` 가
  // `closed` 가 되는 길은 `pc.close()` 뿐인데, **`close()` 는
  // `connectionstatechange` 를 쏘지 않습니다.** 브라우저로 쟀습니다 —
  // 실제로 붙은 연결에서 `connecting`·`connected` 는 잡히는데(대조군),
  // `close()` 뒤에는 상태가 `closed` 인 채로 이벤트가 **0건**입니다.
  // 그래서 `call.ts` 의 `states.set(userId, pc.connectionState)` 가
  // 이 값을 쓰는 일이 없고, `applyRoster` 는 나간 사람을 `states` 에서
  // 지웁니다. 나가면 줄이 그냥 사라집니다.
  //
  // 항목을 지우지 않는 이유는 `Record<PeerState, …>` 가 키를 요구하고
  // `PeerState` 는 `RTCPeerConnection.connectionState` 를 그대로 본뜬
  // 것이기 때문입니다. **살릴 생각이라면** `render()` 가 `roster` 대신
  // `roster ∪ states` 를 훑게 하고, `close()` 가 이벤트를 안 쏘므로
  // `applyRoster` 에서 직접 `states.set(user_id, 'closed')` 를 해야
  // 합니다 — 지금은 `states.delete` 를 합니다.
  closed: { label: '나갔습니다', tone: 'warn' },
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
 *
 * ⚠️⚠️ **「나머지」를 한 덩어리로 세지 마십시오** (결함 401). 예전에는
 * `연결된 사람 수` 를 빼고 남은 전부를 「연결 중」이라고 불렀습니다. 그
 * 자루에는 `connecting`(기다리면 붙는다)뿐 아니라 `disconnected`(붙었다가
 * 끊겼다)와 `failed`(안 붙는다 · 내 목소리가 그 사람에게 안 간다)가 같이
 * 들어 있습니다. UDP 를 막고 재 보니 아래 카드는 「연결 실패 — 네트워크가
 * 막고 있을 수 있습니다」인데 **같은 화면 머리줄이 「나머지는 연결
 * 중입니다」**였습니다 — 머리줄을 먼저 읽는 사람은 기다립니다.
 *
 * 그래서 남은 사람 중 **제일 나쁜 갈래를 개수와 함께** 부릅니다. 낱말은
 * `STATE_TEXT` 의 카드 글자와 같은 말을 씁니다 — 같은 사실을 두 자리가
 * 다르게 부르면 어느 쪽을 믿어야 할지 알 수 없습니다(결함 290).
 */
export function describeCall(peers: readonly PeerView[]): string {
  if (peers.length === 0) return '혼자 있습니다. 다른 팀원이 들어오면 자동으로 연결됩니다.';
  const connected = peers.filter((p) => p.state === 'connected').length;
  if (connected === peers.length) return `${peers.length}명과 통화 중입니다.`;

  const head = `${peers.length}명 중 ${connected}명 연결됨`;
  const failed = peers.filter((p) => p.state === 'failed').length;
  if (failed) return `${head} — ${failed}명은 연결 실패했습니다.`;
  const unstable = peers.filter((p) => p.state === 'disconnected').length;
  if (unstable) return `${head} — ${unstable}명은 신호가 불안정합니다.`;
  return `${head} — 나머지는 연결 중입니다.`;
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
    /* ⚠️ **되받는 말이 인원수와 맞아야 합니다** (결함 403). 예전에는 몇
       명이든 「그 사람에게는」이었습니다. 셋이 통화하다 하나가 끊기는
       상황을 처음 만들어 보니 「김민수, 이하늘과 연결하지 못했습니다.
       **그 사람에게는** 내 목소리가 가지 않습니다.」였습니다 — 이름은
       둘인데 받는 이가 하나라, 둘 중 하나만 못 듣는 것으로 읽힙니다.
       옆의 같은 모양(`contribution/view.ts` 의 나간 사람 안내)은 되받는
       말을 아예 안 쓰거나 「남은 사람들」로 씁니다. */
    const them = failed.length === 1 ? '그 사람에게는' : '그 사람들에게는';
    problems.push(
      `${withJosa(names, '과와')} 연결하지 못했습니다. ${them} 내 목소리가 가지 않습니다.`,
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

// ══════════════════════════════════════════════════════════════
// 「내 마이크」·「내 타일」 — **아는 것만 말합니다** (결함 216)
// ══════════════════════════════════════════════════════════════

/**
 * 내 마이크가 지금 어떤 상태인가.
 *
 * - `off`   권한을 아직 안 줬거나 거부 — 켜 본 적이 없다
 * - `muted` 켰지만 내가 껐다 (`track.enabled = false`)
 * - `on`    켜져 있고 소리가 나간다
 */
export type MicState = 'off' | 'muted' | 'on';

/**
 * 화면이 그대로 쓸 한 줄.
 *
 * ⚠️ **`tone` 의 낱말이 자리마다 다릅니다.** 여기는 `showNote` 로 가므로
 * `gap`·`bad`·`plain` 이고, 바로 아래 `CaptureNote` 는 `.state` 클래스로
 * 가므로 `warn`·`ok`·`bad` 입니다. 한쪽 낱말을 다른 쪽에 쓰면 **오류가
 * 안 나고 색만 안 칠해집니다** — 실제로 `CaptureNote` 를 `gap` 으로
 * 적었다가 알았습니다.
 */
export interface MicNote {
  text: string;
  tone: 'gap' | 'bad' | 'plain';
}

/**
 * 「내 마이크」 칸이 할 말.
 *
 * ⚠️ **껐는데도 「마이크가 켜졌습니다」 라고 말하고 있었습니다** (결함 216).
 * 이 문장은 마이크를 처음 열 때 **한 번만** 쓰였고, 토글은 아래 버튼의
 * 글자와 `aria-pressed` 만 바꿨습니다. 가짜 마이크로 재서 확인한 것:
 *
 *     켠 직후: 상태줄 "마이크가 켜졌습니다" · 버튼 "마이크 끄기"
 *     끈 뒤  : 상태줄 "마이크가 켜졌습니다" · 버튼 "마이크 켜기"   ← 어긋남
 *
 * 이건 작은 어긋남이 아닙니다 — 사람은 이 줄을 보고 "내 소리가 나가고
 * 있구나" 라고 믿고 말합니다. 그 발언은 아무에게도 안 갑니다.
 *
 * ⚠️ **껐다고 빨강으로 쓰지 않습니다.** 끈 것은 잘못이 아니라 그 사람의
 * 선택이고, 빨강은 "네가 뭘 잘못했다" 로 읽힙니다. 흙빛(`gap`)입니다.
 *
 * ⚠️ **"녹음이 안 됩니다" 라고 쓰지 않습니다.** 통화 마이크와 녹음은 다른
 * 것입니다 — 녹음은 녹음 화면이 자기 스트림으로 따로 잡습니다. 여기서
 * 녹음까지 단언하면 고치려던 거짓말을 다른 자리에 다시 만드는 것입니다.
 */
export function describeMic(state: MicState, problems: readonly string[]): MicNote {
  if (state === 'off') {
    return { text: '마이크가 아직 꺼져 있습니다 — 권한을 허용하면 켜집니다.', tone: 'gap' };
  }
  if (state === 'muted') {
    return { text: '마이크를 껐습니다 — 지금 말해도 통화 상대에게 안 들립니다.', tone: 'gap' };
  }
  if (problems.length > 0) return { text: problems.join(' '), tone: 'bad' };
  return { text: '마이크가 켜졌습니다 (에코 제거 켬 · 자동 게인 끔).', tone: 'plain' };
}

/**
 * 마이크 토글이 **무엇이라고 말해야 하는가** (결함 277).
 *
 * ⚠️ `describeMic` 은 국면을 셋(`off`·`muted`·`on`)으로 아는데, 버튼은
 * **둘로만** 그려지고 있었습니다 — 껐는가 아닌가. 그래서 권한을 거부한
 * 사람의 화면에서 상태줄은 「마이크가 아직 꺼져 있습니다」인데 버튼은
 * 「마이크 끄기」에 **`aria-pressed="true"`** 였습니다. 눈으로 보는
 * 사람에게는 흐린 버튼이지만, 낭독기는 **「눌림」 = 켜져 있음**이라고
 * 읽습니다.
 *
 * `paintMic` 바로 위에 「같은 사실을 두 곳에서 쓰면 반드시 갈라집니다」
 * (결함 216)라고 적혀 있었는데, 그 함수 **안에서** 다시 갈라져 있었습니다.
 */
export function micToggleLabel(state: MicState): string {
  return state === 'on' ? '마이크 끄기' : '마이크 켜기';
}

/**
 * 토글이 「눌림」인가 — **켜져 있는가**와 같은 말이어야 합니다.
 *
 * ⛔ `off` 를 `true` 로 읽지 않습니다. 안 열린 것은 켜진 것이 아닙니다.
 */
export function micTogglePressed(state: MicState): boolean {
  return state === 'on';
}

/**
 * 마이크가 **열려 있는가** — 토글과 레벨 막대를 그릴 것인가.
 *
 * 안 열렸으면 토글할 것도, 잴 것도 없습니다. 그 자리에는 실제로 할 수
 * 있는 일(`마이크 권한 허용하기`)이 대신 섭니다 — 값 없는 레인은 안
 * 그린다는 v2 F3 과 같은 규칙입니다. 권한을 거부한 화면에는 **한 칸도
 * 안 찬 레벨 막대**가 가로로 누워 있었습니다.
 *
 * ⚠️ `muted` 는 **그립니다.** 그때 막대가 0인 것은 못 잰 것이 아니라
 * **나가는 소리가 없다**는 잰 결과입니다 (측정 불가 ≠ 0 의 반대편).
 */
export function micOpen(state: MicState): boolean {
  return state !== 'off';
}

/** 내 타일이 **녹음에 대해** 할 말. */
export interface CaptureNote {
  label: string;
  /**
   * ⚠️ **`PeerView['tone']` 과 같은 낱말을 씁니다.** 처음에 `'gap'` 이라고
   * 적었는데 `call.html` 의 규칙은 `.state.warn` 입니다 — 그 이름은
   * 아무 데도 없어서 **글자가 그냥 회색으로 나올 뻔했습니다.** 흙빛을
   * 칠하는 클래스는 `warn` 이고, 그것이 `--gap` 을 씁니다.
   *
   * 빨강(`bad`)은 안 씁니다 — 녹음을 아직 안 켠 것은 잘못이 아닙니다.
   */
  tone: PeerView['tone'];
}

/**
 * 내 타일의 녹음 상태.
 *
 * ⚠️ **여기에 「이 기기에서 녹음됩니다」 가 조건 없이 박혀 있었습니다**
 * (결함 216). 통화에 들어와 있다는 것과 녹음이 돌고 있다는 것은 **다른
 * 일**입니다 — 녹음은 녹음 화면에서 따로 시작하고, 동의가 안 끝났으면
 * 시작조차 안 됩니다. 아무것도 안 남고 있는데 화면은 남고 있다고 말했고,
 * 이 제품에서 **녹음이 한 번 끊기면 그 구간은 영영 못 잽니다.** 믿고
 * 말한 회의 하나가 통째로 사라지는 거짓말입니다.
 *
 * ⚠️ **「이 기기에서」 를 뺐습니다.** 서버는 트랙이 어느 기기 것인지
 * 알려 주지 않습니다 — 다른 기기로 녹음 중일 수도 있습니다. 모르는 것을
 * 덧붙이지 않습니다.
 *
 * ⚠️⚠️ **`status` 하나만 보면 안 됩니다** (결함 404). 서버의 트랙은 녹음
 * 화면을 **열기만 해도** 만들어지고 그 순간부터 `status` 가 `recording`
 * 입니다(`join_track`) — 「참가했다」는 뜻이지 「소리가 들어온다」가
 * 아닙니다. 그래서 시작 버튼을 한 번도 안 누른 사람에게 이 카드가 초록
 * 「녹음 중입니다」를 띄우고 있었습니다. 같은 순간 **로비는 팀에게**
 * 「2분째 녹음이 한 조각도 안 왔습니다 — 녹음을 시작했는지
 * 확인해 주세요」라고 말하고 있었습니다 (그때 그 문장은 「그 폰에서」로
 * 시작했습니다 — 결함 446 에서 걷어냈습니다). 브라우저로 나란히 놓고
 * 쟀습니다(결함 290) — 정작 확인해야 할 본인만 괜찮다는 말을 들었습니다.
 *
 * 판단은 로비가 이미 하고 있으므로 **베끼지 않고 부릅니다**
 * (`isSilentTooLong`). 문장은 갈라 둡니다 — 로비는 남에게 하는 말이고
 * 여기는 자기 화면입니다(결함 344·358).
 *
 * @param track `GET /api/meetings/{id}/tracks` 에서 **내 user_id** 로 찾은 것.
 *              없으면 `undefined` — 그건 "아직 녹음 안 함" 입니다.
 *              ⚠️ 칸을 골라 넘기지 말고 **그대로** 넘기십시오(결함 368).
 */
export function describeMyCapture(track: TrackHealth | undefined): CaptureNote {
  if (track === undefined) {
    return { label: '아직 녹음 중이 아닙니다', tone: 'warn' };
  }
  switch (track.status) {
    case 'recording':
      if (isSilentTooLong(track)) {
        /* 조각이 **한 개도** 안 온 것과 오다가 끊긴 것은 할 일이 다릅니다
           — 로비가 갈라 둔 그대로입니다. */
        return (track.chunk_count ?? 0) === 0
          ? { label: '녹음이 한 조각도 안 올라갔습니다 — 녹음 화면을 확인하세요', tone: 'bad' }
          : { label: '녹음이 안 올라옵니다 — 녹음 화면을 확인하세요', tone: 'bad' };
      }
      return { label: '녹음 중입니다', tone: 'ok' };
    case 'completed':
      return { label: '녹음이 끝났습니다', tone: 'ok' };
    default:
      // unusable · aborted — "0" 이 아니라 "못 씀" 입니다.
      return { label: '녹음을 쓸 수 없습니다', tone: 'warn' };
  }
}

/**
 * 보낼 트랙이 없을 때 **받기만 하는 자리**를 열어야 하는가 (결함 221).
 *
 * ## 왜 이게 필요한가
 *
 * `RTCPeerConnection` 에 트랙을 하나도 안 붙이고 `createOffer()` 하면
 * **미디어 줄이 없는 SDP** 가 나옵니다. 브라우저로 쟀습니다(대조군 포함):
 *
 *     트랙 없음:  m= 줄 **0개** · ICE 후보 **0개**
 *     트랙 있음:  m= 줄 1개    · ICE 후보 2개
 *
 * 후보가 0개면 연결은 영영 성립하지 않습니다. 화면에는 「연결 준비 중」
 * 만 떠 있고, 왜 그런지는 아무 데도 안 나옵니다.
 *
 * ⚠️ **누가 거는지에 따라 갈립니다.** 거는 쪽은 `me < other` 로 정합니다
 * (`shouldInitiate`). 마이크 없는 사람의 `user_id` 가 작으면 그 사람이
 * 빈 offer 를 보내고 **그 짝은 죽습니다.** 반대면 상대가 소리를 담아
 * 걸어 주므로 붙습니다 — 같은 상황인데 번호로 운이 갈립니다.
 *
 * ⚠️⚠️ 그리고 이 파일은 이미 **"마이크가 켜지지 않았습니다 — 이 상태로는
 * 내 발언이 하나도 기록되지 않습니다"** 라고 경고하고 있었습니다. 그 문장은
 * "남의 목소리는 들린다" 를 전제로 합니다(`callWarnings` 머리 주석에 그렇게
 * 적혀 있습니다). 실제로는 **아무 소리도 못 듣는** 경우가 있었으니, 경고가
 * 사실보다 부드러웠던 셈입니다.
 *
 * ## 고침
 *
 * 보낼 것이 없어도 **받는 자리**(`recvonly` 트랜시버)를 엽니다. 그러면
 * m= 줄이 생겨 협상이 되고, 마이크 없는 사람도 **듣기는 합니다.** 그게
 * 원래 이 화면이 약속하던 것입니다.
 */
export function needsRecvOnlyAudio(localAudioTrackCount: number): boolean {
  return localAudioTrackCount === 0;
}
