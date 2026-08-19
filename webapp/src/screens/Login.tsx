import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.ts';
import { EvidenceChip } from '../components/EvidenceChip.tsx';
import { validateLogin, validateSignup, describeAuthFailure } from '@lib/auth/session.ts';
import { pageTitle } from '@lib/shell/title.ts';

// 로그인 — 좌측 히어로가 이 제품의 주장입니다 (지시서 기타-6 §로그인):
// 회의 발화 → 업무 → PR 사슬을 정지 화면으로 보여줍니다. 애니메이션 없음.

export default function Login() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 이 화면은 `AppShell` 밖이라 제목을 스스로 답니다.
  // ⚠️ 가입으로 바꾸면 제목도 따라갑니다 — 같은 주소에서 화면이 바뀌는데
  //    제목이 그대로면 낭독기는 아무 일도 안 일어난 것으로 읽습니다.
  useEffect(() => {
    document.title = pageTitle(mode === 'login' ? '로그인' : '가입');
  }, [mode]);

  const submit = async () => {
    const problems =
      mode === 'login'
        ? validateLogin(email, password)
        : validateSignup(name, email, password);
    if (problems.length > 0) {
      setError(problems.map((p) => p.message).join(' · '));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signup') {
        await api.post('/api/auth/signup', { name: name.trim(), email: email.trim(), password });
      }
      await api.post('/api/auth/login', { email: email.trim(), password });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      navigate('/', { replace: true });
    } catch (e) {
      setError(
        e instanceof ApiError ? describeAuthFailure(e.status, e.detail) : '로그인하지 못했습니다',
      );
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <aside className="login__hero" aria-hidden="true">
        <h1 className="login__claim">
          회의에서 한 말이
          <br />
          누구의 일이 되었는지
          <br />
          거슬러 올라갑니다.
        </h1>
        <div className="card login__chain">
          <div className="tlrow tlrow--evidence">
            <span className="tlrow__at num">0:01</span>
            <div>
              <span className="tlrow__who">김민수 · 결정</span>
              <p className="tlrow__text">“로그인 API는 민수가 금요일까지 만들기로 하죠”</p>
            </div>
            <span className="tlrow__dot" />
          </div>
          <p className="login__arrow num">↓ 근거 #1</p>
          <p className="login__task">
            <span className="num">TASK-3</span> 로그인 API 구현 — 김민수 ·{' '}
            <span className="num">09-11</span>
          </p>
          <p className="login__arrow num">↓</p>
          <p className="login__task">
            <span className="num">demo#17</span> 병합됨 <EvidenceChip id="근거 보기" onOpen={() => {}} label="예시 근거" />
          </p>
        </div>
      </aside>

      <main className="login__form-side">
        <form
          className="login__form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {/* ⚠️ `<h1>` 이었습니다 — 한 화면에 `<h1>` 이 둘이면 낭독기 사용자에게
              "이 페이지의 주제" 가 둘이 됩니다. 주제는 왼쪽의 문장이고,
              이것은 상표입니다. */}
          <p className="login__brand">TeamFlow</p>
          {mode === 'signup' && (
            <label className="field">
              <span className="field__label">이름</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </label>
          )}
          <label className="field">
            <span className="field__label">이메일</span>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </label>
          <label className="field">
            <span className="field__label">비밀번호</span>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </label>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {mode === 'login' ? '로그인' : '가입하고 로그인'}
          </button>
          {error !== null && (
            <p className="disabled-reason" role="alert">
              {error}
            </p>
          )}
          <p className="t13 muted">
            {mode === 'login' ? (
              <>
                처음이신가요?{' '}
                <button type="button" className="login__switch" onClick={() => setMode('signup')}>
                  가입하기
                </button>
              </>
            ) : (
              <>
                계정이 있으신가요?{' '}
                <button type="button" className="login__switch" onClick={() => setMode('login')}>
                  로그인하기
                </button>
              </>
            )}
          </p>
          <p className="t12 faint">비밀번호는 scrypt로 해싱해 저장합니다.</p>
        </form>
      </main>
    </div>
  );
}
