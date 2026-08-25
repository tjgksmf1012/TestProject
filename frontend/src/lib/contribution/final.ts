
import { teamDateTime } from '../time/calendar.ts';
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
/** 이 조정에 **사유가 필요한가.** 시스템 값과 다르게 정했으면 필요합니다.
 *
 *  ⚠️ `problemsWith`(무엇이 문제인가)와 `firstGapOf`(어디로 데려갈까)가
 *  **같은 규칙**을 봐야 합니다 — 따로 적으면 「이유를 적으라」고 해 놓고
 *  엉뚱한 칸으로 데려갑니다(대표 실패 ②). */
export function needsReasonFor(
  draft: Draft,
  systemValues: ReadonlyMap<number, number>,
): boolean {
  if (draft.final_value === null || Number.isNaN(draft.final_value)) return false;
  const system = systemValues.get(draft.user_id);
  if (system === undefined) return false;
  return !sameValue(draft.final_value, system);
}

export function problemsWith(
  drafts: Draft[],
  systemValues: Map<number, number>,
  /**
   * 아무것도 안 잰 사람들 (`nothingMeasured` — 범주가 하나도 없음).
   *
   * ⛔ 이 사람들은 **「시스템 값 그대로」 확정할 수 없습니다** (결함 307) —
   * 받아들일 값 자체가 없습니다. 팀이 값을 **직접 적고 이유를 남기는 것**은
   * 됩니다(불변식 ④: 시스템은 판정하지 않습니다).
   *
   * ⚠️ 거절은 서버가 합니다. 여기서는 **미리 말해 줄** 뿐입니다 — 눌러서
   * 400 을 받고 나서야 아는 것보다 낫습니다.
   */
  unmeasured: ReadonlySet<number> = new Set(),
): string[] {
  const problems: string[] = [];
  for (const draft of drafts) {
    if (draft.final_value === null) {
      if (unmeasured.has(draft.user_id)) {
        problems.push(
          '아직 잰 것이 없어 시스템 값이 없습니다 — 확정하려면 값을 직접 적고 이유를 남기세요',
        );
      }
      continue;
    }
    if (Number.isNaN(draft.final_value)) {
      problems.push(`숫자가 아닌 값이 있습니다 (${draft.user_id})`);
      continue;
    }
    /* ⚠️ **-5% · 999% 가 아무 경고 없이 확정됐습니다** (결함 215). 셋을
       `-5 · -894 · 999` 로 넣었더니 합이 정확히 100 이라 합계 경고도
       조용했고, 서버는 201 을 줬습니다.

       ⛔ 이것은 **불변식 넷째("시스템은 판정하지 않습니다")의 예외가
       아닙니다.** 팀이 시스템 값과 다르게 정하는 것은 얼마든지 되고, 그건
       사유로 남깁니다. 여기서 막는 것은 **다른 의견이 아니라 있을 수 없는
       값**입니다 — 기여도는 전체에 대한 몫이라 음수도 100 초과도 뜻이
       없습니다. 바로 위 "숫자가 아닌 값" 과 같은 종류입니다.

       ⚠️ 합계가 100 이 아닌 것은 **막지 않습니다.** 팀 일부만 확정하는
       경우가 있어서, 그건 경고만 하기로 이미 정해져 있습니다. */
    if (draft.final_value < 0 || draft.final_value > 100) {
      problems.push('기여도는 0~100 사이여야 합니다 — 음수나 100 초과는 몫이 될 수 없습니다');
      continue;
    }
    if (needsReasonFor(draft, systemValues) && !draft.reason.trim()) {
      /* ⚠️ 뒤의 "사유 없는 조정은…" 은 **화면이 목록 전체에 붙이고
         있었습니다.** 문제가 하나뿐일 때는 읽혔는데, 범위 문제가 생기자
         「기여도는 0~100 사이여야 합니다 … — 사유 없는 조정은 근거 없는
         점수와 같습니다」 가 됐습니다 — 범위와 아무 상관 없는 꼬리입니다.
         문장은 **그 문제 옆에** 둡니다. */
      problems.push(
        '시스템 값과 다르게 확정하려면 이유를 적어야 합니다 — 사유 없는 조정은 근거 없는 점수와 같습니다',
      );
    }
  }
  // 같은 말을 여러 번 쌓지 않는다. 사람이 읽을 목록이다.
  return [...new Set(problems)];
}

/**
 * 확정 줄에 적을 **시스템 값**.
 *
 * ## ⛔ 안 잰 사람에게 `0.0%` 라고 적고 있었습니다 (결함 307)
 *
 * 갓 만든 프로젝트에서 기여도 화면의 카드는 정확히 말합니다 —
 *
 *     —                    ← 구간 (`describeRange`)
 *     모르는 폭 100%p
 *     이 사람의 활동이 아직 하나도 연결되지 않았습니다
 *       — 0 이라는 뜻이 아니라 연결이 없다는 뜻입니다.
 *
 * 그런데 **여섯 줄 아래** 확정 줄이 「시스템 **0.0%**」였습니다. 같은
 * 화면이 같은 사실을 두고 서로 다른 말을 합니다(결함 290 과 같은 모양).
 * 그리고 [이 값으로 확정] 을 누르면 그 0 이 기록으로 남고, 최종 보고서가
 * 「측정하지 못했습니다」 두 줄 아래에서 「팀 확정 0%」라고 적었습니다.
 *
 * ⚠️ **`—` 는 카드와 같은 글자입니다.** 확정 줄만 다른 글자를 쓰면 사람은
 * 둘이 다른 뜻이라고 읽습니다.
 */
export function systemLabel(value: number | undefined, measured: boolean): string {
  if (!measured) return '—';
  return `${(value ?? 0).toFixed(1)}%`;
}

/**
 * 서버로 보낼 모양. 안 건드린 칸은 값을 **안 보낸다** — 서버가 시스템 값을 쓴다.
 *
 * ⚠️ **안 잰 사람은 예외입니다** (결함 307). 그 사람의 시스템 값은 0 으로
 * 계산되므로, 팀이 **일부러 0 을 적어도** `sameValue(0, 0)` 이 참이 되어
 * 「안 건드렸다」로 접혔습니다. 그러면 값이 안 실려 나가고 서버가 거절해서,
 * 팀이 이유까지 적었는데도 400 이 났습니다 — 고치면서 낸 것을 렌더해서
 * 잡았습니다. 잰 것이 없으면 「시스템과 같다」는 말 자체가 뜻이 없습니다.
 */
export function toPayload(
  drafts: Draft[],
  systemValues: Map<number, number>,
  unmeasured: ReadonlySet<number> = new Set(),
): Payload[] {
  return drafts.map((draft) => {
    const system = systemValues.get(draft.user_id);
    const untouched =
      draft.final_value === null ||
      (!unmeasured.has(draft.user_id) &&
        system !== undefined &&
        sameValue(draft.final_value, system));
    if (untouched) return { user_id: draft.user_id };
    return {
      user_id: draft.user_id,
      final_value: draft.final_value as number,
      reason: draft.reason.trim() || undefined,
    };
  });
}

/** 화면 입력칸에 되돌려 놓을 값. */
export interface Restore {
  /** 사람이 적었던 값. */
  final_value: number;
  /** 그때 적은 이유. 없으면 빈 문자열. */
  reason: string;
}

/**
 * 저장된 확정 중 **사람이 조정한 것**만 돌려준다 (결함 97).
 *
 * ## 왜 필요한가 — 남의 조정이 조용히 지워지고 있었습니다
 *
 * 확정 표의 입력칸은 늘 **비어 있게** 그려졌습니다. 빈 칸은
 * `toPayload` 에서 "안 건드림" 이고, 서버는 안 건드린 칸에 **시스템
 * 값**을 씁니다. 그래서 이런 일이 났습니다.
 *
 *   1. 김민수가 이하늘의 값을 33.6 → 30 으로 조정하고 이유를 적는다
 *   2. 나중에 같은 화면을 열면 이하늘 칸은 **비어 있다** (안내도 없다)
 *   3. 김민수가 **자기 값만** 고치고 확정을 누른다
 *   4. 이하늘의 30 과 이유가 **말 없이 33.6 으로 되돌아간다**
 *
 * 브라우저로 재현했습니다 — 3단계 뒤 서버 기록이
 * `2:30/문서 작업이 많았습니다` 에서 `2:33.552/-` 로 바뀝니다.
 * 사람의 판단을 지운 것이고, 지웠다는 말조차 안 했습니다.
 *
 * ## ⚠️ 조정한 칸만 되돌려 놓습니다
 *
 * 안 건드린 칸까지 채우면 **반올림한 값이 새 조정으로 읽힙니다** —
 * 시스템 값 41.713 을 `41.7` 로 적어 놓으면 다음 확정에서
 * "시스템 값과 다르니 이유를 적으라" 고 막습니다. 빈 칸은 원래
 * "시스템 값 그대로" 라는 뜻이고, 그 뜻이 맞습니다.
 */
export function adjustmentsToRestore(finals: FinalRow[]): Map<number, Restore> {
  const out = new Map<number, Restore>();
  for (const f of finals) {
    if (sameValue(f.final_value, f.system_value)) continue;
    out.set(f.user_id, { final_value: f.final_value, reason: f.reason ?? '' });
  }
  return out;
}

/**
 * 저장된 확정을 **모르는 채로** 확정하려 할 때.
 *
 * 조회가 실패하면 입력칸을 되돌려 놓을 수 없습니다. 그 상태로 확정하면
 * 위 1~4 가 그대로 일어나는데, 이번엔 화면도 그걸 모릅니다. 모르면
 * 멈춥니다 — 사람의 판단을 지우는 쪽으로 기울면 안 됩니다.
 */
export const BLIND_CONFIRM =
  '지금 저장된 확정을 불러오지 못했습니다 — 이대로 확정하면 이전에 조정한 값이 지워질 수 있습니다. 새로고침한 뒤 다시 해 주세요.';

/** 확정이 **지금 막혀 있는 이유**. 막힌 게 없으면 `null`. */
export interface ConfirmGate {
  /** 팀원이 몇 명인가. 0명이면 확정할 것 자체가 없습니다. */
  memberCount: number;
  /** 아직 값을 안 적은 칸 수. */
  unfilled: number;
  /** `problemsWith` 가 찾은 것들 (합·안 잰 사람 등). */
  problems: readonly string[];
  /** 저장된 확정을 **못 불러온** 상태인가. */
  blind: boolean;
  /** 지금 보내는 중인가. */
  sending?: boolean;
}

/**
 * 「이 값으로 확정」이 **지금 안 되는 이유**.
 *
 * ## ⛔ 빈 칸을 「시스템 값 그대로」로 확정할 수 있었습니다 (결함 372)
 *
 * v2 F1-4 는 이렇게 정했습니다 — **확정값은 시스템이 아니라 팀이
 * 적습니다.** 빈 칸은 「시스템 값 그대로」가 아니라 「아직 안 정함」이고,
 * 다 정해야 확정이 열립니다.
 *
 * SPA 는 그 결정대로 막고 있었는데(`3칸 남음`), **레거시는 아무 게이트도
 * 없었습니다.** 손대지 않은 화면에서 한 번 누르면 `201` 이 떨어지고
 * 기록이 이렇게 남습니다 —
 *
 *     08-25 14:24에 이하늘님이 확정했습니다 — 시스템 값 그대로입니다.
 *
 * 이 제품의 불변식 ④ 는 **시스템은 판정하지 않습니다** 입니다. 사람이
 * 아무 값도 안 적었는데 시스템 값이 팀의 확정으로 굳고, 그 기록에는
 * 사람 이름이 붙습니다 — 시스템의 판정에 사람 얼굴을 씌운 것입니다.
 *
 * ⚠️ 순서가 곧 우선순위입니다. 빈 칸이 있으면 그것부터 말합니다 —
 * 합이 안 맞는다고 먼저 말하면, 아직 안 적은 사람에게 「고쳐라」부터
 * 시키는 셈입니다(`whyCannotSave` 와 같은 뜻).
 */
/** 확정을 막는 **갈래**. 판단은 여기 한 벌이고, 화면은 각자 필요한
 *  모양으로 투영합니다 — 레거시는 문장(`whyCannotConfirm`)을, SPA 는
 *  사유 문단의 id 를 고릅니다. ⚠️ 두 화면이 각자 `if` 사슬을 쓰면 그
 *  순간 갈라집니다(대표 실패 ②). 갈래를 하나 더하면 SPA 의
 *  `Record<ConfirmBlock, …>` 이 **컴파일 오류**로 알려 줍니다. */
export type ConfirmBlock = 'sending' | 'no-members' | 'unfilled' | 'problems' | 'blind';

/** ⚠️ 순서가 곧 우선순위입니다 — 아직 안 적은 사람에게 「고쳐라」부터
 *  시키지 않습니다. */
export function confirmBlockOf(gate: ConfirmGate): ConfirmBlock | null {
  if (gate.sending === true) return 'sending';
  if (gate.memberCount === 0) return 'no-members';
  if (gate.unfilled > 0) return 'unfilled';
  if (gate.problems.length > 0) return 'problems';
  if (gate.blind) return 'blind';
  return null;
}

/** 막힌 버튼을 눌렀을 때 **데려갈 자리**. 알려만 주고 갈 곳이 없으면
 *  이 저장소의 대표 실패 ③ 입니다.
 *
 *  ⚠️ 순서는 `confirmBlockOf` 와 **같습니다** — 빈 칸이 먼저입니다. 두
 *  화면이 각자 `find` 사슬을 쓰면 그 순간 두 벌이고, 한쪽만 고쳐집니다.
 *  DOM 은 화면이 만집니다 — 여기서는 **어느 사람의 어느 칸인가**만
 *  정합니다. */
export interface ConfirmGap {
  userId: number;
  field: 'value' | 'reason';
}

export function firstGapOf(
  drafts: readonly Draft[],
  systemValues: ReadonlyMap<number, number>,
  reasonOf: (userId: number) => string,
): ConfirmGap | null {
  const empty = drafts.find((d) => d.final_value === null || Number.isNaN(d.final_value));
  if (empty !== undefined) return { userId: empty.user_id, field: 'value' };
  const noReason = drafts.find(
    (d) => needsReasonFor(d, systemValues) && reasonOf(d.user_id).trim() === '',
  );
  if (noReason !== undefined) return { userId: noReason.user_id, field: 'reason' };
  return null;
}

export function whyCannotConfirm(gate: ConfirmGate): string | null {
  switch (confirmBlockOf(gate)) {
    case 'sending':
      return '확정하는 중입니다';
    case 'no-members':
      return '확정할 팀원이 없습니다';
    case 'unfilled':
      return `${gate.unfilled}칸 남음`;
    case 'problems':
      return gate.problems.join(' · ');
    case 'blind':
      return BLIND_CONFIRM;
    default:
      return null;
  }
}

/**
 * 이름 + `님`.
/**
 * 이름 + `님`.
 *
 * `님` 은 받침이 있어서 뒤따르는 조사가 **이름과 상관없이** 정해집니다
 * (`님이`·`님의`). 그래도 조사는 `withJosa` 로 고릅니다 — 여기서 눈으로
 * 고르기 시작하면 다음 사람이 `님` 을 뗄 때 조용히 틀어집니다.
 *
 * 이름을 모르면 `#3님` 입니다. **빈칸으로 두지 않습니다** — 주체가 사라진
 * 문장은 시스템이 정한 것처럼 읽힙니다.
 */
function person(id: number, names: Map<number, string>): string {
  const name = names.get(id) ?? `#${id}`;
  return `${name}님`;
}

/**
 * 이 확정을 **누가** 남겼는가.
 *
 * ⚠️ `adjusted_by` 가 비어 있으면 **지어내지 않고 뺍니다.** 빈 자리를
 * 아무 이름으로 메우면, 하지 않은 판단을 그 사람에게 씌우게 됩니다.
 */
function confirmers(finals: FinalRow[], names: Map<number, string>): string[] {
  const ids = [...new Set(finals.map((f) => f.adjusted_by))];
  return ids.filter((id): id is number => id !== null).map((id) => person(id, names));
}

const percent = (value: number): string => `${value.toFixed(1)}%`;

/**
 * 확정 상태를 한 줄로.
 *
 * ⚠️ **확정 전에 "0" 이나 빈 문자열을 보여주면 안 됩니다.** 사람은 그걸
 * "확정값이 0" 으로 읽습니다. 아직 아무도 확정하지 않았다는 것과 0 으로
 * 확정했다는 것은 다릅니다 — 이 저장소가 반복해 지켜 온 구분입니다.
 *
 * ## ⚠️ 주어는 **조정한 사람**입니다 (결함 95)
 *
 * 이 문장은 이렇게 나오고 있었습니다.
 *
 *     … 확정했습니다 — 이하늘은 시스템 값과 다르게 정했습니다.
 *
 * 그런데 **이하늘은 값이 깎인 사람**이고, 깎은 사람은 김민수였습니다.
 * 빠진 정보가 아니라 **잘못된 귀속**입니다 — 읽는 사람은 이하늘이 제
 * 점수를 스스로 올렸다고 읽습니다. 서버는 `adjusted_by` 에 누가 눌렀는지
 * 남기고 있었고(`api/main.py` 의 "조정은 판단이고, 판단에는 주체가 있어야
 * 이의를 제기할 상대가 생깁니다"), 화면이 그 칸을 **안 읽었습니다**.
 *
 * ## 이유도 같이 말합니다 (결함 96)
 *
 * `problemsWith` 는 "시스템 값과 다르게 확정하려면 이유를 적어야 합니다"
 * 로 사람을 막고, 서버도 400 으로 막습니다. 그렇게 받아 낸 `reason` 을
 * **아무 화면도 보여주지 않았습니다.** 근거를 강제로 받아 놓고 감춰 두면
 * 받은 뜻이 없습니다 — 이의를 제기하려면 무엇에 대해서인지 알아야 합니다.
 */
export function describeFinals(finals: FinalRow[], names: Map<number, string>): string {
  if (finals.length === 0) return '아직 아무도 확정하지 않았습니다.';

  const first = finals[0];
  if (first === undefined) return '아직 아무도 확정하지 않았습니다.';
  /* ⚠️ **브라우저 달력이었습니다** (결함 334). `toLocaleString` 을 시간대
     없이 부르면 보는 사람의 시간대로 찍힙니다 — 같은 순간을

         서울   26. 9. 2. AM 1:30
         뉴욕   26. 9. 1. PM 12:30

     로 **날짜까지 갈라서** 보여 줍니다. 하필 이 값은 「누가 **언제**
     확정했는가」 — 분쟁에서 제일 먼저 보는 줄입니다. 팀 달력 한 벌
     (`Asia/Seoul`)로 그립니다 (결함 246).

     ⚠️ 결함 287 이 `home/next.ts` 에서 같은 것을 고치고 「예전에는
     `toLocaleString` 을 시간대 없이 불렀습니다」라고 적어 뒀는데, 그때
     **이 자리와 레거시 기여도 화면은 안 봤습니다.** */
  const when = teamDateTime(first.confirmed_at) ?? first.confirmed_at;

  // ⚠️ `은(는)` 이 그대로 화면에 나오고 있었습니다 (결함 76).
  const who = confirmers(finals, names).join(', ');
  const did =
    who === ''
      ? '확정했습니다(누가 눌렀는지는 기록에 없습니다)'
      : `${withJosa(who, '이가')} 확정했습니다`;

  const adjusted = finals.filter((f) => !sameValue(f.final_value, f.system_value));
  if (adjusted.length === 0) {
    // 그대로 두는 것도 **사람의 확정**입니다. 주어를 빼면 시스템이 정한
    // 것처럼 읽히고, 그게 `docs/05` §5 가 금지한 바로 그 그림입니다.
    return `${when}에 ${did} — 시스템 값 그대로입니다.`;
  }

  const details = adjusted.map((f) => {
    const reason = f.reason?.trim() ?? '';
    const why = reason === '' ? '이유가 남아 있지 않습니다' : reason;
    const target = person(f.user_id, names);
    return `${target} ${percent(f.final_value)}(시스템 ${percent(f.system_value)}, 이유: ${why})`;
  });
  return `${when}에 ${did} — ${details.join(' · ')}`;
}
