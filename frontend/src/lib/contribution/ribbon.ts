/**
 * 기여도 리본 — **얼마나 알고 있나**를 한 줄로. (결함 247)
 *
 * ## ⛔ 이 파일이 생긴 이유
 *
 * 리본 조각을 만드는 코드가 **화면 안에**(`webapp/src/screens/Contributions.tsx`)
 * 있었습니다. 그래서 이 저장소의 제일 무거운 불변식이 걸린 자리인데
 * **가드가 한 번도 안 울렸습니다.**
 *
 * 재 보니 세 사람의 리본이 같은 자에서 출발했습니다:
 *
 *     1440px  세 축의 left 가 전부 273.00 · 파랑 끝도 셋 다 44.60%
 *              빗금 꼬리 끝만 67.97% / 62.84% / 58.36%
 *     900px   세 축이 201→731 로 **픽셀까지 동일**
 *
 * 그리고 그 꼬리 길이는 우연이 아니라 **구조적으로 기여도 순위**였습니다.
 * `confidence` 는 팀당 한 번 계산되는 상수이고(`scoring.py`), 폭은
 * `spread = share × (1 − confidence) × 0.5` 이므로
 *
 *     꼬리 끝 = c + s(1 − c)/100        (c 가 상수인 한 s 에 대해 순증가)
 *
 * 즉 **같은 축 위에 세로로 쌓인 막대그래프**였고, 그건 곧 순위표입니다
 * (AGENTS.md 불변식 ①). 이 규칙을 어긴 것이 세 번째입니다.
 *
 * ## 지금 그리는 것
 *
 * 리본은 **언제나 가득 찹니다.** 길이는 사람마다 같고, **나뉘는 자리만**
 * 다릅니다 — 왼쪽은 확신한 만큼, 오른쪽은 모르는 만큼(빗금).
 *
 *     [■■■■■■■■│////////////////]   확신 45% · 나머지는 모르는 것
 *
 * 길이가 같으니 **길이를 견줄 수 없고**, 그래서 순위가 안 생깁니다.
 * 값(구간 `30~54%` · 모르는 폭 `25%p`)은 **글자로** 옆에 섭니다 —
 * 「값은 글자로, 그림은 폭이나 개수만」.
 *
 * ⚠️ 눈금(0/25/50/75/100)도 같이 걷었습니다. 눈금이 서면 그 축은 사람들이
 * 공유하는 **측정 자**가 되고, 게다가 그 자 위에 단위가 둘 앉아 있었습니다
 * (파랑은 확신도 0~1, 빗금 폭은 기여도 %p).
 */

/** 조각의 뜻. 화면 컴포넌트(`TrackRibbon`)의 것과 같은 낱말입니다. */
export type RibbonKind = 'known' | 'unknown' | 'empty';

export interface RibbonPiece {
  /** 0~1 */
  start: number;
  /** 0~1 */
  end: number;
  kind: RibbonKind;
}

/**
 * 이 사람을 얼마나 알고 있나 — 확신한 몫과 모르는 몫.
 *
 * 둘을 더하면 **언제나 1** 입니다. 사람마다 리본 길이가 같아야 길이를
 * 견주는 일이 안 생깁니다.
 *
 * ⚠️ 확신도가 0 이면 리본은 통째로 빗금입니다 — 「아무것도 모른다」는
 * 0점이 아니라 **모르는 것**이고, 그 말을 그림이 해야 합니다.
 */
export function confidenceRibbon(confidence: number): RibbonPiece[] {
  const known = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0;
  const pieces: RibbonPiece[] = [];
  if (known > 0) pieces.push({ start: 0, end: known, kind: 'known' });
  if (known < 1) pieces.push({ start: known, end: 1, kind: 'unknown' });
  return pieces;
}

/** 낭독기에 읽힐 한 줄. 그림이 말하는 것과 **같은 것**을 말합니다. */
export function describeRibbon(name: string, confidence: number): string {
  const known = Math.round(Math.min(1, Math.max(0, confidence)) * 100);
  if (known === 0) return `${name} — 아직 아무것도 확인하지 못했습니다`;
  return `${name} — 확신한 몫 ${known}%, 나머지 ${100 - known}%는 모르는 것입니다`;
}
