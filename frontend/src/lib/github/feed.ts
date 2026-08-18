/**
 * GitHub 활동 갈래의 판단 (요구사항 정의서 §17 GITHUB-003~005 · 008).
 *
 * 화면(`demo/activity.tsx`)은 그리기만 하고, 무엇을 어떤 순서로 보여 줄지는
 * 여기서 정합니다 — 화면 코드에는 자동 테스트가 없습니다.
 *
 * ## ⚠️ 서버가 준 순서를 **바꾸지 않습니다**
 *
 * 집계(`counts`)는 서버가 어휘 선언 순으로 줍니다. 여기서 건수로 다시
 * 정렬하면 그 순간 순위표가 됩니다 — 서버·화면 어느 한쪽이라도 정렬하면
 * 다른 쪽의 결정이 무의미해지므로, 양쪽 다 "받은 순서 그대로" 입니다.
 */

export interface FeedItem {
  id: number;
  kind: string;
  label: string;
  who: string;
  repo: string;
  ref: string | null;
  occurred_at: string;
}

export interface KindCount {
  kind: string;
  label: string;
  count: number;
}

/** 갈래 고르개 하나. `kind === null` 은 "전부". */
export interface FeedFilter {
  kind: string | null;
  label: string;
  count: number;
}

/**
 * 고르개 목록. 맨 앞은 언제나 "전부" 이고, 나머지는 **서버가 준 순서
 * 그대로**입니다.
 *
 * ⚠️ 0건인 종류도 남깁니다 — 누르면 빈 목록이 나오는 것이 "그 종류는
 * 없다" 를 배우는 방법입니다. 숨기면 그 종류가 세어지는지조차 모릅니다.
 */
export function feedFilters(counts: readonly KindCount[]): FeedFilter[] {
  const total = counts.reduce((n, c) => n + c.count, 0);
  return [
    { kind: null, label: '전부', count: total },
    ...counts.map((c) => ({ kind: c.kind, label: c.label, count: c.count })),
  ];
}

/** 고른 갈래만. `null` 이면 전부 — 순서는 받은 그대로입니다. */
export function filterFeed(items: readonly FeedItem[], kind: string | null): FeedItem[] {
  if (kind === null) return [...items];
  return items.filter((item) => item.kind === kind);
}

/**
 * 커밋 목록이 없는 이유. 화면이 이 한 줄을 **반드시** 보여 줍니다.
 *
 * 말없이 없으면 사람은 "커밋은 아직 안 만들었나 보다" 로 읽고, 그건
 * 틀린 결론입니다 — 일부러 안 셉니다 (`docs/05` §2.1).
 */
export function whyNoCommits(): string {
  return (
    '커밋 목록은 일부러 없습니다 — 커밋은 쪼개기 쉬워 세지 않고, ' +
    '코드 기여는 병합된 PR 단위로만 봅니다.'
  );
}

/**
 * 빈 목록일 때 하는 말. **다음에 할 일이 있는 자리**를 같이 알려 줍니다 —
 * 알려만 주고 갈 곳을 안 주면 대표 실패 ③ 입니다.
 */
export function describeEmptyFeed(): { why: string; how: string } {
  return {
    why: '저장소가 안 이어졌거나, 이어진 뒤 병합·리뷰·이슈 닫힘이 아직 없습니다.',
    how: '프로젝트 설정의 GitHub 연결 진단에서 배달이 오는지 확인할 수 있습니다.',
  };
}
