/**
 * 녹음 종료를 서버에 알리는 요청 본문.
 *
 * ## 왜 이게 따로 있는가
 *
 * ⚠️ **이 요청을 보내는 코드가 저장소에 하나도 없었습니다.**
 *
 * `POST /api/meetings/{mid}/tracks/{tid}/complete` 는 녹음이 처리
 * 파이프라인으로 넘어가는 **유일한 정상 경로**입니다
 * (`complete_track` → `try_finalize_meeting` → 큐). 그런데 정지 버튼은
 * `client.stop()` 으로 요약을 받아 **화면에만 그리고 끝났습니다.**
 *
 * 그래서 이런 일이 벌어졌습니다.
 *
 *   · 트랙이 영원히 `recording` 으로 남는다 (`ended_at` 은 NULL)
 *   · 회의가 큐에 들어가지 않는다 — 요약도 업무 후보도 영원히 안 나온다
 *   · 로비가 그 상태를 **풀 수도 없다.** `verdictOf` 가 coverage 를 아직
 *     모르므로 `healthy` 를 돌려주고, `recording > 0` 이 영구히 참이 되어
 *     **강제 종료 버튼도 검토 버튼도 뜨지 않는다**
 *
 * 오류 메시지는 하나도 없습니다. 회의 → 후보 → 칸반 → 기여도라는 이
 * 프로젝트의 주장 전체가 실제 화면에서는 **첫 단계에서 멈춰 있었습니다.**
 * 시연에서 안 보인 이유는 `seed_demo.py` 가 트랙을 `status="completed"` 로
 * DB 에 직접 써 넣기 때문입니다 — 시연은 이 경로를 한 번도 지나지 않습니다.
 *
 * 본문 만들기를 여기로 뺀 이유는 화면 코드에 테스트가 없기 때문입니다.
 * 필드 이름 하나가 어긋나면 서버는 422 를 주는데, 그 422 를 사람이 볼
 * 자리가 없습니다.
 */

import type { CaptureWarning } from './capture.ts';
import type { Gap } from './types.ts';
import type { Timeline, TrackVerdict } from './timeline.ts';

/** 서버 `TrackComplete` 와 같은 모양. 필드 이름이 어긋나면 422 다. */
export interface TrackCompleteBody {
  ended_at: string;
  coverage: number;
  total_gap_ms: number;
  longest_gap_ms: number;
  gaps: Record<string, unknown>[];
  capture_confidence: number;
  capture_warnings: Record<string, unknown>[];
  stop_reason: string | null;
  timeslice_ms: number;
}

export interface CompleteInput {
  timeline: Timeline;
  verdict: TrackVerdict;
  captureConfidence: number;
  warnings: readonly CaptureWarning[];
  timesliceMs: number;
  stopReason?: string | null;
}

/**
 * 밀리초 단위 서버 시각을 ISO 문자열로.
 *
 * 서버는 `datetime` 을 받으므로 숫자를 그대로 보내면 422 입니다.
 */
function isoOf(serverTimeMs: number): string {
  return new Date(serverTimeMs).toISOString();
}

function gapOf(gap: Gap): Record<string, unknown> {
  return {
    reason: gap.reason,
    start_ms: gap.startMs,
    end_ms: gap.endMs,
    duration_ms: gap.durationMs,
    after_seq: gap.afterSeq,
  };
}

/**
 * 종료 요청 본문.
 *
 * ⭐ **커버리지를 반올림하거나 보정하지 않습니다.** 서버는 이 값을 그대로
 * 믿지 않고 실제로 받은 청크 수와 대조해 **더 나쁜 쪽**을 씁니다. 여기서
 * 미리 좋게 만들면 그 대조가 무의미해집니다.
 */
export function completeBody(input: CompleteInput): TrackCompleteBody {
  const { timeline } = input;
  return {
    ended_at: isoOf(timeline.endedAtMs),
    // 서버가 0~1 을 요구한다. 계산 오차로 1 을 아주 조금 넘으면 422 가
    // 나는데, 그 422 는 "녹음이 끝나지 않는다" 로 보인다.
    coverage: Math.min(1, Math.max(0, timeline.coverage)),
    total_gap_ms: Math.max(0, Math.round(timeline.totalGapMs)),
    longest_gap_ms: Math.max(0, Math.round(timeline.longestGapMs)),
    gaps: timeline.gaps.map(gapOf),
    capture_confidence: Math.min(1, Math.max(0, input.captureConfidence)),
    capture_warnings: input.warnings.map((w) => ({
      setting: w.setting,
      severity: w.severity,
      message: w.message,
    })),
    stop_reason: input.stopReason ?? null,
    timeslice_ms: input.timesliceMs,
  };
}

/** 서버 `TrackCompleteOut` 과 같은 모양. */
export interface TrackCompleteResult {
  track_id: number;
  status: string;
  coverage: number;
  usable: boolean;
  message: string;
  meeting_queued: boolean;
  meeting_status: string;
}

/**
 * 종료 결과를 사람이 읽을 문구로.
 *
 * ⭐ **서버가 준 커버리지를 씁니다.** 화면이 계산한 값과 다를 수 있고,
 * 다를 때는 서버 쪽이 맞습니다 — 서버는 실제로 받은 청크를 셉니다.
 * 화면 값을 계속 보여주면 사람은 "괜찮다고 했는데 왜 안 되지" 가 됩니다.
 */
export function describeCompletion(result: TrackCompleteResult): string {
  const percent = `${(result.coverage * 100).toFixed(1)}%`;

  if (result.meeting_queued) {
    return `녹음을 마쳤습니다 (서버 기준 커버리지 ${percent}). 전원이 끝나 회의 처리를 시작합니다.`;
  }
  if (result.meeting_status) {
    return `녹음을 마쳤습니다 (서버 기준 커버리지 ${percent}). ${result.meeting_status}`;
  }
  return `녹음을 마쳤습니다 (서버 기준 커버리지 ${percent}).`;
}

/**
 * 종료가 실패했을 때 무엇을 말할 것인가.
 *
 * ⭐ 조용히 넘어가면 안 됩니다. 종료가 실패하면 트랙이 `recording` 으로
 * 남고, 그러면 **로비의 검토 버튼과 강제 종료 버튼이 둘 다 잠깁니다.**
 * 사람이 다시 시도할 수 있다는 것까지 말해야 합니다.
 */
export function describeCompletionFailure(status: number, detail?: string): string {
  const suffix = '다시 시도를 눌러 주세요 — 끝내지 않으면 회의 처리가 시작되지 않습니다.';
  if (status === 401) return '로그인이 풀렸습니다. 다시 로그인한 뒤 종료해야 합니다.';
  if (status === 404) return `이 트랙을 찾을 수 없습니다. ${suffix}`;
  if (status === 409) return detail || `이미 끝난 트랙입니다. ${suffix}`;
  if (status === 0) return `서버에 연결하지 못했습니다. ${suffix}`;
  return `${detail || `종료하지 못했습니다 (HTTP ${status})`}. ${suffix}`;
}
