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

// 근거가 없다는 사실도 정보입니다 — 숨기지 않고 황토로 말합니다.
export function NoEvidenceNotice({ what }: { what: string }) {
  return (
    <p className="notice" role="note">
      <strong>근거 없음.</strong> {what} 근거가 연결되지 않아 등록할 수 없습니다. 회의
      전사에서 해당 발화를 찾아 근거로 연결하세요.
    </p>
  );
}
