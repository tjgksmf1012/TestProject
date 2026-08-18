import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  allQuiet,
  notMeasurableText,
  QUIET_TEXT,
  TRENDS_NOTE,
  trendLine,
  type KindTrend,
} from './trends.ts';

function trend(over: Partial<KindTrend> = {}): KindTrend {
  return { kind: 'repeated_discussion', early_avg: 2, late_avg: 0, direction: 'falling', ...over };
}

describe('회의 개선 추세 (REVIEW-006)', () => {
  it('⭐ 관찰이지 판정이 아니다 — 좋다/나쁘다가 문장에 없다', () => {
    for (const direction of ['falling', 'rising', 'flat']) {
      const line = trendLine(trend({ direction }));
      assert.doesNotMatch(line, /좋|나쁘|나빠|개선|악화/, line);
    }
  });

  it('줄고·늘고·비슷을 사람 말로 적는다', () => {
    assert.equal(
      trendLine(trend()),
      '반복 논의 — 회의당 2건 → 0건, 줄고 있습니다',
    );
    assert.match(trendLine(trend({ direction: 'rising' })), /늘고 있습니다/);
    assert.match(trendLine(trend({ direction: 'flat' })), /비슷합니다/);
  });

  it('소수 평균은 한 자리로 적는다', () => {
    assert.match(trendLine(trend({ early_avg: 1.5, late_avg: 0.5 })), /1\.5건 → 0\.5건/);
  });

  it('검토 화면에 없는 미응답 질문도 이름이 있다', () => {
    // findings.ts 의 표에는 일부러 없는 값 — 코드가 그대로 나오면 안 된다.
    assert.match(trendLine(trend({ kind: 'unanswered_question' })), /^미응답 질문 —/);
  });

  it('모르는 방향은 지어내지 않고 코드 그대로 보인다', () => {
    assert.match(trendLine(trend({ direction: 'sideways' })), /sideways$/);
  });

  it('못 재면 몇 개가 더 필요한지까지 말한다 — 침묵은 고장으로 읽힌다', () => {
    const text = notMeasurableText({ measurable: false, meetings_counted: 2, needed: 3, kinds: [] });
    assert.match(text, /2개/);
    assert.match(text, /3개/);
  });

  it('전부 0 이면 다섯 줄의 0 대신 한 줄로 말한다', () => {
    assert.equal(allQuiet([trend({ early_avg: 0, late_avg: 0 })]), true);
    assert.equal(allQuiet([trend()]), false);
    assert.match(QUIET_TEXT, /없었습니다/);
  });

  it('회의를 짚지 않는다는 것을 화면이 말한다', () => {
    assert.match(TRENDS_NOTE, /어느 회의였는지는 일부러 싣지 않습니다/);
  });
});
