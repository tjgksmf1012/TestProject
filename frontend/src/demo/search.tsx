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
  groupByKind,
  hrefFor,
  type Hit,
} from '../lib/search/view.ts';
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

  useEffect(() => {
    void (async () => {
      const response = await get(`/api/projects/${projectId}/members`);
      if (response === null || !response.ok) return;
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
          <label className="clabel" htmlFor="who">
            담당자
          </label>
          <select id="who" value={assignee} onChange={(event) => setAssignee(event.target.value)}>
            <option value="">누구든</option>
            {members.map((member) => (
              <option key={member.user_id} value={String(member.user_id)}>
                {member.name}
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

      {/* ⚠️ 버튼만 흐려 두면 왜 안 되는지 모른 채 계속 누릅니다. */}
      {why !== null && <p className="cwhy">{why}</p>}
      <NoteLine note={note} id="search-note" />
      <button type="submit" id="find" disabled={!canSearch(query, filters)}>
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
            how: '다른 낱말로 찾거나, 담당자·상태만으로 찾아보세요.',
          })}
        />
      ) : (
        groupByKind(hits).map((group) => (
          <section key={group.kind} className="kgroup">
            {/* ⚠️ 종류 순서는 **고정**입니다 — 건수 순으로 세우면 그게 곧
                순위표이고, 새로고침마다 자리가 바뀝니다. */}
            <h2 className="shead">
              {describeKind(group.kind)} <span className="kcount">{group.hits.length}</span>
            </h2>
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
        ))
      )}
    </>
  );
}

const host = document.getElementById('app');
if (host !== null) createRoot(host).render(<App />);
renderNav('search');
bootApp();
