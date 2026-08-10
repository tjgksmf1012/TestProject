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
import { readdirSync, readFileSync } from 'node:fs';
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
  return [...wanted].sort().map((name) => join(DEMO, `${name}.ts`));
}

/** 소스에서 곧바로 뽑은 번들. `{파일이름 → 내용}`. 디스크에 쓰지 않습니다. */
export async function bundle(): Promise<Map<string, string>> {
  const result = await build({
    ...OPTIONS,
    entryPoints: entryPoints(),
    outdir: PUBLIC,
    write: false,
  });
  return new Map(result.outputFiles.map((f) => [basename(f.path), f.text]));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const entries = entryPoints();
  await build({ ...OPTIONS, entryPoints: entries, outdir: PUBLIC });
  console.log(`${entries.length}개 화면을 빌드했습니다.`);
}
