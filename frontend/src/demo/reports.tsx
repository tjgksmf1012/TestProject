/**
 * 보고서 화면 — 회의록 · 주간 · 최종.
 *
 * ## ⚠️ 이 화면이 생긴 이유
 *
 * `reports` 표는 처음부터 스키마에 있었고 **쓰는 코드가 0곳**이었습니다.
 * 그리고 만드는 코드를 붙이더라도 볼 자리가 없으면 그건 이 저장소가 반복해
 * 당한 실패 ③ 입니다 — "할 일을 알려 주고 그 일을 할 자리를 안 줌".
 *
 * ## 판단은 여기 없습니다
 *
 * 무엇을 결측으로 볼지, 못 잰 사람을 어떻게 적을지, 복사한 글자에 무엇이
 * 남아야 하는지는 전부 `lib/reports/view.ts` 에 있고 테스트가 붙어 있습니다.
 * 여기는 그리기만 합니다.
 *
 * ⚠️ **사람을 다시 정렬하지 않습니다.** 서버가 이름 순으로 세워서 줍니다
 * (`backend/teamflow/reports/blocks.py`). 화면이 또 정하면 순서를 정하는
 * 곳이 둘이 되고, 언젠가 한쪽이 점수 순이 됩니다 — 순위표는 그렇게 생깁니다.
 */

import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { detailText } from '../lib/http/detail.ts';
import { isSessionExpired, loginUrlFor, safeApiBase, type Me } from '../lib/auth/session.ts';
import { tryGet, trySend, unreachableText } from '../lib/http/send.ts';
import {
  emptyReports,
  describeConfidence,
  describeFinal,
  describeRange,
  describeReportType,
  describeWhen,
  gapsOf,
  personGapsHeading,
  teamReasonsHeading,
  subjectOf,
  toPlainText,
  tooNewToRender,
  type Block,
  type Person,
  type ReportContent,
  type ReportSummary,
} from '../lib/reports/view.ts';
import { copySucceeded, copyText, describeCopy } from '../lib/ui/copy.ts';
import { emptyHtml } from '../lib/ui/empty.ts';
import { describeHttpStatus, failureHtml } from '../lib/ui/failure.ts';
import { whileLoading } from '../lib/ui/pending.ts';
import { rows as rowSkeleton } from '../lib/ui/skeleton.ts';
import { Byline, NoteLine, RawHtml, type Note } from './parts.tsx';
import { renderNav } from './nav.ts';
import { bootApp } from './pwa.ts';

const params = new URLSearchParams(location.search);
// ⚠️ 주소창의 `?api=` 를 그대로 쓰면 링크 하나로 자료가 어디로 가는지
// 바뀝니다. 보고서에는 사람별 기여가 들어갑니다.
const apiBase = safeApiBase(params.get('api'), location.origin);
const projectId = Number(params.get('project') ?? '1');

const get = (path: string): Promise<Response | null> => tryGet(`${apiBase}${path}`);

function goToLogin(): void {
  location.href = loginUrlFor(location.pathname + location.search);
}

// ══════════════════════════════════════════════════════════════
// 블록 그리기
// ══════════════════════════════════════════════════════════════

function PersonRow({ person }: { person: Person }) {
  const confidence = describeConfidence(person);
  const final = describeFinal(person);
  const holes = gapsOf(person);
  return (
    <div className="prow">
      <p className="pwho">
        <span className="who">{person.name}</span>
        <span className="role">{person.role}</span>
      </p>
      <div className="pval">
        {/* ⚠️ 값은 **글자**입니다. 폭으로 그리면 그 순간 막대그래프이고,
            막대그래프는 곧 순위표입니다 — 이 저장소가 두 번 낸 결함. */}
        <p className={person.measured ? 'range' : 'range range-gap'}>
          {describeRange(person)}
        </p>
        {confidence !== null && <p className="conf">{confidence}</p>}
        {person.measured && <p className="conf">근거 {person.evidence_count}건</p>}
      </div>
      <div className="pwhy">
        {person.reasons.length > 0 && (
          <>
            {/* ⚠️ **이 목록은 사람마다 똑같습니다** (결함 344). 서버는
                `compute_confidence` 를 팀당 한 번 부르고, 보고서는 그것을
                사람 이름 밑에 그립니다. 머리말이 없으면 네 줄이 그 사람에
                대한 지적으로 읽힙니다 — 커버리지 1.0 인 사람의 항목이
                「녹음이 끊긴 트랙이 있습니다」를 이고 있었습니다. */}
            <p className="notes-head">{teamReasonsHeading()}</p>
            <ul className="notes">
              {person.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </>
        )}
        {holes.length > 0 && (
          <>
            <p className="notes-head">{personGapsHeading()}</p>
            <ul className="notes notes-gap">
              {holes.map((hole) => (
                <li key={hole}>{hole}</li>
              ))}
            </ul>
          </>
        )}
        {final !== null && <p className="final">{final}</p>}
      </div>
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'heading':
      return <h2 className="bhead">{block.text}</h2>;
    case 'paragraph':
      return <p className="bpara">{block.text}</p>;
    case 'facts':
      return (
        <dl className="facts">
          {block.items.map((item) => (
            <div className="fact" key={item.label}>
              <dt>{item.label}</dt>
              {/* ⚠️ 못 잰 값은 빈 칸이 아니라 글자입니다. 빈 칸은 0 처럼
                  읽힙니다. 색은 빨강이 아니라 흙빛 — 못 잰 것은 누가 뭘
                  잘못한 게 아닙니다. */}
              <dd className={item.gap ? 'gap' : ''}>
                {item.gap ? '못 쟀습니다' : item.value}
                {item.note !== undefined && item.note !== '' && (
                  <span className="fnote">{item.note}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      );
    case 'list':
      return block.items.length === 0 ? (
        <p className="bempty">{block.empty_note}</p>
      ) : (
        <ul className="blist">
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      );
    case 'people':
      return (
        <div className="people">
          {block.people.map((person, index) => (
            /* ⚠️ 이름+역할을 열쇠로 쓰면 **동명이인**에서 겹칩니다 (결함 345).
               보고서의 `Person` 에는 번호가 없으므로 자리를 같이 씁니다. */
            <PersonRow key={`${index}/${person.name}/${person.role}`} person={person} />
          ))}
        </div>
      );
    case 'gap':
      return <p className="bgap">{block.text}</p>;
  }
}

function ReportBody({ content }: { content: ReportContent }) {
  if (tooNewToRender(content)) {
    // ⚠️ 못 그리는 것과 빈 것은 다릅니다. 조용히 아무것도 안 그리면
    //    "보고서가 비었다" 로 읽힙니다.
    return (
      <p className="bgap">
        이 보고서는 더 새로운 형식으로 만들어졌습니다. 앱을 업데이트해 주세요 —
        내용이 빈 것이 아닙니다.
      </p>
    );
  }
  return (
    <>
      {content.notices.length > 0 && (
        <div className="notice-box">
          {content.notices.map((notice) => (
            <p key={notice}>{notice}</p>
          ))}
        </div>
      )}
      {content.blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </>
  );
}

// ══════════════════════════════════════════════════════════════
// 화면
// ══════════════════════════════════════════════════════════════

type Screen =
  | { k: 'loading' }
  | { k: 'unreachable' }
  | { k: 'failed'; status: number }
  | { k: 'ok'; rows: ReportSummary[] };

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [screen, setScreen] = useState<Screen>({ k: 'loading' });
  const [slow, setSlow] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [content, setContent] = useState<ReportContent | null>(null);
  const [openSlow, setOpenSlow] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  // ⚠️ 복사 안내는 **따로** 둡니다. 위쪽 안내 줄에 쓰면 긴 보고서에서는
  //    눌렀을 때 메시지가 화면 밖에 뜹니다 — 사람은 아무 일도 안 일어난
  //    줄 알고 옛 클립보드 내용을 붙여 넣습니다 (결함 81 이 말하는 그것).
  const [copyNote, setCopyNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);
  /* ⚠️ **빈 상자가 「다음에 뭘」을 상수로 뱉고 있었습니다** (결함 312).
     회의가 0개인 팀에게 「회의 로비에서 회의록을 만드세요」라고 했는데,
     이 화면은 회의를 **받아 온 적이 없어** 그걸 알 방법이 없었습니다.
     모르는 동안은 `null` 입니다 — 모르는 것을 0 이라고 하지 않습니다. */
  const [meetingCount, setMeetingCount] = useState<number | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const response = await whileLoading(
      get(`/api/projects/${projectId}/reports`),
      () => setSlow(true),
      () => setSlow(false),
    );
    if (response === null) {
      setScreen({ k: 'unreachable' });
      return;
    }
    if (isSessionExpired(response.status)) {
      goToLogin();
      return;
    }
    if (!response.ok) {
      setScreen({ k: 'failed', status: response.status });
      return;
    }
    setScreen({ k: 'ok', rows: (await response.json()) as ReportSummary[] });
  }, []);

  useEffect(() => {
    void (async () => {
      const response = await get('/api/auth/me');
      if (response !== null) {
        if (!response.ok) {
          goToLogin();
          return;
        }
        setMe((await response.json()) as Me);
      }
      const meetings = await get(`/api/projects/${projectId}/meetings`);
      if (meetings !== null && meetings.ok) {
        setMeetingCount(((await meetings.json()) as unknown[]).length);
      }
      await load();
    })();
  }, [load]);

  const open = useCallback(async (id: number): Promise<void> => {
    setOpenId(id);
    setContent(null);
    const response = await whileLoading(
      get(`/api/reports/${id}`),
      () => setOpenSlow(true),
      () => setOpenSlow(false),
    );
    if (response === null) {
      setNote({ text: unreachableText('보고서를 열지 못했습니다'), tone: 'bad' });
      return;
    }
    if (!response.ok) {
      setNote({ text: `보고서를 열지 못했습니다 (HTTP ${response.status})`, tone: 'bad' });
      return;
    }
    const body = (await response.json()) as { content: ReportContent };
    setContent(body.content);
  }, []);

  const make = useCallback(
    async (type: 'weekly' | 'final'): Promise<void> => {
      setBusy(true);
      setNote(null);
      /* ⛔ **기간을 화면이 짓지 않습니다** (결함 296).
         예전에는 여기서 「지난 7일」(`end - 6일 ~ end`)을 만들어 보냈습니다.
         그 창은 누를 때마다 굴러가서 `scope_key` 가 날마다 달라졌고,
         **하루에 한 벌씩 주간 보고서가 쌓였습니다** — 사흘 눌러 세 벌이
         나오는 것을 재현했습니다. 게다가 단추는 「이번 주」라고 적혀
         있는데 이 제품의 「이번 주」는 월~일입니다(`meeting/resolve.py` ·
         `lib/calendar/month.ts`).

         팀 달력을 아는 곳은 서버입니다(`clock.team_week`). 기간을 안
         보내면 서버가 팀 달력의 이번 주로 채웁니다. */
      const body = { report_type: type };

      const response = await trySend(() =>
        fetch(`${apiBase}/api/projects/${projectId}/reports`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'same-origin',
        }),
      );
      setBusy(false);
      if (response === null) {
        setNote({ text: unreachableText('보고서를 만들지 못했습니다'), tone: 'bad' });
        return;
      }
      if (isSessionExpired(response.status)) {
        goToLogin();
        return;
      }
      if (!response.ok) {
        /* ⛔ 서버가 사람에게 쓴 문장을 버리고 있었습니다 (결함 316). */
        setNote({
          text: detailText(
            await response.json().catch(() => null),
            `보고서를 만들지 못했습니다 (HTTP ${response.status})`,
          ),
          tone: 'bad',
        });
        return;
      }
      const created = (await response.json()) as { id: number; content: ReportContent };
      setNote({ text: '보고서를 만들었습니다', tone: 'plain' });
      await load();
      setOpenId(created.id);
      setContent(created.content);
    },
    [load],
  );

  const copy = useCallback(async (): Promise<void> => {
    if (content === null) return;
    // ⚠️ **화면 글자가 아니라 데이터에서** 만듭니다 (설정 화면에서 배운 것).
    //    화면에서 긁으면 형태가 다른 것 — 특히 팀 경고 — 이 빠집니다.
    //
    // ⚠️ `navigator.clipboard` 를 직접 부르지 않습니다. 그건 보안
    //    컨텍스트에서만 있고, 없을 때 조용히 죽습니다 (결함 81). 사람은
    //    눌렀는데 아무 일도 안 일어난 줄 알고 옛 클립보드 내용을 붙여
    //    넣습니다 — 보고서에서 그러면 **남의 자료가 나갑니다.**
    const outcome = await copyText(toPlainText(content), navigator.clipboard);
    setCopyNote({
      text: copySucceeded(outcome)
        ? '보고서를 글자로 복사했습니다'
        : describeCopy(outcome, '보고서'),
      tone: copySucceeded(outcome) ? 'plain' : 'bad',
    });
  }, [content]);

  const header = (
    <header>
      <h1 className="head">보고서</h1>
      <p className="lede">
        회의록·주간·최종을 만들고 내보냅니다. 사람별 기여가 들어가는 보고서에는 팀
        경고가 함께 나갑니다.
      </p>
      {me !== null && <Byline name={me.name} avatar={me.avatar} what="보는 중" />}
    </header>
  );

  const actions = (
    <>
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void make('final')}
        >
          최종 보고서 만들기
        </button>
        <button type="button" disabled={busy} onClick={() => void make('weekly')}>
          이번 주 보고서 만들기
        </button>
      </div>
      <NoteLine note={note} />
    </>
  );

  if (screen.k !== 'ok') {
    return (
      <>
        {header}
        {actions}
        {screen.k === 'loading' ? (
          // 200ms 전에는 **아무것도 안 그립니다.** 대부분의 응답이 그 안에
          // 끝나므로, 곧바로 그리면 반드시 한 번 깜빡입니다 (§8 에서 되살린 결함).
          slow && (
            <div
              className="rlist"
              aria-busy="true"
              dangerouslySetInnerHTML={{ __html: rowSkeleton(3) }}
            />
          )
        ) : (
          <RawHtml
            html={
              screen.k === 'unreachable'
                ? failureHtml({
                    what: unreachableText('보고서를 불러오지 못했습니다.'),
                    retry: true,
                  })
                : failureHtml({
                    what: '보고서를 불러오지 못했습니다.',
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
      </>
    );
  }

  if (screen.rows.length === 0) {
    return (
      <>
        {header}
        {actions}
        <RawHtml
          html={emptyHtml(emptyReports(meetingCount))}
        />
      </>
    );
  }

  const openRow = screen.rows.find((row) => row.id === openId) ?? null;

  return (
    <>
      {header}
      {actions}
      <div className="cols">
        <ul className="rlist">
          {screen.rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className={row.id === openId ? 'ritem current' : 'ritem'}
                {...(row.id === openId ? { 'aria-current': 'true' as const } : {})}
                onClick={() => void open(row.id)}
              >
                <span className="rtype">{describeReportType(row.report_type)}</span>
                {/* ⚠️ `row.title` 을 그대로 쓰면 종류가 두 번 나옵니다 — 옆
                    칩이 이미 말하고 있습니다. 주간은 날짜까지 세 번이었습니다
                    (렌더해서 봤습니다). `subjectOf` 가 겹치는 만큼을 걷습니다. */}
                {subjectOf(row) !== '' && (
                  <span className="rtitle">{subjectOf(row)}</span>
                )}
                <span className="rwhen">{describeWhen(row)}</span>
              </button>
            </li>
          ))}
        </ul>

        <article className="rbody">
          {openRow === null ? (
            <p className="bempty">왼쪽에서 보고서를 고르세요.</p>
          ) : content === null ? (
            openSlow && (
              <div
                aria-busy="true"
                dangerouslySetInnerHTML={{ __html: rowSkeleton(4) }}
              />
            )
          ) : (
            <>
              <div className="rbar">
                <h2 className="rhead">{content.title}</h2>
                <button type="button" id="copy" onClick={() => void copy()}>
                  글자로 복사
                </button>
              </div>
              <NoteLine note={copyNote} id="copy-note" />
              <ReportBody content={content} />
            </>
          )}
        </article>
      </div>
    </>
  );
}

const host = document.getElementById('app');
if (host !== null) createRoot(host).render(<App />);
renderNav('reports');
bootApp();
