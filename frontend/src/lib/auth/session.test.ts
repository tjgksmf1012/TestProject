import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MIN_PASSWORD_LENGTH,
  describeAuthFailure,
  isSessionExpired,
  loginUrlFor,
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
    strictEqual(safeRedirect(null), '/lobby.html');
    strictEqual(safeRedirect(''), '/lobby.html');
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
      strictEqual(safeRedirect(evil), '/lobby.html', evil);
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
