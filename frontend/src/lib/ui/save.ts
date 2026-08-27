/**
 * 「저장」이 **지금 안 되는 이유**.
 *
 * ## ⛔ 설정의 저장 넷이 `disabled` 였습니다 (결함 234)
 *
 * 이 저장소의 비활성 버튼은 `aria-disabled` 입니다 — 초점을 받고, 눌리고,
 * **사유를 말합니다.** `disabled` 는 초점을 못 받으므로 낭독기·키보드
 * 사용자가 그 자리에 닿지 못합니다.
 *
 * 역할 비중 화면에서 재 봤습니다. 합을 0.5 로 만들면 화면에는 사유가
 * 멀쩡히 적힙니다.
 *
 *     합이 1 이어야 합니다 (지금 0.5)
 *
 * 그런데 Tab 을 눌러 가면 `기획 비중 → 디자인 비중 → 「왜 나만 바꿀 수
 * 있나요」` 로 **저장 버튼을 건너뛰고** 패널 밖으로 나갑니다. 버튼에
 * 닿지 못하니 `aria-describedby` 도 걸 수 없고, 그 문장은 **버튼과 아무
 * 관계가 없는 홑 문단**으로 남습니다.
 *
 * 같은 화면의 `저장소 연결` 은 이미 올바른 모양이었습니다(결함 211).
 * 그 옆에서 넷이 옛 모양으로 남아 있었습니다 — 설정의 `저장` 은 role ·
 * github · profile · general 넷입니다.
 *
 * ## 순서가 뜻을 정합니다
 *
 * ⚠️ **권한이 맨 앞입니다.** 권한이 없는 사람에게 「합이 1 이어야 합니다」
 * 라고 하면, 고쳐도 안 되는 일을 시키는 것입니다.
 *
 * ⚠️ **「바꾼 것이 없습니다」는 맨 뒤입니다.** 값에 문제가 있는데 이 말을
 * 먼저 하면, 사람은 뭘 바꿔야 하는지 모른 채 바꾸라는 말만 듣습니다.
 */
export interface SaveGate {
  /** 권한이 없어서 못 하는 경우의 문장. 없으면 `null`. */
  noPermission?: string | null;
  /** 값 자체의 문제. 없으면 `null`. */
  problem?: string | null;
  /** 저장할 만큼 바뀌었는가. */
  dirty?: boolean;
  /** 지금 보내는 중인가. */
  saving?: boolean;
}

export function whyCannotSave(gate: SaveGate): string | null {
  if (gate.noPermission !== null && gate.noPermission !== undefined && gate.noPermission !== '') {
    return gate.noPermission;
  }
  if (gate.saving === true) return '저장하는 중입니다';
  if (gate.problem !== null && gate.problem !== undefined && gate.problem !== '') {
    return gate.problem;
  }
  if (gate.dirty === false) return '바꾼 것이 없습니다';
  return null;
}
