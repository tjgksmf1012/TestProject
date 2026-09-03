import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
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
      'confirmed',
    );
    strictEqual((short as string).includes('짧아'), true);

    // ⚠️ 말한 시간이 있으면 **국면과 상관없이** 「짧아서」입니다 — 그건
    //    처리가 끝났는지와 무관한 사실입니다.
    strictEqual(
      notMeasurableText(
        speaking({ measurable: false, shares: [share({ speaking_ms: 30_000 })] }),
        'queued',
      ),
      short,
    );

    const notYet = notMeasurableText(
      speaking({ measurable: false, shares: [share({ speaking_ms: 0, ratio: null })] }),
      'processing',
    );
    strictEqual((notYet as string).includes('처리'), true);
  });

  describe('⭐ 발언이 0건일 때 **국면마다 다르게 말한다** (결함 438)', () => {
    const none = speaking({ measurable: false, shares: [share({ speaking_ms: 0, ratio: null })] });
    const PHASES = ['pending', 'queued', 'processing', 'needs_review', 'confirmed', 'failed'];

    it('다섯 국면이 한 문장으로 뭉개지지 않는다', () => {
      const said = PHASES.map((st) => notMeasurableText(none, st) as string);
      for (const line of said) ok(line.trim().length > 0, '빈 줄입니다');
      // 「처리 중」과 「처리 끝」이 같은 말을 하면 안 됩니다.
      ok(
        new Set(said).size >= 4,
        `국면이 여섯인데 문장이 ${new Set(said).size}가지뿐입니다: ${JSON.stringify([...new Set(said)])}`,
      );
    });

    it('⭐ **끝난 회의에 「아직」이라고 하지 않는다** — 오지 않을 것을 기다립니다', () => {
      for (const st of ['needs_review', 'confirmed', 'failed']) {
        const line = notMeasurableText(none, st) as string;
        ok(!line.includes('아직'), `${st}: 「아직」은 「기다리면 온다」로 읽힙니다 — ${line}`);
      }
    });

    it('실패한 회의에는 **할 수 있는 일**을 말한다', () => {
      const line = notMeasurableText(none, 'failed') as string;
      ok(line.includes('다시 처리'), `로비에서 풀 수 있다는 것을 적어야 합니다 — ${line}`);
    });

    it('모르는 상태도 빈 칸으로 두지 않고, 모른다는 것을 숨기지 않는다', () => {
      const line = notMeasurableText(none, 'no-such-status') as string;
      ok(line.trim().length > 0);
      ok(line.includes('않았거나'), `양다리를 걸치되 모른다는 것을 적어야 합니다 — ${line}`);
    });
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
