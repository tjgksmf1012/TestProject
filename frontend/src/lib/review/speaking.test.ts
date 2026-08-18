import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  inGivenOrder,
  notMeasurableText,
  SHARE_NOTE,
  shareText,
  skewText,
  type Share,
  type Speaking,
} from './speaking.ts';

function share(over: Partial<Share> = {}): Share {
  return { user_id: 1, name: '김민수', speaking_ms: 300_000, ratio: 0.5, ...over };
}

function speaking(over: Partial<Speaking> = {}): Speaking {
  return { shares: [share()], measurable: true, skewed: false, ...over };
}

describe('몫을 글자로', () => {
  it('비율과 분을 같이 말한다', () => {
    strictEqual(shareText(share({ ratio: 0.32, speaking_ms: 600_000 })), '32% · 10분');
  });

  it('⭐ 못 잰 것을 **0% 라고 쓰지 않는다**', () => {
    // `0%` 는 "한마디도 안 했다" 로 읽히는데, 실제로는 잴 것이 없었던
    // 것입니다 (결함 121 이 정확히 그것이었습니다).
    const text = shareText(share({ ratio: null, speaking_ms: 0 }));
    strictEqual(text.includes('0%'), false);
    strictEqual(text, '잴 수 없음');
  });
});

describe('⭐ 잴 수 없을 때', () => {
  it('빈 칸으로 두지 않는다', () => {
    // 아무것도 안 그리면 "고장" 이나 "다들 말을 안 했다" 로 읽힙니다.
    const why = notMeasurableText(speaking({ measurable: false }));
    strictEqual(why !== null, true);
  });

  it('짧은 회의와 분석 전을 **가려서 말한다**', () => {
    const short = notMeasurableText(
      speaking({ measurable: false, shares: [share({ speaking_ms: 30_000 })] }),
    );
    strictEqual((short as string).includes('짧아'), true);

    const notYet = notMeasurableText(
      speaking({ measurable: false, shares: [share({ speaking_ms: 0, ratio: null })] }),
    );
    strictEqual((notYet as string).includes('분석'), true);
  });

  it('잴 수 있으면 아무 말도 안 한다', () => {
    strictEqual(notMeasurableText(speaking()), null);
  });
});

describe('⭐ 편중을 말하되 나무라지 않는다', () => {
  it('쏠렸으면 사실을 적는다', () => {
    const text = skewText(speaking({ skewed: true }));
    strictEqual(text !== null, true);
    strictEqual((text as string).includes('절반 이상'), true);
  });

  it('⭐ **누가인지 안 적는다**', () => {
    // 적는 순간 "이 회의를 독점한 사람" 표시가 됩니다.
    const text = skewText(speaking({ skewed: true })) as string;
    strictEqual(text.includes('김민수'), false);
  });

  it('⭐ 나무라지 않는다', () => {
    // 회의에는 발제하는 사람이 있고, 그 사람이 많이 말하는 것은 정상입니다.
    const text = skewText(speaking({ skewed: true })) as string;
    for (const verdict of ['독점', '문제', '과도', '줄이', '주의']) {
      strictEqual(text.includes(verdict), false, verdict);
    }
  });

  it('못 잰 회의는 쏠렸다고 안 한다', () => {
    strictEqual(skewText(speaking({ measurable: false, skewed: true })), null);
  });
});

describe('⭐ 줄을 세우지 않는다', () => {
  it('서버가 준 순서 그대로', () => {
    const rows = [
      share({ user_id: 1, name: '김민수', ratio: 0.1 }),
      share({ user_id: 2, name: '이하늘', ratio: 0.9 }),
    ];
    deepStrictEqual(
      inGivenOrder(rows).map((r) => r.user_id),
      [1, 2],
    );
  });

  it('⭐ 원본을 건드리지 않는다', () => {
    const rows = [share({ user_id: 1 }), share({ user_id: 2 })];
    inGivenOrder(rows).reverse();
    deepStrictEqual(
      rows.map((r) => r.user_id),
      [1, 2],
    );
  });

  it('⭐ 기여도가 아니라고 **화면이 말한다**', () => {
    strictEqual(SHARE_NOTE.includes('기여도가 아닙니다'), true);
  });
});
