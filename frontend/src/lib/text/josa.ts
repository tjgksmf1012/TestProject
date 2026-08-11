/**
 * 한국어 조사를 **값에 맞춰** 고른다.
 *
 * ## 왜 필요한가
 *
 * 화면 문구가 이렇게 적혀 있었습니다.
 *
 *     `${when} 에 확정했습니다 — ${who} 은(는) 시스템 값과 다르게 정했습니다.`
 *     `후보 ${candidate.id} 를 승인할 수 없습니다`
 *     `${formatDuration(ms)} 가 비었습니다`
 *
 * 실제로 화면에 나온 문장은 이랬습니다.
 *
 *     2026. 8. 8. 오후 1:03:30 에 확정했습니다 — 김민수 은(는) …
 *     후보 3 를 승인할 수 없습니다
 *
 * 문제가 둘입니다.
 *
 *   1. **`은(는)` 은 사람이 읽는 글자가 아닙니다.** 미완성 소프트웨어로
 *      읽힙니다. 이 화면은 성적에 쓰일 수 있는 숫자를 보여주는 곳이라,
 *      "대충 만들었구나" 로 읽히면 숫자까지 같이 의심받습니다.
 *   2. **변수 뒤의 조사는 붙여 씁니다.** `김민수 는` 이 아니라 `김민수는`
 *      입니다. 띄우면 조사가 다음 낱말처럼 보입니다.
 *
 * ## 규칙
 *
 * 한글 음절은 유니코드로 계산합니다 — `(코드 − 0xAC00) % 28` 이 0 이 아니면
 * 받침이 있습니다. 숫자는 **읽는 소리**로 정합니다(3=삼 받침 있음,
 * 4=사 받침 없음). 둘 다 정확한 규칙이고 눈으로 고르지 않습니다.
 *
 * ## ⚠️ 로마자로 끝나는 값은 **관례**입니다
 *
 * `PR` 은 "피알"(받침 ㄹ), `API` 는 "에이피아이"(받침 없음)처럼 **읽는
 * 소리**를 따라야 하는데, 그 소리는 글자만 봐서는 정해지지 않습니다.
 * 여기서는 흔히 쓰는 알파벳 읽기표를 씁니다. 관례이므로 틀릴 수 있고,
 * **그래서 화면 문구는 되도록 로마자 뒤에 조사를 두지 않는 쪽**으로
 * 씁니다. 이 함수를 믿고 아무 데나 붙이지 마세요.
 */

/** 고를 조사 쌍. 앞이 **받침 있을 때**입니다. */
export type JosaPair = '은는' | '이가' | '을를' | '과와' | '으로로';

const PAIRS: Record<JosaPair, [string, string]> = {
  은는: ['은', '는'],
  이가: ['이', '가'],
  을를: ['을', '를'],
  과와: ['과', '와'],
  으로로: ['으로', '로'],
};

/** 숫자를 한국어로 읽었을 때 받침이 있는가. 0=영, 1=일, 3=삼, 6=육, 7=칠, 8=팔 */
const DIGIT_HAS_FINAL: Record<string, boolean> = {
  '0': true, // 영
  '1': true, // 일
  '2': false, // 이
  '3': true, // 삼
  '4': false, // 사
  '5': false, // 오
  '6': true, // 육
  '7': true, // 칠
  '8': true, // 팔
  '9': false, // 구
};

/**
 * 알파벳을 한국어로 읽었을 때 받침이 있는가.
 *
 * ⚠️ **관례입니다.** 위 주석 참고.
 */
const LETTER_HAS_FINAL: Record<string, boolean> = {
  a: false, // 에이
  b: false, // 비
  c: false, // 씨
  d: false, // 디
  e: false, // 이
  f: true, // 에프
  g: false, // 지
  h: false, // 에이치
  i: false, // 아이
  j: false, // 제이
  k: false, // 케이
  l: true, // 엘
  m: true, // 엠
  n: true, // 엔
  o: false, // 오
  p: false, // 피
  q: false, // 큐
  r: true, // 알
  s: true, // 에스
  t: false, // 티
  u: false, // 유
  v: false, // 브이
  w: false, // 더블유
  x: true, // 엑스
  y: false, // 와이
  z: false, // 지
};

/**
 * 끝 글자에 받침이 있는가.
 *
 * 판단할 수 없으면 `null` 입니다 — 기호로 끝나거나 빈 문자열일 때입니다.
 * **모르면 모른다고 답합니다.** 아무 쪽이나 고르면 그게 틀린 문장이 됩니다.
 */
export function hasFinalConsonant(word: string): boolean | null {
  const trimmed = word.trim();
  if (trimmed === '') return null;

  const last = trimmed[trimmed.length - 1] as string;
  const code = last.codePointAt(0) ?? 0;

  // 한글 음절 (가 ~ 힣)
  if (code >= 0xac00 && code <= 0xd7a3) {
    return (code - 0xac00) % 28 !== 0;
  }
  if (last in DIGIT_HAS_FINAL) return DIGIT_HAS_FINAL[last] as boolean;

  const lower = last.toLowerCase();
  if (lower in LETTER_HAS_FINAL) return LETTER_HAS_FINAL[lower] as boolean;

  return null;
}

/** 한국어로 읽었을 때 **ㄹ 받침**으로 끝나는 숫자·글자. */
const RIEUL_DIGITS = new Set(['1', '7', '8']); // 일 · 칠 · 팔
const RIEUL_LETTERS = new Set(['l', 'r']); // 엘 · 알

/**
 * 끝소리가 **ㄹ** 인가. `으로/로` 하나 때문에 필요합니다.
 *
 * ⚠️ 이것을 안 보면 화면에 **"할 일으로"** 가 뜹니다. 실제로 떴습니다 —
 * 칸반의 옮기기 버튼이 그랬고, 렌더해서 눈으로 볼 때까지 아무도 몰랐습니다.
 * 받침 유무만 보는 규칙은 여기서 정확히 절반만 맞습니다.
 */
export function endsInRieul(word: string): boolean | null {
  const trimmed = word.trim();
  if (trimmed === '') return null;
  const last = trimmed[trimmed.length - 1] as string;
  const code = last.codePointAt(0) ?? 0;

  // 한글 음절이면 종성 번호 8 이 ㄹ 입니다.
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 8;
  if (last in DIGIT_HAS_FINAL) return RIEUL_DIGITS.has(last);

  const lower = last.toLowerCase();
  if (lower in LETTER_HAS_FINAL) return RIEUL_LETTERS.has(lower);
  return null;
}

/**
 * 값 뒤에 붙일 조사.
 *
 * ⚠️ **판단할 수 없으면 받침 없는 쪽을 씁니다.** `은(는)` 같은 짝 표기를
 * 돌려주지 않습니다 — 그게 화면에 나오는 것이 이 함수를 만든 이유입니다.
 * 대신 그런 값이 오는 자리는 **문장을 바꾸는 쪽**을 택하세요.
 *
 * ⚠️ **`으로/로` 만 규칙이 다릅니다.** 받침이 있어도 그 받침이 **ㄹ** 이면
 * `로` 입니다 — `서울로`·`할 일로`·`PR로`(피알). 나머지 네 쌍은 받침
 * 유무만 봅니다 (`서울은`·`서울을`).
 */
export function josa(word: string, pair: JosaPair): string {
  const [withFinal, withoutFinal] = PAIRS[pair];
  if (hasFinalConsonant(word) !== true) return withoutFinal as string;
  if (pair === '으로로' && endsInRieul(word) === true) return withoutFinal as string;
  return withFinal as string;
}

/** 값과 조사를 **붙여서** 한 덩어리로. 띄우면 조사가 낱말처럼 보입니다. */
export function withJosa(word: string, pair: JosaPair): string {
  return `${word}${josa(word, pair)}`;
}
