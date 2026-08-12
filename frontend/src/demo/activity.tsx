/**
 * 활동 기록 화면 (요구사항 정의서 §21 ACTIVITY-001).
 *
 * ## ⚠️ 이 화면이 생긴 이유
 *
 * `audit_logs` 에는 **쓰는 곳이 열한 곳**이었고 **읽는 곳이 0곳**이었습니다.
 * 기여도 가중치를 바꾼 것, AI 출력을 사람이 고친 것, 점수를 조정한 것이
 * 전부 성실하게 쌓이고 있었는데 **볼 방법이 없었습니다.**
 *
 * 이 저장소가 대표 실패 ① 로 적어 둔 그것입니다 — 오류가 안 나니 아무도
 * 몰랐고, `docs/20` 이 대조하다가 발견했습니다.
 *
 * ## ⚠️ 여기서는 아무것도 **고치지 못합니다**
 *
 * 감사 기록은 "누가 언제 무엇을 바꿨나" 를 나중에 확인하려고 있습니다.
 * 화면에서 고치거나 지울 수 있으면 그 목적이 통째로 사라집니다.
 * 이 화면에는 보내는 요청이 하나도 없습니다 — 읽기만 합니다.
 */

import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { isSessionExpired, loginUrlFor, safeApiBase } from '../lib/auth/session.ts';
import { tryGet, unreachableText } from '../lib/http/send.ts';
import { describeTime } from '../lib/chat/view.ts';
import { teamDateOf } from '../lib/time/calendar.ts';
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
  touches_contribution: boolean;
}

const params = new URLSearchParams(location.search);
const apiBase = safeApiBase(params.get('api'), location.origin);
const projectId = Number(params.get('project') ?? '1');

const get = (path: string): Promise<Response | null> => tryGet(`${apiBase}${path}`);

function goToLogin(): void {
  location.href = loginUrlFor(location.pathname + location.search);
}

function App() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);

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

  useEffect(() => {
    void load();
  }, [load]);

  const header = (
    <header className="head">
      <h1>활동 기록</h1>
      <p className="lede">
        이 프로젝트에서 <b>누가 언제 무엇을 바꿨는지</b>입니다. 기여도 조정·역할
        비중 변경·AI 결과 수정처럼 사람의 숫자를 건드린 일은 <b>눈에 띄게</b>{' '}
        표시합니다 — 분쟁이 생기면 제일 먼저 볼 것입니다.
      </p>
    </header>
  );

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
            <span className="atarget">{entry.target}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

const host = document.getElementById('app');
if (host !== null) createRoot(host).render(<App />);
renderNav('activity');
bootApp();
