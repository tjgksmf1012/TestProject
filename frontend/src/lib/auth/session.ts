/**
 * 로그인 화면의 판단 로직.
 *
 * 화면 셋(`index` · `review` · `lobby`)은 그동안 주소창의 `?me=1` 을 읽어
 * 자기가 누구인지 정했습니다. 즉 **사용자가 스스로 신원을 선언**했고 서버는
 * 그걸 그대로 믿었습니다. 이제 신원은 서버가 세션에서 읽고, 화면은
 * `/api/auth/me` 로 물어봅니다.
 *
 * 여기 있는 것은 전부 DOM 없이 테스트되는 순수 함수입니다
 * (`frontend/README.md` 의 경계 규칙).
 */

/** 서버 `MeOut` 과 같은 모양. 어긋나면 화면이 이름을 못 그린다. */
export interface Me {
  user_id: number;
  name: string;
  email: string;
  /** 자기소개 (`USER-004`). 안 적었으면 `null`. */
  bio?: string | null;
  /** 프로필 이미지 (`USER-004`) — `data:image/png;base64,…` 그대로. */
  avatar?: string | null;
}

/** 서버 `passwords.MIN_PASSWORD_LENGTH` 와 같아야 한다. */
export const MIN_PASSWORD_LENGTH = 8;

export interface FormProblem {
  field: 'email' | 'password' | 'name';
  message: string;
}

/**
 * 보내기 전에 잡을 수 있는 것만 잡는다.
 *
 * 서버가 최종 판정을 하고 화면은 그걸 반복하지 않는다 — 규칙이 두 곳에
 * 있으면 반드시 갈라지고, 갈라지면 화면은 통과시켰는데 서버가 막는
 * (혹은 그 반대의) 상태가 된다. 여기서 막는 것은 **왕복이 명백히 낭비인
 * 경우**뿐이다.
 */
export function validateLogin(email: string, password: string): FormProblem[] {
  const problems: FormProblem[] = [];
  if (!email.trim()) {
    problems.push({ field: 'email', message: '이메일을 입력하세요' });
  } else if (!email.includes('@')) {
    problems.push({ field: 'email', message: '이메일 형식이 아닙니다' });
  }
  if (!password) {
    problems.push({ field: 'password', message: '비밀번호를 입력하세요' });
  }
  return problems;
}

/**
 * ⚠️ **화면의 칸 순서대로 쌓는다** — 이름 → 이메일 → 비밀번호.
 *
 * 예전에는 `validateLogin` 결과 뒤에 이름을 붙여서 문구가
 * `이메일 · 비밀번호 · 이름` 으로 나왔는데, 가입 폼의 칸은
 * `이름 · 이메일 · 비밀번호` 순입니다. 세 줄이 위에 모여 있고 그 아래
 * 칸 셋이 다른 순서로 있으면 사람이 눈으로 짝을 지어야 합니다 —
 * 순서만 맞추면 공짜로 되는 일입니다.
 */
export function validateSignup(
  name: string,
  email: string,
  password: string,
): FormProblem[] {
  const problems: FormProblem[] = [];
  if (!name.trim()) {
    problems.push({ field: 'name', message: '이름을 입력하세요' });
  }
  problems.push(...validateLogin(email, password));
  // 로그인과 달리 가입에서는 길이를 미리 본다. 여기서 막지 않으면 사람이
  // 짧은 비밀번호를 만들고 서버에서 거절당한 뒤 다시 입력해야 한다.
  if (password && password.length < MIN_PASSWORD_LENGTH) {
    problems.push({
      field: 'password',
      message: `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다`,
    });
  }
  return problems;
}

/**
 * 로그인 후 돌아갈 곳.
 *
 * ⚠️ **`next` 를 그대로 쓰면 열린 리다이렉트가 된다.** 공격자가
 * `/login.html?next=https://evil.example/login` 링크를 보내면, 사용자는
 * 진짜 도메인에서 로그인 화면을 보고 로그인한 뒤 남의 사이트로 넘어간다.
 * 거기 똑같이 생긴 로그인 화면이 있으면 "로그인이 안 됐나" 하고 한 번 더
 * 입력한다 — 그게 피싱이 성립하는 방식이다.
 *
 * 그래서 **같은 오리진의 경로만** 받는다. 판단 기준은 "`/` 로 시작하되
 * `//` 는 아닌 것" 이다. `//evil.example` 은 프로토콜 상대 URL 이라
 * 브라우저가 외부 주소로 읽는다.
 */
export function safeRedirect(next: string | null, fallback = '/home.html'): string {
  if (!next) return fallback;
  if (!next.startsWith('/')) return fallback;
  if (next.startsWith('//')) return fallback;
  // `/\evil.example` 를 외부로 읽는 브라우저가 있다.
  if (next.startsWith('/\\')) return fallback;
  return next;
}

/** 지금 있는 화면으로 돌아오도록 로그인 주소를 만든다. */
export function loginUrlFor(pathWithQuery: string): string {
  return `/login.html?next=${encodeURIComponent(pathWithQuery)}`;
}

/**
 * 화면이 요청을 보낼 서버 주소.
 *
 * ⚠️ 모든 화면이 `?api=` 를 읽어 그대로 `fetch` 주소 앞에 붙였다. 이건
 * 위 `safeRedirect` 가 막는 것보다 **나쁘다.** `next` 는 로그인이 *끝난 뒤*
 * 어디로 가느냐를 바꾸지만, `api` 는 **비밀번호가 어디로 가느냐**를 바꾼다.
 *
 *     https://<진짜 도메인>/login.html?api=https://evil.example
 *
 * 이 링크를 받은 사람은 끝까지 진짜 도메인·진짜 자물쇠·진짜 로그인 화면에
 * 머무른다. 눈으로 알아챌 단서가 하나도 없는데 평문 비밀번호가 남의 서버로
 * 나가고, 공격자가 200 을 돌려주면 화면은 아무 일 없다는 듯 넘어간다.
 * 로그인 화면만의 문제도 아니다 — 녹음 화면에서는 회의 음성이 나간다.
 *
 * 그런데 `?api=` 를 아예 없애면 개발할 때가 불편하다. 화면은 정적 서버
 * (`:5173`)에 띄우고 API 는 `:8000` 에 띄우는 게 보통이라, 그때는 다른
 * 포트를 가리켜야 한다. 그래서 **지금 보고 있는 화면 자체가 로컬일 때만**
 * 허용한다. 진짜 도메인에서는 무슨 값을 넣든 무시된다 — 피싱 링크가
 * 성립하는 곳은 진짜 도메인이므로, 막아야 할 곳만 정확히 막힌다.
 *
 * 같은 오리진의 경로(`/proxy` 같은 것)는 어디서든 허용한다. 그건 애초에
 * 남의 서버로 나갈 수가 없다.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function safeApiBase(raw: string | null, pageOrigin: string): string {
  if (!raw) return '';

  // 같은 오리진의 경로. `//evil.example` 과 `/\evil.example` 은 브라우저가
  // 외부 주소로 읽으므로 safeRedirect 와 같은 기준으로 걸러낸다.
  if (raw.startsWith('/')) {
    if (raw.startsWith('//') || raw.startsWith('/\\')) return '';
    return raw.replace(/\/+$/, '');
  }

  let target: URL;
  let page: URL;
  try {
    target = new URL(raw);
    page = new URL(pageOrigin);
  } catch {
    return '';
  }

  // 같은 오리진을 절대 주소로 쓴 것은 언제나 안전하다.
  if (target.origin === page.origin) return target.origin + target.pathname.replace(/\/+$/, '');

  // 여기서부터는 남의 오리진이다. 화면 자체가 로컬일 때만 허용한다.
  if (!LOCAL_HOSTS.has(page.hostname)) return '';
  if (!LOCAL_HOSTS.has(target.hostname)) return '';
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return '';
  return target.origin + target.pathname.replace(/\/+$/, '');
}

/**
 * 서버 응답을 사람이 읽을 문구로.
 *
 * 401 을 "인증 실패" 라고만 쓰면 사람은 무엇을 고쳐야 할지 모른다.
 * 반대로 "그런 이메일 없음" 과 "비밀번호 틀림" 을 구분하면 **누가 가입돼
 * 있는지가 새어 나간다** — 서버가 일부러 같은 문구를 주므로 화면도
 * 구분하지 않는다.
 */
export function describeAuthFailure(status: number, detail?: string): string {
  if (status === 401) return detail || '이메일 또는 비밀번호가 올바르지 않습니다';
  if (status === 409) return detail || '이미 가입된 이메일입니다';
  if (status === 400) return detail || '입력을 확인하세요';
  if (status >= 500) return '서버에 문제가 있습니다. 잠시 뒤 다시 시도하세요';
  return detail || `요청이 실패했습니다 (HTTP ${status})`;
}

/**
 * 응답이 "로그인이 풀렸다" 인가.
 *
 * 403 은 포함하지 않는다. 403 은 **로그인은 됐지만 이 팀 사람이 아니다**
 * 라는 뜻이라, 로그인 화면으로 보내면 같은 계정으로 다시 로그인해서 또
 * 403 을 보는 무한 왕복이 된다.
 */
export function isSessionExpired(status: number): boolean {
  return status === 401;
}

// ══════════════════════════════════════════════════════════════
// 로그아웃 — **끊겼는지 확인하고 나서** 화면을 옮긴다
//
// 화면 둘이 이렇게 쓰고 있었습니다.
//
//     void fetch(`${apiBase}/api/auth/logout`, { method: 'POST' })
//       .then(() => { location.href = '/login.html'; });
//
// `fetch` 는 500 이든 502 든 **정상적으로 resolve 합니다.** 그래서 서버가
// 세션을 못 끊어도 화면은 로그인 화면으로 갑니다. 그 사람은 로그아웃했다고
// 믿고 자리를 뜨는데 **세션 토큰은 살아 있습니다.**
//
// 이건 서버가 자기 docstring 에 적어 둔 바로 그 상황입니다 —
//
//     "쿠키만 지우면 토큰은 살아 있습니다. 그 토큰이 어딘가에 복사돼
//      있으면 로그아웃한 줄 알고 있는 동안 남이 그 계정으로 들어옵니다."
//
// 서버는 `revoke()` 로 제대로 끊는데, 화면이 그 성공 여부를 안 봤습니다.
// 학교 실습실 공용 PC 에서 이 회의 음성과 기여도 점수에 남이 들어옵니다.
//
// ⚠️ 그리고 네트워크가 끊기면 프로미스가 **거절**되고 `.catch` 가 없어서
// 버튼이 죽은 것처럼 보입니다. 반대 방향의 같은 결함입니다.

/** 로그아웃 요청의 결말. */
export type LogoutResult =
  /** 서버에서 세션이 끊겼다. 화면을 옮겨도 된다. */
  | 'done'
  /** 못 끊었다. **옮기면 거짓말이 된다.** */
  | 'still-signed-in';

/**
 * HTTP 상태로 결말을 정한다. 요청 자체가 실패했으면 `null` 을 준다.
 *
 * ⭐ 401 은 **성공으로 봅니다.** 서버가 이 세션을 모른다는 뜻이므로 그
 * 토큰으로는 아무도 못 들어옵니다. 여기서 실패로 처리하면 이미 만료된
 * 사람이 로그아웃 버튼에 갇힙니다.
 */
export function logoutOutcome(status: number | null): LogoutResult {
  if (status === null) return 'still-signed-in';
  if (status === 401) return 'done';
  if (status >= 200 && status < 300) return 'done';
  return 'still-signed-in';
}

/**
 * 못 끊었을 때 사람에게 할 말.
 *
 * **무엇이 사실인지**(아직 로그인돼 있다)와 **할 일**(다시 누르기)을
 * 같이 말합니다. "로그아웃 실패" 만으로는 지금 상태가 뭔지 모릅니다.
 */
export function describeLogoutFailure(status: number | null): string {
  const why =
    status === null
      ? '서버에 연결하지 못했습니다'
      : `서버가 처리하지 못했습니다 (HTTP ${status})`;
  return `로그아웃하지 못했습니다 — ${why}. 이 기기에 로그인 상태가 그대로 남아 있으니 다시 눌러 주세요.`;
}
