import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.ts';
import { validateLogin, validateSignup, describeAuthFailure } from '@lib/auth/session.ts';
import { pageTitle } from '@lib/shell/title.ts';
import { Problem } from '../components/Problem.tsx';

export default function Login() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = pageTitle(mode === 'login' ? '로그인' : '가입');
    const params = new URLSearchParams(window.location.search);
    const oauthError = params.get('oauth_error');
    if (oauthError === 'no_client_id' || oauthError === 'no_credentials') {
      setError('Google 로그인을 사용할 수 없습니다. 이메일로 로그인하거나 관리자에게 문의해 주세요.');
    } else if (oauthError === 'invalid_state') {
      setError('로그인 요청이 만료되었거나 다른 창에서 시작되었습니다. Google 로그인을 다시 시작해 주세요.');
    } else if (oauthError === 'cancelled') {
      setError('Google 로그인이 취소되었습니다.');
    } else if (oauthError) {
      setError(`Google 로그인 오류 (${oauthError})`);
    }
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
      } else {
        await api.post('/api/auth/login', { email: email.trim(), password });
      }
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
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
              <span className="tlrow__who">팀 회의 · 결정</span>
              <p className="tlrow__text">“실시간 음성 회의와 회의록으로 업무를 정리합니다”</p>
            </div>
            <span className="tlrow__dot" />
          </div>
          <p className="login__arrow num">↓ 실시간 연동</p>
          <p className="login__task">
            <span className="num">TASK</span> 업무 후보 검토·승인 후 칸반 등록
          </p>
          <p className="login__arrow num">↓</p>
          <p className="login__task">
            <span className="num">기여도</span> 개인 및 팀 기여도 다각도 분석
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
          <p className="login__brand">TeamFlow</p>

          {/* 소셜 원클릭 로그인 (Google 공식 OAuth 2.0) */}
          <div className="oauth-btn-grid" style={{ gridTemplateColumns: '1fr' }}>
            <button
              type="button"
              className="oauth-btn"
              disabled={busy}
              onClick={() => {
                window.location.href = '/api/auth/google/login';
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z" />
                <path fill="#34A853" d="M12 24c3.3 0 6.08-1.09 8.1-2.96l-3.88-3.05c-1.08.72-2.45 1.16-4.22 1.16-3.24 0-5.98-2.18-6.96-5.11H1.07v3.14C3.09 21.2 7.22 24 12 24z" />
                <path fill="#FBBC05" d="M5.04 14.04c-.25-.72-.38-1.49-.38-2.29s.13-1.57.38-2.29V6.32H1.07C.39 7.68 0 9.21 0 11.75s.39 4.07 1.07 5.43l3.97-3.14z" />
                <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.22 0 3.09 2.8 1.07 6.32l3.97 3.14c.98-2.93 3.72-5.11 6.96-5.11z" />
              </svg>
              Google 계정으로 계속하기
            </button>
          </div>

          <div style={{ textAlign: 'center', margin: '14px 0 10px', color: 'var(--c-ink-muted)', fontSize: '12px' }}>
            또는 이메일 계정으로 {mode === 'login' ? '로그인' : '가입'}
          </div>

          {mode === 'signup' && (
            <label className="field">
              <span className="field__label">이름</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </label>
          )}
          <label className="field">
            <span className="field__label">이메일</span>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                className="input"
                style={{ flex: 1 }}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </div>
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
            <Problem>{error}</Problem>
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
          <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--c-border)', textAlign: 'center' }}>
            <Link to="/demo" style={{ fontSize: 'var(--fs-12)', color: 'var(--c-evidence)', textDecoration: 'none', fontWeight: 500 }}>
              음향 벡터 · 키워드 규칙 예시 체험관 둘러보기 →
            </Link>
          </div>
        </form>
      </main>
    </div>
  );
}
