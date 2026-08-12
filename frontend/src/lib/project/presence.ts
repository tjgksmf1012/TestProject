/**
 * 지금 붙어 있는가 (요구사항 정의서 §4 `USER-005`).
 *
 * ## ⚠️ 이건 근태 표시가 **아닙니다**
 *
 * 사람 이름 옆에 붙는 표시라 오해되기 제일 쉬운 자리입니다. 셋을 지킵니다.
 *
 * 1. **과거를 안 말합니다.** 서버가 시각을 안 보내므로 화면은 `마지막
 *    접속 3일 전` 을 그릴 수가 없습니다 — 그릴 재료가 없는 것이 제일
 *    확실한 방법입니다
 * 2. **오프라인을 빨갛게 칠하지 않습니다.** 이 저장소에서 빨강은 "네가
 *    뭘 잘못했다" 이고, 자리에 없는 것은 잘못이 아닙니다
 * 3. **색으로만 말하지 않습니다.** 점만 찍으면 색을 못 보는 사람에게는
 *    아무 표시도 없는 것입니다. 글자를 같이 답니다
 */

/**
 * 사람이 읽을 이름.
 *
 * ⚠️ **서버의 `vocab.PRESENCE_LABEL` 과 짝입니다.** 두 벌이지만 런타임이
 * 달라 어쩔 수 없고, `test_repo_integrity.py` 의 교차 검사가 갈라지면
 * 터집니다.
 */
export const PRESENCE_LABEL: Record<string, string> = {
  online: '접속 중',
  away: '자리 비움',
  offline: '오프라인',
  in_meeting: '회의 중',
};

/** 모르는 값은 **지어내지 않습니다.** 빈 문자열이면 화면이 아무것도 안 그립니다. */
export function presenceLabel(status: string | null | undefined): string {
  if (status == null) return '';
  return PRESENCE_LABEL[status] ?? '';
}

/**
 * 점에 붙일 클래스.
 *
 * ⚠️ 오프라인은 **아무 클래스도 안 줍니다** — 기본이 흐린 테두리뿐인
 * 빈 점이고, 그게 "지금 없다" 를 조용히 말하는 방법입니다.
 */
export function presenceDot(status: string | null | undefined): string {
  if (status === 'online' || status === 'in_meeting') return 'here';
  if (status === 'away') return 'away';
  return '';
}

/**
 * 화면에 보여 줄 만한 상태인가.
 *
 * ⚠️ **오프라인은 안 그립니다.** 팀 대부분이 오프라인인 것이 보통이고,
 * 그걸 다 표시하면 목록이 회색 점으로 덮여 정작 지금 있는 사람이 안
 * 보입니다. 그리고 "누가 없는지" 를 한눈에 세게 만드는 것 자체가 이
 * 화면이 하면 안 되는 일입니다.
 */
export function worthShowing(status: string | null | undefined): boolean {
  return status === 'online' || status === 'away' || status === 'in_meeting';
}
