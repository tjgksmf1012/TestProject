/**
 * 업무 우선순위 — **무엇부터 볼 것인가** (요구사항 정의서 §15 `TASK-007`).
 *
 * ## ⚠️ 칸만 있고 아무도 안 읽고 있었습니다
 *
 * `tasks.priority` 는 정수 열로 진작 있었고 검색 API 는 이 값으로 거르기까지
 * 했는데, 사람이 값을 **정할 자리도 볼 자리도** 없었습니다 — 있지도 않은
 * 값으로 거를 수 있는 필터였습니다. 이 저장소의 실패 ①(만들어 놓고 아무도
 * 안 부름)과 ③(할 일을 알려 주고 그 일을 할 자리를 안 줌)이 겹친 자리입니다.
 *
 * ## ⛔ 기여도에 연결하지 마십시오
 *
 * 우선순위가 점수에 닿는 순간 **드롭다운 하나가 점수 발행기**가 됩니다.
 * 아무 일도 안 하고 자기 업무를 `긴급` 으로 바꾸는 것만으로 점수가 오르면
 * 안 됩니다. 이건 "무엇부터 볼까" 를 정하는 값이지 "누가 잘했나" 가
 * 아닙니다. 백엔드도 이 변경으로 기여 이벤트를 만들지 않습니다.
 *
 * ## ⚠️ 작을수록 급합니다
 *
 * `0 긴급 · 1 높음 · 2 보통 · 3 낮음`. 방향을 헷갈리면 정렬이 조용히
 * 뒤집힙니다 — 이름과 숫자를 같이 읽으세요.
 *
 * ⚠️ **`backend/teamflow/db/vocab.py` 의 `TASK_PRIORITY_LABEL` 과 짝입니다.**
 * 런타임이 달라 두 벌이지만, `test_repo_integrity.py` 의 교차 검사가 값이
 * 갈라지면 터집니다.
 */

/** 작을수록 급함. DB 의 `tasks.priority` 가 받는 값 전부. */
export const PRIORITIES = [0, 1, 2, 3] as const;

export type Priority = (typeof PRIORITIES)[number];

/** 값을 안 정했을 때. DB 열의 기본값과 **같아야 합니다.** */
export const PRIORITY_DEFAULT: Priority = 2;

const PRIORITY_LABEL: Record<Priority, string> = {
  0: '긴급',
  1: '높음',
  2: '보통',
  3: '낮음',
};

/**
 * 이 값이 우리가 아는 넷 중 하나인가.
 *
 * ⚠️ 서버가 제약 밖의 값을 주는 일은 이제 없지만(`ck_task_priority`),
 * 제약을 걸기 **전에** 들어간 행이 남아 있을 수 있습니다. 모르는 값을
 * 그대로 그리면 화면에 **빈 칸**이 뜹니다.
 */
export function isPriority(value: unknown): value is Priority {
  return typeof value === 'number' && (PRIORITIES as readonly number[]).includes(value);
}

/** 사람이 읽을 이름. 모르는 값이면 기본값의 이름으로 떨어집니다. */
export function describePriority(value: unknown): string {
  return PRIORITY_LABEL[isPriority(value) ? value : PRIORITY_DEFAULT];
}

/**
 * 이 우선순위를 **카드에 표시할 것인가.**
 *
 * ⚠️ `보통` 은 안 그립니다. 넷 중 셋에 배지가 붙으면 배지가 배경이 되고,
 * 정작 `긴급` 이 눈에 안 들어옵니다 — 늘 있는 글자는 아무도 안 읽습니다.
 * 값을 바꿀 자리는 `⋯` 메뉴에 언제나 있으므로, 안 그린다고 못 정하는
 * 것은 아닙니다.
 */
export function showsBadge(value: unknown): boolean {
  return isPriority(value) && value !== PRIORITY_DEFAULT;
}

/**
 * 배지의 톤. **`긴급` 만 색을 씁니다.**
 *
 * ⚠️ 넷을 네 색으로 칠하면 칸반이 신호등이 되고, 이 저장소가 색에 쓰는
 * 뜻(인디고 = 근거 있음 · 황토 = 못 잼)과 부딪힙니다. `높음`·`낮음` 은
 * 글자만으로 충분합니다.
 */
export function priorityTone(value: unknown): 'urgent' | 'plain' {
  return value === 0 ? 'urgent' : 'plain';
}

/**
 * `⋯` 메뉴에 세울 항목들 — **급한 것부터.**
 *
 * ⚠️ 지금 값도 목록에 남깁니다. 빼면 메뉴가 셋이 되고, 사람은 "지금 뭐지"
 * 를 확인하러 다른 데를 봐야 합니다. `current` 로 표시만 합니다.
 */
export function priorityChoices(now: unknown): { value: Priority; label: string; current: boolean }[] {
  const at = isPriority(now) ? now : PRIORITY_DEFAULT;
  return PRIORITIES.map((value) => ({ value, label: PRIORITY_LABEL[value], current: value === at }));
}
