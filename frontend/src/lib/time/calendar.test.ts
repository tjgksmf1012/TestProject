import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  WEEKDAY_LABELS,
  describeMonth,
  formatTeamDate,
  monthGrid,
  monthOf,
  moveInCalendar,
  shiftMonth,
  teamDateOf,
  todayInTeamCalendar,
} from './calendar.ts';

describe('monthGrid', () => {
  it('⭐ 언제나 42칸 — 격자가 달마다 흔들리면 화면 높이가 춤춘다', () => {
    for (const month of ['2026-01', '2026-02', '2026-09', '2028-02']) {
      strictEqual(monthGrid(month).length, 42, month);
    }
  });

  it('⭐ 첫 칸은 언제나 일요일', () => {
    // 요일 머리(WEEKDAY_LABELS)가 일요일 시작인데 격자가 월요일 시작이면
    // 날짜가 통째로 한 칸 밀린다 — 눈으로는 잘 안 보이는 종류의 결함이다.
    for (const month of ['2026-01', '2026-02', '2026-09', '2027-03']) {
      const first = monthGrid(month)[0];
      strictEqual(new Date(`${first?.date}T00:00:00Z`).getUTCDay(), 0, month);
    }
  });

  it('2026-09 — 9월 1일은 화요일이므로 앞에 8월 30·31이 붙는다', () => {
    const cells = monthGrid('2026-09');
    deepStrictEqual(cells.slice(0, 3).map((c) => c.date), ['2026-08-30', '2026-08-31', '2026-09-01']);
    strictEqual(cells[0]?.inMonth, false);
    strictEqual(cells[1]?.inMonth, false);
    strictEqual(cells[2]?.inMonth, true);
  });

  it('그 달의 날 수가 맞다 — 윤년 2월 포함', () => {
    strictEqual(monthGrid('2026-02').filter((c) => c.inMonth).length, 28);
    strictEqual(monthGrid('2028-02').filter((c) => c.inMonth).length, 29);
    strictEqual(monthGrid('2026-09').filter((c) => c.inMonth).length, 30);
    strictEqual(monthGrid('2026-01').filter((c) => c.inMonth).length, 31);
  });

  it('⚠️ 칸이 하루씩 이어진다 — 서머타임에 하루를 건너뛰거나 겹치지 않는다', () => {
    // 로컬 `setDate(+1)` 로 만들면 시간대에 따라 같은 날이 두 번 나온다.
    // 여기는 전부 UTC 계산이라 어느 시간대에서 돌려도 같아야 한다.
    const cells = monthGrid('2026-03');
    const days = cells.map((c) => Date.parse(`${c.date}T00:00:00Z`));
    for (let i = 1; i < days.length; i++) {
      strictEqual((days[i] as number) - (days[i - 1] as number), 86_400_000, `${cells[i]?.date}`);
    }
  });

  it('형식이 틀리면 던진다 — 조용히 오늘로 넘어가지 않는다', () => {
    throws(() => monthGrid('2026-9'), RangeError);
    throws(() => monthGrid('2026'), RangeError);
    throws(() => monthGrid('2026-13'), RangeError);
    throws(() => monthGrid('2026-00'), RangeError);
  });
});

describe('shiftMonth', () => {
  it('연도를 넘어간다 — 양쪽으로', () => {
    strictEqual(shiftMonth('2026-12', 1), '2027-01');
    strictEqual(shiftMonth('2026-01', -1), '2025-12');
  });

  it('여러 달을 한 번에', () => {
    strictEqual(shiftMonth('2026-09', 5), '2027-02');
    strictEqual(shiftMonth('2026-03', -5), '2025-10');
    strictEqual(shiftMonth('2026-09', 0), '2026-09');
  });

  it('12의 배수는 연도만 바뀐다', () => {
    strictEqual(shiftMonth('2026-07', 12), '2027-07');
    strictEqual(shiftMonth('2026-07', -24), '2024-07');
  });
});

describe('monthOf', () => {
  it('날짜가 있으면 그 달', () => {
    strictEqual(monthOf('2026-09-04', '2026-01-01'), '2026-09');
  });

  it('⭐ 값이 없거나 망가졌으면 fallback 의 달 — 달력이 안 열리면 못 고른다', () => {
    strictEqual(monthOf(null, '2026-01-15'), '2026-01');
    strictEqual(monthOf('', '2026-01-15'), '2026-01');
    strictEqual(monthOf('내일', '2026-01-15'), '2026-01');
  });
});

describe('formatTeamDate', () => {
  it('`YYYY-MM-DD` 를 그대로 — 다른 값은 자릿수가 흔들린다', () => {
    strictEqual(formatTeamDate('2026-09-04'), '2026-09-04');
  });

  it('망가진 값은 null — 화면이 "미지정" 을 그리게 한다', () => {
    strictEqual(formatTeamDate(null), null);
    strictEqual(formatTeamDate(''), null);
    strictEqual(formatTeamDate('09/04/2026'), null);
  });
});

describe('describeMonth', () => {
  it('앞자리 0 을 떼고 읽는다', () => {
    strictEqual(describeMonth('2026-09'), '2026년 9월');
    strictEqual(describeMonth('2026-12'), '2026년 12월');
  });

  it('형식이 틀리면 던진다', () => {
    throws(() => describeMonth('2026'), RangeError);
  });
});

describe('WEEKDAY_LABELS', () => {
  it('⭐ 일곱 개이고 일요일부터 — 격자와 순서가 같아야 한다', () => {
    strictEqual(WEEKDAY_LABELS.length, 7);
    strictEqual(WEEKDAY_LABELS[0], '일');
    strictEqual(WEEKDAY_LABELS[6], '토');
  });
});

describe('이미 있던 것들이 그대로인가', () => {
  it('teamDateOf 는 팀 시간대의 달력 날짜를 준다', () => {
    // UTC 2026-09-04 20:00 은 서울에서 이미 9월 5일이다.
    strictEqual(teamDateOf('2026-09-04T20:00:00Z'), '2026-09-05');
  });

  it('todayInTeamCalendar 는 YYYY-MM-DD 를 준다', () => {
    strictEqual(/^\d{4}-\d{2}-\d{2}$/.test(todayInTeamCalendar(new Date('2026-09-04T01:00:00Z'))), true);
  });
});

describe('moveInCalendar — 격자 키보드 (결함 196)', () => {
  it('⭐ 좌우는 하루, 위아래는 한 주', () => {
    strictEqual(moveInCalendar('2026-09-10', 'ArrowLeft'), '2026-09-09');
    strictEqual(moveInCalendar('2026-09-10', 'ArrowRight'), '2026-09-11');
    strictEqual(moveInCalendar('2026-09-10', 'ArrowUp'), '2026-09-03');
    strictEqual(moveInCalendar('2026-09-10', 'ArrowDown'), '2026-09-17');
  });

  it('⭐ 달 경계를 알아서 넘는다 — 화면에 보이는 격자가 그렇게 생겼다', () => {
    strictEqual(moveInCalendar('2026-09-01', 'ArrowLeft'), '2026-08-31');
    strictEqual(moveInCalendar('2026-09-30', 'ArrowRight'), '2026-10-01');
    strictEqual(moveInCalendar('2026-12-31', 'ArrowRight'), '2027-01-01');
  });

  it('Home·End 는 그 주의 일요일·토요일', () => {
    // 2026-09-10 은 목요일
    strictEqual(moveInCalendar('2026-09-10', 'Home'), '2026-09-06');
    strictEqual(moveInCalendar('2026-09-10', 'End'), '2026-09-12');
  });

  it('⭐ PageUp/Down 은 달을 넘기되 **날짜를 유지**한다', () => {
    strictEqual(moveInCalendar('2026-09-10', 'PageUp'), '2026-08-10');
    strictEqual(moveInCalendar('2026-09-10', 'PageDown'), '2026-10-10');
  });

  it('⚠️ 없는 날로 튀지 않는다 — 1월 31일에서 한 달 뒤는 2월 말일이다', () => {
    strictEqual(moveInCalendar('2026-01-31', 'PageDown'), '2026-02-28');
    strictEqual(moveInCalendar('2028-01-31', 'PageDown'), '2028-02-29', '윤년');
    strictEqual(moveInCalendar('2026-03-31', 'PageUp'), '2026-02-28');
  });

  it('다루지 않는 키는 `null` — 화면이 그때만 기본 동작을 막는다', () => {
    strictEqual(moveInCalendar('2026-09-10', 'Enter'), null);
    strictEqual(moveInCalendar('2026-09-10', 'a'), null);
    strictEqual(moveInCalendar('말도 안 되는 값', 'ArrowLeft'), null);
  });
});
