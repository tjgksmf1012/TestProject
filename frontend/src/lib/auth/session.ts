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

export function validateSignup(
  name: string,
  email: string,
  password: string,
): FormProblem[] {
  const problems = validateLogin(email, password);
  if (!name.trim()) {
    problems.push({ field: 'name', message: '이름을 입력하세요' });
  }
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
