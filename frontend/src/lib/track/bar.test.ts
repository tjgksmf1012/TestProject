/**
 * 트랙 막대가 **모르는 것을 아는 척하지 않는가.**
 *
 * 이 파일이 고정하는 것: **커버리지 막대가 위치를 지어내지 않는다.**
 * 서버가 주는 것은 `coverage` 와 `total_gap_ms` —
 * 총량뿐입니다. 이걸 시간축처럼 그리면 사람은 "12분쯤에 끊겼구나"
 * 라고 읽는데, 우리는 그걸 모릅니다. 기여도를 다루는 화면에서 위치를
 * 지어내면 그 화면의 모든 숫자가 같이 의심받습니다.
 */

import { strictEqual, deepStrictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { coverageBar, describeCoverage } from './bar.ts';

describe('커버리지 막대 — 양만 뜻을 가진다', () => {
  it('채운 칸과 구멍이 이어 붙는다 (누적 막대)', () => {
    const bars = coverageBar(0.42);
    deepStrictEqual(
      bars.map((b) => [b.kind, Math.round(b.left), Math.round(b.width)]),
      [
        ['talk', 0, 42],
        ['gap', 42, 58],
      ],
    );
  });

  it('⭐ 위치를 지어내지 않는다 — 구멍은 언제나 채운 칸 **뒤**', () => {
    // 서버가 주는 것은 총량뿐입니다. 구멍을 중간 어딘가에 놓으면
    // 사람은 그 시각에 끊긴 줄 압니다. 우리는 모릅니다.
    for (const cov of [0.1, 0.42, 0.8, 0.99]) {
      const bars = coverageBar(cov);
      const talk = bars.find((b) => b.kind === 'talk');
      const gap = bars.find((b) => b.kind === 'gap');
      strictEqual(talk?.left, 0, `coverage ${cov}: 채운 칸은 항상 왼쪽 끝`);
      strictEqual(gap?.left, talk?.width, `coverage ${cov}: 구멍은 바로 뒤`);
    }
  });

  it('⭐ 모르는 것은 그리지 않는다 — 0% 로 그리면 "아무것도 안 함" 이 된다', () => {
    deepStrictEqual(coverageBar(null), []);
    deepStrictEqual(coverageBar(undefined), []);
    deepStrictEqual(coverageBar(Number.NaN), []);
  });

  it('완전한 녹음에는 구멍 칸이 없다', () => {
    const bars = coverageBar(1);
    strictEqual(bars.length, 1);
    strictEqual(bars[0]?.kind, 'talk');
  });

  it('0% 는 구멍만 — 모름과 다르다', () => {
    const bars = coverageBar(0);
    strictEqual(bars.length, 1);
    strictEqual(bars[0]?.kind, 'gap');
  });
});

describe('커버리지 문구', () => {
  it('커버리지를 사람의 말로 — 모름과 0% 를 구분한다', () => {
    strictEqual(describeCoverage(null), '아직 모릅니다');
    strictEqual(describeCoverage(0), '녹음 0%');
    strictEqual(describeCoverage(0.42), '녹음 42%');
  });
});
