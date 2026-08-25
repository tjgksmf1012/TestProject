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
 * 도구이고 주간 보고서도 월~일로 끊습니다(`teamflow/clock.py` 의
 * `team_week`). 달력만 일요일 시작이면 "이번 주" 가 두 뜻이 됩니다.
 *
 * ⚠️ 이 줄은 한동안 **사실이 아니었습니다** — `reports/period.py` 를
 * 가리키고 있었는데 그 파일은 받은 기간을 찍기만 하고, 실제로는 화면이
 * 「지난 7일」을 만들어 보내고 있었습니다(결함 296). 문서에 적힌 것을
 * 그대로 믿지 말고 세어 보라는 것이 이 저장소의 규칙입니다.
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

// ══════════════════════════════════════════════════════════════
// 비어 있을 때 할 말
// ══════════════════════════════════════════════════════════════

/**
 * 비어 있는 자리에 적을 세 줄.
 *
 * ⛔ **격자에 뱃지가 보이는데 「없습니다 · 만드세요」 라고 시키면 안 됩니다.**
 * 8월을 열면 격자 끝 줄에 9월 초 나흘이 붙어 보이고, 씨앗 프로젝트에서는
 * 거기에 회의 넷과 마감 하나가 뱃지로 떠 있었습니다. 그런데 바로 아래
 * 목록은 「이 달에는 잡힌 일이 없습니다 — 일정은 자동으로 생기지 않습니다.
 * 칸반에서 업무에 마감일을 주세요」 라고 **없다고 단언하고 이미 있는 것을
 * 만들라고 시켰습니다**(결함 294). 한 화면이 서로 반대되는 말을 합니다.
 *
 * 「이 달에는 없다」 자체는 참입니다 — 거짓말은 **이유와 다음 할 일**
 * 쪽입니다. 그래서 그 두 줄만 격자가 아는 것으로 바꿉니다.
 */
export interface EmptyNote {
  what: string;
  why: string;
  how: string;
}

/** `2026-09-01` → `9월 1일`. 못 읽으면 원문 그대로. */
export function describeDate(date: string): string {
  const hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (hit === null) return date;
  return `${Number(hit[2])}월 ${Number(hit[3])}일`;
}

function dayNumber(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
}

/**
 * 격자에서 일이 있는 칸 중 기준 날짜에 **가장 가까운** 것. 없으면 `null`.
 *
 * ⚠️ 같은 거리면 **앞날**을 고릅니다. 지나간 것을 가리키면 "가서 보라" 는
 * 말이 쓸모없어집니다.
 */
export function nearestDayWithItems(cells: readonly DayCell[], from: string): DayCell | null {
  const base = dayNumber(from);
  let best: DayCell | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  let bestAhead = false;
  for (const cell of cells) {
    if (cell.items.length === 0) continue;
    const delta = dayNumber(cell.date) - base;
    const gap = Math.abs(delta);
    const ahead = delta >= 0;
    if (gap < bestGap || (gap === bestGap && ahead && !bestAhead)) {
      best = cell;
      bestGap = gap;
      bestAhead = ahead;
    }
  }
  return best;
}

/**
 * 이 격자에서 「비었습니다」 라고 말할 때 함께 할 말.
 *
 * `picked` 가 `null` 이면 달 전체가, 아니면 고른 날 하나가 빈 것입니다.
 */
export function emptyNote(cells: readonly DayCell[], picked: DayCell | null): EmptyNote {
  const what = picked === null ? '이 달에는 잡힌 일이 없습니다' : '이 날에는 잡힌 일이 없습니다';
  const from = picked?.date ?? cells.find((cell) => cell.inMonth)?.date ?? cells[0]?.date ?? '';
  const near = from === '' ? null : nearestDayWithItems(cells, from);

  // 격자가 통째로 비었을 때만 "만드세요" 가 참입니다.
  //
  // ⚠️ 예전에는 `how` 가 「아래에서 회의 일정을 잡거나, **칸반에서 업무에
  // 마감일을 주세요**」 였습니다 (결함 389). 칸반에는 마감일을 주는 자리가
  // 없습니다 — 업무 PATCH 에 `deadline` 을 싣는 화면이 **두 뿌리 다 0곳**
  // 이고, 마감일은 후보를 승인할 때 한 번 정해집니다. 결함 386 이 바로 위
  // 머리줄에서 걷어낸 그 주장인데, **같은 화면의 이 줄이 그대로 남아**
  // 머리줄과 반대되는 말을 하고 있었습니다 (실패 ②·결함 298·301).
  if (near === null) {
    return {
      what,
      why: '일정은 자동으로 생기지 않습니다 — 업무 마감일이나 회의에서 옵니다.',
      how: '아래에서 회의 일정을 잡으세요. 업무 마감일은 업무 후보를 승인할 때 정해집니다.',
    };
  }

  const when = describeDate(near.date);
  if (near.inMonth) {
    // 고른 날만 비었습니다 — 이 달에는 있습니다.
    return {
      what,
      why: `이 달에 잡힌 일은 있습니다 — 가장 가까운 것은 ${when}입니다.`,
      how: '[이 달 전체 보기]를 누르면 이 달에 있는 일이 모두 나옵니다.',
    };
  }

  const ahead = dayNumber(near.date) >= dayNumber(from);
  return {
    what,
    why: `가장 가까운 일은 ${when}입니다 — 격자 ${ahead ? '끝' : '앞'}의 흐린 칸에 이미 보입니다.`,
    how: `[${ahead ? '다음달' : '지난달'}]을 누르면 그 달이 열립니다.`,
  };
}


// ══════════════════════════════════════════════════════════════
// 잡아 둔 일정 무르기 (결함 298)
// ══════════════════════════════════════════════════════════════

/**
 * 이 항목을 **무를 수 있는가**.
 *
 * ⛔ 서버에는 `DELETE /api/scheduled-meetings/{id}` 가 처음부터 있었고
 * 검사까지 붙어 있었는데 **부르는 곳이 0곳**이었습니다 — 이 저장소가
 * 대표 실패 ① 로 적어 둔 「만들어 놓고 아무도 안 부름」입니다. 일정을
 * 잘못 잡거나 두 번 잡으면 달력·홈·회의 목록에 **영영 남았습니다**
 * (실패 ③ 「할 일을 알려 주고 그 일을 할 자리를 안 줌」).
 *
 * ⚠️ **여기는 「보여 줄까」만 정합니다.** 무를 수 있는지 최종 판정은
 * 서버입니다(`이미 연 회의는 무를 수 없습니다`) — 격자가 이웃 달을
 * 걸치면 이미 연 회의도 `meeting_planned` 로 그려질 수 있습니다.
 * 같은 판단을 두 벌 만들지 않고, 거절당하면 **서버가 한 말을 그대로**
 * 보여 줍니다.
 */
export function canCancelMeeting(item: CalendarItem): boolean {
  return item.kind === 'meeting_planned' && item.meeting_id !== null;
}

/**
 * 무르기 전에 물어볼 말.
 *
 * ⚠️ 「되돌릴 수 없습니다」라고 적지 않습니다 — 잡아 둔 일정은 다시 잡으면
 * 그만이고, 없는 위험을 말하면 다음에 진짜 경고를 안 읽습니다
 * (`deleteTaskConfirm` 과 다른 이유로 다른 문장입니다).
 */
export function cancelMeetingConfirm(title: string): string {
  return `${title} 일정을 무릅니다. 아직 안 연 회의라 기록은 남지 않습니다.`;
}
