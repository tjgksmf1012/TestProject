/**
 * 로그인·가입 화면.
 *
 * ⚠️ 화면 코드라 자동 테스트가 없습니다. 판단이 들어가는 것은 전부
 * `src/lib/auth/session.ts` 에 있고 24개 테스트로 검증됩니다.
 * 여기는 DOM 배선일 뿐입니다.
 */

import { detailText } from '../lib/http/detail.ts';
import { describeAuthFailure, safeApiBase, safeRedirect, validateLogin, validateSignup, type FormProblem } from '../lib/auth/session.ts';
import { escapeHtml } from '../lib/html.ts';
import { bootApp } from './pwa.ts';

const params = new URLSearchParams(location.search);
// ⚠️ 주소창의 `?api=` 를 그대로 쓰면 **비밀번호와 회의 음성이 어디로
// 가는지**를 링크 하나로 바꿀 수 있다. safeApiBase 가 진짜 도메인에서는
// 무시하고, 로컬 화면에서 로컬 서버일 때만 통과시킨다.
const apiBase = safeApiBase(params.get('api'), location.origin);
const next = safeRedirect(params.get('next'));

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`요소 없음: ${id}`);
  return el;
};

const value = (id: string): string => ($(id) as HTMLInputElement).value;

let mode: 'login' | 'signup' = 'login';

function showProblems(problems: FormProblem[]): void {
  $('error').innerHTML = problems
    .map((p) => `<p>${escapeHtml(p.message)}</p>`)
    .join('');
  $('error').hidden = problems.length === 0;
}

function showMessage(text: string): void {
  $('error').innerHTML = `<p>${escapeHtml(text)}</p>`;
  $('error').hidden = false;
}

function render(): void {
  const signup = mode === 'signup';
  $('name-row').hidden = !signup;
  $('submit').textContent = signup ? '가입하고 시작하기' : '로그인';
  $('toggle').textContent = signup
    ? '이미 계정이 있습니다 — 로그인'
    : '처음이신가요? 가입하기';
  $('title').textContent = signup ? '가입' : '로그인';
  $('error').hidden = true;
}

async function submit(): Promise<void> {
  const email = value('email');
  const password = value('password');
  const name = value('name');

  const problems =
    mode === 'signup'
      ? validateSignup(name, email, password)
      : validateLogin(email, password);
  if (problems.length) {
    showProblems(problems);
    return;
  }

  const button = $('submit') as HTMLButtonElement;
  button.disabled = true;
  try {
    const path = mode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
    const body = mode === 'signup' ? { name, email, password } : { email, password };
    const response = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // 쿠키를 받으려면 필요하다. 같은 오리진이면 기본값도 same-origin 이지만,
      // 개발 중에 ?api= 로 다른 주소를 붙였을 때 조용히 로그인이 안 되는 걸
      // 막는다.
      credentials: 'same-origin',
    });

    if (!response.ok) {
      // 422 는 `detail` 이 **객체 배열**입니다. 그대로 넘기면 로그인
      // 실패 문구 자리에 `[object Object]` 가 나옵니다.
      const body = await response.json().catch(() => null);
      const detail = detailText(body, '') || undefined;
      showMessage(describeAuthFailure(response.status, detail));
      return;
    }

    location.href = next;
  } catch (err) {
    showMessage(`연결하지 못했습니다: ${String(err)}`);
  } finally {
    button.disabled = false;
  }
}

$('submit').addEventListener('click', () => void submit());
$('form').addEventListener('submit', (event) => {
  event.preventDefault();
  void submit();
});
$('toggle').addEventListener('click', () => {
  mode = mode === 'login' ? 'signup' : 'login';
  render();
});

// 이미 로그인돼 있으면 굳이 다시 묻지 않는다.
void fetch(`${apiBase}/api/auth/me`, { credentials: 'same-origin' }).then((r) => {
  if (r.ok) location.href = next;
});

render();

// 서비스 워커 등록 + 설치 안내. 안 부르면 sw.js 는 그냥 놓인 파일이다.
bootApp();
