import type { ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useProjects } from '../api/hooks.ts';

// 앱 셸 — 레일 72px + 헤더 56px + 판. R1: body 는 스크롤하지 않습니다.
// 레일은 넷뿐입니다 (R8): 홈 · 칸반 · 기여도 · 설정. 레거시 화면은 여기 없습니다.

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
  // 구간(range) 아이콘 — 단일 점수가 아니라 구간이라는 것을 레일에서부터 말합니다.
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M4 5 V15 M16 5 V15" strokeLinecap="round" />
      <path d="M6.5 10 H13.5" strokeLinecap="round" />
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
  /** 제목 옆 모노 보조값 (건수·시각 등). */
  meta?: ReactNode;
  /** 회의 화면처럼 URL 에 projectId 가 없을 때 레일 목적지를 알려 줍니다. */
  projectId?: number;
  children: ReactNode;
}

export function AppShell({ title, actions, meta, projectId, children }: AppShellProps) {
  const params = useParams();
  const { pathname } = useLocation();
  const { data: projects } = useProjects();
  const pid =
    projectId ??
    (params['projectId'] !== undefined ? Number(params['projectId']) : projects?.[0]?.project_id);

  const items = [
    { label: '홈', to: '/', active: pathname === '/' || pathname.startsWith('/meeting/'), icon: <IconHome /> },
    { label: '칸반', to: pid !== undefined ? `/project/${pid}/kanban` : '/', active: pathname.includes('/kanban'), icon: <IconKanban /> },
    { label: '기여도', to: pid !== undefined ? `/project/${pid}/contributions` : '/', active: pathname.includes('/contributions'), icon: <IconContrib /> },
    { label: '설정', to: pid !== undefined ? `/project/${pid}/settings/role` : '/', active: pathname.includes('/settings'), icon: <IconSettings /> },
  ];

  return (
    <div className="app">
      <nav className="rail" aria-label="주 메뉴">
        <div className="rail__brand">TF</div>
        {items.map((item) => (
          <Link
            key={item.label}
            to={item.to}
            className="rail__item"
            aria-current={item.active ? 'page' : undefined}
          >
            {item.icon}
            {item.label}
          </Link>
        ))}
        <div className="rail__spacer" />
      </nav>
      <div className="main">
        <header className="appbar">
          <h1 className="appbar__title">{title}</h1>
          {meta !== undefined && <span className="appbar__meta">{meta}</span>}
          <div className="appbar__spacer" />
          {actions}
        </header>
        {children}
      </div>
    </div>
  );
}
