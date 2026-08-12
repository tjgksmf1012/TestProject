/**
 * 담당자를 화면에 어떻게 적는가 (`TASK-006` — 담당자는 하나 이상).
 *
 * ## ⚠️ 여럿이 맡으면 **나눠 셌다고 말해야 합니다**
 *
 * 서버는 업무 하나가 만드는 완료 점수를 담당자 수로 나눕니다
 * (`contribution/sharing.py`). 안 나누면 카드에 이름을 다섯 얹는 것이
 * 곧 점수 부풀리기가 되기 때문입니다.
 *
 * 그런데 **나눈 사실을 화면이 말하지 않으면** 사람은 자기 기여도가
 * 낮게 나온 이유를 모릅니다. 이 저장소의 대표 실패 ③ 입니다 — 할 일을
 * 알려 주고 그 일을 할 자리를 안 주는 것, 여기서는 **결과를 보여 주고
 * 이유를 안 주는 것**.
 *
 * ## ⚠️ 맨 앞이 주담당이 아닙니다
 *
 * 서버가 **이름 순**으로 줍니다. 여기서 다시 정렬하지 않습니다 —
 * 정렬하는 순간 그 순서에 뜻이 생기고, 뜻이 생기면 사람은 맨 앞을
 * "진짜 담당자" 로 읽습니다. 두 사람이 맡았으면 둘 다 담당자입니다.
 */

export interface Person {
  user_id: number;
  name: string;
}

/** 담당자 이름 사이에 넣는 것. 서버(`db/assignees.py`)와 같은 글자입니다. */
export const NAME_JOIN = ' · ';

/**
 * 카드에 적는 담당자 줄.
 *
 * ⚠️ **비어 있으면 빈칸이 아니라 "담당자 없음" 입니다.** 빈칸으로 두면
 * 사람은 화면이 덜 그려진 것으로 읽고, 담당자가 없다는 사실 자체가
 * 안 보입니다 — 아무도 안 맡은 일이 제일 위험합니다.
 */
export function assigneeText(assigneeIds: readonly number[], people: readonly Person[]): string {
  if (assigneeIds.length === 0) return '담당자 없음';
  return assigneeIds.map((id) => nameOf(id, people)).join(NAME_JOIN);
}

/**
 * 명단에 없는 사람도 이름 자리를 줍니다.
 *
 * ⚠️ 나간 사람이 담당자로 남아 있을 수 있습니다. 그때 빈칸을 그리면
 * 카드가 담당자 없는 것처럼 보이고, 실제로는 기여 이벤트가 그 사람에게
 * 갑니다 — 화면과 점수가 다른 말을 합니다.
 */
export function nameOf(userId: number, people: readonly Person[]): string {
  return people.find((p) => p.user_id === userId)?.name ?? `사용자 #${userId}`;
}

/**
 * 여럿이 맡았을 때 카드가 반드시 말해야 하는 한 줄. 혼자면 `null`.
 *
 * ⚠️ **"나눴다" 를 숫자로 적습니다.** "공동 담당" 같은 말은 배분이
 * 일어났다는 사실을 안 전달합니다.
 *
 * ⚠️ **누가 더 했는지는 안 적습니다.** 시스템은 그것을 모르고, 안다고
 * 말하면 그 순간 사람에 대한 판정이 됩니다 (`AGENTS.md` 불변식 4).
 */
export function splitNote(assigneeIds: readonly number[]): string | null {
  const n = assigneeIds.length;
  if (n < 2) return null;
  return `${n}명이 맡은 업무입니다 — 완료 기여를 ${n}분의 1씩 나눠 셉니다`;
}

/**
 * 담당자 고르개에서 이 사람을 넣고 뺀 결과.
 *
 * ⚠️ **여기서 정렬하지 않습니다.** 서버가 저장한 뒤 이름 순으로 다시
 * 돌려줍니다. 화면에서 미리 정렬하면 저장 전후로 순서가 달라 보여
 * 사람이 "뭔가 바뀌었나" 하고 다시 누릅니다.
 */
export function toggled(assigneeIds: readonly number[], userId: number): number[] {
  return assigneeIds.includes(userId)
    ? assigneeIds.filter((id) => id !== userId)
    : [...assigneeIds, userId];
}
