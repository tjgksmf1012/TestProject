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
  | 'record'
  | 'review'
  | 'kanban'
  | 'contributions'
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
  record: '녹음',
  review: '업무 후보 검토',
  kanban: '칸반',
  contributions: '기여도',
  project: '설정',
};

export function labelOf(screen: ScreenId): string {
  return LABEL[screen];
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
 * 이 화면에서 못 가는 곳과 그 이유.
 *
 * 링크를 조용히 빼기만 하면 사용자는 **그 화면이 없는 줄** 압니다.
 * 왜 지금 갈 수 없는지 말해 주는 편이 낫습니다 — 대개 주소에 id 가 빠진
 * 것이고, 그건 고칠 수 있는 문제입니다.
 */
export function missingLinks(context: NavContext): string[] {
  const notes: string[] = [];
  if (positive(context.meetingId) === null && context.current !== 'home') {
    notes.push('회의를 지정하지 않아 로비·검토 화면으로 갈 수 없습니다');
  }
  if (positive(context.projectId) === null && context.current !== 'home') {
    notes.push('프로젝트를 지정하지 않아 칸반·기여도·설정 화면으로 갈 수 없습니다');
  }
  return notes;
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
