import * as Dialog from '@radix-ui/react-dialog';
import { useMemo, useRef, useState, type MouseEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AppShell, triggerInstantCall } from '../components/AppShell.tsx';
import { TrackRibbon } from '../components/TrackRibbon.tsx';
import { StatusChip } from '../components/StatusChip.tsx';
import { Why } from '../components/Why.tsx';
import {
  useCreateProject,
  useJoinProject,
  useMeetings,
  useProjects,
  useSettingsMutations,
  useAnalytics,
} from '../api/hooks.ts';
import { ApiError } from '../api/client.ts';
import type { MeetingSummary } from '../api/types.ts';
import {
  coverageReading,
  describeCoverageRibbon,
  emphasisFor,
  emptyProjectsMessage,
  hasLane,
  homeProject,
  nextStepFor,
  requestedProjectId,
  sectionMeetings,
  describeMeetingWhen,
} from '@lib/home/next.ts';
import {
  progressText,
  overdueText,
  PROGRESS_NOTE,
  LOAD_NOTE,
  NOTHING_FOUND,
  signalViews,
  type Analytics,
} from '@lib/analytics/view.ts';
import {
  allQuiet,
  notMeasurableText,
  QUIET_TEXT,
  TRENDS_NOTE,
  trendLine,
} from '@lib/analytics/trends.ts';
import { codeProblem, normalizeCode, titleProblem } from '@lib/project/setup.ts';
import { describeActionFailure } from '@lib/ui/load.ts';
import { meetingLabel } from '@lib/ui/naming.ts';
import { plainText } from '@lib/ui/plain.ts';
import { Problem } from '../components/Problem.tsx';

function spaHref(href: string, projectId: number): string {
  const meeting = /meeting=(\d+)/.exec(href)?.[1];
  if (href.startsWith('/lobby.html') && meeting) return `/meeting/${meeting}/lobby`;
  if (href.startsWith('/review.html') && meeting) return `/meeting/${meeting}/review`;
  if (href.startsWith('/kanban.html')) return `/project/${projectId}/kanban`;
  return '/';
}

function MeetingRow({
  meeting,
  projectId,
  waiting,
}: {
  meeting: MeetingSummary;
  projectId: number;
  waiting: boolean;
}) {
  const step = nextStepFor({ ...meeting, title: meeting.title }, projectId);
  const coverage = meeting.coverage;

  return (
    <div className="mrow">
      <span className="mrow__status">{!waiting && <StatusChip status={meeting.status} />}</span>
      <span className="mrow__title">{meetingLabel(meeting.title, meeting.meeting_id)}</span>
      <span className="mrow__date num">{describeMeetingWhen(meeting)}</span>
      <span className="mrow__ribbon">
        {hasLane(coverage) && (
          <TrackRibbon
            size="md"
            segments={[
              { start: 0, end: coverage as number, kind: 'known' },
              { start: coverage as number, end: 1, kind: 'unknown' },
            ]}
            label={describeCoverageRibbon(
              meetingLabel(meeting.title, meeting.meeting_id),
              coverage as number,
            )}
          />
        )}
      </span>
      <span className="mrow__cov num">
        {hasLane(coverage) ? coverageReading(coverage as number) : ''}
      </span>
      <span className="mrow__action">
        {step.href !== null ? (
          <Link
            className={`btn btn--sm btn--${emphasisFor(step, waiting)}`}
            to={spaHref(step.href, projectId)}
          >
            {step.label}
          </Link>
        ) : (
          <span className="mrow__none">—</span>
        )}
        <Why
          about={`${meetingLabel(meeting.title, meeting.meeting_id)} — 다음에 할 일`}
          lines={[step.reason]}
          countsAs="안내"
        />
      </span>
    </div>
  );
}

/** 프로젝트 현황 판 — 장황한 설명문은 `?` 팝오버와 접힘 메뉴로 숨기고 핵심 지표만 깔끔한 카드로 표시 */
function ProjectHealthPane({
  projectId,
  analytics,
}: {
  projectId: number;
  analytics?: Analytics;
}) {
  if (!analytics) return null;
  const views = signalViews(analytics.signals);
  const late = overdueText(analytics.progress);

  return (
    <section className="pane pane--evidence tf-health-pane" aria-label="프로젝트 현황">
      <div className="pane__head">
        <h2 className="pane__title">프로젝트 요약</h2>
        <span className="pane__hint">실시간 지표</span>
      </div>
      <div className="pane__body tf-health-body">
        {/* 1. 업무 진행률 카드 */}
        <div className="tf-health-card">
          <div className="tf-health-card__hdr">
            <h3 className="tf-health-card__title">업무 진행률</h3>
            <Why about="업무 진행률 집계 기준" lines={[PROGRESS_NOTE]} countsAs="안내" />
          </div>
          <div className="tf-health-card__metric num">
            {progressText(analytics.progress)}
          </div>
          {late !== null && (
            <div className="tf-late-pill">
              <span aria-hidden="true">⚠</span> {late}
            </div>
          )}
        </div>

        {/* 2. 담당 업무 현황 (2열 컴팩트 그리드) */}
        <div className="tf-health-card">
          <div className="tf-health-card__hdr">
            <h3 className="tf-health-card__title">담당 중인 업무</h3>
            <Why about="담당 업무 수 안내" lines={[plainText(LOAD_NOTE)]} countsAs="안내" />
          </div>
          <ul className="tf-load-grid">
            {analytics.load.map((row) => (
              <li key={row.user_id ?? 'none'} className="tf-load-chip">
                <span className="tf-load-chip__name">{row.name}</span>
                <span className="tf-load-chip__val num">{row.open_tasks}건</span>
              </li>
            ))}
          </ul>
        </div>

        {/* 3. 감지된 신호 */}
        <div className="tf-health-card">
          <div className="tf-health-card__hdr">
            <h3 className="tf-health-card__title">감지된 신호</h3>
          </div>
          {views.length === 0 ? (
            <p className="t12 muted">{NOTHING_FOUND}</p>
          ) : (
            <ul className="tf-signal-list">
              {views.map((v) => (
                <li key={v.kind} className="tf-signal-item">
                  <div className="tf-signal-item__title">{v.title}</div>
                  {v.reason !== null && (
                    <div className="tf-signal-item__reason">{v.reason}</div>
                  )}
                  {v.taskIds.length > 0 && (
                    <div className="tf-signal-item__links">
                      {v.taskIds.slice(0, 5).map((tid) => (
                        <Link
                          key={tid}
                          className="chip chip--evidence"
                          to={`/project/${projectId}/kanban`}
                        >
                          #{tid}
                        </Link>
                      ))}
                      {v.taskIds.length > 5 && (
                        <span className="t12 muted">+{v.taskIds.length - 5}</span>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 4. 회의 품질 추세 (기본 접힘 처리로 화면 난잡함 방지) */}
        <details className="disc tf-trend-disc">
          <summary>
            <span>회의 추세 분석 요약</span>
            <Why about="회의 추세 비교 방식" lines={[TRENDS_NOTE]} countsAs="안내" />
          </summary>
          <div className="disc__body">
            {!analytics.meeting_trends.measurable ? (
              <p className="t12 gap">{notMeasurableText(analytics.meeting_trends)}</p>
            ) : allQuiet(analytics.meeting_trends.kinds) ? (
              <p className="t12 muted">{QUIET_TEXT}</p>
            ) : (
              <ul className="tf-trend-list">
                {analytics.meeting_trends.kinds.map((kind) => (
                  <li key={kind.kind} className="tf-trend-item">
                    {trendLine(kind)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </details>
      </div>
    </section>
  );
}

function StartDialog({
  focus,
  onClose,
  onClosed,
}: {
  focus: 'create' | 'join' | null;
  onClose: () => void;
  onClosed: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const land = async (projectId: number) => {
    await queryClient.invalidateQueries({ queryKey: ['projects'] });
    navigate(`/?project=${projectId}`);
    onClose();
  };

  const createProject = useCreateProject();
  const joinProject = useJoinProject();

  const create = async () => {
    const bad = titleProblem(title);
    if (bad !== null) {
      setError(bad);
      return;
    }
    setBusy(true);
    try {
      const made = await createProject.mutateAsync(title.trim());
      await land(made.project_id);
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : '만들지 못했습니다');
      setBusy(false);
    }
  };
  const join = async () => {
    const bad = codeProblem(code);
    if (bad !== null) {
      setError(bad);
      return;
    }
    setBusy(true);
    try {
      const joined = await joinProject.mutateAsync(normalizeCode(code));
      await land(joined.project_id);
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : '참가하지 못했습니다');
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      open={focus !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-backdrop" />
        <Dialog.Content
          className="dialog"
          aria-label="프로젝트 시작하기"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onClosed();
          }}
        >
          <Dialog.Title className="sec__title">프로젝트 시작하기</Dialog.Title>
          <label className="field">
            <span className="field__label">새 프로젝트 이름</span>
            <div className="sec__row">
              <input
                className="input"
                autoFocus={focus === 'create'}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void create()}>
                만들기
              </button>
            </div>
          </label>
          <label className="field">
            <span className="field__label">또는 초대 코드로 참가</span>
            <div className="sec__row">
              <input
                className="input input--num"
                placeholder="ABCD-EFGH"
                autoFocus={focus === 'join'}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => void join()}>
                참가
              </button>
            </div>
          </label>
          <Problem>{error}</Problem>
          <Dialog.Close asChild>
            <button type="button" className="btn btn--ghost btn--sm">
              닫기
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const { search } = useLocation();
  const projectsQuery = useProjects();
  const project = useMemo(
    () => homeProject(projectsQuery.data ?? [], requestedProjectId(search)),
    [projectsQuery.data, search],
  );
  const meetings = useMeetings(project?.project_id);
  const analytics = useAnalytics(project?.project_id);
  const m = useSettingsMutations(project?.project_id);
  const [starting, setStarting] = useState<'create' | 'join' | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const start =
    (which: 'create' | 'join') => (event: MouseEvent<HTMLButtonElement>) => {
      openerRef.current = event.currentTarget;
      setStarting(which);
    };

  const sections = useMemo(() => sectionMeetings(meetings.data ?? []), [meetings.data]);

  return (
    <AppShell
      projectId={project?.project_id}
      title={project?.title ?? '홈'}
      meta={
        project !== undefined ? (
          <span className="meta-chips">
            <span className="meta-chip">
              팀원 <strong>{project.member_count}</strong>
            </span>
            <span className="meta-chip">
              회의 <strong>{project.meeting_count}</strong>
            </span>
            {project.needs_review > 0 ? (
              <span className="meta-chip meta-chip--highlight">
                검토 필요 <strong>{project.needs_review}</strong>
              </span>
            ) : (
              <span className="meta-chip">
                검토 필요 <strong>0</strong>
              </span>
            )}
          </span>
        ) : undefined
      }
      actions={
        <div className="appbar__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={start('create')}>
            + 새 프로젝트
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={start('join')}>
            초대 코드
          </button>
          {project !== undefined && (
            <button
              type="button"
              className={`btn ${sections.needsReview.length > 0 ? 'btn--secondary' : 'btn--primary'}`}
              disabled={m.openMeeting.isPending}
              onClick={() =>
                m.openMeeting.mutate(undefined, {
                  onSuccess: (meeting) => navigate(`/meeting/${meeting.meeting_id}/lobby`),
                })
              }
            >
              회의 열기
            </button>
          )}
        </div>
      }
    >
      <div className="panes">
        <section className="pane" style={project !== undefined ? { flex: '1 1 68%' } : undefined}>
          <div className="pane__body">
            {/* 상단 워크스페이스 퀵 액션 벤토 카드 */}
            {project !== undefined && (
              <div className="tf-home-bento">
                <div className="tf-bento-card tf-bento-card--call">
                  <div className="tf-bento-card__top">
                    <span className="tf-bento-icon tf-bento-icon--green">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <polygon points="23 7 16 12 23 17 23 7" />
                        <rect x="1" y="5" width="15" height="14" rx="2" />
                      </svg>
                    </span>
                    <span className="tf-bento-badge">실시간 회의</span>
                  </div>
                  <div className="tf-bento-card__title">음성 회의실</div>
                  <div className="tf-bento-card__sub">
                    개별 동의를 확인한 뒤 음성 통화와 녹음 화면을 엽니다
                  </div>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm tf-bento-btn"
                    onClick={() => triggerInstantCall(project.project_id)}
                  >
                    회의실 열기
                  </button>
                </div>

                <div className="tf-bento-card">
                  <div className="tf-bento-card__top">
                    <span className="tf-bento-icon">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <rect x="3" y="4" width="5" height="16" rx="1" />
                        <rect x="10" y="4" width="5" height="11" rx="1" />
                        <rect x="17" y="4" width="4" height="14" rx="1" />
                      </svg>
                    </span>
                    <span className="tf-bento-badge num">
                      {analytics.data ? progressText(analytics.data.progress) : '업무 보드'}
                    </span>
                  </div>
                  <div className="tf-bento-card__title">칸반 보드</div>
                  <div className="tf-bento-card__sub">
                    할 일 배정, 진행 상태, GitHub PR 연결 내역을 관리합니다
                  </div>
                  <Link
                    className="btn btn--secondary btn--sm tf-bento-btn"
                    to={`/project/${project.project_id}/kanban`}
                  >
                    칸반 보드 열기 →
                  </Link>
                </div>

                <div className="tf-bento-card">
                  <div className="tf-bento-card__top">
                    <span className="tf-bento-icon">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="M4 6h16M4 12h16M4 18h16" />
                        <circle cx="9" cy="6" r="2" fill="currentColor" />
                        <circle cx="14" cy="12" r="2" fill="currentColor" />
                        <circle cx="11" cy="18" r="2" fill="currentColor" />
                      </svg>
                    </span>
                    <span className="tf-bento-badge">활동 요약</span>
                  </div>
                  <div className="tf-bento-card__title">팀원별 기여도</div>
                  <div className="tf-bento-card__sub">
                    회의 참여, 업무 완료, 코드 기여 내역을 한눈에 확인합니다
                  </div>
                  <Link
                    className="btn btn--secondary btn--sm tf-bento-btn"
                    to={`/project/${project.project_id}/contributions`}
                  >
                    기여도 보기 →
                  </Link>
                </div>
              </div>
            )}

            {projectsQuery.isSuccess && project === undefined && (
              <div className="empty">
                <p style={{ margin: 0 }}>{emptyProjectsMessage()}</p>
                <div className="sec__row" style={{ justifyContent: 'center', marginTop: 'var(--sp-5)' }}>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={start('create')}
                  >
                    새 프로젝트 만들기
                  </button>
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={start('join')}
                  >
                    초대 코드로 참가
                  </button>
                </div>
              </div>
            )}
            {project !== undefined && meetings.isSuccess && (meetings.data?.length ?? 0) === 0 && (
              <div
                className="card tf-onboarding-card"
                style={{
                  padding: '24px',
                  marginBottom: '24px',
                  border: '1px solid var(--c-accent)',
                  borderRadius: 'var(--r-lg)',
                  background: 'var(--c-surface-sunken)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px', flexWrap: 'wrap', gap: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '20px' }}>🚀</span>
                    <h2 style={{ fontSize: 'var(--fs-16)', fontWeight: 'var(--fw-bold)', margin: 0 }}>
                      TeamFlow AI 첫 발자국 가이드 (30초 온보딩)
                    </h2>
                  </div>
                  <span className="dc-badge dc-badge--ok">클린 워크스페이스 준비됨</span>
                </div>
                <p className="t13 muted" style={{ margin: '0 0 16px 0', lineHeight: 1.6 }}>
                  TeamFlow AI는 <strong>“회의에서 나온 말이 칸반과 기여도 기록까지 자동으로 이어지는 도구”</strong>입니다.
                  새 워크스페이스에서 아래 3단계를 따라 첫 회의를 시작하고 기여도를 쌓아보세요.
                </p>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px', marginBottom: '20px' }}>
                  <div style={{ background: 'var(--c-surface)', padding: '14px', borderRadius: 'var(--r-md)', border: '1px solid var(--c-border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                      <span className="dc-badge dc-badge--ok num">1단계</span>
                      <strong style={{ fontSize: '13px' }}>음성 회의와 개별 녹음</strong>
                    </div>
                    <p className="t12 muted" style={{ margin: 0, lineHeight: 1.5 }}>
                      전원이 동의한 뒤 각자의 트랙을 녹음합니다. 발언자는 녹음한 팀원으로 구분하고 AI가 음성을 전사합니다.
                    </p>
                  </div>
                  <div style={{ background: 'var(--c-surface)', padding: '14px', borderRadius: 'var(--r-md)', border: '1px solid var(--c-border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                      <span className="dc-badge dc-badge--warn num">2단계</span>
                      <strong style={{ fontSize: '13px' }}>AI 후보 검토 & 승인</strong>
                    </div>
                    <p className="t12 muted" style={{ margin: 0, lineHeight: 1.5 }}>
                      LLM이 도출한 의사결정과 할 일 후보를 원문 대화록과 대조하며 담당자와 마감일을 확정합니다.
                    </p>
                  </div>
                  <div style={{ background: 'var(--c-surface)', padding: '14px', borderRadius: 'var(--r-md)', border: '1px solid var(--c-border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                      <span className="dc-badge dc-badge--info num">3단계</span>
                      <strong style={{ fontSize: '13px' }}>칸반 보드 & 기여도 산출</strong>
                    </div>
                    <p className="t12 muted" style={{ margin: 0, lineHeight: 1.5 }}>
                      승인된 업무가 칸반으로 넘어가고, GitHub PR과 함께 4대 불변식 기여도 구간으로 기록됩니다.
                    </p>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={m.openMeeting.isPending}
                    onClick={() =>
                      m.openMeeting.mutate(undefined, {
                        onSuccess: (meeting) => navigate(`/meeting/${meeting.meeting_id}/lobby`),
                      })
                    }
                  >
                    🎤 첫 회의 시작하기
                  </button>
                  <Link to="/demo" className="btn btn--secondary">
                    🧪 AI 기능 체험관 (Demo Lab) 둘러보기 →
                  </Link>
                </div>
              </div>
            )}

            {(projectsQuery.data?.length ?? 0) >= 2 && (
              <div style={{ marginBottom: 'var(--sp-5)' }}>
                <details className="disc tf-proj-disc">
                  <summary>
                    전체 프로젝트 전환 ({projectsQuery.data!.length}개 · 가나다순)
                  </summary>
                  <div className="sec__list" style={{ marginTop: 'var(--sp-3)' }}>
                    {[...projectsQuery.data!]
                      .sort((a, b) => a.title.localeCompare(b.title, 'ko'))
                      .map((p) => (
                        <div key={p.project_id} className="mrow">
                          <span className="mrow__title">
                            <Link to={`/?project=${p.project_id}`}>{p.title}</Link>
                          </span>
                          <span className="mrow__when">
                            팀원 {p.member_count} · 회의 {p.meeting_count}
                          </span>
                          <span className="mrow__state">
                            {p.needs_review > 0 ? `검토 필요 ${p.needs_review}건` : '검토 대기 없음'}
                          </span>
                          <span className="mrow__action">
                            <Link className="btn btn--secondary btn--sm" to={`/?project=${p.project_id}`}>
                              열기
                            </Link>
                          </span>
                        </div>
                      ))}
                  </div>
                </details>
              </div>
            )}

            {sections.needsReview.length > 0 && (
              <section className="mgroup">
                <h2 className="mgroup__title">
                  <StatusChip status="needs_review" />
                  <span className="mgroup__count num">{sections.needsReview.length}</span>
                </h2>
                {sections.needsReview.map((meeting) => (
                  <MeetingRow
                    key={meeting.meeting_id}
                    meeting={meeting as MeetingSummary}
                    projectId={project?.project_id ?? 0}
                    waiting
                  />
                ))}
              </section>
            )}

            {sections.rest.length > 0 && (
              <section className="mgroup mgroup--flat">
                <div className="tf-section-subhdr">최근 회의 목록</div>
                {sections.rest.map((meeting) => (
                  <MeetingRow
                    key={meeting.meeting_id}
                    meeting={meeting as MeetingSummary}
                    projectId={project?.project_id ?? 0}
                    waiting={false}
                  />
                ))}
              </section>
            )}

            {m.openMeeting.isError && (
              <Problem>
                {describeActionFailure(
                  '회의 열기',
                  m.openMeeting.error instanceof ApiError ? m.openMeeting.error.status : null,
                  m.openMeeting.error instanceof ApiError ? m.openMeeting.error.detail : null,
                )}
              </Problem>
            )}
          </div>
        </section>
        {project !== undefined && (
          <ProjectHealthPane projectId={project.project_id} analytics={analytics.data} />
        )}
      </div>
      <StartDialog
        focus={starting}
        onClose={() => setStarting(null)}
        onClosed={() => openerRef.current?.focus()}
      />
    </AppShell>
  );
}
