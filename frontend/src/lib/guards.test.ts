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

  it('⭐ 공용 CSS 가 화면이 쓰는 이름을 뺏지 않는다 (결함 55·56)', () => {
    // 같은 턴에 두 번 당했습니다.
    //
    //   `#members`  로비의 참가자 목록이 **기여도 카드용 격자**를 물려받아
    //               두 명씩 나란히 놓였습니다
    //   `.range`    기여도의 "33~50%" **문단**에 새 막대 규칙(height 8px,
    //               overflow hidden)이 걸려 숫자가 통째로 사라졌습니다
    //
    // 둘 다 원인이 같습니다 — 공용 CSS 에 규칙을 새로 넣을 때, 그 이름을
    // 화면이 **이미 다른 뜻으로** 쓰고 있었습니다. id 와 클래스는 화면마다
    // 자유롭게 붙지만 공용 CSS 는 전 화면에 걸립니다.
    //
    // 여기서는 **공용 CSS 가 id 선택자로 레이아웃을 걸지 않는가**만
    // 봅니다. id 는 화면 하나의 것이라는 기대로 붙는데 공용 규칙이
    // 거기 걸리면 다른 화면이 조용히 물려받습니다.
    // `#tabs` 는 예외입니다 — **전 화면이 같은 뜻으로 쓰는 유일한 id**
    // 입니다. `renderNav` 가 화면마다 정확히 하나를 채우고, 그 하나가
    // 모든 화면에서 같은 것(아래 탭바)입니다. 이건 이름이 겹쳐서 생긴
    // 사고가 아니라 의도한 공용 요소입니다.
    const GLOBAL_IDS = new Set(['#tabs']);
    const css = readFileSync(join(PUBLIC, 'app.css'), 'utf8');
    const layout = /#([a-z][a-z0-9-]*)\s*\{[^}]*display:\s*(grid|flex)/g;
    const offenders = [...css.matchAll(layout)]
      .map((m) => `#${m[1]}`)
      .filter((id) => !GLOBAL_IDS.has(id));
    strictEqual(
      [...new Set(offenders)].join(', '),
      '',
      '공용 CSS 가 id 에 레이아웃을 겁니다. 역할 클래스로 바꾸세요',
    );
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

describe('상태 화면 (지시서 §7)', () => {
  /** 목록을 **비동기로 채우는** 그릇. 화면과 그 그릇의 id. */
  const ASYNC_CONTAINERS: [string, string][] = [
    ['home.ts', 'projects'],
    ['contributions.ts', 'members'],
    ['kanban.ts', 'board'],
    ['review.ts', 'list'],
    ['lobby.ts', 'roster'],
  ];

  /**
   * "…중" 문구를 HTML 에 적어 두는 것이 **정당한** 자리.
   *
   * 규칙은 "요청 응답이 곧바로 덮어쓰는가" 입니다. 덮어쓰면 깜빡임이고,
   * 사람이 기다려야 하는 진짜 상태면 적어 두는 것이 맞습니다.
   */
  const SLOW_ON_PURPOSE = new Map([
    ['call.html#summary', 'WebRTC 연결은 실제로 몇 초 걸린다 — 요청 응답이 아니다'],
    ['call.html#mic', '마이크 권한은 사람이 눌러야 끝난다'],
    ['index.html#phase', '녹음기 상태 라벨이다 — 요청이 아니라 상태다'],
  ]);

  it('⭐ 정적 "불러오는 중…" 을 HTML 에 심어 두지 않는다', () => {
    // 심어 두면 **언제나** 한 번 깜빡입니다 — 대부분의 요청은 200ms
    // 안에 끝나기 때문입니다. 깜빡임은 아무것도 안 보여주는 것보다
    // 나쁩니다 (지시서 §4.7).
    //
    // 실제로 홈·로비·프로젝트 설정이 그랬습니다. 화면을 열 때마다
    // "불러오는 중…" 이 한 프레임 스쳤고, 아무도 버그로 세지 않았습니다.
    const offenders: string[] = [];
    for (const name of readdirSync(PUBLIC).filter((n) => n.endsWith('.html'))) {
      const html = readFileSync(join(PUBLIC, name), 'utf8');
      // 주석에 적어 둔 설명은 뺀다 — 왜 비웠는지가 거기 적혀 있다.
      const markup = html.replace(/<!--[\s\S]*?-->/g, '');
      // ⚠️ 끝에 `<` 를 **넣지 않습니다.** 넣으면 그 `<` 까지 먹어 버려서
      // 바로 뒤에 붙은 요소가 검사에서 통째로 빠집니다. 실제로 그랬습니다 —
      // `<div id="gh-health">` 가 뒤따르는 `<p id="gh-headline">` 의
      // 여는 꺾쇠를 먹었고, 되돌려도 이 검사가 통과했습니다.
      // (결함 49·57·이번 — 되돌림이 안 깨지면 내 검사를 먼저 의심할 것.)
      for (const [, id, inner] of markup.matchAll(
        /<(?:p|div|span|li)\b[^>]*\bid="([^"]+)"[^>]*>([^<]*)/g,
      )) {
        const text = (inner as string).trim();
        if (!/(?:불러오|확인하|확인|로딩|연결하|여는|준비)는? ?중/.test(text)) continue;
        if (SLOW_ON_PURPOSE.has(`${name}#${id as string}`)) continue;
        offenders.push(`${name}#${id as string} → "${text}"`);
      }
    }
    strictEqual(
      offenders.join(', '),
      '',
      '정적 로딩 문구는 언제나 한 번 깜빡입니다. 비우고 pending.ts 에 맡기세요',
    );
  });

  it('예외 목록이 실재하는 자리를 가리킨다', () => {
    // 화면이 바뀌어 그 요소가 사라져도 예외는 남습니다. 그러면 다음에
    // 같은 이름을 쓰는 자리가 조용히 면제됩니다.
    const dangling: string[] = [];
    for (const key of SLOW_ON_PURPOSE.keys()) {
      const [file, id] = key.split('#');
      const html = readFileSync(join(PUBLIC, file as string), 'utf8');
      if (!html.includes(`id="${id as string}"`)) dangling.push(key);
    }
    strictEqual(dangling.join(', '), '');
  });

  it('⭐ 목록을 비동기로 채우는 화면은 로딩 표시를 **켠다**', () => {
    // 이 저장소의 대표 실패 방식: 맞는 모듈을 만들어 놓고 아무도
    // 부르지 않는 것 (결함 47). 그러니 모듈이 있는지가 아니라
    // **호출**을 셉니다.
    const offenders: string[] = [];
    for (const [name] of ASYNC_CONTAINERS) {
      const code = codeOf(readFileSync(join(DEMO, name), 'utf8'));
      if (!/whileLoading\(/.test(code)) offenders.push(`${name} → whileLoading 을 안 부름`);
      if (!/showSkeleton\(/.test(code)) offenders.push(`${name} → showSkeleton 을 안 부름`);
    }
    strictEqual(offenders.join(', '), '');
  });

  it('⭐ 켠 스켈레톤을 **끄는 짝**이 있다', () => {
    // 안 끄면 화면이 영원히 로딩 중으로 남습니다. 오류는 안 납니다.
    const offenders: string[] = [];
    for (const [name] of ASYNC_CONTAINERS) {
      const code = codeOf(readFileSync(join(DEMO, name), 'utf8'));
      const on = [...code.matchAll(/showSkeleton\(/g)].length;
      const off = [...code.matchAll(/clearSkeleton\(/g)].length;
      if (off < on) offenders.push(`${name} → 켬 ${on} · 끔 ${off}`);
    }
    strictEqual(offenders.join(', '), '');
  });

  it('⭐ 목록 그릇마다 **빈 상태나 오류 상태**를 그린다', () => {
    // "데이터가 없습니다" 만 띄우는 것은 미완성으로 칩니다 (지시서 §7).
    // 이 저장소가 반복해 당한 결함은 전부 같은 모양이었습니다 —
    // 없는 것을 빈 것으로 답한다.
    const offenders: string[] = [];
    for (const [name] of ASYNC_CONTAINERS) {
      const code = codeOf(readFileSync(join(DEMO, name), 'utf8'));
      if (!/emptyHtml\(|failureHtml\(/.test(code)) offenders.push(name);
    }
    strictEqual(offenders.join(', '), '');
  });

  it('⭐ [다시 불러오기] 를 만든 화면은 그것을 **잇는다**', () => {
    // `failureHtml({retry: true})` 는 버튼을 그리기만 합니다. 안 이으면
    // 눌러도 아무 일이 안 일어나고, 사람은 화면이 더 고장 났다고
    // 생각합니다 — 만들어 놓고 안 부르는 그 방식 그대로입니다.
    const offenders: string[] = [];
    for (const { name, source } of demoFiles()) {
      const code = codeOf(source);
      if (!/retry:\s*true/.test(code)) continue;
      if (!/querySelector<HTMLButtonElement>\('\.retry'\)|\.retry'\)/.test(code)) {
        offenders.push(name);
      }
    }
    strictEqual(offenders.join(', '), '');
  });

  it('⭐ 스켈레톤이 쓰는 클래스가 공용 CSS 에 **정의돼 있다**', () => {
    // 안 정의되면 회색 막대가 **높이 0** 으로 그려집니다. 눈에는
    // 아무것도 안 보이고, 로딩 표시가 없는 것과 똑같아집니다.
    // `--bar` 가 없어서 구간 막대가 투명이던 결함 42 와 같은 부류입니다.
    //
    // ⚠️ 처음에는 `class="..."` 만 훑었습니다. 그런데 막대의 클래스는
    // `class="sk${kind && ` sk-${kind}`}"` 로 **조립**됩니다 — 그래서
    // `.sk-track` 규칙을 지워도 이 검사가 통과했습니다. 되돌림이 안
    // 깨지면 가드가 불필요한 게 아니라 **내가 잘못 세고 있는 것**입니다
    // (결함 49·57 에서 두 번 배운 것). 조립되는 쪽도 같이 셉니다.
    const source = codeOf(readFileSync(join(ROOT, 'src', 'lib', 'ui', 'skeleton.ts'), 'utf8'));
    const css = readFileSync(join(PUBLIC, 'app.css'), 'utf8');

    const used = new Set<string>(['sk']); // 막대 자신
    for (const [, group] of source.matchAll(/class="([^"$]+)"/g)) {
      for (const name of (group as string).split(/\s+/)) {
        if (name.startsWith('sk')) used.add(name);
      }
    }
    // `bar(72, 'line')` 처럼 넘기는 변형 이름 → `.sk-line`
    for (const [, kind] of source.matchAll(/\bbar\(\s*\d+\s*,\s*'([a-z-]+)'\s*\)/g)) {
      used.add(`sk-${kind as string}`);
    }

    strictEqual(used.size >= 6, true, `세는 클래스가 너무 적습니다: ${[...used].join(', ')}`);
    const missing = [...used].filter((c) => !new RegExp(`\\.${c}\\b`).test(css));
    strictEqual(missing.join(', '), '', '공용 CSS 에 없는 스켈레톤 클래스');
  });

  it('⭐ 지역 `<style>` 이 색을 손으로 칠하지 않는다 (결함 59·60)', () => {
    // 지시서 §11-A 2번: **토큰을 우회하는 곳 = 0.**
    //
    // 손으로 칠한 색은 두 가지로 틀립니다.
    //
    //   결함 59  로그인의 주 버튼만 파랑(#2563eb). 나머지 여덟 화면은
    //            청록입니다. **사람이 제일 먼저 보는 화면**이 브랜드
    //            밖이었습니다
    //   결함 60  `color: #fff` 가 네 곳. 밝은 모드에서는 맞지만
    //            어두운 모드에서 의미색이 밝게 뒤집혀 **2.06:1** 이
    //            됩니다. 밝은 모드만 보면 절대 안 보입니다
    //
    // 토큰은 모드마다 뒤집히지만 손으로 적은 값은 안 뒤집힙니다.
    // 그게 이 규칙의 전부입니다.
    const RAW = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
    const offenders: string[] = [];
    for (const name of readdirSync(PUBLIC).filter((n) => n.endsWith('.html'))) {
      const style = /<style>([\s\S]*?)<\/style>/.exec(readFileSync(join(PUBLIC, name), 'utf8'));
      if (style === null) continue;
      // ⚠️ 주석을 먼저 뺍니다. 이 저장소의 주석은 "예전에는 #2563eb
      // 였다" 처럼 **틀린 예를 그대로 적어 두므로**, 안 빼면 규칙이
      // 자기 설명에 걸립니다.
      const css = (style[1] as string).replace(/\/\*[\s\S]*?\*\//g, '');
      // 선택자(`#submit`)가 아니라 **값**만 봅니다.
      for (const [, body] of css.matchAll(/\{([^{}]*)\}/g)) {
        for (const decl of (body as string).split(';')) {
          const value = decl.slice(decl.indexOf(':') + 1);
          if (decl.includes(':') && RAW.test(value)) {
            offenders.push(`${name} → ${decl.trim().slice(0, 60)}`);
          }
        }
      }
    }
    strictEqual(
      offenders.join(' | '),
      '',
      '색은 tokens.css 에서만 정합니다 — 손으로 적은 값은 어두운 모드에서 안 뒤집힙니다',
    );
  });

  it('⭐ 진행률 엔드포인트를 **실제로 부르는 화면이 있다** (감사 #8)', () => {
    // 이 결함의 요점이 바로 그것이었습니다 — `RedisProgress` 가 진행률을
    // **쓰기만** 하고 읽는 곳이 0곳이었습니다. 그래서 읽기 엔드포인트를
    // 만들었는데, 그걸 **부르는 화면이 없으면 같은 결함을 한 층 위에서
    // 반복하는 것**입니다.
    //
    // 그러니 엔드포인트가 있는지가 아니라 **호출**을 셉니다 (결함 47 교훈).
    const callers = demoFiles().filter(({ source }) =>
      /\/progress`?\)/.test(codeOf(source)),
    );
    strictEqual(
      callers.length > 0,
      true,
      '`/api/meetings/{id}/progress` 를 부르는 화면이 하나도 없습니다',
    );
  });

  it('⭐ 화면에 **색 이모지**를 내보내지 않는다 (지시서 §4.6)', () => {
    // 색 이모지는 셋을 못 합니다.
    //
    //   · 기기마다 **다른 그림**이 나옵니다 (Apple·Google·Windows 각각)
    //   · 색이 박혀 있어 어두운 모드에서도 그대로고, 선택된 탭이
    //     진해질 때 아이콘만 안 따라옵니다
    //   · 크기·베이스라인이 서체에 딸려 있어 세로 정렬이 틀어집니다
    //
    // ⚠️ **흑백 기호는 막지 않습니다.** `⚠` `✓` `⚑` `→` `①` 은 본문
    // 서체로 그려지고 `color` 를 따라갑니다 — 위 셋 중 어느 것도
    // 해당하지 않습니다. 목록 글머리에 SVG 를 넣는 것은 과합니다.
    //
    // 잡는 것은 (a) 이모지 블록의 문자와 (b) **변이 선택자 U+FE0F** 입니다.
    // (b) 가 붙으면 `⚠` 같은 흑백 기호도 **색 이모지로 강제**됩니다 —
    // 실제로 `⚠️ 화면이 가려짐` 이 그랬습니다.
    const EMOJI = /[\u{1F000}-\u{1FAFF}]|\u{FE0F}/u;

    const offenders: string[] = [];
    const check = (label: string, text: string): void => {
      const clean = text
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      clean.split('\n').forEach((line, i) => {
        if (EMOJI.test(line)) offenders.push(`${label}:${i + 1} ${line.trim().slice(0, 50)}`);
      });
    };

    for (const name of readdirSync(PUBLIC).filter((n) => n.endsWith('.html'))) {
      check(name, readFileSync(join(PUBLIC, name), 'utf8'));
    }
    for (const { name, source } of demoFiles()) check(name, source);

    strictEqual(
      offenders.join(' | '),
      '',
      '색 이모지 대신 `src/lib/nav/icons.ts` 의 아이콘을 쓰세요',
    );
  });

  it('⭐ 간격이 4px 격자를 벗어나지 않는다 (지시서 §4.3 · §11-A 3번)', () => {
    // 격자 밖 값은 여백을 미세하게 어긋나게 만들고, 그건 화면마다
    // 조금씩 다른 인상을 줍니다. 어느 한 곳도 눈에 띄지 않는데 전체가
    // 어수선해지는 종류의 결함입니다.
    //
    // 시작할 때 **15종 48곳**이었습니다 — `.15rem`(2.4px) `.35rem`(5.6px)
    // `.85rem`(13.6px) `.9rem`(14.4px) 같은 값들.
    //
    // 격자: 4·8·12·16·20·24·32·40·48·64·80·96, 그리고 §4.3 이 아이콘↔텍스트와
    // 라벨↔입력창에만 허용하는 6.
    const GRID = new Set([0, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96]);
    const SPACING =
      /^(margin|padding|gap|row-gap|column-gap)(-(top|right|bottom|left|inline|block))?$/;

    const toPx = (value: string): number | null => {
      const m = /^(-?[\d.]+)(rem|px)$/.exec(value.trim());
      if (m === null) return null;
      const n = Number(m[1]);
      return m[2] === 'rem' ? Math.round(n * 16 * 100) / 100 : n;
    };

    const sources: [string, string][] = [];
    for (const name of readdirSync(PUBLIC).filter((n) => n.endsWith('.html'))) {
      const style = /<style>([\s\S]*?)<\/style>/.exec(readFileSync(join(PUBLIC, name), 'utf8'));
      if (style !== null) sources.push([name, style[1] as string]);
    }
    sources.push(['app.css', readFileSync(join(PUBLIC, 'app.css'), 'utf8')]);

    const offenders: string[] = [];
    for (const [name, raw] of sources) {
      const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const rule of css.matchAll(/\{([^{}]*)\}/g)) {
        for (const decl of (rule[1] as string).split(';')) {
          if (!decl.includes(':')) continue;
          const prop = decl.slice(0, decl.indexOf(':')).trim();
          const value = decl.slice(decl.indexOf(':') + 1);
          if (!SPACING.test(prop)) continue;
          // 토큰과 `calc()` 는 통과 — 값은 tokens.css 가 정합니다.
          if (value.includes('var(') || value.includes('calc(')) continue;
          for (const part of value.split(/\s+/).filter(Boolean)) {
            const px = toPx(part);
            if (px !== null && !GRID.has(Math.abs(px))) {
              offenders.push(`${name} → ${prop}: ${part}`);
            }
          }
        }
      }
    }
    strictEqual(
      [...new Set(offenders)].join(', '),
      '',
      '간격은 4·8·12·16·… 만 씁니다 (아이콘↔텍스트·라벨↔입력창만 6)',
    );
  });

  it('⭐ 공용 CSS 가 **스스로를 덮지 않는다** (결함 61)', () => {
    // Stage D 에서 위쪽에 디스플레이 타이포를 넣었는데, 아래쪽에 남아
    // 있던 옛 `h1 { font-size: 1.5rem }` 이 **뒤에 나온다는 이유만으로**
    // 이겼습니다. 특성도가 같으면 나중 것이 이깁니다.
    //
    // 그래서 `--fs-display`·`--ls-display` 는 만들어 놓고 **한 번도
    // 화면에 나온 적이 없었습니다.** 브라우저로 봐도 "제목이 좀 작네"
    // 정도라 눈에 안 띕니다 — 이 저장소의 대표 실패 방식(만들어 놓고
    // 아무도 안 씀)이 자기 파일 안에서 일어난 것입니다.
    //
    // ⚠️ 같은 **선택자**가 두 번 나오는 것 자체는 정상입니다
    // (`.rangebar, .cov` 로 바탕을 깔고 `.cov` 에서 높이만 다시 잡는
    // 식). 문제가 되는 것은 **같은 속성**을 두 번 정하는 것입니다.
    // 그때만 "어느 값이 이기나" 를 사람이 세어 봐야 합니다.
    const css = readFileSync(join(PUBLIC, 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

    // 미디어 쿼리 안의 재정의는 정상 — 넓은 화면에서 값을 바꾸는 것이
    // 그 블록의 존재 이유입니다. 그 구간은 건너뜁니다.
    const media: [number, number][] = [];
    for (const m of css.matchAll(/@media[^{]*\{/g)) {
      let depth = 1;
      let i = m.index + m[0].length;
      while (i < css.length && depth > 0) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}') depth--;
        i++;
      }
      media.push([m.index, i]);
    }
    const insideMedia = (at: number): boolean => media.some(([a, b]) => at >= a && at < b);

    const seen = new Map<string, Set<string>>();
    const offenders: string[] = [];
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (insideMedia(rule.index)) continue;
      const selector = (rule[1] as string).split(/\s+/).join(' ').trim();
      if (selector === '' || selector.startsWith('@') || selector === ':root') continue;
      for (const one of selector.split(',').map((s) => s.trim()).filter(Boolean)) {
        const props = seen.get(one) ?? new Set<string>();
        for (const decl of (rule[2] as string).split(';')) {
          if (!decl.includes(':')) continue;
          const prop = decl.slice(0, decl.indexOf(':')).trim();
          if (prop === '' || prop.startsWith('--')) continue;
          if (props.has(prop)) offenders.push(`${one} → ${prop}`);
          props.add(prop);
        }
        seen.set(one, props);
      }
    }
    strictEqual(
      [...new Set(offenders)].join(', '),
      '',
      '같은 선택자에 같은 속성을 두 번 정했습니다. 뒤엣것이 조용히 이깁니다',
    );
  });

  it('⭐ 의미색 위의 글자색이 모드마다 뒤집힌다 (결함 60)', () => {
    // `--on-semantic` 이 Layer 1 값을 참조해야 두 모드에서 다 맞습니다.
    // 고정값(`#ffffff`)으로 적으면 어두운 모드가 그대로 깨집니다.
    const tokens = readFileSync(join(PUBLIC, 'tokens.css'), 'utf8');
    const decl = /--on-semantic:\s*([^;]+);/.exec(tokens);
    strictEqual(decl !== null, true, '--on-semantic 이 없습니다');
    strictEqual(
      /^var\(--/.test((decl?.[1] ?? '').trim()),
      true,
      `--on-semantic 은 Layer 1 토큰을 참조해야 합니다 (지금: ${decl?.[1] ?? ''})`,
    );
  });

  it('⭐ 빈/오류 상태 클래스도 공용 CSS 에 있다', () => {
    const css = readFileSync(join(PUBLIC, 'app.css'), 'utf8');
    for (const selector of ['.empty-state', '.failure-state']) {
      strictEqual(css.includes(selector), true, `${selector} 이 app.css 에 없습니다`);
    }
  });
});
