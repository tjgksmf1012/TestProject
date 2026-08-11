/**
 * 로그인·가입 화면 — **React 로 옮긴 다섯 번째 화면** (docs/19 §24).
 *
 * ⚠️ 판단은 전부 `lib/auth/session.ts` 에 있고 테스트가 붙어 있습니다.
 * 여기는 그리기만 합니다 — 화면 코드에는 자동 테스트가 없으므로, 판단이
 * 이리로 새는 만큼이 검증 밖으로 나갑니다.
 *
 * 이 화면은 **탭바가 없는 유일한 화면**입니다(`offline.html` 과 둘).
 * 아직 어느 프로젝트 사람인지도 모르므로 탭이 전부 죽은 링크가 됩니다.
 */

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { detailText } from '../lib/http/detail.ts';
import { describeUnexpected, trySend, unreachableText } from '../lib/http/send.ts';
import {
  describeAuthFailure,
  safeApiBase,
  safeRedirect,
  validateLogin,
  validateSignup,
} from '../lib/auth/session.ts';
import { bootApp } from './pwa.ts';

const params = new URLSearchParams(location.search);
// ⚠️ 주소창의 `?api=` 를 그대로 쓰면 **비밀번호와 회의 음성이 어디로
// 가는지**를 링크 하나로 바꿀 수 있다. safeApiBase 가 진짜 도메인에서는
// 무시하고, 로컬 화면에서 로컬 서버일 때만 통과시킨다.
const apiBase = safeApiBase(params.get('api'), location.origin);
const next = safeRedirect(params.get('next'));

function Login() {
  const [signup, setSignup] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  /**
   * 화면이 할 말. **아직 안 적은 것과 실패를 가릅니다** (docs/19 §26).
   *
   * ⚠️ 예전에는 둘을 한 배열에 담아 전부 빨갛게 찍었습니다. 가입 폼을 막
   * 연 사람에게 빨간 줄 셋이 뜨는데, 그 사람은 아무것도 잘못하지
   * 않았습니다 — 이 저장소가 로비·검토·녹음에서 이미 고친 그 모양입니다.
   */
  const [note, setNote] = useState<{ lines: string[]; tone: 'gap' | 'bad' } | null>(null);
  // 누르는 동안 잠근다 (결함 89).
  const [sending, setSending] = useState(false);

  useEffect(() => {
    // 이미 로그인돼 있으면 곧바로 넘겨 줍니다. **닿지 못하면 아무 말도
    // 안 합니다** — 아직 아무것도 안 한 사람에게 "서버에 닿지 못했습니다"
    // 를 띄우면 놀랍니다.
    //
    // ⚠️ 그래도 `.catch` 는 있어야 합니다 (결함 115). 없으면 오프라인에서
    // `TypeError: Failed to fetch` 가 **처리되지 않은 거부**로 남아 콘솔에
    // 빨간 줄이 뜹니다. 말을 안 하는 것과 오류를 흘리는 것은 다릅니다.
    void fetch(`${apiBase}/api/auth/me`, { credentials: 'same-origin' })
      .then((r) => {
        if (r.ok) location.href = next;
      })
      .catch(() => undefined);
  }, []);

  const submit = async (): Promise<void> => {
    const found = signup ? validateSignup(name, email, password) : validateLogin(email, password);
    if (found.length > 0) {
      // 보내기도 전에 잡은 것 — **아직 안 적은 것**이라 흙빛입니다.
      setNote({ lines: found.map((p) => p.message), tone: 'gap' });
      return;
    }
    setNote(null);
    setSending(true);
    try {
      const response = await trySend(() =>
        fetch(`${apiBase}${signup ? '/api/auth/signup' : '/api/auth/login'}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(signup ? { name, email, password } : { email, password }),
          // 쿠키를 받으려면 필요합니다. 같은 오리진이면 기본값도
          // same-origin 이지만, 개발 중에 `?api=` 로 다른 주소를 붙였을 때
          // 조용히 로그인이 안 되는 걸 막습니다.
          credentials: 'same-origin',
        }),
      );
      if (response === null) {
        setNote({
          lines: [unreachableText(signup ? '가입하지 못했습니다' : '로그인하지 못했습니다')],
          tone: 'bad',
        });
        return;
      }
      if (!response.ok) {
        // 422 는 `detail` 이 **객체 배열**입니다. 그대로 넘기면 실패 문구
        // 자리에 `[object Object]` 가 나옵니다.
        const body = (await response.json().catch(() => null)) as unknown;
        const detail = detailText(body, '') || undefined;
        setNote({ lines: [describeAuthFailure(response.status, detail)], tone: 'bad' });
        return;
      }
      location.href = next;
    } catch (error) {
      // 보내는 실패는 위에서 `null` 로 끝납니다. 여기는 응답을 읽다 깨진 경우입니다.
      console.error(error);
      setNote({ lines: [describeUnexpected()], tone: 'bad' });
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <header className="head">
        <h1 id="title">{signup ? '가입' : '로그인'}</h1>
        <p className="lede">
          TeamFlow는 회의에서 정한 일이 칸반과 GitHub을 거쳐 기여 기록까지 이어지게 하는
          도구입니다. 회의 녹음과 기여도는 팀 내부 자료라 로그인이 필요합니다.
        </p>
      </header>

      {note !== null && (
        <div id="error" className={note.tone === 'gap' ? 'error gap' : 'error'}>
          {note.lines.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      )}

      <div className="card">
        <form
          id="form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {signup && (
            <label id="name-row">
              이름
              <input
                id="name"
                type="text"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          )}
          <label>
            이메일
            <input
              id="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            비밀번호
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button id="submit" className="primary" type="submit" disabled={sending}>
            {signup ? '가입하고 시작하기' : '로그인'}
          </button>
        </form>
        {/* 모드를 바꾸는 것뿐이라 **주 행동과 경쟁하면 안 됩니다** —
            글자 무게로 둡니다. */}
        <button
          id="toggle"
          type="button"
          className="linkish"
          onClick={() => {
            setSignup((was) => !was);
            setNote(null);
          }}
        >
          {signup ? '이미 계정이 있습니다 — 로그인' : '처음이신가요? 가입하기'}
        </button>
      </div>

      <p className="note">
        비밀번호는 scrypt로 해싱해 저장하고, 세션 토큰은 원문이 아니라 해시만 남깁니다.
        로그아웃하면 서버에서 세션을 끊습니다.
      </p>
    </>
  );
}

const host = document.getElementById('app');
if (host === null) throw new Error('요소 없음: app');
createRoot(host).render(<Login />);

// 서비스 워커 등록 + 설치 안내. 안 부르면 sw.js 는 그냥 놓인 파일이다.
bootApp();
