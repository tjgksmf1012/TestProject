/**
 * 화면 사이의 이동.
 *
 * ## 왜 이게 로직인가
 *
 * 화면 일곱 개를 따로 만들었더니 **넷이 막다른 길**이 됐습니다 — 녹음·승인·
 * 칸반·기여도에 들어가면 브라우저 뒤로가기 말고는 나올 방법이 없었습니다.
 * 폰에서는 그게 더 나쁩니다. 주소창이 없는 PWA 로 열면 갇힙니다.
 *
 * 그런데 링크를 그냥 다 붙이면 안 됩니다. 화면마다 필요한 id 가 다르고,
 * **id 가 없는데 링크를 만들면 눌렀을 때 엉뚱한 프로젝트(기본값 1)로
 * 갑니다.** 없는 링크를 안 만드는 것이 여기서 하는 판단입니다.
 *
 *     home          아무 id 도 필요 없다
 *     lobby/review  meeting 이 필요하다
 *     kanban        project 가 필요하다 (meeting 은 선택 — 어느 회의에서 왔는지)
 *     contributions project 가 필요하다
 *     project(설정) project 가 필요하다
 *     index(녹음)   meeting 이 있으면 서버 트랙, 없으면 로컬 실험
 */

import type { IconName } from './icons.ts';

export type ScreenId =
  | 'home'
  | 'lobby'
  | 'chat'
  | 'calendar'
  | 'notifications'
  | 'activity'
  | 'search'
  | 'record'
  | 'review'
  | 'kanban'
  | 'contributions'
  | 'reports'
  | 'project';

export interface NavContext {
  /** 지금 보고 있는 화면 */
  current: ScreenId;
  projectId?: number | null;
  meetingId?: number | null;
}

export interface NavLink {
  screen: ScreenId;
  label: string;
  href: string;
}

const LABEL: Record<ScreenId, string> = {
  home: '홈',
  lobby: '회의 로비',
  chat: '채팅',
  calendar: '일정',
  notifications: '알림',
  activity: '활동 기록',
  search: '찾기',
  record: '녹음',
  review: '업무 후보 검토',
  kanban: '칸반',
  contributions: '기여도',
  reports: '보고서',
  project: '설정',
};

/**
 * 화면 이름.
 *
 * ⚠️ **테스트만 부릅니다.** 그래도 남깁니다 — `links.test.ts` 가
 * "`navLinks` 와 `tabsFor` 의 라벨이 같은 표에서 나온다" 를 이걸로
 * 확인합니다. 지우면 두 곳이 서로 다른 글자를 쓰기 시작해도 아무도
 * 모릅니다. 근거는 `guards.test.ts` 의 면제 목록에 적어 뒀습니다.
 */
export function labelOf(screen: ScreenId): string {
  return LABEL[screen];
}

/**
 * SPA 주소 → 지금 있는 화면.
 *
 * ## 왜 화면 코드에 안 두는가
 *
 * "지금 어느 화면인가" 는 **판단**입니다. 프로젝트 레일이 어디로 보낼지,
 * 어느 칸에 지금 표시를 붙일지가 여기서 갈립니다. 화면 코드(`webapp/src`)
 * 에는 자동 테스트가 없으므로 거기 적으면 검증 밖으로 나갑니다.
 *
 * ⚠️ **basename(`/app`) 이 붙기 전의 주소**를 받습니다. React Router 의
 *    `useLocation().pathname` 이 그렇습니다 — `/app/project/7/kanban` 이
 *    아니라 `/project/7/kanban` 입니다. 앞에 `/app` 이 붙어 오면 그때도
 *    맞게 읽도록 한 번 벗겨 냅니다(주소창을 그대로 넘기는 실수가
 *    조용히 `home` 으로 떨어지지 않게).
 */
export function appScreenOf(pathname: string): ScreenId {
  const path = (pathname || '/').replace(/^\/app(?=\/|$)/, '') || '/';
  if (/^\/project\/\d+\/kanban/.test(path)) return 'kanban';
  if (/^\/project\/\d+\/contributions/.test(path)) return 'contributions';
  if (/^\/project\/\d+\/settings/.test(path)) return 'project';
  if (/^\/meeting\/\d+\/lobby/.test(path)) return 'lobby';
  if (/^\/meeting\/\d+\/review/.test(path)) return 'review';
  return 'home';
}

function positive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 이 맥락에서 갈 수 있는 곳.
 *
 * **지금 화면은 빼고** 줍니다 — 자기 자신으로 가는 링크는 새로고침일 뿐인데
 * 사용자는 뭔가 일어날 거라고 기대합니다.
 *
 * 홈은 항상 있습니다. 어떤 id 도 필요 없고, **어디서든 빠져나올 곳이 하나는
 * 있어야** 하기 때문입니다.
 */
/**
 * ⚠️ **부르는 뿌리가 하나입니다 — 그리고 그건 결정입니다** (2026-08-24).
 *
 * `demo/nav.ts` 만 이 함수를 부릅니다. SPA(`webapp/src`)의 셸은 탭 넷
 * (홈·칸반·기여도·설정)과 프로젝트 레일뿐이라, 여기서 만드는 여섯
 * (채팅·일정·알림·활동 기록·찾기·보고서)으로 가는 문이 `/app` 안에
 * **없습니다.** `/app/` 에서 `<a href>` 를 따라 걸으면 주소 스물여섯에
 * 닿는데 그 여섯은 하나도 없습니다 — 재서 확인했습니다.
 *
 * ⛔ **「한쪽 뿌리만」으로 보고 조용히 SPA 에 배선하지 마십시오.**
 * `docs/22` §R8 이 「레거시 6화면은 라우트만 유지 · 내비에 새로 노출하지
 * 않았습니다」라고 못 박은 자리입니다. 반대로 **결함 305** 는 「화면을
 * 만들었으면 걸어서 닿는지 보라」를 못 박았고 그때 고친 것이 바로 이
 * 여섯입니다(레거시 쪽).
 *
 * 두 기록이 같은 곳을 반대로 가리키므로 **여기서 고르지 않습니다.**
 * 세 자리가 서로를 가리킵니다 — 이 주석 · `docs/22` §R8 ·
 * `docs/24` 의 `/app` 크롤 측정치. 결정하려면 **`/app` 이 기본 문이
 * 되는 시점**을 먼저 정해야 합니다(지금 로그인은 `/home.html` 로 갑니다).
 *
 * ⚠️ 다만 SPA 는 그 여섯으로 **가라고 말하지도 않습니다** — 화면 열다섯을
 * 훑어 확인했습니다. 그래서 실패 ③(가라고 해 놓고 자리가 없음)은
 * 아닙니다. 안내를 하나라도 넣는 순간 그때는 결함입니다.
 */
export function navLinks(context: NavContext): NavLink[] {
  const project = positive(context.projectId);
  const meeting = positive(context.meetingId);
  const links: NavLink[] = [{ screen: 'home', label: LABEL.home, href: '/home.html' }];

  if (meeting !== null) {
    links.push({
      screen: 'lobby',
      label: LABEL.lobby,
      href: `/lobby.html?meeting=${meeting}`,
    });
    links.push({
      screen: 'review',
      label: LABEL.review,
      href: `/review.html?meeting=${meeting}`,
    });
  }

  if (project !== null) {
    // 칸반은 프로젝트 단위지만, 어느 회의에서 왔는지 알면 들고 갑니다 —
    // 그래야 칸반에서 다시 그 회의로 돌아올 수 있습니다.
    const suffix = meeting !== null ? `&meeting=${meeting}` : '';
    links.push({
      screen: 'kanban',
      label: LABEL.kanban,
      href: `/kanban.html?project=${project}${suffix}`,
    });
    links.push({
      screen: 'contributions',
      label: LABEL.contributions,
      href: `/contributions.html?project=${project}${suffix}`,
    });
    // ⚠️ **탭이 아니라 여기입니다.** 탭은 넷 그대로 둡니다 — 사람은
    // 자리를 기억해서 누르므로, 다섯째가 끼면 그때까지 넷째였던 것을
    // 누르려던 손이 엉뚱한 화면으로 갑니다. 보고서는 자주 가는 곳이
    // 아니라 **다 끝나고 한 번 가는 곳**이라 이 줄이 맞는 자리입니다.
    // ⚠️ **탭이 아니라 여기입니다.** 탭 넷은 그대로 둡니다 — 이유는
    // 바로 아래 보고서 링크에 적어 뒀습니다. 채팅은 셸의 채널 목록에서도
    // 갈 수 있으므로, 이 줄은 채널이 아직 하나도 없는 사람을 위한 문입니다.
    links.push({
      screen: 'chat',
      label: LABEL.chat,
      href: `/chat.html?project=${project}`,
    });
    links.push({
      screen: 'calendar',
      label: LABEL.calendar,
      href: `/calendar.html?project=${project}`,
    });
    links.push({
      screen: 'notifications',
      label: LABEL.notifications,
      href: `/notifications.html?project=${project}`,
    });
    links.push({
      screen: 'activity',
      label: LABEL.activity,
      href: `/activity.html?project=${project}`,
    });
    links.push({
      screen: 'search',
      label: LABEL.search,
      href: `/search.html?project=${project}`,
    });
    links.push({
      screen: 'reports',
      label: LABEL.reports,
      href: `/reports.html?project=${project}`,
    });
    // 회의를 여는 곳이 여기뿐입니다. 이 링크가 없으면 프로젝트를 만들어
    // 놓고도 다음 단계로 갈 방법이 없습니다.
    links.push({
      screen: 'project',
      label: LABEL.project,
      href: `/project.html?project=${project}`,
    });
  }

  return links.filter((link) => link.screen !== context.current);
}

/**
 * 셸이 **지금 열어 두고 있는 문**.
 *
 * `missingLinks` 는 「지금 못 가는 곳」을 말하는 자리인데, 셸이 같은
 * 화면에서 그 곳으로 가는 문을 이미 그리고 있으면 그 말은 **거짓**이
 * 됩니다. 그래서 이 사실을 받아서 판단합니다 (결함 343).
 */
export interface ShellDoors {
  /**
   * 셸의 **회의 목록**이 지금 그려지고 있는가.
   *
   * ⚠️ 「회의가 있는가」가 아닙니다. 목록이 비어 있어도 그 자리는
   * 「아직 연 회의가 없습니다 — 설정에서 엽니다」라고 **더 정확한 말**을
   * 합니다 — 그 옆에서 「회의를 지정하지 않아」라고 다시 말하면 한 화면이
   * 같은 사실에 이유를 둘 답니다 (결함 290).
   */
  meetingListShown: boolean;
}

/**
 * 이 화면에서 아직 못 가는 곳과 **무엇을 해야 열리는가**.
 *
 * 링크를 조용히 빼기만 하면 사용자는 **그 화면이 없는 줄** 압니다.
 * 무엇을 고르면 열리는지 말해 주는 편이 낫습니다.
 *
 * ## ⚠️ 「갈 수 없습니다」라고 적지 않습니다 (결함 343)
 *
 * 예전 문구는 「회의를 지정하지 않아 로비·검토 화면으로 **갈 수
 * 없습니다**」였습니다. 그런데 셸의 왼쪽 회의 목록은 같은 화면에서
 * `/lobby.html?meeting=N` **여섯 개**를 그리고 있었습니다 — 화면이
 * 「갈 수 없다」고 적은 자리 200px 옆에 그 문이 여섯 개 있었습니다.
 *
 * 두 가지를 고쳤습니다:
 *
 * 1. **문이 이미 보이면 아무 말도 하지 않습니다** (`meetingListShown`).
 * 2. 말할 때도 막다른 길이 아니라 **조건과 문**을 말합니다. 「홈」은
 *    아래 탭바에 늘 있고 회의·프로젝트를 **모두** 늘어놓으므로, 창이
 *    좁아 회의 목록이 접힌 때에도 참인 답입니다 (390px 에서 확인).
 *
 * ⚠️ **프로젝트를 모르면 회의 이야기는 하지 않습니다.** 회의는 프로젝트
 * 안에 있어서 순서가 있고, 두 줄을 같이 내면 「무엇부터」가 사라집니다.
 */
export function missingLinks(context: NavContext, doors: ShellDoors): string[] {
  if (context.current === 'home') return [];

  if (positive(context.projectId) === null) {
    return ['칸반·기여도·보고서·설정은 프로젝트를 고르면 열립니다 — 홈에서 고르세요'];
  }
  if (positive(context.meetingId) === null && !doors.meetingListShown) {
    return ['로비·검토는 회의를 고르면 열립니다 — 홈에서 고르세요'];
  }
  return [];
}

/**
 * 주소에서 맥락을 읽는다.
 *
 * `0`·음수·`NaN` 을 걸러 내는 게 핵심입니다. `Number(null)` 은 0 이고
 * `Number('abc')` 는 NaN 인데, 둘 다 그대로 링크에 넣으면
 * `?project=0` · `?project=NaN` 같은 주소가 만들어집니다 — 서버는 404 를
 * 주고 사용자는 화면이 고장 났다고 읽습니다.
 */
/**
 * 아래 탭바에 늘 보이는 자리들.
 *
 * ## 왜 `navLinks` 와 따로인가
 *
 * `navLinks` 는 **갈 수 있는 곳만** 줍니다. 그건 위쪽 링크 줄에는 맞지만
 * 탭바에는 맞지 않습니다 — 탭이 상황에 따라 사라지면 같은 자리에 다른
 * 것이 오고, 사람은 **자리를 기억해서** 누르므로 엉뚱한 화면으로 갑니다.
 *
 * 그래서 탭은 **항상 같은 순서로 넷**입니다. 못 가는 것은 흐리게 두고
 * 왜 못 가는지 이유를 함께 줍니다. 숨기면 그 화면이 없는 줄 압니다.
 *
 * 회의 화면(로비·검토·녹음)은 탭이 아닙니다. 그건 "지금 이 회의" 안에서만
 * 뜻이 있는 화면이라, 늘 보이는 자리에 두면 **어느 회의인지 모르는 채로**
 * 눌리게 됩니다.
 */
export interface NavTab {
  screen: ScreenId;
  label: string;
  /** 탭바에 그릴 그림의 **이름**. 마크업은 `icons.ts` 가 만듭니다. */
  icon: IconName;
  href: string;
  current: boolean;
  /** 지금 갈 수 있는가. 못 가면 흐리게 그린다. */
  enabled: boolean;
  /** 못 가는 이유. 없으면 갈 수 있다는 뜻. */
  blockedReason: string | null;
}

/**
 * ⚠️ 예전에는 `🏠📋📊⚙️` 였습니다. 이모지는 **기기마다 다른 그림**이고
 * 색이 박혀 있어 어두운 모드에서 안 맞습니다 (지시서 §4.6).
 * 지금은 `icons.ts` 가 직접 그린 path 를 줍니다.
 */
const TAB_ICON: Record<string, IconName> = {
  home: 'home',
  kanban: 'board',
  // ⭐ 이 제품의 시그니처가 아이콘이 된 것 — 시간축 위의 평행 트랙.
  contributions: 'track',
  project: 'sliders',
};

/** 탭 순서. **바꾸지 마세요** — 사람은 자리를 기억해서 누릅니다. */
const TAB_ORDER: ScreenId[] = ['home', 'kanban', 'contributions', 'project'];

export function navTabs(context: NavContext): NavTab[] {
  const project = positive(context.projectId);
  const meeting = positive(context.meetingId);
  const suffix = meeting !== null ? `&meeting=${meeting}` : '';

  return TAB_ORDER.map((screen) => {
    const needsProject = screen !== 'home';
    const enabled = !needsProject || project !== null;

    let href = '/home.html';
    if (screen === 'kanban') href = `/kanban.html?project=${project}${suffix}`;
    if (screen === 'contributions') {
      href = `/contributions.html?project=${project}${suffix}`;
    }
    if (screen === 'project') href = `/project.html?project=${project}`;

    return {
      screen,
      label: LABEL[screen],
      icon: TAB_ICON[screen] ?? 'sliders',
      // 못 가는 탭에 주소를 주면 눌렸을 때 `?project=null` 로 간다.
      href: enabled ? href : '',
      current: context.current === screen,
      enabled,
      blockedReason: enabled
        ? null
        : '프로젝트를 고르면 열립니다 — 홈에서 프로젝트를 누르세요',
    };
  });
}

export function contextFromSearch(current: ScreenId, search: string): NavContext {
  const params = new URLSearchParams(search);
  const read = (key: string): number | null => {
    const raw = params.get(key);
    if (raw === null) return null;
    return positive(Number(raw));
  };
  return { current, projectId: read('project'), meetingId: read('meeting') };
}
