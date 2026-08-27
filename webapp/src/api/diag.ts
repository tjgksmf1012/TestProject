import { clientErrorPayload } from '@lib/diag/report.ts';

/**
 * 화면에서 난 일을 서버 로그로 보낸다.
 *
 * ⚠️ **실패해도 아무 일도 안 일어나야 합니다.** 오류 보고가 오류를 내면
 *    그 오류가 다시 보고를 부르고, 그 순간 브라우저가 멈춥니다.
 *    그래서 `.catch(() => {})` 이고, 응답도 안 봅니다.
 * ⚠️ `keepalive` 는 화면이 곧 사라질 때(새로고침·닫기) 요청이 취소되지
 *    않게 합니다 — 마지막 오류가 가장 알고 싶은 것입니다.
 *
 * 무엇을 보낼지(주소에서 `?…` 를 떼는 것 포함)는 `@lib/diag/report.ts`
 * 가 정합니다. 여기는 나르기만 합니다.
 */
export function reportClientError(error: unknown, kind: string): void {
  try {
    const body = JSON.stringify(clientErrorPayload(error, kind, window.location.href));
    void fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* 보고가 화면을 멈추게 두지 않습니다. */
  }
}

/**
 * 아무도 안 잡은 오류를 여기서 줍는다.
 *
 * ⚠️ ErrorBoundary 는 **렌더 중에 던진 것만** 잡습니다. `setTimeout`
 *    안에서 던진 것, `await` 이 거절된 것은 못 잡습니다 — 그게 대부분입니다.
 */
export function watchForUncaught(): void {
  window.addEventListener('error', (e) => reportClientError(e.error ?? e.message, 'error'));
  window.addEventListener('unhandledrejection', (e) =>
    reportClientError(e.reason, 'unhandledrejection'),
  );
}
