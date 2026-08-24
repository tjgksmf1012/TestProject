/**
 * 데스크톱 셸 — **창을 닫을 때** 무엇을 할 것인가 (결함 342).
 *
 * ## 이 파일이 있는 이유
 *
 * 이 셸의 존재 이유는 하나뿐입니다 — 「창을 내리거나 화면이 잠겨도 녹음이
 * 안 끊기게」. 그래서 `powerSaveBlocker` 로 잠을 막고 스로틀을 껐습니다.
 *
 * 그런데 **창 닫기 단추 하나면 그게 다 무너졌습니다.** 재 봤습니다.
 *
 *     녹음 중 : 청크 1개 · 절전방지 true
 *     창을 닫음
 *     닫은 뒤 : 앱이 살아 있나=false   ← 녹음 중이던 구간은 영영 못 잽니다
 *
 * 확인도 경고도 없었습니다. 게다가 녹음 화면은 그때 이렇게 말하고 있습니다 —
 * 「화면을 꺼도 녹음이 이어집니다. **앱을 완전히 닫지만 마세요.**」
 * 그 부탁을 어기는 방법이 **창의 X 를 누르는 것**이었고, 사람은 그것을
 * 「완전히 닫기」로 읽지 않습니다.
 *
 * ## ⚠️ 트레이도 자동 실행도 만들지 않았습니다
 *
 * `AGENTS.md` 가 「그것 말고 다른 이유(트레이·자동 실행)로 이 셸을 늘리지
 * 마십시오」라고 못 박아 뒀습니다. 여기서 하는 것은 셸을 늘리는 것이
 * 아니라 **원래 하나뿐인 이유를 닫기 경로에서도 지키는 것**입니다.
 *
 * ## ⚠️ 판단이 여기 있는 이유
 *
 * main 프로세스에는 자동 검사가 안 붙습니다. 무엇을 묻고 어떻게 답을
 * 읽을지는 여기서 정하고, main 은 대화상자를 띄우는 **손**만 합니다.
 */

/** 닫기를 눌렀을 때의 판정. */
export type CloseVerdict =
  | { kind: 'quit' }
  | {
      kind: 'confirm';
      title: string;
      body: string;
      /** 머무르는 쪽 — **기본값이고 취소 버튼입니다.** */
      stay: string;
      /** 닫는 쪽. */
      leave: string;
    };

/**
 * 지금 창을 닫아도 되는가.
 *
 * @param holdingAwake 재우기 방지를 **잡고 있는가**. 이 셸에서 그것은 곧
 *   「녹음 중이거나 끊겼다가 되살아나기를 기다리는 중」입니다
 *   (`lib/platform/awake.ts` 의 `shouldHoldAwake` 가 정합니다).
 *
 *   ⚠️ `interrupted` 도 잡습니다 — 그때 닫으면 되살아날 기회가 사라지므로
 *   막아야 하는 것은 같습니다.
 */
export function whenClosing(holdingAwake: boolean): CloseVerdict {
  if (!holdingAwake) return { kind: 'quit' };
  return {
    kind: 'confirm',
    title: '녹음 중입니다',
    // ⚠️ **되돌릴 수 없다는 것을 먼저 적습니다.** 이 저장소의 다른 확인
    //    문구(`DISCARD_CONFIRM`)와 같은 결입니다.
    body:
      '지금 닫으면 녹음 중인 구간은 되돌릴 수 없습니다.\n' +
      '녹음을 멈추고 닫으려면 창에서 「정지」를 먼저 누르세요.',
    stay: '계속 녹음',
    leave: '닫고 버리기',
  };
}

/**
 * 대화상자가 돌려준 번호를 **머무를까 닫을까**로 옮긴다.
 *
 * ⚠️ 버튼 순서를 main 이 따로 정하지 않게 여기서 같이 정합니다 — 두 곳이
 * 순서를 각자 알면 반드시 갈라집니다(이 저장소의 대표 실패 ②).
 */
export function closeButtons(verdict: CloseVerdict): string[] {
  return verdict.kind === 'confirm' ? [verdict.stay, verdict.leave] : [];
}

/** 대화상자 응답(index) → 정말 닫을 것인가. 모르는 값이면 **안 닫습니다.** */
export function leavesOnAnswer(answer: number): boolean {
  return answer === 1;
}
