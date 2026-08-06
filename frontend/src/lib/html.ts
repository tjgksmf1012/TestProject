/**
 * HTML 이스케이프.
 *
 * ⚠️ **DOM 을 쓰지 않습니다.** 원래 두 화면이 각자 이렇게 갖고 있었습니다.
 *
 * ```ts
 * const div = document.createElement('div');
 * div.textContent = text;
 * return div.innerHTML;          // ← 여기가 함정
 * ```
 *
 * 이 방식은 **텍스트 자리에서만 맞습니다.** HTML fragment serialization 사양은
 * 텍스트 노드를 직렬화할 때 `&`, `<`, `>`, ` ` 만 치환하고 **따옴표는
 * 그대로 둡니다** — 텍스트 자리에서는 따옴표가 위험하지 않으니까요.
 *
 * 그런데 `review.ts` 는 그 결과를 **속성 자리**에 넣고 있었습니다.
 *
 * ```
 * <input class="title" value="${escapeHtml(effectiveTitle(...))}"
 * ```
 *
 * 그 값은 LLM 이 회의 발화에서 뽑은 업무 제목입니다. 제목에 따옴표가 하나
 * 들어가면 속성이 거기서 끝나고 그 뒤가 마크업으로 해석됩니다. 회의에서
 * 누군가 `로그인 " onmouseover="…` 라고 말하기만 하면 됩니다.
 *
 * 그래서 DOM 대신 문자열 치환을 씁니다. 부수 효과가 둘 더 있습니다.
 *   - Node 에서 테스트할 수 있습니다 (DOM 이 필요 없으므로).
 *   - 화면마다 복사본을 두지 않아도 됩니다.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * 텍스트 자리와 **속성 자리 양쪽에서** 안전한 이스케이프.
 *
 * `&` 를 가장 먼저 치환해야 합니다 — 나중에 하면 앞서 만든 `&lt;` 의
 * `&` 를 다시 건드려 `&amp;lt;` 가 됩니다. 정규식 한 번으로 훑는 이유입니다.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

/**
 * 속성값을 따옴표까지 포함해 만든다.
 *
 * `value=${attr(x)}` 로 쓰면 따옴표를 빠뜨릴 수 없습니다. 이스케이프를
 * 기억하는 것보다 **빠뜨릴 수 없는 형태**로 만드는 쪽이 낫습니다.
 */
export function attr(value: string | number): string {
  return `"${escapeHtml(String(value))}"`;
}
