/**
 * 누가 얼마나 말했는가 — 화면에 어떻게 적을 것인가
 * (요구사항 정의서 §9 `AI-AUDIO-005` · §12 `AI-REVIEW-007`).
 *
 * ## ⚠️ 이 화면이 이 제품에서 제일 위험합니다
 *
 * 정의서의 예시가 이렇게 생겼습니다.
 *
 *     윤식 32% / 민수 27% / 지연 25% / 철수 16%
 *
 * **내림차순으로 늘어놓은 그 모양이 곧 리더보드입니다.** 같은 문서의
 * `AI-REVIEW-007` 과 `NFR-005` 가 그걸 금지합니다 — 요구는 **값을
 * 만들라**는 것이지 **줄을 세우라**는 것이 아닙니다 (`docs/20` §3).
 *
 * 그래서 화면에서 셋을 지킵니다.
 *
 * 1. **다시 정렬하지 않습니다.** 서버가 이름 순으로 줍니다
 * 2. **막대를 안 그립니다.** 값을 같은 축 위에 폭으로 늘어놓으면 그게 곧
 *    순위표입니다 — 이 저장소가 두 번 어긴 규칙입니다. 값은 **글자로**
 * 3. **기여도가 아니라고 화면이 말합니다.** 안 적으면 사람은 이 숫자를
 *    성적으로 읽습니다
 */

export interface Share {
  user_id: number;
  name: string;
  speaking_ms: number;
  /** ⚠️ 못 잰 회의는 `null` 입니다 — **0 이 아닙니다.** */
  ratio: number | null;
}

export interface Speaking {
  shares: Share[];
  measurable: boolean;
  skewed: boolean;
}

/**
 * 한 사람의 몫을 글자로.
 *
 * ⚠️ **못 잰 것은 `0%` 라고 쓰지 않습니다.** 그건 "한마디도 안 했다" 로
 * 읽히는데 실제로는 잴 것이 없었던 것입니다 (결함 121 이 정확히 그것).
 */
export function shareText(share: Share): string {
  if (share.ratio === null) return '잴 수 없음';
  const minutes = Math.round(share.speaking_ms / 60000);
  return `${Math.round(share.ratio * 100)}% · ${minutes}분`;
}

/**
 * 이 회의에서 비중을 말할 수 있는가. 못 하면 그 이유.
 *
 * ⚠️ **빈 칸으로 두지 않습니다.** 아무것도 안 그리면 사람은 "고장" 으로
 * 읽거나, 더 나쁘게는 "다들 말을 안 했다" 로 읽습니다.
 */
export function notMeasurableText(speaking: Speaking): string | null {
  if (speaking.measurable) return null;
  const spoke = speaking.shares.some((s) => s.speaking_ms > 0);
  if (!spoke) {
    return '아직 발언이 분석되지 않아 비중을 잴 수 없습니다.';
  }
  return '회의가 짧아 비중을 말하기 어렵습니다 — 짧은 회의의 비율은 경향으로 읽으면 안 됩니다.';
}

/**
 * 쏠렸을 때 할 말.
 *
 * ⚠️ **누가인지 안 적습니다.** 서버가 안 보내기도 하지만, 보내더라도
 * 적으면 안 됩니다 — 그 순간 "이 회의를 독점한 사람" 표시가 됩니다.
 *
 * ⚠️ **나무라지 않습니다.** 회의에는 발제하는 사람이 있고 그 사람이 많이
 * 말하는 것은 정상입니다. 사실만 적고 판단은 팀이 합니다.
 */
export function skewText(speaking: Speaking): string | null {
  if (!speaking.measurable || !speaking.skewed) return null;
  return '한 사람이 회의의 절반 이상을 말했습니다. 발제하는 자리였다면 자연스러운 모습입니다.';
}

/**
 * 목록 옆에 반드시 붙는 말.
 *
 * ⚠️ 이 한 줄이 빠지면 사람은 이 숫자를 **성적**으로 읽습니다.
 * `docs/05` §5 가 "총 발언 시간 = 점수 아님(참고 표시만)" 으로 정해 뒀고,
 * 정의서 `AI-REVIEW-007` 도 같은 말을 합니다.
 */
export const SHARE_NOTE =
  '말한 시간입니다. **기여도가 아닙니다** — 많이 말한 것이 많이 한 것은 아닙니다.';

/**
 * 그릴 순서.
 *
 * ⚠️ **서버가 준 순서 그대로입니다.** 여기서 정렬하면 그 순간 순위가
 * 됩니다. 이 함수가 하는 일은 "정렬하지 않는다" 를 **눈에 보이게**
 * 하는 것뿐입니다 — 다음 사람이 `.sort()` 를 넣고 싶어질 때 여기서
 * 막힙니다.
 */
export function inGivenOrder(shares: readonly Share[]): Share[] {
  return [...shares];
}
