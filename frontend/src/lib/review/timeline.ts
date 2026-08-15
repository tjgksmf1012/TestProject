/**
 * 회의 타임라인 (`REVIEW-002`) 과 구간 재생 (`REVIEW-004`) 의 판단.
 *
 * ## 타임라인은 **한 줄기**입니다
 *
 * 발화와 비효율 구간(`findings`)을 시간 순으로 한 줄기에 섞습니다.
 * 사람별로 줄을 갈라 늘어놓으면 그 순간 "누가 얼마나 말했나" 그림이
 * 됩니다 — 발언 비중 화면이 일부러 안 그린 것을 여기서 그리게 됩니다.
 *
 * ## 재생 위치는 서버가 정합니다
 *
 * `audio.position_ms` 는 **이어 붙인 소리** 위의 위치입니다 — 발화
 * 시각(`start_ms`)과 다릅니다. 이어 붙이면 공백이 사라져 뒤가
 * 앞당겨지는데, 그 보정은 서버(`audio/playback.py`)가 했습니다. 여기서
 * `start_ms` 로 틀면 **엉뚱한 말**이 나옵니다.
 */

import { evidenceView, type EvidenceView, type Utterance } from './evidence.ts';
import { findingView, type Finding, type FindingView } from './findings.ts';

/** 서버 타임라인의 발화 한 줄 — 근거 발화와 같은 모양 + 들을 자리. */
export interface TimelineUtterance extends Utterance {
  audio: { track_id: number; position_ms: number } | null;
}

/** 한 발화를 들을 구간. 초 단위 — `HTMLAudioElement.currentTime` 이 초라서. */
export interface Clip {
  trackId: number;
  startSec: number;
  /** 여기 오면 멈춘다. 구간 재생이지 트랙 전체 재생이 아니다. */
  endSec: number;
}

export type TimelineRow =
  | { kind: 'utterance'; view: EvidenceView; clip: Clip | null }
  | { kind: 'finding'; view: FindingView };

/**
 * 들을 구간. 못 들으면 `null` — 이유는 서버가 이미 골랐습니다
 * (트랙 미지정 · 소리 미보관 · 유실 구간).
 */
export function clipOf(utterance: TimelineUtterance): Clip | null {
  if (utterance.audio === null) return null;
  const durationMs = Math.max(0, utterance.end_ms - utterance.start_ms);
  return {
    trackId: utterance.audio.track_id,
    startSec: utterance.audio.position_ms / 1000,
    endSec: (utterance.audio.position_ms + durationMs) / 1000,
  };
}

/**
 * 발화와 비효율 구간을 시간 순 **한 줄기**로 섞는다.
 *
 * 같은 시각이면 구간 머리말이 먼저다 — "여기부터 반복 논의" 를 그 발화
 * **앞**에 세워야 구간의 머리말로 읽힌다.
 */
export function timelineRows(
  utterances: readonly TimelineUtterance[],
  findings: readonly Finding[],
): TimelineRow[] {
  // ⚠️ `findingViews`(복수형)가 아닙니다 — 그쪽은 종류 순으로 다시
  //    정렬합니다. 여기는 **시간**이 축이라 건별로 만들어 시각을 답니다.
  const rows: { at: number; tie: number; row: TimelineRow }[] = findings.map((finding) => ({
    at: finding.start_ms,
    tie: 0,
    row: { kind: 'finding', view: findingView(finding) },
  }));
  for (const utterance of utterances) {
    rows.push({
      at: utterance.start_ms,
      tie: 1,
      row: { kind: 'utterance', view: evidenceView(utterance), clip: clipOf(utterance) },
    });
  }
  rows.sort((a, b) => a.at - b.at || a.tie - b.tie);
  return rows.map((r) => r.row);
}

/** 지금 시각이 구간 끝을 지났는가 — `timeupdate` 마다 묻는다. */
export function pastClipEnd(currentSec: number, clip: Clip): boolean {
  return currentSec >= clip.endSec;
}

/** 트랙 소리의 주소. 발화가 아니라 **트랙** 단위다 — 구간은 시각으로 간다. */
export function trackAudioUrl(apiBase: string, meetingId: number, trackId: number): string {
  return `${apiBase}/api/meetings/${meetingId}/tracks/${trackId}/audio`;
}

/**
 * 소리가 하나도 없는 회의에서 할 말.
 *
 * ⚠️ 재생 버튼이 조용히 안 뜨기만 하면 사람은 **고장**으로 읽습니다.
 * 흙빛으로 이유를 말합니다 — 소리가 없는 것은 잘못이 아니라 사실입니다.
 */
export function noAudioNote(): string {
  return '이 회의는 소리가 보관돼 있지 않습니다 — 녹음이 업로드된 회의만 구간을 들을 수 있습니다';
}

/** 발화가 하나도 없을 때. 빈 목록은 고장과 구별이 안 됩니다. */
export function emptyTimelineNote(): string {
  return '이 회의에는 기록된 발화가 없습니다 — 녹음이 아직 처리되지 않았거나, 녹음 없이 열린 회의입니다';
}

/**
 * 어느 안내를 내보일 것인가 — 소리 없음과 **연결 안 됨**은 다른 사실입니다.
 *
 * 소리는 보관돼 있는데 어느 발화도 들을 수 없는 회의가 있습니다(발화가
 * 트랙에 안 묶였거나 전부 유실 구간 위). 그때 아무 말도 안 하면 듣기
 * 버튼이 없는 이유를 알 수 없고, "소리가 없다" 고 말하면 거짓입니다.
 */
export function audioNote(hasAudio: boolean, rows: readonly TimelineRow[]): string | null {
  if (!hasAudio) return noAudioNote();
  const playable = rows.some((row) => row.kind === 'utterance' && row.clip !== null);
  if (!playable) {
    return '소리는 보관돼 있는데 발화와 아직 연결되지 않아 구간을 들을 수 없습니다';
  }
  return null;
}
