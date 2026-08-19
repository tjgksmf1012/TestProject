import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Navigate, Outlet, RouterProvider } from 'react-router-dom';
import { useMe } from './api/hooks.ts';
import Login from './screens/Login.tsx';
import Home from './screens/Home.tsx';
import Settings from './screens/Settings.tsx';
import Kanban from './screens/Kanban.tsx';
import Contributions from './screens/Contributions.tsx';
import Lobby from './screens/Lobby.tsx';
import Review from './screens/Review.tsx';
import Crashed from './screens/Crashed.tsx';
import { watchForUncaught } from './api/diag.ts';
import './app.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

// 로그인 전이면 /login 으로. 판별이 끝나기 전에는 빈 셸만 그립니다 —
// 화면이 먼저 떴다가 튕기면 "쫓겨났다"로 읽힙니다.
function RequireAuth() {
  const { data: me, isPending } = useMe();
  if (isPending) return null;
  if (me === null || me === undefined) return <Navigate to="/login" replace />;
  return <Outlet />;
}

// 녹음(index.html)·통화(call.html)는 SPA 밖입니다 — 장치 수명을 React 로 옮기지
// 않는다는 결정(docs/19 §24.9)은 이 리디자인에서도 유지됩니다.
// ⚠️ **오류 화면을 안 주면 라우터의 기본 화면이 뜹니다** — 영문
// `Unexpected Application Error!` 와 압축된 스택, 그리고 나가는 문이
// 하나도 없는 화면입니다. 베타 체험에서 찍어 보고 알았습니다.
//
// `errorElement` 는 **그 아래 전부**를 덮습니다. 그래서 맨 바깥 한 겹에
// 답니다 — 화면마다 달면 반드시 몇 곳이 빠집니다.
const router = createBrowserRouter(
  [
    { path: '/login', element: <Login />, errorElement: <Crashed /> },
    {
      element: <RequireAuth />,
      errorElement: <Crashed />,
      children: [
        { path: '/', element: <Home /> },
        { path: '/project/:projectId/settings/:section', element: <Settings /> },
        { path: '/project/:projectId/settings', element: <Navigate to="role" replace /> },
        { path: '/project/:projectId/kanban', element: <Kanban /> },
        { path: '/project/:projectId/contributions', element: <Contributions /> },
        { path: '/meeting/:meetingId/lobby', element: <Lobby /> },
        { path: '/meeting/:meetingId/review', element: <Review /> },
        { path: '*', element: <Navigate to="/" replace /> },
      ],
    },
  ],
  { basename: '/app' },
);

// 렌더 밖에서 던져진 것 — `setTimeout` 안, 거절된 `await` — 은
// ErrorBoundary 가 못 잡습니다. 그게 대부분입니다.
watchForUncaught();

const container = document.getElementById('root')!;

/**
 * `index.html` 의 껍데기를 **진짜 화면이 나온 뒤에** 걷습니다.
 *
 * ⚠️ "React 가 mount 됐을 때" 가 아닙니다. 로그인 판별이 끝나기 전에는
 *    `RequireAuth` 가 `null` 을 그리므로, mount 를 신호로 삼으면 껍데기를
 *    걷어 놓고 **다시 흰 화면**이 됩니다. 재 봤더니 서버가 느릴 때 그
 *    구간이 3.2초였습니다.
 *
 * ⚠️ 화면마다 걷는 코드를 두면 반드시 몇 곳이 빠집니다(로그인·오류 화면도
 *    있습니다). `#root` 에 자식이 생기는 것 하나만 봅니다 — 어느 화면이든
 *    같은 신호입니다.
 */
function dropBootShell() {
  const boot = document.getElementById('boot');
  if (boot === null) return;
  if (container.childElementCount > 0) {
    boot.remove();
    return;
  }
  const watcher = new MutationObserver(() => {
    if (container.childElementCount > 0) {
      watcher.disconnect();
      boot.remove();
    }
  });
  watcher.observe(container, { childList: true });
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);

dropBootShell();
