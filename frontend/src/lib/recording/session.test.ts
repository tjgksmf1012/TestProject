import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildTimeline, judgeTrack } from './timeline.ts';
import {
  blockers,
  canStart,
  consentStepLabel,
  permissionStepLabel,
  stepsDone,
  initialState,
  reduce,
  reduceAll,
  toTimelineInput,
  type SessionEvent,
  type SessionState,
  consentForEntry,
  consentStateFrom,
  consentStep,
  describeJoinFailure,
  describeResume,
  describeSoloEntry,
  describeStopReason,
  trackRefused,
} from './session.ts';

const T0 = 1_700_000_000_000;

/** 모든 사전 조건을 충족시키는 이벤트들 */
const PRECONDITIONS: SessionEvent[] = [
  { type: 'SECURE_CONTEXT', secure: true },
  { type: 'PERMISSION', state: 'granted' },
  { type: 'CONSENT', state: 'all_confirmed' },
  { type: 'CLOCK', state: 'ok' },
  // 서버에 내 트랙이 열려야 「준비됐습니다」입니다 (결함 272).
  { type: 'TRACK', state: 'open' },
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
    assert.equal(reasons.length, 5, JSON.stringify(reasons));
    assert.ok(reasons.some((r) => r.includes('HTTPS')));
    assert.ok(reasons.some((r) => r.includes('마이크 권한')));
    assert.ok(reasons.some((r) => r.includes('동의')));
    assert.ok(reasons.some((r) => r.includes('시각')));
    assert.ok(reasons.some((r) => r.includes('트랙')));
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

describe('끝난 준비 단계 (결함 274)', () => {
  it('⭐ 동의와 마이크가 끝나면 단계도 끝난 것으로 표시된다', () => {
    const state = ready();
    assert.deepEqual(stepsDone(state), { consent: true, permission: true });
  });

  it('처음에는 둘 다 안 끝났다', () => {
    assert.deepEqual(stepsDone(initialState()), { consent: false, permission: false });
  });

  it('⭐ 나만 동의했어도 **내 단계는** 끝났다 — 남은 것은 막는 목록이 말한다', () => {
    const mine = reduce(ready(), { type: 'CONSENT', state: 'self_granted' });
    assert.equal(stepsDone(mine).consent, true);
    assert.ok(blockers(mine).some((r) => r.includes('아직 동의하지 않은 참여자')));
  });

  it('⭐ solo 는 「해당 없음」이라 끝난 것으로 그린다 — 안 한 일로 보이면 안 된다', () => {
    const solo = reduce(ready(), { type: 'CONSENT', state: 'solo' });
    assert.equal(stepsDone(solo).consent, true);
  });

  it('동의를 거절하면 단계가 다시 열린다', () => {
    const refused = reduce(ready(), { type: 'CONSENT', state: 'refused' });
    assert.equal(stepsDone(refused).consent, false);
  });

  it('끝난 뒤에는 시키지 않고 길만 남긴다', () => {
    const step = consentStep('7');
    assert.equal(consentStepLabel(step, false), '동의하러 로비로');
    assert.equal(consentStepLabel(step, true), '로비 보기');
    // 회의를 안 고른 세션은 단계 자체가 다른 뜻입니다 — 말을 안 바꿉니다.
    const none = consentStep(null);
    assert.equal(consentStepLabel(none, true), none.label);
  });

  it('마이크 단계는 끝난 뒤에도 **하는 일이 있다** — 감추지 않고 말만 바꾼다', () => {
    assert.equal(permissionStepLabel(false), '마이크 권한 허용');
    assert.equal(permissionStepLabel(true), '마이크 다시 고르기');
  });
});

describe('올릴 자리가 없는 녹음 (결함 272)', () => {
  it('⭐ 트랙이 거절당하면 다른 조건이 다 차도 시작을 막는다', () => {
    // 녹음이 이미 끝난 회의를 다시 열면 참가가 409 로 거절됩니다.
    // 예전에는 그 사실이 상태에 안 들어와서 「준비됐습니다」가 떴고,
    // 10초를 녹음하면 **「커버리지 100.0% · 사용 가능」**이라고 답했습니다 —
    // 서버에는 청크가 **한 개도** 안 갔는데.
    const state = reduce(ready(), { type: 'TRACK', state: 'blocked' });
    assert.equal(canStart(state), false);
    assert.equal(state.phase, 'idle');
    assert.ok(
      blockers(state).some((r) => r.includes('팀에 올라가지 않습니다')),
      JSON.stringify(blockers(state)),
    );
  });

  it('아직 여는 중이면 「모른다」로 막는다 — 모르는 것을 열렸다고 읽지 않는다', () => {
    const state = reduce(ready(), { type: 'TRACK', state: 'pending' });
    assert.equal(canStart(state), false);
    assert.ok(blockers(state).some((r) => r.includes('여는 중')));
  });

  it('열리면 다시 ready 가 된다 — 동의를 마치고 돌아온 자리', () => {
    const blocked = reduce(ready(), { type: 'TRACK', state: 'blocked' });
    const opened = reduce(blocked, { type: 'TRACK', state: 'open' });
    assert.equal(canStart(opened), true);
    assert.equal(opened.phase, 'ready');
  });

  it('⭐ solo 세션에는 묻지 않는다 — 회의에 안 붙은 녹음은 올릴 자리가 원래 없다', () => {
    const solo = reduceAll(initialState(), [
      { type: 'SECURE_CONTEXT', secure: true },
      { type: 'PERMISSION', state: 'granted' },
      { type: 'CONSENT', state: 'solo' },
      { type: 'CLOCK', state: 'ok' },
    ]);
    assert.equal(solo.track, 'pending');
    assert.deepEqual(blockers(solo), []);
    assert.equal(canStart(solo), true);
  });

  it('같은 값이면 같은 객체를 돌려준다 (리듀서 순수성)', () => {
    const state = ready();
    assert.equal(reduce(state, { type: 'TRACK', state: 'open' }), state);
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

describe('⛔ 녹음 화면이 스스로 「전원 동의」를 선언하던 것 (결함 229)', () => {
  const who = (user_id: number, name: string, recording: boolean | null) => ({
    user_id,
    name,
    recording,
    raw_audio_retention: recording,
    voiceprint_storage: recording,
  });

  it('⭐ 전원이 동의해야 `all_confirmed` 다', () => {
    const roster = [who(1, '김민수', true), who(2, '이하늘', true), who(3, '박지원', true)];
    assert.strictEqual(consentStateFrom({ roster }, 1), 'all_confirmed');
  });

  it('⭐ 나만 동의했으면 `self_granted` — 남을 기다린다', () => {
    const roster = [who(1, '김민수', true), who(2, '이하늘', null), who(3, '박지원', true)];
    assert.strictEqual(consentStateFrom({ roster }, 1), 'self_granted');
  });

  it('⛔ 내가 아직이면 `pending` — 남이 다 했어도 내 동의가 먼저다', () => {
    const roster = [who(1, '김민수', null), who(2, '이하늘', true), who(3, '박지원', true)];
    assert.strictEqual(consentStateFrom({ roster }, 1), 'pending');
  });

  it('⛔ **한 명이라도 거부하면 `refused`** — 내가 동의했는지와 무관하다', () => {
    // 제3자 녹음은 형사처벌 대상입니다(docs/07 §1). 거부가 가장 센 답입니다.
    const roster = [who(1, '김민수', true), who(2, '이하늘', false), who(3, '박지원', true)];
    assert.strictEqual(consentStateFrom({ roster }, 1), 'refused');
  });

  it('⛔ 명부를 못 받았으면 `pending` — **모르는 것을 동의로 읽지 않는다**', () => {
    assert.strictEqual(consentStateFrom({ roster: [] }, 1), 'pending');
    // 서버가 닿지 않았거나 모양이 다른 답을 준 경우도 같습니다.
    assert.strictEqual(consentStateFrom(null, 1), 'pending');
    assert.strictEqual(consentStateFrom(undefined, 1), 'pending');
    assert.strictEqual(consentStateFrom({}, 1), 'pending');
  });

  it('⛔ 내가 명부에 없으면 `pending` — 남의 회의에서 시작할 수 없다', () => {
    const roster = [who(2, '이하늘', true), who(3, '박지원', true)];
    assert.strictEqual(consentStateFrom({ roster }, 9), 'pending');
    assert.strictEqual(consentStateFrom({ roster }, null), 'pending');
  });

  it('⭐ 그래서 `blockers` 가 실제로 막는다 — 판단과 화면이 같은 값을 본다', () => {
    // 아무도 동의 안 한 회의. 예전에는 화면이 `all_confirmed` 를 스스로
    // 넣어서 이 갈래를 **건너뛰었습니다.**
    const 아무도 = [who(1, '김민수', null), who(2, '이하늘', null)];
    const state = consentStateFrom({ roster: 아무도 }, 1);
    assert.strictEqual(state, 'pending');
    const reasons = blockers({
      secureContext: true,
      permission: 'granted',
      consent: state,
      clock: 'ok',
      phase: 'idle',
      stopReason: null,
    } as never);
    assert.strictEqual(reasons.includes('녹음 동의가 필요합니다'), true, JSON.stringify(reasons));
  });
});

describe('⛔ 아직 동의 안 한 사람에게 빨간 오류를 보여 준 것 (결함 237)', () => {
  it('⭐ 동의가 아직이면 **흙빛**이다 — 순서지 고장이 아니다', () => {
    // 녹음 화면을 처음 여는 사람은 언제나 이 상태입니다. 빨강은
    // "네가 뭘 잘못했다" 로 읽힙니다 (불변식 ③ 의 색 규칙).
    for (const consent of ['pending', 'self_granted', 'refused'] as const) {
      const note = describeJoinFailure(403, '녹음에 동의하지 않았습니다', consent);
      assert.equal(note.tone, 'gap', consent);
      assert.equal(note.text.includes('아직'), true, note.text);
    }
  });

  it('⛔ 같은 사실을 **두 번 말하지 않는다** — 무엇이 모자란지는 목록이 말한다', () => {
    // 예전에는 위에 빨강으로 「녹음에 동의하지 않았습니다」, 아래 회색
    // 불릿으로 「녹음 동의가 필요합니다」 — 같은 사실이 두 색으로 두 번.
    const note = describeJoinFailure(403, '녹음에 동의하지 않았습니다', 'pending');
    assert.equal(note.text.includes('동의'), false, note.text);
  });

  it('⭐ 동의가 **확인됐는데도** 403 이면 진짜 문제다 — 빨강', () => {
    // 이 엔드포인트의 403 은 두 가지입니다. 동의가 끝났는데 막히면
    // 「이 프로젝트의 구성원이 아닙니다」 쪽입니다.
    const note = describeJoinFailure(403, '이 프로젝트의 구성원이 아닙니다', 'all_confirmed');
    assert.equal(note.tone, 'bad');
    assert.equal(note.text.includes('구성원이 아닙니다'), true, note.text);
  });

  it('⭐ 다른 실패는 그대로 빨강이고 **서버가 한 말을 지우지 않는다**', () => {
    for (const status of [409, 500, 503]) {
      const note = describeJoinFailure(status, `HTTP ${status}`, 'all_confirmed');
      assert.equal(note.tone, 'bad', String(status));
      assert.equal(note.text.includes(String(status)), true, note.text);
    }
  });

  it('⚠️ 상태를 모르면(null) 빨강 — 모르는 것을 「아직」으로 읽지 않는다', () => {
    const note = describeJoinFailure(null, '서버에 닿지 못했습니다', 'pending');
    assert.equal(note.tone, 'bad');
  });
});

describe('회의 없이 연 녹음 화면 (실험 5 모드 · 결함 238)', () => {
  it('회의가 없으면 동의를 **물을 상대가 없다** — 막지 않는다', () => {
    const state = reduceAll(initialState(), [
      { type: 'SECURE_CONTEXT', secure: true },
      { type: 'PERMISSION', state: 'granted' },
      { type: 'CONSENT', state: consentForEntry(null) },
      { type: 'CLOCK', state: 'ok' },
    ]);
    // 결함 238: 여기가 `pending` 이라 「녹음 동의가 필요합니다」가 서고,
    // 그 조건을 풀 자리가 화면에 **없었습니다**.
    assert.equal(state.consent, 'solo');
    assert.deepEqual(blockers(state), []);
    assert.equal(canStart(state), true);
    assert.equal(state.phase, 'ready');
  });

  it('⛔ 회의가 있으면 `solo` 로 열리지 않는다 (결함 229 로 돌아가지 않게)', () => {
    for (const id of ['1', '42', 'abc']) {
      assert.equal(consentForEntry(id), 'pending', id);
    }
    // 화면이 「전원 동의」를 스스로 선언할 문은 이 함수에 **없습니다**.
    assert.notEqual(consentForEntry('1'), 'all_confirmed');
  });

  it('`solo` 는 `all_confirmed` 와 **다른 값**이다 — 해당 없음이지 확인이 아니다', () => {
    assert.notEqual(consentForEntry(null), 'all_confirmed');
  });

  it('준비 단계 ①이 **언제나 갈 자리를 준다**', () => {
    // 결함 238: 회의가 없으면 `<a>` 에 href 가 안 붙어, 눈에는 단추인데
    // 탭으로 닿지도 눌리지도 않았습니다.
    const solo = consentStep(null);
    assert.equal(solo.href.length > 0, true);
    assert.equal(solo.required, false);
    assert.equal(solo.label.includes('로비'), false, solo.label);

    const withMeeting = consentStep('7');
    assert.equal(withMeeting.href, '/app/meeting/7/lobby');
    assert.equal(withMeeting.required, true);
  });

  it('빈 문자열도 회의가 없는 것으로 읽는다 (`?meeting=` 만 적힌 주소)', () => {
    assert.equal(consentForEntry(''), 'solo');
    assert.equal(consentStep('').href, '/app/');
  });

  it('어디로 남는지 **미리** 말하고, 그것은 실패가 아니다', () => {
    const note = describeSoloEntry();
    assert.equal(note.tone, 'gap');
    assert.equal(note.text.includes('올라가지 않습니다'), true, note.text);
  });
});

describe('서버가 트랙을 거절했을 때 (결함 240)', () => {
  it('403 만 **거절**이다 — 끊김·서버 오류는 다시 걸면 된다', () => {
    assert.equal(trackRefused(403), true);
    for (const status of [200, 201, 401, 404, 409, 500, 503, null, undefined]) {
      assert.equal(trackRefused(status), false, String(status));
    }
  });

  it('⭐ 녹음 중에 동의가 철회되면 **그 자리에서** 멈춘다', () => {
    // 서버는 청크마다 동의를 다시 봅니다. 화면이 이걸 안 읽으면 사람은
    // 아무것도 안 담기는 회의를 끝까지 합니다.
    const live = reduce(ready(), { type: 'START', atMs: T0 });
    assert.equal(live.phase, 'recording');
    const revoked = reduce(live, { type: 'CONSENT', state: 'refused' });
    assert.equal(revoked.phase, 'stopping');
    assert.equal(revoked.stopReason, 'consent_revoked');
  });

  it('멈춘 까닭을 **사람의 말로** 말한다 — 내부 enum 을 안 띄운다', () => {
    const said = describeStopReason('consent_revoked');
    assert.equal(said?.includes('철회'), true, String(said));
    assert.equal(said?.includes('consent'), false, String(said));
    assert.equal(describeStopReason('backpressure')?.includes('_'), false);
    assert.equal(describeStopReason('error')?.includes('_'), false);
  });

  it('사람이 스스로 멈춘 것은 **설명하지 않는다**', () => {
    // 아무 일도 없었는데 한 줄이 뜨면 그것대로 놀랍니다.
    assert.equal(describeStopReason('user'), null);
    assert.equal(describeStopReason(null), null);
  });
});

describe('끊겼다 이어졌을 때 (결함 243)', () => {
  it('⛔ **회복은 실패가 아니다** — 빨강으로 말하지 않는다', () => {
    // 실제로 실패 빨강 `[176,46,46]` 으로 떠 있었습니다. 결함 237 의
    // 거울상입니다 — 저기는 당연한 것을 빨갛게, 여기는 좋은 소식을 빨갛게.
    const note = describeResume(3);
    assert.notEqual(note, null);
    assert.notEqual(note?.tone, 'bad');
    assert.equal(note?.text.includes('3개'), true, String(note?.text));
  });

  it('건너뛴 것이 없으면 **아무 말도 안 한다**', () => {
    for (const n of [0, -1, Number.NaN]) {
      assert.equal(describeResume(n), null, String(n));
    }
  });
});
