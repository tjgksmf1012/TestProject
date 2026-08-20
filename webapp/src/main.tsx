import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { createBrowserRouter, Navigate, Outlet, RouterProvider } from 'react-router-dom';
import { useMe } from './api/hooks.ts';
import { ApiError } from './api/client.ts';
import { sessionIsOver } from '@lib/ui/load.ts';
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

/**
 * ⛔ **세션이 죽으면 그 사실을 `me` 에 반영합니다** (결함 227).
 *
 * 안 그러면 이렇게 됩니다 — 재서 확인한 것입니다:
 *
 *   쿠키가 죽음 → 모든 조회가 401
 *   → 화면은 「로그인이 풀렸습니다. 다시 로그인해 주세요.」 라고 말하는데
 *   → 그 화면에 **로그인으로 가는 링크가 한 개도 없습니다**
 *   → 홈·칸반·설정을 눌러도 라우터가 같은 껍데기 안에서 옮길 뿐
 *   → **36초를 눌러 다녀도** 그대로 (60초쯤에야 `me` 가 낡아 풀립니다)
 *
 * `RequireAuth` 는 `useMe` 를 보는데 그쪽 `staleTime` 이 60초입니다.
 * 그 1분 동안 사람은 **멀쩡해 보이는데 아무것도 안 되는 앱**을 누르고
 * 다니고, 화면이 시킨 「다시 로그인」은 **할 자리가 없습니다.**
 *
 * 그래서 실패를 **한 자리에서** 받습니다. 화면 다섯이 각자 로그인 링크를
 * 그리게 하면 반드시 몇 곳이 빠집니다(이 저장소의 실패 ②).
 *
 * ⚠️ 판단(`sessionIsOver`)은 `@lib` 에 있습니다 — 여기 `main.tsx` 에
 *    적으면 자동 검사가 안 닿습니다.
 * ⚠️ `useMe` 자신의 401 은 여기 안 옵니다 — 그쪽은 queryFn 이 잡아서
 *    `null` 로 **성공**시킵니다("로그인 전" 은 오류가 아니므로).
 */
function endSessionIfOver(error: unknown): void {
  const status = error instanceof ApiError ? error.status : null;
  if (!sessionIsOver(status)) return;
  // `RequireAuth` 가 이 값을 보고 로그인 화면으로 보냅니다.
  queryClient.setQueryData(['me'], null);
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: endSessionIfOver }),
  mutationCache: new MutationCache({ onError: endSessionIfOver }),
  defaultOptions: {
    queries: {
      retry: 1,
      /**
       * ⭐ **창으로 돌아오면 다시 읽습니다.**
       *
       * 여태 `false` 였습니다(SPA 를 세울 때의 기본값 — 왜 그랬는지는
       * 커밋 어디에도 안 적혀 있습니다). 그 동안 화면은 **한 번 읽은
       * 것을 그대로** 들고 있었습니다.
       *
       * 혼자 쓰면 안 보입니다. 둘이 쓰면 보입니다 — 브라우저 둘로 재
       * 봤습니다:
       *
       *   A 가 카드를 「완료」로 옮김
       *   → B 의 칸반은 **20초가 지나도** 그대로였습니다.
       *     새로고침하거나 다른 화면 갔다 와야 바뀌었습니다.
       *
       * 그 상태에서 B 가 같은 카드를 옮기면 A 의 결정을 조용히 덮습니다.
       * 이 제품에서 업무 완료는 **기여도로 들어갑니다.**
       *
       * 검토 화면도 같습니다. B 가 이미 승인된 후보를 다시 승인하면
       * 서버는 (일부러) 멱등이라 업무를 두 개 만들지 않지만, B 에게는
       * "칸반에 등록된 업무는 없습니다" 라고만 보입니다 — 거절했을 때와
       * **같은 문장**이라 무슨 일이 있었는지 알 수 없습니다.
       *
       * 설명을 더하는 것보다 **그 상황이 안 생기게** 하는 쪽이 낫습니다.
       *
       * ⚠️ 화면이 깜빡이지는 않습니다. TanStack 은 다시 읽는 동안 이전
       *    데이터를 그대로 그립니다.
       */
      refetchOnWindowFocus: true,
    },
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
