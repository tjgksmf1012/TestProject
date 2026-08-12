/**
 * 일정 화면 — 한 달을 한눈에 (요구사항 정의서 §16).
 *
 * ## 판단은 여기 없습니다
 *
 * 칸을 어떻게 놓을지, 어느 날에 무엇을 담을지, 무엇이 늦은 것인지는 전부
 * `lib/calendar/month.ts` 에 있고 테스트가 붙어 있습니다. 달력은 **한 칸만
 * 밀려도 전부 틀린** 화면이라 눈으로는 잘 안 잡힙니다.
 *
 * ## ⚠️ 달력은 **읽어서 만든 것**입니다
 *
 * 서버에 `calendar_events` 같은 표가 없습니다 — 업무 마감일·프로젝트
 * 마감일·회의를 그때그때 읽어서 만듭니다. 그래서 업무 마감일을 고치면
 * 달력이 그 자리에서 따라옵니다.
 */

import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import {
  dayAriaLabel,
  dayOf,
  describeKind,
  describeMonth,
  hrefFor,
  isOverdue,
  itemsInMonth,
  monthGrid,
  parseMonth,
  rangeFor,
  shiftMonth,
  WEEKDAYS,
  type CalendarItem,
  type DayCell,
} from '../lib/calendar/month.ts';
import { isSessionExpired, loginUrlFor, safeApiBase } from '../lib/auth/session.ts';
import { tryGet, trySend, unreachableText } from '../lib/http/send.ts';
import { todayInTeamCalendar } from '../lib/time/calendar.ts';
import { emptyHtml } from '../lib/ui/empty.ts';
import { describeHttpStatus, failureHtml } from '../lib/ui/failure.ts';
import { whileLoading } from '../lib/ui/pending.ts';
import { rows as rowSkeleton } from '../lib/ui/skeleton.ts';
import { NoteLine, RawHtml, type Note } from './parts.tsx';
import { renderNav } from './nav.ts';
import { bootApp } from './pwa.ts';

const params = new URLSearchParams(location.search);
// ⚠️ 주소창의 `?api=` 를 그대로 쓰면 링크 하나로 팀 일정이 어디로 가는지
// 바뀝니다.
const apiBase = safeApiBase(params.get('api'), location.origin);
const projectId = Number(params.get('project') ?? '1');

const get = (path: string): Promise<Response | null> => tryGet(`${apiBase}${path}`);

function goToLogin(): void {
  location.href = loginUrlFor(location.pathname + location.search);
}

/** 주소의 `?month=` 또는 이번 달. ⚠️ 말이 안 되면 **이번 달**입니다. */
function startingMonth(): { year: number; month: number } {
  const asked = parseMonth(params.get('month') ?? '');
  if (asked !== null) return asked;
  const today = todayInTeamCalendar();
  return { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };
}

function Cell({
  cell,
  today,
  onPick,
  picked,
}: {
  cell: DayCell;
  today: string;
  onPick: (date: string) => void;
  picked: boolean;
}) {
  const classes = ['cell'];
  if (!cell.inMonth) classes.push('out');
  if (cell.date === today) classes.push('today');
  if (picked) classes.push('picked');
  return (
    <button
      type="button"
      className={classes.join(' ')}
      aria-label={dayAriaLabel(cell)}
      {...(picked ? { 'aria-current': 'date' as const } : {})}
      onClick={() => onPick(cell.date)}
    >
      <span className="dnum">{cell.day}</span>
      {/* ⚠️ 칸 안에 제목을 다 적지 않습니다 — 폰에서 한 칸이 50px 인데
          거기에 글자를 넣으면 세로로 쪼개집니다. 개수만 적고 자세한 것은
          아래 목록이 말합니다. */}
      {cell.items.length > 0 && (
        <span className={cell.items.some((i) => isOverdue(i, today)) ? 'dots late' : 'dots'}>
          {cell.items.length}
        </span>
      )}
    </button>
  );
}

function App() {
  const [at, setAt] = useState(startingMonth);
  const [items, setItems] = useState<CalendarItem[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState('');
  const [sending, setSending] = useState(false);

  const today = todayInTeamCalendar();

  const load = useCallback(async (year: number, month: number): Promise<void> => {
    setItems(null);
    const range = rangeFor(year, month);
    const response = await whileLoading(
      get(
        `/api/projects/${projectId}/calendar?since=${encodeURIComponent(range.since)}` +
          `&until=${encodeURIComponent(range.until)}`,
      ),
      () => setSlow(true),
      () => setSlow(false),
    );
    if (response === null) {
      setFailure(unreachableText('일정을 못 불러왔습니다'));
      setItems([]);
      return;
    }
    if (isSessionExpired(response.status)) {
      goToLogin();
      return;
    }
    if (!response.ok) {
      setFailure(describeHttpStatus(response.status) ?? '일정을 못 불러왔습니다');
      setItems([]);
      return;
    }
    setFailure(null);
    setItems((await response.json()) as CalendarItem[]);
  }, []);

  useEffect(() => {
    void load(at.year, at.month);
  }, [at, load]);

  const schedule = useCallback(async (): Promise<void> => {
    setSending(true);
    try {
      const response = await trySend(() =>
        fetch(`${apiBase}/api/projects/${projectId}/scheduled-meetings`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          // ⚠️ `datetime-local` 은 **시간대가 없는** 글자입니다. 그대로
          //    보내면 서버가 UTC 로 읽어 9시간 어긋납니다. 브라우저의
          //    시간대로 해석해 순간으로 바꿔 보냅니다.
          body: JSON.stringify({ title, at: new Date(when).toISOString() }),
        }),
      );
      if (response === null) {
        setNote({ text: unreachableText('일정을 못 잡았습니다'), tone: 'bad' });
        return;
      }
      if (isSessionExpired(response.status)) {
        goToLogin();
        return;
      }
      if (!response.ok) {
        setNote({
          text: describeHttpStatus(response.status) ?? '일정을 못 잡았습니다',
          tone: 'bad',
        });
        return;
      }
      setNote({ text: '회의 일정을 잡았습니다.', tone: 'plain' });
      setTitle('');
      setWhen('');
      await load(at.year, at.month);
    } finally {
      setSending(false);
    }
  }, [title, when, at, load]);

  const header = (
    <header className="head">
      <h1>일정</h1>
      <p className="lede">
        업무 마감일·회의·프로젝트 마감일을 한 달로 봅니다. 따로 적어 두는 것이
        아니라 <b>그때그때 읽어서</b> 만들기 때문에, 칸반에서 마감일을 고치면
        여기가 바로 따라옵니다.
      </p>
    </header>
  );

  if (failure !== null && items !== null && items.length === 0) {
    return (
      <>
        {header}
        <RawHtml
          html={failureHtml({ what: failure, retry: true })}
          onRetry={() => void load(at.year, at.month)}
        />
      </>
    );
  }

  const cells = monthGrid(at.year, at.month, items ?? []);
  const pickedCell = picked === null ? null : (cells.find((c) => c.date === picked) ?? null);
  // 고른 날이 없으면 이 달 것을 아래에 폅니다. 빈 화면을 두면 달력만
  // 보이고 무엇이 있는지 읽을 방법이 없습니다.
  //
  // ⚠️ `items` 를 그대로 쓰면 안 됩니다 — 서버에는 격자 전체(이웃 달 며칠
  //    포함)를 물어보므로 **7월 말과 9월 초가 8월 목록에 섞입니다.**
  //    제목은 "이 달에 있는 일" 인데요. 렌더해서 보고 알았습니다.
  const listed = pickedCell !== null ? pickedCell.items : itemsInMonth(cells);

  return (
    <>
      {header}

      <div className="mbar">
        <button type="button" id="prev" onClick={() => setAt(shiftMonth(at.year, at.month, -1))}>
          지난달
        </button>
        <h2 className="mhead">{describeMonth(at.year, at.month)}</h2>
        <button type="button" id="next" onClick={() => setAt(shiftMonth(at.year, at.month, 1))}>
          다음달
        </button>
      </div>

      {items === null ? (
        slow && <div aria-busy="true" dangerouslySetInnerHTML={{ __html: rowSkeleton(5) }} />
      ) : (
        <>
          <div className="grid" role="grid" aria-label={describeMonth(at.year, at.month)}>
            {WEEKDAYS.map((name) => (
              <div key={name} className="wd" role="columnheader">
                {name}
              </div>
            ))}
            {cells.map((cell) => (
              <Cell
                key={cell.date}
                cell={cell}
                today={today}
                picked={cell.date === picked}
                onPick={(date) => setPicked((current) => (current === date ? null : date))}
              />
            ))}
          </div>

          <section className="detail">
            <div className="dbar">
              <h2 className="shead">
                {pickedCell === null ? '이 달에 있는 일' : `${pickedCell.day}일에 있는 일`}
              </h2>
              {pickedCell !== null && (
                <button type="button" onClick={() => setPicked(null)}>
                  이 달 전체 보기
                </button>
              )}
            </div>

            {listed.length === 0 ? (
              <RawHtml
                html={emptyHtml({
                  what:
                    pickedCell === null
                      ? '이 달에는 잡힌 일이 없습니다'
                      : '이 날에는 잡힌 일이 없습니다',
                  why: '일정은 자동으로 생기지 않습니다 — 업무 마감일이나 회의에서 옵니다.',
                  how: '아래에서 회의 일정을 잡거나, 칸반에서 업무에 마감일을 주세요.',
                })}
              />
            ) : (
              <ul className="ilist">
                {listed.map((thing, i) => {
                  const href = hrefFor(thing, projectId);
                  const late = isOverdue(thing, today);
                  return (
                    <li key={`${thing.kind}-${thing.task_id}-${thing.meeting_id}-${i}`}>
                      {/* ⚠️ 날짜가 없으면 한 달치가 그냥 줄 나열이 됩니다 —
                          격자에서 눈으로 센 다음 여기서 다시 찾아야 합니다. */}
                      <span className="iday">{dayOf(thing)}</span>
                      {/* ⚠️ 늦은 것은 **흙빛**이 아니라 경고색입니다 — 흙빛은
                          "못 쟀다" 는 뜻으로 이 저장소 전체에서 쓰입니다. */}
                      <span className={late ? 'kind late' : 'kind'}>
                        {describeKind(thing.kind)}
                      </span>
                      {href === null ? (
                        <span className="ititle">{thing.title}</span>
                      ) : (
                        <a className="ititle" href={href}>
                          {thing.title}
                        </a>
                      )}
                      {thing.who !== null && <span className="iwho">{thing.who}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="detail">
            <h2 className="shead">회의 일정 잡기</h2>
            <p className="lede">
              잡아만 두는 것이고 <b>녹음은 시작되지 않습니다</b> — 회의를 여는 것은
              로비에서 동의를 받은 뒤입니다.
            </p>
            <NoteLine note={note} id="schedule-note" />
            <form
              className="sform"
              onSubmit={(event) => {
                event.preventDefault();
                void schedule();
              }}
            >
              <label className="clabel" htmlFor="mtitle">
                회의 이름
              </label>
              <input
                id="mtitle"
                value={title}
                maxLength={200}
                placeholder="예: 주간 정기회의"
                onChange={(event) => setTitle(event.target.value)}
              />
              <label className="clabel" htmlFor="mwhen">
                언제
              </label>
              <input
                id="mwhen"
                type="datetime-local"
                value={when}
                onChange={(event) => setWhen(event.target.value)}
              />
              <button
                type="submit"
                id="schedule"
                disabled={title.trim() === '' || when === '' || sending}
              >
                일정 잡기
              </button>
            </form>
          </section>
        </>
      )}
    </>
  );
}

const host = document.getElementById('app');
if (host !== null) createRoot(host).render(<App />);
renderNav('calendar');
bootApp();
