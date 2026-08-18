import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { TrackRibbon, type RibbonSegment } from '../components/TrackRibbon.tsx';
import { StatusChip } from '../components/StatusChip.tsx';
import {
  useMeetings,
  useProjects,
  useSettingsMutations,
  useTracks,
} from '../api/hooks.ts';
import { api, ApiError } from '../api/client.ts';
import type { MeetingSummary } from '../api/types.ts';
import { describeMeetingStatus, nextStepFor, orderProjects } from '@lib/home/next.ts';
import { codeProblem, normalizeCode, titleProblem } from '@lib/project/setup.ts';

// 홈 — "다음에 뭘 해야 하는가" 에 대한 답 (지시서 기타-6 §홈).
//
// 회의는 상태별로 묶고 `검토 필요` 가 항상 맨 위. 각 행은 한 줄이고,
// 트랙 리본 MD 가 녹음이 얼마나 온전한지를 보여줍니다.

const GROUP_ORDER = ['needs_review', 'processing', 'failed', 'pending', 'confirmed'] as const;

/** 서버 상태 → 묶음. queued 는 처리 중과 같은 줄에 섭니다. */
function groupOf(status: string): string {
  if (status === 'queued') return 'processing';
  return GROUP_ORDER.includes(status as (typeof GROUP_ORDER)[number]) ? status : 'pending';
}

/** lib 의 MPA 주소를 SPA 라우트로. 판단(어디로·왜)은 lib 에 있습니다. */
function spaHref(href: string, projectId: number): string {
  const meeting = /meeting=(\d+)/.exec(href)?.[1];
  if (href.startsWith('/lobby.html') && meeting) return `/meeting/${meeting}/lobby`;
  if (href.startsWith('/review.html') && meeting) return `/meeting/${meeting}/review`;
  if (href.startsWith('/kanban.html')) return `/project/${projectId}/kanban`;
  return '/';
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 회의 한 줄 — 리본은 이 회의의 트랙 커버리지. */
function MeetingRow({ meeting, projectId }: { meeting: MeetingSummary; projectId: number }) {
  // 녹음 전 회의는 트랙이 없으므로 묻지 않습니다 — 빈 축이 정답입니다.
  const recorded = meeting.status !== 'pending';
  const tracks = useTracks(recorded ? meeting.meeting_id : undefined);
  const step = nextStepFor({ ...meeting, title: meeting.title });

  const coverages = (tracks.data?.tracks ?? [])
    .map((t) => t.coverage)
    .filter((c): c is number => c !== null && Number.isFinite(c));
  const coverage =
    coverages.length > 0 ? coverages.reduce((a, b) => a + b, 0) / coverages.length : null;

  const segments: RibbonSegment[] =
    coverage === null
      ? []
      : [
          { start: 0, end: coverage, kind: 'known' },
          { start: coverage, end: 1, kind: 'unknown' },
        ];
  const ribbonLabel =
    coverage === null
      ? `${meeting.title ?? '회의'} — 아직 녹음 기록이 없습니다`
      : `${meeting.title ?? '회의'} — 녹음 커버리지 ${Math.round(coverage * 100)}%`;

  return (
    <div className="mrow">
      <span className="mrow__title">{meeting.title ?? '제목 없는 회의'}</span>
      <span className="mrow__date num">{fmtDate(meeting.started_at)}</span>
      <span className="mrow__ribbon">
        <TrackRibbon size="md" segments={segments} label={ribbonLabel} />
      </span>
      <span className="mrow__cov num">
        {coverage === null ? (meeting.status === 'pending' ? '녹음 전' : '—') : `${Math.round(coverage * 100)}%`}
      </span>
      <span className="mrow__action">
        {step.href !== null ? (
          <Link
            className={`btn btn--sm ${step.actionable ? 'btn--primary' : 'btn--secondary'}`}
            to={spaHref(step.href, projectId)}
            title={step.reason}
          >
            {step.label}
          </Link>
        ) : (
          <span className="t12 muted">{step.reason}</span>
        )}
      </span>
    </div>
  );
}

/** 프로젝트 만들기/참가 — 상시 노출할 이유가 없어 헤더 뒤 대화 상자로. */
function StartDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    const bad = titleProblem(title);
    if (bad !== null) {
      setError(bad);
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/projects', { title: title.trim() });
      navigate(0);
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
      await api.post('/api/projects/join', { invite_code: normalizeCode(code) });
      navigate(0);
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : '참가하지 못했습니다');
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="프로젝트 시작하기">
      <div className="dialog">
        <h2 className="sec__title">프로젝트 시작하기</h2>
        <label className="field">
          <span className="field__label">새 프로젝트 이름</span>
          <div className="sec__row">
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
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
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => void join()}>
              참가
            </button>
          </div>
        </label>
        {error !== null && <p className="disabled-reason">{error}</p>}
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
          닫기
        </button>
      </div>
    </div>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const projectsQuery = useProjects();
  const projects = useMemo(
    () => orderProjects(projectsQuery.data ?? []),
    [projectsQuery.data],
  );
  const project = projects[0];
  const meetings = useMeetings(project?.project_id);
  const m = useSettingsMutations(project?.project_id);
  const [startOpen, setStartOpen] = useState(false);

  const groups = useMemo(() => {
    const byGroup = new Map<string, MeetingSummary[]>();
    for (const meeting of meetings.data ?? []) {
      const g = groupOf(meeting.status);
      byGroup.set(g, [...(byGroup.get(g) ?? []), meeting]);
    }
    return GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => ({
      key: g,
      label: describeMeetingStatus(g),
      meetings: byGroup.get(g) ?? [],
    }));
  }, [meetings.data]);

  return (
    <AppShell
      title={project?.title ?? '홈'}
      meta={
        project !== undefined
          ? `팀원 ${project.member_count} · 회의 ${project.meeting_count} · 검토할 회의 ${project.needs_review}`
          : undefined
      }
      actions={
        <div style={{ display: 'flex', gap: 'var(--sp-4)' }}>
          <button type="button" className="btn btn--secondary" onClick={() => setStartOpen(true)}>
            + 새 프로젝트
          </button>
          {project !== undefined && (
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
              회의 열기
            </button>
          )}
        </div>
      }
    >
      <div className="panes">
        <section className="pane">
          <div className="pane__body">
            {projectsQuery.isSuccess && project === undefined && (
              <div className="empty">
                아직 프로젝트가 없습니다. 오른쪽 위 “+ 새 프로젝트”로 만들거나 초대
                코드로 참가하세요.
              </div>
            )}
            {meetings.isSuccess && (meetings.data?.length ?? 0) === 0 && (
              <div className="empty">
                아직 회의가 없습니다. “회의 열기”로 첫 회의를 시작하면 여기서 녹음
                상태와 할 일이 보입니다.
              </div>
            )}
            {groups.map((group) => (
              <section key={group.key} className="mgroup">
                <h2 className="mgroup__title">
                  <StatusChip status={group.key} />
                </h2>
                {group.meetings.map((meeting) => (
                  <MeetingRow
                    key={meeting.meeting_id}
                    meeting={meeting}
                    projectId={project?.project_id ?? 0}
                  />
                ))}
              </section>
            ))}
            {m.openMeeting.isError && (
              <p className="disabled-reason">
                회의를 열지 못했습니다 —{' '}
                {m.openMeeting.error instanceof Error ? m.openMeeting.error.message : '알 수 없는 오류'}
              </p>
            )}
          </div>
        </section>
      </div>
      {startOpen && <StartDialog onClose={() => setStartOpen(false)} />}
    </AppShell>
  );
}
