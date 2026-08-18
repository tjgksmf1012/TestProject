/**
 * 데모 화면 번들.
 *
 * ## 왜 파일로 뺐는가
 *
 * 예전에는 `package.json` 의 `build:demo` 에 진입점 여덟 개가 **손으로**
 * 적혀 있었습니다. 화면을 하나 더 만들고 거기 적는 걸 잊으면, 그 화면은
 * `<script src="/새화면.js">` 를 받으러 갔다가 404 를 만납니다 — 그런데
 * 테스트는 전부 통과합니다. 테스트는 `src/` 를 읽고 브라우저는
 * `public/*.js` 를 받기 때문입니다.
 *
 * 그래서 두 가지를 바꿨습니다.
 *
 *   1. 진입점을 **세어서** 정합니다. 화면 HTML 이 불러오는 스크립트가
 *      곧 진입점입니다 (`entryPoints`).
 *   2. 번들 내용을 메모리로도 뽑을 수 있게 했습니다 (`bundle`). 그래야
 *      테스트가 "지금 소스로 빌드한 것"과 "public 에 놓인 것"을 비교해
 *      **낡은 번들**을 잡을 수 있습니다.
 *
 * 낡은 번들은 이 저장소가 반복해서 당한 실패 방식입니다 — 고친 것이
 * 화면에 반영되지 않았는데 아무 데서도 티가 안 납니다.
 */

import { build } from 'esbuild';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');
const DEMO = join(ROOT, 'src', 'demo');

/** esbuild 설정. 빌드와 검사가 **같은 것**을 써야 비교가 의미 있습니다. */
export const OPTIONS = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  charset: 'utf8',
  /* ⚠️ `automatic` 이라 화면 파일이 `import React` 를 적지 않아도 됩니다.
     `classic` 으로 두면 JSX 마다 React 를 손으로 가져와야 하고, 빠뜨린
     파일만 **런타임에** 터집니다 — 빌드는 통과하고요. */
  jsx: 'automatic',

  /* ⭐ **React 를 넣자마자 번들이 1206KB 가 됐습니다** (다른 화면은 37~69KB).

     원인 둘:

       1. `process.env.NODE_ENV` 를 안 정해 주면 React 가 **개발 빌드**로
          들어갑니다. 개발 빌드는 경고 문구·이름 추적·개발자도구 연동을
          통째로 품고 있어서, 크기만이 아니라 **런타임도 느립니다.**
          그런데 화면은 멀쩡히 돌기 때문에 티가 안 납니다 — 폰에서
          1.2MB 를 받는 것이 어떤 일인지도요.
       2. 압축을 안 했습니다.

     둘을 켜니 1206KB → 260KB 였고, React 를 안 쓰는 화면들도 같이
     줄었습니다 (69→38 · 47→29 · 44→26).

     ⚠️ 이 저장소는 번들을 `public/` 에 **커밋**합니다 — 설치 없이 데모가
     돌아야 하기 때문입니다. 압축하면 그 파일이 읽기 어려워지지만, 읽을
     것은 `src/` 이지 번들이 아닙니다. 그리고 `guards.test.ts` 가 "지금
     소스로 빌드한 것과 같은가" 를 계속 비교하므로 낡은 번들은 그대로
     잡힙니다.

     ⚠️ **여기 "이 `define` 을 지우면 가드가 터진다" 고 적어 뒀는데
     거짓이었습니다.** 네 가지로 실제 빌드해서 쟀습니다:

       지금 그대로        review 258KB   개발빌드 문구 없음 → 가드 통과
       define 만 뺌       review 258KB   없음 → 통과   ← 아무 차이가 없다
       minify 만 뺌       review 719KB   없음 → 통과   ← 2.8배인데 안 잡힌다
       둘 다 뺌           review 1206KB  있음 → 터짐

     `minify` 가 켜져 있으면 esbuild 가 `process.env.NODE_ENV` 를
     `"production"` 으로 **알아서** 넣습니다. 그래서 `define` 은 지금
     아무 일도 안 합니다 — 남겨 두는 것은 나중에 `minify` 를 끄더라도
     개발 빌드가 새지 않게 하려는 것이고, 그게 이 줄의 **유일한** 값입니다.

     그리고 진짜 구멍은 `minify` 였습니다. 꺼도 개발 빌드 검사는 통과하고,
     낡은 번들 검사도 (다시 빌드해 커밋하면) 통과합니다. 그래서
     `guards.test.ts` 에 **압축된 것과 커밋된 것이 같은가**를 따로
     넣었습니다. 상수를 만들지 않고 결과로 잽니다. */
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },

  /* ⭐ **공용 조각을 따로 뺍니다** (docs/19 §24.7).

     화면마다 번들 하나씩 통으로 만들면 `lib/` 도 React 도 화면 수만큼
     복사됩니다. React 화면이 하나뿐일 때는 복사할 것이 없어서 켜면
     오히려 손해였고, 그래서 안 켰습니다. 두 번째 화면(칸반)이 오면서
     실제로 복사가 생겼고, 재 보니 이렇습니다:

       끄면  합계 622KB   review 259KB · kanban 212KB · home 20KB
       켜면  합계 336KB   review  55KB · kanban   8KB · home  4KB

     절반 이하입니다. 화면 하나를 여는 데 받는 양도 줄어듭니다 — 조각은
     화면끼리 공유되므로 두 번째 화면부터는 이미 캐시에 있습니다.

     ⚠️ 조각 이름에는 **해시**가 붙어 빌드마다 바뀝니다. 예전에는 그것이
     못 켜는 이유였습니다 — `sw.js` 의 오프라인 목록이 손으로 적는
     것이라 빌드마다 어긋났기 때문입니다. 그 목록을 빌드가 쓰게 바꾼
     뒤에야 이걸 켤 수 있었습니다. 순서가 있었습니다. */
  splitting: true,
  chunkNames: 'chunk-[hash]',
} as const;

// `src="/main.js"` 와 `src="./main.js"` 둘 다 씁니다. 한쪽만 보면 화면
// 두 개를 조용히 안 만들게 됩니다 — 실제로 처음 쓸 때 그렇게 됐습니다.
const MODULE_SCRIPT = /<script[^>]*\ssrc="\.?\/([A-Za-z0-9_-]+)\.js"/g;

/**
 * 진입점 = 화면 HTML 이 실제로 불러오는 스크립트.
 *
 * `src/demo` 를 통째로 세지 않는 이유: `nav.ts`·`pwa.ts` 처럼 다른
 * 화면이 가져다 쓰는 공용 모듈이 섞여 있습니다. 그것들은 번들 안에
 * 들어가야지 따로 나오면 안 됩니다.
 */
export function entryPoints(): string[] {
  const wanted = new Set<string>();
  for (const file of readdirSync(PUBLIC)) {
    if (!file.endsWith('.html')) continue;
    const html = readFileSync(join(PUBLIC, file), 'utf8');
    for (const [, name] of html.matchAll(MODULE_SCRIPT)) if (name) wanted.add(name);
  }
  /* ⚠️ **`.tsx` 를 먼저 봅니다.** 화면을 React 로 옮기는 동안 두 종류가
     섞이는데, 확장자를 `.ts` 로 못박아 두면 옮긴 화면이 조용히
     `Could not resolve` 로 죽습니다 — 그런데 그건 빌드 로그 안쪽이라
     테스트에는 안 보입니다. */
  return [...wanted].sort().map((name) => {
    const tsx = join(DEMO, `${name}.tsx`);
    return existsSync(tsx) ? tsx : join(DEMO, `${name}.ts`);
  });
}

/**
 * 소스에서 곧바로 뽑은 번들. `{파일이름 → 내용}`. 디스크에 쓰지 않습니다.
 *
 * `overrides` 는 가드가 **설정을 일부러 달리 잡아** 빌드해 볼 때 씁니다 —
 * "압축을 강제해도 커밋된 것과 같은가" 처럼요.
 */
export async function bundle(
  overrides: Record<string, unknown> = {},
): Promise<Map<string, string>> {
  const result = await build({
    ...OPTIONS,
    ...overrides,
    entryPoints: entryPoints(),
    outdir: PUBLIC,
    write: false,
  });
  return new Map(result.outputFiles.map((f) => [basename(f.path), f.text]));
}

/**
 * 오프라인에 **없어도 되는** 것. 근거를 적어야 합니다.
 *
 * 근거 없는 면제는 다음 사람이 그냥 늘립니다 — 그러면 목록 검사가
 * 있으나 마나가 됩니다.
 */
export const NOT_CACHED: Record<string, string> = {
  'sw.js': '서비스 워커 자신. 자기를 캐시하면 새 버전으로 못 갑니다',
};

/**
 * 서비스 워커가 미리 받아 둘 것 — **디렉터리에서 셉니다.**
 *
 * ## ⚠️ 왜 손으로 안 적는가
 *
 * 이 목록은 **두 번 어긋났습니다.** 화면·자산을 새로 만들 때마다
 * 빠뜨렸고, 빠뜨려도 아무 데서도 티가 안 납니다 — 온라인에서는 서버가
 * 주니까 멀쩡하고, 오프라인에서만 그 화면이 안 뜹니다. 그런데 오프라인은
 * 개발 중에 거의 안 겪는 상태입니다.
 *
 * 빠져 있던 것 중에는 `/tokens.css` 도 있었습니다 — **모든 색·간격·글꼴**
 * 이라, 그것만 없어도 오프라인에서 전 화면이 스타일 없는 흰 문서가 됩니다.
 *
 * 가드로 대조하는 것까지 했었는데, 그건 **어긋난 뒤에** 잡는 것입니다.
 * 애초에 갈라지지 않게 빌드가 씁니다. 순서는 정렬해서 고정합니다 —
 * 설치는 `Promise.all` 이라 순서가 동작을 바꾸지 않고, 정렬해 두면
 * 빌드마다 애먼 diff 가 안 납니다.
 *
 * ## 확장자로 안 고릅니다
 *
 * 예전 목록은 "HTML·CSS·번들·manifest" 만 담고 아이콘은 **면제 목록**에
 * 근거를 적어 빼 뒀습니다. 그런데 면제 판단이 실제로 어긋나 있었습니다 —
 * `icon-180.png` 은 화면 열 개가 전부 가리키는데 면제였고,
 * `icon-192.png` 만 목록에 들어 있었습니다. 아무도 못 봤습니다.
 *
 * 아이콘 넷을 합쳐 **24KB** 입니다. 이만한 것을 놓고 판단을 하니까
 * 판단이 틀렸습니다. 그래서 규칙을 없앴습니다 — `public/` 에 있으면
 * 캐시합니다. 예외는 서비스 워커 자신 하나뿐이고, 그건 자기를 캐시하면
 * 새 버전으로 못 가기 때문입니다.
 */
export function shellFiles(): string[] {
  return readdirSync(PUBLIC, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.') && !(e.name in NOT_CACHED))
    .map((e) => `/${e.name}`)
    .sort();
}

/** sw.js 안의 `SHELL` 배열을 지금 `public/` 에 맞게 다시 씁니다. */
export function writeShellList(): number {
  const path = join(PUBLIC, 'sw.js');
  const source = readFileSync(path, 'utf8');
  const files = shellFiles();
  const body = files.map((url) => `  '${url}',`).join('\n');
  const next = source.replace(
    /(\/\* <<< 자동 생성[^*]*\*\/\n)[\s\S]*?(\n\s*\/\* >>> \*\/)/,
    `$1${body}$2`,
  );
  if (next === source && !source.includes(body)) {
    throw new Error('sw.js 에서 자동 생성 표시를 찾지 못했습니다');
  }
  writeFileSync(path, next);
  return files.length;
}

/**
 * 데스크톱 셸(main·preload)을 빌드합니다.
 *
 * ## ⚠️ `public/` 에 넣지 않습니다
 *
 * `shellFiles()` 가 `public/` 을 통째로 세어 오프라인 목록을 만듭니다.
 * 거기 두면 **브라우저 사용자가 Electron main 번들을 내려받습니다** —
 * 쓰지도 못하는 것을. `out/` 으로 뺍니다.
 *
 * ## ⚠️ 왜 electron-vite 를 안 쓰는가
 *
 * 인계 자료집이 권한 도구인데, 그 권고의 전제가 **"이미 Vite 를 쓰고
 * 있다"** 입니다. 이 저장소는 Vite 를 안 씁니다 — esbuild 와 이 파일이
 * 전부이고, 화면도 SPA 가 아니라 HTML 열여섯 장짜리입니다. 도입하면
 * 얻는 것 없이 **번들러가 두 벌**이 됩니다 (대표 실패 ②).
 *
 * ## ⚠️ `.cjs` 로 내보냅니다
 *
 * `package.json` 이 `"type": "module"` 이라 `.js` 는 ESM 으로 읽힙니다.
 * 그런데 **sandbox 가 켜진 preload 는 ESM 을 못 씁니다** — 확장자를
 * 잘못 두면 창은 뜨는데 preload 만 **조용히 안 돕니다.** 오류도 안 납니다.
 */
export async function buildDesktop(): Promise<string[]> {
  const outdir = join(ROOT, 'out');
  const result = await build({
    entryPoints: [
      join(ROOT, 'electron', 'main', 'index.ts'),
      join(ROOT, 'electron', 'preload', 'index.ts'),
    ],
    outdir,
    outbase: join(ROOT, 'electron'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outExtension: { '.js': '.cjs' },
    target: 'node22',
    charset: 'utf8',
    // ⚠️ `electron` 은 런타임이 주는 것이라 번들에 넣으면 안 됩니다.
    external: ['electron'],
    // 압축하지 않습니다 — 웹 번들과 달리 내려받는 것이 아니라 사용자
    // 기계에서 도는 코드이고, 크래시 스택을 읽을 수 있어야 합니다.
    minify: false,
    metafile: true,
  });
  return Object.keys(result.metafile.outputs).sort();
}

/** 지금 `public/` 에 놓인 공용 조각. 이름에 해시가 붙습니다. */
export const chunkFiles = (): string[] =>
  readdirSync(PUBLIC).filter((name) => /^chunk-[A-Z0-9]+\.js$/.test(name));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // ⚠️ **먼저 옛 조각을 지웁니다.** 해시가 붙은 이름이라 내용이 바뀌면
  // 새 파일이 생길 뿐 옛 파일은 덮이지 않습니다. 안 지우면 아무도 안
  // 부르는 조각이 쌓이고, 오프라인 목록은 `public/` 을 세므로 그 죽은
  // 조각까지 폰에 내려받게 됩니다.
  for (const name of chunkFiles()) rmSync(join(PUBLIC, name));

  const entries = entryPoints();
  await build({ ...OPTIONS, entryPoints: entries, outdir: PUBLIC });
  // ⚠️ **번들을 만든 뒤에** 셉니다. 먼저 세면 이번에 새로 생긴 화면의
  // 번들이 아직 디스크에 없어서 목록에서 빠집니다.
  const cached = writeShellList();
  const desktop = await buildDesktop();
  console.log(
    `${entries.length}개 화면을 빌드했고, 오프라인 목록 ${cached}개를 적었습니다. ` +
      `데스크톱 셸 ${desktop.length}개.`,
  );
}
