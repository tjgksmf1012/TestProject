/**
 * 달력 한 달 — 칸을 어떻게 놓고 무엇을 각 칸에 담을 것인가 (정의서 §16).
 *
 * 화면(`src/demo/calendar.tsx`)에는 자동 테스트가 없습니다. 그래서 날짜
 * 계산을 전부 여기로 빼고 테스트를 붙입니다 — 달력은 **한 칸만 밀려도
 * 전부 틀린** 화면이라 눈으로는 잘 안 잡힙니다.
 *
 * ## ⚠️ 어느 날인지는 **팀 달력**이 정합니다
 *
 * 서버는 자르지 않은 순간을 보냅니다. `teamDateOf`(`Asia/Seoul`)로 자르는
 * 곳이 여기 한 곳뿐이어야 합니다 — 서버에서도 자르면 밤에 잡힌 회의가
 * 하루 어긋납니다.
 *
 * ## ⚠️ `Date` 산술을 로컬 시간으로 하지 않습니다
 *
 * `new Date(2026, 8, 1)` 은 **브라우저의 시간대**로 만들어집니다. 그러면
 * 같은 달력이 사람마다 다르게 나옵니다. 여기서는 전부 `Date.UTC` 로
 * 만들고 `YYYY-MM-DD` 글자만 주고받습니다.
 */

import { teamDateOf } from '../time/calendar.ts';

export interface CalendarItem {
  kind: string;
  /** 자르지 않은 순간. 서버가 준 그대로. */
  at: string;
  title: string;
  task_id: number | null;
  meeting_id: number | null;
  who: string | null;
  done: boolean;
}

export interface DayCell {
  /** `YYYY-MM-DD` */
  date: string;
  /** 1~31 */
  day: number;
  /** 이 달의 날인가. 앞뒤로 붙는 이웃 달 칸은 `false` */
  inMonth: boolean;
  items: CalendarItem[];
}

/** 요일 이름. ⚠️ **월요일부터**입니다 — 아래 `weekStart` 참고. */
export const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'] as const;

const YYYY_MM = /^(\d{4})-(\d{2})$/;

/** `YYYY-MM` 이 말이 되는가. 안 되면 `null`. */
export function parseMonth(raw: string): { year: number; month: number } | null {
  const hit = YYYY_MM.exec(raw);
  if (hit === null) return null;
  const year = Number(hit[1]);
  const month = Number(hit[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

/** `2026-09` → `2026년 9월`. */
export function describeMonth(year: number, month: number): string {
  return `${year}년 ${month}월`;
}

function iso(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * 이 달의 몇째 날부터 격자를 그릴 것인가 — **그 주의 월요일**.
 *
 * ⚠️ 일요일 시작이 아니라 월요일 시작입니다. 이 제품은 팀 프로젝트
 * 도구이고 주간 보고서도 월~일로 끊습니다(`reports/period.py`). 달력만
 * 일요일 시작이면 "이번 주" 가 두 뜻이 됩니다.
 */
export function weekStart(year: number, month: number): Date {
  const first = new Date(Date.UTC(year, month - 1, 1));
  // getUTCDay: 일=0 … 토=6 → 월요일까지 며칠 뒤로 갈 것인가
  const back = (first.getUTCDay() + 6) % 7;
  first.setUTCDate(first.getUTCDate() - back);
  return first;
}

/**
 * 한 달치 격자. **언제나 주 단위로 끝납니다** (35칸 또는 42칸).
 *
 * ⚠️ 마지막 주를 잘라 내면 줄 길이가 달마다 달라져서 화면이 들썩입니다.
 */
export function monthGrid(
  year: number,
  month: number,
  items: readonly CalendarItem[],
): DayCell[] {
  const byDate = new Map<string, CalendarItem[]>();
  for (const item of items) {
    const date = teamDateOf(item.at);
    if (date === null) continue; // ⚠️ 못 읽은 날짜를 오늘에 놓지 않습니다
    const bucket = byDate.get(date);
    if (bucket === undefined) byDate.set(date, [item]);
    else bucket.push(item);
  }

  const cursor = weekStart(year, month);
  const cells: DayCell[] = [];
  // 6주면 어떤 달이든 덮습니다. 5주로 끝나면 거기서 멈춥니다.
  for (let i = 0; i < 42; i++) {
    const date = iso(cursor);
    const inMonth = cursor.getUTCMonth() === month - 1;
    cells.push({
      date,
      day: cursor.getUTCDate(),
      inMonth,
      items: byDate.get(date) ?? [],
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    // 주가 끝났고 다음 칸이 이미 다음 달이면 멈춥니다.
    if (cells.length % 7 === 0 && cursor.getUTCMonth() !== month - 1) {
      const doneWithMonth = cursor.getTime() > Date.UTC(year, month - 1, 28);
      if (doneWithMonth) break;
    }
  }
  return cells;
}

/**
 * **이 달 안에** 있는 것만. 격자에 붙은 이웃 달 칸은 뺍니다.
 *
 * ⚠️ 서버에는 격자 전체(이웃 달 며칠 포함)를 물어봅니다 — 8월 31일 칸에
 * 걸린 마감이 9월 격자에도 보여야 하기 때문입니다. 그런데 아래 목록의
 * 제목은 "이 달에 있는 일" 이라, 받은 것을 그대로 늘어놓으면 **7월 말과
 * 9월 초 항목이 8월 목록에 섞입니다.** 렌더해서 보고 알았습니다.
 */
export function itemsInMonth(cells: readonly DayCell[]): CalendarItem[] {
  return cells.filter((cell) => cell.inMonth).flatMap((cell) => cell.items);
}

/** 서버에 물어볼 범위. 격자 첫 칸부터 마지막 칸까지. */
export function rangeFor(year: number, month: number): { since: string; until: string } {
  const cells = monthGrid(year, month, []);
  const first = cells[0]?.date ?? `${year}-01-01`;
  const last = cells[cells.length - 1]?.date ?? first;
  return { since: `${first}T00:00:00Z`, until: `${last}T23:59:59Z` };
}

/** 한 달 앞뒤로. */
export function shiftMonth(
  year: number,
  month: number,
  by: number,
): { year: number; month: number } {
  const at = new Date(Date.UTC(year, month - 1 + by, 1));
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1 };
}

// ══════════════════════════════════════════════════════════════
// 한 칸 안의 것
// ══════════════════════════════════════════════════════════════

/**
 * 종류를 사람 말로.
 *
 * ⚠️ **화면에 두 번째 표를 만들지 마십시오.** 서버의 `ItemKind` 와 여기가
 * 짝입니다. 모르는 종류는 그대로 돌려줍니다 — 지어내면 틀린 말이 됩니다.
 */
const KIND_LABEL: Record<string, string> = {
  task_start: '시작',
  task_due: '마감',
  meeting_planned: '예정된 회의',
  meeting_held: '연 회의',
  project_due: '프로젝트 마감',
};

export function describeKind(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

/**
 * 이 항목이 며칠인가 — `12일`. 못 읽으면 빈 글자.
 *
 * ⚠️ **목록에 날짜가 없으면 한 달치가 그냥 줄 나열이 됩니다.** 격자에서
 * 눈으로 센 다음 아래 목록에서 다시 찾아야 합니다 — 렌더해서 보고
 * 알았습니다. `--:--` 같은 가짜 값은 만들지 않습니다.
 */
export function dayOf(item: CalendarItem): string {
  const date = teamDateOf(item.at);
  return date === null ? '' : `${Number(date.slice(8, 10))}일`;
}

/**
 * 이 항목을 눌렀을 때 갈 곳. 갈 데가 없으면 `null`.
 *
 * ⚠️ **누를 수 없는 것을 버튼으로 그리지 않으려고** `null` 을 돌려줍니다.
 * 프로젝트 마감일은 갈 곳이 없습니다.
 */
export function hrefFor(item: CalendarItem, projectId: number): string | null {
  if (item.meeting_id !== null) return `/lobby.html?meeting=${item.meeting_id}&project=${projectId}`;
  if (item.task_id !== null) return `/kanban.html?project=${projectId}`;
  return null;
}

/**
 * 늦은 것인가 — **끝나지 않았고** 날짜가 지났는가.
 *
 * ⚠️ 끝난 일은 마감일이 지났어도 늦은 것이 아닙니다. 끝냈는데 빨갛게
 * 남으면 사람은 아직 할 일이 있다고 읽습니다.
 *
 * ⚠️ 시작일에는 붙이지 않습니다. 시작일이 지난 것은 정상입니다.
 */
export function isOverdue(item: CalendarItem, today: string): boolean {
  if (item.done) return false;
  if (item.kind !== 'task_due' && item.kind !== 'project_due') return false;
  const date = teamDateOf(item.at);
  return date !== null && date < today;
}

/**
 * 이 날 칸을 낭독기에 뭐라고 읽어 줄 것인가.
 *
 * ⚠️ 칸 안의 점·색은 **눈으로만 읽히는 표시**입니다. 그것뿐이면 낭독기
 * 사용자에게는 숫자만 남습니다.
 */
export function dayAriaLabel(cell: DayCell): string {
  if (cell.items.length === 0) return `${cell.day}일`;
  return `${cell.day}일, ${cell.items.length}건 — ${cell.items
    .map((item) => `${describeKind(item.kind)} ${item.title}`)
    .join(', ')}`;
}
