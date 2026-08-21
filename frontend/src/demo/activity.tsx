/**
 * 활동 기록 화면 (요구사항 정의서 §21 ACTIVITY-001 · §17 GITHUB-003~005 · 008).
 *
 * ## 두 갈래입니다 — 팀 활동(감사 기록) · GitHub
 *
 * 출처가 다른 두 흐름입니다. 한 목록에 섞으면 "이 줄이 사람이 한 일인가
 * 저장소에서 온 일인가" 를 알 수 없게 되므로(회의 검토가 `findings` 와
 * `unresolved_issues` 를 섞지 않는 것과 같은 이유) **갈래로 가릅니다.**
 *
 * ## ⚠️ 이 화면이 생긴 이유
 *
 * `audit_logs` 에는 **쓰는 곳이 열한 곳**이었고 **읽는 곳이 0곳**이었습니다.
 * GitHub 쪽도 같았습니다 — `github_events` 는 웹훅·백필로 쌓이기만 하고
 * **볼 화면이 0곳**이었습니다. 대표 실패 ① 이 표 두 개에서 나란히.
 *
 * ## ⚠️ 여기서는 아무것도 **고치지 못합니다**
 *
 * 누르는 것은 갈래와 거르개뿐이고, 보내는 **쓰기 요청은 0개**입니다.
 * 감사 기록·저장소 기록 둘 다 "나중에 확인하는 것" 이라 화면에서 고칠 수
 * 있으면 목적이 통째로 사라집니다.
 */

import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { isSessionExpired, loginUrlFor, safeApiBase } from '../lib/auth/session.ts';
import { tryGet, unreachableText } from '../lib/http/send.ts';
import { describeTime } from '../lib/chat/view.ts';
import { teamDateOf } from '../lib/time/calendar.ts';
import {
  describeEmptyFeed,
  feedFilters,
  filterFeed,
  whyNoCommits,
  type FeedItem,
  type KindCount,
} from '../lib/github/feed.ts';
import { emptyHtml } from '../lib/ui/empty.ts';
import { describeHttpStatus, failureHtml } from '../lib/ui/failure.ts';
import { whileLoading } from '../lib/ui/pending.ts';
import { rows as rowSkeleton } from '../lib/ui/skeleton.ts';
import { RawHtml } from './parts.tsx';
import { renderNav } from './nav.ts';
import { bootApp } from './pwa.ts';

interface Entry {
  id: number;
  at: string;
  action: string;
  /** ⚠️ 서버가 주는 사람 말. 화면이 두 번째 표를 만들지 않습니다. */
  label: string;
  who: string | null;
  target: string;
  /** 사람이 읽을 이름. 못 찾으면 `target` 그대로 (결함 293). */
  target_label: string;
  touches_contribution: boolean;
}

interface Feed {
  items: FeedItem[];
  counts: KindCount[];
}

const params = new URLSearchParams(location.search);
const apiBase = safeApiBase(params.get('api'), location.origin);
const projectId = Number(params.get('project') ?? '1');

const get = (path: string): Promise<Response | null> => tryGet(`${apiBase}${path}`);

function goToLogin(): void {
  location.href = loginUrlFor(location.pathname + location.search);
}

type Lane = 'team' | 'github';

function App() {
  const [lane, setLane] = useState<Lane>('team');

  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);

  const [feed, setFeed] = useState<Feed | null>(null);
  const [feedFailure, setFeedFailure] = useState<string | null>(null);
  const [kind, setKind] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const response = await whileLoading(
      get(`/api/projects/${projectId}/activity`),
      () => setSlow(true),
      () => setSlow(false),
    );
    if (response === null) {
      setFailure(unreachableText('활동 기록을 못 불러왔습니다'));
      setEntries([]);
      return;
    }
    if (isSessionExpired(response.status)) {
      goToLogin();
      return;
    }
    if (!response.ok) {
      setFailure(describeHttpStatus(response.status) ?? '활동 기록을 못 불러왔습니다');
      setEntries([]);
      return;
    }
    setFailure(null);
    setEntries((await response.json()) as Entry[]);
  }, []);

  const loadFeed = useCallback(async (): Promise<void> => {
    const response = await whileLoading(
      get(`/api/projects/${projectId}/github/feed`),
      () => setSlow(true),
      () => setSlow(false),
    );
    if (response === null) {
      setFeedFailure(unreachableText('GitHub 활동을 못 불러왔습니다'));
      setFeed({ items: [], counts: [] });
      return;
    }
    if (isSessionExpired(response.status)) {
      goToLogin();
      return;
    }
    if (!response.ok) {
      setFeedFailure(describeHttpStatus(response.status) ?? 'GitHub 활동을 못 불러왔습니다');
      setFeed({ items: [], counts: [] });
      return;
    }
    setFeedFailure(null);
    setFeed((await response.json()) as Feed);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // GitHub 갈래를 처음 열 때 받아 옵니다. 미리 받으면 안 여는 사람의
  // 요청이 낭비이고, 열 때마다 받으면 갈래 전환이 느려집니다.
  useEffect(() => {
    if (lane === 'github' && feed === null) void loadFeed();
  }, [lane, feed, loadFeed]);

  const header = (
    <header className="head">
      <h1>활동 기록</h1>
      <p className="lede">
        이 프로젝트에서 <b>누가 언제 무엇을 바꿨는지</b>입니다. 팀 활동은 기여도
        조정·역할 비중 변경처럼 <b>사람의 숫자를 건드린 일</b>을 눈에 띄게 표시하고,
        GitHub 갈래는 저장소에서 온 <b>병합·리뷰·이슈 닫힘</b>을 보여 줍니다.
      </p>
      {/* ⚠️ 갈래이지 필터가 아닙니다 — 두 흐름은 출처가 달라 섞지 않습니다. */}
      <div className="lanes" role="tablist" aria-label="활동 갈래">
        <button
          role="tab"
          aria-selected={lane === 'team'}
          className={lane === 'team' ? 'on' : ''}
          onClick={() => setLane('team')}
        >
          팀 활동
        </button>
        <button
          role="tab"
          aria-selected={lane === 'github'}
          className={lane === 'github' ? 'on' : ''}
          onClick={() => setLane('github')}
        >
          GitHub
        </button>
      </div>
    </header>
  );

  if (lane === 'github') {
    return (
      <>
        {header}
        <GithubLane
          feed={feed}
          failure={feedFailure}
          slow={slow}
          kind={kind}
          onKind={setKind}
          onRetry={() => void loadFeed()}
        />
      </>
    );
  }

  if (failure !== null && entries !== null && entries.length === 0) {
    return (
      <>
        {header}
        <RawHtml html={failureHtml({ what: failure, retry: true })} onRetry={() => void load()} />
      </>
    );
  }

  if (entries === null) {
    return (
      <>
        {header}
        {slow && <div aria-busy="true" dangerouslySetInnerHTML={{ __html: rowSkeleton(5) }} />}
      </>
    );
  }

  if (entries.length === 0) {
    return (
      <>
        {header}
        <RawHtml
          html={emptyHtml({
            what: '아직 기록된 활동이 없습니다',
            why: '기록은 누가 무언가를 바꿀 때 쌓입니다 — 아직 아무도 안 바꿨습니다.',
            how: '업무 후보를 승인하거나 역할 비중을 바꾸면 여기에 남습니다.',
          })}
        />
      </>
    );
  }

  return (
    <>
      {header}
      <ul className="alist">
        {entries.map((entry) => (
          <li key={entry.id} className={entry.touches_contribution ? 'aitem weighty' : 'aitem'}>
            <time className="awhen" dateTime={entry.at}>
              {/* ⚠️ 날짜와 시각을 같이 씁니다 — 감사 기록에서 "언제" 는
                  본문만큼 중요합니다. 못 읽으면 빈 글자입니다. */}
              {teamDateOf(entry.at) ?? ''} {describeTime(entry.at)}
            </time>
            <span className="awhat">{entry.label}</span>
            {/* ⚠️ 사람이 없으면 시스템이 한 일입니다 (보존기간 만료 삭제 등).
                "알 수 없음" 이라고 쓰면 고장으로 읽힙니다. */}
            <span className="awho">{entry.who ?? '시스템'}</span>
            {/* ⛔ 예전에는 `{entry.target}` 이었습니다 (결함 293) — 화면이
                스스로 「누가 언제 **무엇을** 바꿨는지」라고 적어 두고
                「무엇」 자리에 `task:4` 를 찍었습니다. 그 업무 이름은
                「접근성 점검」입니다. 이름은 서버가 줍니다. */}
            <span className="atarget">{entry.target_label}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function GithubLane({
  feed,
  failure,
  slow,
  kind,
  onKind,
  onRetry,
}: {
  feed: Feed | null;
  failure: string | null;
  slow: boolean;
  kind: string | null;
  onKind: (kind: string | null) => void;
  onRetry: () => void;
}) {
  if (failure !== null && feed !== null && feed.items.length === 0) {
    return <RawHtml html={failureHtml({ what: failure, retry: true })} onRetry={onRetry} />;
  }

  if (feed === null) {
    return slow ? (
      <div aria-busy="true" dangerouslySetInnerHTML={{ __html: rowSkeleton(5) }} />
    ) : null;
  }

  if (feed.items.length === 0) {
    const empty = describeEmptyFeed();
    return (
      <>
        <RawHtml
          html={emptyHtml({ what: '아직 GitHub 활동이 없습니다', why: empty.why, how: empty.how })}
        />
        {/* ⚠️ 알려만 주고 갈 곳을 안 주면 대표 실패 ③ 입니다 — 진단이 있는
            화면으로 가는 길을 실제로 놓습니다. */}
        <p className="gnext">
          <a href={`/project.html?project=${projectId}`}>프로젝트 설정에서 연결 진단 보기</a>
        </p>
      </>
    );
  }

  const shown = filterFeed(feed.items, kind);

  return (
    <>
      {/* ⚠️ 건수는 **글자**입니다. 같은 축 위에 폭·위치로 그리면 순위표입니다. */}
      <div className="gbar" role="group" aria-label="종류 거르개">
        {feedFilters(feed.counts).map((f) => (
          <button
            key={f.kind ?? '전부'}
            aria-pressed={kind === f.kind}
            className={kind === f.kind ? 'on' : ''}
            onClick={() => onKind(f.kind)}
          >
            {f.label} {f.count}건
          </button>
        ))}
      </div>

      <ul className="alist">
        {shown.map((item) => (
          <li key={item.id} className="aitem">
            <time className="awhen" dateTime={item.occurred_at}>
              {teamDateOf(item.occurred_at) ?? ''} {describeTime(item.occurred_at)}
            </time>
            <span className="awhat">{item.label}</span>
            {/* ⚠️ GitHub 로그인 그대로일 수 있습니다 — 팀원과 안 이어진
                계정이라는 **사실**이고, 숨기면 그 사실이 같이 숨습니다. */}
            <span className="awho">{item.who}</span>
            <span className="atarget">
              {item.repo}
              {item.ref !== null && ` · ${item.ref}`}
            </span>
          </li>
        ))}
      </ul>

      {/* ⚠️ 커밋이 없는 것은 빠뜨린 게 아니라 결정입니다 (docs/05 §2.1).
          말없이 없으면 사람은 "아직 안 만들었나 보다" 로 잘못 읽습니다. */}
      <p className="gwhy">{whyNoCommits()}</p>
    </>
  );
}

const host = document.getElementById('app');
if (host !== null) createRoot(host).render(<App />);
renderNav('activity');
bootApp();
