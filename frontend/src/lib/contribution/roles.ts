/**
 * 역할 비중 — **기여도 가중치를 정하는 값**.
 *
 * 가입도 초대도 `developer: 1.0` 을 하드코딩하고 있었고 바꿀 자리가
 * 없었습니다. 그래서 기획자·디자이너 프로파일은 도달 불가였고, 문서만
 * 쓴 사람이 개발자 가중치(코드 35% · 문서 5%)로 계산돼 이유 없이 낮게
 * 나왔습니다 — **오류는 어디에도 안 납니다.**
 *
 * 판단만 합니다. DOM 도 fetch 도 없습니다.
 */

export interface RoleOption {
  key: string;
  label: string;
  hint: string;
}

/** 서버 `Role` 과 같은 셋. 늘리면 서버부터 늘려야 한다. */
export const ROLE_OPTIONS: RoleOption[] = [
  { key: 'developer', label: '개발', hint: '코드 35% · 업무 30%' },
  { key: 'planner', label: '기획', hint: '문서 30% · 업무 30% · 코드 0%' },
  { key: 'designer', label: '디자인', hint: '문서 35% · 업무 30% · 코드 0%' },
];

/** 화면에서 읽은 값의 합. 부동소수 먼지를 여기서 턴다. */
export function sumOf(shares: Record<string, number>): number {
  const total = Object.values(shares).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  return Math.round(total * 1e6) / 1e6;
}

/**
 * 보내기 전에 막는다. 서버도 같은 규칙으로 거절하지만, **사람에게 먼저**
 * 말해야 무엇을 고쳐야 하는지 알 수 있다.
 */
export function problemWith(shares: Record<string, number>): string | null {
  if (Object.values(shares).some((v) => !Number.isFinite(v))) {
    return '숫자가 아닌 값이 있습니다';
  }
  if (Object.values(shares).some((v) => v < 0)) {
    return '역할 비중은 음수일 수 없습니다';
  }
  const total = sumOf(shares);
  if (total === 0) return '역할을 하나 이상 골라야 합니다';
  if (Math.abs(total - 1) > 1e-6) {
    return `합이 1 이어야 합니다 (지금 ${total})`;
  }
  return null;
}

/** 서버로 보낼 모양. **0 은 뺀다** — 겸직이 아니라 그냥 그 역할이다. */
export function toPayload(shares: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(shares)) {
    if (value > 0) out[key] = value;
  }
  return out;
}

/**
 * 역할 목록만. **정해진 게 없으면 `null`** 입니다.
 *
 * ## 왜 `describeRoles` 와 갈랐는가
 *
 * `describeRoles` 는 문장을 돌려줍니다 — 역할이 없으면 "역할이 정해지지
 * 않았습니다." 입니다. 설정 화면처럼 넓은 자리에는 맞지만 **맥락 패널의
 * 좁은 줄에는 문장이 안 들어갑니다.**
 *
 * 그렇다고 패널이 자기 몫을 따로 계산하면 역할 이름표가 **두 벌**이
 * 됩니다 — `ROLE_OPTIONS` 에 항목이 하나 늘었을 때 한쪽만 고쳐집니다.
 * 그래서 목록을 만드는 일은 여기 하나로 두고, 없을 때 무슨 말을 할지는
 * 부르는 쪽이 정합니다.
 */
export function roleSummary(shares: Record<string, number> | undefined): string | null {
  const entries = Object.entries(shares ?? {}).filter(([, v]) => v > 0);
  if (entries.length === 0) return null;
  const label = (key: string): string =>
    ROLE_OPTIONS.find((o) => o.key === key)?.label ?? key;
  if (entries.length === 1) return `${label(entries[0]?.[0] ?? '')} 100%`;
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => `${label(key)} ${Math.round(value * 100)}%`)
    .join(' · ');
}

/** 지금 역할을 한 줄로. 겸직이면 둘 다 보여야 한다. */
export function describeRoles(shares: Record<string, number> | undefined): string {
  return roleSummary(shares) ?? '역할이 정해지지 않았습니다.';
}
