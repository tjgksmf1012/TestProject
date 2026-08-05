/**
 * 녹음 클라이언트 공용 타입.
 *
 * docs/04-회의-처리-파이프라인.md §2 (멀티트랙)
 *
 * 설계 원칙 — **브라우저 API는 전부 주입한다.**
 * `getUserMedia`, `MediaRecorder`, `performance.now`, `fetch`, `setTimeout` 은
 * 전부 인자로 받는다. 그래야 Node 에서 의존성 없이 전부 검증된다.
 * 백엔드 `pipeline/steps.py` 의 Protocol 방식과 같은 패턴이다.
 */

/** 단조 증가 시계(ms). 브라우저에서는 `performance.now()`. */
export type MonotonicClock = () => number;

/** 서버 epoch 시각(ms) 기준. 동기화된 시계에서만 나온다. */
export type ServerTimeMs = number;

export interface Interval {
  startMs: ServerTimeMs;
  endMs: ServerTimeMs;
}

/**
 * 녹음 중 발생한 청크 하나의 메타데이터.
 *
 * 바이트 자체(Blob)는 여기 담지 않는다. 순수 로직은 바이트를 볼 필요가 없고,
 * 담는 순간 Node 에서 테스트할 수 없게 된다.
 */
export interface ChunkMeta {
  /** 0부터 단조 증가. 서버가 순서를 복원하는 유일한 근거다. */
  seq: number;
  /** 이 청크가 `ondataavailable` 로 도착한 시각 (동기화된 서버 시각). */
  atMs: ServerTimeMs;
  byteLength: number;
}

/** 타임라인에 뚫린 구멍. 왜 뚫렸는지가 중요하다. */
export type GapReason =
  /** 레코더가 멈췄다 (iOS 화면 잠금·백그라운드 전환 등). 오디오 자체가 없다. */
  | 'recorder_stalled'
  /** 트랙이 mute 됐다. 청크는 오는데 내용이 무음이다. */
  | 'track_muted'
  /** 청크는 만들어졌는데 업로드가 끝내 실패했다. */
  | 'chunk_lost';

export interface Gap extends Interval {
  reason: GapReason;
  durationMs: number;
  /** 이 공백 직전의 마지막 청크 seq. 없으면 -1(녹음 시작 직후). */
  afterSeq: number;
}
