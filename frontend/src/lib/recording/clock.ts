/**
 * 기기 간 시각 동기화.
 *
 * docs/04-회의-처리-파이프라인.md §2
 *
 * ## 왜 필요한가
 *
 * 멀티트랙은 "트랙 = 사람"이라 화자 라벨은 100% 정확하다. 대신 **각 폰이
 * 서로 다른 시각에 녹음을 시작한다**는 문제가 생긴다. 정렬이 어긋나면
 * 트랙 간 에너지 비교(`audio/multitrack.suppress_crosstalk`)가 통째로 틀린다.
 *
 * 최종 정렬은 신호에서 직접 구한다 — GCC-PHAT. 하지만 그 탐색 범위는
 * 무한하지 않다. 백엔드 `MAX_PLAUSIBLE_TAU = 0.5초`.
 *
 *     [클라이언트 시각 동기화]  ±수십 ms 까지 좁힌다
 *                 ↓
 *     [GCC-PHAT]                신호에서 샘플 단위로 확정
 *
 * 즉 이 모듈의 요구사항은 "정확한 시각"이 아니라 **"GCC-PHAT 탐색창 안에
 * 들어가는 시각"** 이다. 그래서 오차 상한을 계산해서 같이 돌려주고,
 * 상한이 기준을 넘으면 녹음을 시작하지 않는다.
 *
 * ## 왜 Date.now() 가 아니라 단조 시계인가
 *
 * `Date.now()` 는 OS 의 NTP 보정으로 녹음 도중에 껑충 뛸 수 있다. 1시간
 * 회의 중간에 200ms 점프하면 그 이후 타임스탬프가 전부 어긋난다.
 * `performance.now()` 는 뒤로 가지 않는다. 단조 시계로 재고, 서버 epoch 로
 * 바꾸는 변환만 주기적으로 갱신한다.
 */

import type { MonotonicClock, ServerTimeMs } from './types.ts';

/**
 * 시각 동기화 왕복 표본 한 개.
 *
 * `t0`/`t3` 은 클라이언트 단조 시계(ms), `t1`/`t2` 는 서버 epoch(ms).
 * 기준이 달라도 되는 이유는 아래 공식이 전부 **차이**만 쓰기 때문이다.
 */
export interface ClockSample {
  /** 클라이언트가 요청을 보낸 시각 (단조) */
  t0: number;
  /** 서버가 요청을 받은 시각 (epoch) */
  t1: number;
  /** 서버가 응답을 보낸 시각 (epoch) */
  t2: number;
  /** 클라이언트가 응답을 받은 시각 (단조) */
  t3: number;
}

export interface ClockEstimate {
  /** `serverEpochMs = monotonicMs + offsetMs` */
  offsetMs: number;
  /** 왕복 시간. 서버 처리 시간은 제외했다. */
  roundTripMs: number;
  /**
   * 오프셋 오차의 **상한**. 왕복 지연이 완벽히 비대칭이어도 이 값을 넘지 않는다.
   * (편도 지연 d1, d2 일 때 오차는 (d1-d2)/2, 상한은 (d1+d2)/2 = 왕복/2)
   */
  maxErrorMs: number;
  /** 이 추정이 적용되는 단조 시각 (t0 와 t3 의 중간) */
  anchorMs: number;
  /** 채택된 상위 표본들의 오프셋 편차. 크면 네트워크가 불안정하다는 뜻. */
  spreadMs: number;
  /** 유효 표본 수 */
  sampleCount: number;
}

/**
 * 녹음 시작을 허용하는 오차 상한.
 *
 * 백엔드 GCC-PHAT 탐색창이 ±500ms 이므로 절반만 쓴다. 나머지 절반은
 * 회의 중 시계 드리프트와 좌석 간 음속 지연(3m ≈ 9ms)에 남겨둔다.
 */
export const SYNC_TOLERANCE_MS = 250;

/** 채택 표본 수. NTP 와 같이 "지연이 가장 짧은 표본"을 신뢰한다. */
const BEST_K = 3;

/**
 * 왕복 표본들에서 시각 오프셋을 추정한다.
 *
 * NTP 와 같은 방식:
 *
 *     왕복  = (t3 - t0) - (t2 - t1)
 *     오프셋 = ((t1 - t0) + (t2 - t3)) / 2
 *
 * 표본을 여러 개 받아 **지연이 가장 짧은 것**을 고른다. 평균이 아니라
 * 최소를 고르는 이유는, 지연이 짧을수록 왕복 비대칭이 작아 오차 상한이
 * 작아지기 때문이다. 평균을 내면 큐잉 지연이 낀 표본이 추정을 오염시킨다.
 *
 * @throws 유효한 표본이 하나도 없으면
 */
export function estimateClock(samples: readonly ClockSample[]): ClockEstimate {
  const usable = samples.filter(isPlausible);
  if (usable.length === 0) {
    throw new Error('시각 동기화 표본이 없습니다 (전부 무효)');
  }

  const scored = usable
    .map((s) => ({
      offsetMs: (s.t1 - s.t0 + (s.t2 - s.t3)) / 2,
      roundTripMs: s.t3 - s.t0 - (s.t2 - s.t1),
      anchorMs: (s.t0 + s.t3) / 2,
    }))
    .sort((a, b) => a.roundTripMs - b.roundTripMs);

  const best = scored[0]!;
  const top = scored.slice(0, Math.min(BEST_K, scored.length));
  const offsets = top.map((s) => s.offsetMs);

  return {
    offsetMs: best.offsetMs,
    roundTripMs: best.roundTripMs,
    maxErrorMs: best.roundTripMs / 2,
    anchorMs: best.anchorMs,
    spreadMs: Math.max(...offsets) - Math.min(...offsets),
    sampleCount: usable.length,
  };
}

/**
 * 물리적으로 말이 안 되는 표본을 버린다.
 *
 * 서버가 응답을 받기 전에 보냈다거나(t2 < t1), 왕복이 음수라거나 하는 건
 * 서버 시계 점프나 계측 오류다. 이런 표본 하나가 최소값으로 뽑히면
 * 추정 전체가 망가지므로 여기서 걸러야 한다.
 */
function isPlausible(s: ClockSample): boolean {
  const total = s.t3 - s.t0;
  const serverSide = s.t2 - s.t1;
  return (
    Number.isFinite(s.t0) &&
    Number.isFinite(s.t1) &&
    Number.isFinite(s.t2) &&
    Number.isFinite(s.t3) &&
    total >= 0 &&
    serverSide >= 0 &&
    total - serverSide >= 0
  );
}

export interface SyncStatus {
  ok: boolean;
  reason: string;
}

/** 이 추정으로 녹음을 시작해도 되는가. */
export function checkSync(
  estimate: ClockEstimate,
  { toleranceMs = SYNC_TOLERANCE_MS }: { toleranceMs?: number } = {},
): SyncStatus {
  if (estimate.maxErrorMs > toleranceMs) {
    return {
      ok: false,
      reason:
        `시각 오차 상한 ${estimate.maxErrorMs.toFixed(0)}ms 가 허용치 ` +
        `${toleranceMs}ms 를 넘습니다 (네트워크가 느립니다)`,
    };
  }
  if (estimate.spreadMs > toleranceMs) {
    return {
      ok: false,
      reason:
        `측정이 불안정합니다 (표본 간 편차 ${estimate.spreadMs.toFixed(0)}ms). ` +
        '다시 시도해 주세요',
    };
  }
  return { ok: true, reason: `오차 상한 ±${estimate.maxErrorMs.toFixed(0)}ms` };
}

/**
 * 회의 내내 시계 변환을 유지한다.
 *
 * ## 왜 한 번 재는 걸로 부족한가
 *
 * 소비자 기기 크리스털은 보통 ±50ppm 안팎으로 흐른다. 1시간이면
 * 50e-6 × 3600s = **180ms**. GCC-PHAT 탐색창(500ms)의 3분의 1 이 넘는다.
 * 그래서 녹음 중에도 주기적으로 다시 재고, 두 측정 사이는 선형 보간한다.
 * 보간하면 드리프트를 따로 모델링하지 않고도 흡수된다.
 */
export class ClockTracker {
  #monotonic: MonotonicClock;
  #estimates: ClockEstimate[] = [];

  constructor(monotonic: MonotonicClock) {
    this.#monotonic = monotonic;
  }

  /** 새 추정을 반영한다. anchor 순으로 정렬 상태를 유지한다. */
  push(estimate: ClockEstimate): void {
    this.#estimates.push(estimate);
    this.#estimates.sort((a, b) => a.anchorMs - b.anchorMs);
  }

  get estimates(): readonly ClockEstimate[] {
    return this.#estimates;
  }

  get synced(): boolean {
    return this.#estimates.length > 0;
  }

  /**
   * 인접한 두 측정 사이의 드리프트(ppm). 측정이 2개 미만이면 null.
   * |값| 이 200ppm 을 넘으면 시계가 아니라 측정이 잘못됐다고 보는 게 맞다.
   */
  driftPpm(): number | null {
    if (this.#estimates.length < 2) return null;
    const first = this.#estimates[0]!;
    const last = this.#estimates[this.#estimates.length - 1]!;
    const span = last.anchorMs - first.anchorMs;
    if (span <= 0) return null;
    return ((last.offsetMs - first.offsetMs) / span) * 1e6;
  }

  /** 단조 시각을 서버 epoch 시각으로 바꾼다. */
  toServerTime(monotonicMs: number): ServerTimeMs {
    return monotonicMs + this.#offsetAt(monotonicMs);
  }

  /** 지금 시각을 서버 epoch 기준으로. */
  now(): ServerTimeMs {
    return this.toServerTime(this.#monotonic());
  }

  #offsetAt(monotonicMs: number): number {
    const es = this.#estimates;
    if (es.length === 0) {
      throw new Error('시각 동기화 전입니다 — toServerTime 을 부를 수 없습니다');
    }
    if (es.length === 1 || monotonicMs <= es[0]!.anchorMs) {
      return es[0]!.offsetMs;
    }
    const last = es[es.length - 1]!;
    // 마지막 측정 이후는 외삽하지 않고 그대로 유지한다. 외삽은 드리프트를
    // 잘못 추정했을 때 오차를 키우기만 한다 — 다음 측정을 기다리는 게 낫다.
    if (monotonicMs >= last.anchorMs) return last.offsetMs;

    for (let i = 1; i < es.length; i += 1) {
      const lo = es[i - 1]!;
      const hi = es[i]!;
      if (monotonicMs <= hi.anchorMs) {
        const t = (monotonicMs - lo.anchorMs) / (hi.anchorMs - lo.anchorMs);
        return lo.offsetMs + t * (hi.offsetMs - lo.offsetMs);
      }
    }
    return last.offsetMs;
  }
}
