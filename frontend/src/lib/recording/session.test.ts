import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildTimeline, judgeTrack } from './timeline.ts';
import {
  blockers,
  canStart,
  initialState,
  reduce,
  reduceAll,
  toTimelineInput,
  type SessionEvent,
  type SessionState,
} from './session.ts';

const T0 = 1_700_000_000_000;

/** 모든 사전 조건을 충족시키는 이벤트들 */
const PRECONDITIONS: SessionEvent[] = [
  { type: 'SECURE_CONTEXT', secure: true },
  { type: 'PERMISSION', state: 'granted' },
  { type: 'CONSENT', state: 'all_confirmed' },
  { type: 'CLOCK', state: 'ok' },
];

function ready(): SessionState {
  return reduceAll(initialState(), PRECONDITIONS);
}

function recording(): SessionState {
  return reduce(ready(), { type: 'START', atMs: T0 });
}

function chunk(seq: number, offsetMs: number): SessionEvent {
  return { type: 'CHUNK', chunk: { seq, atMs: T0 + offsetMs, byteLength: 20_000 } };
}

describe('사전 조건', () => {
  it('처음에는 시작할 수 없고 이유를 전부 알려준다', () => {
    const state = initialState();
    assert.equal(state.phase, 'idle');
    assert.equal(canStart(state), false);

    const reasons = blockers(state);
    assert.equal(reasons.length, 4);
    assert.ok(reasons.some((r) => r.includes('HTTPS')));
    assert.ok(reasons.some((r) => r.includes('마이크 권한')));
    assert.ok(reasons.some((r) => r.includes('동의')));
    assert.ok(reasons.some((r) => r.includes('시각')));
  });

  it('조건을 모두 채우면 ready 가 된다', () => {
    const state = ready();
    assert.equal(state.phase, 'ready');
    assert.deepEqual(blockers(state), []);
  });

  it('⭐ 전원 동의 전에는 시작을 막는다 — 제3자 녹음은 형사처벌 대상이다', () => {
    // 통신비밀보호법. 본인만 동의한 상태로는 시작할 수 없다.
    const state = reduceAll(initialState(), [
      { type: 'SECURE_CONTEXT', secure: true },
      { type: 'PERMISSION', state: 'granted' },
      { type: 'CONSENT', state: 'self_granted' },
      { type: 'CLOCK', state: 'ok' },
    ]);
    assert.equal(canStart(state), false);
    assert.ok(blockers(state).some((r) => r.includes('아직 동의하지 않은 참여자')));

    const attempted = reduce(state, { type: 'START', atMs: T0 });
    assert.equal(attempted.phase, 'idle', '시작 이벤트를 무시한다');
    assert.equal(attempted.startedAtMs, null);
  });

  it('동의를 거부하면 이유가 달라진다', () => {
    const state = reduceAll(initialState(), [
      ...PRECONDITIONS,
      { type: 'CONSENT', state: 'refused' },
    ]);
    assert.ok(blockers(state).some((r) => r.includes('동의하지 않았습니다')));
  });

  it('HTTP 로 열면 시작할 수 없다', () => {
    const state = reduceAll(initialState(), [
      ...PRECONDITIONS,
      { type: 'SECURE_CONTEXT', secure: false },
    ]);
    assert.equal(canStart(state), false);
    assert.ok(blockers(state).some((r) => r.includes('HTTPS')));
  });

  it('시각 오차가 크면 정렬 실패를 예고하며 막는다', () => {
    const state = reduceAll(initialState(), [...PRECONDITIONS, { type: 'CLOCK', state: 'poor' }]);
    assert.equal(canStart(state), false);
    assert.ok(blockers(state).some((r) => r.includes('트랙 정렬')));
  });

  it('권한이 거부되면 ready 에서 idle 로 돌아간다', () => {
    const state = reduce(ready(), { type: 'PERMISSION', state: 'denied' });
    assert.equal(state.phase, 'idle');
  });
});

describe('녹음', () => {
  it('시작하면 recording 이 되고 시작 시각을 기록한다', () => {
    const state = recording();
    assert.equal(state.phase, 'recording');
    assert.equal(state.startedAtMs, T0);
  });

  it('청크를 순서대로 쌓는다', () => {
    const state = reduceAll(recording(), [chunk(0, 5_000), chunk(1, 10_000)]);
    assert.deepEqual(
      state.chunks.map((c) => c.seq),
      [0, 1],
    );
  });

  it('같은 seq 가 두 번 오면 무시한다', () => {
    const state = reduceAll(recording(), [chunk(0, 5_000), chunk(0, 5_000)]);
    assert.equal(state.chunks.length, 1);
  });

  it('녹음 중이 아닐 때 온 청크는 버린다', () => {
    const state = reduce(ready(), chunk(0, 5_000));
    assert.equal(state.chunks.length, 0);
  });

  it('이미 녹음 중이면 START 를 무시한다', () => {
    const state = reduce(recording(), { type: 'START', atMs: T0 + 99_999 });
    assert.equal(state.startedAtMs, T0, '시작 시각이 덮어써지면 안 된다');
  });
});

describe('중단 (iOS 화면 잠금)', () => {
  it('화면이 가려지면 interrupted 로 바뀌고 횟수를 센다', () => {
    const state = reduce(recording(), { type: 'VISIBILITY', hidden: true });
    assert.equal(state.phase, 'interrupted');
    assert.equal(state.interruptions, 1);
  });

  it('돌아오면 다시 recording', () => {
    const state = reduceAll(recording(), [
      { type: 'VISIBILITY', hidden: true },
      { type: 'VISIBILITY', hidden: false },
    ]);
    assert.equal(state.phase, 'recording');
    assert.equal(state.interruptions, 1);
  });

  it('중단 중에도 들어온 청크는 받는다', () => {
    // 안드로이드는 화면이 꺼져도 계속 녹음되는 경우가 있다. 버리면 손해다.
    const state = reduceAll(recording(), [
      { type: 'VISIBILITY', hidden: true },
      chunk(0, 5_000),
    ]);
    assert.equal(state.chunks.length, 1);
  });

  it('⭐ 화면이 가려졌다는 사실만으로 공백을 지어내지 않는다', () => {
    // 실제 공백은 청크 타이밍과 mute 이벤트로만 판정한다 (timeline.ts).
    // 추측으로 데이터를 만들면 그게 또 다른 오답이 된다.
    const state = reduceAll(recording(), [
      { type: 'VISIBILITY', hidden: true },
      { type: 'VISIBILITY', hidden: false },
    ]);
    assert.deepEqual(state.mutedIntervals, []);
  });
});

describe('마이크 음소거 구간', () => {
  it('mute 시작과 해제를 구간으로 남긴다', () => {
    const state = reduceAll(recording(), [
      { type: 'TRACK_MUTE', muted: true, atMs: T0 + 10_000 },
      { type: 'TRACK_MUTE', muted: false, atMs: T0 + 25_000 },
    ]);
    assert.deepEqual(state.mutedIntervals, [{ startMs: T0 + 10_000, endMs: T0 + 25_000 }]);
    assert.equal(state.muteStartedAtMs, null);
  });

  it('mute 이벤트가 중복으로 와도 한 구간이다', () => {
    const state = reduceAll(recording(), [
      { type: 'TRACK_MUTE', muted: true, atMs: T0 + 10_000 },
      { type: 'TRACK_MUTE', muted: true, atMs: T0 + 12_000 },
      { type: 'TRACK_MUTE', muted: false, atMs: T0 + 25_000 },
    ]);
    assert.deepEqual(state.mutedIntervals, [{ startMs: T0 + 10_000, endMs: T0 + 25_000 }]);
  });

  it('짝 없는 unmute 는 무시한다', () => {
    const state = reduce(recording(), { type: 'TRACK_MUTE', muted: false, atMs: T0 + 5_000 });
    assert.deepEqual(state.mutedIntervals, []);
  });

  it('mute 인 채로 정지하면 정지 시각에서 끊어 닫는다', () => {
    const state = reduceAll(recording(), [
      { type: 'TRACK_MUTE', muted: true, atMs: T0 + 10_000 },
      { type: 'STOP', atMs: T0 + 30_000 },
    ]);
    assert.deepEqual(state.mutedIntervals, [{ startMs: T0 + 10_000, endMs: T0 + 30_000 }]);
  });
});

describe('동의 철회', () => {
  it('⭐ 녹음 중 동의가 철회되면 즉시 멈춘다', () => {
    const state = reduceAll(recording(), [chunk(0, 5_000), { type: 'CONSENT', state: 'refused' }]);
    assert.equal(state.phase, 'stopping');
    assert.equal(state.stopReason, 'consent_revoked');
  });

  it('이미 받은 청크를 버리지는 않는다', () => {
    // docs/07: "동의 철회 시 이후 녹음 제외 (이미 수집된 것은 보존기간까지)"
    // 철회는 앞으로에 대한 것이지 소급이 아니다.
    const state = reduceAll(recording(), [
      chunk(0, 5_000),
      chunk(1, 10_000),
      { type: 'CONSENT', state: 'refused' },
    ]);
    assert.equal(state.chunks.length, 2);
  });

  it('철회로 멈춘 뒤 흘러나온 마지막 조각은 받는다 — 철회 전 소리다 (결함 173)', () => {
    // 철회 순간 레코더가 마이크째로 꺼진다(그 보장은 client 테스트가 잰다).
    // 그 뒤에 도착하는 조각은 꺼지기 **전**에 담긴 소리의 플러시라
    // docs/07 의 "이미 수집된 것" 이다. 여기서 버리면 철회 직전 최대
    // 타임슬라이스 하나가 매번 사라진다.
    const state = reduceAll(recording(), [
      { type: 'CONSENT', state: 'refused' },
      chunk(0, 5_000),
    ]);
    assert.equal(state.chunks.length, 1);
  });
});

describe('백프레셔', () => {
  it('⭐ 업로드가 밀리면 청크를 버리는 대신 녹음을 멈춘다', () => {
    const state = reduce(recording(), { type: 'BACKPRESSURE', active: true });
    assert.equal(state.phase, 'stopping');
    assert.equal(state.stopReason, 'backpressure');
  });

  it('해제 신호는 아무것도 바꾸지 않는다', () => {
    const state = reduce(recording(), { type: 'BACKPRESSURE', active: false });
    assert.equal(state.phase, 'recording');
  });
});

describe('종료', () => {
  it('⭐ 정지 직후 흘러나온 마지막 조각은 버리지 않는다 (결함 173)', () => {
    // MediaRecorder.stop() 은 남은 소리를 정지 **뒤에** 흘려보낸다.
    // 그 소리는 정지 전에 녹음된 것 — 회의의 끝, 결정이 말해지는 자리다.
    const state = reduceAll(recording(), [
      chunk(0, 5_000),
      { type: 'STOP', atMs: T0 + 7_000 },
      chunk(1, 7_050),
    ]);
    assert.equal(state.chunks.length, 2, '마지막 조각이 세어져야 한다');
  });

  it('완료된 뒤에 온 조각은 받지 않는다 — 요약이 이미 만들어졌다', () => {
    const state = reduceAll(recording(), [
      chunk(0, 5_000),
      { type: 'STOP', atMs: T0 + 7_000 },
      { type: 'UPLOAD_DONE', lostSeqs: [] },
      chunk(1, 8_000),
    ]);
    assert.equal(state.chunks.length, 1);
  });

  it('정지 → 업로드 완료 → completed', () => {
    const state = reduceAll(recording(), [
      chunk(0, 5_000),
      { type: 'STOP', atMs: T0 + 10_000 },
      { type: 'UPLOAD_DONE', lostSeqs: [] },
    ]);
    assert.equal(state.phase, 'completed');
    assert.equal(state.endedAtMs, T0 + 10_000);
    assert.equal(state.stopReason, 'user');
  });

  it('업로드에 실패한 seq 를 들고 끝난다', () => {
    const state = reduceAll(recording(), [
      { type: 'STOP', atMs: T0 + 10_000 },
      { type: 'UPLOAD_DONE', lostSeqs: [3, 7] },
    ]);
    assert.deepEqual(state.lostSeqs, [3, 7]);
  });

  it('자동 중단(철회·백프레셔) 후에도 종료 시각이 채워진다', () => {
    const state = reduceAll(recording(), [
      { type: 'BACKPRESSURE', active: true },
      { type: 'STOP', atMs: T0 + 20_000 },
      { type: 'UPLOAD_DONE', lostSeqs: [] },
    ]);
    assert.equal(state.endedAtMs, T0 + 20_000);
    assert.equal(state.stopReason, 'backpressure', '중단 사유가 덮어써지면 안 된다');
    assert.equal(state.phase, 'completed');
  });

  it('오류는 failed 로 끝나고 메시지를 남긴다', () => {
    const state = reduce(recording(), { type: 'ERROR', message: '마이크 연결이 끊겼습니다' });
    assert.equal(state.phase, 'failed');
    assert.equal(state.error, '마이크 연결이 끊겼습니다');
  });

  it('완료된 세션에는 UPLOAD_DONE 이 다시 와도 안 바뀐다', () => {
    const done = reduceAll(recording(), [
      { type: 'STOP', atMs: T0 + 10_000 },
      { type: 'UPLOAD_DONE', lostSeqs: [1] },
    ]);
    const again = reduce(done, { type: 'UPLOAD_DONE', lostSeqs: [] });
    assert.deepEqual(again.lostSeqs, [1]);
  });
});

describe('리듀서 순수성', () => {
  it('입력 상태를 변형하지 않는다', () => {
    const before = recording();
    const snapshot = JSON.stringify(before);
    reduce(before, chunk(0, 5_000));
    assert.equal(JSON.stringify(before), snapshot);
  });

  it('청크 배열을 공유하지 않는다', () => {
    const a = reduce(recording(), chunk(0, 5_000));
    const b = reduce(a, chunk(1, 10_000));
    assert.equal(a.chunks.length, 1);
    assert.equal(b.chunks.length, 2);
  });
});

describe('타임라인 연결', () => {
  it('끝나지 않은 세션은 타임라인으로 못 넘긴다', () => {
    assert.throws(() => toTimelineInput(recording()), /시작·종료되지 않은/);
  });

  it('⭐ 세션 → 타임라인 → 트랙 판정이 한 줄로 이어진다', () => {
    // 실제 시나리오: 1분 녹음 중 20초 지점에 화면이 잠겨 30초를 잃었다.
    const events: SessionEvent[] = [
      chunk(0, 5_000),
      chunk(1, 10_000),
      chunk(2, 15_000),
      chunk(3, 20_000),
      { type: 'VISIBILITY', hidden: true },
      // 30초 공백 — 청크가 아예 안 온다
      { type: 'VISIBILITY', hidden: false },
      chunk(4, 55_000),
      chunk(5, 60_000),
      { type: 'STOP', atMs: T0 + 60_000 },
      { type: 'UPLOAD_DONE', lostSeqs: [] },
    ];
    const state = reduceAll(recording(), events);
    const timeline = buildTimeline(state.chunks, {
      ...toTimelineInput(state),
      timesliceMs: 5_000,
    });

    assert.equal(state.interruptions, 1);
    assert.equal(timeline.gaps.length, 1);
    assert.equal(timeline.gaps[0]!.durationMs, 30_000);
    assert.equal(timeline.coverage, 0.5);

    const verdict = judgeTrack(timeline);
    assert.equal(verdict.usable, false, '절반이 빈 트랙으로 발화량을 판단하면 안 된다');
  });

  it('업로드 실패 seq 가 세션을 거쳐 공백으로 이어진다', () => {
    const state = reduceAll(recording(), [
      chunk(0, 5_000),
      chunk(1, 10_000),
      chunk(2, 15_000),
      { type: 'STOP', atMs: T0 + 15_000 },
      { type: 'UPLOAD_DONE', lostSeqs: [1] },
    ]);
    const timeline = buildTimeline(state.chunks, {
      ...toTimelineInput(state),
      timesliceMs: 5_000,
    });
    assert.equal(timeline.gaps.length, 1);
    assert.equal(timeline.gaps[0]!.reason, 'chunk_lost');
  });

  it('mute 구간도 그대로 넘어간다', () => {
    const state = reduceAll(recording(), [
      chunk(0, 5_000),
      { type: 'TRACK_MUTE', muted: true, atMs: T0 + 6_000 },
      chunk(1, 10_000),
      chunk(2, 15_000),
      { type: 'TRACK_MUTE', muted: false, atMs: T0 + 16_000 },
      chunk(3, 20_000),
      { type: 'STOP', atMs: T0 + 20_000 },
      { type: 'UPLOAD_DONE', lostSeqs: [] },
    ]);
    const timeline = buildTimeline(state.chunks, {
      ...toTimelineInput(state),
      timesliceMs: 5_000,
    });
    assert.equal(timeline.gaps.length, 1);
    assert.equal(timeline.gaps[0]!.reason, 'track_muted');
    assert.equal(timeline.gaps[0]!.durationMs, 10_000);
  });
});
