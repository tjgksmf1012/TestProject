/**
 * 검색 화면이 쓰는 판단 (정의서 §20).
 *
 * ## ⚠️ 여기서 **사람을 세지 않습니다**
 *
 * 검색은 "무엇이 있나" 를 찾는 곳이지 "누가 얼마나" 를 세는 곳이
 * 아닙니다. 결과에 사람 이름이 붙지만(누가 한 말인지 알아야 하니까),
 * **사람별 건수를 집계하는 함수가 여기 없습니다.** 그런 것이 생기면
 * 그 순간 "검색 결과 기준 발언 순위" 가 만들어집니다
 * (`AGENTS.md` 불변식 1).
 */

export interface Hit {
  kind: string;
  task_id: number | null;
  meeting_id: number | null;
  title: string;
  /** ⚠️ **자르지 않은 대목**입니다. 자르는 것은 아래 `excerpt` 가 합니다. */
  body: string;
  at: string | null;
  who: string | null;
  status: string | null;
}

/** 종류 → 한 단어. ⚠️ 모르는 종류는 지어내지 않습니다. */
const KIND_LABEL: Record<string, string> = {
  task: '업무',
  meeting: '회의',
  utterance: '회의 내용',
  github: 'GitHub',
};

export function describeKind(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

/** 화면이 고를 수 있는 종류. ⚠️ 서버의 `Kind` 와 짝입니다. */
export const KINDS = ['task', 'meeting', 'utterance', 'github'] as const;

/**
 * 찾은 낱말이 보이도록 **가운데를 잘라** 온다.
 *
 * ⚠️ 앞에서부터 자르면 찾은 낱말이 잘려 나간 뒤에 있을 수 있습니다 —
 * 그러면 왜 이게 걸렸는지 알 수 없는 결과 줄이 됩니다. 서버가 자르지
 * 않고 통째로 보내는 이유가 이것입니다.
 */
export function excerpt(body: string, query: string, span = 80): string {
  if (body.length <= span) return body;

  const needle = query.trim();
  const at = needle === '' ? -1 : body.toLowerCase().indexOf(needle.toLowerCase());
  if (at === -1) return `${body.slice(0, span)}…`;

  const from = Math.max(0, at - Math.floor((span - needle.length) / 2));
  const to = Math.min(body.length, from + span);
  return `${from > 0 ? '…' : ''}${body.slice(from, to)}${to < body.length ? '…' : ''}`;
}

/**
 * 눌러서 갈 곳. 갈 데가 없으면 `null`.
 *
 * ⚠️ GitHub 결과는 **갈 곳이 없습니다** — 이 저장소는 실제 GitHub 에
 * 붙어 본 적이 없어서(`docs/20`) 만들 수 있는 주소가 추측일 뿐입니다.
 * 추측 주소를 링크로 걸면 눌렀을 때 404 가 나고, 사람은 자료가 잘못된
 * 줄 압니다.
 */
export function hrefFor(hit: Hit, projectId: number): string | null {
  if (hit.kind === 'utterance' && hit.meeting_id !== null) {
    return `/review.html?meeting=${hit.meeting_id}`;
  }
  if (hit.meeting_id !== null) {
    return `/lobby.html?meeting=${hit.meeting_id}&project=${projectId}`;
  }
  if (hit.task_id !== null) return `/kanban.html?project=${projectId}`;
  return null;
}

/** 지금 조건으로 찾을 수 있는가. */
/**
 * 찾을 수 있는가.
 *
 * ⚠️ `filters` 가 `null` 이면 **그 화면에는 거를 칸이 없다**는 뜻입니다
 * (채팅의 대화 찾기). 없는 칸을 있는 것처럼 세면 「담당자·상태를
 * 고르세요」라고 말해 놓고 그 칸이 화면에 없습니다(결함 313 의 모양).
 */
export function canSearch(
  query: string,
  filters: { assignee: string; status: string } | null,
): boolean {
  if (query.trim().length >= 2) return true;
  return filters !== null && (filters.assignee !== '' || filters.status !== '');
}

/**
 * 못 찾는 이유. 찾을 수 있으면 `null`.
 *
 * ⚠️ 버튼만 흐려 두면 사람은 **왜 안 되는지** 모른 채 계속 누릅니다.
 */
export function blockedReason(
  query: string,
  filters: { assignee: string; status: string } | null,
): string | null {
  if (canSearch(query, filters)) return null;
  /* ⚠️ **빈 칸일 때는 `null` 입니다** — 그때는 placeholder(「두 글자 이상」)
     가 이미 말하고 있고, 열자마자 빨간 줄이 서 있으면 잔소리입니다.
     문제는 **한 글자를 적은 순간**입니다: placeholder 가 사라지는데 단추는
     그대로 막혀 있어, 화면 어디에도 이유가 없습니다(결함 375). */
  if (query.trim().length === 1) {
    return filters === null
      ? '두 글자 이상 적어 주세요.'
      : /* ⚠️ 「업무」를 붙입니다 — 그 둘은 **업무 검색의 조건**입니다
           (결함 390). 안 붙이면 「담당자로 전부 거를 수 있다」로 읽힙니다. */
        '두 글자 이상 적거나, 업무 담당자·상태를 고르세요.';
  }
  return null;
}

/**
 * 거르는 칸이 **어디까지 걸렸는지** 한 줄. 다 걸렸으면 `null`.
 *
 * ## ⚠️ 왜 필요한가 (결함 390)
 *
 * 「담당자」·「업무 상태」는 서버에서 **업무 검색의 조건**입니다
 * (`search_tasks` — SEARCH-002). 회의·회의 내용·GitHub 은 낱말만 봅니다.
 * 그런데 화면은 그 말을 어디에도 안 했습니다.
 *
 * 담당자를 **김민수**로 고르고 「스키마」를 찾으면 이렇게 나왔습니다 —
 *
 *     담당자 [김민수]
 *     회의       1   DB 스키마 확정 논의
 *     회의 내용   1   1주차 정기회의   **박지원**
 *
 * 고른 사람과 **다른 사람의 이름**이 결과에 붙습니다. 사람의 기여를 다루는
 * 제품에서 제일 나쁜 모양입니다.
 *
 * ⚠️ **상수로 박지 않습니다** — 안 걸린 묶음이 실제로 화면에 있을 때만
 * 말합니다(결함 294 의 「화면이 이미 쥐고 있는 것으로 정할 수 있습니다」).
 * 업무만 나왔으면 할 말이 없습니다.
 *
 * ⚠️ **조사를 이름 뒤에 붙이지 않습니다** — 「회의」는 받침이 없고
 * 「회의 내용」은 있습니다. `에는` 은 둘 다 맞습니다 (결함 88).
 */
export function filterScopeNote(
  filters: { assignee: string; status: string } | null,
  groups: readonly { kind: string }[],
): string | null {
  if (filters === null) return null;
  if (filters.assignee === '' && filters.status === '') return null;
  const untouched = groups.map((group) => group.kind).filter((kind) => kind !== 'task');
  if (untouched.length === 0) return null;
  return `담당자·상태는 업무에만 걸립니다 — ${untouched
    .map(describeKind)
    .join('·')}에는 안 걸렸습니다.`;
}

/** 종류별로 나눈다. ⚠️ **순서는 `KINDS` 고정**입니다 — 건수 순이 아닙니다. */
export function groupByKind(hits: readonly Hit[]): { kind: string; hits: Hit[] }[] {
  return KINDS.map((kind) => ({
    kind: kind as string,
    hits: hits.filter((h) => h.kind === kind),
  })).filter((g) => g.hits.length > 0);
}
