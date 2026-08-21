import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  completeBody,
  completionView,
  coverageLabel,
  describeCompletion,
  describeCompletionFailure,
  usableText,
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
      'started_at',
      'stop_reason',
      'timeslice_ms',
      'total_gap_ms',
    ]);
  });

  it('⭐ 종료 시각을 ISO 문자열로 보낸다 — 숫자는 422 다', () => {
    strictEqual(completeBody(input()).ended_at, '2023-11-14T22:14:20.000Z');
  });

  it('⛔ **소리가 시작된 시각**을 보낸다 — 트랙이 열린 시각이 아니다 (결함 230)', () => {
    // 트랙은 녹음 화면이 **열릴 때** 만들어집니다. 사람은 그 뒤에 마이크
    // 권한을 허용하고 안내를 읽고 버튼을 누릅니다. 서버가 커버리지를
    // `[트랙 생성, 종료]` 창에 대해 재면 그 머뭇거린 시간이 공백이 됩니다.
    //
    // 브라우저에서 잰 값 (같은 12초 녹음, 기다린 시간만 다름):
    //   바로 시작 → 75.6% unusable · 20초 뒤 시작 → 33.5% unusable
    const body = completeBody(input());
    strictEqual(body.started_at, new Date(TIMELINE.startedAtMs).toISOString());
    // 시작이 종료보다 뒤면 서버가 창을 못 만듭니다.
    strictEqual(body.started_at < body.ended_at, true);
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
  it('⭐ 커버리지 **숫자는 문장에 없다** — 바로 아래 칸이 라벨과 함께 말한다', () => {
    /* 결함 220 전에는 서버 값이 **이 문장에만** 있었습니다. 이제는
       `completionView` 가 칸을 서버 값으로 바꾸고 라벨이 주인을 밝히므로,
       같은 숫자를 두 번 읽힐 이유가 없습니다 (결함 275). */
    strictEqual(describeCompletion(result()).includes('83.0%'), false);
    strictEqual(describeCompletion(result()).includes('녹음을 마쳤습니다'), true);
  });

  it('⭐ 값의 주인은 **라벨**이 말한다', () => {
    strictEqual(coverageLabel('server'), '커버리지(서버)');
    strictEqual(coverageLabel('device'), '커버리지(이 기기)');
  });

  it('⛔ 기기는 「사용 가능」을 말할 수 없다 — 모름은 모름이다', () => {
    /* 종료 요청이 서버에 못 닿으면 칸에는 이 기기가 잰 값이 남습니다.
       예전에는 그때도 「판정 사용 가능」이 초록으로 서 있었습니다 —
       「서버에 연결하지 못했습니다」 바로 아래에서. */
    strictEqual(usableText(null), '서버 확인 전');
    strictEqual(usableText(true), '사용 가능');
    strictEqual(usableText(false), '사용 불가');
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

describe('결과 칸의 주인은 **서버**입니다 (결함 220)', () => {
  const server = (over: Partial<TrackCompleteResult> = {}): TrackCompleteResult => ({
    track_id: 1,
    status: 'completed',
    coverage: 0.98,
    usable: true,
    message: '',
    meeting_queued: false,
    meeting_status: '',
    ...over,
  });
  const local = { coverage: 1, headline: '녹음이 끊김 없이 완료됐습니다 (7초)' };

  it('⭐ 서버가 못 쓴다고 하면 칸도 그렇게 말한다', () => {
    // 실제로 이랬습니다 — 서버 `usable=false · coverage=0.515` 옆에서
    // 칸은 「사용 가능 · 100.0%」 를 **초록으로** 띄우고 있었습니다.
    const view = completionView(
      server({ usable: false, coverage: 0.515, status: 'unusable', message: '커버리지 52% — 쓸 수 없습니다' }),
      local,
    );
    strictEqual(view.usableText, '사용 불가');
    strictEqual(view.coverageText, '51.5%');
    strictEqual(view.tone, 'bad');
    strictEqual(view.headline, '커버리지 52% — 쓸 수 없습니다');
  });

  it('⭐ 서버가 괜찮다고 하면 이 기기가 본 문장을 그대로 쓴다', () => {
    const view = completionView(server({ coverage: 0.98 }), local);
    strictEqual(view.headline, local.headline);
    strictEqual(view.tone, 'ok');
    strictEqual(view.coverageText, '98.0%');
    strictEqual(view.usableText, '사용 가능');
  });

  it('⭐ 차이는 **고장이 아니라 정보**다 — 아직 안 올라간 조각이 있다는 뜻', () => {
    const view = completionView(server({ coverage: 0.45, usable: false }), local);
    strictEqual(/100\.0%를 녹음했는데/.test(view.disagreement ?? ''), true);
    strictEqual(/45\.0%만 도착/.test(view.disagreement ?? ''), true);
  });

  it('⚠️ 반올림 차이로 매번 뜨지 않는다 — 그러면 아무도 안 읽는다', () => {
    strictEqual(completionView(server({ coverage: 0.995 }), local).disagreement, null);
    strictEqual(completionView(server({ coverage: 1 }), local).disagreement, null);
    // 서버가 더 높게 잡은 경우도 말할 것이 없습니다.
    strictEqual(completionView(server({ coverage: 1 }), { ...local, coverage: 0.9 }).disagreement, null);
  });

  it('⛔ 다시 올린 뒤에 「안 올라간 조각이 있다」 고 말하지 않는다', () => {
    // 커버리지는 `complete_track` 에서만 계산됩니다 — 늦게 올라온 조각은
    // 그 값에 안 들어갑니다. 그런데도 같은 문장을 띄우면 **방금 올린
    // 사람에게 안 올렸다고** 말하는 것입니다.
    const view = completionView(server({ coverage: 0.45, usable: false }), local, true);
    strictEqual(/안 올라간 조각이 있습니다/.test(view.disagreement ?? ''), false);
    strictEqual(/아직 반영되지 않았습니다/.test(view.disagreement ?? ''), true);
  });
});
