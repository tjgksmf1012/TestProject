import { useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { Picker } from '../components/Picker.tsx';
import { Problem } from '../components/Problem.tsx';
import { ApiError } from '../api/client.ts';
import {
  useChatMessageSearch,
  useFilteredProjectSearch,
  useMembers,
} from '../api/hooks.ts';
import { STATUS_LABEL } from '@lib/kanban/board.ts';
import { labelInList } from '@lib/people/labels.ts';
import {
  appHrefForHit,
  blockedReason,
  canSearch,
  describeKind,
  excerpt,
  filterScopeNote,
  groupByKind,
  moreNote,
} from '@lib/search/view.ts';
import { describeTime } from '@lib/chat/view.ts';
import { describeLoadFailure } from '@lib/ui/load.ts';

function statusOf(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null;
}

export default function Search() {
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = Number(params['projectId']);
  const validProjectId = Number.isFinite(projectId) && projectId > 0 ? projectId : undefined;

  const initialQ = searchParams.get('q') ?? '';
  const [query, setQuery] = useState(initialQ);
  const [assignee, setAssignee] = useState('');
  const [taskStatus, setTaskStatus] = useState('');
  const [submitted, setSubmitted] = useState<{ q: string; assignee: string; status: string } | null>(
    () => (canSearch(initialQ, null) ? { q: initialQ.trim(), assignee: '', status: '' } : null),
  );
  const inputRef = useRef<HTMLInputElement | null>(null);

  const membersQuery = useMembers(validProjectId);
  const members = membersQuery.data ?? [];

  const searchQuery = useFilteredProjectSearch(validProjectId, submitted);
  const chatQuery = useChatMessageSearch(
    validProjectId,
    submitted !== null ? submitted.q : '',
  );

  const filters = { assignee, status: taskStatus };
  const allowed = canSearch(query, filters);
  const why = blockedReason(query, filters);

  const hits = useMemo(
    () => (searchQuery.data ?? []).filter((h) => h.kind !== 'github'),
    [searchQuery.data],
  );
  const groups = useMemo(() => groupByKind(hits), [hits]);
  const chatHits = useMemo(() => {
    if (submitted === null || !canSearch(submitted.q, null)) return [];
    return chatQuery.data ?? [];
  }, [chatQuery.data, submitted]);

  const asked = submitted?.q ?? '';
  const askedFilters = submitted ? { assignee: submitted.assignee, status: submitted.status } : null;
  const scopeNote = askedFilters ? filterScopeNote(askedFilters, groups) : null;

  const cannotLoad =
    searchQuery.error != null
      ? describeLoadFailure('검색 결과', statusOf(searchQuery.error))
      : membersQuery.error != null && statusOf(membersQuery.error) !== null
        ? describeLoadFailure('팀원 목록', statusOf(membersQuery.error))
        : null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!allowed) {
      inputRef.current?.focus();
      return;
    }
    const nextParams = { q: query.trim(), assignee, status: taskStatus };
    setSubmitted(nextParams);
    const sp = new URLSearchParams();
    if (nextParams.q !== '') sp.set('q', nextParams.q);
    setSearchParams(sp, { replace: true });
  };

  return (
    <AppShell
      title="통합 검색"
      projectId={validProjectId}
      meta={
        submitted !== null && searchQuery.isSuccess ? (
          <span className="meta-chip">
            결과 <strong className="num">{hits.length + chatHits.length}</strong>건
          </span>
        ) : undefined
      }
    >
      <div className="panes">
        <section className="pane">
          <div className="pane__head">
            <h2 className="pane__title">업무 · 회의 · 회의 내용 · 채팅 찾기</h2>
            <span className="t12 muted">이 프로젝트 안에서만 찾습니다</span>
          </div>
          <div className="pane__body">
            <form className="tf-search-form" noValidate onSubmit={handleSubmit}>
              <div className="tf-search-form__main">
                <label className="field" style={{ flex: '2 1 240px', margin: 0 }}>
                  <span className="field__label">찾을 말</span>
                  <input
                    ref={inputRef}
                    id="search-q"
                    type="search"
                    className="input"
                    placeholder="두 글자 이상 입력해 주세요"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <div className="field" style={{ flex: '1 1 160px', margin: 0 }}>
                  <span className="field__label">업무 담당자</span>
                  <Picker
                    value={assignee === '' ? null : assignee}
                    onChange={(v) => setAssignee(v ?? '')}
                    options={members.map((m) => ({
                      value: String(m.user_id),
                      label: labelInList(m, members),
                    }))}
                    emptyLabel="누구든"
                    ariaLabel="업무 담당자"
                  />
                </div>
                <div className="field" style={{ flex: '1 1 150px', margin: 0 }}>
                  <span className="field__label">업무 상태</span>
                  <Picker
                    value={taskStatus === '' ? null : taskStatus}
                    onChange={(v) => setTaskStatus(v ?? '')}
                    options={Object.entries(STATUS_LABEL).map(([val, label]) => ({
                      value: val,
                      label,
                    }))}
                    emptyLabel="아무 상태"
                    ariaLabel="업무 상태"
                  />
                </div>
                <div style={{ alignSelf: 'flex-end' }}>
                  <button
                    type="submit"
                    className={`btn btn--primary${!allowed ? ' btn--unmet' : ''}`}
                    aria-disabled={!allowed}
                    aria-describedby={why !== null ? 'search-why' : undefined}
                  >
                    찾기
                  </button>
                </div>
              </div>
              {why !== null && (
                <p id="search-why" className="t12 muted" role="status" style={{ margin: 'var(--sp-2) 0 0' }}>
                  {why}
                </p>
              )}
            </form>

            {cannotLoad !== null ? (
              <Problem>{cannotLoad}</Problem>
            ) : submitted === null ? (
              <div className="empty">
                <p style={{ margin: '0 0 6px', fontWeight: 600 }}>찾을 말을 넣거나 업무 조건을 골라 검색하세요</p>
                <p className="t12 muted" style={{ margin: 0 }}>
                  회의 발화와 팀 채팅은 두 글자 이상 검색어로 찾으며, 담당자·상태 조건은 칸반 업무에 적용됩니다.
                </p>
              </div>
            ) : searchQuery.isFetching ? (
              <p className="t13 muted" role="status">프로젝트 자료를 찾는 중입니다…</p>
            ) : hits.length === 0 && chatHits.length === 0 ? (
              <div className="empty">
                <p style={{ margin: '0 0 6px', fontWeight: 600 }}>찾는 것이 없습니다</p>
                <p className="t12 muted" style={{ margin: '0 0 4px' }}>
                  이 프로젝트 안에서만 찾습니다 — 다른 팀 자료는 나오지 않습니다.
                </p>
                <p className="t12 faint" style={{ margin: 0 }}>
                  다른 낱말로 찾거나, 업무 담당자·상태만으로 찾아보세요.
                </p>
              </div>
            ) : (
              <div className="tf-search-results">
                {scopeNote !== null && (
                  <p className="t12 muted tf-search-scope" role="status">
                    {scopeNote}
                  </p>
                )}

                {groups.map((group) => {
                  const truncated = moreNote(group.hits.length);
                  return (
                    <section key={group.kind} className="tf-search-group">
                      <div className="tf-search-group__head">
                        <h3 className="sec__title" style={{ margin: 0 }}>
                          {describeKind(group.kind)}{' '}
                          <span className="num muted">({group.hits.length})</span>
                        </h3>
                        {truncated !== null && <span className="t12 muted">{truncated}</span>}
                      </div>
                      <ul className="tf-search-hits">
                        {group.hits.map((hit, i) => {
                          const target =
                            validProjectId !== undefined ? appHrefForHit(hit, validProjectId) : null;
                          return (
                            <li key={`${group.kind}-${hit.task_id ?? hit.meeting_id ?? i}-${i}`} className="tf-search-hit">
                              <div className="tf-search-hit__top">
                                {target !== null ? (
                                  <Link to={target} className="tf-search-hit__title">
                                    {hit.title}
                                  </Link>
                                ) : (
                                  <span className="tf-search-hit__title">{hit.title}</span>
                                )}
                                {hit.status !== null && (
                                  <span className="tf-notice-kind">{hit.status}</span>
                                )}
                                {hit.who !== null && <span className="t12 muted">{hit.who}</span>}
                              </div>
                              {hit.body !== '' && (
                                <p className="t13 muted tf-search-hit__body">
                                  {excerpt(hit.body, asked)}
                                </p>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  );
                })}

                {chatHits.length > 0 && validProjectId !== undefined && (
                  <section className="tf-search-group">
                    <div className="tf-search-group__head">
                      <h3 className="sec__title" style={{ margin: 0 }}>
                        팀 채팅 대화 <span className="num muted">({chatHits.length})</span>
                      </h3>
                    </div>
                    <ul className="tf-search-hits">
                      {chatHits.map((hit) => (
                        <li key={hit.message.id} className="tf-search-hit">
                          <div className="tf-search-hit__top">
                            <Link
                              to={`/project/${validProjectId}/chat?channel=${hit.channel_id}`}
                              className="tf-search-hit__title"
                            >
                              #{hit.channel_name} · {hit.message.author_name}
                            </Link>
                            <span className="t12 faint num">
                              {describeTime(hit.message.created_at)}
                            </span>
                          </div>
                          <p className="t13 muted tf-search-hit__body">
                            {excerpt(hit.message.body, asked)}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
