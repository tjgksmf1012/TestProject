/**
 * 프로젝트 레일 — 셸의 **맨 왼쪽 72px**.
 *
 * ## ⚠️ 이 자리는 한 번 지웠던 자리입니다
 *
 * 셸 1단계에서 `--shell-rail` 만큼 왼쪽을 비워 뒀다가 **아무것도 없는
 * 72px** 이 되어 통째로 걷어냈습니다(docs/19 §11). 그때 적어 둔 말이
 * 이것입니다 — *"없는 것을 위해 자리를 비워 두면 그건 빈칸이 아니라
 * 결함입니다. 생길 때 더합니다."*
 *
 * 그래서 이 파일은 **자리를 되찾는 조건**부터 정합니다.
 *
 * ## 프로젝트가 하나면 레일이 없습니다
 *
 * 하나뿐이면 **갈 곳이 없습니다.** 누를 것이 자기 자신 하나인 72px 짜리
 * 열은 그때 걷어낸 빈칸과 같은 것이고, 지금 어느 프로젝트인지는 채널
 * 목록 머리말이 이미 말합니다(§13).
 *
 * 둘 이상이면 이야기가 달라집니다 — **다른 프로젝트에 내가 볼 게 있는지**
 * 알 방법이 지금 홈에 가는 것뿐입니다.
 *
 * ## ⚠️ 순서를 `orderProjects` 와 **일부러 다르게** 합니다
 *
 * 홈은 `orderProjects` 로 **할 일 있는 것을 위로** 올립니다. 그건 "무엇을
 * 먼저 볼까" 에 답하는 화면이라 맞습니다.
 *
 * 레일은 다른 질문에 답합니다 — **"어디를 눌러야 하나."** 여기서 순서가
 * 흔들리면 검토거리 하나가 생겼다는 이유로 어제 누르던 자리에 다른
 * 프로젝트가 옵니다. `links.ts` 가 탭 순서를 고정하며 적어 둔 그 이유가
 * 그대로 적용됩니다 — **사람은 자리를 기억해서 누릅니다.**
 *
 * 그래서 자리는 `project_id` 로 고정하고, 할 일이 있다는 사실은
 * **자리가 아니라 점**으로 말합니다.
 */

import type { ScreenId } from './links.ts';

export interface RailProject {
  project_id: number;
  title: string;
  needs_review: number;
}

export interface RailItem {
  projectId: number;
  /** 네모 안에 넣을 한 글자 */
  initial: string;
  /** 툴팁·낭독기에 쓸 전체 이름 */
  label: string;
  href: string;
  current: boolean;
  /** 검토할 회의가 있는가. **개수가 아니라 있다/없다** 입니다 */
  needsReview: boolean;
}

/**
 * 프로젝트를 바꿔도 **같은 화면에 머무를 수 있는가.**
 *
 * 로비·검토·녹음은 회의 화면이고, 회의는 프로젝트에 딸려 있습니다.
 * 다른 프로젝트로 그 화면을 열 수는 없으므로 그 프로젝트의 칸반으로
 * 보냅니다 — 디스코드에서 서버를 바꾸면 그 서버의 첫 채널로 가는 것과
 * 같습니다.
 *
 * ⚠️ 홈으로 보내지 않습니다. 홈은 **모든 프로젝트**를 보여 주는 화면이라,
 * 프로젝트를 고른 직후에 가면 방금 고른 것이 어디로 갔는지 알 수 없습니다.
 */
const STAYS: ReadonlySet<string> = new Set<ScreenId>(['kanban', 'contributions', 'project']);

export function railHref(screen: ScreenId, projectId: number): string {
  const target = STAYS.has(screen) ? screen : 'kanban';
  return `/${target}.html?project=${projectId}`;
}

/**
 * 네모 안에 넣을 한 글자.
 *
 * ⚠️ `title[0]` 이 아니라 `Array.from` 입니다. 이모지나 일부 문자는
 * **두 칸(surrogate pair)** 이라, 첫 글자만 잘라 내면 깨진 반쪽이
 * 나옵니다 — 화면에 `` 가 뜹니다.
 *
 * ⚠️ 이름이 비어 있으면 `?` 입니다. 빈 네모를 그리면 누를 수는 있는데
 * 무엇인지 알 수 없는 칸이 됩니다.
 */
export function railInitial(title: string): string {
  const trimmed = (title ?? '').trim();
  return Array.from(trimmed)[0] ?? '?';
}

/**
 * 레일을 세울 것인가.
 *
 * ⚠️ **하나뿐이면 세우지 않습니다.** 갈 곳이 없는 열은 빈칸입니다.
 */
export function railIsWorthIt(projects: readonly RailProject[]): boolean {
  return projects.length >= 2;
}

/**
 * 프로젝트 목록 → 레일 항목.
 *
 * ⚠️ **`project_id` 순으로 고정합니다.** 검토거리가 생겼다고 자리가
 * 바뀌면 사람이 어제 누르던 자리를 못 찾습니다.
 */
export function railItems(
  projects: readonly RailProject[],
  screen: ScreenId,
  currentProjectId?: number | null,
): RailItem[] {
  return [...projects]
    .sort((a, b) => a.project_id - b.project_id)
    .map((project) => ({
      projectId: project.project_id,
      initial: railInitial(project.title),
      label: project.title,
      href: railHref(screen, project.project_id),
      current: currentProjectId != null && currentProjectId === project.project_id,
      needsReview: project.needs_review > 0,
    }));
}

/**
 * 레일 항목 하나를 낭독기에 뭐라고 읽어 줄 것인가.
 *
 * ⚠️ 네모 안에는 **한 글자**뿐입니다. 그것만 읽으면 낭독기 사용자는
 * "팀", "졸" 같은 소리만 듣습니다.
 */
export function railAriaLabel(item: RailItem): string {
  const parts = [item.label];
  if (item.needsReview) parts.push('검토할 회의가 있습니다');
  if (item.current) parts.push('지금 보는 프로젝트');
  return parts.join(', ');
}
