import { useEffect, useRef, useState } from 'react';
import * as Pop from '@radix-ui/react-popover';
import {
  WEEKDAY_LABELS,
  describeMonth,
  formatTeamDate,
  monthGrid,
  monthOf,
  moveInCalendar,
  shiftMonth,
  todayInTeamCalendar,
} from '@lib/time/calendar.ts';

// 날짜 고르기 — 네이티브 `<input type="date">` 를 대신합니다 (v2 F7).
//
// ## 왜
//
// 한국어 서비스인데 마감 칸이 `mm/dd/yyyy` 로 떴습니다. ⚠️ 그 표기는
// `lang` 속성으로도 `locale` 로도 **못 바꿉니다** — 브라우저 UI 언어를
// 따릅니다. 이 저장소는 예전에 Playwright 의 `locale` 옵션으로 이걸
// 재려다 없는 결함을 만들 뻔한 적이 있습니다(그 옵션은
// `navigator.language` 만 바꿉니다).
//
// ## 왜 `react-day-picker` 를 안 쓰나
//
// 그러면 `date-fns` 까지 런타임 의존성이 둘 늘어납니다. 이 저장소의
// 규칙은 React·React DOM·Radix 뿐이고, 졸업작품이 끝난 뒤에도 열려야
// 합니다. 달력 격자는 순수 계산이라 `@lib/time/calendar.ts` 에 두고
// 검사 18개가 붙잡습니다 — 여기(화면)는 **그리기만** 합니다.
//
// 띄우는 일은 Radix Popover 가 합니다 (이미 `Why` 가 쓰고 있습니다) —
// 바깥 클릭·ESC·포커스 가두기를 직접 만들지 않기 위해서입니다.

interface DatePickerProps {
  /** `YYYY-MM-DD` 또는 `null`. */
  value: string | null;
  onChange: (value: string | null) => void;
  ariaLabel: string;
  id?: string;
}

export function DatePicker({ value, onChange, ariaLabel, id }: DatePickerProps) {
  const today = todayInTeamCalendar();
  const [open, setOpen] = useState(false);
  // 열 때마다 고른 날의 달로 돌아갑니다. 안 골랐으면 이번 달.
  const [month, setMonth] = useState(() => monthOf(value, today));
  const shown = formatTeamDate(value);

  // ⚠️ **격자 키보드 조작** (결함 196). `role="grid"` 라고 말해 놓고
  //    화살표가 안 먹으면 키보드로 날짜를 고르려면 Tab 을 마흔 번 넘게
  //    눌러야 합니다. 마감은 후보 등록의 필수 조건이라, 마우스를 못 쓰는
  //    사람은 이 제품의 핵심 흐름을 끝낼 수 없었습니다.
  //
  //    ARIA 의 roving tabindex — 격자 전체에서 **한 칸만** 탭 정지점입니다.
  //    나머지는 화살표로 옮겨 다닙니다.
  const [cursor, setCursor] = useState<string>(value ?? today);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const moveTo = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const next = value ?? today;
    setCursor(next);
    setMonth(monthOf(next, today));
    // ⚠️ 여기서 초점을 옮기지 않습니다 — Radix 의 자동 초점이 **뒤에**
    //    와서 도로 뺏어 갑니다. 그 일은 `onOpenAutoFocus` 가 합니다.
  }, [open, value, today]);

  useEffect(() => {
    const want = moveTo.current;
    if (want === null) return;
    moveTo.current = null;
    gridRef.current?.querySelector<HTMLElement>(`[data-date="${want}"]`)?.focus();
  });

  const onGridKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const next = moveInCalendar(cursor, event.key);
    if (next === null) return;
    event.preventDefault();
    setCursor(next);
    setMonth(monthOf(next, today));
    moveTo.current = next;
  };

  return (
    <Pop.Root
      open={open}
      onOpenChange={(next) => {
        if (next) setMonth(monthOf(value, today));
        setOpen(next);
      }}
    >
      <Pop.Trigger asChild>
        <button type="button" className="picker picker--date num" aria-label={ariaLabel} id={id}>
          {/* 안 고른 상태를 **빈 칸으로 두지 않습니다** — 빈 상자는 고장난
              것처럼 보입니다. `미지정` 은 담당자 칸과 같은 낱말입니다. */}
          <span className={shown === null ? 'picker__empty' : undefined}>{shown ?? '미지정'}</span>
          <span className="picker__icon" aria-hidden="true">
            <svg viewBox="0 0 12 12" width="12" height="12">
              <rect x="1" y="2.5" width="10" height="8.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.1" />
              <path d="M1 5 H11 M4 1.2 V3.4 M8 1.2 V3.4" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
            </svg>
          </span>
        </button>
      </Pop.Trigger>
      <Pop.Portal>
        <Pop.Content
          className="cal"
          sideOffset={4}
          align="start"
          // ⚠️ **Radix 가 여는 순간 첫 초점을 가져갑니다** — `‹`(이전 달)
          //    버튼입니다. 거기서는 화살표를 눌러도 아무 일이 없어서,
          //    "격자 키보드를 붙였는데 여전히 안 움직인다" 가 됐습니다.
          //    (`useEffect` 로 나중에 초점을 옮겨 봤지만 Radix 의 자동
          //    초점이 **뒤에** 와서 도로 뺏어 갑니다.)
          //    자동 초점을 막고 **고른 날 칸**으로 직접 보냅니다.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            const want = value ?? today;
            gridRef.current?.querySelector<HTMLElement>(`[data-date="${want}"]`)?.focus();
          }}
        >
          <div className="cal__head">
            <button
              type="button"
              className="cal__nav"
              aria-label="이전 달"
              onClick={() => setMonth(shiftMonth(month, -1))}
            >
              ‹
            </button>
            {/* `aria-live` — 달을 넘기면 낭독기가 새 달을 읽습니다.
                안 넣으면 화살표만 눌리고 어디로 갔는지 안 들립니다. */}
            <span className="cal__month" aria-live="polite">
              {describeMonth(month)}
            </span>
            <button
              type="button"
              className="cal__nav"
              aria-label="다음 달"
              onClick={() => setMonth(shiftMonth(month, 1))}
            >
              ›
            </button>
          </div>
          <div
            className="cal__grid"
            role="grid"
            aria-label={describeMonth(month)}
            ref={gridRef}
            onKeyDown={onGridKey}
          >
            {WEEKDAY_LABELS.map((w) => (
              <span className="cal__wd" key={w} aria-hidden="true">
                {w}
              </span>
            ))}
            {monthGrid(month).map((cell) => {
              const picked = cell.date === value;
              return (
                <button
                  type="button"
                  key={cell.date}
                  className={[
                    'cal__day',
                    cell.inMonth ? '' : 'cal__day--out',
                    cell.date === today ? 'cal__day--today' : '',
                    picked ? 'cal__day--picked' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-pressed={picked}
                  aria-label={cell.date}
                  data-date={cell.date}
                  // 격자에서 **한 칸만** 탭 정지점입니다 (roving tabindex).
                  tabIndex={cell.date === cursor ? 0 : -1}
                  onFocus={() => setCursor(cell.date)}
                  onClick={() => {
                    onChange(cell.date);
                    setOpen(false);
                  }}
                >
                  {Number(cell.date.slice(8))}
                </button>
              );
            })}
          </div>
          {/* 지우는 길이 없으면 한 번 고른 마감을 못 되돌립니다 —
              네이티브 입력은 글자를 지우면 됐지만 여기는 버튼뿐입니다. */}
          <button
            type="button"
            className="btn btn--ghost btn--sm cal__clear"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          >
            마감 지우기
          </button>
        </Pop.Content>
      </Pop.Portal>
    </Pop.Root>
  );
}
