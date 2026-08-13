/**
 * 녹음 클라이언트 조립.
 *
 * 순수 모듈들(clock, timeline, upload-queue, session)을 하나로 묶는다.
 * **브라우저 API 는 전부 주입받는다** — `getUserMedia`, `MediaRecorder`,
 * `performance.now`, `fetch` 중 어느 것도 직접 부르지 않는다.
 * 그래서 이 파일까지 Node 에서 검증된다.
 *
 * 실제 브라우저 어댑터는 `browser-adapter.ts` 에 있다 (그쪽은 얇다).
 *
 * ## 여기 있는 로직이 왜 중요한가
 *
 * seq 번호를 매기고 도착 시각을 찍는 게 이 파일이다. 그 두 값이
 * `buildTimeline` 의 유일한 입력이고, 타임라인이 틀리면 트랙 정렬이 틀리고,
 * 정렬이 틀리면 기여도가 틀린다. 사슬의 첫 고리라서 어댑터에 섞어두면 안 된다.
 */

import { ClockTracker, checkSync, estimateClock, type ClockSample } from './clock.ts';
import {
  DEFAULT_TIMESLICE_MS,
  captureConfidence,
  checkAppliedSettings,
  type AppliedAudioSettings,
  type CaptureWarning,
} from './capture.ts';
import {
  initialState,
  reduce,
  toTimelineInput,
  type SessionEvent,
  type SessionState,
} from './session.ts';
import { buildTimeline, judgeTrack, type Timeline, type TrackVerdict } from './timeline.ts';
import { UploadQueue, type UploadTransport } from './upload-queue.ts';
import type { MonotonicClock } from './types.ts';

// ══════════════════════════════════════════════════════════════
// 주입되는 것들
// ══════════════════════════════════════════════════════════════

/** 서버 왕복 한 번. 서버는 받은 시각(t1)과 보낸 시각(t2)을 돌려준다. */
export interface SyncTransport {
  probe(): Promise<{ t1: number; t2: number }>;
}

export interface AudioTrackHandle {
  /** 실제로 적용된 제약. 요청한 대로 됐는지 확인하는 용도. */
  getSettings(): AppliedAudioSettings;
  /** 트랙이 mute/unmute 될 때 호출된다. iOS 백그라운드 전환이 여기로 온다. */
  onMuteChange(listener: (muted: boolean) => void): void;
  stop(): void;
}

export interface RecorderHandle {
  start(timesliceMs: number): void;
  stop(): void;
  onData(listener: (data: { byteLength: number; payload: unknown }) => void): void;
  onError(listener: (error: Error) => void): void;
}

export interface MediaAdapter {
  isSecureContext(): boolean;
  requestMicrophone(): Promise<AudioTrackHandle>;
  createRecorder(track: AudioTrackHandle): RecorderHandle;
}

export interface RecordingClientOptions {
  monotonic: MonotonicClock;
  media: MediaAdapter;
  sync: SyncTransport;
  upload: UploadTransport;
  timesliceMs?: number;
  /** 시각 동기화 표본 수. 많을수록 좋은 표본을 만날 확률이 오른다. */
  syncSamples?: number;
  onStateChange?: (state: SessionState) => void;
  uploadOptions?: ConstructorParameters<typeof UploadQueue>[1];
}

export interface RecordingSummary {
  state: SessionState;
  timeline: Timeline;
  verdict: TrackVerdict;
  /** 캡처 설정 문제로 낮아진 신뢰도 (0~1) */
  captureConfidence: number;
  warnings: CaptureWarning[];
  /**
   * 서버가 못 받았지만 **이 컴퓨터 디스크에 남아 있는** seq (`docs/21` Phase 1).
   *
   * ⚠️ `timeline` 의 공백에는 그대로 들어 있습니다 — 서버 기준으로는
   * 지금 없는 것이 맞습니다. 이 목록은 "되찾을 수 있다" 만 더합니다.
   * 보관소가 없으면(브라우저) 언제나 빈 배열입니다.
   */
  parked: number[];
  /**
   * `MediaRecorder.start(timeslice)` 에 넘긴 값.
   *
   * 서버가 배치를 다시 계산할 때 필요합니다 — 종료 요청에 실어 보냅니다.
   * 요약에 넣어 두지 않으면 화면 코드가 이 값을 알 방법이 없어, 기본값을
   * 짐작해 보내게 됩니다. 짐작이 틀리면 서버의 공백 계산이 어긋납니다.
   */
  timesliceMs: number;
}

// ══════════════════════════════════════════════════════════════

export class RecordingClient {
  #options: RecordingClientOptions;
  #timesliceMs: number;
  #clock: ClockTracker;
  #queue: UploadQueue;
  #state: SessionState = initialState();

  #track: AudioTrackHandle | null = null;
  #recorder: RecorderHandle | null = null;
  #nextSeq = 0;
  #warnings: CaptureWarning[] = [];

  constructor(options: RecordingClientOptions) {
    this.#options = options;
    this.#timesliceMs = options.timesliceMs ?? DEFAULT_TIMESLICE_MS;
    this.#clock = new ClockTracker(options.monotonic);
    this.#queue = new UploadQueue(options.upload, options.uploadOptions);

    // ⚠️ **생성자에서 `#dispatch` 를 부르면 안 됩니다.**
    //
    // `#dispatch` 는 `onStateChange` 를 부르는데, 그 시점에는 아직
    // `const client = new RecordingClient(...)` 의 대입이 끝나지 않았습니다.
    // 콜백이 `client.state` 를 읽으면 **`client` 가 undefined** 입니다.
    //
    // 실제로 그랬습니다 — 녹음 화면이 열리자마자
    // `Cannot read properties of undefined (reading 'state')` 로 죽었고,
    // 브라우저로 띄워 보고서야 알았습니다. 화면 코드에는 자동 테스트가
    // 없고, 이 클래스의 테스트는 콜백 안에서 자기 자신을 읽지 않습니다.
    //
    // 호출자가 올바르게 대응할 방법이 없는 구조라 여기서 고칩니다.
    // 초기 사실은 **이벤트가 아니라 초기 상태**로 넣습니다 — 아무도
    // 아직 듣고 있지 않은 시점의 '변화' 는 변화가 아닙니다.
    this.#state = reduce(this.#state, {
      type: 'SECURE_CONTEXT',
      secure: options.media.isSecureContext(),
    });
  }

  get state(): SessionState {
    return this.#state;
  }

  get warnings(): readonly CaptureWarning[] {
    return this.#warnings;
  }

  /**
   * 참여자 동의 상태는 서버가 판단한다. 클라이언트는 전달만 한다.
   *
   * 녹음 중에 철회가 들어오면 **그 자리에서 마이크를 끈다.** 상태만 바꾸고
   * 레코더를 살려두면 동의 없이 녹음이 계속된다 — 통신비밀보호법 문제다.
   */
  setConsent(state: SessionState['consent']): void {
    this.#dispatch({ type: 'CONSENT', state });
    if (this.#state.stopReason === 'consent_revoked' && this.#state.endedAtMs === null) {
      this.#halt();
    }
  }

  /** 탭 가시성 변화. iOS 에서는 이게 오디오 중단 신호일 수 있다. */
  setHidden(hidden: boolean): void {
    this.#dispatch({ type: 'VISIBILITY', hidden });
  }

  /**
   * 서버와 시각을 맞춘다.
   *
   * 녹음 시작 전에 한 번, 그리고 회의 중 5분마다 다시 부르는 걸 권장한다.
   * 기기 시계가 흐르기 때문이다 (clock.ts 의 드리프트 설명 참고).
   * 타이머는 여기 두지 않는다 — 화면 쪽에서 걸어야 테스트가 깨끗하다.
   */
  async syncClock(): Promise<void> {
    const samples: ClockSample[] = [];
    const count = this.#options.syncSamples ?? 5;
    for (let i = 0; i < count; i += 1) {
      const t0 = this.#options.monotonic();
      const { t1, t2 } = await this.#options.sync.probe();
      samples.push({ t0, t1, t2, t3: this.#options.monotonic() });
    }

    try {
      const estimate = estimateClock(samples);
      this.#clock.push(estimate);
      this.#dispatch({ type: 'CLOCK', state: checkSync(estimate).ok ? 'ok' : 'poor' });
    } catch {
      this.#dispatch({ type: 'CLOCK', state: 'unsynced' });
    }
  }

  /** 마이크 권한을 얻고, 실제로 적용된 설정을 확인한다. */
  async requestMicrophone(): Promise<void> {
    try {
      const track = await this.#options.media.requestMicrophone();
      this.#track = track;
      this.#warnings = checkAppliedSettings(track.getSettings());
      track.onMuteChange((muted) => {
        // 시각 동기화 전의 mute 는 기록하지 않는다. 시각이 없으면 구간을
        // 만들 수 없고, 지어내면 엉뚱한 자리에 공백이 생긴다.
        if (!this.#clock.synced) return;
        this.#dispatch({ type: 'TRACK_MUTE', muted, atMs: this.#clock.now() });
      });
      this.#dispatch({ type: 'PERMISSION', state: 'granted' });
    } catch {
      this.#dispatch({ type: 'PERMISSION', state: 'denied' });
    }
  }

  /**
   * 녹음을 시작한다.
   *
   * 사전 조건이 하나라도 안 맞으면 아무 일도 일어나지 않는다.
   * 판단은 전부 `session.blockers` 가 한다 — 여기 조건문을 복제하지 않는다.
   */
  start(): boolean {
    if (this.#state.phase !== 'ready' || !this.#track) return false;

    const recorder = this.#options.media.createRecorder(this.#track);
    this.#recorder = recorder;
    recorder.onData((data) => this.#onData(data));
    recorder.onError((error) => this.#dispatch({ type: 'ERROR', message: error.message }));

    this.#queue.start();
    // 반환값을 쓴다. `this.#state` 를 다시 읽으면 TypeScript 가 위 가드에서
    // 좁혀둔 'ready' 를 그대로 들고 있어 비교가 항상 거짓으로 보인다.
    const started = this.#dispatch({ type: 'START', atMs: this.#clock.now() });
    recorder.start(this.#timesliceMs);
    return started.phase === 'recording';
  }

  /**
   * 정지하고, 남은 청크를 전부 올린 뒤, 트랙 판정까지 만들어 돌려준다.
   *
   * @throws 녹음을 시작한 적이 없으면
   */
  async stop(): Promise<RecordingSummary> {
    if (this.#state.startedAtMs === null) {
      throw new Error('녹음을 시작한 적이 없습니다');
    }
    this.#halt();

    const result = await this.#queue.finish();
    this.#dispatch({ type: 'UPLOAD_DONE', lostSeqs: result.lost });

    const timeline = buildTimeline(this.#state.chunks, {
      ...toTimelineInput(this.#state),
      timesliceMs: this.#timesliceMs,
    });

    return {
      state: this.#state,
      timeline,
      verdict: judgeTrack(timeline),
      captureConfidence: captureConfidence(this.#warnings),
      warnings: [...this.#warnings],
      parked: result.parked,
      timesliceMs: this.#timesliceMs,
    };
  }

  #onData(data: { byteLength: number; payload: unknown }): void {
    // 녹음이 끝난 뒤 도착한 마지막 청크는 세션이 알아서 무시한다.
    const seq = this.#nextSeq;
    this.#nextSeq += 1;

    const chunk = { seq, atMs: this.#clock.now(), byteLength: data.byteLength };
    this.#dispatch({ type: 'CHUNK', chunk });
    const status = this.#queue.enqueue({
      seq,
      atMs: chunk.atMs,
      byteLength: data.byteLength,
      payload: data.payload,
    });

    if (status.backpressure) {
      // 업로드가 못 따라간다. 청크를 버리지 않고 녹음을 멈춘다.
      this.#dispatch({ type: 'BACKPRESSURE', active: true });
      this.#halt();
    }
  }

  /** 마이크를 끄고 종료 시각을 찍는다. 여러 경로에서 불려도 한 번만 먹는다. */
  #halt(): void {
    this.#recorder?.stop();
    this.#track?.stop();
    this.#dispatch({ type: 'STOP', atMs: this.#clock.now() });
  }

  /** 이벤트를 적용하고 **새 상태를 돌려준다.** 호출자가 다시 읽지 않게 하려는 것이다. */
  #dispatch(event: SessionEvent): SessionState {
    const next = reduce(this.#state, event);
    if (next === this.#state) return next;
    this.#state = next;
    this.#options.onStateChange?.(next);
    return next;
  }
}
