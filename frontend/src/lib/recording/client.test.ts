import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RecordingClient,
  type AudioTrackHandle,
  type MediaAdapter,
  type RecorderHandle,
  type SyncTransport,
} from './client.ts';
import type { AppliedAudioSettings } from './capture.ts';
import type { PendingChunk, UploadTransport } from './upload-queue.ts';

const TRUE_OFFSET = 1_700_000_000_000;
const CLEAN_SETTINGS: AppliedAudioSettings = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
  sampleRate: 16_000,
};

/** 우리가 직접 굴리는 단조 시계 */
class FakeClock {
  ms = 10_000;
  now = (): number => this.ms;
  advance(by: number): void {
    this.ms += by;
  }
}

class FakeTrack implements AudioTrackHandle {
  stopped = false;
  #settings: AppliedAudioSettings;
  #listener: ((muted: boolean) => void) | null = null;

  constructor(settings: AppliedAudioSettings = CLEAN_SETTINGS) {
    this.#settings = settings;
  }

  getSettings(): AppliedAudioSettings {
    return this.#settings;
  }
  onMuteChange(listener: (muted: boolean) => void): void {
    this.#listener = listener;
  }
  stop(): void {
    this.stopped = true;
  }
  emitMute(muted: boolean): void {
    this.#listener?.(muted);
  }
}

class FakeRecorder implements RecorderHandle {
  started = false;
  stopCount = 0;
  timesliceMs = 0;
  /** stop() 때 흘러나올 마지막 조각 크기. 0 이면 없음. */
  finalFlushBytes = 0;
  #data: ((d: { byteLength: number; payload: unknown }) => void) | null = null;
  #error: ((e: Error) => void) | null = null;

  start(timesliceMs: number): void {
    this.started = true;
    this.timesliceMs = timesliceMs;
  }
  stop(): void | Promise<void> {
    this.stopCount += 1;
    this.started = false;
    if (this.finalFlushBytes === 0) return;
    // 실제 MediaRecorder 의 순서 그대로 — stop() 이 돌아간 **뒤에**
    // dataavailable 이 서고, 'stop'(= 이 약속의 이행)이 그 다음이다.
    const bytes = this.finalFlushBytes;
    this.finalFlushBytes = 0;
    return Promise.resolve().then(() => this.emit(bytes));
  }
  onData(listener: (d: { byteLength: number; payload: unknown }) => void): void {
    this.#data = listener;
  }
  onError(listener: (e: Error) => void): void {
    this.#error = listener;
  }
  emit(byteLength = 20_000): void {
    this.#data?.({ byteLength, payload: `blob-${byteLength}` });
  }
  fail(message: string): void {
    this.#error?.(new Error(message));
  }
}

interface Harness {
  clock: FakeClock;
  track: FakeTrack;
  recorder: FakeRecorder;
  media: MediaAdapter;
  sync: SyncTransport;
  uploaded: number[];
  client: RecordingClient;
}

function harness({
  secure = true,
  denyMic = false,
  settings = CLEAN_SETTINGS,
  oneWayDelay = 10,
  failSeqs = new Set<number>(),
  maxPendingBytes,
}: {
  secure?: boolean;
  denyMic?: boolean;
  settings?: AppliedAudioSettings;
  oneWayDelay?: number;
  failSeqs?: Set<number>;
  maxPendingBytes?: number;
} = {}): Harness {
  const clock = new FakeClock();
  const track = new FakeTrack(settings);
  const recorder = new FakeRecorder();
  const uploaded: number[] = [];

  const media: MediaAdapter = {
    isSecureContext: () => secure,
    requestMicrophone: async () => {
      if (denyMic) throw new Error('NotAllowedError');
      return track;
    },
    createRecorder: () => recorder,
  };

  const sync: SyncTransport = {
    probe: async () => {
      clock.advance(oneWayDelay);
      const t1 = clock.ms + TRUE_OFFSET;
      clock.advance(2); // 서버 처리
      const t2 = clock.ms + TRUE_OFFSET;
      clock.advance(oneWayDelay);
      return { t1, t2 };
    },
  };

  const upload: UploadTransport = {
    send: async (chunk: PendingChunk) => {
      if (failSeqs.has(chunk.seq)) throw new Error(`업로드 실패 seq=${chunk.seq}`);
      uploaded.push(chunk.seq);
    },
  };

  const client = new RecordingClient({
    monotonic: clock.now,
    media,
    sync,
    upload,
    timesliceMs: 5_000,
    uploadOptions: { sleep: async () => {}, maxAttempts: 2, concurrency: 1, maxPendingBytes },
  });

  return { clock, track, recorder, media, sync, uploaded, client };
}

/** 동의까지 마쳐 ready 로 만든다 */
async function prepared(options: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const h = harness(options);
  await h.client.syncClock();
  await h.client.requestMicrophone();
  h.client.setConsent('all_confirmed');
  return h;
}

describe('RecordingClient — 준비 단계', () => {
  it('동기화·권한·동의를 마치면 ready 가 된다', async () => {
    const { client } = await prepared();
    assert.equal(client.state.phase, 'ready');
    assert.equal(client.state.clock, 'ok');
    assert.equal(client.state.permission, 'granted');
  });

  it('HTTP 로 열면 시작할 수 없다', async () => {
    const { client } = await prepared({ secure: false });
    assert.equal(client.state.phase, 'idle');
    assert.equal(client.start(), false);
  });

  it('마이크 권한이 거부되면 denied 로 남는다', async () => {
    const { client } = await prepared({ denyMic: true });
    assert.equal(client.state.permission, 'denied');
    assert.equal(client.start(), false);
  });

  it('⭐ 전원 동의 전에는 레코더를 만들지도 않는다', async () => {
    const h = harness();
    await h.client.syncClock();
    await h.client.requestMicrophone();
    h.client.setConsent('self_granted');

    assert.equal(h.client.start(), false);
    assert.equal(h.recorder.started, false, '레코더가 켜지면 안 된다');
  });

  it('네트워크가 느리면 시각 동기화를 poor 로 보고 막는다', async () => {
    // 편도 400ms → 왕복 800ms → 오차 상한 400ms > 허용치 250ms
    const { client } = await prepared({ oneWayDelay: 400 });
    assert.equal(client.state.clock, 'poor');
    assert.equal(client.start(), false);
  });
});

describe('RecordingClient — 녹음', () => {
  it('시작하면 레코더가 timeslice 와 함께 켜진다', async () => {
    const h = await prepared();
    assert.equal(h.client.start(), true);
    assert.equal(h.recorder.started, true);
    assert.equal(h.recorder.timesliceMs, 5_000);
  });

  it('⭐ seq 는 0부터 빠짐없이 올라간다', async () => {
    const h = await prepared();
    h.client.start();
    for (let i = 0; i < 4; i += 1) {
      h.clock.advance(5_000);
      h.recorder.emit();
    }
    assert.deepEqual(
      h.client.state.chunks.map((c) => c.seq),
      [0, 1, 2, 3],
    );
  });

  it('⭐ 청크 시각이 서버 시각 기준으로 찍힌다', async () => {
    const h = await prepared();
    h.client.start();
    const startedAt = h.client.state.startedAtMs!;
    h.clock.advance(5_000);
    h.recorder.emit();

    assert.equal(startedAt, h.clock.ms - 5_000 + TRUE_OFFSET);
    assert.equal(h.client.state.chunks[0]!.atMs, startedAt + 5_000);
  });

  it('레코더 오류는 failed 로 끝난다', async () => {
    const h = await prepared();
    h.client.start();
    h.recorder.fail('마이크가 분리됐습니다');
    assert.equal(h.client.state.phase, 'failed');
    assert.equal(h.client.state.error, '마이크가 분리됐습니다');
  });

  it('트랙 mute 는 구간으로 기록된다', async () => {
    const h = await prepared();
    h.client.start();
    h.clock.advance(10_000);
    h.track.emitMute(true);
    h.clock.advance(15_000);
    h.track.emitMute(false);

    assert.equal(h.client.state.mutedIntervals.length, 1);
    assert.equal(h.client.state.mutedIntervals[0]!.endMs - h.client.state.mutedIntervals[0]!.startMs, 15_000);
  });

  it('시각 동기화 전에 온 mute 는 무시한다', () => {
    // 시각이 없으면 구간을 만들 수 없다. 지어내면 엉뚱한 자리에 공백이 생긴다.
    const h = harness();
    assert.doesNotThrow(() => h.track.emitMute(true));
    assert.deepEqual(h.client.state.mutedIntervals, []);
  });
});

describe('RecordingClient — 재연결 후 재개 (Phase 4)', () => {
  it('⭐ 서버가 이미 가진 seq 는 다시 안 올린다', async () => {
    // 이게 없으면 재연결마다 처음부터 다시 올려 영영 못 따라잡는다.
    const h = await prepared();
    h.client.start();
    for (let i = 0; i < 5; i += 1) {
      h.clock.advance(5_000);
      h.recorder.emit();
    }
    assert.equal(h.client.resumeFrom([0, 1, 2]), 3);
  });

  it('⚠️ 이 세션이 아직 안 만든 seq 는 건너뛰지 않는다 — 새 소리를 버리게 된다', async () => {
    // 새로고침하면 seq 가 0부터 다시 시작한다. 그때 서버가 가진 0..40 을
    // 그대로 건너뛰면 **새로 녹음한 청크 41개가 사라진다.** 앞선 세션의
    // 것이지 지금 큐에 든 것이 아니다.
    const h = await prepared();
    h.client.start();
    h.clock.advance(5_000);
    h.recorder.emit(); // seq 0 하나만 만든 상태

    assert.equal(h.client.resumeFrom([0, 1, 2, 3, 40]), 1);
  });

  it('⚠️ 녹음 중이 아니면 무시한다 — 부르는 쪽에 국면 판단을 맡기지 않는다', async () => {
    const h = await prepared();
    // 아직 start() 전 = 'ready'
    assert.equal(h.client.resumeFrom([0, 1, 2]), 0);
  });

  it('빈 목록이면 아무 일도 없다', async () => {
    const h = await prepared();
    h.client.start();
    h.clock.advance(5_000);
    h.recorder.emit();
    assert.equal(h.client.resumeFrom([]), 0);
  });
});

describe('RecordingClient — 종료', () => {
  it('정지하면 마이크를 끄고 요약을 돌려준다', async () => {
    const h = await prepared();
    h.client.start();
    for (let i = 0; i < 12; i += 1) {
      h.clock.advance(5_000);
      h.recorder.emit();
    }
    const summary = await h.client.stop();

    assert.equal(h.recorder.stopCount, 1);
    assert.equal(h.track.stopped, true);
    assert.equal(summary.state.phase, 'completed');
    assert.equal(summary.timeline.coverage, 1);
    assert.equal(summary.verdict.usable, true);
    assert.deepEqual(h.uploaded, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('⭐ 정지 직후 흘러나온 마지막 조각도 세고 올린다 (결함 173)', async () => {
    // MediaRecorder.stop() 은 남은 소리(타임슬라이스 미만)를 정지 **뒤에**
    // 흘려보낸다. 예전에는 세션이 버리고 큐는 이미 닫혀 있어서, 회의의
    // 끝 — 결정이 말해지는 자리 — 이 매번 최대 5초씩 사라졌다.
    const h = await prepared();
    h.client.start();
    for (let i = 0; i < 3; i += 1) {
      h.clock.advance(5_000);
      h.recorder.emit();
    }
    h.clock.advance(2_500); // 타임슬라이스 절반에서 정지 버튼
    h.recorder.finalFlushBytes = 9_000;
    const summary = await h.client.stop();

    assert.deepEqual(
      summary.state.chunks.map((c) => c.seq),
      [0, 1, 2, 3],
      '마지막 조각이 타임라인에 세어져야 한다',
    );
    assert.deepEqual(h.uploaded, [0, 1, 2, 3], '마지막 조각이 서버로 올라가야 한다');
    assert.equal(summary.timeline.coverage, 1, '꼬리 공백이 없어야 한다');
  });

  it('시작한 적이 없으면 정지할 수 없다', async () => {
    const { client } = await prepared();
    await assert.rejects(() => client.stop(), /시작한 적이 없습니다/);
  });

  it('⭐ 업로드에 실패한 청크가 타임라인 공백으로 이어진다', async () => {
    const h = await prepared({ failSeqs: new Set([2]) });
    h.client.start();
    for (let i = 0; i < 6; i += 1) {
      h.clock.advance(5_000);
      h.recorder.emit();
    }
    const summary = await h.client.stop();

    assert.deepEqual(summary.state.lostSeqs, [2]);
    assert.equal(summary.timeline.gaps.length, 1);
    assert.equal(summary.timeline.gaps[0]!.reason, 'chunk_lost');
    assert.equal(summary.timeline.gaps[0]!.durationMs, 5_000);
  });

  it('⭐ 화면이 잠겨 청크가 끊긴 구간을 찾아낸다', async () => {
    const h = await prepared();
    h.client.start();
    for (let i = 0; i < 4; i += 1) {
      h.clock.advance(5_000);
      h.recorder.emit();
    }
    // 30초 동안 iOS 가 오디오를 멈춰 청크가 아예 안 온다
    h.client.setHidden(true);
    h.clock.advance(35_000);
    h.client.setHidden(false);
    h.recorder.emit();

    const summary = await h.client.stop();
    assert.equal(summary.state.interruptions, 1);
    assert.equal(summary.timeline.gaps.length, 1);
    assert.equal(summary.timeline.gaps[0]!.durationMs, 30_000);
    assert.equal(summary.timeline.gaps[0]!.reason, 'recorder_stalled');
  });
});

describe('RecordingClient — 자동 중단', () => {
  it('⭐ 업로드가 밀리면 청크를 버리지 않고 녹음을 멈춘다', async () => {
    // 한도를 청크 2개분으로 잡고, 업로드가 전부 실패하게 만든다
    const h = await prepared({
      maxPendingBytes: 30_000,
      failSeqs: new Set([0, 1, 2, 3, 4, 5]),
    });
    h.client.start();
    h.clock.advance(5_000);
    h.recorder.emit();
    h.clock.advance(5_000);
    h.recorder.emit();

    assert.equal(h.client.state.phase, 'stopping');
    assert.equal(h.client.state.stopReason, 'backpressure');
    assert.ok(h.recorder.stopCount >= 1, '레코더가 실제로 꺼져야 한다');
    assert.equal(h.client.state.endedAtMs !== null, true, '종료 시각이 찍혀야 한다');
  });

  it('⭐ 녹음 중 동의가 철회되면 그 자리에서 마이크를 끈다', async () => {
    const h = await prepared();
    h.client.start();
    h.clock.advance(5_000);
    h.recorder.emit();

    h.client.setConsent('refused');

    assert.equal(h.recorder.stopCount, 1, '상태만 바꾸고 끝내면 녹음이 계속된다');
    assert.equal(h.track.stopped, true);
    assert.equal(h.client.state.stopReason, 'consent_revoked');
    assert.equal(h.client.state.chunks.length, 1, '이미 받은 건 버리지 않는다');
  });

  it('철회 뒤 흘러나온 마지막 조각은 남는다 — 마이크가 먼저 꺼져 있다 (결함 173)', async () => {
    // 철회 순간 레코더와 트랙이 같이 죽는다(위 테스트가 잰다). 그러므로
    // 그 뒤에 도착하는 것은 철회 **전**에 담긴 소리의 플러시뿐이고,
    // docs/07 은 그것을 남기라고 한다 — "이미 수집된 것은 보존기간까지".
    // 예전에는 이것까지 버려서 철회 직전 구간이 매번 사라졌다.
    const h = await prepared();
    h.client.start();
    h.client.setConsent('refused');
    assert.equal(h.track.stopped, true, '새 소리가 담길 길이 먼저 끊겨 있어야 한다');
    h.recorder.emit(9_000);
    assert.equal(h.client.state.chunks.length, 1);
  });
});

describe('RecordingClient — 캡처 설정', () => {
  it('AGC 가 안 꺼진 기기도 녹음은 되지만 신뢰도가 낮아진다', async () => {
    const h = await prepared({
      settings: { ...CLEAN_SETTINGS, autoGainControl: true },
    });
    assert.equal(h.client.warnings.length, 1);
    assert.equal(h.client.start(), true, '아이폰 팀원을 배제하지 않는다');

    h.clock.advance(5_000);
    h.recorder.emit();
    const summary = await h.client.stop();
    assert.equal(summary.captureConfidence, 0.7);
    assert.equal(summary.warnings[0]!.setting, 'autoGainControl');
  });

  it('설정이 깨끗하면 신뢰도가 1이다', async () => {
    const h = await prepared();
    h.client.start();
    h.clock.advance(5_000);
    h.recorder.emit();
    const summary = await h.client.stop();
    assert.equal(summary.captureConfidence, 1);
    assert.deepEqual(summary.warnings, []);
  });
});

describe('RecordingClient — 상태 알림', () => {
  it('상태가 바뀔 때만 알린다', async () => {
    const seen: string[] = [];
    const h = harness();
    const client = new RecordingClient({
      monotonic: h.clock.now,
      media: h.media,
      sync: h.sync,
      upload: { send: async () => {} },
      onStateChange: (s) => seen.push(s.phase),
      uploadOptions: { sleep: async () => {} },
    });

    await client.syncClock();
    await client.requestMicrophone();
    client.setConsent('all_confirmed');
    client.setConsent('all_confirmed'); // 같은 값 → 알림 없음

    assert.deepEqual(seen, ['idle', 'idle', 'ready']);
  });

  it('⭐ 생성자는 알림을 보내지 않는다', () => {
    // ⚠️ **호출자가 대응할 방법이 없기 때문입니다.**
    //
    // `const client = new RecordingClient({ onStateChange: () => render() })`
    // 에서 생성자가 콜백을 부르면, 그 시점에는 `client` 대입이 아직
    // 끝나지 않았습니다. 콜백이 `client.state` 를 읽으면 undefined 입니다.
    //
    // 실제로 녹음 화면이 열리자마자 그 오류로 죽었고, **브라우저로 띄워
    // 보고서야** 알았습니다 — 화면 코드에는 자동 테스트가 없고 이 파일의
    // 테스트는 콜백 안에서 자기 자신을 읽지 않았습니다.
    const seen: string[] = [];
    const h = harness();
    let self: RecordingClient | undefined;

    self = new RecordingClient({
      monotonic: h.clock.now,
      media: h.media,
      sync: h.sync,
      upload: { send: async () => {} },
      // 화면이 실제로 하는 것과 같은 모양 — 콜백 안에서 자기를 읽는다.
      onStateChange: () => seen.push(self!.state.phase),
      uploadOptions: { sleep: async () => {} },
    });

    assert.deepEqual(seen, [], '생성자가 콜백을 불렀습니다');
  });

  it('생성자가 알림을 안 보내도 보안 컨텍스트는 반영돼 있다', () => {
    // 알림을 없앤 대가로 사실까지 잃으면 안 됩니다.
    const h = harness();
    const client = new RecordingClient({
      monotonic: h.clock.now,
      media: h.media,
      sync: h.sync,
      upload: { send: async () => {} },
      uploadOptions: { sleep: async () => {} },
    });
    assert.equal(client.state.secureContext, h.media.isSecureContext());
  });
});
