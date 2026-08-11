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
  /** 역할 비중. 겸직이면 둘 이상이 들어 있다. */
  role_shares?: Record<string, number>;
}

/**
 * 서버 `contribution/events.py` 의 `Category` 와 **정확히 같아야 한다.**
 *
 * ⚠️ 어긋나 있었습니다. 이 표에는 서버가 만들지 않는 `review`·`design`·
 * `planning` 이 있었고, 서버가 실제로 보내는 `schedule`·`peer` 가 없었습니다.
 * `describeCategory` 는 모르는 값을 **그대로 돌려주므로** 예외도 경고도
 * 없이 한글 화면에 영어 식별자가 찍혔습니다.
 *
 *     "schedule, peer 활동은 이번 계산에서 빠졌습니다."
 *
 * 성적으로 이어질 수 있는 화면에서, 학생이 자기 점수에서 무엇이 빠졌는지
 * 읽을 수 없는 상태였습니다. 세 역할 프로파일 전부가 `schedule`·`peer` 에
 * 0.10~0.15 가중치를 주므로 무시해도 되는 곁가지도 아닙니다.
 *
 * 어긋나면 `backend/tests/test_repo_integrity.py` 가 잡습니다 — 두 곳에
 * 적어 두면 반드시 갈라지므로, 갈라진 것을 잡는 쪽을 택했습니다.
 */
export const CATEGORY_LABEL: Record<string, string> = {
  task: '업무',
  code: '코드',
  meeting: '회의',
  document: '문서',
  schedule: '일정 준수',
  peer: '동료 평가',
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

/*
 * ⚠️ `rangeBar()` 를 **지웠습니다.**
 *
 * 구간의 절대 위치(`left`)와 폭을 주던 함수인데, 화면이 위치를 그리지
 * 않기로 하면서 부르는 곳이 0곳이 됐습니다 (아래 `uncertaintySpans` 참고).
 *
 * 처음에는 "다시 그릴 일이 생기면 여기 있습니다" 라며 남겨 뒀습니다.
 * `guards.test.ts` 의 "lib 의 export 를 화면이 실제로 부른다" 가 그걸
 * 잡았고, 그 판단이 맞습니다 — 이 저장소의 대표 결함이 **만들어 놓고
 * 아무도 안 부르는 것**이고, "나중에 쓸지도" 는 그 결함을 남겨 두는
 * 가장 흔한 변명입니다. 필요해지면 그때 다시 씁니다. git 이 기억합니다.
 */

/** 한 사람의 "얼마나 모르는가". */
export interface UncertaintySpan {
  userId: number;
  /** 구간의 폭 (%p). 클수록 덜 안다 */
  points: number;
  /** 팀에서 가장 넓은 구간 대비 (0~100). 막대 길이로 쓴다 */
  ratio: number;
}

/**
 * 구간의 **폭**만 뽑는다 — 값이 아니라 **우리 측정의 불확실성**.
 *
 * ## 이 막대가 비교하는 것은 사람이 아닙니다
 *
 * 길이가 긴 사람은 "기여가 큰 사람" 이 아니라 **"우리가 가장 모르는
 * 사람"** 입니다. 그래서 이 그림은 팀을 줄 세우지 않고, 오히려 어디를
 * 더 재야 하는지를 가리킵니다.
 *
 * ⚠️ 길이는 **팀에서 가장 넓은 구간** 기준입니다. 0~100 을 쓰면 폭 12%p 와
 * 20%p 가 둘 다 짧은 막대가 되어 차이가 안 보입니다 — 그러면 그릴 이유가
 * 없습니다.
 *
 * ⚠️ 전원이 폭 0 이면(완전히 확정된 이상적인 경우) **전부 0** 을 돌려
 * 줍니다. 그때 100 을 주면 "다 모른다" 로 보이는데 정반대입니다.
 */
export function uncertaintySpans(members: readonly MemberScore[]): UncertaintySpan[] {
  const points = members.map((m) => Math.abs(clamp(m.range_high, 0, 100) - clamp(m.range_low, 0, 100)));
  const widest = Math.max(0, ...points);
  return members.map((member, i) => ({
    userId: member.user_id,
    points: points[i] ?? 0,
    ratio: widest === 0 ? 0 : Math.round(((points[i] ?? 0) / widest) * 100),
  }));
}

/**
 * 모르는 폭을 **셀 수 있는 점**으로 (docs/19 §25).
 *
 * ## 왜 막대가 아니라 점인가
 *
 * 불확실성 시각화 연구(CHI 2016·2018, 그리고 임상 5포맷 비교)가 한결같이
 * 말하는 것은 **빈도 표현(frequency framing)이 연속 표현보다 정확하게
 * 읽힌다**는 것입니다. 사람은 길이를 눈대중하는 것보다 개수를 세는 쪽을
 * 훨씬 잘합니다.
 *
 * ## ⚠️ 그런데 quantile dotplot 을 그대로 가져오지 않았습니다
 *
 * 원래 형태는 **값 축 위에** 점을 뿌립니다. 이 화면에서 그러면 세 사람의
 * 점이 같은 0~100 축에 세로로 정렬되고, 그건 이 저장소가 이미 두 번
 * 걷어낸 **순위표**입니다 (기여도 막대의 절대 위치 · 카테고리 막대).
 * 게다가 우리에게는 분포가 없습니다 — 구간의 양 끝뿐이라, 점을 뿌리려면
 * **분포 모양을 지어내야** 합니다. 그건 이 저장소가 금지한 것입니다.
 *
 * 그래서 연구가 말하는 **기제**만 가져왔습니다: 값을 **세어지는 양**으로
 * 바꾸되, 위치가 아니라 **개수**로만 씁니다.
 *
 *     점 하나 = 4%p 의 "모름"
 *
 * ⚠️ 예전 막대는 **팀에서 가장 넓은 구간 대비** 길이였습니다. 그러면
 * 같은 20%p 라도 팀 구성에 따라 길이가 달라지고, 긴 막대가 "남보다 더
 * 모른다" 로 읽힙니다. 점은 **절대량**입니다 — 다섯 개면 20%p 이고,
 * 옆 사람이 몇 개든 상관없습니다.
 */
export const POINTS_PER_DOT = 4;

/** 한 줄에 그릴 점 개수. 0 이면 그릴 것이 없다는 뜻입니다. */
export function uncertaintyDots(points: number): number {
  if (!Number.isFinite(points) || points <= 0) return 0;
  // ⚠️ **0 으로 내림하지 않습니다.** 폭이 1%p 라도 "모르는 게 있다" 는
  // 사실이고, 점이 0 개면 화면에서 그것이 **완전히 확정** 으로 보입니다.
  // 반올림 대신 올림인 이유가 그것입니다.
  const dots = Math.ceil(points / POINTS_PER_DOT);
  // 한 줄에 스물다섯이면 100%p — 그보다 넓을 수 없습니다(구간이 0~100).
  return Math.min(dots, Math.ceil(100 / POINTS_PER_DOT));
}

/** 점 개수를 사람 말로. 화면이 숫자를 지어내지 않게 여기서 만듭니다. */
export function uncertaintyDotsNote(points: number): string {
  const dots = uncertaintyDots(points);
  if (dots === 0) return '구간이 없습니다 — 이 값은 확정적입니다';
  return `모르는 폭 ${Math.round(points)}%p · 점 하나가 ${POINTS_PER_DOT}%p`;
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
        '0으로 계산하지 않고 나머지 활동으로 추정했습니다.',
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
        '그 영역은 0이 아니라 나머지 활동으로 추정한 값입니다.',
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

/**
 * 카드에 적을 역할.
 *
 * ⚠️ 서버의 `role` 은 **주 역할 하나**입니다. `blended_profile` 이
 * `max(shares)` 로 고르는데, 개발 50% · 기획 50% 처럼 **동률이면 어느
 * 쪽이 나올지 사전 순에 달립니다.** 그러면 같은 비중을 가진 두 사람이
 * 서로 다른 이름표를 답니다.
 *
 * 더 나쁜 건 절반만 말한다는 것입니다. 기획 60% · 개발 40% 인 사람의
 * 카드에 `planner` 만 적히면, 그 사람의 코드 활동이 왜 가중치가 낮은지
 * 읽을 수 없습니다. 가중치를 정한 값 그대로 보여 줍니다.
 *
 * 비중을 모르면(명단을 못 받은 경우) 서버가 준 주 역할을 그대로 씁니다 —
 * **지어내지 않습니다.**
 */
const ROLE_NAMES: Record<string, string> = {
  developer: '개발',
  planner: '기획',
  designer: '디자인',
};

/**
 * 역할의 한국어 이름.
 *
 * ⚠️ 역할 설정 화면은 &#34;개발/기획/디자인&#34; 이라고 쓰는데 기여도 카드는
 * `developer` 라고 썼습니다. **같은 개념을 두 이름으로 부르면** 사람은
 * 그게 같은 것인지 확신하지 못합니다.
 *
 * 모르는 값은 **그대로 돌려줍니다.** 서버가 역할을 하나 더 만들었는데
 * 화면이 모르면, 지어낸 한국어보다 영어 식별자가 정직합니다 —
 * `describeCategory` 와 같은 규칙입니다.
 */
export function roleLabel(key: string): string {
  return ROLE_NAMES[key] ?? key;
}

export function roleOf(member: MemberScore, people: Person[]): string {
  const shares = people.find((p) => p.user_id === member.user_id)?.role_shares;
  const named = Object.entries(shares ?? {}).filter(([, v]) => v > 0);
  if (named.length === 0) return roleLabel(member.role);
  if (named.length === 1) return roleLabel(named[0]?.[0] ?? member.role);

  return named
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => `${roleLabel(key)} ${Math.round(value * 100)}%`)
    .join(' · ');
}
