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
 * **관리자만 되는 일**을 눌러도 되는가 — 안 되면 그 이유.
 *
 * ⚠️ `canManage` 는 처음부터 있었는데 **리디자인 SPA 에서 아무도 안
 * 불렀습니다** (결함 225). 그래서 평범한 구성원에게도 「프로젝트 이름
 * 저장」·「코드 새로 만들기」·「저장소 연결」 버튼이 멀쩡히 눌리는 상태로
 * 떠 있었고, 누르면 서버가 403 을 주는데 **화면은 아무 말도 안 했습니다.**
 * 사람은 자기가 뭘 잘못 눌렀는지, 됐는지 안 됐는지도 모릅니다.
 *
 * ⚠️ **버튼을 지우지 않습니다.** 이 저장소의 「아직 안 됨」 은 `aria-disabled`
 * + 사유이고, 버튼이 사라지면 "원래 없는 기능" 으로 읽힙니다 — 관리자에게
 * 부탁하면 되는 일인데요.
 *
 * @param what 무엇을 하려는 것인지. 문장에 그대로 들어갑니다.
 */
export function manageBlockedBecause(
  myRole: string | null | undefined,
  what: string,
): string | null {
  if (canManage(myRole)) return null;
  /* ⛔ **모르는 것을 「없다」고 단언하지 않습니다** (결함 254).

     `undefined` 는 「아직 모름」입니다 — 명단이 아직 안 온 몇 초. 그
     동안 이 함수는 **소유자에게** 「팀의 관리자에게 요청하세요」라고
     말했습니다. 재현했습니다: `/members` 를 4초 늦추고 설정 화면을
     여니 그 문장이 떠 있었고, 명단이 오자 사라졌습니다.

     불변식 ③ 과 같은 자리입니다 — **못 잰 것은 0이 아닙니다.** 잠그는
     것은 그대로 둡니다(모르면 잠급니다. 관대하게 보면 없는 버튼이
     생깁니다). 바뀌는 것은 **말**뿐입니다. */
  if (myRole === undefined) {
    return '권한을 아직 확인하지 못했습니다 — 명단을 불러오는 중입니다.';
  }
  // ⚠️ 조사는 앞말 받침을 보고 고릅니다 — 「코드 새로 만들기은」 이 되면
  //    안 됩니다. 이 저장소가 확정 화면에서 이미 한 번 낸 결함(76번)입니다.
  return `${withJosa(what, '은는')} 관리자와 소유자만 할 수 있습니다. 팀의 관리자에게 요청하세요.`;
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
