import { useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { DatePicker } from '../components/DatePicker.tsx';
import { Picker } from '../components/Picker.tsx';
import { Problem } from '../components/Problem.tsx';
import { ApiError } from '../api/client.ts';
import { useCalendar, useScheduleMutations } from '../api/hooks.ts';
import {
  appHrefFor,
  canCancelMeeting,
  cancelMeetingConfirm,
  dayAriaLabel,
  dayOf,
  describeKind,
  describeMonth,
  emptyNote,
  isOverdue,
  itemsInMonth,
  monthGrid,
  parseMonth,
  rangeFor,
  shiftMonth,
  WEEKDAYS,
} from '@lib/calendar/month.ts';
import {
  teamDateOf,
  teamDateTime,
  teamInstantOf,
  todayInTeamCalendar,
} from '@lib/time/calendar.ts';
import { describeActionFailure, describeLoadFailure } from '@lib/ui/load.ts';

function statusOf(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null;
}

function detailOf(error: unknown): string | null {
  return error instanceof ApiError ? error.detail : null;
}

const TIME_SLOTS: string[] = Array.from({ length: 48 }, (_, i) => {
  const hh = String(Math.floor(i / 2)).padStart(2, '0');
  const mm = i % 2 === 0 ? '00' : '30';
  return `${hh}:${mm}`;
});

function currentYearMonth(today: string): { year: number; month: number } {
  return {
    year: Number(today.slice(0, 4)),
    month: Number(today.slice(5, 7)),
  };
}

export default function Calendar() {
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = Number(params['projectId']);
  const validProjectId = Number.isFinite(projectId) && projectId > 0 ? projectId : undefined;
  const today = todayInTeamCalendar();

  const at = useMemo(() => {
    const parsed = parseMonth(searchParams.get('month') ?? '');
    return parsed ?? currentYearMonth(today);
  }, [searchParams, today]);

  const setMonth = (next: { year: number; month: number }) => {
    const formatted = `${next.year}-${String(next.month).padStart(2, '0')}`;
    const sp = new URLSearchParams(searchParams);
    sp.set('month', formatted);
    setSearchParams(sp);
  };

  const range = useMemo(() => rangeFor(at.year, at.month), [at.year, at.month]);
  const cal = useCalendar(validProjectId, range.since, range.until);
  const { schedule, reschedule, cancel } = useScheduleMutations(validProjectId);

  const [picked, setPicked] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [datePart, setDatePart] = useState<string | null>(today);
  const [timePart, setTimePart] = useState('10:00');
  const [formProblem, setFormProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  const cannotLoad =
    cal.error == null ? null : describeLoadFailure('일정', statusOf(cal.error));

  const cells = useMemo(
    () => monthGrid(at.year, at.month, cal.data ?? []),
    [at.year, at.month, cal.data],
  );
  const pickedCell = useMemo(
    () => (picked === null ? null : (cells.find((c) => c.date === picked) ?? null)),
    [cells, picked],
  );
  const monthItems = useMemo(() => itemsInMonth(cells), [cells]);
  const listed = pickedCell !== null ? pickedCell.items : monthItems;
  const lateCount = monthItems.filter((item) => isOverdue(item, today)).length;
  const empty = useMemo(() => emptyNote(cells, pickedCell), [cells, pickedCell]);

  const timeOptions = useMemo(() => {
    const list = TIME_SLOTS.includes(timePart)
      ? TIME_SLOTS
      : [...TIME_SLOTS, timePart].sort();
    return list.map((slot) => ({ value: slot, label: slot }));
  }, [timePart]);

  const mutationPending = schedule.isPending || reschedule.isPending || cancel.isPending;

  const resetForm = () => {
    setEditingId(null);
    setTitle('');
    setDatePart(picked ?? today);
    setTimePart('10:00');
    setFormProblem(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mutationPending) return;
    setNotice(null);
    if (title.trim() === '') {
      setFormProblem('회의 이름을 입력해 주세요.');
      titleInputRef.current?.focus();
      return;
    }
    if (datePart === null) {
      setFormProblem('회의 날짜를 골라 주세요.');
      return;
    }
    const instant = teamInstantOf(`${datePart}T${timePart}`);
    if (instant === null) {
      setFormProblem('회의 날짜와 시각을 다시 확인해 주세요.');
      return;
    }
    setFormProblem(null);

    if (editingId !== null) {
      reschedule.mutate(
        { meetingId: editingId, title: title.trim(), at: instant },
        {
          onSuccess: () => {
            setNotice('회의 일정을 고쳤습니다.');
            resetForm();
          },
          onError: (err) => {
            setFormProblem(describeActionFailure('일정 고치기', statusOf(err), detailOf(err)));
          },
        },
      );
      return;
    }

    schedule.mutate(
      { title: title.trim(), at: instant },
      {
        onSuccess: () => {
          setNotice('회의 일정을 잡았습니다.');
          resetForm();
        },
        onError: (err) => {
          setFormProblem(describeActionFailure('일정 잡기', statusOf(err), detailOf(err)));
        },
      },
    );
  };

  const handleCancelMeeting = (meetingId: number, itemTitle: string) => {
    if (!window.confirm(cancelMeetingConfirm(itemTitle))) return;
    setFormProblem(null);
    setNotice(null);
    cancel.mutate(meetingId, {
      onSuccess: () => {
        if (editingId === meetingId) resetForm();
        setNotice('일정을 물렀습니다.');
      },
      onError: (err) => {
        setFormProblem(describeActionFailure('일정 무르기', statusOf(err), detailOf(err)));
      },
    });
  };

  return (
    <AppShell
      title="일정"
      projectId={validProjectId}
      meta={
        <span className="meta-chips">
          <span className="meta-chip">
            이 달 일정 <strong className="num">{cannotLoad === null && cal.isSuccess ? monthItems.length : '—'}</strong>건
          </span>
          {cannotLoad === null && cal.isSuccess && lateCount > 0 && (
            <span className="meta-chip meta-chip--warn">
              지연 마감 <strong className="num">{lateCount}</strong>건
            </span>
          )}
        </span>
      }
      actions={
        <div className="appbar__actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setMonth(shiftMonth(at.year, at.month, -1));
              setPicked(null);
            }}
          >
            ‹ 지난달
          </button>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => {
              setMonth(currentYearMonth(today));
              setPicked(today);
            }}
          >
            이번 달
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setMonth(shiftMonth(at.year, at.month, 1));
              setPicked(null);
            }}
          >
            다음달 ›
          </button>
        </div>
      }
    >
      <div className="panes tf-cal-panes">
        {/* 왼쪽 — 월간 캘린더 격자 */}
        <section className="pane tf-cal-grid-pane">
          <div className="pane__head">
            <h2 className="pane__title">{describeMonth(at.year, at.month)}</h2>
            <span className="t12 muted">팀 달력 기준 (업무 마감일 · 예정·진행 회의)</span>
          </div>
          <div className="pane__body">
            {cannotLoad !== null ? (
              <Problem>{cannotLoad}</Problem>
            ) : cal.isPending ? (
              <p className="t13 muted">일정을 불러오는 중입니다…</p>
            ) : (
              <div className="tf-cal-grid" role="grid" aria-label={describeMonth(at.year, at.month)}>
                {WEEKDAYS.map((wd) => (
                  <div key={wd} className="tf-cal-wd" role="columnheader">
                    {wd}
                  </div>
                ))}
                {cells.map((cell) => {
                  const isToday = cell.date === today;
                  const isPicked = cell.date === picked;
                  const hasLate = cell.items.some((item) => isOverdue(item, today));
                  return (
                    <button
                      key={cell.date}
                      type="button"
                      className={`tf-cal-cell${cell.inMonth ? '' : ' is-out'}${isToday ? ' is-today' : ''}${isPicked ? ' is-picked' : ''}${hasLate ? ' has-late' : ''}`}
                      aria-label={dayAriaLabel(cell, today)}
                      aria-current={isPicked ? 'date' : undefined}
                      onClick={() => {
                        setPicked((prev) => (prev === cell.date ? null : cell.date));
                        if (editingId === null) setDatePart(cell.date);
                      }}
                    >
                      <span className="tf-cal-cell__top">
                        <span className="tf-cal-cell__num num">{cell.day}</span>
                        {isToday && <span className="tf-cal-cell__today">오늘</span>}
                      </span>
                      {cell.items.length > 0 && (
                        <span className={`tf-cal-cell__badge num${hasLate ? ' is-late' : ''}`}>
                          {hasLate ? `지연 ${cell.items.length}건` : `${cell.items.length}건`}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* 오른쪽 — 선택한 날 / 이 달 목록 + 회의 일정 잡기·고치기 */}
        <section className="pane tf-cal-side-pane">
          <div className="pane__head">
            <h2 className="pane__title">
              {pickedCell === null ? '이 달에 있는 일' : `${pickedCell.day}일에 있는 일`}
            </h2>
            {pickedCell !== null && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                style={{ marginLeft: 'auto' }}
                onClick={() => setPicked(null)}
              >
                이 달 전체 보기
              </button>
            )}
          </div>
          <div className="pane__body">
            {cannotLoad === null && cal.isSuccess && (
              <>
                {listed.length === 0 ? (
                  <div className="empty" style={{ marginBottom: 'var(--sp-5)' }}>
                    <p style={{ margin: '0 0 6px', fontWeight: 600 }}>{empty.what}</p>
                    <p className="t12 muted" style={{ margin: '0 0 4px' }}>{empty.why}</p>
                    <p className="t12 faint" style={{ margin: 0 }}>{empty.how}</p>
                  </div>
                ) : (
                  <ul className="tf-cal-list">
                    {listed.map((thing, idx) => {
                      const target = validProjectId !== undefined ? appHrefFor(thing, validProjectId) : null;
                      const late = isOverdue(thing, today);
                      return (
                        <li
                          key={`${thing.kind}-${thing.task_id ?? 0}-${thing.meeting_id ?? 0}-${idx}`}
                          className={`tf-cal-item${late ? ' is-late' : ''}${thing.done ? ' is-done' : ''}`}
                        >
                          <div className="tf-cal-item__meta">
                            <span className="num t12 muted">{dayOf(thing)}</span>
                            <span className={`tf-notice-kind${late ? ' is-urgent' : ''}`}>
                              {describeKind(thing.kind)}
                            </span>
                            {late && <span className="tf-cal-late-tag">지연</span>}
                            {thing.who !== null && <span className="t12 muted">{thing.who}</span>}
                          </div>
                          <div className="tf-cal-item__main">
                            {target !== null ? (
                              <Link to={target} className="tf-cal-item__link">
                                {thing.title}
                              </Link>
                            ) : (
                              <span className="tf-cal-item__title">{thing.title}</span>
                            )}
                            {canCancelMeeting(thing) && thing.meeting_id !== null && (
                              <div className="tf-row-actions">
                                <button
                                  type="button"
                                  className="btn btn--ghost btn--sm"
                                  disabled={mutationPending}
                                  onClick={() => {
                                    setEditingId(thing.meeting_id);
                                    setTitle(thing.title);
                                    const d = teamDateOf(thing.at);
                                    const dt = teamDateTime(thing.at);
                                    setDatePart(d);
                                    setTimePart(dt !== null ? (dt.split(' ')[1] ?? '10:00') : '10:00');
                                    setFormProblem(null);
                                    setNotice(null);
                                    titleInputRef.current?.focus();
                                  }}
                                >
                                  고치기
                                </button>
                                <button
                                  type="button"
                                  className="btn btn--ghost btn--sm"
                                  disabled={mutationPending}
                                  onClick={() => handleCancelMeeting(thing.meeting_id!, thing.title)}
                                >
                                  무르기
                                </button>
                              </div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}

                <div className="tf-cal-form-card">
                  <h3 className="sec__title" style={{ marginTop: 0 }}>
                    {editingId !== null ? '회의 일정 고치기' : '새 회의 일정 잡기'}
                  </h3>
                  <p className="t12 muted" style={{ margin: '0 0 var(--sp-3)' }}>
                    일정을 잡아만 두며 녹음은 시작되지 않습니다. 실제 회의는 로비에서 동의 후 엽니다.
                  </p>
                  {formProblem !== null && <Problem>{formProblem}</Problem>}
                  {notice !== null && (
                    <p className="status-ok t13" role="status" style={{ margin: '0 0 var(--sp-3)' }}>
                      {notice}
                    </p>
                  )}
                  <form className="tf-cal-form" noValidate onSubmit={handleSubmit}>
                    <label className="field">
                      <span className="field__label">회의 이름</span>
                      <input
                        ref={titleInputRef}
                        type="text"
                        className="input"
                        maxLength={200}
                        placeholder="예: 2주차 스프린트 점검"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                      />
                    </label>
                    <div className="tf-cal-form__row">
                      <div className="field" style={{ flex: '1 1 160px' }}>
                        <span className="field__label">날짜 (팀 달력)</span>
                        <DatePicker
                          value={datePart}
                          onChange={setDatePart}
                          ariaLabel="회의 날짜"
                        />
                      </div>
                      <div className="field" style={{ flex: '0 0 120px' }}>
                        <span className="field__label">시각</span>
                        <Picker
                          value={timePart}
                          onChange={(next) => {
                            if (next !== null) setTimePart(next);
                          }}
                          options={timeOptions}
                          emptyLabel="10:00"
                          ariaLabel="회의 시각"
                        />
                      </div>
                    </div>
                    <div className="tf-row-actions">
                      <button type="submit" className="btn btn--primary btn--sm" disabled={mutationPending}>
                        {mutationPending
                          ? '저장 중…'
                          : editingId !== null
                            ? '일정 고치기'
                            : '일정 잡기'}
                      </button>
                      {editingId !== null && (
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={mutationPending}
                          onClick={resetForm}
                        >
                          고치기 취소
                        </button>
                      )}
                    </div>
                  </form>
                </div>
              </>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
