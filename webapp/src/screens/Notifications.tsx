import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { Problem } from '../components/Problem.tsx';
import { ApiError } from '../api/client.ts';
import {
  useMarkNotificationsRead,
  useNotifications,
  useUnreadNotifications,
} from '../api/hooks.ts';
import { appRailHref } from '@lib/nav/rail.ts';
import {
  canMarkAllRead,
  describeKind,
  emptyNote,
  hrefFor,
  isUrgent,
  timeLabel,
  type Notice,
} from '@lib/notifications/view.ts';
import { describeActionFailure, describeLoadFailure } from '@lib/ui/load.ts';

function statusOf(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null;
}

function detailOf(error: unknown): string | null {
  return error instanceof ApiError ? error.detail : null;
}

export default function Notifications() {
  const params = useParams();
  const projectId = Number(params['projectId']);
  const list = useNotifications(Number.isFinite(projectId) ? projectId : undefined);
  const unreadQuery = useUnreadNotifications(Number.isFinite(projectId) ? projectId : undefined);
  const markRead = useMarkNotificationsRead(Number.isFinite(projectId) ? projectId : undefined);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');

  const cannotLoad =
    list.error == null ? null : describeLoadFailure('알림', statusOf(list.error));

  const unreadCount = unreadQuery.data?.unread_count ?? 0;
  const canReadAll = canMarkAllRead(unreadCount);
  const all = list.data ?? [];
  const items = filter === 'unread' ? all.filter((n) => !n.read) : all;
  const empty = emptyNote();

  const spaTarget = (notice: Notice): { internal: string } | { external: string } | null => {
    if (notice.meeting_id !== null) {
      return { internal: `/meeting/${notice.meeting_id}/lobby` };
    }
    if (notice.task_id !== null) {
      return { internal: appRailHref('kanban', projectId) };
    }
    const legacy = hrefFor(notice, projectId);
    return legacy !== null ? { external: legacy } : null;
  };

  return (
    <AppShell
      title="알림"
      projectId={projectId}
      meta={
        <span className="meta-chips">
          <span className="meta-chip">
            미확인 <strong className="num">{unreadQuery.isSuccess ? unreadCount : '—'}</strong>
          </span>
          <span className="meta-chip">
            전체 <strong className="num">{list.isSuccess ? all.length : '—'}</strong>
          </span>
        </span>
      }
      actions={
        <div className="appbar__actions">
          <button
            type="button"
            className={`btn btn--secondary btn--sm${!canReadAll ? ' btn--unmet' : ''}`}
            aria-disabled={!canReadAll || markRead.isPending}
            aria-describedby={!canReadAll ? 'mark-all-why' : undefined}
            onClick={() => {
              if (!canReadAll || markRead.isPending) return;
              markRead.mutate({ notification_ids: [], all_unread: true });
            }}
          >
            {markRead.isPending ? '처리 중…' : '모두 읽음으로'}
          </button>
        </div>
      }
    >
      <div className="panes">
        <section className="pane">
          <div className="pane__head">
            <h2 className="pane__title">알림 함</h2>
            <div className="kboard-filters" style={{ padding: 0, borderBottom: 0, background: 'transparent', marginLeft: 'auto' }} role="group" aria-label="알림 필터">
              {[
                { id: 'all' as const, label: `전체 (${all.length})` },
                { id: 'unread' as const, label: `안 읽음 (${all.filter((n) => !n.read).length})` },
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
          </div>
          <div className="pane__body">
            {!canReadAll && (
              <p className="t12 faint" id="mark-all-why" style={{ marginBottom: 'var(--sp-3)' }}>
                읽지 않은 저장 알림이 없습니다 (마감 임박·지연 알림은 업무 상태가 바뀌면 자동으로 사라집니다).
              </p>
            )}
            {markRead.isError && (
              <Problem>
                {describeActionFailure(
                  '알림 읽음 표시',
                  statusOf(markRead.error),
                  detailOf(markRead.error),
                )}
              </Problem>
            )}
            {cannotLoad !== null ? (
              <Problem>{cannotLoad}</Problem>
            ) : list.isPending ? (
              <p className="t13 muted">알림을 불러오는 중입니다…</p>
            ) : items.length === 0 ? (
              <div className="empty">
                <p style={{ margin: '0 0 6px', fontWeight: 600 }}>
                  {filter === 'unread' ? '읽지 않은 알림이 없습니다' : empty.what}
                </p>
                <p className="t12 muted" style={{ margin: '0 0 4px' }}>{empty.why}</p>
                <p className="t12 faint" style={{ margin: 0 }}>{empty.how}</p>
              </div>
            ) : (
              <div className="tf-notice-list">
                {items.map((n, index) => {
                  const when = timeLabel(n);
                  const dest = spaTarget(n);
                  const urgent = isUrgent(n);
                  return (
                    <article
                      key={`${n.kind}-${n.notification_id ?? index}-${n.at}`}
                      className={`tf-notice-item${!n.read ? ' is-unread' : ''}${urgent ? ' is-urgent' : ''}`}
                    >
                      <div className="tf-notice-item__top">
                        <span className={`tf-notice-kind${urgent ? ' is-urgent' : ''}`}>
                          {describeKind(n.kind)}
                        </span>
                        {!n.read && n.notification_id !== null && (
                          <span className="tf-notice-dot" aria-label="읽지 않음" />
                        )}
                        {when !== null && <span className="t12 faint num">{when}</span>}
                      </div>
                      <p className="tf-notice-item__text">{n.text}</p>
                      <div className="tf-notice-item__actions">
                        {dest !== null && 'internal' in dest && (
                          <Link
                            to={dest.internal}
                            className="btn btn--secondary btn--sm"
                            onClick={() => {
                              if (n.notification_id !== null && !n.read) {
                                markRead.mutate({ notification_ids: [n.notification_id], all_unread: false });
                              }
                            }}
                          >
                            바로 보기 →
                          </Link>
                        )}
                        {dest !== null && 'external' in dest && (
                          <a
                            href={dest.external}
                            className="btn btn--secondary btn--sm"
                            onClick={() => {
                              if (n.notification_id !== null && !n.read) {
                                markRead.mutate({ notification_ids: [n.notification_id], all_unread: false });
                              }
                            }}
                          >
                            채팅 열기 →
                          </a>
                        )}
                        {n.notification_id !== null && !n.read && (
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            disabled={markRead.isPending}
                            onClick={() =>
                              markRead.mutate({ notification_ids: [n.notification_id!], all_unread: false })
                            }
                          >
                            읽음 표시
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
