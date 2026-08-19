import { useEffect } from 'react';
import { useNavigate, useRouteError } from 'react-router-dom';
import { crashMessage, messageOf } from '@lib/diag/report.ts';
import { reportClientError } from '../api/diag.ts';

/**
 * 화면이 렌더 중에 터졌을 때 **사람이 보는 것.**
 *
 * ## 이게 없을 때 무엇이 떴는가
 *
 * 라우터의 기본 오류 화면입니다 — 베타 체험에서 실제로 찍은 것:
 *
 *     Unexpected Application Error!
 *     e.filter is not a function
 *     at ls (…/assets/index-DskNXvnA.js:12:42055)
 *     …
 *
 * 넷이 한꺼번에 잘못돼 있었습니다. **영문**이고, **압축된 스택**이고,
 * **돌아갈 길이 없고**, 그리고 서버에 **아무 흔적도 안 남았습니다.**
 *
 * ## 여기서 하는 것
 *
 * - 한국어로, 지금 **할 수 있는 것**을 말합니다 (`crashMessage`).
 * - 나가는 문을 둘 줍니다 — 다시 시도 · 홈으로.
 * - 서버에 한 줄 남깁니다. 그래야 다음 날 "왜 안 됐는지" 를 알 수 있습니다.
 *
 * ⚠️ 원래 오류 문구는 **작게, 아래에** 둡니다. 지우지는 않습니다 —
 *    베타 참가자가 그 한 줄을 옮겨 적어 주면 고치는 시간이 크게 줄고,
 *    없애면 사람은 "아무것도 못 알려 주겠다" 가 됩니다.
 */
export default function Crashed() {
  const error = useRouteError();
  const navigate = useNavigate();

  // ⚠️ 렌더 중에 보내면 StrictMode 에서 두 번 갑니다. 효과에서 한 번만.
  useEffect(() => {
    reportClientError(error, 'render');
  }, [error]);

  return (
    <div className="crash">
      <div className="crash__box">
        <h1 className="crash__title">화면을 열지 못했습니다</h1>
        <p className="crash__body">{crashMessage()}</p>
        <div className="crash__actions">
          <button type="button" className="btn btn--primary" onClick={() => navigate(0)}>
            다시 시도
          </button>
          {/* ⚠️ `navigate('/')` 가 아니라 주소를 갈아 끼웁니다. 터진 것이
              셸 자체일 수 있고, 그때 라우터로 옮기면 같은 자리에서 또
              터집니다. */}
          <a className="btn btn--secondary" href="/app/">
            홈으로
          </a>
        </div>
        <p className="crash__detail num">{messageOf(error)}</p>
      </div>
    </div>
  );
}
