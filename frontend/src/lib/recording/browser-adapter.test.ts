/**
 * 어댑터 중 **fetch 만 쓰는 부분**의 테스트.
 *
 * `BrowserMediaAdapter` 는 `getUserMedia`/`MediaRecorder` 가 있어야 해서 여기서
 * 검증할 수 없다. 하지만 HTTP 전송기 둘은 DOM 을 전혀 건드리지 않으므로
 * Node 의 전역 `fetch` 를 갈아끼우면 그대로 돌아간다.
 *
 * 여기서 지키는 건 **서버와의 계약**이다. 백엔드가 요구하는 헤더 하나가
 * 빠져 있으면 400 이 나는데, 그건 실기기에서야 알게 된다.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { HttpSyncTransport, HttpUploadTransport } from './browser-adapter.ts';

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

const originalFetch = globalThis.fetch;

/** 전역 fetch 를 가로채고 호출을 기록한다. */
function stubFetch(response: { ok: boolean; status?: number; json?: unknown }): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      json: async () => response.json,
    } as Response;
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

describe('HttpUploadTransport', () => {
  it('⭐ 청크 도착 시각을 X-Client-At-Ms 로 보낸다', async () => {
    // 이게 빠지면 서버가 400 을 준다. 시각이 없으면 공백을 절대 시각으로
    // 복원할 수 없기 때문이다 (backend api/main.py put_chunk).
    const calls = stubFetch({ ok: true });
    await new HttpUploadTransport('/api/meetings/7/tracks/3').send({
      seq: 12,
      byteLength: 20_000,
      atMs: 1_700_000_060_000,
      payload: 'blob',
    });

    assert.equal(calls.length, 1);
    assert.equal(headerOf(calls[0]!.init, 'X-Client-At-Ms'), '1700000060000');
  });

  it('seq 를 URL 경로에 넣는다 — 같은 seq 는 같은 주소다', async () => {
    const calls = stubFetch({ ok: true });
    await new HttpUploadTransport('/api/meetings/7/tracks/3').send({
      seq: 12,
      byteLength: 1,
      atMs: 1,
      payload: 'x',
    });
    assert.equal(calls[0]!.url, '/api/meetings/7/tracks/3/chunks/12');
  });

  it('PUT 을 쓴다 — 재시도가 안전해야 한다', async () => {
    const calls = stubFetch({ ok: true });
    await new HttpUploadTransport('/t').send({ seq: 0, byteLength: 1, atMs: 1, payload: 'x' });
    assert.equal(calls[0]!.init?.method, 'PUT');
  });

  it('실패하면 던진다 — 업로드 큐가 재시도할 수 있도록', async () => {
    stubFetch({ ok: false, status: 503 });
    await assert.rejects(
      () => new HttpUploadTransport('/t').send({ seq: 0, byteLength: 1, atMs: 1, payload: 'x' }),
      /503/,
    );
  });

  it('추가 헤더(인증 등)를 함께 보낸다', async () => {
    const calls = stubFetch({ ok: true });
    await new HttpUploadTransport('/t', { Authorization: 'Bearer abc' }).send({
      seq: 0,
      byteLength: 1,
      atMs: 1,
      payload: 'x',
    });
    assert.equal(headerOf(calls[0]!.init, 'Authorization'), 'Bearer abc');
    assert.equal(headerOf(calls[0]!.init, 'Content-Type'), 'application/octet-stream');
  });
});

describe('HttpSyncTransport', () => {
  it('서버가 준 t1/t2 를 그대로 돌려준다', async () => {
    stubFetch({ ok: true, json: { t1: 1_700_000_000_010, t2: 1_700_000_000_012 } });
    const result = await new HttpSyncTransport().probe();
    assert.deepEqual(result, { t1: 1_700_000_000_010, t2: 1_700_000_000_012 });
  });

  it('⭐ 캐시를 끈다 — 캐시되면 동기화가 통째로 무의미해진다', async () => {
    const calls = stubFetch({ ok: true, json: { t1: 1, t2: 2 } });
    await new HttpSyncTransport().probe();
    assert.equal(calls[0]!.init?.cache, 'no-store');
  });

  it('백엔드 경로와 일치한다', async () => {
    const calls = stubFetch({ ok: true, json: { t1: 1, t2: 2 } });
    await new HttpSyncTransport('https://api.example.com').probe();
    assert.equal(calls[0]!.url, 'https://api.example.com/api/time');
  });

  it('실패하면 던져서 그 표본을 버리게 한다', async () => {
    stubFetch({ ok: false, status: 502 });
    await assert.rejects(() => new HttpSyncTransport().probe(), /502/);
  });
});
