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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

  it('⭐ 오류 **본문 자체**를 화면에 넣지 않는다 (결함 73)', () => {
    // 위 가드는 `.json()` 뒤에 붙은 `as { detail?: string }` 를 찾습니다.
    // 그래서 **`.text()` 를 쓰는 곳은 안 걸렸습니다.** 녹음 화면이 그랬고,
    // 화면에 이렇게 나왔습니다.
    //
    //     트랙에 참가하지 못했습니다: {"detail":"녹음에 동의하지 않았습니다"}
    //
    // 같은 파일 아래쪽(`finish`)은 이미 `detailText` 를 쓰고 있었습니다 —
    // **한 곳만 고친 것**입니다. 사람은 중괄호를 보면 앱이 깨졌다고 읽고,
    // 정작 읽어야 할 문장("녹음에 동의하지 않았습니다")은 못 봅니다.
    //
    // ⚠️ `.text()` 자체를 금지하지 않습니다 — 응답이 원래 텍스트인 곳이
    // 있을 수 있습니다. 금지하는 것은 **그 값을 화면에 넣는 것**입니다.
    const offenders: string[] = [];
    for (const { name, source } of demoFiles()) {
      const code = codeOf(source);
      // `const x = await response.text()` 로 받은 이름을 모은다
      const names = [...code.matchAll(/(?:const|let)\s+(\w+)\s*=\s*await\s+\w+\.text\(\)/g)].map(
        (m) => m[1] as string,
      );
      for (const bound of names) {
        // 그 이름이 textContent·innerHTML 로 들어가는가
        const used = new RegExp(
          `(?:textContent|innerHTML)\\s*=[^;]*\\b${bound}\\b`,
          's',
        ).test(code);
        if (used) offenders.push(`${name} → ${bound}`);
      }
    }
    strictEqual(
      offenders.join(', '),
      '',
      '`await response.text()` 를 화면에 넣습니다. `detailText(await response.json(), …)` 를 쓰세요',
    );
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

describe('줄어들 수 없는 컨트롤 (결함 77)', () => {
  const screens = (): { name: string; html: string }[] =>
    readdirSync(PUBLIC)
      .filter((name) => name.endsWith('.html'))
      .map((name) => ({ name, html: readFileSync(join(PUBLIC, name), 'utf8') }));

  it('⭐ `.row` 안에 못 줄어드는 컨트롤을 두면 줄바꿈을 허용한다', () => {
    // 승인 화면이 이랬습니다.
    //
    //     app.css     .row > * { min-width: 0 }        ← 라벨은 0 까지 줄어든다
    //     review.html select { min-width: 8rem }        ← 컨트롤은 못 줄어든다
    //
    // 라벨 상자보다 내용이 넓어지고, 넘친 부분이 **옆 라벨 글자 위로
    // 올라탑니다.** 360·390px 에서 "마감일" 이 담당자 칸을 덮었습니다.
    //
    // ⚠️ `audit360.mjs`(가로 넘침)는 이걸 **못 잡습니다.** `body` 에
    // `overflow-x: hidden` 이 있어 넘친 것이 잘리고, 잘린 것은 넘침으로
    // 세지지 않습니다. 잘린 것은 가로 스크롤보다 나쁩니다 — 밀어서
    // 볼 수조차 없습니다.
    //
    // 그래서 **겹치는 대신 줄을 바꾸게** 합니다.
    const offenders: string[] = [];
    for (const { name, html } of screens()) {
      const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
      const bare = style.replace(/\/\*[\s\S]*?\*\//g, '');
      // 이 화면이 `.row` 를 쓰는가
      if (!/class="row"/.test(html) && !/\.row\b/.test(bare)) continue;
      // 컨트롤에 못 줄어드는 바닥을 줬는가
      const hardFloor = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].some(
        (rule) =>
          /\b(select|input|textarea)\b/.test(rule[1] ?? '') &&
          /min-width:\s*(?!0)/.test(rule[2] ?? ''),
      );
      if (!hardFloor) continue;
      // 그러면 줄바꿈과 내용 바닥이 **둘 다** 있어야 한다
      const wraps = /\.row[^{]*\{[^}]*flex-wrap:\s*wrap/.test(bare);
      const floor = /\.row\s*>?\s*label[^{]*\{[^}]*min-width:\s*max-content/.test(bare);
      if (!wraps || !floor) {
        offenders.push(`${name} → ${!wraps ? 'flex-wrap 없음' : ''}${!wraps && !floor ? ' · ' : ''}${!floor ? 'label min-width: max-content 없음' : ''}`);
      }
    }
    strictEqual(
      offenders.join(', '),
      '',
      '`.row { flex-wrap: wrap }` 와 `.row > label { min-width: max-content }` 를 같이 두세요',
    );
  });
});

describe('로그아웃이 안 될 때 (결함 82)', () => {
  const demoFiles = (): { rel: string; code: string }[] =>
    readdirSync(join(ROOT, 'src', 'demo'))
      .filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))
      .map((n) => ({ rel: `src/demo/${n}`, code: readFileSync(join(ROOT, 'src', 'demo', n), 'utf8') }));

  it('⭐ 로그아웃 응답을 안 보고 화면을 옮기지 않는다', () => {
    // 홈과 로비가 이렇게 쓰고 있었습니다.
    //
    //     void fetch(`${apiBase}/api/auth/logout`, { method: 'POST' })
    //       .then(() => { location.href = '/login.html'; });
    //
    // `fetch` 는 500 에서도 resolve 합니다. 서버가 세션을 못 끊어도 화면은
    // 로그인 화면으로 갑니다 — 그 사람은 로그아웃했다고 믿고 자리를 뜨는데
    // **세션 토큰은 살아 있습니다.** 서버의 `logout` docstring 이 경고하는
    // 바로 그 상황입니다.
    const offenders = demoFiles()
      .filter(({ rel }) => rel !== 'src/demo/logout.ts')
      .filter(({ code }) => /auth\/logout/.test(code))
      .map(({ rel }) => rel);
    strictEqual(offenders.join(', '), '', '`demo/logout.ts` 의 `wireLogout` 을 쓰세요');
  });

  it('⭐ 로그아웃 버튼이 있는 화면에는 실패를 적을 자리가 있다', () => {
    const missing = readdirSync(PUBLIC)
      .filter((n) => n.endsWith('.html'))
      .filter((n) => /id="logout"/.test(readFileSync(join(PUBLIC, n), 'utf8')))
      .filter((n) => !/id="logout-note"/.test(readFileSync(join(PUBLIC, n), 'utf8')));
    strictEqual(missing.join(', '), '', '`<p class="status" id="logout-note" hidden>` 를 두세요');
  });

  it('⭐ 그 자리를 실제로 부른다', () => {
    // 요소만 두고 안 쓰면 결함 47 입니다. 화면마다 `wireLogout` 에
    // `logout-note` 를 넘기는지 봅니다.
    const wired = demoFiles()
      .filter(({ rel }) => rel !== 'src/demo/logout.ts')
      .filter(({ code }) => /wireLogout\(/.test(code));
    strictEqual(wired.length >= 2, true, '로그아웃 화면이 둘인데 그보다 적게 잡혔습니다');
    const silent = wired.filter(({ code }) => !/logout-note/.test(code)).map(({ rel }) => rel);
    strictEqual(silent.join(', '), '', '`note: $(\'logout-note\')` 를 넘기세요');
  });
});

describe('요청이 서버에 닿지 못할 때 (결함 87)', () => {
  const demoSources = (): { rel: string; code: string }[] =>
    readdirSync(DEMO)
      .filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))
      .map((n) => ({ rel: `src/demo/${n}`, code: codeOf(readFileSync(join(DEMO, n), 'utf8')) }));

  /** `이름(` 부터 짝 맞는 `)` 까지. 인자 안의 괄호를 세어 자릅니다. */
  const callsOf = (code: string, name: string): { at: number; args: string }[] => {
    const found: { at: number; args: string }[] = [];
    const needle = `${name}(`;
    for (let at = code.indexOf(needle); at !== -1; at = code.indexOf(needle, at + 1)) {
      // `trySend(` 가 `send(` 로도 걸립니다 — 앞 글자가 이름의 일부면 건너뜁니다.
      if (at > 0 && /[\w$.]/.test(code[at - 1] as string)) continue;
      let depth = 0;
      let i = at + needle.length - 1;
      for (; i < code.length; i++) {
        if (code[i] === '(') depth++;
        else if (code[i] === ')' && --depth === 0) break;
      }
      found.push({ at, args: code.slice(at + needle.length, i) });
    }
    return found;
  };

  it('⭐ 누르면 바뀌는 요청은 전부 `trySend` 를 거친다', () => {
    // `fetch` 는 서버가 500 을 줘도 **성공**으로 끝나고, 서버에 닿지
    // 못하면 **거부**합니다. `!response.ok` 만 보는 코드는 두 번째를
    // 통째로 놓치고, 그 뒤가 `void …` 나 `async` 클릭 처리기면 거부가
    // 아무 데도 안 걸립니다. 브라우저에서 확인한 결과가 이렇습니다.
    //
    //     새 프로젝트 만들기  아무 일도 안 일어남
    //     칸반 카드 옮기기    아무 일도 안 일어남
    //     기여도 확정         **"확정했습니다."** 가 그대로 남음
    const offenders: string[] = [];
    for (const { rel, code } of demoSources()) {
      // `send()` 는 `call()` 을 `trySend` 로 감싼 그 파일의 지역 helper 다.
      const hasWrapper = /const send\s*=[\s\S]{0,120}?trySend\(/.test(code);
      for (const name of ['fetch', 'call']) {
        for (const { at, args } of callsOf(code, name)) {
          if (!/\bmethod:/.test(args)) continue; // GET 은 받아 오기 길이다
          const before = code.slice(Math.max(0, at - 40), at);
          if (/trySend\(\(\)\s*=>\s*$/.test(before)) continue;
          if (hasWrapper && name === 'call') continue;
          offenders.push(`${rel} 의 ${name}(`);
        }
      }
    }
    strictEqual(
      [...new Set(offenders)].join(', '),
      '',
      '`trySend(() => fetch(…))` 로 감싸고 `null` 일 때 화면에 적으세요',
    );
  });

  it('⭐ `trySend` 를 쓰는 화면은 `null` 일 때 할 말이 있다', () => {
    // 감싸 놓고 `null` 을 안 보면 그대로 조용합니다 — 오히려 나빠집니다.
    const silent = demoSources()
      .filter(({ code }) => /trySend\(/.test(code))
      // 화면마다 할 말이 다릅니다 — 공통 문구든, 그 화면 전용이든
      // **`null` 을 받아 사람에게 옮기는 함수**가 하나는 있어야 합니다.
      .filter(
        ({ code }) =>
          !/unreachableText\(|describeCompletionFailure\(0\)|describeRequestFailure\(0\)|describeLogoutFailure\(/.test(
            code,
          ),
      )
      .map(({ rel }) => rel);
    strictEqual(silent.join(', '), '', '`response === null` 일 때 적을 문구가 없습니다');
  });

  it('⭐ 누르면 바뀌는 버튼은 누르는 동안 잠근다 (결함 89)', () => {
    // 느린 망에서 "만들기" 를 눌렀는데 2초 동안 아무 일이 없으면 사람은
    // 한 번 더 누릅니다. 브라우저에서 세 번 눌러 보니 **프로젝트가 셋**
    // 생겼습니다 — 화면은 그중 하나로 들어가고, 나머지 둘은 같은 이름에
    // **다른 초대 코드**를 가진 채 목록에 남습니다.
    //
    // 초대 코드는 팀원이 들어오는 유일한 통로라, 갈라지면 기여도가
    // 갈라집니다.
    //
    // ⚠️ `del-run`·`gh-backfill`·로그인은 **이미** 잠그고 있었습니다.
    // 잠그는 곳과 안 잠그는 곳이 섞여 있던 것이 결함입니다 — 두 벌이
    // 있으면 한쪽만 고쳐집니다(73·81·82·87).
    const offenders: string[] = [];
    for (const { rel, code } of demoSources()) {
      // ⚠️ `\bsend\(` 까지 보면 통화 화면의 **WebSocket** `send()` 가
      // 걸립니다 — 이 규칙과 아무 상관이 없습니다. 첫 판에 실제로 걸렸습니다.
      if (!/trySend\(/.test(code)) continue;
      // 그 파일이 잠그는 방법: 공용 helper 이거나, 직접 `disabled = true`.
      const locks = /whilePressed\(/.test(code) || /\.disabled = true/.test(code);
      if (!locks) offenders.push(rel);
    }
    strictEqual(
      offenders.join(', '),
      '',
      '`whilePressed(button, () => …)` 로 누르는 동안 잠그세요',
    );
  });

  it('⭐ 실패 문구를 폴링이 덮는 자리에 쓰지 않는다 (결함 90)', () => {
    // 로비는 3초마다 `render()` 를 돌려 방 상태를 다시 그립니다. 실패
    // 문구를 그 자리(`#room-message`·`#consent-message`)에 쓰면 **3초 뒤에
    // 조용히 사라집니다.** 브라우저로 재 보니 1.5초에는 있고 3.5초에는
    // 없었고, 그 자리에는 원래 문장이 돌아와 있었습니다 —
    //
    //     1.5s  "동의를 제출하지 못했습니다 — 서버에 닿지 못했습니다…"
    //     3.5s  "전원 동의했습니다. 녹음을 시작할 수 있습니다"
    //
    // 폰을 주머니에 넣었다 꺼내면 아무 일도 없었던 화면을 봅니다.
    // 실패는 **아무도 안 덮는 자리**(`…-note`)에 씁니다 — 로그아웃(82)·
    // 복사(81)가 이미 쓰던 방법입니다.
    const source = readFileSync(join(DEMO, 'lobby.ts'), 'utf8');
    const code = codeOf(source);
    const offenders: string[] = [];
    for (const id of ['room-message', 'consent-message']) {
      // `render()` 안의 한 줄만 허용합니다. 그 밖에서 쓰면 덮입니다.
      const writes = [...code.matchAll(new RegExp(`\\$\\('${id}'\\)\\.textContent\\s*=`, 'g'))];
      if (writes.length > 1) offenders.push(`${id} 에 쓰는 곳이 ${writes.length}곳`);
    }
    strictEqual(
      offenders.join(', '),
      '',
      '실패 문구는 `roomNote`/`consentNote` 로 `…-note` 에 쓰세요',
    );
  });

  it('⭐ 그 자리가 화면에 실제로 있다 (결함 90)', () => {
    const html = readFileSync(join(PUBLIC, 'lobby.html'), 'utf8');
    for (const id of ['room-note', 'consent-note']) {
      strictEqual(
        new RegExp(`id="${id}"`).test(html),
        true,
        `lobby.html 에 <p class="status" id="${id}" hidden> 이 없습니다`,
      );
    }
  });

  it('⭐ 안내 자리는 `showNote` 를 거친다 (결함 92)', () => {
    // 요청이 실패했을 때 화면이 하는 말을 아홉 자리에서 재 봤더니
    // **색이 세 가지**였습니다.
    //
    //     빨강  홈 만들기 · 칸반 옮기기 · 승인 제출 · 프로젝트 이름
    //     회색  **기여도 확정** · 로비 동의 · 복사
    //
    // 사람은 화면 몇 개만 봐도 "빨간 줄 = 뭔가 잘못됐다" 를 배웁니다.
    // 그 다음부터 회색 실패는 평범한 상태 줄로 읽힙니다 — 하필 회색인
    // 곳 하나가 **기여도 확정**, 결함 87 에서 "확정했습니다" 가 남는 것을
    // 고친 바로 그 자리였습니다.
    //
    // 글자와 색을 **한 함수**가 같이 정하게 하고, 그 함수를 건너뛰지
    // 못하게 합니다.
    const offenders: string[] = [];
    for (const { rel, code } of demoSources()) {
      for (const m of code.matchAll(/\$\('([\w-]*-note)'\)\s*\.\s*(textContent|hidden)\s*=/g)) {
        offenders.push(`${rel} → ${m[1]}.${m[2]}`);
      }
    }
    strictEqual(
      offenders.join(', '),
      '',
      '`showNote(자리, 글자)` 로 쓰세요 — 글자와 색이 갈라집니다',
    );
  });

  it('⭐ 한 자리에 성공과 실패를 같이 쓰면 색도 같이 정한다 (결함 98)', () => {
    // 위 가드는 이름이 `…-note` 인 자리만 봅니다. 그래서 **다른 이름의
    // 자리**가 그대로 남아 있었습니다. 브라우저로 재 보니 프로젝트 화면의
    // `#role-message` 는 네 가지 뜻이 **전부 같은 회색**이었습니다.
    //
    //     지금 개발 100%                 rgb(94,114,115)
    //     합이 1 이어야 합니다 (지금 5)   rgb(94,114,115)
    //     역할을 저장하지 못했습니다       rgb(94,114,115)   ← 실패
    //     저장했습니다 — 개발 100%        rgb(94,114,115)
    //
    // ⚠️ **`.bad` 를 붙이는 것만으로는 안 됐습니다.** `.rolestatus` 와
    // `app.css` 의 `.bad` 는 특이도가 같은데 화면별 `<style>` 이 뒤에
    // 오므로 `.rolestatus` 가 이깁니다 — 결함 61 과 같은 부류라
    // `.rolestatus.bad` 를 따로 적어야 했습니다.
    //
    // 규칙: 한 자리에 **실패와 성공을 둘 다** 쓰면서 색을 정하는 코드가
    // 하나도 없으면 신고합니다. 실패만 쓰는 자리(칸반 `#result` 는 CSS 가
    // 항상 빨강)는 대상이 아닙니다.
    const LOOKS_FAILED = /unreachableText\(|detailText\(|describeHttpStatus\(|못했습니다|실패/;
    const WRITE = /\$\('([\w-]+)'\)\s*\.textContent\s*=([^;]*);/g;

    // ⚠️ **자리 단위로 세면 부분 되돌림을 놓칩니다.**
    //
    // 처음에는 "이 자리에 `showNote` 가 한 번이라도 있으면 통과" 였습니다.
    // 그랬더니 다섯 줄 중 **두 줄만** 옛 모양으로 되돌려도 조용했습니다 —
    // 남은 `showNote` 세 줄이 자리를 메워 주기 때문입니다. 한 줄만
    // 새어 나가는 것이 실제로 더 흔한 회귀입니다.
    //
    // 그래서 **그 줄**을 봅니다. 실패를 직접 쓰는 줄은 자기 바로 옆에서
    // 색을 정해야 합니다 (`review.ts` 가 `className` 을 바로 윗줄에서
    // 정하는 모양이 통과해야 합니다).
    const offenders: string[] = [];
    for (const { rel, code } of demoSources()) {
      const lines = code.split('\n');
      const writesFine = new Set<string>();
      for (const m of code.matchAll(WRITE)) {
        const id = m[1] as string;
        const value = m[2] as string;
        // 빈 문자열은 "지운다" 지 성공이 아니다.
        if (/^\s*''\s*$/.test(value)) continue;
        if (!LOOKS_FAILED.test(value)) writesFine.add(id);
      }
      for (const m of code.matchAll(WRITE)) {
        const id = m[1] as string;
        if (!LOOKS_FAILED.test(m[2] as string) || !writesFine.has(id)) continue;
        const at = code.slice(0, m.index).split('\n').length - 1;
        const near = lines.slice(Math.max(0, at - 2), at + 3).join('\n');
        const colored = new RegExp(`\\$\\('${id}'\\)\\s*\\.(className\\s*=|classList)`);
        if (!colored.test(near)) offenders.push(`${rel}:${at + 1} → #${id}`);
      }
    }
    strictEqual(
      offenders.join(', '),
      '',
      '실패와 성공이 같은 색으로 나옵니다 — `showNote(자리, 글자, 성공이면 \'plain\')` 을 쓰세요',
    );
  });

  it('⭐ 브라우저 예외를 화면에 붙이지 않는다', () => {
    // `전송 실패: ${String(err)}` → `전송 실패: TypeError: Failed to fetch`
    const offenders = demoSources()
      .filter(({ code }) => /\$\{String\(err[a-z]*\)\}|\$\{err[a-z]*\}/.test(code))
      .map(({ rel }) => rel);
    strictEqual(offenders.join(', '), '', '`describeUnexpected()` 를 쓰고 원문은 콘솔에 남기세요');
  });
});

describe('서버가 보내는데 아무도 안 읽는 칸 (결함 93)', () => {
  /**
   * 화면이 **안 읽어도 되는** 칸과 그 이유. 비워 두면 안 됩니다 —
   * 근거 없는 면제는 다음 사람이 그냥 늘립니다 (결함 80 의 면제 목록과 같은 규칙).
   */
  /** 서버가 실어 보내는 payload 타입들. 늘면 여기 한 줄. */
  const PAYLOADS: [string, string][] = [
    ['TrackHealth', 'src/lib/lobby/room.ts'],
    ['RosterEntry', 'src/lib/lobby/room.ts'],
    ['FinalRow', 'src/lib/contribution/final.ts'],
  ];

  const EXEMPT: Record<string, string> = {
    track_id:
      '로비는 트랙을 **사람으로** 찾는다(`user_id`). 트랙 하나만 여는 화면이 없어 ' +
      '번호를 쓸 데가 없다 — 생기면 그때 지운다',
    stop_reason:
      '내부 enum(consent_revoked·backpressure…)이라 그대로 띄우면 결함 78·86 이 반복된다. ' +
      '한국어 어휘표를 만들고 `_screen_vocabularies` 에 넣어야 하므로 따로 한다',
    capture_confidence:
      '`coverage` 가 이미 "얼마나 담겼나" 를 말한다. 비슷한 숫자를 둘 띄우면 ' +
      '사람이 어느 쪽을 믿을지 모른다',
  };

  /**
   * **같은 이름의 칸이 다른 타입에도 있는** 경우. 값은 이 타입의 칸을
   * 읽는다고 인정할 **정확한 조각**입니다.
   *
   * ⚠️ `.reason` 만 찾으면 `FinalRow.reason` 이 읽히는지 알 수 없습니다.
   * 같은 파일의 `Draft.reason` 이 자리를 메웁니다.
   *
   *     if (… && !draft.reason.trim())      // Draft — 사람이 **적는** 칸
   *     reason: draft.reason.trim() || …    // Draft
   *
   * 그래서 서버가 보낸 이유를 아무 화면도 안 보여주는 동안(결함 96) 이
   * 가드는 조용했습니다. 결함 93 에서 겪은 "같은 이름의 다른 칸" 이
   * **한 파일 안에서** 다시 난 것입니다 — "내 검사가 다른 이유로 통과 중"
   * 아홉 번째.
   *
   * 변수 이름이 바뀌면 여기가 깨집니다. 그게 낫습니다 — 조용히 통과하는
   * 것보다 시끄럽게 틀리는 편이 고칠 수 있습니다.
   */
  const AMBIGUOUS: Record<string, string> = {
    reason: 'f.reason',
  };

  it('⭐ 서버 payload 의 칸은 화면이 읽거나, 안 읽는 이유가 적혀 있다', () => {
    // 서버는 `capture_warnings` 를 저장하고 트랙마다 실어 보냈고, 화면
    // 타입에도 `warnings` 가 있었습니다. **읽는 곳이 0곳이었습니다.**
    // 녹음 화면은 자기가 방금 잡은 경고를 보여주지만 그건 그 폰에서
    // 그 순간뿐이고, 저장된 뒤로는 아무 화면도 안 봤습니다 — 로비가
    // "누구 폰이 잘못됐나" 를 보는 곳인데도요.
    //
    // 이 저장소의 대표 실패 방식(47·63·75·83·84)이 **타입 한 줄**로
    // 나타난 경우라 죽은 export 가드에도 안 걸렸습니다.
    const fields: string[] = [];
    const typeNames: string[] = [];
    for (const [name, rel] of PAYLOADS) {
      const source = readFileSync(join(ROOT, ...rel.split('/')), 'utf8');
      const block = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source);
      strictEqual(block !== null, true, `${rel} 에서 ${name} 을 못 찾았습니다`);
      const body = codeOf(block?.[1] ?? '');
      const own = [...body.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1] as string);
      strictEqual(own.length > 2, true, `${name}: 칸을 못 읽었습니다 (${own.length}개)`);
      fields.push(...own);
      typeNames.push(name);
    }

    // ⚠️ **`TrackHealth` 를 아는 파일만** 봅니다.
    //
    // 처음에는 `src/` 전체에서 `.warnings` 를 찾았는데, 그러면 승인
    // 화면의 `candidate.warnings`·진단의 `health.warnings`·녹음 화면의
    // `client.warnings` 가 **다른 객체인데도** 걸려서 되돌림이 안
    // 깨졌습니다 — "내 검사가 다른 이유로 통과 중" 을 여덟 번째로
    // 겪은 자리입니다. 같은 이름의 다른 칸을 세고 있었습니다.
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          const code = codeOf(readFileSync(full, 'utf8'));
          if (typeNames.some((name) => new RegExp(`\\b${name}\\b`).test(code))) {
            sources.push(code);
          }
        }
      }
    };
    walk(join(ROOT, 'src'));
    strictEqual(sources.length >= 2, true, '이 타입들을 쓰는 파일을 못 찾았습니다');

    // ⚠️ **문자열 안은 읽는 것이 아닙니다.**
    //
    // 확정 표를 그리는 코드에 이런 줄이 있습니다.
    //
    //     row.querySelector<HTMLInputElement>('.reason')
    //
    // 그건 **사람이 적어 넣는 입력 칸**을 찾는 CSS 선택자지, 서버가 보낸
    // `reason` 을 보여주는 자리가 아닙니다. 글자만 같습니다.
    const outsideStrings = (code: string): string =>
      code.replace(/'[^'\n]*'|"[^"\n]*"/g, "''");

    const unread = fields.filter((f) => {
      const snippet = AMBIGUOUS[f];
      const read =
        snippet === undefined
          ? new RegExp(`\\.${f}\\b`)
          : new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      return !sources.some((code) => read.test(outsideStrings(code)));
    });

    const unexplained = unread.filter((f) => !(f in EXEMPT));
    strictEqual(
      unexplained.join(', '),
      '',
      '서버가 보내는데 아무 화면도 안 읽습니다 — 쓰거나, 위 EXEMPT 에 이유를 적으세요',
    );

    // 면제 목록이 낡지 않았는가: 이미 읽고 있는 칸이 면제에 남아 있으면
    // 다음 사람이 "이건 안 읽어도 되는구나" 로 읽습니다.
    const stale = Object.keys(EXEMPT).filter((f) => fields.includes(f) && !unread.includes(f));
    strictEqual(stale.join(', '), '', '이제 읽고 있습니다 — 면제 목록에서 빼세요');

    // `AMBIGUOUS` 도 같이 늙습니다. 없는 칸에 대한 조각이 남아 있으면
    // 다음 사람이 "이 칸은 특별히 챙기고 있구나" 로 잘못 읽습니다.
    const orphan = Object.keys(AMBIGUOUS).filter((f) => !fields.includes(f));
    strictEqual(orphan.join(', '), '', 'payload 에 없는 칸입니다 — AMBIGUOUS 에서 빼세요');
  });
});

describe('복사가 안 될 때 (결함 81)', () => {
  const PUBLIC_DIR = join(ROOT, 'public');
  const demoFiles = (): { rel: string; code: string }[] => {
    const out: { rel: string; code: string }[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          out.push({
            rel: full.slice(ROOT.length + 1).split('\\').join('/'),
            code: readFileSync(full, 'utf8'),
          });
        }
      }
    };
    walk(join(ROOT, 'src'));
    return out;
  };

  it('⭐ `navigator.clipboard` 를 직접 부르지 않는다', () => {
    // 두 화면이 이렇게 쓰고 있었습니다.
    //
    //     void navigator.clipboard.writeText(text).then(() => { … '복사됨' })
    //
    // `navigator.clipboard` 는 **보안 컨텍스트에서만 있습니다.** 폰에서
    // `http://192.168.0.5:8000` 으로 열면 `undefined` 라 그 줄이 클릭
    // 핸들러 안에서 죽고, 화면은 아무 말도 안 합니다. `.catch` 도
    // 없어서 권한 거절도 같은 결과입니다.
    //
    // 사람이 겪는 일: 눌러도 아무 변화가 없다 → 카톡에 붙여 넣는다 →
    // **아까 복사해 둔 다른 글**이 나간다. 결함 71 의 거울상입니다.
    // ⚠️ **부르는 것**만 막습니다. `copyText(text, navigator.clipboard)` 처럼
    // 클립보드를 **넘겨 주는 것**은 이 설계가 원하는 모양입니다 — 처음 쓴
    // 검사가 이름만 보고 그 둘을 같이 잡아, 방금 고친 두 파일을 결함으로
    // 신고했습니다.
    const direct = /navigator\s*\??\.\s*clipboard\s*\??\.\s*writeText/;
    const offenders = demoFiles()
      .filter(({ rel }) => rel !== 'src/lib/ui/copy.ts')
      .filter(({ code }) => direct.test(code))
      .map(({ rel }) => rel);
    strictEqual(offenders.join(', '), '', '`lib/ui/copy.ts` 의 `copyText` 를 쓰세요');

    // 통과해야 하는 모양을 일부러 넣어 본다
    strictEqual(direct.test('void copyText(text, navigator.clipboard).then(…)'), false);
    strictEqual(direct.test('await navigator.clipboard.writeText(x)'), true);
    strictEqual(direct.test('navigator?.clipboard?.writeText(x)'), true);
  });

  it('⭐ 복사 버튼이 있는 화면에는 실패를 적을 자리가 있다', () => {
    // 만들어 놓고 아무도 안 쓰면 결함 47 입니다. 버튼이 있는 화면마다
    // 안내를 적을 요소가 실제로 있는지 봅니다.
    const missing: string[] = [];
    for (const name of readdirSync(PUBLIC_DIR).filter((n) => n.endsWith('.html'))) {
      const html = readFileSync(join(PUBLIC_DIR, name), 'utf8');
      if (!/id="copy"/.test(html)) continue;
      if (!/id="copy-note"/.test(html)) missing.push(name);
    }
    strictEqual(missing.join(', '), '', '`<p class="status" id="copy-note" hidden>` 를 두세요');
  });

  it('⭐ 실패 안내를 실제로 그 자리에 쓴다', () => {
    // 요소만 두고 안 쓰면 화면은 여전히 조용합니다 — 결함 47 그대로입니다.
    const users = demoFiles()
      .filter(({ rel }) => rel !== 'src/lib/ui/copy.ts')
      .filter(({ code }) => /copyText\(/.test(code));
    strictEqual(users.length >= 2, true, '복사 경로가 둘인데 그보다 적게 잡혔습니다');
    const silent = users
      .filter(({ code }) => !/copy-note/.test(code))
      .map(({ rel }) => rel);
    strictEqual(silent.join(', '), '', '실패했을 때 `#copy-note` 에 이유를 쓰세요');
  });
});

describe('한국어 조사 (결함 76)', () => {
  /** `src/` 의 프로덕션 코드에서 주석·import 를 걷어낸 것. */
  const codeFiles = (): { rel: string; code: string }[] => {
    const out: { rel: string; code: string }[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          out.push({
            rel: full.slice(join(ROOT, 'src').length + 1).split('\\').join('/'),
            // ⚠️ 주석은 뺍니다. 이 저장소의 주석은 `` `x` 를 `` 처럼
            // 코드 조각 뒤에 조사를 띄어 쓰는 문서 관례를 씁니다.
            // 그건 화면에 안 나오므로 여기서 볼 대상이 아닙니다.
            code: readFileSync(full, 'utf8')
              .replace(/\/\*[\s\S]*?\*\//g, '')
              .replace(/^\s*\/\/.*$/gm, ''),
          });
        }
      }
    };
    walk(join(ROOT, 'src'));
    return out;
  };

  it('⭐ `은(는)` 같은 짝 표기를 화면에 내보내지 않는다', () => {
    // 확정 화면에 이렇게 나왔습니다.
    //
    //     2026. 8. 8. 오후 1:03:30 에 확정했습니다 — 김민수 은(는) …
    //
    // `은(는)` 은 사람이 읽는 글자가 아닙니다. **미완성 소프트웨어**로
    // 읽히고, 이 화면은 성적에 쓰일 수 있는 숫자를 보여주는 곳이라
    // 그 인상이 숫자에까지 옮겨 갑니다.
    const PAIRED = /은\(는\)|는\(은\)|이\(가\)|가\(이\)|을\(를\)|를\(을\)|와\(과\)|과\(와\)|\(으\)로/;
    const offenders = codeFiles()
      .filter(({ code }) => PAIRED.test(code))
      .map(({ rel }) => rel);
    strictEqual(
      offenders.join(', '),
      '',
      '`lib/text/josa.ts` 의 `withJosa` 로 값에 맞는 조사를 고르세요',
    );
  });

  it('⭐ 값과 조사 사이를 띄우지 않는다', () => {
    // `${who} 은(는)` 처럼 띄우면 조사가 **다음 낱말처럼** 보입니다.
    // 한국어에서 조사는 앞말에 붙여 씁니다.
    //
    // ⚠️ 조사 목록을 좁게 유지합니다. `${n} 개`(단위)나 `${x} 중`처럼
    // 띄어 쓰는 것이 맞는 말이 섞이면 이 가드가 **틀린 신고**를 합니다.
    const PARTICLES = ['은', '는', '이', '가', '을', '를', '와', '과', '로', '으로', '에게', '에', '의'];
    const spaced = new RegExp(`\\$\\{[^{}]*\\}\\s+(${PARTICLES.join('|')})[\\s\`]`);
    const offenders: string[] = [];
    for (const { rel, code } of codeFiles()) {
      // 템플릿 리터럴 안만 본다
      for (const lit of code.matchAll(/`[^`]*`/g)) {
        if (spaced.test(lit[0])) offenders.push(`${rel} → ${lit[0].slice(0, 50)}`);
      }
    }
    strictEqual(offenders.join('\n'), '', '`withJosa(값, 짝)` 으로 붙여 쓰세요');
  });

  it('⭐ 값 바로 뒤에 조사를 글자로 붙이지 않는다 (결함 88)', () => {
    // **네 번째 층입니다.** 앞의 둘은 `${값} 조사` 처럼 **띄운** 것을
    // 봤고, 이건 **붙여 놓은** 것을 봅니다. 붙여 써서 띄어쓰기 가드가
    // 통과시켰고, 짝 표기가 아니라 `은(는)` 가드도 통과시켰습니다.
    //
    // 칸반 카드 버튼이 그래서 이랬습니다.
    //
    //     `${escapeHtml(describeStatus(s))}로`  →  진행 중로
    //
    // `진행 중` 은 받침이 있으므로 `진행 중으로` 입니다. `할 일로` 와
    // `완료로` 는 맞아서, 세 버튼 중 **하나만** 틀린 채로 있었습니다 —
    // 눈으로 훑으면 넘어가기 딱 좋은 모양입니다.
    const PARTICLES = ['은', '는', '이', '가', '을', '를', '와', '과', '으로', '로'];
    const attached = new RegExp(`\\}(${PARTICLES.join('|')})(?![\\w가-힣])`);
    const offenders: string[] = [];
    for (const { rel, code } of codeFiles()) {
      for (const lit of code.matchAll(/`[^`]*`/g)) {
        if (attached.test(lit[0])) offenders.push(`${rel} → ${lit[0].slice(0, 60)}`);
      }
    }
    strictEqual(offenders.join('\n'), '', '`withJosa(값, 짝)` 으로 값에 맞는 조사를 고르세요');
  });

  // ⭐ **세 번째 층입니다** (결함 80).
  //
  // 결함 76 은 `.ts` 의 `${값} 조사` 를 고쳤고, 결함 79 는 백엔드의
  // 글자 그대로 적힌 조사를 고쳤습니다. 그런데 **화면 HTML 에 박혀 있는
  // 정적 글자**는 두 가드 어느 쪽도 안 봅니다. 실제로 아홉 자리가 남아
  // 있었습니다 — 기여도 화면의 `0 이 아닙니다`(이 제품의 핵심 불변식을
  // 말하는 문장), 녹음 화면의 `Wake Lock 을`, 로그인의 `scrypt 로`.
  //
  // ⚠️ **브라우저가 보는 대로 재야 합니다.** 소스에서 `이유</strong>를`
  // 는 붙어 있는데 태그를 공백으로 바꿔 읽으면 `이유 를` 로 보입니다.
  // 처음 쓴 검사가 그래서 멀쩡한 네 자리를 결함으로 신고했습니다 —
  // 이 세션에서 측정 방법이 틀려 없는 결함이 생긴 **열한 번째**입니다.
  // 그래서 인라인 태그는 **폭 0** 으로 지우고, 줄바꿈을 만드는 태그만
  // 줄바꿈으로 바꾸고, 연속 공백을 접습니다. 브라우저가 하는 일입니다.
  const screens = (): { name: string; html: string }[] =>
    readdirSync(PUBLIC)
      .filter((name) => name.endsWith('.html'))
      .map((name) => ({ name, html: readFileSync(join(PUBLIC, name), 'utf8') }));

  // 블록 경계 표시. 공백 접기에 안 쓸려 가도록 **글자가 아닌 것**을 씁니다.
  const BLOCK = '\u0000';
  const rendered = (html: string): string =>
    html
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, BLOCK)
      // 줄바꿈을 만드는 태그만 경계. 나머지 인라인 태그는 **폭 0** 으로 지운다
      .replace(
        /<\/?(br|p|div|li|ul|ol|h[1-6]|section|td|tr|table|dt|dd|dl|nav|button|label|option|form|main|header|footer|article|aside)\b[^>]*>/gi,
        BLOCK,
      )
      .replace(/<[^>]+>/g, '')
      // ⚠️ **소스의 줄바꿈은 브라우저가 공백으로 만듭니다.** 줄바꿈으로
      // 남겨 두면 줄 끝에 걸린 조사를 놓칩니다 — 기여도 화면의
      // `0 이⏎아닙니다` 가 실제로 그렇게 빠져나갔습니다.
      .replace(/\s+/g, ' ')
      .replace(new RegExp(` ?${BLOCK} ?`, 'g'), '\n');

  it('⭐ 화면 HTML 의 글자도 조사를 붙여 쓴다 (결함 80)', () => {
    // 앞말이 무엇이든 이것들은 조사입니다 — 띄우면 틀립니다.
    const SURE = '은|는|을|를|과|와|의|에서|으로|부터|까지|라고|이라고|처럼';
    // ⚠️ 이쪽은 **앞말이 한글이 아닐 때만** 봅니다. `이`·`가`·`로`·`도`·`만`
    // 은 조사일 수도 있고 아닐 수도 있습니다 — `그게 이 프로젝트가` 의
    // `이` 는 관형사고, `3년 만에` 의 `만` 은 의존명사입니다. 한글 뒤에서
    // 둘을 글자만 보고 가를 수 없으므로, 가를 수 있는 자리만 봅니다.
    const sure = new RegExp(`(?<=[가-힣A-Za-z0-9%)\\]"'’」』+]) (${SURE})(?=[ .,·—…!?"'\`)\\]]|$)`, 'g');
    const maybe = new RegExp(`(?<=[A-Za-z0-9%)\\]"'’」』+]) (이|가|로|도|만)(?=[ .,·—…!?"'\`)\\]]|$)`, 'g');

    const offenders: string[] = [];
    for (const { name, html } of screens()) {
      const text = rendered(html);
      for (const rx of [sure, maybe]) {
        rx.lastIndex = 0;
        for (const m of text.matchAll(rx)) {
          const at = m.index ?? 0;
          offenders.push(`${name} → …${text.slice(Math.max(0, at - 24), at + 12).replace(/\n/g, ' ')}…`);
        }
      }
    }
    strictEqual(offenders.join('\n'), '', '조사는 앞말에 붙여 쓰세요');
  });

  // ⚠️ **개발자용 오류 문구는 일부러 통과시킵니다.** 이 저장소는
  // `` `x` 를 `` 처럼 코드 이름 뒤에 조사를 띄어 쓰는 문서 관례를 쓰고,
  // 아래 셋은 화면에 안 나오고 개발자만 봅니다. 그래도 **근거를 적게**
  // 했습니다 — "그냥 예외" 로 두면 다음에 진짜 화면 문구가 여기 섞입니다.
  const DEV_ONLY_ON_PURPOSE: Record<string, string> = {
    'lib/recording/browser-adapter.ts':
      '어댑터를 잘못 끼웠을 때 개발자가 보는 throw. 화면에는 이 문장이 안 나온다.',
    'lib/recording/clock.ts':
      '시계 동기화 전에 `toServerTime` 을 부른 코드를 잡는 throw. 개발자만 본다.',
    'lib/recording/timeline.ts':
      '`timesliceMs` 를 잘못 준 코드를 잡는 throw. 개발자만 본다.',
  };

  it('⭐ 화면에 나가는 `.ts` 문자열도 조사를 붙여 쓴다 (결함 80)', () => {
    // 결함 76 의 가드는 `${값} 조사` 만 봅니다. 글자 그대로 적힌 것은
    // 통과합니다 — 실제로 `lib/pwa/install.ts` 의 iOS 설치 안내가
    // `"홈 화면에 추가" 를 누르면` 이었습니다. 결함 79 에서 백엔드가
    // 똑같이 새 나갔던 것과 **같은 자리**입니다.
    const SURE = '은|는|을|를|과|와|의|에서|으로|부터|까지|라고|이라고|처럼';
    const spaced = new RegExp(`(?<=[가-힣A-Za-z0-9%)\\]"'’」』+]) (${SURE})(?=[ .,·—…!?"'\`)\\]]|$)`);
    const offenders: string[] = [];
    for (const { rel, code } of codeFiles()) {
      if (rel in DEV_ONLY_ON_PURPOSE) continue;
      for (const lit of code.matchAll(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g)) {
        if (spaced.test(lit[0])) offenders.push(`${rel} → ${lit[0].slice(0, 60)}`);
      }
    }
    strictEqual(offenders.join('\n'), '', '조사는 앞말에 붙여 쓰세요');
  });

  it('면제 목록이 낡지 않았다', () => {
    // 면제한 파일이 사라지거나 문구가 고쳐졌는데 목록만 남으면, 그 자리에
    // 새로 들어온 진짜 결함이 조용히 면제됩니다.
    const known = new Set(codeFiles().map(({ rel }) => rel));
    const stale = Object.keys(DEV_ONLY_ON_PURPOSE).filter((rel) => !known.has(rel));
    strictEqual(stale.join(', '), '', '면제 목록에 없는 파일이 적혀 있습니다');
    const noReason = Object.entries(DEV_ONLY_ON_PURPOSE)
      .filter(([, why]) => why.trim().length < 20)
      .map(([rel]) => rel);
    strictEqual(noReason.join(', '), '', '면제에는 근거를 적으세요');
  });

  it('띄어 쓰는 것이 맞는 말까지 잡지는 않는다', () => {
    // 가드가 너무 넓으면 맞는 글을 고치게 만듭니다. 통과해야 하는 것을
    // 일부러 넣어 확인합니다. 의존명사·단위·관형사는 **띄어 쓰는 것이
    // 맞습니다** — 조사와 규칙이 정반대입니다.
    const ok = [
      '<p>커버리지 95% 미만이면 모드 A를 내려야 합니다.</p>',
      '<p>후보 3 개 중 2 개를 승인했습니다.</p>',
      '<p>그게 이 프로젝트가 하려는 일입니다.</p>',
      '<p>말풍선이 붙은 업무는 <strong>회의에서 나온 결정</strong>이 승인을 거친 것입니다.</p>',
      '<p>각 칸에 값을 적고 <strong>이유</strong>를 함께 적으세요.</p>',
      '<p>다시 시도할 수 있습니다.</p>',
    ];
    const SURE = '은|는|을|를|과|와|의|에서|으로|부터|까지|라고|이라고|처럼';
    const sure = new RegExp(`(?<=[가-힣A-Za-z0-9%)\\]"'’」』+]) (${SURE})(?=[ .,·—…!?"'\`)\\]]|$)`);
    const maybe = new RegExp(`(?<=[A-Za-z0-9%)\\]"'’」』+]) (이|가|로|도|만)(?=[ .,·—…!?"'\`)\\]]|$)`);
    const wronglyFlagged = ok.filter((html) => {
      const text = rendered(html);
      return sure.test(text) || maybe.test(text);
    });
    strictEqual(wronglyFlagged.join('\n'), '', '이건 띄어 쓰는 것이 맞는 말입니다');
  });
});

describe('만들어 놓고 아무도 안 쓰는 것 (결함 75)', () => {
  // 이 저장소의 **대표 실패 방식**입니다 — 결함 47(`renderNav`),
  // 감사 #8(진행률), #12(`extract_task_refs`), #13(확정 테이블),
  // 결함 63(`DEADLINE_CHANGED`) 이 전부 같은 모양이었습니다.
  // 백엔드에는 `EventType` 생산자 가드를 달았는데 **프런트에는 없었습니다.**
  //
  // 실제로 찾아보니 `lib/track/bar.ts` 의 `coverageBar`·`describeCoverage`
  // 가 그랬습니다. CSS(`.cov`)도 있고 테스트 13개도 붙어 있는데 **그리는
  // 화면이 0곳**이었습니다. 게다가 같은 판단(커버리지가 null 이면 "아직
  // 모릅니다")을 `lobby/room.ts` 가 따로 구현해 화면에 그리고 있었습니다 —
  // 같은 뜻을 두 벌 가지고 있고 그중 하나만 살아 있는 상태입니다.
  //
  // ⚠️ **면제에는 반드시 근거를 적습니다.** "테스트가 쓰니까 됐다" 는
  // 근거가 아닙니다. 왜 화면이 안 부르는데도 남겨야 하는지를 씁니다.
  const TEST_ONLY_ON_PURPOSE: Record<string, string> = {
    'lib/nav/links.ts::labelOf':
      'links.test.ts 가 "navLinks 와 tabsFor 의 라벨이 같은 표에서 나온다" 를 이걸로 확인한다. ' +
      '지우면 두 곳이 서로 다른 글자를 써도 아무도 모른다',
    'lib/nav/icons.ts::ICON_NAMES':
      '아이콘 이름 목록. icons.test.ts 가 이걸로 전부를 훑는다 — 새 아이콘이 검사를 빠져나가지 못하게',
    'lib/recording/session.ts::reduceAll':
      '이벤트를 순서대로 적용하는 재생(replay)용. 실기기 로그를 그대로 돌려 보는 데 쓴다 (docs/09 실험 5)',
    'lib/recording/capture.ts::estimateSessionBytes':
      'docs/11 비용 계산의 근거. 문서의 숫자가 코드와 어긋나지 않게 테스트가 붙잡는다',
    'lib/recording/capture.ts::estimateChunkBytes':
      '위와 같음 — docs/11 의 청크 크기 근거',
  };

  /** `import … from '…';` 을 걷어낸 것. 가져다 놓기만 한 이름은 안 센다. */
  const withoutImports = (source: string): string =>
    source.replace(/^import[\s\S]*?from\s+'[^']*';\s*$/gm, '');

  it('⭐ `lib/` 의 export 를 화면이 실제로 부른다', () => {
    const files: { rel: string; source: string }[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, name.name);
        if (name.isDirectory()) walk(full);
        else if (name.name.endsWith('.ts')) {
          files.push({
            rel: full.slice(join(ROOT, 'src').length + 1).split('\\').join('/'),
            source: readFileSync(full, 'utf8'),
          });
        }
      }
    };
    walk(join(ROOT, 'src'));

    const offenders: string[] = [];
    for (const { rel, source } of files) {
      if (!rel.startsWith('lib/') || rel.endsWith('.test.ts')) continue;
      for (const m of source.matchAll(/^export (?:function|const) (\w+)/gm)) {
        const name = m[1] as string;
        const key = `${rel}::${name}`;
        if (key in TEST_ONLY_ON_PURPOSE) continue;

        // 제 파일 안에서 쓰이면(다른 export 가 부르면) 산 것이다
        const selfUse = new RegExp(`\\b${name}\\b`, 'g');
        const inOwnFile =
          [...source.matchAll(selfUse)].length >
          [...source.matchAll(new RegExp(`^export (?:function|const) ${name}\\b`, 'gm'))].length;
        if (inOwnFile) continue;

        // ⚠️ **`import` 줄은 쓰는 것이 아닙니다** (결함 97 에서 드러남).
        //
        // 확정 화면의 배선을 일부러 지워 보니 이 가드가 통과했습니다.
        // `import { adjustmentsToRestore, BLIND_CONFIRM } from …` 줄이
        // 남아 있어서 "다른 파일이 이름을 쓴다" 로 셌기 때문입니다.
        // 이 가드의 이름이 "만들어 놓고 아무도 안 쓰는 것" 인데, 정작
        // **가져다 놓고 안 쓰는 것**을 못 봤습니다.
        //
        // (`tsc --noEmit` 이 TS6133 으로 잡긴 합니다. 그건 `npm run
        // check` 를 사람이 칠 때만 돕고, 이 가드는 `npm test` 로 돕니다.)
        const users = files.filter(
          (f) => f.rel !== rel && new RegExp(`\\b${name}\\b`).test(withoutImports(f.source)),
        );
        if (users.length === 0) {
          offenders.push(`${key} — 아무도 안 씀`);
        } else if (users.every((f) => f.rel.endsWith('.test.ts'))) {
          offenders.push(`${key} — 테스트만 씀`);
        }
      }
    }
    strictEqual(
      offenders.join('\n'),
      '',
      '화면이 안 부르는 export 입니다. 배선하거나, 지우거나, 근거를 적어 면제 목록에 넣으세요',
    );
  });

  it('⭐ 화면 파일 안에도 아무도 안 부르는 함수를 두지 않는다 (결함 97)', () => {
    // 위 가드는 `lib/` 의 export 만 봅니다. 그래서 **화면 파일 안에서**
    // 죽는 경우를 못 봤습니다. 결함 97 의 배선을 지워 보니 이랬습니다.
    //
    //     function restoreAdjustments(finals) { … }   // 아무도 안 부름
    //     let finalsKnown = false;                    // 아무도 안 읽음
    //
    // `adjustmentsToRestore` 는 이 죽은 함수가 부르고 있어서 위 가드는
    // "살아 있음" 으로 셌습니다. **죽은 것이 죽은 것을 부르면 둘 다
    // 살아 보입니다.**
    //
    // ⚠️ `tsc --noEmit` 은 TS6133 으로 이걸 잡습니다. 그런데 `tsc` 는
    // `npm install` 이 있어야 돌고, 이 저장소는 **설치 없이 도는 테스트**
    // 를 약속합니다(`frontend/README.md`). 약속을 지키면서 같은 것을
    // 보려면 여기 있어야 합니다.
    const offenders: string[] = [];
    for (const name of readdirSync(join(ROOT, 'src', 'demo'))) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const code = codeOf(readFileSync(join(ROOT, 'src', 'demo', name), 'utf8'));
      for (const m of code.matchAll(/^(?:async )?function (\w+)/gm)) {
        const fn = m[1] as string;
        const uses = [...code.matchAll(new RegExp(`\\b${fn}\\b`, 'g'))].length;
        // 선언 한 번 + 부르는 곳 한 번 = 최소 2
        if (uses < 2) offenders.push(`demo/${name} → ${fn}`);
      }
    }
    strictEqual(offenders.join('\n'), '', '만들어 놓고 아무도 안 부릅니다 — 배선하거나 지우세요');
  });

  it('면제 목록이 실재하는 자리를 가리킨다', () => {
    // 면제 목록이 낡으면 가드가 조용히 헐거워집니다 — 지운 이름이
    // 남아 있으면 다음 사람은 "면제된 게 있구나" 로만 읽습니다.
    const missing = Object.keys(TEST_ONLY_ON_PURPOSE).filter((key) => {
      const [rel, name] = key.split('::');
      const path = join(ROOT, 'src', rel as string);
      if (!existsSync(path)) return true;
      return !new RegExp(`^export (?:function|const) ${name}\\b`, 'm').test(
        readFileSync(path, 'utf8'),
      );
    });
    strictEqual(missing.join(', '), '');
  });
});

describe('체크박스 (결함 72)', () => {
  const appCss = (): string => readFileSync(join(PUBLIC, 'app.css'), 'utf8');
  const screens = (): { name: string; html: string }[] =>
    readdirSync(PUBLIC)
      .filter((name) => name.endsWith('.html'))
      .map((name) => ({ name, html: readFileSync(join(PUBLIC, name), 'utf8') }));

  /** `선택자 { 내용 }` 규칙을 전부. 주석은 미리 지운다. */
  function rules(css: string): { selector: string; body: string }[] {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
    return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
      selector: (m[1] ?? '').trim(),
      body: m[2] ?? '',
    }));
  }

  it('⭐ 글자 칸 크기를 체크박스에도 주지 않는다', () => {
    // 공용 CSS 가 `input, select, textarea { width: 100%; min-height: 44px }`
    // 였습니다. 체크박스도 `input` 이라 그 크기를 받아 **글자 칸만큼
    // 부풀었습니다** — 실측 **217×44**. 로비의 ②③ 동의와 녹음 화면의
    // Wake Lock 둘 다 파란 정사각형 하나가 화면 가운데 놓이고 라벨은
    // 저 멀리 오른쪽으로 밀렸습니다.
    //
    // `tsc` 도 테스트도 CSS 를 안 보고, 브라우저 오류도 안 납니다.
    // 캡처를 **사람 눈으로 볼 때만** 보였습니다.
    const offenders: string[] = [];
    for (const { selector, body } of rules(appCss())) {
      // 글자 칸 크기를 정하는 규칙만 본다
      if (!/\bwidth:\s*100%/.test(body) && !/min-height:\s*var\(--tap\)/.test(body)) continue;
      // 그 규칙이 `input` 을 통째로 잡는가
      if (!/(^|,)\s*input\s*(,|$)/.test(selector)) continue;
      offenders.push(selector);
    }
    strictEqual(
      offenders.join(' | '),
      '',
      '`input` 을 통째로 잡습니다. `input:not([type=checkbox]):not([type=radio])` 로 좁히세요',
    );
  });

  it('⭐ 체크박스 색을 브라우저 기본 파랑에 맡기지 않는다', () => {
    // 안 정하면 UA 스타일시트의 파랑이 칠해집니다. 청록으로 맞춘 아홉
    // 화면에 파란 것 하나가 생기고 어두운 모드도 안 따라옵니다 —
    // 결함 59(로그인 버튼만 파랑)와 같은 실패인데, **우리 CSS 가 아니라
    // 브라우저 기본을 통해** 들어오므로 날 색(hex) 가드가 못 잡습니다.
    const found = rules(appCss()).some(
      ({ selector, body }) =>
        /input\[type=['"]?checkbox/.test(selector) && /accent-color:\s*var\(--/.test(body),
    );
    strictEqual(found, true, 'app.css 가 체크박스에 accent-color 토큰을 주지 않습니다');
  });

  it('⭐ 누르는 것은 라벨이다 — 라벨이 44px 를 확보한다', () => {
    // 체크박스 상자는 13px 입니다. 그걸 44px 로 늘리면 거대한 상자가
    // 되고, 안 늘리면 접촉면이 모자랍니다. **라벨 어디를 눌러도 토글되는
    // 것이 브라우저 기본 동작**이라 실제 접촉면은 `<label>` 입니다.
    const found = rules(appCss()).some(
      ({ selector, body }) =>
        /label:has\(\s*>\s*input\[type=['"]?checkbox/.test(selector) &&
        /min-height:\s*var\(--tap\)/.test(body),
    );
    strictEqual(found, true, '체크박스를 품은 라벨에 min-height: var(--tap) 이 없습니다');
  });

  it('⭐ 체크박스 라벨의 설명을 형제로 두지 않는다', () => {
    // 로비의 ②③ 는 이렇게 적혀 있었습니다.
    //
    //     <label><input type="checkbox" …/>
    //       원본 음성 파일 보관 <span class="hint">거부하면 …</span></label>
    //
    // 라벨이 `display: grid; grid-template-columns: auto 1fr` 였는데
    // **그리드 항목이 셋**이었습니다 — 체크박스 · 익명 텍스트 · `.hint`.
    // `.hint` 가 1열로 떨어지면서 그 열이 설명 글 너비만큼 벌어지고,
    // 설명은 라벨 글자보다 **223px 왼쪽**에 찍혔습니다.
    //
    // 글자와 설명을 한 상자에 넣으면 항목이 둘이 되어 이 일이 안 생깁니다.
    const offenders: string[] = [];
    for (const { name, html } of screens()) {
      for (const label of html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)) {
        const inner = label[1] ?? '';
        if (!/type=['"]checkbox/.test(inner)) continue;
        if (!/class=['"][^'"]*\bhint\b/.test(inner)) continue;
        // 체크박스 **뒤**에 바로 오는 것이 hint 면 형제다 —
        // 감싸는 <span> 이 있으면 그 사이에 여는 태그가 하나 더 있다.
        const after = inner.slice(inner.indexOf('>', inner.indexOf('type=')) + 1);
        const nextTag = after.match(/<(\/?)([a-z]+)([^>]*)>/);
        const wrapped = nextTag?.[2] === 'span' && !/\bhint\b/.test(nextTag[3] ?? '');
        if (!wrapped) offenders.push(`${name} → ${(inner.match(/id=['"]([^'"]+)/) ?? [])[1] ?? '?'}`);
      }
    }
    strictEqual(
      offenders.join(', '),
      '',
      '설명(.hint)이 체크박스의 형제입니다. 글자와 함께 <span> 으로 감싸세요',
    );
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

  it('⭐ 초대 코드를 **화면 글자에서 복사하지 않는다**', () => {
    // 코드가 없을 때 코드 자리에는 `(없음)` 이 적혀 있습니다. 화면 글자를
    // 그대로 복사하면 클립보드에 문자열 `(없음)` 이 들어가고 버튼은
    // **"복사됨"** 이라고 말합니다. 받은 사람은 그걸 참가 칸에 넣고
    // "코드가 없습니다" 를 보고 **자기를 의심합니다.**
    const src = codeOf(readFileSync(join(DEMO, 'project.ts'), 'utf8'));
    strictEqual(
      /writeText\(\s*\$\('code'\)/.test(src),
      false,
      '화면의 `#code` 글자를 그대로 복사합니다',
    );
    strictEqual(
      /codeToCopy\(/.test(src),
      true,
      '`codeToCopy` 를 안 씁니다 — 데이터에서 만들어야 합니다',
    );
    // 코드가 없으면 누를 수 없어야 합니다.
    strictEqual(
      /disabled\s*=\s*inviteCode === null/.test(src),
      true,
      '코드가 없을 때 복사 버튼을 막지 않습니다',
    );
  });

  it('⭐ 기여도 카드가 역할을 **겸직까지** 말한다', () => {
    // 서버의 `role` 은 주 역할 **하나**입니다. `blended_profile` 이
    // `max(shares)` 로 고르는데 동률이면 사전 순에 달립니다. 그래서 카드가
    // `member.role` 을 그대로 쓰던 동안, 시연 데이터의 세 사람이 전부
    // `developer` 로 보였습니다 — 실제로는 50/50, 60/40, 70/30 이었습니다.
    //
    // ⚠️ 이걸 되돌려 봤을 때 **번들 신선도 테스트만** 깨졌습니다.
    // 그건 "빌드를 안 했다" 는 뜻이고 의미 검사가 아닙니다. tsc 의
    // 미사용 import 경고도 카드가 무엇을 그리는지는 안 봅니다.
    const card = codeOf(readFileSync(join(DEMO, 'contributions.ts'), 'utf8'));
    strictEqual(
      /roleOf\(/.test(card),
      true,
      '카드가 `roleOf` 를 안 씁니다 — 겸직이 주 역할 하나로 접힙니다',
    );
    strictEqual(
      /class="role">\$\{escapeHtml\(member\.role\)/.test(card),
      false,
      '카드가 `member.role` 을 그대로 씁니다',
    );
  });

  it('⭐ 역할을 **정할 자리가 있고 실제로 보낸다**', () => {
    // 가입·초대가 `developer: 1.0` 을 하드코딩하고 바꿀 자리가 없었습니다.
    // 그래서 기획자·디자이너 프로파일이 도달 불가였고, 문서만 쓴 사람이
    // 개발자 가중치로 계산돼 이유 없이 낮게 나왔습니다 — 오류는 안 납니다.
    const html = readFileSync(join(PUBLIC, 'project.html'), 'utf8');
    strictEqual(html.includes('id="roles"'), true, '역할 칸이 없습니다');
    strictEqual(html.includes('id="save-roles"'), true, '저장 버튼이 없습니다');

    const callers = demoFiles().filter(({ source }) =>
      /members\/me`?,/.test(codeOf(source)),
    );
    strictEqual(callers.length > 0, true, '`/members/me` 를 부르는 화면이 없습니다');
  });

  it('⭐ 확정 엔드포인트를 **실제로 부르는 화면이 있다** (docs/05 §5)', () => {
    // `docs/05` §5 는 "최종 점수를 시스템이 확정" 을 ❌ 로 금지합니다.
    // 그런데 확정을 남길 자리가 API 에도 화면에도 없어서, 배포 상태에서
    // 존재하는 값은 시스템이 계산한 숫자뿐이었습니다 — **금지한 쪽으로
    // 실제 동작한 것**입니다.
    //
    // API 만 만들고 화면을 안 붙이면 정확히 결함 47 이므로, 존재가 아니라
    // **호출**을 셉니다.
    const callers = demoFiles().filter(({ source }) =>
      /contributions\/final`?\)/.test(codeOf(source)),
    );
    strictEqual(
      callers.length > 0,
      true,
      '`/contributions/final` 을 부르는 화면이 하나도 없습니다',
    );

    // 확정 버튼도 있어야 누를 수 있습니다.
    const html = readFileSync(join(PUBLIC, 'contributions.html'), 'utf8');
    strictEqual(html.includes('id="confirm"'), true, '확정 버튼이 없습니다');
  });

  it('⭐ 3단계 동의 ②③ 을 **묻고 보낸다** (docs/07 §2.3)', () => {
    // ②③ 은 스키마에도 있고 서버도 받는데, **화면이 묻지를 않았습니다.**
    // 그래서 "3단계 분리 동의" 는 문서와 DB 에만 존재했고, 거부할
    // 방법 자체가 없었습니다. 저장만 되고 아무 효과가 없던 것도
    // 결국 아무도 거부할 수 없었기 때문입니다.
    //
    // 존재가 아니라 **호출**을 셉니다 (결함 47·63·감사 #8 교훈).
    const lobbyHtml = readFileSync(join(PUBLIC, 'lobby.html'), 'utf8');
    for (const id of ['keep-audio', 'keep-voiceprint']) {
      strictEqual(
        lobbyHtml.includes(`id="${id}"`),
        true,
        `로비에 ${id} 체크박스가 없습니다 — 물어보지 않으면 거부할 수 없습니다`,
      );
    }

    const lobbyTs = codeOf(readFileSync(join(DEMO, 'lobby.ts'), 'utf8'));
    for (const type of ['raw_audio_retention', 'voiceprint_storage']) {
      strictEqual(
        lobbyTs.includes(type),
        true,
        `로비가 ${type} 을 서버로 보내지 않습니다`,
      );
    }
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
    // (`.a, .b` 로 바탕을 깔고 `.b` 에서 높이만 다시 잡는 식).
    // 문제가 되는 것은 **같은 속성**을 두 번 정하는 것입니다.
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
