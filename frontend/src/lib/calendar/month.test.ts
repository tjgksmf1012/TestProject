import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  dayAriaLabel,
  describeKind,
  describeMonth,
  dayOf,
  hrefFor,
  isOverdue,
  itemsInMonth,
  monthGrid,
  parseMonth,
  rangeFor,
  shiftMonth,
  weekStart,
  WEEKDAYS,
  type CalendarItem,
} from './month.ts';

function item(over: Partial<CalendarItem> = {}): CalendarItem {
  return {
    kind: 'task_due',
    at: '2026-09-10T05:00:00+00:00',
    title: '로그인 API',
    task_id: 7,
    meeting_id: null,
    who: '김민수',
    done: false,
    ...over,
  };
}

describe('달 고르기', () => {
  it('`YYYY-MM` 을 읽는다', () => {
    deepStrictEqual(parseMonth('2026-09'), { year: 2026, month: 9 });
  });

  it('말이 안 되는 달을 통과시키지 않는다', () => {
    strictEqual(parseMonth('2026-13'), null);
    strictEqual(parseMonth('2026-00'), null);
    strictEqual(parseMonth('올해 구월'), null);
    strictEqual(parseMonth(''), null);
  });

  it('앞뒤로 옮기면 해를 넘어간다', () => {
    deepStrictEqual(shiftMonth(2026, 12, 1), { year: 2027, month: 1 });
    deepStrictEqual(shiftMonth(2026, 1, -1), { year: 2025, month: 12 });
  });

  it('사람 말로 적는다', () => {
    strictEqual(describeMonth(2026, 9), '2026년 9월');
  });
});

describe('격자', () => {
  it('⭐ **월요일**부터 시작한다 — 주간 보고서와 같은 끊는 자리', () => {
    strictEqual(WEEKDAYS[0], '월');
    // 2026-09-01 은 화요일 → 그 주 월요일은 8월 31일
    strictEqual(weekStart(2026, 9).toISOString().slice(0, 10), '2026-08-31');
  });

  it('달의 1일이 월요일이면 앞 칸이 안 붙는다', () => {
    // 2026-06-01 은 월요일
    strictEqual(weekStart(2026, 6).toISOString().slice(0, 10), '2026-06-01');
  });

  it('⭐ 언제나 주 단위로 끝난다', () => {
    for (let month = 1; month <= 12; month++) {
      const cells = monthGrid(2026, month, []);
      strictEqual(cells.length % 7, 0, `${month}월이 ${cells.length}칸`);
    }
  });

  it('그 달의 날이 하나도 안 빠진다', () => {
    const cells = monthGrid(2026, 9, []);
    const mine = cells.filter((c) => c.inMonth).map((c) => c.day);
    deepStrictEqual(
      mine,
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
  });

  it('이웃 달 칸은 `inMonth` 가 아니다', () => {
    const cells = monthGrid(2026, 9, []);
    strictEqual(cells[0]?.date, '2026-08-31');
    strictEqual(cells[0]?.inMonth, false);
  });

  it('항목을 **팀 달력**의 날에 놓는다', () => {
    const cells = monthGrid(2026, 9, [item()]);
    const day = cells.find((c) => c.date === '2026-09-10');
    strictEqual(day?.items.length, 1);
  });

  it('⭐ UTC 로 자르면 하루 어긋나는 밤 시각', () => {
    // 2026-09-10T16:00Z 는 서울에서 9월 11일 새벽 1시입니다.
    const cells = monthGrid(2026, 9, [item({ at: '2026-09-10T16:00:00Z' })]);
    strictEqual(cells.find((c) => c.date === '2026-09-11')?.items.length, 1);
    strictEqual(cells.find((c) => c.date === '2026-09-10')?.items.length, 0);
  });

  it('⚠️ 못 읽는 날짜를 오늘에 놓지 않는다', () => {
    const cells = monthGrid(2026, 9, [item({ at: '언제인지 모름' })]);
    strictEqual(
      cells.reduce((n, c) => n + c.items.length, 0),
      0,
    );
  });

  it('⭐ "이 달에 있는 일" 에 이웃 달이 안 섞인다', () => {
    // 서버에는 격자 전체를 물어봅니다 — 8월 31일 칸에 걸린 마감이 9월
    // 격자에도 보여야 하기 때문입니다. 그런데 아래 목록의 제목은 "이 달"
    // 이라, 받은 것을 그대로 늘어놓으면 섞입니다.
    const cells = monthGrid(2026, 9, [
      item({ at: '2026-08-31T05:00:00Z', title: '지난달 것' }),
      item({ at: '2026-09-10T05:00:00Z', title: '이 달 것' }),
      item({ at: '2026-10-01T05:00:00Z', title: '다음달 것' }),
    ]);
    deepStrictEqual(
      itemsInMonth(cells).map((i) => i.title),
      ['이 달 것'],
    );
    // 격자에는 셋 다 있습니다 — 빼는 것이 아니라 목록에만 안 넣습니다.
    strictEqual(
      cells.reduce((n, c) => n + c.items.length, 0),
      3,
    );
  });

  it('서버에 물어볼 범위가 격자를 다 덮는다', () => {
    const cells = monthGrid(2026, 9, []);
    const range = rangeFor(2026, 9);
    strictEqual(range.since.startsWith(cells[0]?.date ?? ''), true);
    strictEqual(range.until.startsWith(cells[cells.length - 1]?.date ?? ''), true);
  });
});

describe('한 칸 안의 것', () => {
  it('종류를 사람 말로 적는다', () => {
    strictEqual(describeKind('task_due'), '마감');
    strictEqual(describeKind('meeting_planned'), '예정된 회의');
  });

  it('⚠️ 모르는 종류를 지어내지 않는다', () => {
    strictEqual(describeKind('sprint_end'), 'sprint_end');
  });

  it('며칠인지 적는다 — **팀 달력**으로', () => {
    strictEqual(dayOf(item()), '10일');
    // 2026-09-10T16:00Z 는 서울에서 11일입니다.
    strictEqual(dayOf(item({ at: '2026-09-10T16:00:00Z' })), '11일');
  });

  it('⚠️ 못 읽는 날짜에 가짜 값을 만들지 않는다', () => {
    strictEqual(dayOf(item({ at: '언제인지 모름' })), '');
  });

  it('갈 곳이 있으면 주소를, 없으면 `null`', () => {
    strictEqual(hrefFor(item(), 3), '/kanban.html?project=3');
    strictEqual(
      hrefFor(item({ task_id: null, meeting_id: 9 }), 3),
      '/lobby.html?meeting=9&project=3',
    );
    strictEqual(hrefFor(item({ kind: 'project_due', task_id: null }), 3), null);
  });

  it('⭐ 끝난 일은 마감일이 지나도 늦은 것이 아니다', () => {
    strictEqual(isOverdue(item({ done: true }), '2026-09-20'), false);
    strictEqual(isOverdue(item({ done: false }), '2026-09-20'), true);
  });

  it('⚠️ 시작일에는 늦음을 안 붙인다 — 지난 것이 정상이다', () => {
    strictEqual(isOverdue(item({ kind: 'task_start' }), '2026-09-20'), false);
  });

  it('아직 안 지난 것은 늦지 않았다', () => {
    strictEqual(isOverdue(item(), '2026-09-01'), false);
    strictEqual(isOverdue(item(), '2026-09-10'), false);
  });

  it('낭독기가 그 날 무엇이 있는지 듣는다', () => {
    const cells = monthGrid(2026, 9, [item()]);
    const day = cells.find((c) => c.date === '2026-09-10');
    strictEqual(dayAriaLabel(day!), '10일, 1건 — 마감 로그인 API');
  });

  it('빈 날은 숫자만 읽는다', () => {
    const cells = monthGrid(2026, 9, []);
    strictEqual(dayAriaLabel(cells.find((c) => c.date === '2026-09-10')!), '10일');
  });
});
