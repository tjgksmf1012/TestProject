/**
 * 데스크톱 셸이 **어느 서버를 띄우는가** — 판단만.
 *
 * ## ⚠️ 왜 `electron/` 이 아니라 여기 있는가
 *
 * 이 저장소는 판단을 `src/lib/**` 에 두고 화면은 그리기만 합니다. 검사가
 * `src/lib/**\/*.test.ts` 를 훑기 때문입니다 — `electron/` 에 두면 그
 * 판단은 **검증 밖으로 나갑니다.**
 *
 * Electron main 은 창을 열고 OS 를 만지는 자리이고, 거기 있는 코드는
 * 자동 검사가 안 붙습니다. 그래서 "무엇이 허용된 주소인가" 같은 판단은
 * 여기에 두고 main 은 그것을 부르기만 합니다.
 */

/** 아무 주소도 안 주면 여기. 개발용 로컬 서버입니다. */
export const DEFAULT_SERVER = 'http://127.0.0.1:8811/home.html';

/**
 * 띄워도 되는 주소인가. 아니면 던집니다.
 *
 * ## ⚠️ 평문 http 는 loopback 에서만
 *
 * 안드로이드 셸이 같은 규칙을 씁니다 —
 * `network_security_config.xml` 이 `cleartextTrafficPermitted` 를 기본
 * 거짓으로 두고 개발용 호스트만 예외로 엽니다. **회의 음성과 세션 쿠키**
 * 가 평문으로 나가면 안 되고, 그건 셸이 무엇이든 같습니다.
 *
 * ⚠️ 주소를 코드에 박지 않습니다. 팀마다 서버가 다르고, 박아 두면 다른
 * 팀은 앱을 다시 빌드해야 합니다.
 */
export function serverUrl(raw?: string | null): URL {
  const url = new URL((raw ?? '').trim() || DEFAULT_SERVER);
  if (!allowed(url)) {
    throw new Error(
      `평문 http는 loopback에서만 됩니다: ${url.origin} — https를 쓰십시오`,
    );
  }
  return url;
}

/**
 * ⚠️ **호스트 이름으로 봅니다.** `http://127.0.0.1.evil.com` 같은 것을
 * `startsWith('http://127.0.0.1')` 로 거르면 통과합니다.
 */
export function allowed(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
}

/**
 * 서버에 못 닿았을 때 띄우는 한 장.
 *
 * ⚠️ **서버에서 받아 오지 않습니다.** 서버에 못 닿아서 띄우는 화면인데
 * 서버에서 받으면 앞뒤가 안 맞습니다. 파일로 두면 그 파일이 또 오프라인
 * 목록과 갈라집니다(대표 실패 ②). `data:` 로 만들어 씁니다.
 *
 * ⚠️ **주소와 사유를 이스케이프합니다.** 둘 다 바깥에서 온 문자열입니다.
 */
export function offlineNotice(url: string, why: string): string {
  const body = `<!doctype html><html lang="ko"><meta charset="utf-8">
<title>서버에 닿지 못했습니다</title>
<style>body{font:15px/1.7 system-ui,sans-serif;margin:0;display:grid;place-items:center;
min-height:100vh;background:#faf9f7;color:#2b2a28}main{max-width:34rem;padding:2rem}
code{background:#eeece8;padding:.1em .35em;border-radius:.25em;word-break:break-all}</style>
<main><h1>서버에 닿지 못했습니다</h1>
<p>이 앱은 팀 서버의 화면을 띄웁니다. 서버가 꺼져 있거나 주소가 다릅니다.</p>
<p>주소: <code>${escapeHtml(url)}</code><br>사유: <code>${escapeHtml(why)}</code></p>
<p>주소는 <code>TEAMFLOW_SERVER_URL</code> 환경 변수로 바꿉니다.</p></main></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(body)}`;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/**
 * 이 창이 이 주소로 가도 되는가.
 *
 * ⚠️ **origin 으로 봅니다.** `startsWith(서버주소)` 로 재면
 * `https://our-server.evil.com` 이 통과합니다.
 */
export function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * 바깥 링크를 기본 브라우저로 보내도 되는가.
 *
 * ⚠️ **https 만.** `shell.openExternal` 에 아무 문자열이나 넘기면 `file:`
 * 로 로컬 파일을, 윈도우에서는 그보다 나쁜 것을 열 수 있습니다.
 */
export function safeToOpenOutside(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
