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
  /**
   * **소리가 시작된 시각** (결함 230).
   *
   * ⚠️ 트랙의 `started_at` 은 **페이지를 열 때** 만들어집니다 — 마이크
   * 권한을 허용하고 「녹음 시작」을 누르기 **전**입니다. 서버는 커버리지를
   * `[started_at, ended_at]` 창에 대해 재기 때문에, 그 사이에 사람이
   * 머뭇거린 시간이 통째로 **공백**으로 잡혔습니다.
   *
   * 같은 12초 녹음을 재 봤습니다:
   *
   *     바로 시작    → 커버리지 75.6%  · 사용 불가
   *     20초 뒤 시작 → 커버리지 33.5%  · 사용 불가
   *
   * 오디오는 똑같습니다. **버튼을 늦게 눌렀다는 것뿐**입니다.
   */
  started_at: string;
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
    // ⚠️ 트랙을 만든 시각이 아니라 **소리가 시작된 시각** (결함 230).
    started_at: isoOf(timeline.startedAtMs),
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

/**
 * 종료한 뒤 **결과 칸이 보여줄 값**.
 *
 * ## 무슨 일이 있었나 (결함 220)
 *
 * 결과 칸은 끝까지 **이 기기가 잰 값**을 보여줬습니다. 서버가 실제로 받은
 * 청크로 다시 계산한 값은 바로 위 한 문장에만 들어갔고요. 실제로 이렇게
 * 나왔습니다 (가짜 마이크로 7초 녹음, 서버 응답 그대로):
 *
 *     서버:  status=unusable · coverage=0.515 · usable=false
 *     화면:  「녹음을 마쳤습니다 (서버 기준 커버리지 45.0%)」   ← 문장
 *            「녹음이 끊김 없이 완료됐습니다 (7초)」 (초록)     ← 판정
 *            커버리지 100.0% · 판정 **사용 가능**               ← 칸
 *
 * 한 화면에 45% 와 100% 가 여덟 줄 사이로 같이 있었고, **크고 초록인
 * 쪽이 틀린 값**이었습니다. 사람은 큰 쪽을 믿고 나갑니다.
 *
 * 그 차이는 고장이 아니라 **정보**입니다 — 마이크는 안 끊겼는데 서버에
 * 절반만 도착했다는 것은 **아직 안 올라간 조각이 있다**는 뜻입니다. 그걸
 * 말해 줘야 사람이 「다시 올리기」를 누릅니다.
 *
 * ⚠️ 이 파일은 이미 "**서버가 준 커버리지를 씁니다. 다를 때는 서버 쪽이
 * 맞습니다**" 라고 적어 두고 있었습니다. 문장 하나에만 적용돼 있었을
 * 뿐입니다 — 규칙은 있었고 **닿는 자리가 좁았습니다.**
 */
export interface CompletionView {
  /** 결과 칸의 커버리지. **서버 값**입니다. */
  coverageText: string;
  /** 「사용 가능」/「사용 불가」. **서버 값**입니다. */
  usableText: string;
  /** 머리 문장. 서버가 못 쓴다고 하면 서버가 준 이유를 그대로 씁니다. */
  headline: string;
  /** `ok` 는 초록, `bad` 는 경고색. 서버 판정을 따릅니다. */
  tone: 'ok' | 'bad';
  /**
   * 기기 값과 서버 값이 **눈에 띄게 다를 때** 그 사실. 아니면 `null`.
   *
   * ⚠️ 반올림 차이로 매번 뜨면 아무도 안 읽습니다. 1%p 넘게 벌어질 때만.
   */
  disagreement: string | null;
}

/** 이만큼 벌어지면 사람에게 말합니다. 그 아래는 반올림입니다. */
const COVERAGE_GAP_TO_TELL = 0.01;

export function completionView(
  result: TrackCompleteResult,
  local: { coverage: number; headline: string },
  /**
   * 종료한 **뒤에** 남은 조각을 다시 올렸는가.
   *
   * ⚠️ 그랬다면 위의 서버 값은 **낡았습니다** — 커버리지는 `complete_track`
   * 에서만 계산되고, 늦게 올라온 조각은 그 계산에 안 들어갑니다. 그런데도
   * 「아직 안 올라간 조각이 있습니다」 를 계속 띄우면, 방금 올린 사람에게
   * 안 올렸다고 말하는 것입니다. 모르는 것은 모른다고 합니다.
   */
  reuploaded = false,
): CompletionView {
  const serverPercent = (result.coverage * 100).toFixed(1);
  const gap = local.coverage - result.coverage;

  return {
    coverageText: `${serverPercent}%`,
    usableText: result.usable ? '사용 가능' : '사용 불가',
    // 서버가 못 쓴다고 하면 **왜**까지 서버가 말합니다. 화면이 다시 짓지
    // 않습니다 — 지으면 같은 사실에 두 문장이 생깁니다.
    headline: result.usable ? local.headline : result.message || local.headline,
    tone: result.usable ? 'ok' : 'bad',
    disagreement: reuploaded
      ? '방금 올린 조각은 위 서버 값에 아직 반영되지 않았습니다 — 그 값은 종료할 때 계산된 것입니다.'
      : gap > COVERAGE_GAP_TO_TELL
        ? `이 기기는 ${(local.coverage * 100).toFixed(1)}%를 녹음했는데 서버에는 ` +
          `${serverPercent}%만 도착했습니다 — 아직 안 올라간 조각이 있습니다.`
        : null,
  };
}
