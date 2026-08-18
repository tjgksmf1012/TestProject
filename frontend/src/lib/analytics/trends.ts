/**
 * 회의 개선 추세 (`REVIEW-006`) 를 사람 말로.
 *
 * ## ⚠️ 서버는 숫자만 줍니다
 *
 * 위험 신호와 같은 규칙입니다 — 문장은 전부 여기서 만들고, 그래서 전부
 * 테스트됩니다. 서버가 주는 것은 종류·앞쪽 절반 평균·최근 절반 평균·
 * 방향뿐이고, **회의별 값·회의 제목은 오지 않습니다** — 어느 회의였는지
 * 짚는 순간 회의 순위표가 됩니다.
 *
 * ## ⚠️ "좋아졌다" 라고 쓰지 않습니다
 *
 * 줄었다·늘었다는 관찰이고 좋다·나쁘다는 판정입니다. 반복 논의가 준 것이
 * 곧 좋은 회의라는 보장은 시스템이 할 말이 아닙니다 (불변식 4).
 */

import { describeFindingKind } from '../review/findings.ts';

export interface KindTrend {
  kind: string;
  early_avg: number;
  late_avg: number;
  /** 'falling' | 'rising' | 'flat' */
  direction: string;
}

export interface MeetingTrends {
  measurable: boolean;
  meetings_counted: number;
  needed: number;
  kinds: KindTrend[];
}

export const TRENDS_NOTE =
  '팀 단위 관찰입니다 — 어느 회의였는지는 일부러 싣지 않습니다.';

/**
 * 못 재는 이유. ⚠️ 흙빛으로 그릴 것 — 회의가 적은 것은 잘못이 아닙니다.
 */
export function notMeasurableText(trends: MeetingTrends): string {
  return (
    `분석된 회의가 ${trends.meetings_counted}개라 추세를 말하기 어렵습니다 — ` +
    `${trends.needed}개는 쌓여야 방향이 보입니다`
  );
}

const DIRECTION: Record<string, string> = {
  falling: '줄고 있습니다',
  rising: '늘고 있습니다',
  flat: '비슷합니다',
};

/**
 * 종류 이름은 검토 화면과 **같은 한 벌**(`describeFindingKind`)을 쓰되,
 * `unanswered_question` 만 여기서 보탭니다 — 그 값은 검토 화면의
 * `findings` 에는 일부러 없고(서버가 `unresolved_issues` 로 따로 보냄)
 * 추세에는 옵니다. 저쪽 표에 더하면 저쪽 가드가 막습니다 — 맞는 일입니다.
 */
const EXTRA_TITLE: Record<string, string> = { unanswered_question: '미응답 질문' };

function kindTitle(kind: string): string {
  return EXTRA_TITLE[kind] ?? describeFindingKind(kind);
}

/** `반복 논의 — 회의당 2건 → 0건, 줄고 있습니다` */
export function trendLine(trend: KindTrend): string {
  // 모르는 방향은 코드 그대로 — 조용히 "비슷" 으로 그리면 서버가 새
  // 방향을 만들었을 때 화면이 거짓말을 시작합니다.
  const direction = DIRECTION[trend.direction] ?? trend.direction;
  return (
    `${kindTitle(trend.kind)} — 회의당 ${countText(trend.early_avg)} → ` +
    `${countText(trend.late_avg)}, ${direction}`
  );
}

function countText(avg: number): string {
  return `${Number.isInteger(avg) ? String(avg) : avg.toFixed(1)}건`;
}

/**
 * 잰 회의 전부에서 아무것도 안 걸렸는가.
 *
 * 그때는 종류마다 `0건 → 0건, 비슷합니다` 를 다섯 줄 늘어놓는 대신 한
 * 줄로 말합니다 — 다섯 줄의 0 은 정보가 아니라 소음입니다.
 */
export function allQuiet(kinds: readonly KindTrend[]): boolean {
  return kinds.every((kind) => kind.early_avg === 0 && kind.late_avg === 0);
}

export const QUIET_TEXT = '분석된 회의들에서 눈에 띈 구간이 없었습니다';
