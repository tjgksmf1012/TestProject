/**
 * 검색 화면 (요구사항 정의서 §20).
 *
 * ## ⚠️ 이 화면은 **한 상자에서 전부 꺼내는 문**입니다
 *
 * 업무·회의·회의에서 오간 말·GitHub 활동이 한 자리에 나옵니다. 그래서
 * 범위가 한 번 새면 남의 팀 회의록이 결과로 나옵니다 — 서버가 종류마다
 * `project_id` 로 먼저 좁히고, 테스트가 그것을 다시 잽니다.
 *
 * ## ⚠️ 사람을 세지 않습니다
 *
 * 결과에 이름이 붙지만(누가 한 말인지 알아야 하니까) **사람별 건수를
 * 세는 곳이 없습니다.** 그런 것이 생기면 그 순간 "검색 결과 기준 발언
 * 순위" 가 만들어지고, 그건 이 저장소가 금지한 리더보드입니다.
 *
 * ## 판단은 여기 없습니다
 *
 * 대목을 어디서 자를지, 어디로 갈지, 언제 찾을 수 있는지는 전부
 * `lib/search/view.ts` 에 있고 테스트가 붙어 있습니다.
 */

import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import {
  blockedReason,
  canSearch,
  describeKind,
  excerpt,
  filterScopeNote,
  groupByKind,
  moreNote,
  hrefFor,
  type Hit,
} from '../lib/search/view.ts';
import { labelInList } from '../lib/people/labels.ts';
import { isSessionExpired, loginUrlFor, safeApiBase } from '../lib/auth/session.ts';
import { tryGet, unreachableText } from '../lib/http/send.ts';
import { STATUS_LABEL } from '../lib/kanban/board.ts';
import { emptyHtml } from '../lib/ui/empty.ts';
import { describeHttpStatus, failureHtml } from '../lib/ui/failure.ts';
import { whileLoading } from '../lib/ui/pending.ts';
import { rows as rowSkeleton } from '../lib/ui/skeleton.ts';
import { NoteLine, RawHtml, type Note } from './parts.tsx';
import { renderNav } from './nav.ts';
import { bootApp } from './pwa.ts';

const params = new URLSearchParams(location.search);
const apiBase = safeApiBase(params.get('api'), location.origin);
const projectId = Number(params.get('project') ?? '1');

const get = (path: string): Promise<Response | null> => tryGet(`${apiBase}${path}`);

function goToLogin(): void {
  location.href = loginUrlFor(location.pathname + location.search);
}

interface Member {
  user_id: number;
  name: string;
  /** ⭐ 같은 이름이 둘일 때 가르는 손잡이 (결함 345). 서버가 프로젝트
      안에서 유일하게 지킵니다. */
  github_login?: string | null;
}

function App() {
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [assignee, setAssignee] = useState('');
  const [taskStatus, setTaskStatus] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  /** 무엇으로 찾은 결과인가. ⚠️ 입력칸이 아니라 **이것**으로 대목을
   *  자릅니다 — 안 그러면 타자를 칠 때마다 이미 찾은 결과의 하이라이트가
   *  따라 움직입니다. */
  const [asked, setAsked] = useState('');
  /** 무엇으로 걸러 찾은 결과인가. ⚠️ `asked` 와 **같은 이유**로 따로
   *  둡니다 — 고르기만 하고 안 누른 값으로 「업무에만 걸렸습니다」라고
   *  말하면 그 줄이 결과보다 앞서 갑니다 (결함 390). */
  const [askedFilters, setAskedFilters] = useState<{
    assignee: string;
    status: string;
  } | null>(null);

  useEffect(() => {
    void (async () => {
      const response = await get(`/api/projects/${projectId}/members`);
      if (response === null) return;
      /* ⚠️ **세션이 끊겼으면 로그인으로 보냅니다** (결함 424).
         예전에는 `|| !response.ok` 로 401 을 **조용히 삼켰습니다.** 그래서
         로그아웃한 사람에게 이 화면만 멀쩡한 찾기 폼으로 열렸고(레거시
         열넷 중 열셋은 바로 로그인으로 갑니다), 담당자·상태를 고르고
         「찾기」를 누른 **뒤에야** 튕겼습니다 — 적은 말은 주소에 없으니
         돌아와도 빈 칸입니다. */
      if (isSessionExpired(response.status)) {
        goToLogin();
        return;
      }
      if (!response.ok) return;
      setMembers((await response.json()) as Member[]);
    })();
  }, []);

  const run = useCallback(async (): Promise<void> => {
    const filters = { assignee, status: taskStatus };
    if (!canSearch(query, filters)) {
      setNote(
        blockedReason(query, filters) === null
          ? null
          : { text: blockedReason(query, filters) as string, tone: 'plain' },
      );
      return;
    }
    setNote(null);

    const search = new URLSearchParams();
    if (query.trim() !== '') search.set('q', query.trim());
    if (assignee !== '') search.set('assignee_id', assignee);
    if (taskStatus !== '') search.set('status', taskStatus);

    const response = await whileLoading(
      get(`/api/projects/${projectId}/search?${search.toString()}`),
      () => setSlow(true),
      () => setSlow(false),
    );
    if (response === null) {
      setFailure(unreachableText('찾지 못했습니다'));
      setHits([]);
      return;
    }
    if (isSessionExpired(response.status)) {
      goToLogin();
      return;
    }
    if (!response.ok) {
      setFailure(describeHttpStatus(response.status) ?? '찾지 못했습니다');
      setHits([]);
      return;
    }
    setFailure(null);
    setAsked(query.trim());
    setAskedFilters(filters);
    setHits((await response.json()) as Hit[]);
  }, [query, assignee, taskStatus]);

  const filters = { assignee, status: taskStatus };
  const why = blockedReason(query, filters);

  const header = (
    <header className="head">
      <h1>찾기</h1>
      <p className="lede">
        업무·회의·회의에서 오간 말·GitHub 활동을 한 자리에서 찾습니다.{' '}
        <b>이 프로젝트 안에서만</b> 찾습니다 — 회의 전사는 팀 내부 자료입니다.
      </p>
    </header>
  );

  const form = (
    <form
      className="qform"
      onSubmit={(event) => {
        event.preventDefault();
        void run();
      }}
    >
      <label className="clabel" htmlFor="q">
        찾을 말
      </label>
      <input
        id="q"
        value={query}
        placeholder="두 글자 이상"
        onChange={(event) => setQuery(event.target.value)}
      />

      <div className="filters">
        <span className="fitem">
          {/* ⚠️ 「업무」가 붙어 있어야 합니다 (결함 390). 이 칸은 서버의
              **업무 검색 조건**이고(`search_tasks` — SEARCH-002) 회의·회의
              내용·GitHub 은 낱말만 봅니다. 옆 칸이 「업무 상태」라고 적는
              동안 이 칸만 안 적어서, 김민수로 걸러 놓고 박지원의 발언이
              나왔습니다. */}
          <label className="clabel" htmlFor="who">
            업무 담당자
          </label>
          <select id="who" value={assignee} onChange={(event) => setAssignee(event.target.value)}>
            <option value="">누구든</option>
            {members.map((member) => (
              <option key={member.user_id} value={String(member.user_id)}>
                {/* 결함 345 — 같은 이름 둘이면 목록이 같은 글자 두 줄입니다. */}
                {labelInList(member, members)}
              </option>
            ))}
          </select>
        </span>

        <span className="fitem">
          <label className="clabel" htmlFor="st">
            업무 상태
          </label>
          <select
            id="st"
            value={taskStatus}
            onChange={(event) => setTaskStatus(event.target.value)}
          >
            <option value="">아무 상태</option>
            {Object.entries(STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </span>
      </div>

      {/* ⚠️ 버튼만 흐려 두면 왜 안 되는지 모른 채 계속 누릅니다.
          ⚠️ **id 가 있어야 단추가 이 줄을 가리킬 수 있습니다** — 없는 동안
          눈으로만 읽혔고, 진짜 `disabled` 라 키보드는 단추에 닿지도 못했습니다
          (결함 375, 373 과 같은 모양). */}
      {why !== null && (
        <p className="cwhy" id="find-why">
          {why}
        </p>
      )}
      <NoteLine note={note} id="search-note" />
      <button
        type="submit"
        id="find"
        aria-disabled={!canSearch(query, filters)}
        aria-describedby={why !== null ? 'find-why' : undefined}
        onClick={(event) => {
          if (!canSearch(query, filters)) {
            event.preventDefault();
            document.getElementById('q')?.focus();
          }
        }}
      >
        찾기
      </button>
    </form>
  );

  if (failure !== null && hits !== null && hits.length === 0) {
    return (
      <>
        {header}
        {form}
        <RawHtml html={failureHtml({ what: failure, retry: true })} onRetry={() => void run()} />
      </>
    );
  }

  return (
    <>
      {header}
      {form}

      {hits === null ? (
        slow && <div aria-busy="true" dangerouslySetInnerHTML={{ __html: rowSkeleton(4) }} />
      ) : hits.length === 0 ? (
        <RawHtml
          html={emptyHtml({
            what: '찾는 것이 없습니다',
            why: '이 프로젝트 안에서만 찾습니다 — 다른 팀 자료는 나오지 않습니다.',
            how: '다른 낱말로 찾거나, 업무 담당자·상태만으로 찾아보세요.',
          })}
        />
      ) : (
        <>
          {/* ⚠️ 걸린 데까지만 말합니다 — 안 걸린 묶음이 **실제로 있을 때만**
              나옵니다 (결함 390 · 294 의 방법). */}
          {filterScopeNote(askedFilters, groupByKind(hits)) !== null && (
            <p className="cwhy scope-note">{filterScopeNote(askedFilters, groupByKind(hits))}</p>
          )}
          {groupByKind(hits).map((group) => (
          <section key={group.kind} className="kgroup">
            {/* ⚠️ 종류 순서는 **고정**입니다 — 건수 순으로 세우면 그게 곧
                순위표이고, 새로고침마다 자리가 바뀝니다. */}
            <h2 className="shead">
              {describeKind(group.kind)} <span className="kcount">{group.hits.length}</span>
            </h2>
            {/* ⚠️ **받은 개수는 총계가 아닙니다** (결함 435). 서버가 한 종류당
                `MAX_PER_KIND` 로 자르는데 화면이 그 수를 그대로 적어서, DB 에
                41건인 검색이 「회의 30」 으로 나가고 잘렸다는 말은 한 자도
                없었습니다. 같은 셸의 회의 레일은 잘릴 때 「그 밖에 25개 —
                홈에서 전부 봅니다」라고 **이미 말하고 있었습니다.** */}
            {moreNote(group.hits.length) !== null && (
              <p className="cwhy kmore">{moreNote(group.hits.length)}</p>
            )}
            <ul className="hlist">
              {group.hits.map((thing, i) => {
                const href = hrefFor(thing, projectId);
                return (
                  <li key={`${group.kind}-${i}`} className="hit">
                    <p className="htitle">
                      {href === null ? (
                        <span>{thing.title}</span>
                      ) : (
                        <a href={href}>{thing.title}</a>
                      )}
                      {thing.status !== null && <span className="hstatus">{thing.status}</span>}
                      {thing.who !== null && <span className="hwho">{thing.who}</span>}
                    </p>
                    {thing.body !== '' && (
                      <p className="hbody">{excerpt(thing.body, asked)}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
          ))}
        </>
      )}
    </>
  );
}

const host = document.getElementById('app');
if (host !== null) createRoot(host).render(<App />);
renderNav('search');
bootApp();
