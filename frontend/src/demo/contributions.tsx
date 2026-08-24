/**
 * 기여도 화면 — **React 로 옮긴 네 번째 화면** (docs/19 §24).
 *
 * ⚠️ 이 저장소에서 **가장 조심해야 하는 화면**입니다. 여기 있는 값이
 * 성적에 쓰일 수 있고, 잘못 그리면 팀을 망가뜨립니다. 지켜야 하는 넷은
 * `lib/contribution/view.ts` 에 적혀 있습니다 —
 * 순위 금지 · 단일 점수 금지 · 측정 불가는 0점이 아님 · 시스템은 판정하지 않음.
 *
 * 판단은 전부 `lib/contribution/view.ts`·`final.ts` 에 있고 테스트가
 * 붙어 있습니다. 여기는 그리기만 합니다 — 판단이 이리로 새는 만큼이
 * 검증 밖으로 나갑니다.
 */

import { useCallback, useEffect, useState } from 'react';
import { labelInList } from '../lib/people/labels.ts';
import { createRoot } from 'react-dom/client';

import {
  categoriesForDisplay,
  describeCategory,
  describeRange,
  hasNoEvidence,
  integrityNotes,
  nameOf,
  nothingMeasured,
  orderForDisplay,
  readBeforeTheNumber,
  roleOf,
  teamWarnings,
  uncertaintyDots,
  uncertaintyDotsNote,
  uncertaintySpans,
  type MemberScore,
  type Person,
  type TeamScore,
  type UncertaintySpan,
} from '../lib/contribution/view.ts';
import {
  adjustmentsToRestore,
  BLIND_CONFIRM,
  describeFinals,
  problemsWith,
  systemLabel,
  toPayload,
  type Draft,
  type FinalRow,
} from '../lib/contribution/final.ts';
import { isSessionExpired, loginUrlFor, safeApiBase, type Me } from '../lib/auth/session.ts';
import { tryGet, trySend, unreachableText } from '../lib/http/send.ts';
import { emptyHtml } from '../lib/ui/empty.ts';
import { detailText } from '../lib/http/detail.ts';
import { describeHttpStatus, failureHtml } from '../lib/ui/failure.ts';
import { whileLoading } from '../lib/ui/pending.ts';
import { scoreCards } from '../lib/ui/skeleton.ts';
import { Byline, RawHtml } from './parts.tsx';
import { teamDateTime } from '../lib/time/calendar.ts';
import { renderNav } from './nav.ts';
import { bootApp } from './pwa.ts';

const params = new URLSearchParams(location.search);
// ⚠️ 주소창의 `?api=` 를 그대로 쓰면 **비밀번호와 회의 음성이 어디로
// 가는지**를 링크 하나로 바꿀 수 있다.
const apiBase = safeApiBase(params.get('api'), location.origin);
const projectId = Number(params.get('project') ?? '1');

// ⚠️ **읽기도 `tryGet` 을 거칩니다** (결함 102) — 맨 `fetch` 는 닿지 못하면
// 던지고, 카드 영역이 텅 빈 채로 남았습니다.
const get = (path: string): Promise<Response | null> => tryGet(`${apiBase}${path}`);

function goToLogin(): void {
  location.href = loginUrlFor(location.pathname + location.search);
}

/** 사람이 입력칸에 적어 둔 것. 빈 문자열은 **0 이 아니라 "안 건드렸다"**. */
interface Typed {
  value: string;
  reason: string;
}

type Screen =
  | { k: 'loading' }
  | { k: 'unreachable' }
  | { k: 'failed'; status: number }
  | { k: 'ok'; score: TeamScore; people: Person[] };

// ══════════════════════════════════════════════════════════════
// 조각들
// ══════════════════════════════════════════════════════════════

/**
 * 문구 속 `**강조**` 만 굵게.
 *
 * ⚠️ 문구 자체는 `lib/contribution/view.ts` 가 정합니다. 여기서는 표시만
 * 합니다. HTML 에는 마크다운이 없어서, 이걸 안 하는 동안 화면에
 * `**측정하지 못했습니다**` 가 **별표째** 나왔습니다.
 *
 * 옮기면서 문자열 조립을 그만뒀습니다 — JSX 가 텍스트를 언제나
 * 이스케이프하므로 `escapeHtml` 을 부를 자리도, 빠뜨릴 자리도 없습니다.
 */
function Emphasized({ text }: { text: string }) {
  return (
    <>
      {text.split(/\*\*([^*]+)\*\*/g).map((part, i) =>
        i % 2 === 1 ? <strong key={i}>{part}</strong> : part,
      )}
    </>
  );
}

/**
 * 줄의 접힌 서랍 — **지운 것이 아니라 접은 것** (docs/19 §18).
 *
 * ⚠️ 조작 신호를 접는 것이 **감추는 것이 아닌** 이유: 이 신호는 원래
 * "표시만 하고 점수를 깎지 않는다" 는 것이었습니다(docs/05 §5). 항상
 * 펼쳐 두면 사람은 그것을 **판정**으로 읽습니다.
 */
function Drawer({ rest, flags }: { rest: readonly string[]; flags: readonly string[] }) {
  if (rest.length === 0 && flags.length === 0) return null;
  return (
    <details className="more">
      <summary>{flags.length ? '신뢰도 사유와 표시' : '신뢰도 사유'}</summary>
      <div className="more-body">
        {rest.length > 0 && (
          <ul className="notes">
            {rest.map((n, i) => (
              <li key={i}>
                <Emphasized text={n} />
              </li>
            ))}
          </ul>
        )}
        {flags.length > 0 && (
          <>
            <ul className="flags">
              {flags.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
            <p className="flagnote">
              표시만 합니다 — 이 신호로 점수를 깎지 않습니다. 판단은 팀이 합니다.
            </p>
          </>
        )}
      </div>
    </details>
  );
}

/**
 * 한 사람의 판독 줄.
 *
 * ## ⚠️ 구간의 **절대 위치를 그리지 않습니다**
 *
 * 세로 줄로 세우자 세 사람의 막대가 같은 0~100 축에 정렬됐고, 그 순간
 * 막대그래프이자 **순위표**가 됐습니다 (렌더해서 보고 알았습니다).
 * 값은 `describeRange` 가 글자로 정확히 말하므로 막대는 그 말의 반복일
 * 뿐이었고, 반복하는 쪽이 순위를 만들었습니다.
 */
function MemberRow({
  member,
  people,
  /**
   * 이 프로젝트를 **떠난** 사람들 (서버의 `former_members`).
   *
   * ⛔ 이걸 안 받던 동안 나간 사람의 줄이 「**사용자 #3**」이었습니다
   * (결함 308). `@lib` 의 `nameOf` 는 결함 222 때 이미 나간 사람을 찾도록
   * 고쳐졌고 SPA 는 넘기고 있었는데, **이 화면만** 안 넘겼습니다.
   * 게다가 같은 화면이 바로 위에서 「**박지원** 님은 이 프로젝트를
   * 떠났지만 그때 한 일은 계산에 그대로 들어 있습니다」라고 말합니다 —
   * 이름을 아는 화면이 이름 자리에 번호를 적고 있었습니다.
   */
  former,
  uncertainty,
}: {
  member: MemberScore;
  people: Person[];
  former: Person[];
  uncertainty: UncertaintySpan | undefined;
}) {
  const notes = readBeforeTheNumber(member);
  const flags = integrityNotes(member);
  // ⚠️ `?? 0` 을 쓰면 **잴 수 없음(null)** 이 0 으로 접히고, 그 0 은
  //    아래에서 "이 값은 확정적입니다" 가 됩니다 (결함 226).
  const points = uncertainty ? uncertainty.points : 0;
  const dots = uncertaintyDots(points);

  return (
    <div className="read">
      <div className="read-who">
        <span className="who">{nameOf(member.user_id, people, former)}</span>
        <span className="role">{roleOf(member, people)}</span>
      </div>

      <div className="read-val">
        <p className="range">{describeRange(member)}</p>
        {/* ⚠️ 「신뢰도」는 **팀 값**입니다 — 팀당 한 번 계산돼(`scoring.py`)
            모두에게 같은 값이 실립니다. 이름 아래에 그냥 두면 「이 사람의
            데이터가 부실하다」로 읽힙니다 (결함 248). 임자를 적습니다. */}
        <p className="conf">팀 신뢰도 {member.confidence_label}</p>
        {/* ⭐ **막대에서 셀 수 있는 점으로** (docs/19 §25). 위치가 아니라
            **개수**로만 씁니다 — 축 위에 뿌리면 순위표가 됩니다.
            폭 0 은 "완전히 확정" 이라 그릴 것이 없습니다. 0px 막대를
            그리면 사람은 그것을 "안 나왔다(고장)" 로 읽습니다. */}
        {dots === 0 ? (
          <p className="unc-none">{uncertaintyDotsNote(points)}</p>
        ) : (
          <>
            <div className="unc-dots" role="img" aria-label={uncertaintyDotsNote(points)}>
              {Array.from({ length: dots }, (_, i) => (
                <i key={i} />
              ))}
            </div>
            <p className="unc-note">{uncertaintyDotsNote(points)}</p>
          </>
        )}
      </div>

      <div className="read-why">
        {hasNoEvidence(member) && (
          <p className="empty">
            이 사람의 활동이 아직 하나도 연결되지 않았습니다 — 0 이라는 뜻이 아니라{' '}
            <strong>연결이 없다</strong>는 뜻입니다.
          </p>
        )}
        {/* ⚠️ **첫 줄만 보이고 나머지는 접습니다** (docs/19 §18).
            `readBeforeTheNumber` 가 측정 불가를 **맨 앞**에 놓습니다 —
            이 숫자를 얼마나 믿을지 정하는 가장 큰 요인이라 그렇게 정렬해
            뒀고, 그 판단을 여기서 그대로 씁니다. 예전에는 셋이 다 깔려서
            사람 셋이면 아홉 줄이었고, **정작 다른 한 줄이 묻혔습니다.** */}
        {notes.length > 0 && (
          <ul className="notes">
            <li>
              <Emphasized text={notes[0] ?? ''} />
            </li>
          </ul>
        )}
        {categoriesForDisplay(member).length > 0 && (
          <ul className="cats">
            {categoriesForDisplay(member).map((c) => (
              <li key={c.category}>
                <span className="cat">{describeCategory(c.category)}</span>
                {/* ⭐ **막대를 걷어냈습니다** (docs/19 §22). `width: team_share%`
                    짜리 막대가 세 줄에서 같은 자리·같은 축에 정렬돼 있었고,
                    그건 이미 한 번 걷어낸 막대그래프와 똑같은 그림입니다.
                    ⚠️ 숫자는 지우지 않습니다 — 글자가 더 정확합니다. */}
                <span className="catnum">
                  {c.event_count}건 · 팀의 {Math.round(c.team_share * 100)}%
                </span>
              </li>
            ))}
          </ul>
        )}
        <Drawer rest={notes.slice(1)} flags={flags} />
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// 화면
// ══════════════════════════════════════════════════════════════

function Contributions() {
  const [screen, setScreen] = useState<Screen>({ k: 'loading' });
  const [me, setMe] = useState<Me | null>(null);
  const [slow, setSlow] = useState(false);
  const [typed, setTyped] = useState<Map<number, Typed>>(new Map());
  const [finalState, setFinalState] = useState('');
  const [message, setMessage] = useState<{ text: string; tone: 'bad' | 'plain' } | null>(null);
  /**
   * 저장된 확정을 **읽어 왔는가** (결함 97).
   *
   * ⚠️ 기본값은 `false` 입니다. 아직 못 읽은 것과 "확정이 없다" 는 다르고,
   * 헷갈리는 쪽으로 기울면 남의 조정을 지웁니다.
   */
  const [finalsKnown, setFinalsKnown] = useState(false);
  // 확정은 **사람이 개입하는 유일한 지점**입니다. 답이 늦다고 두 번
  // 누르면 같은 요청이 두 번 나갑니다 (결함 89).
  const [saving, setSaving] = useState(false);

  const loadFinals = useCallback(async (people: Person[]): Promise<void> => {
    const response = await get(`/api/projects/${projectId}/contributions/final`);
    if (response === null || !response.ok) {
      // 확정 조회가 실패해도 기여도 화면은 살아 있어야 합니다.
      // ⚠️ 다만 **확정은 막습니다** — 저장된 조정을 모르는 채로 확정하면
      // 남의 조정을 말없이 지웁니다 (결함 97).
      setFinalState('');
      setFinalsKnown(false);
      return;
    }
    const body = (await response.json()) as { finals: FinalRow[] };
    setFinalState(describeFinals(
        body.finals,
        // 결함 345 — 같은 이름 둘이면 「이하늘이 33% 로 확정」이 누구 말인지
        // 알 수 없습니다. 이름표는 `@lib` 한 곳에서 붙입니다.
        new Map(people.map((p) => [p.user_id, labelInList(p, people)])),
      ));
    // ⚠️ **판단은 `adjustmentsToRestore` 가 합니다.** 되돌릴 것이 없으면
    // 비웁니다 — 남겨 두면 다시 그린 표에 지난 조정이 유령처럼 남습니다.
    const saved = adjustmentsToRestore(body.finals);
    setTyped(
      new Map(
        [...saved].map(([userId, row]) => [
          userId,
          { value: String(row.final_value), reason: row.reason ?? '' },
        ]),
      ),
    );
    setFinalsKnown(true);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    // ⭐ 명단은 **프로젝트** 단위입니다. 회의 단위로 받던 동안에는
    // `?project=N` 만으로 열면 이름이 전부 `사용자 #3` 이었고, 이름 순
    // 정렬도 그 문자열 순으로 바뀌었습니다 — 사람별 기여를 보여주는
    // 화면에서 가장 나쁜 실패입니다.
    const [scoreRes, memberRes] = await whileLoading(
      Promise.all([
        get(`/api/projects/${projectId}/contributions`),
        get(`/api/projects/${projectId}/members`),
      ]),
      () => setSlow(true),
      () => setSlow(false),
    );

    // ⚠️ **닿지 못한 것을 만료로 읽지 않습니다.** 그러면 지하철에서
    // 화면을 연 사람이 이유도 모른 채 로그아웃당합니다.
    if (scoreRes === null) {
      setScreen({ k: 'unreachable' });
      return;
    }
    if (isSessionExpired(scoreRes.status)) {
      goToLogin();
      return;
    }
    if (!scoreRes.ok) {
      setScreen({ k: 'failed', status: scoreRes.status });
      return;
    }
    const people = memberRes?.ok ? ((await memberRes.json()) as Person[]) : [];
    setScreen({ k: 'ok', score: (await scoreRes.json()) as TeamScore, people });
    await loadFinals(people);
  }, [loadFinals]);

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

  const systemValues =
    screen.k === 'ok'
      ? new Map(screen.score.members.map((ms) => [ms.user_id, Number(ms.share.toFixed(3))]))
      : new Map<number, number>();

  const saveFinal = async (): Promise<void> => {
    if (screen.k !== 'ok') return;
    // ⚠️ 저장된 확정을 못 읽었으면 여기서 멈춥니다 (결함 97). 입력칸이
    // 비어 있는 것이 "시스템 값 그대로" 인지 "못 불러온 것" 인지 화면도
    // 구분 못 하는 상태라, 그대로 보내면 남의 조정을 지웁니다.
    if (!finalsKnown) {
      setMessage({ text: BLIND_CONFIRM, tone: 'bad' });
      return;
    }

    const drafts: Draft[] = orderForDisplay(screen.score.members, screen.people).map((ms) => {
      const mine = typed.get(ms.user_id);
      const raw = (mine?.value ?? '').trim();
      return {
        user_id: ms.user_id,
        // 빈 칸은 **0 이 아니라 "안 건드렸다"** 입니다. `Number('')` 가 0 이라
        // 여기서 안 가르면 아무것도 안 적은 사람이 0점으로 확정됩니다.
        final_value: raw === '' ? null : Number(raw),
        reason: mine?.reason ?? '',
      };
    });

    /* ⛔ 안 잰 사람은 「시스템 값 그대로」 확정할 수 없습니다 (결함 307) —
       받아들일 값 자체가 없습니다. 판정은 `@lib` 의 `nothingMeasured` 하나로
       하고, 거절은 서버가 합니다. */
    const unmeasured = new Set(shown.filter(nothingMeasured).map((ms) => ms.user_id));
    const problems = problemsWith(drafts, systemValues, unmeasured);
    if (problems.length > 0) {
      // ⚠️ 서버도 같은 규칙으로 거절합니다. 여기서 먼저 말하는 이유는,
      // 서버가 400 을 돌려준 뒤에 알려 주면 그때는 이미 다른 사람의
      // 확정까지 같이 실패한 뒤이기 때문입니다.
      setMessage({ text: problems.join(' · '), tone: 'bad' });
      return;
    }

    setSaving(true);
    try {
      // ⚠️ 여기서 실패를 놓치면 화면에 **"확정했습니다."** 가 그대로
      // 남습니다. 이 시스템에서 사람이 개입하는 유일한 지점입니다.
      const response = await trySend(() =>
        fetch(`${apiBase}/api/projects/${projectId}/contributions/final`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ finals: toPayload(drafts, systemValues, unmeasured) }),
          credentials: 'same-origin',
        }),
      );
      if (response === null) {
        setMessage({ text: unreachableText('확정하지 못했습니다'), tone: 'bad' });
        return;
      }
      if (isSessionExpired(response.status)) {
        goToLogin();
        return;
      }
      if (!response.ok) {
        // ⚠️ **`.json()` 도 던집니다.** 500 이 HTML 오류 페이지를 돌려주면
        // 파싱이 실패합니다 (결함 87 이 고친 자리가 다른 길로 열렸던 곳).
        const body: unknown = await response.json().catch(() => null);
        /* ⚠️ 여기 손으로 만든 것이 `detailText` 와 **같은 판단 두 벌**
           이었습니다 (실패 ②). 422 의 객체 배열까지 보는 쪽은 한 벌뿐이라
           그것을 씁니다 (결함 51 · 301). */
        setMessage({
          text: detailText(body, describeHttpStatus(response.status) ?? '확정하지 못했습니다'),
          tone: 'bad',
        });
        return;
      }
      // ⚠️ 성공은 빨갛게 쓰지 않습니다 — 같은 자리라도 뜻이 다릅니다.
      setMessage({ text: '확정했습니다.', tone: 'plain' });
      await loadFinals(screen.people);
    } finally {
      setSaving(false);
    }
  };

  const header = (
    <header className="head">
      <h1>기여도</h1>
      <p className="lede">
        활동 기록에서 <strong>추정한 구간</strong>입니다. 순위가 아니고, 최종값도 아닙니다.
      </p>
      {me !== null && <Byline name={me.name} avatar={me.avatar} what="보는 중" />}
    </header>
  );

  const howToRead = (
    <details className="more">
      <summary>이 화면을 읽는 법</summary>
      <div className="more-body">
        <strong>순위는 제공하지 않습니다.</strong> 목록은 이름 순이고, 점수 순으로 정렬하지
        않습니다 — 리더보드를 안 그려도 목록이 점수 순이면 사람들은 1등과 꼴찌를 읽습니다.
        <br />
        <br />
        숫자는 구간입니다. 신뢰도가 낮을수록 구간이 넓어지고, 그 넓이가 "이 값을 얼마나 믿을 수
        있는가"를 말합니다. <strong>측정하지 못한 영역은 0이 아닙니다</strong> — 나머지 활동으로
        추정한 값이고, 그 사실을 각 줄에 적어 둡니다.
        <br />
        <br />
        {/* ⚠️ 여기에 "막대는 구간의 넓이만 그립니다" 라고 적혀 있었습니다.
            그 막대는 §25 에서 **점으로 바뀌었는데** 설명만 남아, 화면에
            없는 것을 읽는 법으로 알려 주고 있었습니다. */}
        <strong>점은 값이 아니라 "얼마나 모르는가"입니다.</strong> 값의 자리를 그림으로 그리면 세
        사람이 같은 자에 서게 되고, 그건 순위표입니다. 그래서 값은 글자로만 적고, 그림은{' '}
        <strong>개수</strong>만 씁니다 — <strong>점 하나가 4%p 의 "모름"</strong> 이고, 점이 많은
        사람은 기여가 큰 사람이 아니라 <strong>우리가 가장 모르는 사람</strong>이며, 그 자리가
        다음에 더 재야 할 곳입니다.
      </div>
    </details>
  );

  if (screen.k !== 'ok') {
    return (
      <>
        {header}
        <div id="members" {...(screen.k === 'loading' && slow ? { 'aria-busy': 'true' } : {})}>
          {screen.k === 'loading' ? (
            // 200ms 전에는 **아무것도 안 그립니다.**
            slow && <RawHtml html={scoreCards()} />
          ) : (
            // ⚠️ 카드 자리에 씁니다. 위쪽에만 한 줄 남기면 카드 영역이
            // **텅 빈 채**로 있고 사람은 "아무도 아무것도 안 했구나" 로
            // 읽습니다. 이 화면에서 그건 버그가 아니라 **오답**입니다.
            <RawHtml
              html={
                screen.k === 'unreachable'
                  ? failureHtml({
                      what: unreachableText('기여도를 불러오지 못했습니다.'),
                      retry: true,
                    })
                  : failureHtml({
                      what: '기여도를 불러오지 못했습니다.',
                      ...(describeHttpStatus(screen.status) !== null
                        ? { help: describeHttpStatus(screen.status) as string }
                        : {}),
                      code: `HTTP ${screen.status}`,
                      retry: true,
                    })
              }
              onRetry={() => {
                setScreen({ k: 'loading' });
                void load();
              }}
            />
          )}
        </div>
        {howToRead}
      </>
    );
  }

  const { score, people } = screen;
  /* ⛔ 나간 사람의 줄이 「사용자 #3」이었습니다 (결함 308). 서버는 그때도
     `former_members` 로 이름을 같이 보내고 있었고 `@lib` 의 `nameOf` 도
     받을 준비가 돼 있었는데, **이 화면만** 안 읽었습니다. */
  const former = score.former_members ?? [];
  const warnings = teamWarnings(score, people);
  const shown = orderForDisplay(score.members, people);
  // ⚠️ 모르는 폭은 **팀에서 가장 넓은 구간** 기준이라 한 사람만 보고는
  // 정할 수 없습니다. 그래서 목록 전체로 한 번에 계산합니다.
  const spans = new Map(uncertaintySpans(shown).map((s) => [s.userId, s]));
  const typedOf = (userId: number): Typed => typed.get(userId) ?? { value: '', reason: '' };
  const setTypedFor = (userId: number, patch: Partial<Typed>): void => {
    setTyped((prev) => {
      const next = new Map(prev);
      next.set(userId, { ...typedOf(userId), ...patch });
      return next;
    });
  };

  return (
    <>
      {header}

      <p className="meta-line" id="meta">
        {score.algo_version} · {teamDateTime(score.computed_at) ?? score.computed_at} 기준
      </p>

      {/* ⚠️ 이 경고는 **안 줄였습니다.** 여기가 이 제품의 윤리가 사는
          자리입니다 — "이 수치로 서로를 비교하지 마세요". */}
      {warnings.length > 0 && (
        <div id="warnings" className="notice-box">
          {warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      )}

      {/* ⚠️ 사람이 하나도 안 오면 카드 자리가 통째로 빕니다. 그 화면은
          "아무도 아무것도 안 했다" 로 읽히는데, 실제로는 **아직 이을
          활동이 없다** 입니다 (docs/05 §5 — 측정 불가 ≠ 0점). */}
      <div id="members">
        {shown.length === 0 ? (
          <RawHtml
            html={emptyHtml({
              what: '여기에는 팀원별 기여 구간과 그 근거가 나옵니다.',
              why: '아직 이을 활동이 하나도 없습니다 — 아무도 안 했다는 뜻이 아닙니다.',
              how: '회의를 녹음하거나 GitHub 저장소를 연결하면 활동이 여기로 이어집니다.',
              action: { label: '프로젝트 설정', href: `/project.html?project=${projectId}` },
            })}
          />
        ) : (
          shown.map((ms) => (
            <MemberRow
              key={ms.user_id}
              member={ms}
              people={people}
              former={former}
              uncertainty={spans.get(ms.user_id)}
            />
          ))
        )}
      </div>

      <p className="note" id="notice">
        {score.notice}
      </p>

      {/* ⭐ 확정. `docs/05` §5 는 "최종 점수를 시스템이 확정" 을 금지합니다.
          그런데 확정을 남길 자리가 화면에도 API 에도 없어서, 배포 상태에서
          존재하는 값은 시스템이 계산한 숫자뿐이었습니다 — **금지한 쪽으로
          실제 동작한 것**입니다. */}
      <section className="panel" id="final-panel">
        <h2>확정</h2>
        <p className="sub" id="final-state">
          {finalState}
        </p>
        <div id="finals">
          {shown.map((ms) => {
            const name = nameOf(ms.user_id, people, former);
            /* ⛔ 예전에는 `(systemValues.get(id) ?? 0).toFixed(1)` 이라
               안 잰 사람에게 **`0.0%`** 라고 적었습니다 (결함 307). 여섯 줄
               위 카드는 같은 사람을 `—` 라고 그리고 「0 이라는 뜻이 아니라
               연결이 없다는 뜻입니다」라고 말합니다 — 한 화면이 같은 사실을
               두고 서로 다른 말을 하고 있었습니다. */
            const measured = !nothingMeasured(ms);
            const system = systemLabel(systemValues.get(ms.user_id), measured);
            return (
              <div className="final-row" key={ms.user_id} data-user={ms.user_id}>
                <span className="who">{name}</span>
                {/* ⚠️ 시스템 값은 **지워지지 않고 나란히 남습니다.** */}
                <span className="sys">시스템 {system}</span>
                <label>
                  확정{' '}
                  <input
                    type="number"
                    className="val"
                    step="0.1"
                    min="0"
                    max="100"
                    placeholder={measured ? system : ""}
                    aria-label={`${name} 확정값`}
                    value={typedOf(ms.user_id).value}
                    onChange={(e) => setTypedFor(ms.user_id, { value: e.target.value })}
                  />
                </label>
                <span className="why">
                  <input
                    type="text"
                    className="reason"
                    placeholder="시스템 값과 다르게 정했다면 이유"
                    aria-label={`${name} 조정 이유`}
                    value={typedOf(ms.user_id).reason}
                    onChange={(e) => setTypedFor(ms.user_id, { reason: e.target.value })}
                  />
                </span>
              </div>
            );
          })}
        </div>
        <div className="row" style={{ marginTop: '.75rem' }}>
          <button id="confirm" className="primary" disabled={saving} onClick={() => void saveFinal()}>
            이 값으로 확정
          </button>
        </div>
        {message !== null && (
          <p className={message.tone === 'plain' ? 'status plain' : 'status'} id="final-message">
            {message.text}
          </p>
        )}
        <p className="note">
          시스템 값은 <strong>참고값</strong>입니다. 다르게 확정하려면 각 칸에 값을 적고{' '}
          <strong>이유</strong>를 함께 적으세요 — 이유 없는 조정은 근거 없는 점수와 같습니다.
          시스템 값은 지워지지 않고 나란히 남습니다.
        </p>
      </section>

      {howToRead}
    </>
  );
}

const host = document.getElementById('app');
if (host === null) throw new Error('요소 없음: app');
createRoot(host).render(<Contributions />);

renderNav('contributions');

// 서비스 워커 등록 + 설치 안내. 안 부르면 sw.js 는 그냥 놓인 파일이다.
bootApp();
