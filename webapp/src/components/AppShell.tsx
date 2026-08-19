import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useProjects } from '../api/hooks.ts';
import { pageTitle } from '@lib/shell/title.ts';
import { appScreenOf } from '@lib/nav/links.ts';
import { appRailHref, railAriaLabel, railIsWorthIt, railItems } from '@lib/nav/rail.ts';

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

  // ⭐ **프로젝트가 둘 이상이면 바꿀 자리를 준다.**
  //
  // 이게 없던 동안: 프로젝트를 만들거나 초대 코드로 참가하면 서버는 둘 다
  // 알고 있는데 화면의 링크는 전부 하나만 가리켰고, 나머지로 갈 길이
  // **하나도 없었습니다.** 주소를 손으로 쳐야 했는데 사람은 그 id 를
  // 모릅니다. 옛 화면(`/home.html`)에는 있던 것이 리디자인에서 빠진
  // 자리입니다 — 판단(`lib/nav/rail.ts`)은 그대로 있었고 부르는 곳만
  // 없었습니다(이 저장소가 반복해서 당한 실패 ①).
  //
  // ⚠️ 하나뿐이면 **안 그립니다.** 누를 것이 자기 자신뿐인 칸은 빈칸이고,
  //    셸 1단계에서 그 이유로 레일을 통째로 걷어낸 적이 있습니다.
  const projectRail = railIsWorthIt(projects ?? [])
    ? railItems(projects ?? [], appScreenOf(pathname), pid ?? null, appRailHref)
    : [];

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
        {projectRail.length > 0 && (
          /* ⚠️ 자리는 `project_id` 로 고정입니다(`railItems`). 검토거리가
             하나 생겼다고 자리가 바뀌면 어제 누르던 곳에 다른 팀이 옵니다.
             할 일이 있다는 사실은 **자리가 아니라 점**으로 말합니다. */
          <div className="prail" role="navigation" aria-label="프로젝트 바꾸기">
            {projectRail.map((item) => (
              <Link
                key={item.projectId}
                to={item.href}
                className="prail__item"
                aria-label={railAriaLabel(item)}
                aria-current={item.current ? 'true' : undefined}
              >
                {/* 네모 안은 한 글자뿐이라 낭독기에는 `aria-label` 이
                    전체 이름을 읽어 줍니다. */}
                <span aria-hidden="true">{item.initial}</span>
                {item.needsReview && <span className="prail__dot" aria-hidden="true" />}
              </Link>
            ))}
          </div>
        )}
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
