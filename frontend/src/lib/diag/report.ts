/**
 * 화면이 터졌을 때 **서버에 남길 것**을 정한다.
 *
 * ## 왜 이게 필요한가
 *
 * 베타 체험 중에 화면 하나를 일부러 터뜨려 보고 알았습니다. 사람이 보는
 * 것은 이랬습니다 —
 *
 *     Unexpected Application Error!
 *     e.filter is not a function
 *     at ls (…/assets/index-DskNXvnA.js:12:42055)
 *
 * 영문이고, 압축된 스택이고, **돌아갈 버튼이 없고**, 그리고 서버 로그에는
 * **아무것도 안 남았습니다.** 베타 참가자가 "그냥 안 되던데요" 라고 말하면
 * 그걸로 끝입니다. 요청 로그(`uvicorn.access`)는 브라우저 안에서 난 일을
 * 볼 수 없습니다.
 *
 * ## ⚠️ 무엇을 보내지 **않는가** 가 더 중요합니다
 *
 * 이 제품은 회의 내용을 다룹니다 (docs/07 P4). 그래서:
 *
 * - **주소는 `pathname` 만.** `?…`·`#…` 는 뗍니다. 지금은 `?project=3`
 *   뿐이지만, 나중에 누가 검색어나 초대 코드를 주소에 실으면 그날부터
 *   로그 수집기로 새어 나갑니다. 뗄 이유가 생긴 뒤에 떼면 늦습니다.
 * - **사람이 친 글자는 안 보냅니다.** 오류 메시지와 스택뿐입니다.
 * - 길이를 자릅니다. 자르지 않으면 렌더 루프 한 번이 로그를 채웁니다.
 */

/** 어디서 잡힌 것인가. 셋뿐이고, 모르는 값은 `error` 로 눕힙니다. */
export type ClientErrorKind = 'render' | 'error' | 'unhandledrejection';

export interface ClientErrorPayload {
  kind: ClientErrorKind;
  message: string;
  stack: string | null;
  route: string;
}

const KINDS: ReadonlySet<string> = new Set<ClientErrorKind>([
  'render',
  'error',
  'unhandledrejection',
]);

/** 서버 쪽 상한과 **같은 숫자**여야 합니다 — 다르면 조용히 422 가 됩니다. */
export const MAX_MESSAGE = 500;
export const MAX_STACK = 4000;
export const MAX_ROUTE = 200;

function cut(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * 던져진 것(무엇이든)을 한 줄 메시지로.
 *
 * ⚠️ `String(err)` 만 쓰면 평범한 객체가 `[object Object]` 가 되고, 그건
 *    로그에서 아무것도 말해 주지 않습니다. 그럴 때는 키라도 남깁니다.
 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return cut(error.message || error.name, MAX_MESSAGE);
  if (typeof error === 'string') return cut(error, MAX_MESSAGE);
  if (error !== null && typeof error === 'object') {
    const text = String(error);
    if (text !== '[object Object]') return cut(text, MAX_MESSAGE);
    return cut(`알 수 없는 오류 객체 {${Object.keys(error).join(',')}}`, MAX_MESSAGE);
  }
  return cut(String(error), MAX_MESSAGE);
}

/**
 * 주소에서 **경로만.**
 *
 * ⚠️ `new URL(...)` 을 쓰지 않습니다 — 이 값은 `location.pathname` 처럼
 *    호스트가 없는 조각으로도 들어옵니다.
 */
export function routeOf(href: string): string {
  const path = (href || '/').replace(/^https?:\/\/[^/]*/i, '');
  const cutAt = Math.min(
    ...[path.indexOf('?'), path.indexOf('#')].filter((i) => i >= 0).concat([path.length]),
  );
  return cut(path.slice(0, cutAt) || '/', MAX_ROUTE);
}

/** 서버로 보낼 한 덩이. 여기서 자르지 않으면 서버가 422 로 버립니다. */
export function clientErrorPayload(
  error: unknown,
  kind: string,
  href: string,
): ClientErrorPayload {
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : null;
  return {
    kind: (KINDS.has(kind) ? kind : 'error') as ClientErrorKind,
    message: messageOf(error),
    stack: stack === null ? null : cut(stack, MAX_STACK),
    route: routeOf(href),
  };
}

/**
 * 사람에게 보여 줄 말.
 *
 * ⚠️ 원래 오류 문구(`e.filter is not a function`)를 **크게** 쓰지
 *    않습니다. 사람이 고칠 수 있는 것이 아니고, 영문 스택은 "내가 뭘
 *    잘못했나" 로 읽힙니다. 대신 **여기서 할 수 있는 것**을 말합니다.
 */
export function crashMessage(): string {
  return '이 화면을 그리다 문제가 났습니다. 방금 한 일은 저장됐을 수도, 안 됐을 수도 있습니다.';
}
