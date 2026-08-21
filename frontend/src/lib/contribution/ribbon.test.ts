import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert/strict';

import {
  confidenceRibbon,
  describeTeamRibbon,
  ribbonReading,
  sharedConfidence,
} from './ribbon.ts';
import type { RibbonPiece } from './ribbon.ts';

/* 리본이 **가득 찼는가** — 이 검사만 쓰는 자라 여기 둡니다.
   `lib/` 로 올리면 "만들어 놓고 아무도 안 부르는 것"(실패 ①) 이 됩니다. */
function ribbonIsFull(pieces: readonly RibbonPiece[]): boolean {
  if (pieces.length === 0) return false;
  const covered = pieces.reduce((sum, p) => sum + Math.max(0, p.end - p.start), 0);
  return Math.abs(covered - 1) < 1e-9;
}

describe('기여도 리본은 **순위를 안 그린다** (결함 247)', () => {
  it('⭐ 확신도가 무엇이든 리본은 **가득 찬다** — 길이가 같아야 견줄 것이 없다', () => {
    // 예전에는 리본 길이가 `확신도 + 기여도 폭` 이라 사람마다 달랐고,
    // 세 줄이 같은 축에 서서 막대그래프가 됐습니다.
    for (const c of [0, 0.1, 0.446, 0.5, 0.9, 1]) {
      ok(ribbonIsFull(confidenceRibbon(c)), `확신도 ${c} 에서 안 가득 찹니다`);
    }
  });

  it('나뉘는 자리만 다르다 — 왼쪽은 확신, 오른쪽은 모름', () => {
    deepStrictEqual(confidenceRibbon(0.45), [
      { start: 0, end: 0.45, kind: 'known' },
      { start: 0.45, end: 1, kind: 'unknown' },
    ]);
  });

  it('⛔ 아무것도 모르면 **통째로 빗금** — 0점이 아니라 모르는 것', () => {
    deepStrictEqual(confidenceRibbon(0), [{ start: 0, end: 1, kind: 'unknown' }]);
    ok(ribbonIsFull(confidenceRibbon(0)));
  });

  it('다 알면 빗금이 없다', () => {
    deepStrictEqual(confidenceRibbon(1), [{ start: 0, end: 1, kind: 'known' }]);
  });

  it('이상한 값도 **지어내지 않고** 0~1 로 접는다', () => {
    ok(ribbonIsFull(confidenceRibbon(Number.NaN)));
    ok(ribbonIsFull(confidenceRibbon(-3)));
    ok(ribbonIsFull(confidenceRibbon(9)));
    deepStrictEqual(confidenceRibbon(Number.NaN), [{ start: 0, end: 1, kind: 'unknown' }]);
  });

  it('⭐ 낭독기가 듣는 것과 **그림이 말하는 것**이 같다', () => {
    // 예전 aria-label 은 「확신도 45% · 모르는 폭 14%p」 였습니다 — 그림은
    // 확신도 축인데 라벨은 %p 를 말해 눈과 귀가 다른 축을 봤습니다.
    const said = describeTeamRibbon(0.45);
    strictEqual(said.includes('45%'), true, said);
    strictEqual(said.includes('55%'), true, said);
    strictEqual(said.includes('%p'), false, said);
  });

  it('⭐ 문구의 임자는 **팀**이다 — 사람 이름을 안 부른다 (결함 248)', () => {
    // 「김민수 — 확신한 몫 45%」 는 「이 사람은 45%만 파악됐다」로 읽힙니다.
    // 실제로는 팀당 한 번 계산되는 값이라 세 사람이 전부 같은 45% 였습니다.
    strictEqual(describeTeamRibbon(0.446).startsWith('팀 전체'), true);
  });

  it('아무것도 모를 때는 **그렇게 말한다**', () => {
    strictEqual(describeTeamRibbon(0).includes('확인하지 못했습니다'), true);
  });

  it('⭐ 값이 갈라지면 **팀 것이라고 안 한다** (결함 248)', () => {
    strictEqual(sharedConfidence([0.446, 0.446]), 0.446);
    strictEqual(sharedConfidence([0.446, 0.45]), null);
    strictEqual(sharedConfidence([]), null);
    // 0~1 밖은 접습니다 — 리본은 그 밖을 그릴 수 없습니다.
    strictEqual(sharedConfidence([1.4, 1.4]), 1);
  });

  it('옆에 서는 글자가 **그림과 같은 값**을 말한다', () => {
    strictEqual(ribbonReading(0.446), '확신 45% · 모름 55%');
    strictEqual(ribbonReading(0), '확신 0% · 모름 100%');
  });

  it('⛔ 두 조각의 뜻이 겹치지 않는다 — 빈 곳(`empty`)은 안 쓴다', () => {
    // `empty` 를 쓰면 「측정했는데 0」 과 「아직 모름」 이 한 리본에 섞입니다.
    for (const c of [0, 0.3, 1]) {
      ok(confidenceRibbon(c).every((p) => p.kind !== 'empty'), `확신도 ${c}`);
    }
  });
});
