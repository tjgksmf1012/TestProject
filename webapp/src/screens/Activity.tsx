import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { Problem } from '../components/Problem.tsx';
import { ApiError } from '../api/client.ts';
import { useActivity } from '../api/hooks.ts';
import { describeEmptyActivity } from '@lib/activity/empty.ts';
import { describeTime } from '@lib/chat/view.ts';
import { teamDateOf } from '@lib/time/calendar.ts';
import { describeLoadFailure } from '@lib/ui/load.ts';

function statusOf(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null;
}

export default function Activity() {
  const params = useParams();
  const projectId = Number(params['projectId']);
  const validProjectId = Number.isFinite(projectId) && projectId > 0 ? projectId : undefined;
  const activity = useActivity(validProjectId, 100);
  const [filter, setFilter] = useState<'all' | 'contribution' | 'general'>('all');

  const cannotLoad =
    activity.error == null ? null : describeLoadFailure('활동 기록', statusOf(activity.error));

  const entries = activity.data ?? [];
  const touchCount = entries.filter((e) => e.touches_contribution).length;
  const generalCount = entries.length - touchCount;
  const shown =
    filter === 'contribution'
      ? entries.filter((e) => e.touches_contribution)
      : filter === 'general'
        ? entries.filter((e) => !e.touches_contribution)
        : entries;

  const empty = describeEmptyActivity();

  return (
    <AppShell
      title="활동 기록"
      projectId={validProjectId}
      meta={
        <span className="meta-chips">
          <span className="meta-chip">
            전체 <strong className="num">{cannotLoad === null && activity.isSuccess ? entries.length : '—'}</strong>건
          </span>
          <span className="meta-chip">
            기여도 반영 <strong className="num">{cannotLoad === null && activity.isSuccess ? touchCount : '—'}</strong>건
          </span>
        </span>
      }
    >
      <div className="panes">
        <section className="pane">
          <div className="pane__head">
            <h2 className="pane__title">팀 결정 감사 로그</h2>
            <span className="t12 muted">읽기 전용 기록 · 수정할 수 없습니다</span>
            {cannotLoad === null && activity.isSuccess && (
              <div
                className="kboard-filters"
                style={{ padding: 0, borderBottom: 0, background: 'transparent', marginLeft: 'auto' }}
                role="group"
                aria-label="활동 필터"
              >
                {[
                  { id: 'all' as const, label: `전체 (${entries.length})` },
                  { id: 'contribution' as const, label: `기여도 반영 (${touchCount})` },
                  { id: 'general' as const, label: `일반 결정 (${generalCount})` },
                ].map((chip) => (
                  <button
                    key={chip.id}
                    type="button"
                    className={`kboard-filter-chip${filter === chip.id ? ' is-active' : ''}`}
                    aria-pressed={filter === chip.id}
                    onClick={() => setFilter(chip.id)}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="pane__body">
            {cannotLoad !== null ? (
              <Problem>{cannotLoad}</Problem>
            ) : activity.isPending ? (
              <p className="t13 muted">활동 기록을 불러오는 중입니다…</p>
            ) : shown.length === 0 ? (
              <div className="empty">
                <p style={{ margin: '0 0 6px', fontWeight: 600 }}>
                  {entries.length === 0 ? '아직 기록된 활동이 없습니다' : '선택한 조건에 해당하는 기록이 없습니다'}
                </p>
                <p className="t12 muted" style={{ margin: '0 0 4px' }}>{empty.why}</p>
                <p className="t12 faint" style={{ margin: 0 }}>{empty.how}</p>
              </div>
            ) : (
              <ul className="tf-act-list">
                {shown.map((entry) => (
                  <li
                    key={entry.id}
                    className={`tf-act-item${entry.touches_contribution ? ' is-weighty' : ''}`}
                  >
                    <div className="tf-act-item__top">
                      <time className="num t12 muted" dateTime={entry.at}>
                        {teamDateOf(entry.at) ?? ''} {describeTime(entry.at)}
                      </time>
                      {entry.touches_contribution && (
                        <span className="tf-act-tag">기여도 반영</span>
                      )}
                      <span className="tf-act-who t12">{entry.who ?? '시스템'}</span>
                    </div>
                    <div className="tf-act-item__body">
                      <strong>{entry.label}</strong>
                      {entry.target_label !== '' && (
                        <span className="muted"> · {entry.target_label}</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
