import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MIN_PASSWORD_LENGTH,
  describeAuthFailure,
  isSessionExpired,
  loginUrlFor,
  safeApiBase,
  safeRedirect,
  validateLogin,
  validateSignup,
} from './session.ts';

describe('validateLogin', () => {
  it('둘 다 채워져 있으면 통과', () => {
    deepStrictEqual(validateLogin('a@x.com', 'password123'), []);
  });

  it('빈 칸을 잡는다', () => {
    const fields = validateLogin('', '').map((p) => p.field);
    deepStrictEqual(fields, ['email', 'password']);
  });

  it('공백만 넣은 이메일도 빈 칸이다', () => {
    strictEqual(validateLogin('   ', 'password123')[0]?.field, 'email');
  });

  it('⭐ 로그인에서는 비밀번호 길이를 보지 않는다', () => {
    // 규칙이 바뀌기 전에 가입한 사람은 짧은 비밀번호를 갖고 있다.
    // 로그인 화면이 길이를 막으면 그 사람은 자기 계정에 못 들어간다.
    deepStrictEqual(validateLogin('a@x.com', 'old'), []);
  });
});

describe('validateSignup', () => {
  it('이름·이메일·비밀번호가 다 있으면 통과', () => {
    deepStrictEqual(validateSignup('김민수', 'a@x.com', 'password123'), []);
  });

  it('이름이 비면 잡는다', () => {
    strictEqual(
      validateSignup('  ', 'a@x.com', 'password123').some((p) => p.field === 'name'),
      true,
    );
  });

  it('⭐ 가입에서는 길이를 미리 본다 — 서버 규칙과 같은 숫자로', () => {
    const problems = validateSignup('가', 'a@x.com', 'x'.repeat(MIN_PASSWORD_LENGTH - 1));
    strictEqual(problems.some((p) => p.field === 'password'), true);
    deepStrictEqual(validateSignup('가', 'a@x.com', 'x'.repeat(MIN_PASSWORD_LENGTH)), []);
  });

  it('비밀번호가 아예 비었으면 길이 문구를 겹쳐 말하지 않는다', () => {
    const messages = validateSignup('가', 'a@x.com', '').map((p) => p.message);
    deepStrictEqual(messages, ['비밀번호를 입력하세요']);
  });
});

describe('safeRedirect', () => {
  it('같은 오리진 경로는 그대로 쓴다', () => {
    strictEqual(safeRedirect('/review.html?meeting=1'), '/review.html?meeting=1');
  });

  it('없으면 기본 화면으로', () => {
    strictEqual(safeRedirect(null), '/home.html');
    strictEqual(safeRedirect(''), '/home.html');
  });

  it('⭐ 외부 주소는 거부한다 — 열린 리다이렉트는 피싱이 된다', () => {
    // 진짜 도메인에서 로그인한 뒤 남의 사이트로 넘어가면, 사람은 거기
    // 똑같이 생긴 로그인 화면에 한 번 더 입력한다.
    for (const evil of [
      'https://evil.example/login',
      'http://evil.example',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      'evil.example',
    ]) {
      strictEqual(safeRedirect(evil), '/home.html', evil);
    }
  });

  it('기본 화면을 바꿀 수 있다', () => {
    strictEqual(safeRedirect(null, '/index.html'), '/index.html');
  });
});

describe('loginUrlFor', () => {
  it('돌아올 곳을 인코딩해서 붙인다', () => {
    strictEqual(
      loginUrlFor('/review.html?meeting=1'),
      '/login.html?next=%2Freview.html%3Fmeeting%3D1',
    );
  });

  it('⭐ 왕복이 성립한다', () => {
    const original = '/lobby.html?meeting=42';
    const url = loginUrlFor(original);
    const next = new URLSearchParams(url.split('?')[1]).get('next');
    strictEqual(safeRedirect(next), original);
  });
});

describe('describeAuthFailure', () => {
  it('서버가 준 문구를 우선한다', () => {
    strictEqual(describeAuthFailure(400, '비밀번호는 8자 이상이어야 합니다'),
      '비밀번호는 8자 이상이어야 합니다');
  });

  it('⭐ 401 은 이메일과 비밀번호를 구분하지 않는다', () => {
    // 구분해서 알려 주면 어떤 이메일이 가입돼 있는지 알아낼 수 있다.
    const message = describeAuthFailure(401);
    strictEqual(message.includes('이메일 또는 비밀번호'), true);
    strictEqual(/없는 계정|가입되지/.test(message), false);
  });

  it('500 은 사용자 잘못이 아니라고 말한다', () => {
    strictEqual(describeAuthFailure(503).includes('서버'), true);
  });

  it('모르는 상태 코드도 삼키지 않는다', () => {
    strictEqual(describeAuthFailure(418).includes('418'), true);
  });
});

describe('isSessionExpired', () => {
  it('401 이면 로그인 화면으로', () => {
    strictEqual(isSessionExpired(401), true);
  });

  it('⭐ 403 은 로그인 화면으로 보내지 않는다', () => {
    // 403 은 "로그인은 됐지만 이 팀 사람이 아니다" 다. 로그인 화면으로
    // 보내면 같은 계정으로 다시 로그인해 또 403 을 보는 무한 왕복이 된다.
    strictEqual(isSessionExpired(403), false);
    strictEqual(isSessionExpired(404), false);
    strictEqual(isSessionExpired(200), false);
  });
});

describe('safeApiBase', () => {
  const REAL = 'https://teamflow.example';
  const LOCAL = 'http://localhost:5173';

  it('없으면 같은 오리진 — 이게 정상 경로다', () => {
    strictEqual(safeApiBase(null, REAL), '');
    strictEqual(safeApiBase('', REAL), '');
  });

  it('⭐ 진짜 도메인에서는 남의 주소를 절대 받지 않는다', () => {
    // 이걸 받으면 진짜 도메인·진짜 자물쇠·진짜 로그인 화면에서
    // 평문 비밀번호가 남의 서버로 나간다. 사람이 알아챌 단서가 없다.
    for (const evil of [
      'https://evil.example',
      'http://evil.example:8000',
      'https://evil.example/api',
      '//evil.example',
      '/\\evil.example',
      'https://teamflow.example.evil.com',
      'javascript:alert(1)',
      'data:text/html,x',
    ]) {
      strictEqual(safeApiBase(evil, REAL), '', evil);
    }
  });

  it('⭐ 로컬 화면에서 로컬 서버는 허용한다 — 개발이 그렇게 돌아간다', () => {
    // 화면은 :5173, API 는 :8000 에 뜨는 게 보통이다.
    strictEqual(safeApiBase('http://localhost:8000', LOCAL), 'http://localhost:8000');
    strictEqual(safeApiBase('http://127.0.0.1:8000', LOCAL), 'http://127.0.0.1:8000');
  });

  it('⭐ 로컬 화면이어도 바깥 주소는 막는다', () => {
    // 개발 중이라고 해서 남의 서버로 보낼 이유는 없다.
    strictEqual(safeApiBase('https://evil.example', LOCAL), '');
  });

  it('로컬이어도 http/https 가 아니면 막는다', () => {
    strictEqual(safeApiBase('javascript://localhost/%0aalert(1)', LOCAL), '');
    strictEqual(safeApiBase('file://localhost/etc/passwd', LOCAL), '');
  });

  it('같은 오리진을 절대 주소로 쓴 것은 어디서든 통과', () => {
    strictEqual(safeApiBase(REAL, REAL), REAL);
  });

  it('같은 오리진의 경로는 통과 — 프록시를 앞에 둘 수 있다', () => {
    strictEqual(safeApiBase('/proxy', REAL), '/proxy');
  });

  it('끝의 슬래시를 걷어낸다 — 붙이면 //api 가 된다', () => {
    strictEqual(safeApiBase('http://localhost:8000/', LOCAL), 'http://localhost:8000');
    strictEqual(safeApiBase('/proxy/', REAL), '/proxy');
  });
});

describe('주소창에서 읽어도 같은 판단을 한다', () => {
  // 화면들은 `safeApiBase(params.get('api'), location.origin)` 를 직접
  // 씁니다. 예전에는 그걸 감싼 `apiBaseFromLocation` 이 따로 있었는데
  // **부르는 화면이 0곳**이었습니다 — 테스트만 그 길을 지나고 있었던
  // 셈이라 지웠습니다. 여기 있던 경우는 화면이 실제로 지나는 길로
  // 옮겼습니다. 공격 사례를 같이 잃으면 안 되니까요.
  const fromSearch = (search: string, pageOrigin: string): string =>
    safeApiBase(new URLSearchParams(search).get('api'), pageOrigin);

  it('남의 오리진은 거절한다', () => {
    strictEqual(
      fromSearch('?api=https://evil.example&next=/home.html', 'https://teamflow.example'),
      '',
    );
  });

  it('로컬끼리는 통과한다', () => {
    strictEqual(fromSearch('?api=http://localhost:8000', 'http://localhost:5173'), 'http://localhost:8000');
  });

  it('파라미터가 없으면 빈 값', () => {
    strictEqual(fromSearch('', 'https://teamflow.example'), '');
  });
});
