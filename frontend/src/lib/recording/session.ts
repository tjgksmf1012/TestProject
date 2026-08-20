/**
 * 녹음 세션 상태 머신.
 *
 * docs/07-법적-윤리-요구사항.md §1, §2.3
 *
 * ## 왜 상태 머신인가
 *
 * "녹음 시작" 버튼 하나에 법적 요건이 걸려 있다.
 *
 *   - 통신비밀보호법: 당사자 녹음은 적법하지만, **제3자 녹음은 형사처벌**이다.
 *     참여자 전원이 동의했는지 확인하기 전에는 시작하면 안 된다.
 *   - 개인정보보호법: 음성은 개인정보다. 동의 단계 ①(recording)이 없으면
 *     수집 자체가 위법이다.
 *
 * 이걸 버튼의 `disabled` 속성으로 처리하면 언젠가 깨진다. 조건이 늘어나고,
 * 화면이 늘어나고, 어딘가에서 확인을 빼먹는다. **시작을 막는 규칙을 한 곳에
 * 모아 순수 함수로 두고 전부 테스트한다.**
 *
 * ## 중단을 다루는 방식
 *
 * iOS Safari 는 화면이 잠기면 오디오를 정지시킨다 (timeline.ts 참고).
 * 그래서 세션은 "중단됐을 수 있음"을 1급 상태로 갖는다. 다만 **화면이
 * 가려졌다는 사실만으로 공백을 지어내지는 않는다** — 실제 공백은 청크
 * 타이밍과 트랙 mute 이벤트로 판정한다 (timeline.buildTimeline).
 * 추측으로 데이터를 만들면 그게 또 다른 오답이 된다.
 */

import { consentStateOf, type RosterEntry } from '../lobby/room.ts';
import type { ChunkMeta, Interval, ServerTimeMs } from './types.ts';

export type Phase =
  /** 사전 조건이 아직 안 갖춰졌다 */
  | 'idle'
  /** 시작 가능 */
  | 'ready'
  | 'recording'
  /** 녹음 중인데 화면이 가려졌다 — 오디오가 끊겼을 수 있다 */
  | 'interrupted'
  /** 정지했고 남은 청크를 올리는 중 */
  | 'stopping'
  | 'completed'
  | 'failed';

export type PermissionState = 'unknown' | 'granted' | 'denied';

/** docs/07 §2.3 의 동의 단계 ① */
export type ConsentState =
  | 'pending'
  /** 나는 동의했지만 다른 참여자를 아직 기다린다 */
  | 'self_granted'
  /** 서버가 참여자 전원의 동의를 확인했다 */
  | 'all_confirmed'
  | 'refused';

export type ClockState = 'unsynced' | 'ok' | 'poor';

export type StopReason =
  | 'user'
  | 'consent_revoked'
  | 'backpressure'
  | 'error';

export interface SessionState {
  phase: Phase;
  /** getUserMedia 는 보안 컨텍스트(HTTPS 또는 localhost)에서만 동작한다 */
  secureContext: boolean;
  permission: PermissionState;
  consent: ConsentState;
  clock: ClockState;
  startedAtMs: ServerTimeMs | null;
  endedAtMs: ServerTimeMs | null;
  chunks: ChunkMeta[];
  /** 트랙이 실제로 mute 였던 구간. 확인된 사실만 들어간다. */
  mutedIntervals: Interval[];
  /** mute 진행 중이면 시작 시각 */
  muteStartedAtMs: ServerTimeMs | null;
  /** 화면이 가려진 횟수. 공백의 근거가 아니라 경고의 근거다. */
  interruptions: number;
  lostSeqs: number[];
  stopReason: StopReason | null;
  error: string | null;
}

export type SessionEvent =
  | { type: 'SECURE_CONTEXT'; secure: boolean }
  | { type: 'PERMISSION'; state: PermissionState }
  | { type: 'CONSENT'; state: ConsentState }
  | { type: 'CLOCK'; state: ClockState }
  | { type: 'START'; atMs: ServerTimeMs }
  | { type: 'CHUNK'; chunk: ChunkMeta }
  | { type: 'VISIBILITY'; hidden: boolean }
  | { type: 'TRACK_MUTE'; muted: boolean; atMs: ServerTimeMs }
  | { type: 'BACKPRESSURE'; active: boolean }
  | { type: 'STOP'; atMs: ServerTimeMs; reason?: StopReason }
  | { type: 'UPLOAD_DONE'; lostSeqs: readonly number[] }
  | { type: 'ERROR'; message: string };

export function initialState(): SessionState {
  return {
    phase: 'idle',
    secureContext: false,
    permission: 'unknown',
    consent: 'pending',
    clock: 'unsynced',
    startedAtMs: null,
    endedAtMs: null,
    chunks: [],
    mutedIntervals: [],
    muteStartedAtMs: null,
    interruptions: 0,
    lostSeqs: [],
    stopReason: null,
    error: null,
  };
}

/**
 * 지금 녹음을 시작할 수 없는 이유들.
 *
 * 빈 배열이면 시작 가능하다. 문구는 그대로 화면에 띄운다 —
 * "시작할 수 없습니다" 만 보여주고 이유를 숨기면 사용자가 고칠 수 없다.
 */
export function blockers(state: SessionState): string[] {
  const reasons: string[] = [];

  if (!state.secureContext) {
    reasons.push('HTTPS 연결이 필요합니다 (마이크는 보안 연결에서만 열립니다)');
  }
  if (state.permission === 'denied') {
    reasons.push('마이크 권한이 거부됐습니다. 브라우저 설정에서 허용해 주세요');
  } else if (state.permission !== 'granted') {
    reasons.push('마이크 권한을 아직 허용하지 않았습니다');
  }

  switch (state.consent) {
    case 'refused':
      reasons.push('참여자가 녹음에 동의하지 않았습니다');
      break;
    case 'self_granted':
      reasons.push('아직 동의하지 않은 참여자가 있습니다');
      break;
    case 'pending':
      reasons.push('녹음 동의가 필요합니다');
      break;
    case 'all_confirmed':
      break;
  }

  if (state.clock === 'unsynced') {
    reasons.push('서버와 시각을 맞추는 중입니다');
  } else if (state.clock === 'poor') {
    reasons.push('네트워크가 느려 시각 오차가 큽니다. 트랙 정렬이 실패할 수 있습니다');
  }

  return reasons;
}

/**
 * 트랙 참가가 막혔을 때 — **「아직」인가 「고장」인가.**
 *
 * ## ⛔ 처음 들어온 사람에게 빨간 오류를 보여 줬습니다 (결함 237)
 *
 * 아직 동의하지 않은 사람이 녹음 화면을 열면 서버가 403 을 줍니다.
 * 화면은 그것을 **모든 실패와 같이** 다뤘습니다.
 *
 *     트랙에 참가하지 못했습니다: 녹음에 동의하지 않았습니다   ← 빨강
 *     · 마이크 권한을 아직 허용하지 않았습니다                 ← 회색
 *     · 녹음 동의가 필요합니다                                 ← 회색
 *
 * **같은 사실이 두 번, 두 색으로** 나옵니다. 그리고 그 빨강은
 * ①~④ 단계 중 아직 안 한 첫 단계를 가리키는 것뿐입니다 — 고장이 아니라
 * **순서**입니다.
 *
 * `showNote` 는 이미 `'gap'` 색조를 갖고 있고, 그 주석이 정확히 이 경우를
 * 말합니다: "마이크 권한을 아직 안 준 것은 순서상 당연한 상태인데 빨갛게
 * 쓰면 「고장 났다」로 읽힙니다." 동의도 같은 부류인데 마이크 쪽만
 * 고쳐져 있었습니다 (실패 ② — 두 벌이 있으면 한쪽만 고쳐진다).
 *
 * ## 왜 상태 코드만으로 못 가르는가
 *
 * 이 엔드포인트의 403 은 **두 가지**입니다.
 *
 *     이 프로젝트의 구성원이 아닙니다   ← 진짜 문제
 *     녹음에 동의하지 않았습니다        ← 순서상 당연
 *
 * 서버 글월을 문자열로 맞춰 보는 것은 두 벌이 됩니다(서버가 한 글자
 * 고치면 조용히 갈라집니다). 대신 **화면이 이미 아는 것**으로 가릅니다 —
 * 결함 229 가 참가보다 **먼저** 동의를 읽게 해 뒀습니다.
 *
 * ⚠️ 동의가 **확인된** 상태에서 온 403 은 진짜 문제입니다(구성원이
 * 아니거나 서버가 다르게 봅니다). 그때는 빨강이 맞습니다.
 */
export interface JoinNote {
  text: string;
  tone: 'bad' | 'gap';
}

export function describeJoinFailure(
  status: number | null,
  detail: string,
  consent: ConsentState,
): JoinNote {
  if (status === 403 && consent !== 'all_confirmed') {
    // ⚠️ 아래 막는 목록이 **무엇이 모자란지** 이미 말합니다. 여기서 또
    //    말하면 같은 사실이 두 번 서고, 사람은 둘이 다른 일인 줄 압니다.
    return { text: '아직 트랙이 열리지 않았습니다 — 아래 조건이 차면 열립니다', tone: 'gap' };
  }
  return { text: `트랙에 참가하지 못했습니다: ${detail}`, tone: 'bad' };
}

export function canStart(state: SessionState): boolean {
  return blockers(state).length === 0;
}

/** 순수 리듀서. 부수효과 없음 — 그래서 전부 테스트된다. */
export function reduce(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    // 값이 그대로면 **같은 객체를 돌려준다.** 새 객체를 만들면 화면이
    // 아무 이유 없이 다시 그려지고, "바뀌었을 때만 알린다"가 성립하지 않는다.
    case 'SECURE_CONTEXT':
      if (state.secureContext === event.secure) return state;
      return settle({ ...state, secureContext: event.secure });

    case 'PERMISSION':
      if (state.permission === event.state) return state;
      return settle({ ...state, permission: event.state });

    case 'CONSENT': {
      if (state.consent === event.state) return state;
      const next = settle({ ...state, consent: event.state });
      // 녹음 중에 동의가 철회되면 즉시 멈춘다.
      // docs/07: "동의 철회 시 이후 녹음 제외 (이미 수집된 것은 보존기간까지)"
      // — 이미 받은 청크를 버리지는 않는다. 앞으로를 멈출 뿐이다.
      if (isLive(state.phase) && event.state === 'refused') {
        return { ...next, phase: 'stopping', stopReason: 'consent_revoked' };
      }
      return next;
    }

    case 'CLOCK':
      if (state.clock === event.state) return state;
      return settle({ ...state, clock: event.state });

    case 'START': {
      if (state.phase !== 'ready') return state;
      if (!canStart(state)) return state;
      return { ...state, phase: 'recording', startedAtMs: event.atMs };
    }

    case 'CHUNK': {
      // ⚠️ 'stopping' 에서도 받습니다 (결함 173). `MediaRecorder.stop()` 은
      // 마지막 조각을 **정지 뒤에** 흘려보내는데, 그 소리는 정지 **전에**
      // 녹음된 것입니다 — 회의의 끝, 결정이 말해지는 자리입니다. 여기서
      // 버리면 타임슬라이스 하나(최대 5초)가 매번 사라집니다. 동의 철회로
      // 멈춘 경우에도 이 조각은 철회 전 소리라 docs/07 의 "이미 수집된
      // 것" 에 해당합니다. completed 뒤에는 안 받습니다 — 요약이 이미
      // 만들어져, 받아도 아무 데도 못 갑니다.
      if (!isLive(state.phase) && state.phase !== 'stopping') return state;
      if (state.chunks.some((c) => c.seq === event.chunk.seq)) return state;
      return { ...state, chunks: [...state.chunks, event.chunk] };
    }

    case 'VISIBILITY': {
      if (!isLive(state.phase)) return state;
      if (event.hidden) {
        return { ...state, phase: 'interrupted', interruptions: state.interruptions + 1 };
      }
      return { ...state, phase: 'recording' };
    }

    case 'TRACK_MUTE': {
      if (!isLive(state.phase)) return state;
      if (event.muted) {
        if (state.muteStartedAtMs !== null) return state;
        return { ...state, muteStartedAtMs: event.atMs };
      }
      if (state.muteStartedAtMs === null) return state;
      return {
        ...state,
        muteStartedAtMs: null,
        mutedIntervals: [
          ...state.mutedIntervals,
          { startMs: state.muteStartedAtMs, endMs: event.atMs },
        ],
      };
    }

    case 'BACKPRESSURE': {
      // 업로드가 못 따라가는데 계속 녹음하면 메모리가 터진다.
      // 청크를 버리는 대신 녹음을 멈춘다 — 온전한 59분이 구멍난 60분보다 낫다.
      if (!event.active || !isLive(state.phase)) return state;
      return { ...state, phase: 'stopping', stopReason: 'backpressure' };
    }

    case 'STOP': {
      if (state.phase === 'stopping') {
        return { ...state, endedAtMs: state.endedAtMs ?? event.atMs };
      }
      if (!isLive(state.phase)) return state;
      return {
        ...state,
        phase: 'stopping',
        endedAtMs: event.atMs,
        stopReason: event.reason ?? 'user',
        // 정지 시점에 mute 가 진행 중이었으면 거기서 끊어 닫는다
        ...closeOpenMute(state, event.atMs),
      };
    }

    case 'UPLOAD_DONE': {
      if (state.phase !== 'stopping') return state;
      return { ...state, phase: 'completed', lostSeqs: [...event.lostSeqs] };
    }

    case 'ERROR':
      return { ...state, phase: 'failed', error: event.message, stopReason: 'error' };
  }
}

function isLive(phase: Phase): boolean {
  return phase === 'recording' || phase === 'interrupted';
}

function closeOpenMute(
  state: SessionState,
  atMs: ServerTimeMs,
): Pick<SessionState, 'mutedIntervals' | 'muteStartedAtMs'> {
  if (state.muteStartedAtMs === null) {
    return { mutedIntervals: state.mutedIntervals, muteStartedAtMs: null };
  }
  return {
    mutedIntervals: [...state.mutedIntervals, { startMs: state.muteStartedAtMs, endMs: atMs }],
    muteStartedAtMs: null,
  };
}

/** 사전 조건이 바뀌면 idle ↔ ready 를 다시 계산한다. 녹음 중이면 건드리지 않는다. */
function settle(state: SessionState): SessionState {
  if (state.phase !== 'idle' && state.phase !== 'ready') return state;
  return { ...state, phase: canStart(state) ? 'ready' : 'idle' };
}

/** 여러 이벤트를 순서대로 적용한다. 테스트와 재생(replay)에 쓴다. */
export function reduceAll(
  state: SessionState,
  events: readonly SessionEvent[],
): SessionState {
  return events.reduce(reduce, state);
}

/** 세션이 끝난 뒤 `buildTimeline` 에 그대로 넘길 입력. */
export interface TimelineInputFromSession {
  chunks: ChunkMeta[];
  startedAtMs: ServerTimeMs;
  endedAtMs: ServerTimeMs;
  mutedIntervals: Interval[];
  lostSeqs: number[];
}

export function toTimelineInput(state: SessionState): TimelineInputFromSession {
  if (state.startedAtMs === null || state.endedAtMs === null) {
    throw new Error('녹음이 시작·종료되지 않은 세션입니다');
  }
  return {
    chunks: state.chunks,
    startedAtMs: state.startedAtMs,
    endedAtMs: state.endedAtMs,
    mutedIntervals: state.mutedIntervals,
    lostSeqs: state.lostSeqs,
  };
}

/**
 * 서버의 동의 명부를 이 화면의 동의 상태로.
 *
 * ## ⛔ 녹음 화면이 **자기 스스로 「전원 동의」를 선언**하고 있었습니다 (결함 229)
 *
 * `index.html` 의 「녹음에 동의」 단추가 이랬습니다.
 *
 *     $('consent').addEventListener('click', () => {
 *       // 실험용이므로 로컬에서 동의를 확정한다.
 *       client.setConsent('all_confirmed');
 *     });
 *
 * 서버에는 동의 명부가 **이미 있고**(`GET /api/meetings/{id}/consent`),
 * 로비가 그걸 씁니다. 녹음 화면만 안 불렀습니다 — 이 저장소의 실패 ①
 * (만들어 놓고 아무도 안 부름) 이 하필 가장 민감한 자리에서 났습니다.
 *
 * 재현한 것:
 *
 *   1. 로비에서 셋이 다 동의했는데도 녹음 화면은 「녹음 동의가 필요합니다」
 *      — 진짜 동의가 화면에 **한 번도 안 닿습니다.**
 *   2. **아무도 동의하지 않은** 회의에서 혼자 그 단추를 누르면 막는 이유가
 *      전부 사라지고 「준비됐습니다」가 되며, 녹음이 실제로 돕니다
 *      (청크 1개, 마이크 켜짐). 서버는 트랙 참가를 403 으로 막지만
 *      그 말은 화면 **다른 줄**에 있고, 같은 화면이 동시에
 *      「녹음 중」이라고 말합니다.
 *
 * `docs/07` §1 은 제3자 녹음을 형사처벌 대상으로 적어 두었고, 바로 위
 * `blockers` 에도 그 갈래가 있습니다. **판단은 멀쩡했고 화면이 그 판단에
 * 값을 안 물어본 것**입니다.
 *
 * ⚠️ 거부가 먼저입니다. 한 명이라도 거부하면 내가 동의했는지와 무관하게
 * 이 회의는 녹음할 수 없습니다.
 *
 * ⚠️ **응답 본문을 통째로 받습니다.** 화면이 `body.roster ?? []` 를 쓰면
 * "명부를 못 받았다" 를 다루는 규칙이 화면으로 새고, 화면에는 자동 검사가
 * 없습니다. 덤으로 화면이 `RosterEntry` 를 이름으로 부를 일이 없어집니다 —
 * 결함 93 가드가 타입 이름으로 훑을 파일을 고르기 때문에, 이름을 부르면
 * 녹음 화면의 **다른** `track_id` 가 로비 것으로 잘못 세어집니다.
 */
export function consentStateFrom(
  body: { roster?: readonly RosterEntry[] } | null | undefined,
  myUserId: number | null,
): ConsentState {
  // 명부를 못 받았으면 **모르는 것**입니다. 모르는 것을 동의로 읽지 않습니다.
  const roster = body?.roster ?? [];
  if (roster.length === 0) return 'pending';

  const states = roster.map((entry) => ({ entry, state: consentStateOf(entry) }));
  if (states.some(({ state }) => state === 'refused')) return 'refused';

  const mine = myUserId === null ? undefined : states.find(({ entry }) => entry.user_id === myUserId);
  if (mine === undefined || mine.state !== 'granted') return 'pending';

  return states.every(({ state }) => state === 'granted') ? 'all_confirmed' : 'self_granted';
}
