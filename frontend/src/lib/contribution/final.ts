
import { withJosa } from '../text/josa.ts';
/**
 * 최종 확정 — **사람이** 확정한다 (`docs/05` §5).
 *
 * `docs/05` §5 는 "최종 점수를 시스템이 확정" 을 ❌ 로 금지합니다. 그런데
 * 확정을 남길 자리가 API 에도 화면에도 없어서, 배포 상태에서 존재하는
 * 값은 시스템이 계산한 숫자뿐이었습니다 — 금지한 쪽으로 실제 동작한
 * 것입니다.
 *
 * 이 파일은 **판단만** 합니다. DOM 도 fetch 도 없습니다 — 화면 코드에
 * 묻으면 브라우저 없이는 못 재고, 못 재는 규칙은 조용히 틀어집니다.
 */

export interface FinalRow {
  user_id: number;
  system_value: number;
  final_value: number;
  adjusted_by: number | null;
  reason: string | null;
  confirmed_at: string;
}

export interface Draft {
  user_id: number;
  /** 사람이 적은 값. 비워 두면 시스템 값을 그대로 받아들인다. */
  final_value: number | null;
  reason: string;
}

export interface Payload {
  user_id: number;
  final_value?: number;
  reason?: string;
}

/** 두 값이 실질적으로 같은가. 부동소수 비교를 한 곳에 모은다. */
export function sameValue(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

/**
 * 보내기 전에 막는다.
 *
 * ⚠️ 서버도 같은 규칙으로 거절합니다. 여기서 막는 이유는 **사람에게 먼저
 * 말하기 위해서**입니다 — 서버가 400 을 돌려준 뒤에 알려 주면, 그때는
 * 이미 다른 사람의 확정까지 같이 실패한 뒤입니다.
 */
export function problemsWith(
  drafts: Draft[],
  systemValues: Map<number, number>,
): string[] {
  const problems: string[] = [];
  for (const draft of drafts) {
    if (draft.final_value === null) continue;
    if (Number.isNaN(draft.final_value)) {
      problems.push(`숫자가 아닌 값이 있습니다 (${draft.user_id})`);
      continue;
    }
    const system = systemValues.get(draft.user_id);
    if (system === undefined) continue;
    if (!sameValue(draft.final_value, system) && !draft.reason.trim()) {
      problems.push('시스템 값과 다르게 확정하려면 이유를 적어야 합니다');
    }
  }
  // 같은 말을 여러 번 쌓지 않는다. 사람이 읽을 목록이다.
  return [...new Set(problems)];
}

/** 서버로 보낼 모양. 안 건드린 칸은 값을 **안 보낸다** — 서버가 시스템 값을 쓴다. */
export function toPayload(drafts: Draft[], systemValues: Map<number, number>): Payload[] {
  return drafts.map((draft) => {
    const system = systemValues.get(draft.user_id);
    const untouched =
      draft.final_value === null ||
      (system !== undefined && sameValue(draft.final_value, system));
    if (untouched) return { user_id: draft.user_id };
    return {
      user_id: draft.user_id,
      final_value: draft.final_value as number,
      reason: draft.reason.trim() || undefined,
    };
  });
}

/**
 * 확정 상태를 한 줄로.
 *
 * ⚠️ **확정 전에 "0" 이나 빈 문자열을 보여주면 안 됩니다.** 사람은 그걸
 * "확정값이 0" 으로 읽습니다. 아직 아무도 확정하지 않았다는 것과 0 으로
 * 확정했다는 것은 다릅니다 — 이 저장소가 반복해 지켜 온 구분입니다.
 */
export function describeFinals(finals: FinalRow[], names: Map<number, string>): string {
  if (finals.length === 0) return '아직 아무도 확정하지 않았습니다.';

  const first = finals[0];
  if (first === undefined) return '아직 아무도 확정하지 않았습니다.';
  const when = new Date(first.confirmed_at).toLocaleString('ko-KR');
  const adjusted = finals.filter((f) => !sameValue(f.final_value, f.system_value));
  if (adjusted.length === 0) {
    return `${when}에 시스템 값 그대로 확정했습니다.`;
  }
  const who = adjusted
    .map((f) => names.get(f.user_id) ?? `#${f.user_id}`)
    .join(', ');
  // ⚠️ `은(는)` 이 그대로 화면에 나오고 있었습니다 (결함 76).
  return `${when}에 확정했습니다 — ${withJosa(who, '은는')} 시스템 값과 다르게 정했습니다.`;
}
