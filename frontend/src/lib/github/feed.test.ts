import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeEmptyFeed,
  feedFilters,
  filterFeed,
  whyNoCommits,
  type FeedItem,
  type KindCount,
} from './feed.ts';

const COUNTS: KindCount[] = [
  { kind: 'pull_request.merged', label: 'PR 병합', count: 1 },
  { kind: 'pull_request.review', label: 'PR 리뷰', count: 0 },
  { kind: 'issues.closed', label: '이슈 닫힘', count: 5 },
];

const item = (id: number, kind: string): FeedItem => ({
  id,
  kind,
  label: kind,
  who: '김민수',
  repo: 'team/demo',
  ref: null,
  occurred_at: '2026-09-01T12:00:00+00:00',
});

describe('고르개 목록', () => {
  it('맨 앞은 전부이고 합계를 든다', () => {
    const filters = feedFilters(COUNTS);
    assert.equal(filters[0]?.kind, null);
    assert.equal(filters[0]?.count, 6);
  });

  it('⭐ 서버가 준 순서를 바꾸지 않는다 — 건수 순이 아니다', () => {
    // ⚠️ 두 기준이 갈라지는 데이터입니다(결함 163) — 건수 순이라면
    //    이슈 닫힘(5)이 PR 병합(1)보다 앞에 와야 합니다.
    const kinds = feedFilters(COUNTS).map((f) => f.kind);
    assert.deepEqual(kinds, [null, 'pull_request.merged', 'pull_request.review', 'issues.closed']);
  });

  it('⭐ 0건인 종류를 숨기지 않는다', () => {
    const zero = feedFilters(COUNTS).find((f) => f.kind === 'pull_request.review');
    assert.ok(zero, '0건이라고 고르개에서 빠졌습니다');
    assert.equal(zero.count, 0);
  });
});

describe('갈래 거르기', () => {
  const items = [item(3, 'issues.closed'), item(2, 'pull_request.merged'), item(1, 'issues.closed')];

  it('null 은 전부, 순서 그대로', () => {
    assert.deepEqual(
      filterFeed(items, null).map((i) => i.id),
      [3, 2, 1],
    );
  });

  it('고른 갈래만, 순서 그대로', () => {
    assert.deepEqual(
      filterFeed(items, 'issues.closed').map((i) => i.id),
      [3, 1],
    );
  });
});

describe('사람에게 하는 말', () => {
  it('⭐ 커밋이 없는 이유를 말한다 — 없는 척하지 않는다', () => {
    const text = whyNoCommits();
    assert.ok(text.includes('일부러'));
    assert.ok(text.includes('병합된 PR'));
  });

  it('⭐ 빈 목록은 다음에 갈 자리를 같이 준다', () => {
    // 알려만 주고 갈 곳을 안 주면 대표 실패 ③ 입니다.
    const { why, how } = describeEmptyFeed();
    assert.ok(why.length > 0);
    assert.ok(how.includes('연결 진단'), '어디서 확인하는지가 없습니다');
  });

  it('폰 이야기를 하지 않는다', () => {
    for (const text of [whyNoCommits(), describeEmptyFeed().why, describeEmptyFeed().how]) {
      for (const word of ['폰', '홈 화면', '모바일']) {
        assert.ok(!text.includes(word), `"${word}" 가 들어 있습니다: ${text}`);
      }
    }
  });
});
