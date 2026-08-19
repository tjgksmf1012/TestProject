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
import { hasLane, nextStepFor, orderProjects, sectionMeetings } from '@lib/home/next.ts';
import { codeProblem, normalizeCode, titleProblem } from '@lib/project/setup.ts';

// 홈 — "다음에 뭘 해야 하는가" 에 대한 답 (지시서 기타-6 §홈).
//
// ⚠️ **상태별 묶음을 걷어냈습니다** (v2 F4). 회의 다섯에 그룹이 다섯이면
// 그건 묶음이 아니라 머리말 다섯이고, 목록 높이의 절반을 머리말이 먹었습니다.
// 게다가 그룹 순서가 상태 순서라 날짜가 뒤죽박죽이 되어 시간 감각이
// 사라졌습니다. 이제 **사람을 기다리는 것(검토 필요)만** 위로 올리고,
// 나머지는 최근 것부터 한 덩어리입니다. 가르는 판단은 `@lib` 에 있습니다.

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

/**
 * 회의 한 줄.
 *
 * 칸은 여섯이고 **폭이 고정**입니다 (v2 F6) —
 * `[상태 120] [제목 1fr] [날짜 100] [레인 260] [수치 60] [액션 140]`.
 * 예전에는 설명 텍스트가 x=1264 까지 뻗어 버튼 열을 침범했고, 버튼 우측
 * 끝이 행마다 1264~1268px 로 제각각이라 세로로 훑을 수가 없었습니다.
 *
 * `waiting` 이면 상태 칸을 **비웁니다** — 「검토 필요」 덩어리 안에서는
 * 머리말이 이미 그 말을 했습니다. 칸 자체는 남으므로 두 덩어리의 액션 열
 * 우측 끝은 같은 x 에 섭니다.
 */
function MeetingRow({
  meeting,
  projectId,
  waiting,
}: {
  meeting: MeetingSummary;
  projectId: number;
  /**
   * 이 줄이 「검토 필요」 덩어리 안에 있는가 = **지금 사람을 기다리는가.**
   * 참이면 상태 칸을 비우고(머리말이 이미 말했습니다) 버튼을 primary 로.
   */
  waiting: boolean;
}) {
  // 녹음 전 회의는 트랙이 없으므로 묻지 않습니다 — 빈 축이 정답입니다.
  const recorded = meeting.status !== 'pending';
  const tracks = useTracks(recorded ? meeting.meeting_id : undefined);
  const step = nextStepFor({ ...meeting, title: meeting.title });

  const coverages = (tracks.data?.tracks ?? [])
    .map((t) => t.coverage)
    .filter((c): c is number => c !== null && Number.isFinite(c));
  const coverage =
    coverages.length > 0 ? coverages.reduce((a, b) => a + b, 0) / coverages.length : null;

  return (
    <div className="mrow">
      <span className="mrow__status">{!waiting && <StatusChip status={meeting.status} />}</span>
      <span className="mrow__title">{meeting.title ?? '제목 없는 회의'}</span>
      <span className="mrow__date num">{fmtDate(meeting.started_at)}</span>
      {/* ⚠️ **잴 게 없으면 레인을 안 그립니다** (v2 F3). 예전에는 회의
          다섯 중 넷이 빈 회색 막대였고, 값 없는 요소가 목록의 시각적
          무게중심을 차지했습니다. 레인은 "아는 것 / 모르는 것" 을 말하는
          문법인데, 잴 게 없을 때 빈 막대를 그리면 그 문법이 무너집니다.
          이 줄의 상태는 상태 칸이 이미 말하고 있습니다. */}
      <span className="mrow__ribbon">
        {hasLane(coverage) && (
          <TrackRibbon
            size="md"
            segments={[
              { start: 0, end: coverage as number, kind: 'known' },
              { start: coverage as number, end: 1, kind: 'unknown' },
            ]}
            label={`${meeting.title ?? '회의'} — 녹음 커버리지 ${Math.round((coverage as number) * 100)}%`}
          />
        )}
      </span>
      <span className="mrow__cov num">
        {hasLane(coverage) ? `${Math.round((coverage as number) * 100)}%` : ''}
      </span>
      <span className="mrow__action">
        {step.href !== null ? (
          /* ⚠️ **primary 는 「검토 필요」 줄에만** (v2 F9). 예전에는
             `actionable` 인 줄이 전부 인디고라 한 화면에 primary 가 셋이었고,
             셋이 다 강조면 아무것도 강조가 아닙니다. 나머지 줄도 `actionable`
             여부는 살립니다 — 갈 수 있는 곳은 테두리 버튼, 그냥 보러 가는
             곳은 ghost. lib 이 준 판단을 버리지 않습니다. */
          <Link
            className={`btn btn--sm ${
              waiting ? 'btn--primary' : step.actionable ? 'btn--secondary' : 'btn--ghost'
            }`}
            to={spaHref(step.href, projectId)}
            title={step.reason}
          >
            {step.label}
          </Link>
        ) : (
          /* 갈 곳이 없는 상태(처리 중)입니다. 이유는 상태 칩이 이미 말하고
             있으므로 여기서 되풀이하지 않습니다. 자리는 비워 두지 않고
             `—` 로 예약합니다 — 행마다 우측 끝이 어긋나면 세로 스캔이
             죽습니다. */
          <span className="mrow__none" title={step.reason}>
            —
          </span>
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

  // 가르는 판단은 `@lib` 에 있습니다 — 화면은 그리기만.
  const sections = useMemo(() => sectionMeetings(meetings.data ?? []), [meetings.data]);

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
          {/* v2 F9 — 화면당 primary 는 하나. 주된 행동은 `회의 열기` 입니다. */}
          <button type="button" className="btn btn--ghost" onClick={() => setStartOpen(true)}>
            + 새 프로젝트
          </button>
          {project !== undefined && (
            /* ⚠️ 사람을 기다리는 회의가 있으면 **그 줄의 버튼이 primary**
               이고 이 버튼은 양보합니다 (v2 F9). 지금 해야 할 일이 검토인데
               `회의 열기` 가 같이 인디고면 어느 쪽이 먼저인지 화면이 말해
               주지 않습니다. 검토할 게 없으면 새 회의를 여는 것이 다음
               행동이므로 이 버튼이 primary 로 돌아옵니다. */
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
            {/* 사람을 기다리는 것만 따로. 머리말은 **여기 한 번**뿐이고,
                이 덩어리의 줄들은 상태 칸을 비웁니다. */}
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
            {/* 나머지는 묶지 않고 최근 것부터. 상태는 줄마다 자기 칸에서
                말합니다 — 그룹 머리말 다섯 개가 목록의 절반을 먹던 것을
                걷어낸 자리입니다. */}
            {sections.rest.length > 0 && (
              <section className="mgroup mgroup--flat">
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
