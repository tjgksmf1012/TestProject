import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  dayAriaLabel,
  describeKind,
  describeMonth,
  describeDate,
  dayOf,
  canCancelMeeting,
  cancelMeetingConfirm,
  emptyNote,
  nearestDayWithItems,
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
    strictEqual(dayAriaLabel(day!, '2026-09-01'), '10일, 1건 — 마감 로그인 API');
  });

  it('빈 날은 숫자만 읽는다', () => {
    const cells = monthGrid(2026, 9, []);
    strictEqual(dayAriaLabel(cells.find((c) => c.date === '2026-09-10')!, '2026-09-01'), '10일');
  });

  it('⭐ 오늘은 **귀로도** 오늘이다 (결함 400)', () => {
    /* 「오늘」은 테두리 **색** 하나에만 실려 있었습니다. 고대비에서는 모든
       칸의 테두리가 같은 시스템 색으로 덮여 옆 칸과 한 자도 안 달라지고,
       낭독기에게는 **원래부터** 「26일」이라 「1일」과 모양이 같았습니다.
       같은 파일이 **고른 날**에는 `aria-current="date"` 를 붙이고 있었으니
       안 붙어 있던 것은 오늘 쪽입니다. */
    const cells = monthGrid(2026, 9, []);
    strictEqual(dayAriaLabel(cells.find((c) => c.date === '2026-09-10')!, '2026-09-10'), '10일, 오늘');
  });

  it('⭐ 오늘이면서 일정이 있으면 **둘 다** 읽는다', () => {
    /* ⚠️ 한 갈래만 고치면 옆 갈래가 그대로 남습니다(결함 298·301) —
       일정이 있는 날은 다른 문장을 만드므로 따로 잽니다. */
    const cells = monthGrid(2026, 9, [item()]);
    strictEqual(
      dayAriaLabel(cells.find((c) => c.date === '2026-09-10')!, '2026-09-10'),
      '10일, 오늘, 1건 — 마감 로그인 API',
    );
  });

  it('⚠️ 오늘이 아닌 날에 「오늘」을 붙이지 않는다', () => {
    /* 반대 방향. 한 방향만 재면 「언제나 오늘이라고 적는」 고침도 통과합니다. */
    const cells = monthGrid(2026, 9, []);
    ok(!dayAriaLabel(cells.find((c) => c.date === '2026-09-11')!, '2026-09-10').includes('오늘'));
  });
});

describe('비어 있을 때 할 말 (결함 294)', () => {
  const at = (kind: string, iso: string, title: string): CalendarItem => ({
    kind,
    at: iso,
    title,
    task_id: null,
    meeting_id: 1,
    who: null,
    done: false,
  });

  // 재현한 그림: 8월을 열면 격자 끝 줄에 9월 1·2·3·5 가 붙어 보이고
  // 거기에 회의 넷이 뱃지로 떠 있었습니다. 8월 자체는 비어 있습니다.
  const august = () =>
    monthGrid(2026, 8, [
      at('meeting_held', '2026-09-01T10:00:00Z', '1주차 정기회의'),
      at('meeting_held', '2026-09-02T10:00:00Z', '중간발표 리허설'),
      at('meeting_held', '2026-09-03T10:00:00Z', '제목 없는 회의 #4'),
      at('meeting_held', '2026-09-05T10:00:00Z', 'DB 스키마 확정 논의'),
    ]);

  it('⭐ 격자에 뱃지가 보이면 「만드세요」 라고 시키지 않는다', () => {
    const cells = august();
    // 심은 것이 실제로 심겼는지부터 — 이 달은 비었고 이웃 칸에는 있습니다.
    strictEqual(itemsInMonth(cells).length, 0);
    strictEqual(
      cells.filter((cell) => !cell.inMonth && cell.items.length > 0).length,
      4,
    );

    const note = emptyNote(cells, null);
    strictEqual(note.what, '이 달에는 잡힌 일이 없습니다');
    // ⛔ 이 두 줄이 결함 294 의 거짓말입니다.
    strictEqual(note.why.includes('일정은 자동으로 생기지 않습니다'), false);
    strictEqual(note.how.includes('칸반에서 업무에 마감일을 주세요'), false);
    // 대신 격자가 아는 사실을 말합니다.
    strictEqual(note.why, '가장 가까운 일은 9월 1일입니다 — 격자 끝의 흐린 칸에 이미 보입니다.');
    strictEqual(note.how, '[다음달]을 누르면 그 달이 열립니다.');
  });

  it('격자가 통째로 비었을 때만 「만드세요」 가 참이다', () => {
    const note = emptyNote(monthGrid(2026, 8, []), null);
    strictEqual(note.why, '일정은 자동으로 생기지 않습니다 — 업무 마감일이나 회의에서 옵니다.');
    strictEqual(note.how, '아래에서 회의 일정을 잡으세요. 업무 마감일은 업무 후보를 승인할 때 정해집니다.');
  });

  it('⭐ 빈 상자가 **없는 자리**로 보내지 않는다 (결함 389)', () => {
    // 칸반에는 마감일을 주는 자리가 없습니다 — 업무 PATCH 에 `deadline` 을
    // 싣는 화면이 두 뿌리 다 0곳입니다. 결함 386 이 이 화면 **머리줄**에서
    // 걷어낸 주장이 빈 상자에 그대로 남아 있었습니다.
    const everywhere = [
      emptyNote(monthGrid(2026, 8, []), null),
      emptyNote(monthGrid(2026, 9, [at('meeting_held', '2026-08-31T10:00:00Z', '지난 회의')]), null),
      emptyNote(monthGrid(2026, 9, [at('meeting_held', '2026-09-10T10:00:00Z', '회의')]),
        monthGrid(2026, 9, [at('meeting_held', '2026-09-10T10:00:00Z', '회의')])
          .find((cell) => cell.date === '2026-09-04')!),
    ];
    for (const note of everywhere) {
      const flat = `${note.what} ${note.why} ${note.how}`;
      strictEqual(
        /칸반[^.]{0,40}마감일/.test(flat),
        false,
        `칸반에서 마감일을 준다고 말합니다: ${note.how}`,
      );
    }
  });

  it('앞쪽 이웃 칸이면 [지난달] 을 가리킨다', () => {
    // 9월을 열면 격자 앞 줄에 8월 31일이 붙습니다.
    const cells = monthGrid(2026, 9, [at('meeting_held', '2026-08-31T10:00:00Z', '지난 회의')]);
    strictEqual(itemsInMonth(cells).length, 0);
    const note = emptyNote(cells, null);
    strictEqual(note.why, '가장 가까운 일은 8월 31일입니다 — 격자 앞의 흐린 칸에 이미 보입니다.');
    strictEqual(note.how, '[지난달]을 누르면 그 달이 열립니다.');
  });

  it('고른 날만 비었으면 이 달 전체를 가리킨다', () => {
    const cells = monthGrid(2026, 9, [at('meeting_held', '2026-09-10T10:00:00Z', '회의')]);
    const picked = cells.find((cell) => cell.date === '2026-09-04')!;
    const note = emptyNote(cells, picked);
    strictEqual(note.what, '이 날에는 잡힌 일이 없습니다');
    strictEqual(note.why, '이 달에 잡힌 일은 있습니다 — 가장 가까운 것은 9월 10일입니다.');
    strictEqual(note.how, '[이 달 전체 보기]를 누르면 이 달에 있는 일이 모두 나옵니다.');
  });

  it('같은 거리면 앞날을 고른다 — 지나간 것을 가리키면 쓸모가 없다', () => {
    const cells = monthGrid(2026, 9, [
      at('meeting_held', '2026-09-08T10:00:00Z', '지난 것'),
      at('meeting_held', '2026-09-12T10:00:00Z', '올 것'),
    ]);
    strictEqual(nearestDayWithItems(cells, '2026-09-10')?.date, '2026-09-12');
  });

  it('날짜를 사람 말로. 못 읽으면 원문 그대로', () => {
    strictEqual(describeDate('2026-09-01'), '9월 1일');
    strictEqual(describeDate('2026-12-25'), '12월 25일');
    strictEqual(describeDate('없음'), '없음');
  });
});

describe('잡아 둔 일정 무르기 (결함 298)', () => {
  const item = (over: Partial<CalendarItem> = {}): CalendarItem => ({
    kind: 'meeting_planned',
    at: '2026-09-15T01:00:00Z',
    title: '주간 스탠드업',
    task_id: null,
    meeting_id: 7,
    who: null,
    done: false,
    ...over,
  });

  it('⭐ 잡아 둔 회의에만 무르기를 보여 준다', () => {
    strictEqual(canCancelMeeting(item()), true);
    // 이미 연 회의는 서버가 거절합니다 — 단추를 그리지 않습니다.
    strictEqual(canCancelMeeting(item({ kind: 'meeting_held' })), false);
    // 마감일은 무를 것이 아닙니다 (칸반에서 고칩니다).
    strictEqual(canCancelMeeting(item({ kind: 'task_due', meeting_id: null })), false);
    strictEqual(canCancelMeeting(item({ kind: 'project_due', meeting_id: null })), false);
  });

  it('⚠️ 가리킬 회의가 없으면 안 그린다 — 누를 곳이 없습니다', () => {
    strictEqual(canCancelMeeting(item({ meeting_id: null })), false);
  });

  it('⚠️ 없는 위험을 말하지 않는다 — 다시 잡으면 그만입니다', () => {
    const said = cancelMeetingConfirm('주간 스탠드업');
    strictEqual(said.includes('주간 스탠드업'), true);
    // `deleteTaskConfirm` 과 달리 「되돌릴 수 없습니다」가 아닙니다.
    strictEqual(said.includes('되돌릴 수 없습니다'), false);
  });
});
