// 서버와의 유일한 통로. 화면 코드는 fetch 를 직접 부르지 않습니다.
// 세션은 쿠키(same-origin)로 흐릅니다 — 토큰을 어디에도 저장하지 않습니다.

export class ApiError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, '서버에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 시도하세요.');
  }
  if (!res.ok) {
    let detail = `요청이 실패했습니다 (HTTP ${res.status}).`;
    try {
      const data = (await res.json()) as { detail?: unknown };
      if (typeof data.detail === 'string' && data.detail) detail = data.detail;
    } catch {
      // 본문이 JSON 이 아니면 상태 코드 문구를 그대로 씁니다.
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
