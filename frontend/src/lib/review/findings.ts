/**
 * 비효율 구간을 사람 말로 (요구사항 정의서 §12 · `REVIEW-003`).
 *
 * ## ⚠️ 이것은 **관찰이지 판정이 아닙니다**
 *
 * 규칙 기반 추정입니다(`meeting/inefficiency.py`). 틀립니다. 그래서
 * 화면은 세 가지를 지킵니다.
 *
 * 1. **등급을 안 매깁니다.** 빨강·노랑이 없습니다. 서버도 `severity` 를
 *    안 보냅니다 — 회의를 빨갛게 칠하는 순간 **팀에 대한 판정**으로
 *    읽힙니다 (`AGENTS.md` 불변식 4).
 * 2. **왜 걸렸는지 적습니다.** 겹친 낱말, 떨어진 시간. 근거 없는 지적은
 *    반박할 수 없고, 반박할 수 없으면 잔소리입니다.
 * 3. **근거 발화를 열 수 있습니다.** 이 저장소의 대표 실패 ③ 이
 *    "할 일을 알려 주고 그 일을 할 자리를 안 줌" 입니다.
 *
 * ## ⚠️ 사람 이름이 여기 없습니다
 *
 * 서버가 화자를 안 보냅니다. 보내면 화면이 그걸로 "누가 회의를 늘어지게
 * 했는가" 를 만들 수 있습니다.
 */

/** 서버가 주는 한 건 (`GET /api/meetings/{id}` 의 `findings`). */
export interface Finding {
  kind: string;
  start_ms: number;
  end_ms: number;
  evidence_utterance_ids: number[];
  detail: Record<string, unknown>;
}

/** 화면에 그릴 한 줄. */
export interface FindingView {
  kind: string;
  /** `반복 논의` — 모르는 종류면 코드를 그대로 씁니다. */
  title: string;
  /** 무엇을 뜻하는지 한 줄. 모르는 종류면 `null`. */
  what: string | null;
  /** 왜 걸렸는가. 못 만들면 `null` — **지어내지 않습니다.** */
  why: string | null;
  /** `12:30 ~ 25:10`. 근거가 없어 시각이 0이면 `null`. */
  at: string | null;
  evidence: number[];
}

const TITLE: Record<string, string> = {
  repeated_discussion: '반복 논의',
  topic_drift: '주제 이탈',
  incomplete_task: '미완성 업무',
  decision_conflict: '결정 번복',
  unanswered_question: '답이 안 난 것',
};

/**
 * 무엇을 뜻하는가.
 *
 * ⚠️ **"비효율적입니다" 라고 쓰지 않습니다.** 무슨 일이 있었는지만
 * 적고, 그게 문제인지는 팀이 정합니다.
 */
const WHAT: Record<string, string> = {
  repeated_discussion: '같은 화제가 한참 뒤에 다시 나왔습니다',
  topic_drift: '본줄기에서 잠깐 벗어났다가 돌아왔습니다',
  incomplete_task: '약속은 있는데 업무 후보로 이어지지 않았습니다',
  decision_conflict: '앞의 결정을 뒤집었습니다',
};

/** 화면에 늘어놓을 순서. ⚠️ **건수 순이 아닙니다** — 회의마다 자리가 바뀝니다. */
export const KIND_ORDER: readonly string[] = [
  'repeated_discussion',
  'topic_drift',
  'incomplete_task',
  'decision_conflict',
];

/** `750000` → `12:30`. 음수나 0은 `null` — **시각을 지어내지 않습니다.** */
export function atText(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function span(finding: Finding): string | null {
  const from = atText(finding.start_ms);
  const to = atText(finding.end_ms);
  if (from === null) return null;
  return to === null || to === from ? from : `${from} ~ ${to}`;
}

function words(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((w): w is string => typeof w === 'string') : [];
}

/** `1490000` → `24분`. */
function minutes(ms: unknown): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  return `${Math.round(ms / 60000)}분`;
}

/**
 * 왜 걸렸는가.
 *
 * ⚠️ 만들 수 없으면 `null` 입니다. **"알 수 없는 이유로 걸렸습니다" 라고
 * 적지 않습니다** — 그건 아무 말도 안 하는 것보다 나쁩니다.
 */
export function whyText(finding: Finding): string | null {
  const detail = finding.detail ?? {};

  if (finding.kind === 'repeated_discussion') {
    const shared = words(detail.shared_words);
    if (shared.length === 0) return null;
    const apart = minutes(detail.apart_ms);
    const gap = apart === null ? '' : ` — ${apart} 만에`;
    return `${shared.join(' · ')} 얘기가 다시 나왔습니다${gap}`;
  }

  if (finding.kind === 'topic_drift') {
    const off = words(detail.off_topic_words);
    if (off.length === 0) return null;
    return `${off.slice(0, 5).join(' · ')} 얘기를 하는 동안입니다`;
  }

  if (finding.kind === 'incomplete_task') {
    const count = detail.count;
    if (typeof count !== 'number' || count <= 0) return null;
    return `약속 ${count}건이 업무 후보로 안 이어졌습니다`;
  }

  if (finding.kind === 'decision_conflict') {
    // ⚠️ `how` 를 그대로 보여 주지 않습니다 — `supersedes` 는 내부
    //    사정이지 사람이 알 말이 아닙니다 (결함 78·86 과 같은 부류).
    const shared = words(detail.shared_words);
    if (shared.length > 0) return `${shared.join(' · ')}에 대한 결정이 둘입니다`;
    if (detail.how === 'supersedes') return '회의에서 앞의 결정을 뒤집었습니다';
    return null;
  }

  return null;
}

export function findingView(finding: Finding): FindingView {
  return {
    kind: finding.kind,
    title: TITLE[finding.kind] ?? finding.kind,
    what: WHAT[finding.kind] ?? null,
    why: whyText(finding),
    at: span(finding),
    evidence: [...(finding.evidence_utterance_ids ?? [])],
  };
}

/**
 * 그릴 순서대로. ⚠️ **모르는 종류를 버리지 않습니다.**
 *
 * 버리면 탐지기를 하나 더 붙였을 때 화면이 **조용히 아무것도 안 보여
 * 줍니다** — 오류가 안 나서 안 보이는 부류이고, 이 저장소가 여러 번
 * 당한 자리입니다.
 */
export function findingViews(findings: readonly Finding[]): FindingView[] {
  const rank = (kind: string): number => {
    const at = KIND_ORDER.indexOf(kind);
    return at === -1 ? KIND_ORDER.length : at;
  };
  return [...findings]
    .sort((a, b) => rank(a.kind) - rank(b.kind) || a.start_ms - b.start_ms)
    .map(findingView);
}
