/**
 * 모든 모듈이 실제로 불러와지는지 확인한다.
 *
 * 브라우저 어댑터는 로직 테스트가 없다 — 브라우저가 없으니 당연하다.
 * 그래도 **문법이 깨지는 것만은** 여기서 잡힌다. 그것만 해도 값어치가 있다.
 * (Node 의 타입 스트리핑은 enum·namespace·생성자 파라미터 프로퍼티를
 * 거부한다. 어댑터에 무심코 쓰면 브라우저에서야 알게 된다.)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('모듈 로딩', () => {
  it('배럴에서 핵심 심볼이 전부 나온다', async () => {
    const api = await import('./index.ts');
    for (const name of [
      'RecordingClient',
      'ClockTracker',
      'UploadQueue',
      'buildTimeline',
      'judgeTrack',
      'reduce',
      'blockers',
      'pickMimeType',
      'checkAppliedSettings',
      'estimateClock',
      'backoffDelay',
    ]) {
      assert.equal(typeof api[name as keyof typeof api], 'function', `${name} 이 없다`);
    }
  });

  it('브라우저 어댑터도 문법 오류 없이 로딩된다', async () => {
    const adapter = await import('./browser-adapter.ts');
    assert.equal(typeof adapter.BrowserMediaAdapter, 'function');
    assert.equal(typeof adapter.HttpSyncTransport, 'function');
    assert.equal(typeof adapter.HttpUploadTransport, 'function');
    assert.equal(typeof adapter.keepScreenAwake, 'function');
  });

  it('어댑터를 불러오는 것만으로 브라우저 API 를 건드리지 않는다', async () => {
    // 모듈 최상위에서 navigator/document 를 만지면 SSR 에서 터진다.
    // Next.js 는 서버에서 한 번 렌더하므로 이건 실제 위험이다.
    await assert.doesNotReject(() => import('./browser-adapter.ts'));
  });
});
