import { useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { Disclosure } from '../components/Disclosure.tsx';
import { EvidenceChip } from '../components/EvidenceChip.tsx';
import { Conditions, describeConditions, type Condition } from '../components/Conditions.tsx';
import { Why } from '../components/Why.tsx';
import { Picker } from '../components/Picker.tsx';
import { DatePicker } from '../components/DatePicker.tsx';
import {
  useCandidates,
  useMeeting,
  useMeetingMembers,
  useSubmitReview,
  useTimeline,
} from '../api/hooks.ts';
import {
  approvalBlockers,
  attentionReasons,
  buildReviewPayload,
  effectiveAssignee,
  effectiveDeadline,
  canSubmit,
  describeSubmitResult,
  emptyDraft,
  laneCounts,
  reviewLane,
  sortForReview,
  summarize,
  type Candidate,
  type Draft,
  type ReviewContext,
} from '@lib/review/candidates.ts';
import { audioNote, emptyTimelineNote, timelineRows, trackAudioUrl, type TimelineRow } from '@lib/review/timeline.ts';
import { missingNote, emptyEvidenceNote, withContext } from '@lib/review/evidence.ts';
import { agendaItems, issueViews } from '@lib/review/minutes.ts';
import { todayInTeamCalendar } from '@lib/time/calendar.ts';

// 업무 후보 검토 — 3판 (지시서 07).
//
// 이 화면의 단 하나의 목적은 **후보를 승인/거절하는 것**입니다. 전사는
// 근거를 확인할 때 참조하는 것이라 옆에 둡니다 — 위에 쌓지 않습니다.
// AI 가 만든 것(점선 위)과 사람이 정하는 것(점선 아래)을 형태로 가릅니다.

function useDraftMap() {
  const [drafts, setDrafts] = useState<ReadonlyMap<number, Draft>>(new Map());
  const update = (id: number, patch: Partial<Draft>) => {
    setDrafts((prev) => {
      const next = new Map(prev);
      next.set(id, { ...(prev.get(id) ?? emptyDraft()), ...patch });
      return next;
    });
  };
  return { drafts, update };
}

export default function Review() {
  const params = useParams();
  const meetingId = Number(params['meetingId']);
  const meeting = useMeeting(meetingId);
  const candidatesQuery = useCandidates(meetingId);
  const timeline = useTimeline(meetingId);
  const membersQuery = useMeetingMembers(meetingId);
  const submit = useSubmitReview(meetingId);

  const { drafts, update } = useDraftMap();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [submitNote, setSubmitNote] = useState<string | null>(null);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const listRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingId, setPlayingId] = useState<number | null>(null);

  const candidates = useMemo(
    () => sortForReview(candidatesQuery.data ?? []),
    [candidatesQuery.data],
  );
  const members = membersQuery.data ?? [];
  const context: ReviewContext = useMemo(
    () => ({ memberIds: members.map((m) => m.user_id), today: todayInTeamCalendar() }),
    [members],
  );

  const rows: TimelineRow[] = useMemo(
    () => timelineRows(timeline.data?.utterances ?? [], meeting.data?.findings ?? []),
    [timeline.data, meeting.data],
  );
  const clipByUtterance = useMemo(() => {
    const map = new Map<number, { trackId: number; startSec: number; endSec: number }>();
    for (const row of rows) {
      if (row.kind === 'utterance' && row.clip !== null) map.set(row.view.id, row.clip);
    }
    return map;
  }, [rows]);

  // 어느 발화가 근거로 쓰였는가 — 전사에 인디고 점을 찍는 근거.
  const evidenceIds = useMemo(() => {
    const all = new Set<number>();
    for (const c of candidates) for (const id of c.evidence_utterance_ids) all.add(id);
    return all;
  }, [candidates]);
  const selected = candidates.find((c) => c.id === selectedId) ?? null;
  const selectedEvidence = useMemo(
    () => new Set(selected?.evidence_utterance_ids ?? []),
    [selected],
  );

  const reduceMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const select = (candidate: Candidate | null) => {
    setSelectedId(candidate?.id ?? null);
    const first = candidate?.evidence_utterance_ids[0];
    if (first !== undefined) {
      rowRefs.current.get(first)?.scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block: 'center',
      });
    }
  };

  // 키보드 순회 — J/K(또는 화살표)로 다음/이전, Enter 등록, Esc 해제.
  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (candidates.length === 0) return;
    const idx = candidates.findIndex((c) => c.id === selectedId);
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      select(candidates[Math.min(idx + 1, candidates.length - 1)] ?? null);
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      select(candidates[Math.max(idx - 1, 0)] ?? null);
    } else if (e.key === 'Escape') {
      select(null);
    } else if (e.key === 'Enter' && selected) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
      e.preventDefault();
      const draft = drafts.get(selected.id) ?? emptyDraft();
      if (approvalBlockers(selected, draft, context).length === 0) {
        update(selected.id, { decision: 'approve' });
      }
    }
  };

  const playClip = (utteranceId: number) => {
    const clip = clipByUtterance.get(utteranceId);
    const audio = audioRef.current;
    if (!clip || !audio) return;
    if (playingId === utteranceId) {
      audio.pause();
      setPlayingId(null);
      return;
    }
    audio.src = trackAudioUrl('', meetingId, clip.trackId);
    audio.currentTime = clip.startSec;
    audio.ontimeupdate = () => {
      if (audio.currentTime >= clip.endSec) {
        audio.pause();
        setPlayingId(null);
      }
    };
    void audio.play();
    setPlayingId(utteranceId);
  };

  const lanes = laneCounts(candidates, drafts);
  const summary = summarize(candidates, drafts, context);
  const submitBlockedReason =
    lanes.pending > 0
      ? `${lanes.all}건 중 ${lanes.pending}건이 아직 처리되지 않았습니다`
      : !canSubmit(summary)
        ? summary.blocked > 0
          ? '승인 표시된 후보 중 조건이 안 채워진 것이 있습니다'
          : '결정한 후보가 없습니다'
        : null;

  const onSubmit = () => {
    try {
      const payload = buildReviewPayload(candidates, drafts, context);
      submit.mutate(payload, {
        onSuccess: (result) => {
          setSubmitNote(describeSubmitResult(result.approved_count, result.approved_task_ids));
          setSelectedId(null);
        },
      });
    } catch (e) {
      setSubmitNote(e instanceof Error ? e.message : '제출하지 못했습니다');
    }
  };

  const title = meeting.data?.title ?? '회의 검토';
  const note = audioNote(timeline.data?.has_audio ?? false, rows);

  return (
    <AppShell
      title={`${title} · 업무 후보 ${lanes.all}건`}
      projectId={meeting.data?.project_id}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-4)' }}>
          {/* v2 F10 — 일괄 승인 기능은 **만들지 않습니다.** 이 버튼은
              후보를 하나씩 다 처리한 뒤에야 열리는 마무리 버튼이고,
              라벨도 그렇게 읽혀야 합니다(`3건 모두 처리하고 제출` → `검토
              끝내기`). 사람이 하나씩 승인한다는 것이 이 제품의 안전장치라,
              그걸 건너뛰는 길은 없습니다. */}
          {submitBlockedReason !== null && (
            <span className="disabled-reason" style={{ margin: 0 }} id="submit-reason">
              {lanes.pending > 0 ? `${lanes.pending}건 남음` : submitBlockedReason}
            </span>
          )}
          {/* ⚠️ `disabled` 가 아니라 `aria-disabled` 입니다 — 카드의 `등록`
              버튼과 같은 규칙입니다. 비활성 버튼은 포커스를 못 받아 낭독기에
              사유를 못 전합니다(GOV.UK). 누르면 아직 안 정한 첫 후보로
              데려다 줍니다. */}
          <button
            type="button"
            className={`btn btn--primary${submitBlockedReason !== null ? ' btn--unmet' : ''}`}
            aria-disabled={submitBlockedReason !== null || submit.isPending}
            aria-describedby={submitBlockedReason !== null ? 'submit-reason' : undefined}
            onClick={() => {
              if (submit.isPending) return;
              if (submitBlockedReason !== null) {
                const first = candidates.find(
                  (c) => (drafts.get(c.id)?.decision ?? null) === null,
                );
                if (first !== undefined) {
                  setSelectedId(first.id);
                  document.getElementById(`cand-${first.id}`)?.scrollIntoView({ block: 'center' });
                }
                return;
              }
              onSubmit();
            }}
          >
            검토 끝내기
          </button>
        </div>
      }
    >
      <audio ref={audioRef} hidden />
      <div className="panes">
        {/* 좌 — 회의 내용. 통계·요약은 접고 전사가 주인공. */}
        <section className="pane pane--transcript" aria-label="회의 내용">
          <div className="pane__head">
            <h2 className="pane__title">회의 내용</h2>
            <span className="pane__count">{rows.length}</span>
          </div>
          <div className="pane__body">
            {meeting.data && (
              <>
                <Disclosure
                  summary={`요약 · 다음 안건 ${agendaItems(meeting.data.next_agenda).length} · 답 안 난 것 ${issueViews(meeting.data.unresolved_issues).length}`}
                >
                  <p>{meeting.data.summary ?? '요약이 아직 없습니다 — 처리가 끝나면 여기 담깁니다.'}</p>
                  {agendaItems(meeting.data.next_agenda).map((item) => (
                    <p key={item}>다음 안건 — {item}</p>
                  ))}
                  {issueViews(meeting.data.unresolved_issues).map((issue) => (
                    <p key={issue.content}>
                      답 안 난 것 — {issue.content}
                      {issue.at !== null && (
                        <>
                          {' '}
                          (<span className="num">{issue.at}</span>)
                        </>
                      )}{' '}
                      · 근거 {issue.evidenceCount}건
                    </p>
                  ))}
                </Disclosure>
                {meeting.data.findings.length > 0 && (
                  <Disclosure summary={`눈에 띈 것 ${meeting.data.findings.length}건`}>
                    <p className="t12 muted">
                      규칙 기반 관찰입니다 — 문제인지 아닌지는 팀이 정합니다.
                    </p>
                  </Disclosure>
                )}
              </>
            )}
            {note !== null && (
              <p className="notice">
                소리 없음
                <Why about="이 회의의 소리" lines={[note]} />
              </p>
            )}
            {rows.length === 0 && <div className="empty">{emptyTimelineNote()}</div>}
            {rows.map((row, i) =>
              row.kind === 'finding' ? (
                <div className="tlrow" key={`f-${i}`}>
                  <span className="tlrow__at num">{row.view.at ?? ''}</span>
                  <div>
                    <span className="tlrow__who">
                      {row.view.title}
                      {row.view.what !== null && ` — ${row.view.what}`}
                    </span>
                  </div>
                  <span />
                </div>
              ) : (
                <div
                  className={[
                    'tlrow',
                    evidenceIds.has(row.view.id) ? 'tlrow--evidence' : '',
                    selectedEvidence.has(row.view.id) ? 'tlrow--focus' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  key={row.view.id}
                  ref={(el) => {
                    if (el) rowRefs.current.set(row.view.id, el);
                    else rowRefs.current.delete(row.view.id);
                  }}
                >
                  <span className="tlrow__at num">{row.view.at ?? ''}</span>
                  <div>
                    <span className="tlrow__who">
                      {row.view.speaker}
                      {row.view.type !== null && ` · ${row.view.type}`}
                      {row.view.overlap && ' · 동시 발화'}
                    </span>
                    <p className="tlrow__text">{row.view.text}</p>
                    {row.view.speakerNote !== null && (
                      <span className="t12 crow__flags">{row.view.speakerNote}</span>
                    )}
                    {row.clip !== null && (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => playClip(row.view.id)}
                      >
                        {playingId === row.view.id ? '⏹ 멈춤' : '▶ 듣기'}
                      </button>
                    )}
                  </div>
                  <span className="tlrow__dot" aria-hidden="true" />
                </div>
              ),
            )}
          </div>
        </section>

        {/* 중 — 후보. 주 작업. */}
        <section className="pane pane--candidates" aria-label="업무 후보">
          <div className="pane__head">
            <h2 className="pane__title">후보</h2>
            <span className="pane__count">검토 필요 {lanes.pending}</span>
            <span className="pane__count">등록 {lanes.approve} · 거절 {lanes.reject}</span>
          </div>
          <div className="pane__body" ref={listRef} onKeyDown={onListKeyDown}>
            {submitNote !== null && (
              <p className="notice" role="status">
                {submitNote}
              </p>
            )}
            {candidates.length === 0 && !candidatesQuery.isPending && (
              <div className="empty">
                검토할 후보가 없습니다 — 회의 처리가 끝나면 AI 초안이 여기 올라옵니다.
              </div>
            )}
            {candidates.map((candidate) => {
              const draft = drafts.get(candidate.id) ?? emptyDraft();
              const lane = reviewLane(candidate, draft);
              const blockers = approvalBlockers(candidate, draft, context);
              const noEvidence = candidate.evidence_utterance_ids.length === 0;
              const blocked = blockers.length > 0;
              // 문장 셋이 하던 말을 칩 셋이 합니다. 근거는 영구 조건이라
              // 못 채우면 이 후보는 등록될 수 없습니다 (불변식).
              const conditions: Condition[] = [
                {
                  label: `근거 ${candidate.evidence_utterance_ids.length}`,
                  met: !noEvidence,
                },
                { label: '담당자', met: effectiveAssignee(candidate, draft) !== null },
                {
                  label: '마감',
                  met: (effectiveDeadline(candidate, draft) ?? '') !== '',
                },
              ];
              return (
                <article
                  key={candidate.id}
                  id={`cand-${candidate.id}`}
                  className={`cand${candidate.id === selectedId ? ' cand--selected' : ''}`}
                  tabIndex={0}
                  onClick={() => select(candidate)}
                  onFocus={() => setSelectedId(candidate.id)}
                  aria-current={candidate.id === selectedId ? 'true' : undefined}
                >
                  <div className="cand__head">
                    <span className="cand__source">AI 초안</span>
                    {lane === 'approve' && <span className="cand__state cand__state--approve">등록 표시됨</span>}
                    {lane === 'reject' && <span className="cand__state cand__state--reject">거절 표시됨</span>}
                    <span className="cand__conf">
                      확신 {Math.round(candidate.confidence * 100)}%
                      {/* "왜 확신이 낮은가" 는 **지우지 않습니다** — 원문 그대로
                          한 번의 동작으로 닿습니다. 카드마다 같은 문장을
                          펼쳐 두면 셋이면 186자가 되고, 늘 있는 글자는
                          배경이 되어 아무도 안 읽습니다. */}
                      <Why
                        about={`${candidate.title} — 확신이 낮은 이유`}
                        lines={attentionReasons(candidate)}
                      />
                    </span>
                  </div>
                  <h3 className="cand__title">{candidate.title}</h3>
                  <div className="cand__chips">
                    {noEvidence ? (
                      <span className="chip chip--unknown">⚠ 근거 없음 — 등록할 수 없습니다</span>
                    ) : (
                      candidate.evidence_utterance_ids.map((id) => (
                        <EvidenceChip
                          key={id}
                          id={`#${id}`}
                          onOpen={() => select(candidate)}
                        />
                      ))
                    )}
                  </div>
                  {/* 점선 아래 — 여기부터 사람의 몫 */}
                  <hr className="cand__divider" />
                  <div
                    className="cand__controls"
                    id={`cand-fields-${candidate.id}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <label className="field">
                      <span className="field__label">
                        담당자
                        {candidate.assignee_id === null && candidate.assignee_hint && (
                          <> — 회의에서는 “{candidate.assignee_hint}”</>
                        )}
                      </span>
                      {/* v2 F8 — 네이티브 `<select>` 는 브라우저가 그려서
                          나머지 UI 와 톤이 어긋나고, 다크에서 목록만 밝게
                          떴습니다. 직접 만들지 않고 Radix 를 씁니다 —
                          키보드·타이핑 검색·낭독기를 다시 만들면 대개 덜
                          만들게 됩니다. */}
                      <Picker
                        value={
                          effectiveAssignee(candidate, draft) === null
                            ? null
                            : String(effectiveAssignee(candidate, draft))
                        }
                        onChange={(next) =>
                          update(candidate.id, {
                            assigneeOverride: next === null ? null : Number(next),
                          })
                        }
                        options={members.map((m) => ({ value: String(m.user_id), label: m.name }))}
                        emptyLabel="미지정"
                        ariaLabel={`${candidate.title} — 담당자`}
                      />
                    </label>
                    <label className="field">
                      <span className="field__label">마감</span>
                      {/* v2 F7 — `mm/dd/yyyy` 는 `lang` 으로도 `locale` 로도
                          못 바꿉니다. 브라우저 UI 언어를 따르기 때문입니다. */}
                      <DatePicker
                        value={effectiveDeadline(candidate, draft)}
                        onChange={(next) => update(candidate.id, { deadlineOverride: next })}
                        ariaLabel={`${candidate.title} — 마감`}
                      />
                    </label>
                  </div>
                  <div className="cand__actions" onClick={(e) => e.stopPropagation()}>
                    {/* ⚠️ `disabled` 가 아니라 `aria-disabled` 입니다. 비활성
                        버튼은 포커스를 못 받아 낭독기에 사유를 못 전합니다
                        (GOV.UK). 누르면 못 채운 칸으로 데려다 줍니다. */}
                    <button
                      type="button"
                      className={`btn btn--primary btn--sm${blocked ? ' btn--unmet' : ''}`}
                      aria-disabled={blocked}
                      aria-describedby={blocked ? `conds-${candidate.id}` : undefined}
                      title={blocked ? describeConditions(conditions) : undefined}
                      onClick={() => {
                        if (blocked) {
                          (
                            document.getElementById(`cand-fields-${candidate.id}`)
                              ?.querySelector<HTMLElement>('select, input')
                          )?.focus();
                          return;
                        }
                        update(candidate.id, { decision: 'approve' });
                      }}
                    >
                      등록
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => update(candidate.id, { decision: 'pending' })}
                    >
                      나중에
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => update(candidate.id, { decision: 'reject' })}
                    >
                      거절
                    </button>
                    {lane === 'pending' && (
                      <Conditions items={conditions} id={`conds-${candidate.id}`} />
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        {/* 우 — 선택된 후보의 근거만. */}
        <section className="pane pane--evidence" aria-label="근거">
          <div className="pane__head">
            <h2 className="pane__title">근거</h2>
            {selected !== null && (
              <span className="pane__count">{selected.evidence_utterance_ids.length}건</span>
            )}
          </div>
          <div className="pane__body">
            {selected === null ? (
              <div className="empty">후보를 고르면 근거 발화가 여기 나옵니다.</div>
            ) : (
              (() => {
                const asked = selected.evidence_utterance_ids;
                // 이 회의의 발화를 화면 순서대로. 근거 창을 뜰 바탕입니다.
                const byId = new Map(
                  rows.flatMap((row) => (row.kind === 'utterance' ? [[row.view.id, row.view] as const] : [])),
                );
                const missing = missingNote(
                  asked,
                  [...byId.keys()].filter((id) => selectedEvidence.has(id)).map((id) => ({ id }) as never),
                );
                if (![...byId.keys()].some((id) => selectedEvidence.has(id))) {
                  return <div className="empty">{emptyEvidenceNote(asked)}</div>;
                }
                // ⚠️ **근거만 떼어 놓으면 판단할 수 없습니다** (v2 F5).
                // "금요일까지 만들기로 하죠" 한 줄은 합의인지 반문인지
                // 구분이 안 됩니다. 앞뒤 두 건씩을 함께 놓고, 근거인 것만
                // 인디고로 표시합니다. 무엇을 고를지는 `@lib` 이 정합니다.
                const picks = withContext([...byId.keys()], asked, 2);
                return (
                  <>
                    {picks.map((pick) => {
                      const view = byId.get(pick.id);
                      if (view === undefined) return null;
                      return (
                        <div
                          className={`evrow${pick.isEvidence ? ' evrow--cited' : ' evrow--around'}`}
                          key={view.id}
                        >
                          <div className="evrow__meta">
                            <span className="num">발화 #{view.id}</span>
                            {view.at !== null && <span className="num">{view.at}</span>}
                            <span>
                              {view.speaker}
                              {view.type !== null && ` · ${view.type}`}
                            </span>
                          </div>
                          <p className="evrow__text">“{view.text}”</p>
                          {pick.isEvidence && view.speakerNote !== null && (
                            <p className="evrow__note">{view.speakerNote}</p>
                          )}
                        </div>
                      );
                    })}
                    {missing !== null && <p className="notice">{missing}</p>}
                  </>
                );
              })()
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
