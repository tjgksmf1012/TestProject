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
const router = createBrowserRouter(
  [
    { path: '/login', element: <Login /> },
    {
      element: <RequireAuth />,
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
