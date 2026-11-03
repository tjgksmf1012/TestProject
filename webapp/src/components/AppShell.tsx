import { useEffect, useState, type ReactNode } from 'react';
import { MAIN_LANDMARK_ID, SKIP_HREF, SKIP_TEXT } from '@lib/nav/skip.ts';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useProjects, useUnreadNotifications } from '../api/hooks.ts';
import { pageTitle } from '@lib/shell/title.ts';
import { appScreenOf } from '@lib/nav/links.ts';
import { appRailHref, railAriaLabel, railIsWorthIt, railItems } from '@lib/nav/rail.ts';
import { describeLogoutFailure, logoutOutcome } from '@lib/auth/session.ts';
import { api, ApiError } from '../api/client.ts';
import { Problem } from './Problem.tsx';
import { SettingsModal } from './SettingsModal.tsx';
import { CallStageModal } from './CallStageModal.tsx';
import { CommandPalette } from './CommandPalette.tsx';

// 앱 셸 — 레일 72px + 헤더 56px + 판. R1: body 는 스크롤하지 않습니다.
// 레일은 홈 · 칸반 · 기여도 · 설정 + 빠른 런처(더보기) · 음성/성문 설정 · 로그아웃.

function IconHome() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M3.5 9.5 L10 3.5 L16.5 9.5 V16.5 H12 V12 H8 V16.5 H3.5 Z" strokeLinejoin="round" />
    </svg>
  );
}
function IconKanban() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
      <rect x="3" y="3.5" width="4" height="13" rx="1" />
      <rect x="8" y="3.5" width="4" height="9" rx="1" />
      <rect x="13" y="3.5" width="4" height="6" rx="1" />
    </svg>
  );
}
function IconContrib() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M4 5 V15 M16 5 V15" strokeLinecap="round" />
      <path d="M6.5 10 H13.5" strokeLinecap="round" />
    </svg>
  );
}
function IconLogout() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M12.5 6.5V4.5H3.5v11h9v-2" strokeLinejoin="round" />
      <path d="M8.5 10h8M14 7.5 16.5 10 14 12.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
function IconSettings() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M4 6.5 H16 M4 13.5 H16" strokeLinecap="round" />
      <circle cx="8" cy="6.5" r="1.8" fill="var(--c-surface)" />
      <circle cx="12.5" cy="13.5" r="1.8" fill="var(--c-surface)" />
    </svg>
  );
}

interface AppShellProps {
  title: string;
  /** 헤더 오른쪽 — 주 행동은 화면당 하나만. */
  actions?: ReactNode;
  /** 창 제목에만 쓸 이름. 안 주면 `title` 을 씁니다. */
  docTitle?: string;
  /** 제목 옆 모노 보조값 (건수·시각 등). */
  meta?: ReactNode;
  /** 회의 화면처럼 URL 에 projectId 가 없을 때 레일 목적지를 알려 줍니다. */
  projectId?: number;
  children: ReactNode;
}

const RAIL_BLOCKED_WHY = '프로젝트를 만들거나 초대 코드로 참가하면 열립니다';

// 모듈 수준 공유 상태 — 화면(홈 ↔ 칸반 ↔ 기여도)을 이동해도 화상 통화 PIP가 끊기지 않고 유지됩니다.
let sharedCallOpen = false;
let sharedCallMin = false;
const callListeners = new Set<() => void>();

export function triggerInstantCall(minimized = false): void {
  sharedCallOpen = true;
  sharedCallMin = minimized;
  callListeners.forEach((fn) => fn());
}

export function AppShell({ title, docTitle, actions, meta, projectId, children }: AppShellProps) {
  const params = useParams();
  const { pathname } = useLocation();
  const { data: projects } = useProjects();
  const pid =
    projectId ??
    (params['projectId'] !== undefined ? Number(params['projectId']) : projects?.[0]?.project_id);
  const { data: unread } = useUnreadNotifications(pid);
  const unreadCount = unread?.unread_count ?? 0;

  // Modals state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'voice' | 'account' | 'display'>('voice');
  const [cmdOpen, setCmdOpen] = useState(false);
  const [callState, setCallState] = useState({ open: sharedCallOpen, min: sharedCallMin });
  const [isDark, setIsDark] = useState(
    () => document.documentElement.dataset.theme === 'dark',
  );

  const toggleTheme = () => {
    const next = isDark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem('tf_theme', next);
    } catch {
      // ignore
    }
    setIsDark(!isDark);
  };

  useEffect(() => {
    const sync = () => setCallState({ open: sharedCallOpen, min: sharedCallMin });
    callListeners.add(sync);
    return () => {
      callListeners.delete(sync);
    };
  }, []);

  const setCallOpen = (open: boolean) => {
    sharedCallOpen = open;
    if (!open) sharedCallMin = false;
    callListeners.forEach((fn) => fn());
  };

  const setCallMin = (min: boolean) => {
    sharedCallMin = min;
    callListeners.forEach((fn) => fn());
  };

  const projectRail = railIsWorthIt(projects ?? [])
    ? railItems(projects ?? [], appScreenOf(pathname), pid ?? null, appRailHref)
    : [];

  const noProject = pid === undefined;
  const items = [
    {
      label: '홈',
      screen: 'home' as const,
      active: pathname === '/' || pathname.startsWith('/meeting/'),
      icon: <IconHome />,
    },
    {
      label: '칸반',
      screen: 'kanban' as const,
      active: pathname.includes('/kanban'),
      icon: <IconKanban />,
    },
    {
      label: '기여도',
      screen: 'contributions' as const,
      active: pathname.includes('/contributions'),
      icon: <IconContrib />,
    },
    {
      label: '설정',
      screen: 'project' as const,
      active: pathname.includes('/settings'),
      icon: <IconSettings />,
    },
  ].map((item) => ({
    ...item,
    to: pid === undefined ? '/' : appRailHref(item.screen, pid),
    blocked: noProject && item.screen !== 'home',
  }));

  useEffect(() => {
    document.title = pageTitle(docTitle ?? title);
  }, [title, docTitle]);

  const [busy, setBusy] = useState(false);
  const [logoutProblem, setLogoutProblem] = useState<string | null>(null);
  const doLogout = async () => {
    setBusy(true);
    setLogoutProblem(null);
    let status: number | null = null;
    try {
      await api.post<void>('/api/auth/logout');
      status = 200;
    } catch (e) {
      status = e instanceof ApiError ? (e.status === 0 ? null : e.status) : null;
    }
    setBusy(false);
    if (logoutOutcome(status) === 'done') {
      window.location.href = '/app/login';
      return;
    }
    setLogoutProblem(describeLogoutFailure(status));
  };

  return (
    <div className="app">
      <a className="skip" href={SKIP_HREF}>
        {SKIP_TEXT}
      </a>
      <nav className="rail" aria-label="주 메뉴">
        <div className="rail__brand">TF</div>
        {projectRail.length > 0 && (
          <div className="prail" role="navigation" aria-label="프로젝트 바꾸기">
            {projectRail.map((item) => (
              <Link
                key={item.projectId}
                to={item.href}
                className="prail__item"
                aria-label={railAriaLabel(item)}
                title={item.label}
                aria-current={item.current ? 'true' : undefined}
              >
                <span aria-hidden="true">{item.initial}</span>
                {item.needsReview && <span className="prail__dot" aria-hidden="true" />}
              </Link>
            ))}
          </div>
        )}
        {items.map((item) =>
          item.blocked ? (
            <span
              key={item.label}
              className="rail__item rail__item--blocked"
              role="link"
              aria-disabled="true"
              tabIndex={0}
              aria-describedby="rail-blocked-why"
              title={RAIL_BLOCKED_WHY}
            >
              {item.icon}
              {item.label}
            </span>
          ) : (
            <Link
              key={item.label}
              to={item.to}
              className="rail__item"
              aria-current={item.active ? 'page' : undefined}
            >
              {item.icon}
              {item.label}
            </Link>
          ),
        )}
        <div className="rail__spacer" />

        {/* 빠른 메뉴 런처 (채팅·일정·보고서·알림·검색 통합) */}
        <button
          type="button"
          className="rail__item"
          onClick={() => setCmdOpen(true)}
          title={`모든 메뉴 및 빠른 실행 (Ctrl+K)${unreadCount > 0 ? ` · 미확인 알림 ${unreadCount}건` : ''}`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="14" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
          </svg>
          더보기
        </button>

        <button type="button" className="rail__item rail__logout" disabled={busy} onClick={() => void doLogout()}>
          <IconLogout />
          로그아웃
        </button>
        <p id="rail-blocked-why" className="visually-hidden">
          {RAIL_BLOCKED_WHY}
        </p>
      </nav>

      <main className="main" id={MAIN_LANDMARK_ID} tabIndex={-1}>
        <Problem>{logoutProblem}</Problem>
        <header className="appbar">
          <h1 className="appbar__title">{title}</h1>
          {meta !== undefined && <span className="appbar__meta">{meta}</span>}
          <div className="appbar__spacer" />

          {/* 깔끔하게 정돈된 상단 툴바: 검색(Ctrl+K) + AI 랩 + 화상회의 + 오디오·비디오 설정 */}
          <nav className="appbar__tools tf-toolbar" aria-label="빠른 도구">
            <Link
              to="/demo"
              className="tf-lab-pill"
              title="AI 음성인식 · 성문 화자분리 기술 체험관"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                padding: '4px 10px',
                borderRadius: 'var(--r-full)',
                background: 'var(--c-surface-sunken)',
                border: '1px solid var(--c-border)',
                color: 'var(--c-ink)',
                fontSize: 'var(--fs-12)',
                fontWeight: 'var(--fw-medium)',
                textDecoration: 'none',
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
              </svg>
              <span>AI 랩</span>
            </Link>

            <button
              type="button"
              className="tf-search-pill"
              onClick={() => setCmdOpen(true)}
              title="빠른 실행 및 메뉴 검색 (Ctrl+K)"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <span className="tf-search-pill__label">검색</span>
              <kbd className="dc-kbd">Ctrl K</kbd>
            </button>

            <button
              type="button"
              className="tf-call-pill"
              onClick={() => {
                setCallMin(false);
                setCallOpen(true);
              }}
              title="화상 회의실 열기 (카메라·마이크 점검 및 입장)"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <polygon points="23 7 16 12 23 17 23 7" />
                <rect x="1" y="5" width="15" height="14" rx="2" />
              </svg>
              <span>화상회의</span>
            </button>

            <button
              type="button"
              className="tf-icon-pill"
              onClick={() => {
                setSettingsTab('voice');
                setSettingsOpen(true);
              }}
              title="설정"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span>설정</span>
            </button>

            <button
              type="button"
              className="tf-icon-pill tf-icon-pill--square"
              onClick={toggleTheme}
              aria-label={isDark ? '라이트 모드로 전환' : '다크 모드로 전환'}
              title={isDark ? '라이트 모드로 전환' : '다크 모드로 전환'}
            >
              {isDark ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <circle cx="12" cy="12" r="5" />
                  <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              )}
            </button>
          </nav>

          {actions !== undefined && <span className="appbar__divider" aria-hidden="true" />}
          {actions}
        </header>
        {children}
      </main>

      {/* 실시간 화상·화면 공유 스테이지 및 플로팅 PIP */}
      <CallStageModal
        open={callState.open}
        minimized={callState.min}
        projectId={pid ?? 1}
        onMinimize={(min) => setCallMin(min)}
        onClose={() => setCallOpen(false)}
        onOpenSettings={() => {
          setSettingsTab('voice');
          setSettingsOpen(true);
        }}
      />

      {/* 환경설정 모달 (CallStageModal 보다 뒤에 렌더링 + z-index: 250 으로 항상 최상단에 표시) */}
      <SettingsModal
        open={settingsOpen}
        initialTab={settingsTab}
        projectId={pid ?? 1}
        onClose={() => setSettingsOpen(false)}
      />

      {/* Ctrl+K 빠른 명령 팔레트 */}
      <CommandPalette
        open={cmdOpen}
        projectId={pid}
        onClose={() => setCmdOpen(false)}
        onOpenCall={() => {
          setCallMin(false);
          setCallOpen(true);
        }}
        onOpenSettings={(tab) => {
          setSettingsTab(tab);
          setSettingsOpen(true);
        }}
      />
    </div>
  );
}
