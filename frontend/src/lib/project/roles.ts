/**
 * 프로젝트 권한 3단계 — 화면이 무엇을 보여 주고 무엇을 잠글 것인가
 * (요구사항 정의서 §5 `PROJECT-003`·`PROJECT-004`).
 *
 * ## ⚠️ 여기서 막는 것은 **보안이 아닙니다**
 *
 * 진짜 문은 서버(`projects/permissions.py`)입니다. 여기서 하는 일은
 * **못 하는 버튼을 안 보여 주는 것**입니다 — 눌렀더니 403 이 뜨는 화면은
 * 사람에게 "고장 났다" 로 읽힙니다.
 *
 * 그래서 이 파일이 없어도 안전은 유지됩니다. 반대로, 이 파일만 있고
 * 서버가 안 막으면 **아무것도 안 막힌 것**입니다.
 *
 * ## ⚠️ `role_shares` 와 다른 것입니다
 *
 * `lib/contribution/roles.ts` 는 **기여도 가중치**를 다룹니다. 이름이
 * 비슷해서 헷갈리기 쉬운데, 저기는 "개발 0.7 · 기획 0.3" 이고 여기는
 * "소유자·관리자·팀원" 입니다. 한 칸에 담으면 기획 비중을 바꾼 것이
 * 권한 변경이 됩니다.
 */

import { withJosa } from '../text/josa.ts';

export type ProjectRole = 'owner' | 'admin' | 'member';

/**
 * 사람이 읽을 이름.
 *
 * ⚠️ **서버의 `vocab.PROJECT_ROLE_LABEL` 과 짝입니다.** 두 벌이지만
 * 런타임이 달라 어쩔 수 없고, `test_repo_integrity.py` 의 교차 검사가
 * 갈라지면 터집니다 (`TASK_STATUS_LABEL` 과 같은 방식).
 */
export const ROLE_LABEL: Record<string, string> = {
  owner: '소유자',
  admin: '관리자',
  member: '팀원',
};

/** ⚠️ 클수록 큽니다. 글자로 비교하면 `'admin' < 'member'` 라 뜻이 정반대입니다. */
const RANK = { owner: 3, admin: 2, member: 1 } as const;

/** 모르는 값은 제일 낮게 봅니다 — 관대하게 보면 없는 버튼이 생깁니다. */
function rank(role: string | null | undefined): number {
  if (role === 'owner' || role === 'admin' || role === 'member') return RANK[role];
  return 0;
}

export function roleLabel(role: string | null | undefined): string {
  if (role == null) return '';
  return ROLE_LABEL[role] ?? role;
}

/** 팀원·설정을 다룰 수 있는가. */
export function canManage(role: string | null | undefined): boolean {
  return rank(role) >= RANK.admin;
}

/**
 * 이 사람의 권한을 내가 바꿀 수 있는가.
 *
 * ⚠️ **자기 자신은 못 바꿉니다.** 막지 않으면 권한 3단계가 장식이 됩니다.
 * ⚠️ **같은 등급도 못 바꿉니다.** 관리자 둘이 서로를 강등할 수 있으면
 *    먼저 누른 쪽이 이기는 경주가 됩니다.
 */
export function canChangeRoleOf(
  myRole: string | null | undefined,
  targetRole: string | null | undefined,
  { isMe }: { isMe: boolean },
): boolean {
  if (isMe) return false;
  if (!canManage(myRole)) return false;
  return rank(myRole) > rank(targetRole);
}

/** 내가 이 사람에게 줄 수 있는 등급들. ⚠️ **자기 등급 이상은 못 줍니다.** */
export function assignableRoles(myRole: string | null | undefined): ProjectRole[] {
  const mine = rank(myRole);
  return (['owner', 'admin', 'member'] as ProjectRole[]).filter((r) => RANK[r] < mine);
}

/** 이 사람을 내보낼 수 있는가. 권한 변경과 같은 규칙입니다. */
export function canRemove(
  myRole: string | null | undefined,
  targetRole: string | null | undefined,
  { isMe }: { isMe: boolean },
): boolean {
  return canChangeRoleOf(myRole, targetRole, { isMe });
}

/**
 * 나가기를 막아야 하는가. 막을 이유가 없으면 `null`.
 *
 * ⚠️ **버튼을 지우지 않고 이유를 말합니다.** 없어진 버튼은 사람에게
 * "이 화면은 나갈 수가 없다" 가 아니라 "고장 났다" 로 읽힙니다.
 */
export function leaveBlockedBecause(
  myRole: string | null | undefined,
  allRoles: readonly string[],
): string | null {
  if (myRole !== 'owner') return null;
  const owners = allRoles.filter((r) => r === 'owner').length;
  if (owners > 1) return null;
  return '마지막 소유자입니다. 다른 사람에게 소유자를 넘긴 뒤에 나갈 수 있습니다.';
}

/**
 * 나가기를 누르기 전에 물을 말.
 *
 * ⚠️ **한 일이 남는다는 것을 말합니다.** 안 적으면 사람은 나가면 자기
 * 기록도 지워진다고 믿거나, 반대로 지워질까 봐 못 나갑니다. 지우는 것은
 * 개인 정보 파기라는 **다른 문**입니다.
 */
export const LEAVE_CONFIRM =
  '이 프로젝트에서 나갑니다. 지금까지 맡은 업무와 회의 기록은 팀에 그대로 남습니다.';

/**
 * 업무를 지우기 전에 물을 말 (`TASK-003`).
 *
 * ⚠️ 되돌릴 방법을 화면이 안 주므로 **되돌릴 수 없다고 먼저 말합니다.**
 *
 * ⚠️ `을(를)` 이라고 적지 않습니다 — 그건 사람이 읽는 글자가 아니고,
 * 이 저장소가 확정 화면에서 한 번 낸 결함입니다(76번). 받침을 보고
 * 고릅니다.
 */
export function deleteTaskConfirm(title: string): string {
  return `${withJosa(title, '을를')} 지웁니다. 칸반에서 사라지고 되돌릴 수 없습니다.`;
}
