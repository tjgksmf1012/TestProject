import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useProjects } from '../api/hooks.ts';
import { pageTitle } from '@lib/shell/title.ts';

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
  /**
   * 창 제목에만 쓸 이름. 안 주면 `title` 을 씁니다.
   *
   * ⚠️ 설정 화면은 머리줄에 **프로젝트 이름**을 답니다(그 화면에 온 사람은
   * 어느 프로젝트를 만지는지부터 알아야 합니다). 그런데 홈도 같은 이름을
   * 달기 때문에, 창 제목을 `title` 로 만들면 **두 화면의 제목이 똑같아집니다**
   * — 낭독기 사용자에게는 화면이 안 바뀐 것과 같습니다 (WCAG 2.4.2).
   */
  docTitle?: string;
  /** 제목 옆 모노 보조값 (건수·시각 등). */
  meta?: ReactNode;
  /** 회의 화면처럼 URL 에 projectId 가 없을 때 레일 목적지를 알려 줍니다. */
  projectId?: number;
  children: ReactNode;
}

export function AppShell({ title, docTitle, actions, meta, projectId, children }: AppShellProps) {
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

  // ⚠️ SPA 는 페이지가 새로 뜨지 않으므로 **제목을 우리가 갈아 끼워야**
  //    합니다. 안 하면 아홉 화면이 전부 `TeamFlow` 하나고, 낭독기는 화면이
  //    바뀐 것을 알릴 방법을 잃습니다 (WCAG 2.4.2 · 결함 187).
  useEffect(() => {
    document.title = pageTitle(docTitle ?? title);
  }, [title, docTitle]);

  return (
    <div className="app">
      {/* 키보드로 오는 사람은 화면마다 왼쪽 메뉴 다섯 칸을 지나야 본문에
          닿습니다 (WCAG 2.4.1, 수준 A). 평소에는 안 보이고 탭으로 초점이
          오면 나타납니다 — **`display: none` 으로 감추면 초점도 못 받아
          아무 일도 안 합니다.** */}
      <a className="skip" href="#main-content">
        본문으로 건너뛰기
      </a>
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
      {/* ⚠️ `<div>` 였습니다. 랜드마크가 없으면 낭독기 사용자가 "본문으로"
          라는 이동 수단을 잃습니다 — 건너뛰기 링크가 닿을 자리이기도 합니다.
          `tabIndex={-1}` 은 링크로 왔을 때 **초점이 실제로 여기 앉게** 하려는
          것입니다. 없으면 스크롤만 되고 초점은 링크에 남습니다. */}
      <main className="main" id="main-content" tabIndex={-1}>
        <header className="appbar">
          <h1 className="appbar__title">{title}</h1>
          {meta !== undefined && <span className="appbar__meta">{meta}</span>}
          <div className="appbar__spacer" />
          {actions}
        </header>
        {children}
      </main>
    </div>
  );
}
