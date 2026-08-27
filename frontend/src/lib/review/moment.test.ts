import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evidenceMomentText, momentText } from './moment.ts';

describe('회의 시작 후 몇 분 몇 초인가 (결함 353)', () => {
  it('⭐ 발화의 `0` 은 **시각입니다** — 「회의 시작과 동시에」', () => {
    /* 재현: 8분 회의의 첫 발화(0:00)가 두 뿌리 다 **빈칸**이었습니다.
       빈칸은 「모른다」로 읽히는데, 그 시각은 정확히 압니다.
       ⚠️ 실기가 그 값을 만듭니다 — `to_segments` 의 `start * hop_ms` 는
       녹음 시작과 동시에 말하면 정확히 0 입니다. */
    strictEqual(momentText(0), '0:00');
  });

  it('발화 시각을 mm:ss 로', () => {
    strictEqual(momentText(750_000), '12:30');
    strictEqual(momentText(65_000), '1:05');
    strictEqual(momentText(59_000), '0:59');
    strictEqual(momentText(3_600_000), '60:00');
  });

  it('⛔ 발화에 「모르는 시각」은 없다 — 음수·비정상만 null', () => {
    strictEqual(momentText(-1), null);
    strictEqual(momentText(Number.NaN), null);
    strictEqual(momentText(Number.POSITIVE_INFINITY), null);
  });

  it('⭐ 근거 구간의 `0` 은 **「근거가 없다」** — 시각을 지어내지 않는다', () => {
    /* 사건·미해결 사안은 근거 발화가 없으면 서버가 `0~0` 을 보냅니다.
       `0:00` 이라고 적으면 회의 맨 처음에 있었던 일처럼 읽힙니다 —
       근거를 적어 내린 결정이라 이쪽은 그대로 둡니다. */
    strictEqual(evidenceMomentText(0), null);
    strictEqual(evidenceMomentText(-1), null);
    strictEqual(evidenceMomentText(Number.NaN), null);
  });

  it('⚠️ 두 자가 **다른 답**을 내는 자리가 정확히 `0` 이다', () => {
    // 여기서 갈리지 않으면 이름을 가른 뜻이 없습니다.
    strictEqual(momentText(0) === evidenceMomentText(0), false);
    for (const ms of [1, 1_000, 65_000, 750_000]) {
      strictEqual(momentText(ms), evidenceMomentText(ms), String(ms));
    }
  });
});
