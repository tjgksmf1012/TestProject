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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEMO = join(ROOT, 'src', 'demo');
const PUBLIC = join(ROOT, 'public');

const demoFiles = (): { name: string; source: string }[] =>
  readdirSync(DEMO)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, source: readFileSync(join(DEMO, name), 'utf8') }));

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
