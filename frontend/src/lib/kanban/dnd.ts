/**
 * 칸반 드래그 앤 드롭의 판단 (`TASK-005`).
 *
 * ## ⚠️ 끌기는 버튼 경로에 **더하는** 것입니다
 *
 * 버튼(`nextStatuses` 로 그리는 `.move`)이 키보드·낭독기·터치의 유일한
 * 길입니다 — HTML5 DnD 는 터치에서 아예 안 돌고, 포인터가 없는 사람에게는
 * 처음부터 없는 기능입니다. 끌기를 달았다고 버튼을 걷으면 그 사람들에게서
 * 카드를 옮기는 방법 자체가 사라집니다. `guards.test.ts` 의 짝 가드가
 * 「끌기가 있으면 버튼도 있다」 를 잽니다.
 *
 * ## ⚠️ 허용 범위는 버튼과 **똑같습니다**
 *
 * 어디로 옮길 수 있는가는 `nextStatuses` 가 이미 정하고 있습니다. 여기서
 * 따로 정하면 같은 판단이 두 벌이 되고, 「끌기로는 되는데 버튼으로는 안
 * 되는 이동」 이 생기는 순간부터 두 벌은 반드시 갈라집니다.
 */

import { nextStatuses, type Task } from './board.ts';

/**
 * DataTransfer 에 쓰는 우리만의 형식.
 *
 * `text/plain` 을 같이 싣지 않습니다 — 카드를 끌다 입력창에 놓으면 숫자가
 * 글로 박힙니다. 이 형식만 실으면 우리 판 밖에서는 놓을 곳이 없습니다.
 */
export const TASK_DRAG_TYPE = 'application/x-teamflow-task';

/** DataTransfer 에 앉힐 값. id 만 건너갑니다 — 판이 나머지를 이미 압니다. */
export function dragPayload(taskId: number): string {
  return String(taskId);
}

/**
 * 건너온 값 읽기.
 *
 * ⚠️ 숫자가 아니면 `null` 입니다. drop 이벤트는 **아무나** 일으킬 수
 * 있습니다 — 다른 창에서 끌어온 글자, 파일, 남의 사이트 조각. 그대로
 * 숫자로 바꿔 PATCH 주소에 넣으면 이상한 요청이 나갑니다.
 */
export function draggedTaskId(payload: string | null | undefined): number | null {
  if (payload === null || payload === undefined) return null;
  if (!/^\d{1,10}$/.test(payload)) return null;
  return Number(payload);
}

/**
 * 이 열에 내려놓을 수 있는가 — `nextStatuses` 에 위임합니다.
 *
 * 같은 열(제자리)은 거짓입니다 — 같은 값 PATCH 는 아무 일도 안 하면서
 * 사용자는 뭔가 했다고 생각합니다. `알 수 없는 상태` 열(`__unknown__`)도
 * 거짓입니다 — 서버 상태 목록에 없는 곳으로는 보낼 수 없습니다.
 * 반대로 **알 수 없는 상태에서 아는 열로** 끄는 것은 참입니다 — 버튼이
 * 이미 허용하는 구조 경로이고, 끌기만 막으면 두 벌이 됩니다.
 */
export function canDropOn(task: Task, toStatus: string, statuses: readonly string[]): boolean {
  return nextStatuses(task, statuses).includes(toStatus);
}
