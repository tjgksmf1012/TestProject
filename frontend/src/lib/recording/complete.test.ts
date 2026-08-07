import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  completeBody,
  describeCompletion,
  describeCompletionFailure,
  type CompleteInput,
  type TrackCompleteResult,
} from './complete.ts';
import type { Timeline } from './timeline.ts';

const TIMELINE: Timeline = {
  startedAtMs: 1_700_000_000_000,
  endedAtMs: 1_700_000_060_000,
  durationMs: 60_000,
  segments: [],
  gaps: [
    {
      reason: 'recorder_stalled',
      startMs: 1_700_000_020_000,
      endMs: 1_700_000_025_000,
      durationMs: 5_000,
      afterSeq: 3,
    },
  ],
  totalGapMs: 5_000,
  longestGapMs: 5_000,
  coverage: 0.9166666,
  alignmentSafe: false,
};

function input(over: Partial<CompleteInput> = {}): CompleteInput {
  return {
    timeline: TIMELINE,
    verdict: { usable: true, confidence: 0.9, reason: '' },
    captureConfidence: 0.8,
    warnings: [
      { setting: 'echoCancellation', severity: 'warning', message: '에코 제거가 켜져 있습니다' },
    ],
    timesliceMs: 5_000,
    ...over,
  };
}

describe('completeBody', () => {
  it('⭐ 서버 `TrackComplete` 의 필드를 전부 채운다', () => {
    // 이름이 하나만 어긋나도 422 인데, 그 422 를 사람이 볼 자리가 없다.
    deepStrictEqual(Object.keys(completeBody(input())).sort(), [
      'capture_confidence',
      'capture_warnings',
      'coverage',
      'ended_at',
      'gaps',
      'longest_gap_ms',
      'stop_reason',
      'timeslice_ms',
      'total_gap_ms',
    ]);
  });

  it('⭐ 종료 시각을 ISO 문자열로 보낸다 — 숫자는 422 다', () => {
    strictEqual(completeBody(input()).ended_at, '2023-11-14T22:14:20.000Z');
  });

  it('⭐ 커버리지를 반올림하거나 보정하지 않는다', () => {
    // 서버는 이 값을 그대로 믿지 않고 실제로 받은 청크와 대조해 **더 나쁜
    // 쪽**을 쓴다. 여기서 미리 좋게 만들면 그 대조가 무의미해진다.
    strictEqual(completeBody(input()).coverage, 0.9166666);
  });

  it('0~1 을 벗어난 값은 잘라 낸다 — 그 422 는 "녹음이 안 끝난다" 로 보인다', () => {
    const over = completeBody(
      input({ timeline: { ...TIMELINE, coverage: 1.0000001 }, captureConfidence: 1.2 }),
    );
    strictEqual(over.coverage, 1);
    strictEqual(over.capture_confidence, 1);

    const under = completeBody(
      input({ timeline: { ...TIMELINE, coverage: -0.1 }, captureConfidence: -1 }),
    );
    strictEqual(under.coverage, 0);
    strictEqual(under.capture_confidence, 0);
  });

  it('공백을 snake_case 로 옮긴다', () => {
    deepStrictEqual(completeBody(input()).gaps, [
      {
        reason: 'recorder_stalled',
        start_ms: 1_700_000_020_000,
        end_ms: 1_700_000_025_000,
        duration_ms: 5_000,
        after_seq: 3,
      },
    ]);
  });

  it('⭐ 공백이 있어도 지우지 않는다 — 그게 이 요청의 핵심이다', () => {
    // 공백을 빼고 보내면 서버는 커버리지만 보고 정상 종료로 읽는다.
    strictEqual(completeBody(input()).total_gap_ms, 5_000);
    strictEqual(completeBody(input()).gaps.length, 1);
  });

  it('캡처 경고를 그대로 싣는다', () => {
    deepStrictEqual(completeBody(input()).capture_warnings, [
      { setting: 'echoCancellation', severity: 'warning', message: '에코 제거가 켜져 있습니다' },
    ]);
  });

  it('멈춘 이유가 없으면 null — 빈 문자열이 아니다', () => {
    strictEqual(completeBody(input()).stop_reason, null);
    strictEqual(completeBody(input({ stopReason: 'user' })).stop_reason, 'user');
  });
});

function result(over: Partial<TrackCompleteResult> = {}): TrackCompleteResult {
  return {
    track_id: 7,
    status: 'completed',
    coverage: 0.83,
    usable: true,
    message: '녹음이 정상 저장됐습니다',
    meeting_queued: false,
    meeting_status: '',
    ...over,
  };
}

describe('describeCompletion', () => {
  it('⭐ **서버가 준** 커버리지를 보여준다', () => {
    // 화면이 계산한 값과 다를 수 있고, 다를 때는 서버 쪽이 맞다 —
    // 서버는 실제로 받은 청크를 센다.
    strictEqual(describeCompletion(result()).includes('83.0%'), true);
  });

  it('전원이 끝났으면 처리가 시작된다고 말한다', () => {
    const text = describeCompletion(result({ meeting_queued: true }));
    strictEqual(text.includes('회의 처리를 시작'), true);
  });

  it('아직 녹음 중인 사람이 있으면 그 안내를 그대로 전한다', () => {
    const text = describeCompletion(
      result({ meeting_status: '아직 2명이 녹음 중입니다' }),
    );
    strictEqual(text.includes('아직 2명이 녹음 중입니다'), true);
  });
});

describe('describeCompletionFailure', () => {
  it('⭐ 다시 시도하라고 말한다 — 안 끝내면 회의가 영원히 안 돈다', () => {
    // 종료가 실패하면 트랙이 `recording` 으로 남고, 그러면 로비의
    // 검토 버튼과 강제 종료 버튼이 **둘 다 잠긴다.**
    for (const status of [0, 404, 409, 500]) {
      strictEqual(describeCompletionFailure(status).includes('다시 시도'), true, `${status}`);
    }
  });

  it('401 은 로그인을 말한다 — 다시 시도해 봐야 똑같다', () => {
    strictEqual(describeCompletionFailure(401).includes('로그인'), true);
  });

  it('서버가 준 문구가 있으면 그걸 우선한다', () => {
    strictEqual(
      describeCompletionFailure(409, '이미 종료된 트랙입니다').includes(
        '이미 종료된 트랙입니다',
      ),
      true,
    );
  });

  it('모르는 상태 코드도 삼키지 않는다', () => {
    strictEqual(describeCompletionFailure(418).includes('418'), true);
  });
});
