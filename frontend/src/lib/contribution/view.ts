/**
 * 기여도 화면의 판단 로직.
 *
 * 이 화면은 이 프로젝트에서 **가장 위험한 화면**입니다. 대학생 팀 프로젝트의
 * 기여도는 성적으로 이어지고, 숫자 하나가 사람 사이를 틀어놓습니다.
 * `docs/05` §5 와 `docs/07` E2 가 정한 것을 화면에서 지키는 게 여기 있는
 * 코드의 전부입니다.
 *
 *   1. **순위를 만들지 않는다.** 정렬조차 점수로 하지 않습니다.
 *   2. **단일 점수를 띄우지 않는다.** 구간 + 신뢰도 + 근거가 같이 갑니다.
 *   3. **측정 불가는 0점이 아니다.** 이 둘을 같은 칸에 그리면 안 됩니다.
 *   4. **시스템은 판정하지 않는다.** 조작 신호는 표시만 하고 점수를 안 깎습니다.
 *
 * 서버가 이미 이 규칙에 맞는 값을 내려보냅니다. 화면이 그걸 **다시 정렬하거나
 * 반올림하면서** 규칙을 깨는 게 흔한 사고라, 그 지점을 테스트로 막습니다.
 */

/** 서버 `CategoryOut` 과 같은 모양. */
export interface Category {
  category: string;
  raw: number;
  team_share: number;
  weight: number;
  event_count: number;
  evidence_ids: number[];
}

export interface IntegrityFlag {
  code?: string;
  message?: string;
  detail?: Record<string, unknown>;
}

export interface MeasurementGap {
  category?: string;
  reason?: string;
  detail?: Record<string, unknown>;
}

/** 서버 `MemberScoreOut` 과 같은 모양. */
export interface MemberScore {
  user_id: number;
  role: string;
  share: number;
  range_low: number;
  range_high: number;
  confidence: number;
  confidence_label: string;
  confidence_reasons: string[];
  categories: Category[];
  integrity_flags: IntegrityFlag[];
  measurement_gaps?: MeasurementGap[];
}

/** 서버 `ScoreOut` 과 같은 모양. */
export interface TeamScore {
  algo_version: string;
  computed_at: string;
  members: MemberScore[];
  skipped_categories: string[];
  notice: string;
}

/** 이름을 붙이려면 팀원 명단이 필요하다. 서버 점수에는 user_id 만 있다. */
export interface Person {
  user_id: number;
  name: string;
}

export const CATEGORY_LABEL: Record<string, string> = {
  code: '코드',
  review: '리뷰',
  meeting: '회의',
  task: '업무',
  document: '문서',
  design: '디자인',
  planning: '기획',
};

export function describeCategory(category: string): string {
  return CATEGORY_LABEL[category] ?? category;
}

/**
 * ⭐ **점수로 정렬하지 않는다.**
 *
 * 정렬은 순위다. 리더보드를 안 그려도 목록이 점수 순이면 사람들은 1등과
 * 꼴찌를 읽습니다 — `docs/07` E2 가 금지하는 건 위젯이 아니라 그 읽기입니다.
 *
 * 이름 순으로 둡니다. 매번 같은 자리에 있어야 "지난주보다 내가 내려갔다" 를
 * 자리로 읽지 않습니다. 이름이 같으면 user_id 로 갈라 순서를 고정합니다 —
 * 순서가 흔들리면 그것도 변화로 읽힙니다.
 */
export function orderForDisplay(
  members: readonly MemberScore[],
  people: readonly Person[],
): MemberScore[] {
  const name = (m: MemberScore): string => nameOf(m.user_id, people);
  return [...members].sort((a, b) => {
    const byName = name(a).localeCompare(name(b), 'ko');
    return byName !== 0 ? byName : a.user_id - b.user_id;
  });
}

export function nameOf(userId: number, people: readonly Person[]): string {
  return people.find((p) => p.user_id === userId)?.name ?? `사용자 #${userId}`;
}

/**
 * 구간 문구. **단일 점수를 만들지 않는다.**
 *
 * `share` 하나만 보여주면 그 숫자가 사실처럼 보입니다. 실제로는 추정이고,
 * 신뢰도가 낮을수록 구간이 넓어집니다 — 그 넓이가 "이 값을 얼마나 믿을 수
 * 있는가" 를 말해 주는 유일한 표현입니다.
 */
export function describeRange(member: MemberScore): string {
  const low = Math.round(member.range_low);
  const high = Math.round(member.range_high);
  if (low === high) return `${low}%`;
  return `${low}~${high}%`;
}

/**
 * 구간 막대의 위치와 폭 (0~100 백분율).
 *
 * 폭을 최소 1% 로 잡습니다. 0 이면 막대가 사라져서 **구간이 아예 없는 것처럼**
 * 보이는데, 구간이 좁은 것과 구간이 없는 것은 다릅니다.
 */
export function rangeBar(member: MemberScore): { left: number; width: number } {
  const low = clamp(member.range_low, 0, 100);
  const high = clamp(member.range_high, 0, 100);
  const left = Math.min(low, high);
  return { left, width: Math.max(Math.abs(high - low), 1) };
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * 이 사람의 숫자를 읽기 전에 알아야 할 것들.
 *
 * 신뢰도 라벨만 띄우면 "낮음" 이 무슨 뜻인지 알 수 없습니다. 서버가 이유를
 * 문장으로 주므로 그대로 보여줍니다. 측정 불가는 **맨 앞**에 둡니다 —
 * 그게 이 숫자를 얼마나 믿을지 결정하는 가장 큰 요인입니다.
 */
export function readBeforeTheNumber(member: MemberScore): string[] {
  const lines: string[] = [];

  for (const gap of member.measurement_gaps ?? []) {
    const category = gap.category ? describeCategory(gap.category) : '일부 활동';
    // ⚠️ "0" 이라고 쓰지 않는다. 측정하지 못한 것과 하지 않은 것은 다르다.
    lines.push(
      `${category} 기여를 **측정하지 못했습니다** — ${gap.reason ?? '사유 미기록'}. ` +
        '0 으로 계산하지 않고 나머지 활동으로 추정했습니다.',
    );
  }

  lines.push(...member.confidence_reasons);
  return lines;
}

/**
 * 조작 신호. **점수를 깎지 않는다.**
 *
 * 시스템이 사람을 판정하지 않는다는 원칙(docs/05 §5)입니다. 신호를 근거로
 * 자동 감점하면 그 판정에 사람이 이의를 제기할 곳이 없습니다. 표시만 하고,
 * 판단은 팀이 합니다.
 */
export function integrityNotes(member: MemberScore): string[] {
  return member.integrity_flags
    .map((f) => f.message ?? f.code ?? '')
    .filter((text) => text !== '');
}

/**
 * 팀 전체에 대해 화면 맨 위에 띄울 경고.
 *
 * 개인 카드에만 적으면 자기 것만 보고 넘어갑니다. **팀의 절반이 측정 불가면
 * 그건 개인 사정이 아니라 이 수치 전체를 못 믿는다는 뜻**이라, 위에서 한 번
 * 말해야 합니다.
 */
export function teamWarnings(score: TeamScore, people: readonly Person[]): string[] {
  const warnings: string[] = [];

  if (score.members.length === 0) {
    return ['아직 기여도를 계산할 활동 기록이 없습니다.'];
  }

  const unmeasured = score.members.filter((m) => (m.measurement_gaps ?? []).length > 0);
  if (unmeasured.length > 0) {
    const names = unmeasured.map((m) => nameOf(m.user_id, people)).join(', ');
    warnings.push(
      `${names} 님은 일부 활동을 측정하지 못했습니다. ` +
        '그 영역은 0 이 아니라 나머지 활동으로 추정한 값입니다.',
    );
  }

  const shaky = score.members.filter((m) => m.confidence < LOW_CONFIDENCE);
  if (shaky.length === score.members.length) {
    warnings.push(
      '팀 전원의 신뢰도가 낮습니다. 이 수치로 서로를 비교하지 마세요 — ' +
        '연결되지 않은 데이터가 무엇인지 먼저 확인해야 합니다.',
    );
  }

  if (score.skipped_categories.length > 0) {
    const skipped = score.skipped_categories.map(describeCategory).join(', ');
    warnings.push(`${skipped} 활동은 이번 계산에서 빠졌습니다.`);
  }

  return warnings;
}

export const LOW_CONFIDENCE = 0.6;

/**
 * 이 사람의 점수를 구성한 활동. 값이 0 인 카테고리는 **버리지 않는다.**
 *
 * 빼 버리면 "이 사람은 리뷰를 안 했다" 가 화면에서 사라집니다. 그건 팀이
 * 이야기해야 할 것이지 숨길 것이 아닙니다. 다만 정렬은 가중치 순 — 이
 * 역할에서 무엇이 중요한지를 먼저 보여줍니다.
 */
export function categoriesForDisplay(member: MemberScore): Category[] {
  return [...member.categories].sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.category.localeCompare(b.category);
  });
}

/** 근거가 하나도 없는 숫자인가. 있으면 화면이 그렇게 말해야 한다. */
export function hasNoEvidence(member: MemberScore): boolean {
  return member.categories.every((c) => c.event_count === 0);
}
