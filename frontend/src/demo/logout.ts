/**
 * 로그아웃 버튼 배선.
 *
 * ## 왜 한 곳에 모았나
 *
 * 홈과 로비가 **글자까지 똑같은** 로그아웃 코드를 각자 가지고 있었습니다.
 * 그리고 둘 다 같은 결함을 가지고 있었습니다 — 서버가 세션을 못 끊어도
 * 로그인 화면으로 옮겨 갔습니다 (결함 82).
 *
 * 이 저장소는 같은 실수를 두 번 했습니다. 결함 73 은 `detailText` 를 한
 * 파일에서만 쓰고 있었고, 결함 81 은 복사 코드가 두 화면에 흩어져 있어
 * 한쪽만 고쳐졌습니다. **두 벌이 있으면 한쪽만 고쳐집니다.**
 *
 * ⚠️ 판단은 여기 없습니다. `lib/auth/session.ts` 의 `logoutOutcome` 이
 * 정하고 테스트가 붙습니다. 여기는 그걸 부르고 DOM 을 만지는 배선입니다.
 */

import { describeLogoutFailure, logoutOutcome } from '../lib/auth/session.ts';
import { trySend } from '../lib/http/send.ts';

export interface LogoutWiring {
  /** 로그아웃 버튼. */
  button: HTMLButtonElement;
  /** 못 끊었을 때 이유를 적을 자리. 없으면 버튼 옆에 아무 말도 못 한다. */
  note: HTMLElement;
  /** `safeApiBase` 를 지난 주소. */
  apiBase: string;
  /** 성공했을 때 갈 곳. */
  next?: string;
}

export function wireLogout({ button, note, apiBase, next = '/login.html' }: LogoutWiring): void {
  button.addEventListener('click', () => {
    // 누르는 동안 잠근다 (결함 89). 로그아웃은 멱등이지만, 두 번 누르면
    // 두 요청이 겹쳐 나중 것의 401 이 "실패" 로 읽힐 수 있다.
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    note.hidden = true;

    // ⚠️ 상태를 **보고** 나서 옮깁니다. `fetch` 는 500 에서도 resolve 하므로
    // `.then(() => location.href = …)` 은 "실패해도 옮긴다" 와 같습니다.
    //
    // 네트워크가 끊기면 `trySend` 가 `null` 을 돌려줍니다 — 그때도
    // `logoutOutcome` 한 곳에서 판단합니다 (결함 87 과 같은 약).
    void trySend(() =>
      fetch(`${apiBase}/api/auth/logout`, {
        method: 'POST',
        credentials: 'same-origin',
      }),
    )
      .then((response) => (response === null ? null : response.status))
      .then((status) => {
        button.disabled = false;
        button.removeAttribute('aria-busy');
        if (logoutOutcome(status) === 'done') {
          location.href = next;
          return;
        }
        note.textContent = describeLogoutFailure(status);
        note.hidden = false;
      });
  });
}
