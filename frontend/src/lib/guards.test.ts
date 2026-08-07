/**
 * 화면 코드가 지켜야 하는 것들 — 소스를 직접 읽어서 확인한다.
 *
 * `src/demo/*.ts` 에는 자동 테스트가 없습니다. 판단 로직을 전부 `src/lib`
 * 로 뺐기 때문인데, **뺀다고 해서 화면이 그걸 부른다는 보장은 없습니다.**
 * 이 저장소에서 가장 자주 나온 결함이 정확히 그것입니다 — 맞는 함수를
 * 만들어 놓고 아무도 부르지 않는 것.
 *
 * 여기 있는 것은 "이 함수를 쓰라" 가 아니라 **"이 함수를 건너뛰지 마라"**
 * 를 고정합니다. 건너뛰어도 화면은 잘 돌아가고, 예외도 안 나고, 테스트도
 * 통과하기 때문에 사람이 알아챌 방법이 없습니다.
 */

import { strictEqual } from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { bundle, entryPoints } from '../../build.mts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEMO = join(ROOT, 'src', 'demo');
const PUBLIC = join(ROOT, 'public');

const demoFiles = (): { name: string; source: string }[] =>
  readdirSync(DEMO)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, source: readFileSync(join(DEMO, name), 'utf8') }));

/**
 * 주석을 뺀 코드.
 *
 * ⚠️ 이게 없으면 **틀린 예를 적어 둔 주석이 규칙 위반으로 잡힙니다.**
 * 이 저장소의 주석은 대개 "예전에는 이랬다" 를 그대로 적어 두므로,
 * 나쁜 모양을 찾는 규칙은 거의 전부 자기 설명에 걸립니다. 그러면
 * 사람은 규칙을 느슨하게 만들고, 느슨해진 규칙은 진짜를 놓칩니다.
 */
const codeOf = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * 이 모듈이 실제로 붙는 HTML. 진입점이 아니면 null.
 *
 * `main.ts` 만 이름이 다릅니다 — 녹음 화면이 `index.html` 이라서.
 */
function htmlFor(moduleName: string): string | null {
  const stem = moduleName.replace(/\.ts$/, '');
  for (const candidate of [stem === 'main' ? 'index' : stem]) {
    try {
      return readFileSync(join(PUBLIC, `${candidate}.html`), 'utf8');
    } catch {
      return null;
    }
  }
  return null;
}

describe('화면 코드 규칙', () => {
  it('테스트가 볼 화면 파일이 실제로 있다', () => {
    // 경로가 틀리면 아래 테스트들이 전부 "0개 통과" 로 조용히 성공한다.
    strictEqual(demoFiles().length > 0, true);
  });

  it('⭐ `?api=` 를 safeApiBase 없이 읽는 화면이 없다', () => {
    // 그대로 쓰면 링크 하나로 **비밀번호와 회의 음성이 어디로 가는지**가
    // 바뀐다. 피해자는 끝까지 진짜 도메인·진짜 자물쇠·진짜 로그인 화면에
    // 머무르므로 눈으로 알아챌 단서가 없다.
    const offenders = demoFiles()
      .filter(({ source }) => /\.get\(\s*['"]api['"]\s*\)/.test(source))
      .filter(({ source }) => !/safeApiBase\(/.test(source))
      .map(({ name }) => name);
    strictEqual(offenders.join(', '), '');
  });

  it('⭐ `?next=` 를 safeRedirect 없이 읽는 화면이 없다', () => {
    // 열린 리다이렉트. 진짜 도메인에서 로그인한 뒤 남의 사이트로 넘어간다.
    const offenders = demoFiles()
      .filter(({ source }) => /\.get\(\s*['"]next['"]\s*\)/.test(source))
      .filter(({ source }) => !/safeRedirect\(/.test(source))
      .map(({ name }) => name);
    strictEqual(offenders.join(', '), '');
  });

  it('⭐ 화면이 찾는 요소 id 가 HTML 에 전부 있다', () => {
    // `$('start-error')` 처럼 없는 id 를 찾으면 그 자리에서 예외가 나고,
    // 모듈 최상단에서 나므로 **화면 전체가 백지가 된다.** 오타 하나로
    // 그렇게 되는데, 타입 검사도 테스트도 잡지 못한다.
    const problems: string[] = [];
    for (const { name, source } of demoFiles()) {
      const html = htmlFor(name);
      if (html === null) continue; // 진입점이 아닌 모듈(nav.ts 등)
      const ids = new Set(
        [...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]),
      );
      for (const [, id] of source.matchAll(/\$\(\s*'([^']+)'\s*\)/g)) {
        if (!ids.has(id)) problems.push(`${name} → #${id}`);
      }
    }
    strictEqual(problems.join(', '), '');
  });

  it('⭐ innerHTML 에 문자열을 붙이는 화면은 escapeHtml 을 가져온다', () => {
    // 회의 제목·업무 제목은 LLM 이 발화에서 만든 문자열이다. 사람이 회의
    // 중에 태그처럼 생긴 말을 하면 그게 그대로 들어온다.
    const offenders = demoFiles()
      .filter(({ source }) => /innerHTML\s*=/.test(source))
      .filter(({ source }) => !/escapeHtml/.test(source))
      .map(({ name }) => name);
    strictEqual(offenders.join(', '), '');
  });
});

describe('모바일 규칙', () => {
  const screens = (): { name: string; html: string }[] =>
    readdirSync(PUBLIC)
      .filter((name) => name.endsWith('.html'))
      .map((name) => ({ name, html: readFileSync(join(PUBLIC, name), 'utf8') }));

  it('테스트가 볼 화면이 실제로 있다', () => {
    strictEqual(screens().length >= 8, true);
  });

  it('⭐ 모든 화면이 공통 스타일을 가져온다', () => {
    // 안 가져오면 그 화면만 데스크톱 값으로 돌아간다 — 터치 타깃도,
    // safe-area 도, 탭바 자리도 없어진다.
    const missing = screens()
      .filter(({ html }) => !html.includes('href="/app.css"'))
      .map(({ name }) => name);
    strictEqual(missing.join(', '), '');
  });

  it('⭐ 모든 화면이 노치 뒤까지 그린다 (viewport-fit=cover)', () => {
    // 이게 없으면 `env(safe-area-inset-*)` 가 전부 0 이 되고, 아래 고정
    // 버튼이 홈 인디케이터에 가려 **안 눌린다.**
    const missing = screens()
      .filter(({ html }) => !html.includes('viewport-fit=cover'))
      .map(({ name }) => name);
    strictEqual(missing.join(', '), '');
  });

  it('⭐ 로그인 말고는 전부 아래 탭바가 있다', () => {
    // 전체화면 PWA·WebView 에는 주소창도 뒤로가기도 없다. 탭바가 없으면
    // 그 화면은 정말 막다른 길이 된다.
    // 로그인은 아직 어느 프로젝트 사람인지도 모르고, 오프라인 화면은
    // 연결이 없어서 어디로도 갈 수 없다 — 둘 다 탭이 죽은 링크가 된다.
    const exempt = new Set(['login.html', 'offline.html']);
    const missing = screens()
      .filter(({ name }) => !exempt.has(name))
      .filter(({ html }) => !html.includes('id="tabs"'))
      .map(({ name }) => name);
    strictEqual(missing.join(', '), '');
  });

  it('⭐ 탭바가 있는 화면은 그것을 **채운다** (결함 47)', () => {
    // 위 테스트는 `<nav id="tabs">` 가 HTML 에 있는지만 봤습니다. 홈은
    // 그 요소를 갖고 있으면서 `renderNav` 를 안 불렀고, 그래서 탭바가
    // **빈 채로** 남았습니다 — 폰에서는 아래 여백처럼 보여서 아무도
    // 몰랐고, PC 로 옮기고 나서야 화면 위에 빈 줄로 드러났습니다.
    //
    // 이 저장소가 반복해서 당한 방식 그대로입니다: 맞는 함수를 만들어
    // 놓고 아무도 부르지 않는 것. 그러니 요소가 아니라 **호출**을 셉니다.
    const offenders: string[] = [];
    for (const { name, html } of screens()) {
      if (!html.includes('id="tabs"')) continue;
      const script = html.match(/<script[^>]*\ssrc="\.?\/([A-Za-z0-9_-]+)\.js"/)?.[1];
      if (script === undefined) {
        offenders.push(`${name} → 모듈 스크립트가 없다`);
        continue;
      }
      const source = readFileSync(join(DEMO, `${script}.ts`), 'utf8');
      if (!/renderNav\(/.test(source)) offenders.push(`${name} → ${script}.ts`);
    }
    strictEqual(offenders.join(', '), '');
  });

  it('⭐ 서버 오류를 `detail` 째로 화면에 넣지 않는다 (결함 51)', () => {
    // FastAPI 는 `detail` 을 두 모양으로 줍니다.
    //
    //     HTTPException  → "저장소가 연결되지 않았습니다"   ← 문자열
    //     검증 실패(422) → [{loc, msg, type}, ...]          ← **객체 배열**
    //
    // 화면 여섯 곳이 `as { detail?: string }` 로 단언하고 그대로
    // `textContent` 에 넣고 있었습니다. 422 가 오면 전부
    // **`[object Object]`** 가 됩니다. 타입 단언은 런타임에 아무것도
    // 확인하지 않으므로 `tsc` 는 조용합니다.
    //
    // 실제 브라우저에서 422 를 받아 보기 전에는 아무 데도 티가 안 났습니다.
    const offenders = demoFiles()
      .filter(({ source }) => /detail\?\s*:\s*string/.test(codeOf(source)))
      .map(({ name }) => name);
    strictEqual(offenders.join(', '), '');
  });

  it('⭐ 헤더를 객체로 겹쳐 쓰지 않는다 (결함 50)', () => {
    // 자바스크립트 객체 키는 대소문자를 구분하고 **HTTP 헤더는 안
    // 합니다.** 이 모양이 그래서 위험합니다.
    //
    //     headers: { 'Content-Type': 'application/json', ...init?.headers }
    //
    // 호출부가 `content-type`(소문자)을 주면 두 키가 **둘 다 살아남아**
    // `Content-Type: application/json, application/json` 이 나갑니다.
    // FastAPI 는 그걸 JSON 으로 안 보고 422 를 줍니다.
    //
    // 규칙을 사람이 지키게 하는 대신 `new Headers()` 를 쓰게 합니다 —
    // 그건 이름을 대소문자 무시로 다루므로 겹칠 수가 없습니다.
    const offenders = demoFiles()
      .filter(({ source }) =>
        /headers:\s*\{[^}]*\.\.\.\s*\(?\s*init\?\.headers/.test(codeOf(source)),
      )
      .map(({ name }) => name);
    strictEqual(offenders.join(', '), '');
  });

  it('⭐ 화면이 공통 토큰을 다시 정의하지 않는다', () => {
    // app.css 보다 뒤에 오므로 다시 정의하면 **공통 값이 통째로 덮인다.**
    // 폰 기준으로 짠 색·간격이 화면마다 제각각으로 돌아간다.
    const owned = ['--line', '--dim', '--accent', '--bg', '--surface', '--text'];
    const offenders: string[] = [];
    for (const { name, html } of screens()) {
      const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
      for (const block of style.matchAll(/:root\s*\{([^}]*)\}/g)) {
        for (const token of owned) {
          if (new RegExp(`${token}\\s*:`).test(block[1] ?? '')) {
            offenders.push(`${name} → ${token}`);
          }
        }
      }
    }
    strictEqual(offenders.join(', '), '');
  });

  it('⭐ 입력 칸 글자를 16px 밑으로 내리지 않는다', () => {
    // iOS Safari 는 글자가 16px 보다 작은 입력 칸에 포커스가 가면 화면을
    // 확대하고, **확대된 채로 돌아오지 않는다.** 사람은 앱이 깨졌다고
    // 느낀다. 0.9375rem = 15px 이 딱 그 함정이다.
    const offenders: string[] = [];
    for (const { name, html } of screens()) {
      const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
      for (const rule of style.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
        const selector = (rule[1] ?? '').trim();
        if (!/\binput\b|\btextarea\b|\bselect\b/.test(selector)) continue;
        const size = (rule[2] ?? '').match(/font-size:\s*([\d.]+)(rem|px|em)/);
        if (!size) continue;
        const px = size[2] === 'px' ? Number(size[1]) : Number(size[1]) * 16;
        if (px < 16) offenders.push(`${name} → ${selector} (${px}px)`);
      }
    }
    strictEqual(offenders.join(', '), '');
  });
});

describe('아래 고정 요소', () => {
  it('⭐ 탭바와 겹치는 고정 요소가 없다', () => {
    // `position: fixed; bottom: 0` 을 쓰면 탭바 **밑에** 깔린다.
    // 승인 화면의 제출 버튼이 그랬다 — 화면에 보이는데 안 눌린다.
    // 아래에 붙이는 것은 app.css 의 `.actionbar` 를 써야 한다.
    const offenders: string[] = [];
    for (const name of readdirSync(PUBLIC).filter((n) => n.endsWith('.html'))) {
      const style =
        readFileSync(join(PUBLIC, name), 'utf8').match(/<style>([\s\S]*?)<\/style>/)?.[1] ??
        '';
      for (const rule of style.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
        const body = rule[2] ?? '';
        if (!/position:\s*fixed/.test(body)) continue;
        if (/bottom:\s*0/.test(body)) {
          offenders.push(`${name} → ${(rule[1] ?? '').trim()}`);
        }
      }
    }
    strictEqual(offenders.join(', '), '');
  });

  it('⭐ 아래 고정 막대를 쓰는 화면은 본문 여백을 확보한다', () => {
    // 안 하면 마지막 카드가 막대에 가려 **영원히 안 보인다.**
    const offenders: string[] = [];
    for (const name of readdirSync(PUBLIC).filter((n) => n.endsWith('.html'))) {
      const html = readFileSync(join(PUBLIC, name), 'utf8');
      if (!/class="actionbar"/.test(html)) continue;
      if (!/<body[^>]*class="[^"]*has-actionbar/.test(html)) offenders.push(name);
    }
    strictEqual(offenders.join(', '), '');
  });
});

describe('앱 껍데기 배선', () => {
  /** 화면 진입점 — HTML 이 `<script>` 로 부르는 모듈들. */
  const entries = (): { name: string; source: string }[] =>
    demoFiles().filter(({ name }) => htmlFor(name) !== null);

  it('진입점을 실제로 찾았다', () => {
    strictEqual(entries().length >= 8, true);
  });

  it('⭐ 모든 진입점이 bootApp 을 부른다', () => {
    // 안 부르면 서비스 워커가 등록되지 않고 `sw.js` 는 그냥 저장소에
    // 놓인 파일이 된다. 오프라인 화면도, 설치 안내도 안 뜬다 —
    // 그런데 **오류는 하나도 안 난다.**
    const missing = entries()
      .filter(({ source }) => !/\bbootApp\(\)/.test(source))
      .map(({ name }) => name);
    strictEqual(missing.join(', '), '');
  });

  it('⭐ 서비스 워커가 캐시하는 파일이 전부 실재한다', () => {
    // 없는 파일을 캐시 목록에 두면 그 항목만 조용히 실패한다.
    // 특히 **오프라인 화면이 없으면** 지하철에서 흰 화면이 뜨고,
    // 사람은 앱이 죽었다고 생각한다.
    const sw = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');
    const list = sw.match(/const SHELL = \[([\s\S]*?)\];/)?.[1] ?? '';
    const urls = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
    strictEqual(urls.length > 0, true);

    const missing = urls.filter((url) => {
      try {
        readFileSync(join(PUBLIC, url.replace(/^\//, '')));
        return false;
      } catch {
        return true;
      }
    });
    strictEqual(missing.join(', '), '');
  });

  it('⭐ 서비스 워커가 API 응답을 캐시하지 않는다', () => {
    // 이건 성능이 아니라 안전이다. 동의를 철회하면 서버가 회의 자료를
    // 지우는데(docs/07 P6), 캐시에 남아 있으면 **지운 뒤에도 폰에서
    // 계속 보인다.** 기여도도 지난 값을 지금 값처럼 보여주면 안 된다.
    const sw = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');
    strictEqual(/startsWith\('\/api\/'\)/.test(sw), true);
    // 캐시 목록에 API 경로가 섞여 있으면 위 검사를 지나도 소용없다.
    const list = sw.match(/const SHELL = \[([\s\S]*?)\];/)?.[1] ?? '';
    strictEqual(list.includes('/api/'), false);
  });

  it('⭐ manifest 가 가리키는 아이콘이 전부 실재한다', () => {
    // 없으면 홈 화면에 추가했을 때 **화면 캡처가 아이콘이 된다.**
    const manifest = JSON.parse(
      readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8'),
    ) as { icons: { src: string }[]; start_url: string };

    const missing = manifest.icons
      .map((icon) => icon.src)
      .filter((src) => {
        try {
          readFileSync(join(PUBLIC, src.replace(/^\//, '')));
          return false;
        } catch {
          return true;
        }
      });
    strictEqual(missing.join(', '), '');
  });

  it('⭐ manifest 의 start_url 이 실재하는 화면이다', () => {
    // 없는 곳을 가리키면 설치한 앱이 **404 로 열린다.**
    const manifest = JSON.parse(
      readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8'),
    ) as { start_url: string };
    readFileSync(join(PUBLIC, manifest.start_url.replace(/^\//, '')));
  });

  it('⭐ 화면이 가리키는 apple-touch-icon 이 실재한다', () => {
    // iOS 는 SVG 를 받지 않는다. PNG 가 없으면 홈 화면 아이콘이 없다.
    const problems: string[] = [];
    for (const name of readdirSync(PUBLIC).filter((n) => n.endsWith('.html'))) {
      const html = readFileSync(join(PUBLIC, name), 'utf8');
      const icon = html.match(/rel="apple-touch-icon"\s+href="([^"]+)"/)?.[1];
      if (!icon) {
        problems.push(`${name} → 없음`);
        continue;
      }
      if (!icon.endsWith('.png')) problems.push(`${name} → ${icon} (PNG 아님)`);
      try {
        readFileSync(join(PUBLIC, icon.replace(/^\//, '')));
      } catch {
        problems.push(`${name} → ${icon} (파일 없음)`);
      }
    }
    strictEqual(problems.join(', '), '');
  });
});

// ══════════════════════════════════════════════════════════════
// 빌드된 번들이 소스와 같은가
//
// ⚠️ **테스트는 `src/` 를 읽고, 브라우저는 `public/*.js` 를 받습니다.**
//
// 그래서 소스를 고치고 빌드를 안 하면 이런 일이 벌어집니다 — 테스트는
// 전부 통과하고, 타입 검사도 통과하고, 화면은 **고치기 전 코드로**
// 돕니다. 어디에도 오류가 안 납니다. 이 저장소가 반복해서 당한 부류이고,
// 이 구역을 만들게 된 것도 실제로 한 번 그렇게 됐기 때문입니다.
// ══════════════════════════════════════════════════════════════

describe('빌드된 번들', () => {
  it('⭐ public 의 번들이 지금 소스로 빌드한 것과 같다', async () => {
    // 다르면 화면은 옛 코드로 돕니다. `npm run build:demo` 를 잊은 것입니다.
    const fresh = await bundle();
    const stale: string[] = [];
    for (const [name, text] of fresh) {
      let onDisk: string;
      try {
        onDisk = readFileSync(join(PUBLIC, name), 'utf8');
      } catch {
        stale.push(`${name} (없음)`);
        continue;
      }
      if (onDisk !== text) stale.push(name);
    }
    strictEqual(
      stale.join(', '),
      '',
      `번들이 소스와 다릅니다 — \`npm run build:demo\` 를 실행하세요: ${stale.join(', ')}`,
    );
  });

  it('⭐ 화면이 부르는 스크립트마다 소스가 있다', () => {
    // 없으면 그 화면은 404 를 받고 **아무 동작도 하지 않습니다.**
    const missing = entryPoints().filter((path: string) => {
      try {
        readFileSync(path);
        return false;
      } catch {
        return true;
      }
    });
    strictEqual(missing.join(', '), '');
  });

  it('⭐ 진입점 수를 세는 방식이 화면 수와 맞는다', () => {
    // 손으로 적은 목록은 화면을 더할 때 빠집니다. 세는 쪽이 맞는지 확인합니다.
    const withScript = readdirSync(PUBLIC)
      .filter((n) => n.endsWith('.html'))
      .filter((n) => /<script[^>]*\ssrc="\.?\/[A-Za-z0-9_-]+\.js"/.test(
        readFileSync(join(PUBLIC, n), 'utf8'),
      ));
    strictEqual(entryPoints().length, withScript.length);
  });
});

// ══════════════════════════════════════════════════════════════
// hidden 이 실제로 가리는가
// ══════════════════════════════════════════════════════════════

describe('hidden', () => {
  it('⭐ app.css 가 [hidden] 을 무력화하지 않게 못 박는다', () => {
    // ⚠️ **작성자 스타일은 언제나 브라우저 기본을 이깁니다.** 특성도와
    // 무관합니다. 그래서 `label { display: block }` 하나만 있어도
    // `[hidden] { display: none }`(브라우저 기본)이 통째로 무력해집니다.
    //
    // 실제로 그랬고, **브라우저로 화면을 띄워 보고서야** 알았습니다 —
    // 로비의 "강제 종료" 가 항상 보이고 있었습니다.
    const css = readFileSync(join(PUBLIC, 'app.css'), 'utf8');
    const rule = /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/;
    strictEqual(
      rule.test(css),
      true,
      'app.css 에 `[hidden] { display: none !important }` 가 있어야 합니다. ' +
        '없으면 화면이 숨긴 요소가 그대로 보입니다.',
    );
  });

  it('⭐ 화면별 <style> 이 그 규칙을 되돌리지 않는다', () => {
    // 화면 안에서 `[hidden]` 에 display 를 다시 주면 그 화면만 조용히
    // 깨집니다. 전체를 다시 확인할 방법이 없으니 아예 못 쓰게 합니다.
    const offenders: string[] = [];
    for (const name of readdirSync(PUBLIC).filter((n) => n.endsWith('.html'))) {
      const html = readFileSync(join(PUBLIC, name), 'utf8');
      if (/\[hidden\][^{]*\{[^}]*display:\s*(?!none)/.test(html)) offenders.push(name);
    }
    strictEqual(offenders.join(', '), '');
  });
});

// ══════════════════════════════════════════════════════════════
// CSS 변수가 실제로 정의돼 있는가
// ══════════════════════════════════════════════════════════════

describe('CSS 토큰', () => {
  it('⭐ 화면이 쓰는 var(--x) 가 전부 정의돼 있다', () => {
    // ⚠️ 정의되지 않은 변수를 쓰면 **그 선언 전체가 무효**가 됩니다.
    // 오류도 경고도 없고, 그 자리만 조용히 사라집니다.
    //
    // 실제로 그랬습니다. `--bar` 가 아무 데도 없어서
    // `background: var(--bar)` 가 통째로 무시됐고, **기여도 화면의 구간
    // 막대가 전부 투명**이었습니다 — 그 화면의 주인공인데도요.
    // 브라우저로 띄워 보고서야 알았습니다.
    // ⚠️ 토큰의 원본은 `tokens.css` 입니다. `app.css` 만 읽으면
    // 정의된 것을 못 찾아 전부 위반으로 잡힙니다.
    const defined = new Set(
      ['tokens.css', 'app.css'].flatMap((file) =>
        [...readFileSync(join(PUBLIC, file), 'utf8').matchAll(/(--[a-z0-9-]+)\s*:/g)].map(
          (m) => m[1] as string,
        ),
      ),
    );

    const problems: string[] = [];
    for (const name of readdirSync(PUBLIC).filter((n) => n.endsWith('.html'))) {
      const html = readFileSync(join(PUBLIC, name), 'utf8');
      // 그 화면이 스스로 정의한 것도 인정한다.
      const local = new Set(
        [...html.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] as string),
      );
      for (const [, used] of html.matchAll(/var\((--[a-z0-9-]+)/g)) {
        if (!defined.has(used as string) && !local.has(used as string)) {
          problems.push(`${name} → ${used}`);
        }
      }
    }
    strictEqual(
      [...new Set(problems)].join(', '),
      '',
      '정의되지 않은 CSS 변수를 씁니다. 그 선언은 조용히 사라집니다',
    );
  });

  it('⭐ 공용 CSS 스스로도 없는 변수를 쓰지 않는다', () => {
    const files = ['tokens.css', 'app.css'].map((f) => readFileSync(join(PUBLIC, f), 'utf8'));
    const defined = new Set(
      files.flatMap((css) =>
        [...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] as string),
      ),
    );
    const missing = [
      ...new Set(
        files.flatMap((css) =>
          [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1] as string),
        ).filter((name) => !defined.has(name)),
      ),
    ];
    strictEqual(missing.join(', '), '');
  });

  it('⭐ 화면이 tokens.css 를 app.css 보다 **먼저** 불러온다', () => {
    // 순서가 뒤집히면 app.css 의 별칭(`--dim: var(--text-subtle)`)이
    // 아직 없는 값을 참조합니다. CSS 변수는 선언 시점이 아니라 사용
    // 시점에 풀리므로 대부분 살아남지만, 캐스케이드가 얽히면
    // **조용히 빈 값**이 됩니다.
    const problems: string[] = [];
    for (const name of readdirSync(PUBLIC).filter((n) => n.endsWith('.html'))) {
      const html = readFileSync(join(PUBLIC, name), 'utf8');
      const t = html.indexOf('tokens.css');
      const a = html.indexOf('app.css');
      if (t === -1) problems.push(`${name} → tokens.css 를 안 부름`);
      else if (a !== -1 && t > a) problems.push(`${name} → 순서가 뒤집힘`);
    }
    strictEqual(problems.join(', '), '');
  });

  it('⭐ 어두운 모드에서도 같은 토큰이 정의된다', () => {
    // 밝은 쪽에만 있는 색이 있으면 어두운 모드에서 그 자리가 사라집니다.
    const css = readFileSync(join(PUBLIC, 'tokens.css'), 'utf8');
    const dark = css.slice(css.indexOf('prefers-color-scheme: dark'));
    const darkTokens = new Set(
      [...dark.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] as string),
    );
    // ⚠️ **Layer 1 원시값만** 봅니다. Layer 2 의미 이름은 모드마다
    // 바뀌면 안 됩니다 — 바뀌면 화면 코드가 모드별로 갈라지고,
    // 그러면 한쪽에서만 깨집니다.
    for (const name of ['--ink-900', '--ink-700', '--ink-500', '--ink-300',
                        '--ink-200', '--ink-100', '--ink-050', '--ink-000',
                        '--teal-700', '--teal-100', '--clay-600', '--clay-100',
                        '--green-700', '--amber-800', '--red-700']) {
      strictEqual(darkTokens.has(name), true, `어두운 모드에 ${name} 이 없습니다`);
    }
  });
});
