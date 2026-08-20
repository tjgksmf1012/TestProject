import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type Draft } from './candidates.ts';
import {
  draftStorageKey,
  isBlankDraft,
  parseDrafts,
  serializeDrafts,
} from './drafts.ts';

const LIVE = [1, 2, 3];

describe('검토 초안 보관 (결함 217)', () => {
  it('⭐ 정한 것이 오간다 — 이게 전부다', () => {
    const drafts = new Map<number, Draft>([
      [1, { decision: 'approve', assigneeOverride: 2, deadlineOverride: '2026-09-30' }],
      [2, { decision: 'reject', note: '중복' }],
    ]);
    const back = parseDrafts(serializeDrafts(drafts), LIVE);
    deepStrictEqual(back.get(1), {
      decision: 'approve',
      assigneeOverride: 2,
      deadlineOverride: '2026-09-30',
    });
    deepStrictEqual(back.get(2), { decision: 'reject', note: '중복' });
  });

  it('⭐ 아무것도 안 정한 것은 저장하지 않는다', () => {
    // 후보를 훑기만 해도 빈 초안이 생깁니다. 그게 쌓이면 저장소만 커집니다.
    strictEqual(isBlankDraft({ decision: 'pending' }), true);
    strictEqual(serializeDrafts(new Map([[1, { decision: 'pending' } as Draft]])), '{}');
  });

  it('⚠️ 「미지정으로 되돌림」 은 빈 것이 아니다 — 사람이 **정한** 것이다', () => {
    // `assigneeOverride: null` 은 "AI 가 고른 담당자를 지웠다" 입니다.
    // 이걸 빈 초안으로 보면 되살릴 때 AI 값이 다시 살아납니다.
    strictEqual(isBlankDraft({ decision: 'pending', assigneeOverride: null }), false);
    const back = parseDrafts(
      serializeDrafts(new Map([[1, { decision: 'pending', assigneeOverride: null } as Draft]])),
      LIVE,
    );
    strictEqual(back.get(1)?.assigneeOverride, null);
  });

  it('⭐ **지금 있는 후보**에만 되살린다 — 그 사이에 처리된 것은 뜻이 없다', () => {
    const raw = JSON.stringify({ '1': { decision: 'approve' }, '99': { decision: 'approve' } });
    const back = parseDrafts(raw, LIVE);
    strictEqual(back.has(1), true);
    strictEqual(back.has(99), false, '없는 후보의 초안이 되살아났습니다');
  });

  it('⚠️ 모양이 이상한 것은 **버린다** — 개발자 도구로 무엇이든 넣을 수 있다', () => {
    strictEqual(parseDrafts('그냥 글자', LIVE).size, 0);
    strictEqual(parseDrafts('[1,2,3]', LIVE).size, 0);
    strictEqual(parseDrafts(null, LIVE).size, 0);
    strictEqual(parseDrafts('', LIVE).size, 0);
    // 모르는 판정은 통째로 버립니다.
    strictEqual(parseDrafts(JSON.stringify({ '1': { decision: '승인함' } }), LIVE).size, 0);
    // 판정이 맞으면 살리되, 이상한 칸만 뺍니다.
    const mixed = parseDrafts(
      JSON.stringify({ '1': { decision: 'approve', assigneeOverride: '이하늘', note: 7 } }),
      LIVE,
    );
    deepStrictEqual(mixed.get(1), { decision: 'approve' });
  });

  it('⛔ 서버가 받는 모양이 아닌 마감일은 되살리지 않는다', () => {
    // 아무 글자나 되살리면 확정할 때 400 이 나고, 사람은 **자기가 안 적은
    // 값** 때문에 막힙니다.
    for (const bad of ['9월 30일', '2026/09/30', '2026-9-3', 'null']) {
      const back = parseDrafts(JSON.stringify({ '1': { decision: 'approve', deadlineOverride: bad } }), LIVE);
      strictEqual(back.get(1)?.deadlineOverride, undefined, `${bad} 이 되살아났습니다`);
    }
    const good = parseDrafts(
      JSON.stringify({ '1': { decision: 'approve', deadlineOverride: '2026-09-30' } }),
      LIVE,
    );
    strictEqual(good.get(1)?.deadlineOverride, '2026-09-30');
  });

  it('⚠️ 회의마다 자리가 다르다 — 한 칸에 몰면 남의 후보 id 와 섞인다', () => {
    strictEqual(draftStorageKey(1) === draftStorageKey(2), false);
    strictEqual(draftStorageKey(7).includes('7'), true);
  });
});
