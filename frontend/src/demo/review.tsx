/**
 * 업무 후보 승인 화면 — **React 로 옮긴 첫 화면 전체** (docs/19 §24).
 *
 * docs/03 §3 — "AI가 만든 업무는 후보이고, 사람이 승인해야 실제 tasks 가 된다."
 * 이 화면이 그 안전장치의 사람 쪽 끝이다.
 *
 * ## ⚠️ 옮기면서 지킨 것
 *
 * **판단은 하나도 여기로 오지 않았습니다.** `lib/review/candidates.ts` 의
 * `approvalBlockers`·`blockerLine`·`reviewLane`·`laneCounts`·
 * `buildReviewPayload` 를 그대로 부릅니다 — 그쪽에는 테스트 79개가
 * 붙어 있고, 화면 코드에는 자동 테스트가 없습니다. 판단이 이리로 새면
 * 그만큼 검증 밖으로 나갑니다.
 *
 * CSS 클래스 이름도 그대로입니다. 브리프대로 맞춰 놓은 판형을
 * 스택을 옮기면서 다시 흔들 이유가 없습니다.
 */

import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import {
  LOW_CONFIDENCE,
  approvalBlockers,
  attentionReasons,
  blockerLine,
  buildReviewPayload,
  canSubmit,
  describeBlocker,
  describeSubmitResult,
  effectiveAssignee,
  effectiveDeadline,
  effectiveTitle,
  emptyDraft,
  laneCounts,
  reviewLane,
  sortForReview,
  summarize,
  type Candidate,
  type Draft,
  type Lane,
  type ReviewContext,
} from '../lib/review/candidates.ts';
import { iconSvg } from '../lib/nav/icons.ts';
import { isSessionExpired, loginUrlFor, safeApiBase, type Me } from '../lib/auth/session.ts';
import { describeUnexpected, tryGet, trySend, unreachableText } from '../lib/http/send.ts';
import { emptyHtml, type EmptyState } from '../lib/ui/empty.ts';
import { Byline, RawHtml } from './parts.tsx';
import { failureHtml } from '../lib/ui/failure.ts';
import { whileLoading } from '../lib/ui/pending.ts';
import { rows as skeletonRows } from '../lib/ui/skeleton.ts';
import {
  agendaItems,
  hasExtraMinutes,
  issueViews,
  type UnresolvedIssue,
} from '../lib/review/minutes.ts';
import { pendingNote, typeCounts, type TypeCount } from '../lib/review/labels.ts';
import { findingViews, type Finding } from '../lib/review/findings.ts';
import { todayInTeamCalendar } from '../lib/time/calendar.ts';
import { mountEvidence, openEvidence } from './evidence.tsx';
import { renderNav } from './nav.ts';
import { bootApp } from './pwa.ts';

interface Member {
  user_id: number;
  name: string;
  role_shares: Record<string, number>;
}

interface MeetingInfo {
  title: string | null;
  status: string;
  summary: string | null;
  next_agenda: string[];
  unresolved_issues: UnresolvedIssue[];
  /** 비효율 구간 (§12). 없으면 빈 배열 — 옛 서버면 아예 안 옵니다. */
  findings?: Finding[];
}

const params = new URLSearchParams(location.search);
// ⚠️ 주소창의 `?api=` 를 그대로 쓰면 **비밀번호와 회의 음성이 어디로
// 가는지**를 링크 하나로 바꿀 수 있다. safeApiBase 가 진짜 도메인에서는
// 무시하고, 로컬 화면에서 로컬 서버일 때만 통과시킨다.
const apiBase = safeApiBase(params.get('api'), location.origin);
const meetingId = Number(params.get('meeting') ?? '1');

const get = (path: string): Promise<Response | null> => tryGet(`${apiBase}${path}`);

function goToLogin(): void {
  location.href = loginUrlFor(location.pathname + location.search);
}

interface Loaded {
  candidates: Candidate[];
  members: Member[];
  meeting: MeetingInfo;
  context: ReviewContext;
}

type Screen =
  | { k: 'loading' }
  | { k: 'unreachable' }
  | { k: 'error' }
  | { k: 'ok'; data: Loaded };

// ══════════════════════════════════════════════════════════════
// 조각들
// ══════════════════════════════════════════════════════════════

/** 아이콘. `iconSvg` 는 상수 문자열만 돌려줍니다 (주입 통로 아님). */
function Icon({ name }: { name: 'person' | 'calendar' }) {
  return <span className="ico" dangerouslySetInnerHTML={{ __html: iconSvg(name) }} />;
}

/**
 * 회의 맥락 — 접힌 한 줄 (브리프 §6).
 *
 * ⚠️ 회의록이 하나도 없으면 **상자 자체가 없습니다.** 접힌 빈 상자는
 * 눌러 볼 때까지 비었는지 알 수 없습니다.
 */
function Brief({ meeting }: { meeting: MeetingInfo }) {
  const agenda = agendaItems(meeting.next_agenda ?? []);
  const issues = issueViews(meeting.unresolved_issues ?? []);
  const summary = meeting.summary ?? '';
  const extra = hasExtraMinutes({
    next_agenda: meeting.next_agenda ?? [],
    unresolved_issues: meeting.unresolved_issues ?? [],
  });
  if (!extra && summary === '') return null;

  // ⚠️ 숫자를 **지어내지 않습니다.** 있는 것만 셉니다.
  const parts: string[] = [];
  if (summary !== '') parts.push('회의 요약');
  if (agenda.length > 0) parts.push(`다음 안건 ${agenda.length}`);
  if (issues.length > 0) parts.push(`답 안 난 것 ${issues.length}`);

  return (
    <details className="brief">
      <summary>
        <span className="brief-line">{parts.join(' · ')}</span>
        <span className="brief-cta">회의 내용 보기</span>
      </summary>
      <div className="brief-body">
        {summary !== '' && <p id="meeting-summary">{summary}</p>}
        {agenda.length > 0 && (
          <>
            <h2 className="minutes-head">다음 회의에서 다룰 안건</h2>
            <ul id="agenda">
              {agenda.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </>
        )}
        {issues.length > 0 && (
          <>
            <h2 className="minutes-head">회의에서 답이 안 난 것</h2>
            <ul id="issues">
              {issues.map((view, i) => (
                <li key={i}>
                  {view.at !== null && <span className="at">{view.at}</span>}
                  <span className="what">{view.content}</span>
                  {/* ⚠️ 근거 0건도 적습니다. 감추면 근거 없는 사안이
                      근거 있는 것과 똑같아 보입니다. */}
                  {view.evidenceCount === 0 ? (
                    <span className="why none">근거 발화 없음</span>
                  ) : (
                    <span className="why">근거 발화 {view.evidenceCount}건</span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </details>
  );
}

const LANE_TABS: [Lane | 'all', string][] = [
  ['all', '전체'],
  ['pending', '검토 필요'],
  ['approve', '등록'],
  ['reject', '거절'],
];

/**
 * 후보 카드 하나.
 *
 * 정보 순서는 브리프 §10 그대로입니다 —
 * 제목 → 확신도 → 담당자·마감일 → 근거 → 막는 것 → 결정.
 */
function CandidateCard({
  candidate,
  draft,
  members,
  context,
  onChange,
}: {
  candidate: Candidate;
  draft: Draft;
  members: Member[];
  context: ReviewContext;
  onChange: (patch: Partial<Draft>) => void;
}) {
  const blockers = approvalBlockers(candidate, draft, context);
  const reasons = attentionReasons(candidate);
  const decided = candidate.review_status !== 'pending';
  const low = candidate.confidence < LOW_CONFIDENCE;
  const assignee = effectiveAssignee(candidate, draft);
  const deadline = effectiveDeadline(candidate, draft) ?? '';
  const check = blockerLine(blockers);
  const evidence = candidate.evidence_utterance_ids;
  const title = effectiveTitle(candidate, draft);
  const known = members.some((m) => m.user_id === assignee);

  return (
    <article className="cand" data-decision={draft.decision} data-done={decided ? '1' : '0'}>
      <div className="cand-top">
        <input
          className="title"
          type="text"
          aria-label="업무 제목"
          value={title}
          disabled={decided}
          onChange={(e) => onChange({ titleOverride: e.target.value })}
        />
        {/* ⭐ 48px `34%` 를 걷어낸 자리 (브리프 §11). 확신도는 제목을
            **읽고 나서** 참고하는 값입니다. */}
        <span className={low ? 'badge low' : 'badge'} title="AI 확신도">
          {(candidate.confidence * 100).toFixed(0)}%
        </span>
      </div>

      <div className="fields">
        <label className="field sel" data-empty={assignee === null ? '1' : '0'}>
          <Icon name="person" />
          <span className="visually-hidden">담당자</span>
          <select
            className="assignee"
            disabled={decided}
            value={assignee === null ? '' : String(assignee)}
            onChange={(e) =>
              onChange({ assigneeOverride: e.target.value === '' ? null : Number(e.target.value) })
            }
          >
            <option value="">담당자 미지정</option>
            {/* 팀에서 빠졌거나 잘못 들어온 담당자도 반드시 보여준다.
                명단에 없다고 조용히 "미지정" 으로 그리면, 사람은 비어
                있는 줄 알고 그냥 승인해 버린다. */}
            {assignee !== null && !known && (
              <option value={assignee}>알 수 없는 사용자 #{assignee}</option>
            )}
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field" data-empty={deadline === '' ? '1' : '0'}>
          <Icon name="calendar" />
          <span className="visually-hidden">마감일</span>
          <input
            className="deadline"
            type="date"
            value={deadline}
            disabled={decided}
            onChange={(e) => onChange({ deadlineOverride: e.target.value === '' ? null : e.target.value })}
          />
        </label>

        {/* ⭐ 누를 수 있습니다 (docs/19 §24). 오랫동안 이 자리는
            `근거 #5` 라고 **적기만** 했습니다. */}
        {evidence.length === 0 ? (
          <span className="src none">근거 없음</span>
        ) : (
          <button type="button" className="src" onClick={() => openEvidence(evidence, title)}>
            근거 #{evidence.join(', #')}
          </button>
        )}
      </div>

      {/* 회의에서 부른 이름을 명단에서 못 찾았을 때만. */}
      {candidate.assignee_hint && assignee === null && (
        <p className="hint">
          회의에서는 <strong>{candidate.assignee_hint}</strong> 라고 했습니다 — 명단에서 찾지
          못했습니다
        </p>
      )}

      {/* ⭐ 막는 이유는 한 줄 (브리프 §13). 안 채운 칸은 흙빛. */}
      {check.tone !== 'none' && (
        <p className="check" data-tone={check.tone}>
          {check.text}
        </p>
      )}

      {/* 서버가 무엇을 확신하지 못했는가. 승인을 막지 않으므로 접습니다 —
          접어도 **한 번의 클릭 안에** 있습니다. */}
      {reasons.length > 0 && (
        <details className="why-not">
          <summary>확신하지 못한 이유 {reasons.length}건</summary>
          <ul>
            {reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </details>
      )}

      {decided ? (
        <p className="done">
          이미 {candidate.review_status === 'approved' ? '등록' : '거절'}된 후보입니다
        </p>
      ) : (
        <>
          <div className="acts">
            <button
              className={draft.decision === 'approve' ? 'approve on' : 'approve'}
              disabled={blockers.length > 0}
              onClick={() => onChange({ decision: 'approve' })}
            >
              업무로 등록
            </button>
            <button
              className={draft.decision === 'pending' ? 'clear on' : 'clear'}
              onClick={() => onChange({ decision: 'pending' })}
            >
              나중에 검토
            </button>
            <button
              className={draft.decision === 'reject' ? 'reject on' : 'reject'}
              onClick={() => onChange({ decision: 'reject' })}
            >
              거절
            </button>
          </div>
          {/* ⭐ 메모는 **결정한 뒤에만**. 이 칸의 문구가 "왜 이렇게
              결정했는지" 라 결정 전에는 설명할 것이 없습니다. */}
          {draft.decision !== 'pending' && (
            <input
              className="memo"
              type="text"
              aria-label="메모"
              placeholder="메모 (선택) — 왜 이렇게 결정했는지"
              value={draft.note ?? ''}
              onChange={(e) => onChange({ note: e.target.value })}
            />
          )}
        </>
      )}
    </article>
  );
}

/** 후보가 0건일 때, **회의 상태에 따라** 다른 말을 한다. */
function emptyReviewState(status: string): EmptyState {
  const what = '여기에는 회의에서 뽑은 업무 후보가 나옵니다.';
  if (status === 'queued' || status === 'processing') {
    return {
      what,
      why: '녹음을 아직 처리하는 중입니다.',
      how: '끝나면 여기에 후보가 나옵니다. 잠시 뒤에 새로고침하세요.',
    };
  }
  if (status === 'failed') {
    return {
      what,
      why: '녹음 처리에 실패해서 후보를 만들지 못했습니다.',
      how: '로비에서 트랙이 온전한지 확인하세요 — 끊긴 구간이 많으면 처리가 실패합니다.',
      action: { label: '트랙 상태 보기', href: `/lobby.html?meeting=${meetingId}` },
    };
  }
  if (status === 'confirmed') {
    return {
      what,
      why: '이 회의의 후보는 모두 검토를 마쳤습니다.',
      how: '승인한 업무는 칸반에 있습니다.',
      action: { label: '칸반 보기', href: `/kanban.html?meeting=${meetingId}` },
    };
  }
  // needs_review 인데 0건 — 처리는 끝났고 뽑을 게 없었습니다.
  // **고장이 아니라 결과입니다.**
  return {
    what,
    why: '처리는 끝났는데 업무로 뽑을 만한 발언이 없었습니다 — 고장이 아닙니다.',
    how: '회의에서 누가·무엇을·언제까지 하기로 했는지 말하면 그 발언이 후보가 됩니다.',
    action: { label: '칸반 보기', href: `/kanban.html?meeting=${meetingId}` },
  };
}

// ══════════════════════════════════════════════════════════════
// 화면
// ══════════════════════════════════════════════════════════════

interface TypeTally {
  labels: Record<string, number>;
  unclassified: number;
  total: number;
}

/**
 * 이 회의에서 무슨 말이 오갔나 (요구사항 정의서 §10 · `REVIEW-005`).
 *
 * ## ⚠️ 사람 이름이 여기 없습니다
 *
 * 회의 단위로만 셉니다. 사람별로 세면 그 순간 "누가 제일 많이 제안했나"
 * 표가 되고, 그건 이 저장소가 금지한 리더보드입니다. 서버도 사람별
 * 건수를 **안 줍니다** — 막는 자리를 화면이 아니라 API 에 뒀습니다.
 *
 * ## ⚠️ 막대를 안 그립니다
 *
 * 값을 같은 축 위에 세로로 늘어놓으면 그게 곧 순위표입니다
 * (`AGENTS.md` 불변식 1 — 이 저장소가 두 번 어긴 규칙). **값은 글자로**
 * 적습니다.
 */
function SpeechTypes({ counts }: { counts: TypeTally | null }) {
  if (counts === null) return null;

  const rows: TypeCount[] = typeCounts(counts.labels);
  const pending = pendingNote(counts.unclassified, counts.total);

  // 아무 말도 안 오간 회의는 표를 그리지 않습니다 — 0 열세 줄은 소음입니다.
  if (counts.total === 0) return null;

  const spoken = rows.filter((row) => row.count > 0);

  return (
    <section className="types">
      <h2 className="minutes-head">무슨 말이 오갔나</h2>
      {/* ⚠️ 안 잰 것을 0 옆에 두지 않습니다 — 위에 따로 적습니다. */}
      {pending !== null && <p className="text-gap text-[12px]">{pending}</p>}
      <ul className="tlist">
        {spoken.map((row) => (
          <li key={row.type} className={row.zero ? 'tzero' : undefined}>
            <span className="tname">{row.label}</span>
            <span className="tnum tabular-nums">{row.count}</span>
          </li>
        ))}
      </ul>
      {/* ⚠️ 0건인 유형을 통째로 숨기면 "반대가 없었다" 가 안 보입니다.
          줄로 세우면 시끄러우니 한 줄로 적습니다. */}
      {spoken.length < rows.length && (
        <p className="text-text-subtle text-[12px]">
          없던 것 — {rows.filter((r) => r.count === 0).map((r) => r.label).join(' · ')}
        </p>
      )}
    </section>
  );
}

/**
 * 회의에서 눈에 띈 것 (정의서 §12 · `REVIEW-003` AI 분석 마커).
 *
 * ## ⚠️ 이것은 관찰이지 판정이 아닙니다
 *
 * 규칙 기반 추정이라 **틀립니다.** 그래서 등급을 안 매기고(빨강·노랑
 * 없음), 왜 걸렸는지 적고, 근거 발화를 열 수 있게 둡니다.
 *
 * ⚠️ **빨강을 쓰지 않습니다.** 이 저장소에서 빨강은 "네가 뭘 잘못했다"
 * 로 읽힙니다 — 회의를 빨갛게 칠하면 그건 팀에 대한 판정입니다.
 */
function Findings({ findings }: { findings: Finding[] }) {
  const views = findingViews(findings);
  if (views.length === 0) return null;

  return (
    <section className="finds">
      <h2 className="minutes-head">회의에서 눈에 띈 것</h2>
      {/* ⚠️ 규칙 기반이라는 것을 **먼저** 말합니다. 안 적으면 사람은
          이걸 AI 의 판정으로 읽고, 틀렸을 때 신뢰가 통째로 무너집니다. */}
      <p className="finds-note">
        규칙으로 찾은 것이라 <b>틀릴 수 있습니다</b>. 근거를 눌러 원문을 보고 판단하세요.
      </p>
      <ul className="flist">
        {views.map((view, i) => (
          <li key={`${view.kind}-${i}`}>
            <p className="fhead">
              <span className="fname">{view.title}</span>
              {view.at !== null && <span className="fat">{view.at}</span>}
            </p>
            {view.what !== null && <p className="fwhat">{view.what}</p>}
            {view.why !== null && <p className="fwhy">{view.why}</p>}
            {view.evidence.length > 0 && (
              <button
                type="button"
                className="src"
                onClick={() => openEvidence(view.evidence, view.title)}
              >
                근거 #{view.evidence.join(', #')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Review() {
  const [screen, setScreen] = useState<Screen>({ k: 'loading' });
  const [types, setTypes] = useState<TypeTally | null>(null);
  const [drafts, setDrafts] = useState<Map<number, Draft>>(new Map());
  const [lane, setLane] = useState<Lane | 'all'>('all');
  const [me, setMe] = useState<Me | null>(null);
  const [result, setResult] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  // 스켈레톤을 **켤 때만** 켜지는 깃발. 처음부터 `true` 로 두면 안 됩니다 —
  // 대부분의 요청은 200ms 안에 끝나고, 그러면 남는 건 깜빡임뿐입니다.
  const [slow, setSlow] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    // ⚠️ 옮기면서 여기를 한 번 잃었습니다. 처음 React 판은 `k: 'loading'`
    // 이면 곧바로 "불러오는 중…" 을 그렸고, 그래서 화면을 열 때마다
    // **반드시** 한 번 깜빡였습니다 — `whileLoading` 이 없애려고 만든
    // 바로 그 결함을, 그 함수를 안 부르는 방식으로 되살린 것입니다.
    //
    // 끄는 것은 `whileLoading` 의 `finally` 가 책임집니다. 성공이든
    // 실패든 켠 것은 반드시 꺼집니다.
    const [c, m, g, t] = await whileLoading(
      Promise.all([
        get(`/api/meetings/${meetingId}/candidates`),
        get(`/api/meetings/${meetingId}/members`),
        get(`/api/meetings/${meetingId}`),
        // ⚠️ 이것 하나가 실패해도 화면 전체를 못 쓰게 만들지 않습니다 —
        //    후보 검토는 유형 집계 없이도 할 수 있습니다. 아래에서 `ok`
        //    일 때만 씁니다.
        get(`/api/meetings/${meetingId}/utterance-types`),
      ]),
      () => setSlow(true),
      () => setSlow(false),
    );
    // 셋 중 하나라도 닿지 못했으면 그건 연결 문제입니다 (결함 102).
    if (c === null || m === null || g === null) {
      setScreen({ k: 'unreachable' });
      return;
    }
    if ([c, m, g].some((r) => isSessionExpired(r.status))) {
      goToLogin();
      return;
    }
    if (!c.ok || !m.ok || !g.ok) {
      setScreen({ k: 'error' });
      return;
    }
    setTypes(t !== null && t.ok ? ((await t.json()) as TypeTally) : null);

    const members = (await m.json()) as Member[];
    setScreen({
      k: 'ok',
      data: {
        candidates: sortForReview((await c.json()) as Candidate[]),
        members,
        meeting: (await g.json()) as MeetingInfo,
        context: { memberIds: members.map((x) => x.user_id), today: todayInTeamCalendar() },
      },
    });
  }, []);

  useEffect(() => {
    void (async () => {
      const response = await get('/api/auth/me');
      // 닿지 못한 것을 만료로 읽으면 이유도 모른 채 로그아웃당합니다.
      if (response !== null) {
        if (!response.ok) {
          goToLogin();
          return;
        }
        setMe((await response.json()) as Me);
      }
      await load();
    })();
  }, [load]);

  const draftOf = (id: number): Draft => drafts.get(id) ?? emptyDraft();

  const update = (id: number, patch: Partial<Draft>): void => {
    setDrafts((prev) => {
      const next = new Map(prev);
      next.set(id, { ...(prev.get(id) ?? emptyDraft()), ...patch });
      return next;
    });
  };

  const submit = async (): Promise<void> => {
    if (screen.k !== 'ok') return;
    const { candidates, context } = screen.data;
    let payload;
    try {
      payload = buildReviewPayload(candidates, drafts, context);
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
      return;
    }
    // 누르는 동안 잠근다 (결함 89).
    setSending(true);
    try {
      const response = await trySend(() =>
        fetch(`${apiBase}/api/meetings/${meetingId}/candidates/review`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          credentials: 'same-origin',
        }),
      );
      if (response === null) {
        setResult({ tone: 'bad', text: unreachableText('제출하지 못했습니다') });
        return;
      }
      if (isSessionExpired(response.status)) {
        goToLogin();
        return;
      }
      if (!response.ok) {
        setResult({ tone: 'bad', text: `제출 실패 (HTTP ${response.status})` });
        return;
      }
      const body = (await response.json()) as {
        approved_count: number;
        approved_task_ids: number[];
        failures: Record<string, string[]>;
      };
      const failed = Object.entries(body.failures);
      setResult({
        tone: failed.length ? 'bad' : 'ok',
        text: failed.length
          ? `${body.approved_count}건 승인, ${failed.length}건 실패: ` +
            failed
              .map(([id, codes]) => `#${id} ${codes.map(describeBlocker).join('/')}`)
              .join(' · ')
          : describeSubmitResult(body.approved_count, body.approved_task_ids),
      });
      setDrafts(new Map());
      await load();
    } finally {
      setSending(false);
    }
  };

  const header = (
    <header className="head">
      <h1>업무 후보 검토</h1>
      <p className="lede">AI가 회의에서 뽑은 후보입니다. 등록해야 칸반에 올라갑니다.</p>
      {me !== null && <Byline name={me.name} what="검토 중" />}
    </header>
  );

  if (screen.k !== 'ok') {
    return (
      <>
        {header}
        {screen.k === 'loading' ? (
          // 200ms 전에는 **아무것도 안 그립니다.** `aria-busy` 는 낭독기
          // 쪽 짝이고, 뼈대 자체는 `aria-hidden` 이라 읽히지 않습니다.
          slow && (
            <div id="list" aria-busy="true" dangerouslySetInnerHTML={{ __html: skeletonRows(3) }} />
          )
        ) : (
          <RawHtml
            html={failureHtml({
              what:
                screen.k === 'unreachable'
                  ? unreachableText('업무 후보를 불러오지 못했습니다.')
                  : '업무 후보를 불러오지 못했습니다.',
              ...(screen.k === 'error' ? { help: describeUnexpected() } : {}),
              retry: true,
            })}
            onRetry={() => {
              setScreen({ k: 'loading' });
              void load();
            }}
          />
        )}
      </>
    );
  }

  const { candidates, members, meeting, context } = screen.data;
  const summary = summarize(candidates, drafts, context);
  const counts = laneCounts(candidates, drafts);
  const shown = candidates.filter(
    (candidate) => lane === 'all' || reviewLane(candidate, draftOf(candidate.id)) === lane,
  );

  return (
    <>
      {header}
      <Brief meeting={meeting} />
      <SpeechTypes counts={types} />
      <Findings findings={meeting.findings ?? []} />

      {candidates.length === 0 ? (
        <RawHtml html={emptyHtml(emptyReviewState(meeting.status))} />
      ) : (
        <>
          {/* ⚠️ **세기만 하고 거르지 않는 탭은 거짓말입니다.** */}
          <div className="seg" role="tablist" aria-label="검토 상태">
            {LANE_TABS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={key === lane}
                onClick={() => setLane(key)}
              >
                {label}
                <span className="n">{counts[key]}</span>
              </button>
            ))}
          </div>

          <div id="list">
            {shown.map((candidate) => (
              <CandidateCard
                key={candidate.id}
                candidate={candidate}
                draft={draftOf(candidate.id)}
                members={members}
                context={context}
                onChange={(patch) => update(candidate.id, patch)}
              />
            ))}
          </div>

          {/* ⚠️ 거른 결과가 0건인 것과 후보가 0건인 것은 다릅니다. */}
          {shown.length === 0 && <p className="lane-empty">이 상태인 후보가 없습니다</p>}
        </>
      )}

      <details className="more">
        <summary>등록되지 않는 후보가 있는 이유</summary>
        <div className="more-body">
          근거 발화가 없는 후보는 등록할 수 없습니다. 담당자·마감일을 채워도 마찬가지입니다 —
          회의에 없던 내용을 사람이 "고쳐서" 통과시키는 경로를 만들면 안 되기 때문입니다.
        </div>
      </details>

      <div className="actionbar">
        <div className="inner">
          {/* 제출 결과와 "빠진 정보" 안내가 같이 오는 자리입니다.
              `role="status"` — 사람이 방금 누른 것의 결과라 들려야 합니다. */}
          <div id="result" role="status" className={result?.tone ?? ''}>
            {result !== null
              ? result.text
              : summary.blocked > 0
                ? `${summary.blocked}건에 빠진 정보가 있어 제출할 수 없습니다`
                : ''}
          </div>
          <button
            id="submit"
            className="primary"
            disabled={!canSubmit(summary) || sending}
            onClick={() => void submit()}
          >
            제출
          </button>
        </div>
      </div>
    </>
  );
}

const host = document.getElementById('app');
if (host === null) throw new Error('요소 없음: app');
createRoot(host).render(<Review />);

// 근거 발화 상자를 한 번 붙인다.
mountEvidence(apiBase, meetingId);

renderNav('review');

// 서비스 워커 등록 + 설치 안내. 안 부르면 sw.js 는 그냥 놓인 파일이다.
bootApp();
