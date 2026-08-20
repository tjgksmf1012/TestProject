import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useProjects } from '../api/hooks.ts';
import { pageTitle } from '@lib/shell/title.ts';
import { appScreenOf } from '@lib/nav/links.ts';
import { appRailHref, railAriaLabel, railIsWorthIt, railItems } from '@lib/nav/rail.ts';
import { describeLogoutFailure, logoutOutcome } from '@lib/auth/session.ts';
import { api, ApiError } from '../api/client.ts';
import { Problem } from './Problem.tsx';

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

  // ⚠️ **프로젝트가 없으면 이 셋은 갈 곳이 없습니다.** 예전에는 그때도
  //    `/` 로 링크를 걸어 뒀는데, 갓 가입한 사람이 「칸반」을 누르면
  //    같은 화면에 그대로 있었습니다 — 눌리는데 아무 일도 안 일어나는
  //    것은 이 저장소가 결함으로 세는 모양입니다(빈 `<a>` · 갈 곳 없는
  //    버튼). 링크를 지우지 않고 **이유를 답니다.**
  const noProject = pid === undefined;
  const items = [
    { label: '홈', to: '/', active: pathname === '/' || pathname.startsWith('/meeting/'), icon: <IconHome />, blocked: false },
    { label: '칸반', to: noProject ? '/' : `/project/${pid}/kanban`, active: pathname.includes('/kanban'), icon: <IconKanban />, blocked: noProject },
    { label: '기여도', to: noProject ? '/' : `/project/${pid}/contributions`, active: pathname.includes('/contributions'), icon: <IconContrib />, blocked: noProject },
    { label: '설정', to: noProject ? '/' : `/project/${pid}/settings/role`, active: pathname.includes('/settings'), icon: <IconSettings />, blocked: noProject },
  ];

  // ⚠️ SPA 는 페이지가 새로 뜨지 않으므로 **제목을 우리가 갈아 끼워야**
  //    합니다. 안 하면 아홉 화면이 전부 `TeamFlow` 하나고, 낭독기는 화면이
  //    바뀐 것을 알릴 방법을 잃습니다 (WCAG 2.4.2 · 결함 187).
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
      // ⚠️ 네트워크가 끊기면 `ApiError(0)` 입니다 — 판단은 `null` 로 받습니다.
      status = e instanceof ApiError ? (e.status === 0 ? null : e.status) : null;
    }
    setBusy(false);
    if (logoutOutcome(status) === 'done') {
      // ⚠️ 라우터가 아니라 주소를 갈아 끼웁니다 — 캐시에 남은 남의 데이터가
      //    다음 사람 화면에 잠깐 비치지 않게 합니다.
      window.location.href = '/app/login';
      return;
    }
    setLogoutProblem(describeLogoutFailure(status));
  };

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
        {items.map((item) =>
          item.blocked ? (
            <span
              key={item.label}
              className="rail__item rail__item--blocked"
              role="link"
              aria-disabled="true"
              title="프로젝트를 만들거나 초대 코드로 참가하면 열립니다"
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
        {/* ⭐ **로그아웃이 `/app` 어디에도 없었습니다.** 한 번 들어오면
            나갈 길도, 다른 계정으로 바꿀 길도 없었습니다. 레거시에는
            `demo/logout.ts` 가 있었고 판단(`logoutOutcome` ·
            `describeLogoutFailure`)도 `@lib` 에 있었는데 SPA 만 안
            불렀습니다 — 결함 197 과 같은 모양입니다.

            ⚠️ **상태를 보고 나서 옮깁니다.** 실패해도 로그인 화면으로
            보내면 세션이 살아 있는데 나간 줄 압니다(결함 82). */}
        <button type="button" className="rail__item" disabled={busy} onClick={() => void doLogout()}>
          <IconLogout />
          로그아웃
        </button>
      </nav>
      {/* ⚠️ `<div>` 였습니다. 랜드마크가 없으면 낭독기 사용자가 "본문으로"
          라는 이동 수단을 잃습니다 — 건너뛰기 링크가 닿을 자리이기도 합니다.
          `tabIndex={-1}` 은 링크로 왔을 때 **초점이 실제로 여기 앉게** 하려는
          것입니다. 없으면 스크롤만 되고 초점은 링크에 남습니다. */}
      <main className="main" id="main-content" tabIndex={-1}>
        {/* 로그아웃이 실패하면 **레일이 아니라 본문 위**에 말합니다 —
            72px 열에는 문장이 세로로 쪼개집니다. */}
        <Problem>{logoutProblem}</Problem>
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
