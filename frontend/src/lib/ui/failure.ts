/**
 * 오류 화면 — 지시서 §7 은 넷을 요구합니다.
 *
 *     무엇이 실패했는지 · 다시 하기 · 도움 받을 곳 · 오류 코드
 *
 * ## ⚠️ 코드를 감추지 않습니다
 *
 * "문제가 발생했습니다" 만 뜨는 화면은 사람이 할 수 있는 일이 없습니다.
 * `HTTP 403` 과 `HTTP 500` 은 **다른 사람이 다른 일을 해야 하는** 상황
 * 입니다 — 앞은 팀장이 초대해 주면 되고, 뒤는 팀이 고칠 수 없습니다.
 * 그 구분을 화면이 지우면 아무도 못 고칩니다.
 *
 * ## ⚠️ 없는 지원 창구를 지어내지 않습니다
 *
 * 흔한 빈칸이 "고객센터에 문의하세요" 입니다. **이 제품에는 고객센터가
 * 없습니다.** 없는 곳으로 보내는 것은 아무 데도 안 보내는 것보다
 * 나쁩니다 — 사람이 찾아다니는 시간을 씁니다. 그래서 `help` 는
 * 선택이고, 실제로 갈 곳이 있을 때만 채웁니다.
 */

import { escapeHtml } from '../html.ts';

export interface Failure {
  /** 무엇이 실패했는가. 동작 이름으로 씁니다 — "기여도를 불러오지 못했습니다". */
  what: string;
  /** HTTP 상태 같은 코드. 없으면 생략합니다 — 빈 괄호를 남기지 않습니다. */
  code?: string | number;
  /** 지금 사람이 할 수 있는 일. 없으면 생략합니다. */
  help?: string;
  /** 다시 하기 버튼을 넣을지. 넣으면 `.retry` 를 화면이 배선합니다. */
  retry?: boolean;
}

/** 자주 나오는 상태 코드를 사람의 말로. 모르는 코드는 지어내지 않습니다. */
export function describeHttpStatus(status: number): string | null {
  if (status === 401) return '로그인이 풀렸습니다.';
  if (status === 403) return '이 프로젝트의 구성원만 볼 수 있습니다.';
  if (status === 404) return '찾을 수 없습니다 — 주소가 바뀌었거나 지워졌습니다.';
  if (status === 429) return '요청이 너무 잦습니다. 잠시 뒤에 다시 해 보세요.';
  if (status >= 500) return '서버 쪽 문제입니다. 팀이 고칠 수 있는 것이 아닙니다.';
  return null;
}

export function failureHtml(failure: Failure): string {
  const code =
    failure.code === undefined || failure.code === ''
      ? ''
      : `<p class="code">오류 코드 ${escapeHtml(String(failure.code))}</p>`;
  const help = failure.help ? `<p class="why">${escapeHtml(failure.help)}</p>` : '';
  const retry = failure.retry ? '<button type="button" class="retry">다시 불러오기</button>' : '';
  return (
    '<div class="failure-state" role="alert">' +
    `<p class="what">${escapeHtml(failure.what)}</p>` +
    help +
    retry +
    code +
    '</div>'
  );
}
