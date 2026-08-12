import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_SERVER,
  allowed,
  escapeHtml,
  offlineNotice,
  safeToOpenOutside,
  sameOrigin,
  serverUrl,
} from './server.ts';

// ══════════════════════════════════════════════════════════════
// 어느 서버를 띄우는가 — 평문은 loopback 에서만
// ══════════════════════════════════════════════════════════════

test('아무것도 안 주면 개발용 로컬 서버', () => {
  assert.equal(serverUrl(undefined).href, DEFAULT_SERVER);
  assert.equal(serverUrl('').href, DEFAULT_SERVER);
  assert.equal(serverUrl('   ').href, DEFAULT_SERVER);
});

test('https 는 어디든 된다', () => {
  assert.equal(serverUrl('https://teamflow.example.com/home.html').protocol, 'https:');
});

test('평문 http 는 loopback 에서만', () => {
  for (const ok of ['http://127.0.0.1:8811/', 'http://localhost:3000/', 'http://[::1]:8811/']) {
    assert.ok(allowed(new URL(ok)), ok);
  }
  // ⚠️ **회의 음성과 세션 쿠키**가 평문으로 나가면 안 됩니다.
  assert.throws(() => serverUrl('http://teamflow.example.com/'), /평문/);
});

test('loopback 처럼 생긴 남의 주소에 속지 않는다', () => {
  // ⚠️ `startsWith('http://127.0.0.1')` 로 재면 이게 **통과합니다.**
  //    호스트 이름으로 봐야 합니다.
  assert.equal(allowed(new URL('http://127.0.0.1.evil.com/')), false);
  assert.throws(() => serverUrl('http://localhost.evil.com/'), /평문/);
});

test('http·https 가 아닌 것은 거절', () => {
  for (const bad of ['file:///etc/passwd', 'data:text/html,x', 'ftp://x/']) {
    assert.equal(allowed(new URL(bad)), false, bad);
  }
});

// ══════════════════════════════════════════════════════════════
// 창이 여기를 벗어나면 안 된다
// ══════════════════════════════════════════════════════════════

const ORIGIN = 'https://teamflow.example.com';

test('같은 곳이면 통과', () => {
  assert.ok(sameOrigin(`${ORIGIN}/kanban.html?project=1`, ORIGIN));
});

test('⭐ 앞이 같다고 통과시키면 안 된다', () => {
  // ⚠️ `startsWith(서버주소)` 로 재면 이 둘이 **통과합니다.**
  assert.equal(sameOrigin('https://teamflow.example.com.evil.com/', ORIGIN), false);
  assert.equal(sameOrigin('https://teamflow.example.com@evil.com/', ORIGIN), false);
});

test('포트·프로토콜이 다르면 다른 곳', () => {
  assert.equal(sameOrigin('http://teamflow.example.com/', ORIGIN), false);
  assert.equal(sameOrigin('https://teamflow.example.com:8443/', ORIGIN), false);
});

test('주소가 아니면 거절', () => {
  assert.equal(sameOrigin('javascript:alert(1)', ORIGIN), false);
  assert.equal(sameOrigin('그냥 글자', ORIGIN), false);
});

// ══════════════════════════════════════════════════════════════
// 바깥 링크는 https 만
// ══════════════════════════════════════════════════════════════

test('바깥으로 보내는 것은 https 뿐', () => {
  assert.ok(safeToOpenOutside('https://github.com/x/y'));
  // ⚠️ `shell.openExternal` 에 아무거나 넘기면 로컬 파일이 열립니다.
  for (const bad of ['file:///etc/passwd', 'http://x/', 'javascript:alert(1)', 'smb://x/']) {
    assert.equal(safeToOpenOutside(bad), false, bad);
  }
});

// ══════════════════════════════════════════════════════════════
// 못 닿았을 때의 한 장
// ══════════════════════════════════════════════════════════════

test('안내에 주소와 사유가 들어간다', () => {
  const html = decodeURIComponent(offlineNotice('http://127.0.0.1:8811/', 'ERR_CONNECTION_REFUSED'));
  assert.ok(html.includes('127.0.0.1:8811'));
  assert.ok(html.includes('ERR_CONNECTION_REFUSED'));
  assert.ok(html.includes('TEAMFLOW_SERVER_URL'), '고치는 방법을 알려 줘야 합니다');
});

test('⭐ 안내가 서버에서 아무것도 안 받아 온다', () => {
  // 서버에 못 닿아서 띄우는 화면입니다. 거기서 무언가를 받아 오면
  // 그 화면도 같이 실패합니다.
  const html = decodeURIComponent(offlineNotice('http://x/', 'why'));
  assert.ok(!/<script|src=|href=/i.test(html), '바깥을 부르는 것이 있습니다');
});

test('안내에 들어가는 글자를 이스케이프한다', () => {
  const html = decodeURIComponent(offlineNotice('http://x/"><script>alert(1)</script>', 'why'));
  assert.ok(!html.includes('<script>alert(1)'), '주소가 그대로 들어갔습니다');
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});
