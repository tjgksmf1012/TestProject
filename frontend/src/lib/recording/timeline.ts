/**
 * 트랙 타임라인 복원과 공백 탐지.
 *
 * docs/04-회의-처리-파이프라인.md §2
 *
 * ## 이 모듈이 존재하는 이유
 *
 * iOS Safari 는 **화면이 잠기거나 탭이 백그라운드로 가면 getUserMedia 오디오를
 * 정지시킨다.** WebKit 의 오래된 제약이고, 2026년 8월 현재도 그대로다.
 * 안드로이드 크롬도 배터리 세이버가 공격적이면 비슷한 일이 생긴다.
 *
 * 여기서 진짜 위험한 건 "30초를 잃는 것"이 아니다. **모르고 잃는 것**이다.
 *
 *     [순진한 구현]  청크를 순서대로 이어붙인다
 *                    → 중간에 30초가 비면 그 뒤 전체가 30초 앞당겨진다
 *                    → 트랙 간 정렬이 깨진다
 *                    → 에너지 비교로 뽑는 주화자가 전부 틀린다
 *                    → 엉뚱한 사람의 기여도가 된다  (docs/05 §5)
 *
 * 조용히 짧아진 트랙 하나가 회의 전체의 화자 판정을 망가뜨린다. 그래서
 * 각 청크에 **동기화된 절대 시각**을 붙이고, 공백을 명시적으로 찾아내
 * 서버가 무음으로 메우게 한다. 30초를 잃는 건 어쩔 수 없지만, 그게 어디
 * 있는지 알면 나머지 59분 30초는 살릴 수 있다.
 *
 * 잃은 구간은 "판정 불가"로 표시된다 — `video/speaker.fuse` 가 불일치를
 * 억지로 해소하지 않는 것과 같은 원칙이다.
 */

import type { ChunkMeta, Gap, Interval, ServerTimeMs } from './types.ts';
import { withJosa } from '../text/josa.ts';

/** 실제 오디오가 존재하는 구간. 서버는 이 절대 시각에 그대로 배치한다. */
export interface Segment extends Interval {
  fromSeq: number;
  toSeq: number;
  durationMs: number;
}

export interface Timeline {
  startedAtMs: ServerTimeMs;
  endedAtMs: ServerTimeMs;
  durationMs: number;
  segments: Segment[];
  gaps: Gap[];
  /** 공백 구간의 합집합 길이. 겹치는 공백을 두 번 세지 않는다. */
  totalGapMs: number;
  longestGapMs: number;
  /** 오디오가 있는 시간 비율 (0~1) */
  coverage: number;
  /**
   * 청크를 그냥 이어붙여도 되는가.
   *
   * 공백이 하나라도 있으면 false — 이어붙이면 그 뒤가 전부 앞당겨진다.
   * 이 값이 false 인 트랙은 반드시 절대 시각으로 배치해야 한다.
   */
  alignmentSafe: boolean;
}

export interface BuildTimelineOptions {
  /** `MediaRecorder.start(timeslice)` 에 넘긴 값 */
  timesliceMs: number;
  startedAtMs: ServerTimeMs;
  endedAtMs: ServerTimeMs;
  /** 끝내 업로드하지 못한 청크 seq */
  lostSeqs?: readonly number[];
  /** 트랙이 mute 였던 구간 (MediaStreamTrack 의 mute/unmute 이벤트) */
  mutedIntervals?: readonly Interval[];
  /**
   * 이만큼까지의 지연은 정상 지터로 본다.
   * 브라우저의 `dataavailable` 은 timeslice 를 정확히 지키지 않는다.
   */
  stallToleranceMs?: number;
}

const DEFAULT_STALL_TOLERANCE_MS = 300;

/** 이보다 짧은 공백은 무시한다. 화자 판정에 영향이 없다. */
const MIN_REPORTED_GAP_MS = 100;

export function buildTimeline(
  chunks: readonly ChunkMeta[],
  options: BuildTimelineOptions,
): Timeline {
  const {
    timesliceMs,
    startedAtMs,
    endedAtMs,
    lostSeqs = [],
    mutedIntervals = [],
    stallToleranceMs = DEFAULT_STALL_TOLERANCE_MS,
  } = options;

  if (timesliceMs <= 0) throw new Error('timesliceMs 는 양수여야 합니다');
  if (endedAtMs < startedAtMs) throw new Error('종료 시각이 시작 시각보다 빠릅니다');

  const durationMs = endedAtMs - startedAtMs;
  const ordered = [...chunks].sort((a, b) => a.seq - b.seq);
  const lost = new Set(lostSeqs);
  const gaps: Gap[] = [];

  // ── 1. 레코더가 멈춘 구간 ──────────────────────────────
  // 청크가 와야 할 때 오지 않았다. iOS 화면 잠금이 여기 잡힌다.
  let prevAt = startedAtMs;
  let prevSeq = -1;
  for (const chunk of ordered) {
    const delta = chunk.atMs - prevAt;
    const stall = delta - timesliceMs;
    if (stall > stallToleranceMs) {
      pushGap(gaps, {
        startMs: prevAt,
        endMs: chunk.atMs - timesliceMs,
        reason: 'recorder_stalled',
        afterSeq: prevSeq,
      });
    }
    prevAt = chunk.atMs;
    prevSeq = chunk.seq;
  }

  // 마지막 청크와 종료 시각 사이도 공백이다. 정지 직전에 멈췄을 수 있다.
  if (endedAtMs - prevAt > stallToleranceMs) {
    pushGap(gaps, {
      startMs: prevAt,
      endMs: endedAtMs,
      reason: 'recorder_stalled',
      afterSeq: prevSeq,
    });
  }

  // ── 2. 업로드에 실패한 청크 ─────────────────────────────
  // 바이트는 만들어졌는데 서버에 없다. 결과적으로 같은 구멍이다.
  for (const chunk of ordered) {
    if (!lost.has(chunk.seq)) continue;
    pushGap(gaps, {
      startMs: Math.max(startedAtMs, chunk.atMs - timesliceMs),
      endMs: chunk.atMs,
      reason: 'chunk_lost',
      afterSeq: chunk.seq - 1,
    });
  }

  // ── 3. mute 된 구간 ────────────────────────────────────
  // 청크는 정상적으로 오는데 내용이 무음이다. 타이밍만 봐서는 절대 못 찾는다.
  // iOS 에서 백그라운드 전환 시 마이크가 muted 로 바뀌는 경우가 이쪽이다.
  for (const muted of mutedIntervals) {
    pushGap(gaps, {
      startMs: Math.max(startedAtMs, muted.startMs),
      endMs: Math.min(endedAtMs, muted.endMs),
      reason: 'track_muted',
      afterSeq: lastSeqBefore(ordered, muted.startMs),
    });
  }

  gaps.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const union = mergeIntervals(gaps);
  const totalGapMs = union.reduce((acc, g) => acc + (g.endMs - g.startMs), 0);
  const longestGapMs = gaps.reduce((acc, g) => Math.max(acc, g.durationMs), 0);

  return {
    startedAtMs,
    endedAtMs,
    durationMs,
    segments: segmentsFrom(ordered, union, startedAtMs, endedAtMs),
    gaps,
    totalGapMs,
    longestGapMs,
    coverage: durationMs > 0 ? Math.max(0, 1 - totalGapMs / durationMs) : 0,
    alignmentSafe: gaps.length === 0,
  };
}

function pushGap(gaps: Gap[], gap: Omit<Gap, 'durationMs'>): void {
  const durationMs = gap.endMs - gap.startMs;
  if (durationMs < MIN_REPORTED_GAP_MS) return;
  gaps.push({ ...gap, durationMs });
}

function lastSeqBefore(chunks: readonly ChunkMeta[], atMs: number): number {
  let seq = -1;
  for (const chunk of chunks) {
    if (chunk.atMs > atMs) break;
    seq = chunk.seq;
  }
  return seq;
}

/** 겹치거나 맞닿은 구간을 합친다. 공백 길이를 두 번 세지 않기 위해서다. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals]
    .filter((i) => i.endMs > i.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const merged: Interval[] = [];
  for (const current of sorted) {
    const last = merged[merged.length - 1];
    if (last && current.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, current.endMs);
    } else {
      merged.push({ startMs: current.startMs, endMs: current.endMs });
    }
  }
  return merged;
}

/** 전체 구간에서 공백을 뺀 나머지가 실제 오디오 구간이다. */
function segmentsFrom(
  chunks: readonly ChunkMeta[],
  gapUnion: readonly Interval[],
  startedAtMs: number,
  endedAtMs: number,
): Segment[] {
  const segments: Segment[] = [];
  let cursor = startedAtMs;

  const close = (endMs: number): void => {
    if (endMs <= cursor) return;
    segments.push({
      startMs: cursor,
      endMs,
      durationMs: endMs - cursor,
      fromSeq: firstSeqIn(chunks, cursor, endMs),
      toSeq: lastSeqIn(chunks, cursor, endMs),
    });
  };

  for (const gap of gapUnion) {
    close(Math.min(gap.startMs, endedAtMs));
    cursor = Math.max(cursor, gap.endMs);
  }
  close(endedAtMs);

  return segments;
}

function firstSeqIn(chunks: readonly ChunkMeta[], startMs: number, endMs: number): number {
  for (const chunk of chunks) {
    if (chunk.atMs > startMs && chunk.atMs <= endMs) return chunk.seq;
  }
  return -1;
}

function lastSeqIn(chunks: readonly ChunkMeta[], startMs: number, endMs: number): number {
  let seq = -1;
  for (const chunk of chunks) {
    if (chunk.atMs > startMs && chunk.atMs <= endMs) seq = chunk.seq;
  }
  return seq;
}

const REASON_LABEL: Record<Gap['reason'], string> = {
  recorder_stalled: '녹음 중단 (화면 잠금이나 앱 전환)',
  track_muted: '마이크 음소거',
  chunk_lost: '업로드 실패',
};

/** 사용자에게 보여줄 한 줄 요약. 숨기지 않고 그대로 알린다. */
export function describeTimeline(timeline: Timeline): string {
  if (timeline.gaps.length === 0) {
    return `녹음이 끊김 없이 완료됐습니다 (${formatDuration(timeline.durationMs)})`;
  }
  const reasons = new Set(timeline.gaps.map((g) => REASON_LABEL[g.reason]));
  return (
    `${withJosa(formatDuration(timeline.totalGapMs), '이가')} 비었습니다 ` +
    `(${[...reasons].join(', ')}). ` +
    `가장 긴 공백 ${formatDuration(timeline.longestGapMs)}, ` +
    `커버리지 ${(timeline.coverage * 100).toFixed(1)}%`
  );
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}분 ${seconds}초` : `${seconds}초`;
}

/**
 * 이 트랙을 화자 판정에 쓸 수 있는가.
 *
 * 커버리지가 낮은 트랙은 "말을 안 한 사람"처럼 보인다. 실제로는 폰이
 * 잠긴 것뿐인데 기여도가 깎이면 그건 그냥 오답이다. 임계값 아래면
 * 트랙을 버리고 사람에게 알린다 — 조용히 낮은 점수를 주는 것보다 낫다.
 */
export const MIN_USABLE_COVERAGE = 0.8;

export interface TrackVerdict {
  usable: boolean;
  /** 기여도 계산에 반영할 신뢰 가중치 (0~1) */
  confidence: number;
  reason: string;
}

export function judgeTrack(
  timeline: Timeline,
  { minCoverage = MIN_USABLE_COVERAGE }: { minCoverage?: number } = {},
): TrackVerdict {
  if (timeline.coverage >= 1) {
    return { usable: true, confidence: 1, reason: '공백 없음' };
  }
  if (timeline.coverage < minCoverage) {
    return {
      usable: false,
      confidence: 0,
      reason:
        `커버리지 ${(timeline.coverage * 100).toFixed(0)}% — ` +
        '이 트랙으로는 발화량을 판단할 수 없습니다. 사람이 확인해야 합니다',
    };
  }
  return {
    usable: true,
    confidence: timeline.coverage,
    reason: `공백 ${formatDuration(timeline.totalGapMs)} 만큼 신뢰도를 낮춥니다`,
  };
}
