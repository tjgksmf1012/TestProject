import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ClockTracker,
  SYNC_TOLERANCE_MS,
  checkSync,
  estimateClock,
  type ClockSample,
} from './clock.ts';

/** 서버 epoch 과 클라이언트 단조 시계의 진짜 차이 */
const TRUE_OFFSET = 1_700_000_000_000;

/**
 * 왕복 한 번을 물리적으로 시뮬레이션한다.
 *
 * @param t0 클라이언트 전송 시각 (단조)
 * @param out 나가는 편도 지연
 * @param serverMs 서버 처리 시간
 * @param back 돌아오는 편도 지연
 */
function roundTrip(t0: number, out: number, serverMs: number, back: number): ClockSample {
  const t1 = t0 + out + TRUE_OFFSET;
  const t2 = t1 + serverMs;
  const t3 = t0 + out + serverMs + back;
  return { t0, t1, t2, t3 };
}

describe('estimateClock', () => {
  it('지연이 대칭이면 오프셋을 정확히 복원한다', () => {
    const e = estimateClock([roundTrip(1000, 20, 5, 20)]);
    assert.equal(e.offsetMs, TRUE_OFFSET);
    assert.equal(e.roundTripMs, 40);
    assert.equal(e.maxErrorMs, 20);
  });

  it('서버 처리 시간은 왕복에서 빠진다', () => {
    // 서버가 500ms 걸려도 네트워크 왕복은 40ms 그대로다.
    const e = estimateClock([roundTrip(1000, 20, 500, 20)]);
    assert.equal(e.roundTripMs, 40);
    assert.equal(e.offsetMs, TRUE_OFFSET);
  });

  it('지연이 비대칭이어도 오차가 maxErrorMs 상한을 넘지 않는다', () => {
    // 나갈 때 100ms, 돌아올 때 10ms — 최악에 가까운 비대칭
    const e = estimateClock([roundTrip(1000, 100, 5, 10)]);
    const actualError = Math.abs(e.offsetMs - TRUE_OFFSET);
    assert.ok(actualError > 0, '비대칭이면 오차가 있어야 한다');
    assert.ok(
      actualError <= e.maxErrorMs,
      `오차 ${actualError} 가 상한 ${e.maxErrorMs} 을 넘었다`,
    );
  });

  it('여러 표본 중 왕복이 가장 짧은 것을 채택한다', () => {
    // 큐잉 지연이 낀 표본(느리고 비대칭)이 섞여 있어도 오염되면 안 된다.
    const e = estimateClock([
      roundTrip(1000, 400, 5, 20), // 느림 + 심한 비대칭
      roundTrip(2000, 15, 5, 15), // 빠름 + 대칭  ← 이게 채택돼야 한다
      roundTrip(3000, 300, 5, 300), // 느림
    ]);
    assert.equal(e.roundTripMs, 30);
    assert.equal(e.offsetMs, TRUE_OFFSET);
    assert.equal(e.sampleCount, 3);
  });

  it('평균이 아니라 최소를 고르는 게 실제로 유리하다', () => {
    const samples = [
      roundTrip(1000, 15, 5, 15),
      roundTrip(2000, 500, 5, 20),
      roundTrip(3000, 480, 5, 30),
    ];
    const best = estimateClock(samples);
    const naiveMean =
      samples.reduce((acc, s) => acc + (s.t1 - s.t0 + (s.t2 - s.t3)) / 2, 0) / samples.length;

    const bestError = Math.abs(best.offsetMs - TRUE_OFFSET);
    const meanError = Math.abs(naiveMean - TRUE_OFFSET);
    assert.ok(bestError < meanError, `최소 채택 ${bestError} < 평균 ${meanError} 이어야 한다`);
  });

  it('물리적으로 불가능한 표본은 버린다', () => {
    const bad: ClockSample = { t0: 1000, t1: TRUE_OFFSET + 900, t2: TRUE_OFFSET + 800, t3: 1040 };
    const e = estimateClock([bad, roundTrip(2000, 20, 5, 20)]);
    assert.equal(e.sampleCount, 1, '무효 표본은 세지 않는다');
    assert.equal(e.offsetMs, TRUE_OFFSET);
  });

  it('응답이 요청보다 먼저 온 표본도 버린다', () => {
    const impossible: ClockSample = { t0: 5000, t1: TRUE_OFFSET, t2: TRUE_OFFSET, t3: 4000 };
    assert.throws(() => estimateClock([impossible]), /표본이 없습니다/);
  });

  it('표본이 하나도 없으면 던진다', () => {
    assert.throws(() => estimateClock([]), /표본이 없습니다/);
  });

  it('표본 간 편차를 spreadMs 로 노출한다', () => {
    const stable = estimateClock([
      roundTrip(1000, 20, 5, 20),
      roundTrip(2000, 21, 5, 19),
      roundTrip(3000, 19, 5, 21),
    ]);
    assert.ok(stable.spreadMs < 5, `안정된 네트워크는 편차가 작아야 한다 (${stable.spreadMs})`);
  });
});

describe('checkSync', () => {
  it('빠른 네트워크는 통과한다', () => {
    const status = checkSync(estimateClock([roundTrip(1000, 20, 5, 20)]));
    assert.equal(status.ok, true);
  });

  it('왕복이 너무 길면 녹음을 막는다', () => {
    // 편도 300ms → 왕복 600ms → 오차 상한 300ms > 허용치 250ms
    const status = checkSync(estimateClock([roundTrip(1000, 300, 5, 300)]));
    assert.equal(status.ok, false);
    assert.match(status.reason, /오차 상한/);
  });

  it('허용치는 백엔드 GCC-PHAT 탐색창(±500ms)의 절반이다', () => {
    // backend/teamflow/audio/multitrack.py MAX_PLAUSIBLE_TAU = 0.5
    assert.equal(SYNC_TOLERANCE_MS, 250);
  });

  it('편차가 크면 네트워크 불안정으로 보고 막는다', () => {
    const unstable = estimateClock([
      roundTrip(1000, 30, 5, 30),
      roundTrip(2000, 700, 5, 5),
      roundTrip(3000, 5, 5, 700),
    ]);
    const status = checkSync(unstable);
    assert.equal(status.ok, false);
    assert.match(status.reason, /불안정/);
  });
});

describe('ClockTracker', () => {
  it('동기화 전에는 시각 변환을 거부한다', () => {
    const tracker = new ClockTracker(() => 0);
    assert.equal(tracker.synced, false);
    assert.throws(() => tracker.now(), /동기화 전/);
  });

  it('⭐ 서버 시각은 **정수**다 — 소수가 나가면 서버가 요청을 통째로 거절한다 (결함 175)', () => {
    // 오프셋은 표본 평균이라 소수가 나오고, `performance.now()` 도 소수다.
    // 그대로 흘렸더니 실기에서 `X-Client-At-Ms: 1787101582540.65` 가 나갔고
    // 서버가 422 로 거절해 **청크가 한 개도 안 올라갔다.** 큐는 여섯 번
    // 재시도하고 포기하므로 회의 전체가 서버에 안 닿는다.
    //
    // 단위 테스트가 못 잡은 이유: 가짜 시계가 정수를 주기 때문이다.
    // 여기서는 일부러 소수를 넣는다.
    const tracker = new ClockTracker(() => 5000.37);
    tracker.push({
      offsetMs: TRUE_OFFSET + 0.28,
      roundTripMs: 40,
      maxErrorMs: 20,
      anchorMs: 1000,
      spreadMs: 1,
      sampleCount: 3,
    });
    const at = tracker.now();
    assert.equal(Number.isInteger(at), true, `정수가 아닙니다: ${at}`);
    assert.equal(at, Math.round(5000.37 + TRUE_OFFSET + 0.28));
    // 헤더로 나갈 때 소수점이 안 붙는지도 같이 본다 — 실제로 나간 모양이다.
    assert.equal(/^\d+$/.test(String(at)), true, `헤더 값이 정수 문자열이 아닙니다: ${String(at)}`);
  });

  it('보간 구간에서도 정수다 — 소수 오프셋 둘 사이', () => {
    const tracker = new ClockTracker(() => 4000);
    tracker.push({ offsetMs: TRUE_OFFSET + 0.1, roundTripMs: 40, maxErrorMs: 20, anchorMs: 1000, spreadMs: 1, sampleCount: 3 });
    tracker.push({ offsetMs: TRUE_OFFSET + 60.7, roundTripMs: 40, maxErrorMs: 20, anchorMs: 7000, spreadMs: 1, sampleCount: 3 });
    assert.equal(Number.isInteger(tracker.now()), true);
  });

  it('측정이 하나면 그 오프셋을 그대로 쓴다', () => {
    const tracker = new ClockTracker(() => 5000);
    tracker.push(estimateClock([roundTrip(1000, 20, 5, 20)]));
    assert.equal(tracker.now(), 5000 + TRUE_OFFSET);
  });

  it('측정 사이는 선형 보간해서 드리프트를 흡수한다', () => {
    const tracker = new ClockTracker(() => 0);
    // anchor 1000 에서 오프셋 O, anchor 601000(10분 뒤) 에서 O+60 (100ppm 드리프트)
    tracker.push({
      offsetMs: TRUE_OFFSET,
      roundTripMs: 40,
      maxErrorMs: 20,
      anchorMs: 1000,
      spreadMs: 1,
      sampleCount: 3,
    });
    tracker.push({
      offsetMs: TRUE_OFFSET + 60,
      roundTripMs: 40,
      maxErrorMs: 20,
      anchorMs: 601_000,
      spreadMs: 1,
      sampleCount: 3,
    });

    // 정확히 중간 지점이면 오프셋도 중간이어야 한다
    const mid = tracker.toServerTime(301_000);
    assert.equal(mid, 301_000 + TRUE_OFFSET + 30);
  });

  it('마지막 측정 이후는 외삽하지 않는다', () => {
    const tracker = new ClockTracker(() => 0);
    tracker.push({
      offsetMs: TRUE_OFFSET,
      roundTripMs: 40,
      maxErrorMs: 20,
      anchorMs: 1000,
      spreadMs: 1,
      sampleCount: 3,
    });
    tracker.push({
      offsetMs: TRUE_OFFSET + 60,
      roundTripMs: 40,
      maxErrorMs: 20,
      anchorMs: 601_000,
      spreadMs: 1,
      sampleCount: 3,
    });

    // 10분 더 지나도 오프셋은 +60 에서 멈춘다 (+120 으로 외삽하지 않는다)
    const later = tracker.toServerTime(1_201_000);
    assert.equal(later, 1_201_000 + TRUE_OFFSET + 60);
  });

  it('측정 순서가 뒤바뀌어 들어와도 정렬한다', () => {
    const tracker = new ClockTracker(() => 0);
    const late = {
      offsetMs: TRUE_OFFSET + 60,
      roundTripMs: 40,
      maxErrorMs: 20,
      anchorMs: 601_000,
      spreadMs: 1,
      sampleCount: 3,
    };
    const early = { ...late, offsetMs: TRUE_OFFSET, anchorMs: 1000 };
    tracker.push(late);
    tracker.push(early);
    assert.equal(tracker.toServerTime(301_000), 301_000 + TRUE_OFFSET + 30);
  });

  it('드리프트를 ppm 으로 계산한다', () => {
    const tracker = new ClockTracker(() => 0);
    tracker.push({
      offsetMs: TRUE_OFFSET,
      roundTripMs: 40,
      maxErrorMs: 20,
      anchorMs: 0,
      spreadMs: 1,
      sampleCount: 3,
    });
    tracker.push({
      offsetMs: TRUE_OFFSET + 180,
      roundTripMs: 40,
      maxErrorMs: 20,
      anchorMs: 3_600_000,
      spreadMs: 1,
      sampleCount: 3,
    });
    // 1시간에 180ms → 50ppm. 소비자 기기의 전형적인 값이다.
    assert.equal(tracker.driftPpm(), 50);
  });

  it('측정이 하나뿐이면 드리프트를 알 수 없다', () => {
    const tracker = new ClockTracker(() => 0);
    tracker.push(estimateClock([roundTrip(1000, 20, 5, 20)]));
    assert.equal(tracker.driftPpm(), null);
  });

  it('1시간 회의에서 재동기화 없이 두면 탐색창의 3분의 1을 잃는다', () => {
    // 이 테스트는 "왜 주기적으로 다시 재야 하는가"의 근거다.
    const driftPpm = 50;
    const meetingMs = 3_600_000;
    const accumulated = (driftPpm / 1e6) * meetingMs;
    assert.equal(accumulated, 180);
    assert.ok(accumulated > SYNC_TOLERANCE_MS * 0.5, '허용치의 절반을 넘게 먹는다');
  });
});
