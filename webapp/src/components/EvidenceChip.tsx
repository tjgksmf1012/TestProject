// 근거 칩 — 인디고는 "근거 있음/실행 가능"에만 씁니다.
// 칩은 언제나 원문으로 이어져야 합니다 (실패 ③: 근거 번호만 주고 볼 자리를 안 준 것).

interface EvidenceChipProps {
  /** 근거 번호 등 짧은 식별자 — 모노로 그립니다. */
  id: string;
  onOpen: () => void;
  /** 접근성 라벨. 생략하면 "근거 {id} 원문 보기". */
  label?: string;
}

export function EvidenceChip({ id, onOpen, label }: EvidenceChipProps) {
  return (
    <button type="button" className="chip chip--evidence" onClick={onOpen} aria-label={label ?? `근거 ${id} 원문 보기`}>
      {id}
    </button>
  );
}

/**
 * **눌리지 않는** 근거 칩 — 삽화 전용.
 *
 * ## 왜 따로 있는가 (결함 337)
 *
 * 로그인 화면의 왼쪽 삽화(`aria-hidden="true"`)가 진짜 `EvidenceChip` 을
 * `onOpen={() => {}}` 로 그리고 있었습니다. 두 가지가 한꺼번에 틀립니다.
 *
 *   · **첫 Tab 이 거기에 닿습니다.** `aria-hidden` 은 낭독기에게만 하는
 *     말이고 **초점 순서는 안 건드립니다** — 낭독기에는 "없는 것" 이라고
 *     해 놓고 키보드로는 제일 먼저 닿는 자리였습니다
 *   · **눌러도 아무 일도 안 합니다.** 재 보니 0바이트 · 0요소 · 0요청
 *
 * 위의 `EvidenceChip` 주석이 「칩은 **언제나** 원문으로 이어져야 합니다」
 * 라고 적어 둔 바로 그것입니다(실패 ③). 삽화의 칩은 이어질 원문이
 * 없으므로 **버튼이 아니어야** 합니다.
 */
export function EvidenceChipStill({ id }: { id: string }) {
  return <span className="chip chip--evidence">{id}</span>;
}

// 근거가 없다는 사실도 정보입니다 — 숨기지 않고 황토로 말합니다.
export function NoEvidenceNotice({ what }: { what: string }) {
  return (
    <p className="notice" role="note">
      <strong>근거 없음.</strong> {what} 근거가 연결되지 않아 등록할 수 없습니다. 회의
      전사에서 해당 발화를 찾아 근거로 연결하세요.
    </p>
  );
}
