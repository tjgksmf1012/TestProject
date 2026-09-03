/**
 * 화면 스모크 — 손으로 하던 브라우저 걸음을 굳힌 것.
 *
 * ## 왜 이것이 필요했나
 *
 * `docs/24` 에서 재 봤습니다 — 결함 고침의 **53%가 화면 층**인데 그 층의
 * 자동 검사는 **0개**였습니다(`demo/*.tsx` 15 + `screens/*.tsx` 8, 전부
 * 검사 없음). 판단은 `@lib` 로 잘 모여 96% 가 검사를 갖는데, z-index ·
 * 겹침 · 고대비에서 사라지는 표시 · 잘림은 전부 `@lib` 밖입니다.
 *
 * 그래서 매 회차 사람이 브라우저로 찾고, 그 확인은 아무 데도 안 남았고,
 * **이미 찾은 자리가 다시 깨지는 것은 아무도 안 보고 있었습니다.**
 *
 * ## 이 자가 재는 것
 *
 *   A. 화면이 실제로 **서로 다른 화면**으로 열리는가 (결함 182·356)
 *   B. 5xx · 콘솔 오류가 없는가
 *   C. 잘려서 안 보이는 것이 없는가 (결함 285·354·364)
 *   D. 고대비에서 **뜻이 뭉개지지** 않는가 (결함 393·399·400 · 레인 3 A·B)
 *
 * ## ⚠️ 이 자가 **못 보는 것** (자를 만들었으면 같이 적습니다)
 *
 *   - 눌러야 나오는 것 — 대화상자·팝오버·메뉴 안은 안 봅니다
 *   - 글이 **참인가** — 「없습니다」가 거짓인지는 사람이 읽어야 합니다
 *   - 확대·큰 글자·터치 — 축을 곱하는 것은 아직 없습니다
 *   - 키보드 — Tab 순서와 초점 되돌리기
 *   - 양이 늘 때 — 씨앗 크기에서만 봅니다
 */
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(HERE, '..');
const ROOT = join(FRONTEND, '..');

/**
 * playwright 는 `frontend` 의 devDependency 입니다.
 *
 * ⚠️ 여기 **컨테이너의 전역 경로를 후보로 적어 두었다가** 한 번 당했습니다.
 * 그 후보가 있으니 로컬에서는 늘 통과했고, 그래서 「`npm ci` 뒤에 맨
 * 이름으로 풀리는가」라는 **CI 가 실제로 밟는 경로**를 한 번도 안 재고
 * 있었습니다. 후보를 지우면 안 깔렸을 때 그 자리에서 터집니다 —
 * 그게 정직한 쪽입니다.
 *
 * ⚠️ 버전은 캐럿이 아니라 **정확히** 못 박습니다. 브라우저 빌드 번호가
 * 버전에 매여 있어서, `playwright install` 이 받은 것과 `import` 가 푸는
 * 것이 다르면 「브라우저가 없다」로 죽습니다.
 */
async function loadChromium() {
  try {
    const mod = await import('playwright');
    return (mod.default ?? mod).chromium;
  } catch (err) {
    throw new Error(
      'playwright 를 못 찾았습니다 — `npm --prefix frontend ci` 를 먼저 돌리세요.\n' +
        String(err),
    );
  }
}

// ── 화면 목록은 **소스에서** 뽑습니다 ────────────────────────────
//
// ⚠️ 손으로 적으면 화면이 늘 때 조용히 낡습니다 (결함 305·329). 그러면
//    새 화면은 영영 이 자 밖입니다.

/** 로그인 없이 열리는 화면. 나머지는 로그인 뒤에 엽니다. */
const PUBLIC_SCREENS = new Set(['login', 'offline']);

/** 세션만으로는 못 여는 화면 — 장치(마이크·RTC)를 잡습니다. */
const NEEDS_DEVICE = new Set(['index', 'call']);

function legacyScreens() {
  return readdirSync(join(FRONTEND, 'public'))
    .filter((f) => f.endsWith('.html'))
    .map((f) => f.replace(/\.html$/, ''))
    .filter((name) => !NEEDS_DEVICE.has(name))
    .sort();
}

function spaRoutes() {
  const src = readFileSync(join(ROOT, 'webapp', 'src', 'main.tsx'), 'utf8');
  // ⚠️ **되돌리는 갈래는 뺍니다** — `element: <Navigate …>` 는 일부러 다른
  //    주소로 보내는 것이라 「같은 화면이 두 번 열렸다」가 참입니다. 목록을
  //    손으로 적지 않고 **소스에서 읽어** 거릅니다 (라우트가 늘어도 맞습니다).
  const routes = [...src.matchAll(/\{\s*path:\s*'([^']+)'\s*,\s*element:\s*<(\w+)/g)];
  return routes
    .filter(([, , element]) => element !== 'Navigate')
    .map(([, path]) => path)
    .filter((p) => p !== '*')
    .map((p) => p.replace(':projectId', '1').replace(':meetingId', '1').replace(':section', 'role'));
}

// ── 서버 ────────────────────────────────────────────────────────

async function waitFor(url, seconds = 90) {
  for (let i = 0; i < seconds * 2; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* 아직 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function bootServer(port, dbPath, audioRoot) {
  const env = {
    ...process.env,
    DATABASE_URL: `sqlite:///${dbPath}`,
    AUDIO_STORAGE_ROOT: audioRoot,
    ASR_BACKEND: 'fake',
  };
  const py = join(ROOT, '.venv', 'bin', 'python');
  const run = (args) =>
    new Promise((res, rej) => {
      const p = spawn(py, args, { cwd: ROOT, env, stdio: 'inherit' });
      p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`${args[0]} exit ${c}`))));
    });
  await run(['-m', 'alembic', 'upgrade', 'head']);
  await run(['scripts/seed_demo.py', '--reset']);
  const server = spawn(
    py,
    ['-m', 'uvicorn', 'teamflow.api.main:app', '--host', '127.0.0.1', '--port', String(port), '--app-dir', 'backend'],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const up = await waitFor(`http://127.0.0.1:${port}/home.html`);
  // ⚠️ 200 은 「내 서버가 떴다」가 아니라 「누가 거기 있다」입니다 (결함 182).
  if (!up || /address already in use/i.test(log)) {
    server.kill();
    throw new Error(`서버가 안 떴습니다 (포트 ${port}). 로그:\n${log.slice(-800)}`);
  }
  return server;
}

// ── 브라우저 안에서 도는 자들 ──────────────────────────────────
//
// ⚠️ 이 함수들은 **문자열로 넘어가 브라우저 안에서** 돕니다. 바깥 변수를
//    참조하면 안 됩니다.

/** 보임 — `getBoundingClientRect` 는 「자리를 차지하는가」이지 「보이는가」가 아닙니다. */
const VISIBLE = `(el) => el.checkVisibility({
  contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })`;

/**
 * C. 잘려서 안 보이는 것.
 *
 * ⚠️ 세 가지를 갈라야 없는 결함을 안 만듭니다:
 *   - `.vh`·`.visually-hidden` 은 **설계상** 1×1 로 잘립니다
 *   - `position: fixed` 는 **설계상** 조상의 클리핑을 벗어납니다
 *   - 가장 가까운 「가로를 막는」 조상이 `auto/scroll` 이면 **굴려서 닿습니다**
 */
const CLIPPING = `() => {
  const visible = ${VISIBLE};
  const SCREEN_READER_ONLY = ['visually-hidden', 'vh', 'sr-only'];
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    if (SCREEN_READER_ONLY.some((c) => el.classList.contains(c))) continue;
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed') continue;

    // ① 자기 상자 안에서 자르는가
    if (cs.overflowX === 'hidden' || cs.overflowX === 'clip') {
      if (el.scrollWidth > el.clientWidth + 1) {
        out.push({ why: '자기 상자에서 잘림', sel: name(el),
                   sw: el.scrollWidth, cw: el.clientWidth });
        continue;
      }
    }
    // ② 가장 가까운 「가로를 막는」 조상 밖으로 나갔는가
    let box = el.parentElement;
    while (box) {
      const bs = getComputedStyle(box);
      if (bs.overflowX !== 'visible') break;
      box = box.parentElement;
    }
    if (!box) continue;
    const bs = getComputedStyle(box);
    if (bs.overflowX === 'auto' || bs.overflowX === 'scroll') continue;  // 굴려서 닿음
    if (getComputedStyle(box).position === 'fixed') continue;
    const a = el.getBoundingClientRect(), b = box.getBoundingClientRect();
    if (a.width === 0) continue;
    const over = Math.max(b.left - a.left, a.right - b.right);
    if (over > 2) {
      out.push({ why: '막는 조상 밖으로 나감', sel: name(el),
                 box: name(box), over: Math.round(over) });
    }
  }
  return out;

  function name(el) {
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + id + cls;
  }
}`;

/**
 * D. 고대비에서 **뜻이 뭉개지는가**.
 *
 * `forced-colors: active` 는 채움과 테두리를 시스템 색으로 덮습니다. 색
 * 하나에 뜻을 실은 자리는 거기서 통째로 사라집니다.
 *
 * ⚠️ **「하나가 됐는가」가 아니라 「가짓수보다 줄었는가」로 묻습니다** —
 *    다섯 상태가 둘로 줄어도 뜻은 사라집니다 (결함 393 회차).
 *
 * ⚠️ 뿌리 클래스의 **수식자**(`.base--mod`)와 **`aria-current`** 를 둘 다
 *    봅니다. 결함 400 의 census 가 수식자만 훑어 `[aria-current="page"]`
 *    를 구조적으로 못 봤고, 그래서 레인 3 이 셸에서 다시 찾았습니다.
 */
const VARIANT_SIGNATURES = `() => {
  const visible = ${VISIBLE};

  // ⚠️ **알파 0 을 「투명」으로 봐야 합니다.** Chromium 은 고대비 밝음에서
  //    배경을 \`rgba(255,255,255,0)\` 로 답합니다. 글자로 비교하면
  //    \`rgb(255,255,255)\` 와 **달라 보여서**, 흰 바탕 위 흰 막대를
  //    「모양이 다르다」로 읽습니다 — 레인 3 이 자기 자에서 겪은 그것이고
  //    이 자도 처음에 같은 구멍이 있었습니다.
  const rgba = (c) => {
    const m = String(c).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const n = m[1].split(',').map((x) => parseFloat(x));
    return { r: n[0], g: n[1], b: n[2], a: n.length > 3 ? n[3] : 1 };
  };
  /** 실제로 칠해지는 배경 — 조상을 걸어 알파가 있는 첫 색. */
  const effBg = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.01) return \`\${c.r},\${c.g},\${c.b}\`;
    }
    return '255,255,255';
  };
  /** 바탕과 같거나 투명하면 **없는 것**입니다. */
  const ink = (color, bg) => {
    const c = rgba(color);
    if (!c || c.a < 0.01) return 'none';
    const key = \`\${c.r},\${c.g},\${c.b}\`;
    return key === bg ? 'none' : key;
  };

  const groups = {};
  const add = (key, tag, el) => {
    const cs = getComputedStyle(el);
    const bf = getComputedStyle(el, '::before');
    const bg = effBg(el.parentElement ?? el);
    // ⚠️ **안 보이는 ::before 는 「없는 것」과 같아야 합니다.** 처음에는
    //    'none/none' 과 'none' 을 다르게 세어, 고대비에서 막대가 바탕색이
    //    되어도 「모양이 다르다」로 읽었습니다 — 심어 보고 알았습니다.
    const markBg = bf.content === 'none' || bf.content === ''
      ? 'none' : ink(bf.backgroundColor, bg);
    // ⚠️ 폭이 0 인 테두리는 **색이 무엇이든 안 보입니다.** 처음에는 색만
    //    보고 세어, 안 보이는 막대를 「모양이 다르다」로 읽었습니다.
    const markBd = bf.content === 'none' || bf.content === '' || parseFloat(bf.borderTopWidth) === 0
      ? 'none' : ink(bf.borderTopColor, bg);
    const mark = markBg === 'none' && markBd === 'none' ? 'none' : markBg + '/' + markBd;
    const border = (w, c) => (parseFloat(w) > 0 ? w + ':' + ink(c, bg) : 'none');
    const sig = [
      ink(cs.color, bg),
      ink(cs.backgroundColor, bg),
      border(cs.borderTopWidth, cs.borderTopColor),
      border(cs.borderBottomWidth, cs.borderBottomColor),
      border(cs.borderLeftWidth, cs.borderLeftColor),
      cs.fontWeight, cs.fontStyle, cs.textDecorationLine,
      mark,
    ].join('|');
    (groups[key] ??= { shapes: {}, texts: {} });
    (groups[key].shapes[tag] ??= new Set()).add(sig);
    (groups[key].texts[tag] ??= new Set()).add((el.textContent ?? '').trim().slice(0, 40));
  };

  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const classes = typeof el.className === 'string' ? el.className.trim().split(/\\s+/) : [];
    const base = classes.find((c) => c && !c.includes('--'));
    const mod = classes.find((c) => c.includes('--'));
    if (base && mod) add('mod:' + base, mod, el);
    const nav = el.closest('nav, [role="navigation"], #tabs, .tabs, .rail, .chan');
    if (nav && (el.tagName === 'A' || el.tagName === 'BUTTON')) {
      add('cur:' + (nav.id || nav.className || nav.tagName),
          el.getAttribute('aria-current') ? 'current' : 'other', el);
    }
  }
  const out = {};
  for (const [k, g] of Object.entries(groups)) {
    const sigs = new Set();
    for (const s of Object.values(g.shapes)) for (const v of s) sigs.add(v);
    // ⚠️ **글자가 뜻을 나르면 색이 사라져도 사실은 안 없어집니다.**
    //    「검토 필요」·「처리 중」처럼 갈래마다 다른 글자를 가진 배지는
    //    고대비에서 뭉개져도 읽을 수 있습니다 — 결함 393 이 「값은 글자로,
    //    그림은 폭이나 개수만」으로 정해 둔 그것이고, 레인 3 이 걸린 것을
    //    하나씩 읽어 무죄로 가른 기준입니다.
    //
    //    ⛔ 「cur:」(지금 어디인가)는 **예외입니다.** 「홈」·「칸반」이라는
    //    글자는 **그 탭이 무엇인지**를 말하지 **내가 거기 있는지**를 말하지
    //    않습니다. 그래서 글자가 달라도 뜻은 색에만 실려 있습니다.
    const carriesText = !k.startsWith('cur:')
      && Object.values(g.texts).every((t) => [...t].some((x) => x.length > 0))
      && new Set(Object.values(g.texts).map((t) => [...t].sort().join('\u0001'))).size
         === Object.keys(g.texts).length;
    // ⛔ 「cur:」는 **현재 ↔ 나머지**만 봅니다. 모양 가짓수를 통째로 세면
    //    나머지끼리 뭉개지는 것(예: 위험 탭이 붉은색을 잃는 것)까지 걸려서,
    //    정작 재려는 「지금 어디인가」가 그 소음에 묻힙니다.
    const cur = g.shapes['current'];
    const other = g.shapes['other'];
    const currentStandsOut =
      cur && other ? [...cur].some((x) => !other.has(x)) : null;
    out[k] = {
      tags: Object.keys(g.shapes).length,
      shapes: sigs.size,
      currentStandsOut,
      carriesText,
    };
  }
  return out;
}`;

// ── 걷기 ────────────────────────────────────────────────────────

/**
 * 고대비에서 뭉개지지만 **뜻은 안 사라지는** 자리.
 *
 * ⚠️ 예외에는 **왜 예외인가**를 적습니다. 그리고 아래에서 **예외가
 *    낡는 것도 잽니다** — 더 이상 뭉개지지 않으면 이 표에서 빼라고
 *    빨개집니다 (결함 306 이 라우트 예외에서 정한 방법).
 */
const EXCUSED = new Map([
  [
    'mod:ribbon__seg',
    '리본의 채움은 고대비에서 사라지지만 값은 옆 「?」 팝오버가 글자로 '
      + '나릅니다(「확신 45% · 모름 55%」). 「지우지 않고 한 겹 아래로」는 '
      + 'docs/22 처방 ③ 의 기록된 결정이고, 레인 3 이 눌러서 확인했습니다. '
      + '⛔ 이 자는 **눌러야 나오는 것을 못 봅니다** — 그래서 규칙이 아니라 '
      + '예외입니다.',
  ],
]);

const PORT = Number(process.env.SMOKE_PORT ?? 8899);
const BASE = process.env.SMOKE_BASE ?? `http://127.0.0.1:${PORT}`;
const SEED = { email: 'minsu@example.com', password: 'teamflow-demo' };

async function visit(page, url) {
  const problems = [];
  const onConsole = (m) => {
    if (m.type() === 'error') problems.push(`콘솔: ${m.text().slice(0, 160)}`);
  };
  const onResponse = (r) => {
    if (r.url().includes('/api/') && r.status() >= 500) {
      problems.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`);
    }
  };
  page.on('console', onConsole);
  page.on('response', onResponse);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  const shape = await page.evaluate(() => ({
    els: document.querySelectorAll('*').length,
    heading: document.querySelector('h1')?.innerText?.trim() ?? '(h1 없음)',
    url: location.pathname + location.search,
  }));
  page.off('console', onConsole);
  page.off('response', onResponse);
  return { ...shape, problems };
}

async function main() {
  const chromium = await loadChromium();
  const scratch = process.env.SMOKE_SCRATCH ?? '/tmp/teamflow-smoke';
  let server = null;
  if (!process.env.SMOKE_BASE) {
    const { mkdirSync, rmSync } = await import('node:fs');
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    server = await bootServer(PORT, `${scratch}/smoke.db`, `${scratch}/audio`);
  }

  const failures = [];
  const excusedFired = new Set();
  const note = (screen, why) => failures.push(`${screen}: ${why}`);
  const browser = await chromium.launch({ args: ['--no-sandbox', '--lang=ko-KR'] });

  try {
    const targets = [
      ...legacyScreens().map((s) => ({
        id: `레거시/${s}`,
        url: `${BASE}/${s}.html${PUBLIC_SCREENS.has(s) ? '' : '?project=1&meeting=1'}`,
        needsLogin: !PUBLIC_SCREENS.has(s),
      })),
      ...spaRoutes().map((p) => ({
        id: `SPA${p}`,
        url: `${BASE}/app${p === '/' ? '/' : p}`,
        needsLogin: p !== '/login',
      })),
    ];

    // ⚠️ **대비 루프 밖**에 둡니다. 안에 두면 고대비 회차에서 새 Map 이
    //    되어 보통 회차의 값이 버려지고, 비교가 `undefined` 와 이뤄져
    //    **아무것도 안 재면서 초록**입니다. 처음 쓸 때 그랬습니다.
    const baseline = new Map();

    for (const contrast of [false, true]) {
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: 'ko-KR',
      });
      const page = await ctx.newPage();
      if (contrast) await page.emulateMedia({ forcedColors: 'active' });

      // 로그인은 **제품 경로로** 한 번
      await page.goto(`${BASE}/login.html`);
      await page.fill('#email', SEED.email);
      await page.fill('#password', SEED.password);
      await page.click('button[type=submit]');
      await page.waitForURL(/home\.html/, { timeout: 20000 });

      const seen = new Map();

      for (const t of targets) {
        const label = contrast ? `${t.id} (고대비)` : t.id;
        const r = await visit(page, t.url);
        for (const p of r.problems) note(label, p);

        if (!contrast) {
          // A. 서로 **다른 화면**으로 열렸는가 — 같은 지문이면 되돌려진 것입니다
          const print = `${r.els}|${r.heading}`;
          if (seen.has(print)) {
            note(label, `${seen.get(print)} 와 같은 화면입니다 (els=${r.els} · h1=${r.heading}) `
              + `— 주소가 되돌려졌을 수 있습니다`);
          } else {
            seen.set(print, t.id);
          }
          // C. 잘림
          for (const c of await page.evaluate(`(${CLIPPING})()`)) {
            note(label, `잘림 — ${c.why}: ${c.sel} ${JSON.stringify(c)}`);
          }
          baseline.set(t.id, await page.evaluate(`(${VARIANT_SIGNATURES})()`));
        } else {
          // D. 고대비에서 가짓수가 줄었는가
          const now = await page.evaluate(`(${VARIANT_SIGNATURES})()`);
          const was = baseline.get(t.id) ?? {};
          // `SMOKE_DEBUG=1` 로 자가 **무엇을 보고 있는지** 찍습니다.
          // ⚠️ 「0건」을 믿기 전에 이걸로 자가 헛돌고 있지 않은지 보십시오.
          if (process.env.SMOKE_DEBUG) {
            const keys = new Set([...Object.keys(was), ...Object.keys(now)]);
            for (const k of keys) {
              console.log(`   [debug] ${t.id} ${k}: 보통 ${JSON.stringify(was[k])} → 고대비 ${JSON.stringify(now[k])}`);
            }
          }
          for (const [key, v] of Object.entries(now)) {
            const before = was[key];
            if (!before) continue;
            if (key.startsWith('cur:')) {
              // 「지금 어디인가」 — 현재가 나머지와 갈라지는가만 봅니다
              if (before.currentStandsOut === true && v.currentStandsOut === false) {
                note(label, `「지금 어디인가」가 사라짐 — ${key}: 보통에서는 현재 탭이 `
                  + `나머지와 갈라지는데 고대비에서 똑같아집니다`);
              }
              continue;
            }
            if (v.carriesText) continue;  // 글자가 뜻을 나릅니다
            if (EXCUSED.has(key)) {
              if (before.shapes > 1 && v.shapes < before.shapes) excusedFired.add(key);
              continue;  // 위 표에 이유가 적혀 있습니다
            }
            if (before.shapes > 1 && v.shapes < before.shapes) {
              note(label, `뜻이 뭉개짐 — ${key}: 모양 ${before.shapes}가지 → ${v.shapes}가지 `
                + `(갈래 ${v.tags}개)`);
            }
          }
        }
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    server?.kill();
  }

  // ⚠️ **예외가 낡는 것도 잽니다.** 고쳐서 더 이상 안 뭉개지는데 표에
  //    남아 있으면 다음 사람이 속습니다 (결함 306).
  for (const [key, why] of EXCUSED) {
    if (!excusedFired.has(key)) {
      failures.push(
        `예외가 낡았습니다 — ${key} 는 이제 아무 화면에서도 안 뭉개집니다. ` +
          `EXCUSED 에서 빼십시오. (적혀 있던 이유: ${why.slice(0, 60)}…)`,
      );
    }
  }

  if (failures.length) {
    console.error(`\n❌ 화면 스모크 ${failures.length}건\n`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log('✅ 화면 스모크 통과');
}

await main();
