/**
 * 발언 유형을 사람 말로 (요구사항 정의서 §10).
 *
 * ## ⚠️ 이것은 **두 벌 중 한 벌**입니다
 *
 * 원본은 `backend/teamflow/db/vocab.py` 의 `UTTERANCE_LABEL` 입니다.
 * 런타임이 달라 어쩔 수 없이 두 벌인데, `test_repo_integrity.py` 의 교차
 * 검사가 값이 갈라지면 터집니다 (`STATUS_LABEL` 과 같은 방식).
 *
 * ⚠️ 그러니 **여기만 고치지 마십시오.** 한쪽만 고치면 서버는 `반대 의견`
 * 이라 부르고 화면은 다른 말을 하게 됩니다.
 *
 * ## ⚠️ 여기에 **사람별 집계가 없습니다**
 *
 * 유형별로 세는 것은 회의 단위입니다. 사람별로 세면 그 순간
 * "누가 제일 많이 제안했나" 표가 만들어지고, 그건 이 저장소가 금지한
 * 리더보드입니다 (`AGENTS.md` 불변식 1). `REVIEW-005` 를 사람별로
 * 만들려는 사람은 그 불변식을 먼저 읽으십시오.
 */

/** 서버의 `UTTERANCE_LABEL` 과 짝. */
export const TYPE_LABEL: Record<string, string> = {
  question: '질문',
  proposal: '제안',
  answer: '정보 제공',
  agreement: '동의',
  objection: '반대 의견',
  refinement: '보완 의견',
  decision: '결정',
  request: '업무 요청',
  commitment: '일정 약속',
  confirmation: '확인 요청',
  opinion: '의견',
  social: '맞장구',
  other: '기타',
};

/**
 * 화면에 늘어놓을 순서.
 *
 * ⚠️ **찬반 셋을 붙여 둡니다** — `REVIEW-005` 가 "동의 수 · 반대 의견 수"
 * 를 요구하는데, 셋이 나란히 있으면 그 자체로 답이 됩니다. 따로 한 줄을
 * 더 뽑았다가 **같은 값이 두 줄로 나와서** 걷어냈습니다(두 벌).
 *
 * ⚠️ **건수 순으로 세우지 않습니다.** 건수 순이면 회의마다 자리가 바뀌고,
 * 맨 위가 "제일 중요한 것" 으로 읽힙니다. 회의가 흘러가는 모양대로
 * 고정합니다 — 묻고, 답하고, 제안하고, 찬반이 갈리고, 정하고, 맡습니다.
 */
export const TYPE_ORDER: readonly string[] = [
  'question',
  'answer',
  'proposal',
  'agreement',
  'objection',
  'refinement',
  'opinion',
  'decision',
  'request',
  'commitment',
  'confirmation',
  'social',
  'other',
];

/** 점수가 0인 라벨. 화면은 이것을 **흐리게** 그립니다. */
export const ZERO_SCORE: readonly string[] = ['social', 'other'];

/** 모르는 값은 지어내지 않습니다. */
export function describeType(type: string | null): string | null {
  if (type === null || type === '') return null;
  return TYPE_LABEL[type] ?? type;
}

export interface TypeCount {
  type: string;
  label: string;
  count: number;
  /** 점수에 안 들어가는 것인가. 화면이 흐리게 그립니다. */
  zero: boolean;
}

/**
 * 서버가 준 유형별 건수를 화면 순서대로.
 *
 * ⚠️ **순서는 `TYPE_ORDER` 고정**이고 0건도 빼지 않습니다. 0건을 빼면
 * "이 회의에는 반대가 하나도 없었다" 가 **안 보입니다.** 그건 회의에
 * 대해 말해 주는 것이 많은 사실입니다 — 아무도 반대하지 않은 회의와
 * 반대를 세지 않은 회의는 다릅니다.
 *
 * ⚠️ 입력은 서버의 `labels` 를 **그대로** 받습니다. 화면이 발화 목록을
 * 받아서 직접 세는 모양이었으면 대본 전체를 떠 와야 하고, 그러면
 * "근거만 준다" 는 엔드포인트의 약속이 깨집니다.
 */
export function typeCounts(labels: Readonly<Record<string, number>>): TypeCount[] {
  // 모르는 값이 왔으면 뒤에 붙입니다 — 버리면 합이 안 맞습니다.
  const extra = Object.keys(labels)
    .filter((t) => !TYPE_ORDER.includes(t))
    .sort();

  return [...TYPE_ORDER, ...extra].map((type) => ({
    type,
    label: TYPE_LABEL[type] ?? type,
    count: labels[type] ?? 0,
    zero: ZERO_SCORE.includes(type),
  }));
}

/**
 * 아직 분류하지 않은 발화가 있으면 그렇게 말한다.
 *
 * ⚠️ **이걸 0건과 섞으면 안 됩니다.** 분류 전과 "모르겠음"(`other`)은
 * 다릅니다 — 앞은 아직 안 잰 것이고 뒤는 재고 나서 모르는 것입니다.
 * 안 재고 0으로 그리면 불변식 3(측정 불가 ≠ 0점)을 어깁니다.
 */
export function pendingNote(unclassified: number, total: number): string | null {
  if (unclassified <= 0) return null;
  if (unclassified >= total) return '아직 분류하지 않았습니다 — 분석이 끝나면 나옵니다.';
  return `${unclassified}건은 아직 분류 전입니다 — 아래 숫자에 안 들어 있습니다.`;
}
