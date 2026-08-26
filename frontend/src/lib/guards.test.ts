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

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { bundle, chunkFiles, entryPoints, shellFiles } from '../../build.mts';
import { confidenceRibbon, describeTeamRibbon, sharedConfidence } from './contribution/ribbon.ts';
import { whyCannotConfirm } from './contribution/final.ts';
import {
  attentionAbout,
  canSubmit,
  summarize,
  whyCannotSubmitBatch,
  type ReviewContext,
  type ReviewSummary,
  confidenceReading,
} from './review/candidates.ts';
import {
  describeMissingSummary,
  reviewPhase,
  whyCannotFinishReview,
} from './review/phase.ts';
import { meetingLabel } from './ui/naming.ts';
import { appRailHref } from './nav/rail.ts';
import { withJosa } from './text/josa.ts';
import { EVIDENCE_CHIPS_SHOWN, splitEvidenceChips } from './review/evidence.ts';
import { describeMeetingWhen, meetingWhen, nextStepFor } from './home/next.ts';
import { EXTRA_CONSENTS, memberStatuses, roomLine } from './lobby/room.ts';
import {
  blockers,
  initialState,
  reduce,
  reduceAll,
  type SessionEvent,
} from './recording/session.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEMO = join(ROOT, 'src', 'demo');
const LIB = join(ROOT, 'src', 'lib');
const PUBLIC = join(ROOT, 'public');

/**
 * 화면 파일 전부.
 *
 * ⚠️ **`.tsx` 를 빠뜨리면 가드가 통째로 눈을 감습니다.**
 *
 * React 로 옮기기 시작하면서 첫 화면 조각(`evidence.tsx`)을 만들었더니,
 * 그 파일이 분명히 부르는 `lib/` export 를 가드가 **"테스트만 씀"** 이라고
 * 했습니다. 규칙이 깨진 게 아니라 **찾는 방법이 낡은** 것이었습니다 —
 * 이 저장소가 반복해서 당한 그것이고, 이번에는 화면을 하나씩 옮기는
 * 동안 옮긴 화면마다 조용히 감시가 사라졌을 자리입니다.
 *
 * `.test.ts` 는 뺍니다. 테스트가 부르는 것은 "화면이 쓴다" 가 아닙니다.
 */
const SCREEN_EXT = /\.tsx?$/;

const demoFiles = (): { name: string; source: string }[] =>
  readdirSync(DEMO)
    .filter((name) => SCREEN_EXT.test(name) && !name.endsWith('.test.ts'))
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
 * `이름(...)` 호출의 **인자 전체**를 괄호 짝을 맞춰 떼어 온다.
 *
 * 창을 "뒤 400자" 로 잡으면 인자가 길 때 잘리고, 짧을 때는 남의 코드를
 * 먹습니다. 어느 쪽이든 규칙이 엉뚱한 것을 재게 됩니다.
 */
function callArgs(code: string, fnName: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(new RegExp(`\\b${fnName}\\(`, 'g'))) {
    const open = (m.index as number) + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') {
        depth--;
        if (depth === 0) {
          out.push(code.slice(open + 1, i));
          break;
        }
      }
    }
  }
  return out;
}

/**
 * **선언형으로** 잠그는가 — React 화면이 잠그는 방법.
 *
 * 명령형 화면은 버튼을 붙잡고 `disabled = true` 를 씁니다. React 화면은
 * 그럴 수 없습니다 — DOM 은 React 가 갖고 있고, 화면이 직접 만지면
 * 다음 렌더에 그대로 지워집니다. 그래서 모양이 다릅니다:
 *
 *     setSending(true) … setSending(false) … disabled={… || sending}
 *
 * ⚠️ **셋을 다 봅니다.** 켜기만 보면 안 푸는 화면이 통과하고, 켜고 끄기만
 * 보면 버튼에 **안 이어진** 깃발이 통과합니다 — 이 저장소가 반복해 당한
 * "만들어 놓고 아무도 안 부름" 이 규칙 안에서 재현되는 자리입니다.
 */
/** `const 이름 = … => { … }` 의 **몸통**. 중괄호 짝을 맞춰 떼어 옵니다. */
function bodyOf(code: string, name: string): string {
  const at = new RegExp(`\\bconst ${name}\\s*=`).exec(code);
  if (at === null) return '';
  const open = code.indexOf('{', at.index);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return '';
}

/** 이 핸들러가 (한 단계 건너서라도) 서버를 바꾸러 가는가. */
function mutates(code: string, name: string, seen = new Set<string>()): boolean {
  if (seen.has(name)) return false;
  seen.add(name);
  const body = bodyOf(code, name);
  if (body === '') return false;
  if (/trySend\(/.test(body)) return true;
  // `create` 가 `send(...)` 를 부르는 모양. 한 단계만 따라갑니다.
  for (const [, called] of body.matchAll(/\b(?:void\s+)?([a-z]\w*)\(/g)) {
    if (mutates(code, called as string, seen)) return true;
  }
  return false;
}

/** `<button …>` 여는 태그들. 속성 블록만 돌려줍니다. */
function buttonTags(code: string): string[] {
  return [...code.matchAll(/<button\b([^>]*)>/g)].map((m) => m[1] as string);
}

function locksDeclaratively(code: string): boolean {
  for (const m of code.matchAll(/\bset([A-Z]\w*)\(true\)/g)) {
    const suffix = m[1] as string;
    const flag = suffix[0]?.toLowerCase() + suffix.slice(1);
    if (!new RegExp(`\\bset${suffix}\\(false\\)`).test(code)) continue;
    // ① 진짜 `disabled` 로 잠그거나 …
    if (new RegExp(`disabled=\\{[^}]*\\b${flag}\\b`).test(code)) return true;
    // ② … 이 저장소가 **더 좋아하는 모양**으로 잠그거나.
    if (locksByAriaDisabled(code, flag)) return true;
  }
  return false;
}

/**
 * `aria-disabled` 로 잠그는 것도 **잠그는 것**입니다 (결함 365).
 *
 * ⚠️ 이 자는 원래 `disabled=\{…flag…\}` 라는 **글자**만 봤습니다. 결함 365
 * 에서 레거시 검토의 「제출」을 결함 234 의 모양(`aria-disabled` — 초점을
 * 받고, 눌리고, 사유를 말함)으로 바꾸자 **요구는 하나도 안 바뀌었는데**
 * 이 자만 빨개졌습니다. 「가드가 「글자 자리」를 재고 있어서 내가 공용으로
 * 올리자 터진 것」(결함 335)과 같은 부류입니다.
 *
 * 요구는 「누르는 동안 두 번째 요청이 안 나간다」이므로 **둘 다** 봅니다 —
 * 화면이 그 값으로 `aria-disabled` 를 그리는가, 그리고 **누르는 손이 그
 * 값을 보고 되돌아가는가.** 그리는 것만 있고 되돌아가지 않으면
 * `aria-disabled` 는 낭독기에게 하는 말일 뿐이고 요청은 두 번 나갑니다.
 *
 * 플래그를 그대로 쓰지 않고 **한 번 감싼 이름**(`const submitBlocked =
 * whyCannotSubmitBatch(summary, \{ sending \})`)도 따라갑니다.
 */
function locksByAriaDisabled(code: string, flag: string): boolean {
  const carriers = new Set<string>([flag]);
  for (const m of code.matchAll(/\bconst (\w+)\s*=([^;]*);/g)) {
    if (new RegExp(`\\b${flag}\\b`).test(m[2] as string)) carriers.add(m[1] as string);
  }
  for (const name of carriers) {
    const drawn = new RegExp(`aria-disabled=\\{[^}]*\\b${name}\\b`).test(code);
    /* ⚠️ 되돌아가기가 **블록 안**에 있어도 되돌아가는 것입니다 —
       `if (x !== null) { setMessage(…); return; }` (결함 372). 처음 이 자는
       `) return` 만 봐서, 요구는 하나도 안 바뀌었는데 빨개졌습니다. */
    const refuses = new RegExp(
      `if\\s*\\([^)]*\\b${name}\\b[^)]*\\)\\s*\\{?[\\s\\S]{0,200}?\\breturn\\b`,
    ).test(code);
    if (drawn && refuses) return true;
  }
  return false;
}

/**
 * 화면 모듈의 소스. `review` 처럼 `.tsx` 로 옮긴 화면도 찾습니다.
 *
 * ⚠️ `${stem}.ts` 로 하드코딩하면 옮긴 화면에서 **파일이 없다고 터지거나**
 * (탭바 가드) **조용히 건너뜁니다** (진입점 목록). 둘 다 실제로 났습니다.
 */
function demoSource(stem: string): string | null {
  for (const ext of ['.tsx', '.ts']) {
    try {
      return readFileSync(join(DEMO, `${stem}${ext}`), 'utf8');
    } catch {
      /* 다음 확장자 */
    }
  }
  return null;
}

/**
 * 이 화면이 그 조각을 **어디에든** 갖고 있는가 — HTML 이든 화면 모듈이든.
 *
 * ⚠️ 화면을 React 로 옮기면 마크업이 `.html` 에서 `.tsx` 안으로 옮겨
 * 갑니다. 요구("누를 버튼이 있는가")는 그대로인데 **찾는 자리**가 낡아
 * 검사만 터집니다. 이 저장소가 이번 이전에서 여섯 번 겪은 모양입니다.
 */
function screenHas(stem: string, needle: string): boolean {
  const html = (() => {
    try {
      return readFileSync(join(PUBLIC, `${stem}.html`), 'utf8');
    } catch {
      return '';
    }
  })();
  return html.includes(needle) || (demoSource(stem) ?? '').includes(needle);
}

/**
 * 이 모듈이 실제로 붙는 HTML. 진입점이 아니면 null.
 *
 * `main.ts` 만 이름이 다릅니다 — 녹음 화면이 `index.html` 이라서.
 *
 * ⚠️ 확장자를 `/\.ts$/` 로 벗기면 `review.tsx` 는 하나도 안 벗겨져
 * `review.tsx.html` 을 찾고, 없으니 **진입점이 아니라고 답합니다.**
 * 그러면 `bootApp` 가드가 옮긴 화면을 조용히 놓칩니다.
 */
function htmlFor(moduleName: string): string | null {
  const stem = moduleName.replace(SCREEN_EXT, '');
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

  it('⭐ 로그인 말고는 전부 내비게이션이 있다', () => {
    // 전체화면 PWA·WebView 에는 주소창도 뒤로가기도 없다. 내비가 없으면
    // 그 화면은 정말 막다른 길이 된다.
    // 로그인은 아직 어느 프로젝트 사람인지도 모르고, 오프라인 화면은
    // 연결이 없어서 어디로도 갈 수 없다 — 둘 다 링크가 죽은 링크가 된다.
    //
    // ⚠️ 요구는 "막다른 길 금지"이지 "#tabs 가 있을 것"이 아닙니다.
    // 리디자인(v2 F2) 뒤 녹음·통화는 옛 탭바 대신 SPA 셸을 미러링한
    // `#sparail`(레일 + 하단 탭바 전환)을 씁니다 — 그것도 내비입니다.
    const exempt = new Set(['login.html', 'offline.html']);
    const missing = screens()
      .filter(({ name }) => !exempt.has(name))
      .filter(({ html }) => !html.includes('id="tabs"') && !html.includes('id="sparail"'))
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
      const source = demoSource(script);
      if (source === null) {
        offenders.push(`${name} → ${script} 소스를 못 찾음`);
        continue;
      }
      if (!/renderNav\(/.test(source)) offenders.push(`${name} → ${script}`);
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
    // `#tabs` 와 `#nav` 은 예외입니다 — **전 화면이 같은 뜻으로 쓰는 둘**
    // 입니다. `renderNav` 가 화면마다 정확히 하나씩 채우고, 그 하나가
    // 모든 화면에서 같은 것(아래 탭바 · 더 보기 줄)입니다. 이건 이름이
    // 겹쳐서 생긴 사고가 아니라 의도한 공용 요소입니다.
    //
    // ⚠️ `#nav` 을 더할 때 **먼저 세어 봤습니다** — 이 이름을 다른 뜻으로
    // 쓰는 화면이 있으면 그건 예외가 아니라 결함 55·56 그 자체입니다.
    // 열두 화면 전부 셸이 채우는 그 자리이고, 읽는 코드는 `nav.ts` 한
    // 곳뿐입니다 (결함 305 에서 되살렸습니다).
    const GLOBAL_IDS = new Set(['#tabs', '#nav']);
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

  /**
   * 글자 크기 토큰 → px. `tokens.css` 에서 읽습니다.
   *
   * ⚠️ 이게 없을 때 아래 가드는 **`font-size: var(--fs-label)` 을 그냥
   * 건너뛰었습니다.** 정규식이 숫자만 찾는데 `var(...)` 는 숫자가 아니라
   * `continue` 로 빠졌고, 그래서 검토 화면의 13px 담당자·마감일 칸이
   * "0건" 으로 통과했습니다. **토큰을 쓰면 가드가 눈을 감는** 모양입니다.
   */
  const fontTokens = (): Map<string, number> => {
    const css = readFileSync(join(PUBLIC, 'tokens.css'), 'utf8');
    const map = new Map<string, number>();
    for (const m of css.matchAll(/(--fs-[a-z0-9-]+)\s*:\s*([\d.]+)(rem|px)\s*;/g)) {
      map.set(m[1] as string, m[3] === 'px' ? Number(m[2]) : Number(m[2]) * 16);
    }
    return map;
  };

  /** 선언에서 px 를 뽑습니다. 토큰이면 풀어서. 못 풀면 `null`. */
  const pxOf = (value: string, tokens: Map<string, number>): number | null => {
    const token = /var\((--fs-[a-z0-9-]+)\)/.exec(value);
    if (token !== null) return tokens.get(token[1] as string) ?? null;
    const literal = /([\d.]+)(rem|px|em)/.exec(value);
    if (literal === null) return null;
    return literal[2] === 'px' ? Number(literal[1]) : Number(literal[1]) * 16;
  };

  it('⭐ 입력 칸 글자를 16px 밑으로 내리지 않는다', () => {
    // iOS Safari 는 글자가 16px 보다 작은 입력 칸에 포커스가 가면 화면을
    // 확대하고, **확대된 채로 돌아오지 않는다.** 사람은 앱이 깨졌다고
    // 느낀다. 0.9375rem = 15px 이 딱 그 함정이다.
    //
    // ⚠️ 마우스 전용 미디어 쿼리(`hover: hover`) 안은 봐 줍니다 — iOS 는
    // 거기 안 들어옵니다. 손가락에서만 16px 이면 됩니다.
    const tokens = fontTokens();
    ok(tokens.size >= 3, `tokens.css 에서 글자 토큰을 ${tokens.size}개밖에 못 읽었습니다`);

    const offenders: string[] = [];
    for (const { name, html } of screens()) {
      const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
      // ⚠️ **주석을 먼저 걷어냅니다.** 이 검사는 `{` 앞의 글자를 통째로
      //    선택자로 보는데, 바로 위에 붙은 주석도 거기 딸려 들어옵니다.
      //    그래서 주석에 `select` 라는 낱말이 있으면 `<span>` 규칙이
      //    입력 칸으로 잡혔습니다 — 실제로 `.mrole-flat` 이 그렇게
      //    걸렸습니다(그 주석은 "잠긴 select 대신 글자" 라고 적혀
      //    있었습니다). 바로 아래 44px 검사는 이미 이렇게 하고 있었고,
      //    여기만 빠져 있었습니다.
      const bare = style.replace(/\/\*[\s\S]*?\*\//g, '');
      // 마우스 전용 블록은 통째로 들어냅니다.
      const touch = bare.replace(
        /@media\s*\([^)]*hover:\s*hover[^)]*\)[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g,
        '',
      );
      for (const rule of touch.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
        const selector = (rule[1] ?? '').trim();
        if (!/\binput\b|\btextarea\b|\bselect\b/.test(selector)) continue;
        // 체크박스·라디오는 글자를 넣는 칸이 아니라 확대가 안 일어납니다.
        if (/checkbox|radio/.test(selector)) continue;
        const decl = /font-size:\s*([^;]+)/.exec(rule[2] ?? '');
        if (decl === null) continue;
        const px = pxOf(decl[1] as string, tokens);
        if (px !== null && px < 16) offenders.push(`${name} → ${selector} (${px}px)`);
      }
    }
    strictEqual(offenders.join(', '), '', 'iOS 에서 포커스가 가면 화면이 확대되고 안 돌아옵니다');
  });

  it('⭐ 컨트롤을 **손가락에서** 줄이지 않는다 (`--tap` 44px)', () => {
    // `tokens.css` 가 `--tap: 2.75rem /* 44px — 손가락 끝 접촉면 */` 이라고
    // 정하고 `app.css` 가 `button, .btn { min-height: var(--tap) }` 으로
    // 겁니다. 그런데 화면별 `<style>` 이 `min-height: 0` 으로 되돌리면
    // 그 규칙이 사라집니다.
    //
    // 마우스에서 컨트롤을 작게 하는 것 자체는 맞습니다 — 칸반이 그걸
    // **`@media (hover: hover) and (pointer: fine)` 안에서** 합니다.
    // 문제는 그 밖에서 하는 것입니다. 검토·프로젝트가 그랬고, 실제 폰
    // 에뮬레이션(`hasTouch`)으로 재니 버튼이 40.1px, 제목 칸이 35.5px
    // 이었습니다.
    //
    // ⚠️ 폭만 390 으로 줄여서 재면 **안 잡힙니다.** Chromium 은 그때도
    // `hover: hover` 를 보고해서 마우스용 규칙이 그대로 먹습니다. 그렇게
    // 재서 칸반을 위반으로 잘못 셀 뻔했습니다.
    const offenders: string[] = [];
    for (const { name, html } of screens()) {
      const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
      const bare = style.replace(/\/\*[\s\S]*?\*\//g, '');
      const touch = bare.replace(
        /@media\s*\([^)]*hover:\s*hover[^)]*\)[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g,
        '',
      );
      for (const rule of touch.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
        const selector = (rule[1] ?? '').trim();
        if (!/\bbutton\b|\bselect\b|\binput\b|\.btn\b/.test(selector)) continue;
        if (/checkbox|radio/.test(selector)) continue;
        if (!/min-height:\s*0/.test(rule[2] ?? '')) continue;
        // 글자로만 된 것(`.linkish`·아이콘 버튼)은 대상이 아닙니다 — 상자가
        // 없으므로 44px 상자를 만들 수 없습니다. 그 대신 `.linkish` 를
        // 쓰거나 `padding` 으로 접촉면을 넓힙니다.
        if (/\.linkish|\.src\b/.test(selector)) continue;
        offenders.push(`${name} → ${selector}`);
      }
    }
    strictEqual(
      offenders.join(', '),
      '',
      '`min-height: 0` 은 `@media (hover: hover) and (pointer: fine)` 안에서만 쓰세요 — '
        + '손가락에서는 44px 이어야 합니다',
    );
  });

  it('⭐ **상자로 만든 링크**도 손가락을 받아야 한다 (`--tap` 44px)', () => {
    // ⚠️ 위 가드는 `button`·`input`·`select`·`.btn` 이 `min-height: 0` 으로
    //    **되돌리는 것**만 봅니다. 그래서 링크에는 눈을 감습니다 — `<a>` 는
    //    애초에 공용 44px 규칙을 안 받으므로 되돌릴 것도 없습니다.
    //
    // 실제로 프로젝트 상태 화면의 근거 링크가 그 틈으로 들어갔습니다.
    // 폰에서 재니 **13×14px** 이고 이웃과 **6.4px** 떨어져 있었습니다.
    // 위 가드는 통과했습니다. 요구가 아니라 **찾는 자리**가 좁았던 것입니다.
    //
    // 여기서는 "링크를 상자로 만든 것" 만 봅니다 — `display` 를 준 순간
    // 그건 글줄 속 낱말이 아니라 **누르는 칸**이고, 누르는 칸은 44px 이
    // 하한입니다. 문장 속 보통 링크는 대상이 아닙니다(상자가 없습니다).
    const offenders: string[] = [];
    for (const { name, html } of screens()) {
      const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
      const bare = style.replace(/\/\*[\s\S]*?\*\//g, '');
      const touch = bare.replace(
        /@media\s*\([^)]*hover:\s*hover[^)]*\)[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g,
        '',
      );
      for (const rule of touch.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
        const selector = (rule[1] ?? '').trim();
        const body = rule[2] ?? '';
        // 선택자가 `a` 를 겨냥하는가 (`.rsrc a`·`a.chip`·`li > a` …)
        if (!/(^|[\s,>+~])a([.:#[\s,]|$)/.test(selector)) continue;
        // 상자가 됐는가
        if (!/display:\s*(inline-)?(flex|grid|block)/.test(body)) continue;
        if (/min-height:\s*var\(--tap\)/.test(body)) continue;
        offenders.push(`${name} → ${selector.replace(/\s+/g, ' ')}`);
      }
    }
    strictEqual(
      offenders.join(', '),
      '',
      '링크를 상자로 만들었으면 `min-height: var(--tap)` 도 주세요 — '
        + '누르는 칸은 손가락에서 44px 이 하한입니다',
    );
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
  // ⚠️ 위 `SCREEN_EXT` 와 같은 이유로 `.tsx` 를 봅니다.
  const demoFiles = (): { rel: string; code: string }[] =>
    readdirSync(join(ROOT, 'src', 'demo'))
      .filter((n) => SCREEN_EXT.test(n) && !n.endsWith('.test.ts'))
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
      .filter((n) => SCREEN_EXT.test(n) && !n.endsWith('.test.ts'))
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

  it('⭐ **읽는 요청도** `tryGet` 을 거친다 (결함 102)', () => {
    // 위 가드는 이름 그대로 **바꾸는** 요청만 봅니다 — `method:` 가 없으면
    // `continue` 하고 "GET 은 받아 오기 길이다" 라고 적어 두었습니다.
    // 그런데 받아 오기도 서버에 닿지 못하면 **던집니다.** 그 뒤가
    // `void start()` 면 거부가 아무 데도 안 걸립니다.
    //
    // GET 만 끊고 네 화면을 열어 봤습니다.
    //
    //     기여도  #members 가 **빈 문자열** · pageerror: Failed to fetch
    //     홈      #projects 가 **빈 문자열**
    //     칸반    #board 가 **빈 문자열**
    //     승인    말은 했는데 화면에 **`Failed to fetch`**
    //
    // 앞의 셋은 "아직 아무도 아무것도 안 했구나" 로 읽힙니다 — 이
    // 저장소가 대표 실패로 적어 둔 그 모양이고, 기여도 화면에서는
    // 버그가 아니라 **오답**입니다.
    //
    // ⚠️ 네 화면이 각자 `const get = … fetch(…)` 를 들고 있었습니다.
    // 네 벌이라 한 곳만 고치면 셋이 남습니다 — `lib/http/send.ts` 의
    // `tryGet` 한 벌로 합쳤습니다.
    /**
     * 이미 **다른 방식으로 맞게** 잡는 곳. 비워 두면 안 됩니다 —
     * 근거 없는 면제는 다음 사람이 그냥 늘립니다.
     */
    const EXEMPT: Record<string, string> = {
      'src/demo/lobby.tsx':
        '`getJson` 이 **던지는 것이 계약**이고 호출부가 `catch` 로 받아 ' +
        '`#sub` 에 "불러오지 못했습니다" 를 빨갛게 씁니다 (결함 98 에서 실측). ' +
        '이미 사람에게 말하고 있으므로 바꾸면 오히려 두 갈래가 됩니다',
      'src/demo/login.tsx':
        '`void fetch(…/me)` 는 **이미 로그인돼 있으면 넘겨 주려는** 곁길입니다. ' +
        '닿지 못하면 로그인 폼이 그대로 남고, 그게 맞는 화면입니다 — ' +
        '여기서 "서버에 닿지 못했습니다" 를 띄우면 아직 아무것도 안 한 사람을 놀래킵니다. ' +
        '⚠️ **말을 안 하는 것과 오류를 흘리는 것은 다릅니다** (결함 115) — ' +
        '`.catch(() => undefined)` 로 거부를 삼킵니다. 아래 검사가 그것을 봅니다',
    };

    const offenders: string[] = [];
    for (const { rel, code } of demoSources()) {
      if (rel in EXEMPT) continue;
      for (const { at, args } of callsOf(code, 'fetch')) {
        if (/\bmethod:/.test(args)) continue; // 바꾸는 요청은 위 가드가 본다
        const before = code.slice(Math.max(0, at - 40), at);
        // `tryGet` 안에서 부르는 것과 `trySend(() => fetch(…))` 는 맞다
        if (/trySend\(\(\)\s*=>\s*$/.test(before)) continue;
        offenders.push(`${rel} 의 읽기 fetch(`);
      }
    }

    // 면제 목록이 낡지 않았는가 — 그 파일이 이제 안 걸리면 빼야 합니다.
    const stale = Object.keys(EXEMPT).filter((rel) => {
      const source = demoSources().find((f) => f.rel === rel);
      if (!source) return true;
      return !callsOf(source.code, 'fetch').some(({ at, args }) => {
        if (/\bmethod:/.test(args)) return false;
        return !/trySend\(\(\)\s*=>\s*$/.test(source.code.slice(Math.max(0, at - 40), at));
      });
    });
    strictEqual(stale.join(', '), '', '이제 안 걸립니다 — 면제 목록에서 빼세요');
    strictEqual(
      [...new Set(offenders)].join(', '),
      '',
      '`tryGet(주소)` 를 쓰고 `null` 일 때 화면에 적으세요 — 텅 빈 화면은 "0건" 으로 읽힙니다',
    );
  });

  it('⭐ 브라우저 예외를 **변수에 담아서도** 화면에 붙이지 않는다 (결함 103)', () => {
    // 아래 가드는 `${String(err)}` 같은 **직접 붙이기**만 봅니다. 승인
    // 화면은 한 단계 돌아갔고, 그래서 통과했습니다.
    //
    //     const message = error instanceof Error ? error.message : String(error);
    //     failureHtml({ …, help: message })
    //
    // GET 을 끊으면 한글 화면에 **`Failed to fetch`** 가 그대로 떴습니다.
    const offenders: string[] = [];
    for (const { rel, code } of demoSources()) {
      // `error.message` 를 담은 변수 이름을 모으고, 그 이름이 화면으로
      // 나가는 자리에 쓰이는지 본다.
      const carriers = [
        ...code.matchAll(/const (\w+)\s*=[^;]*\b(?:err|error)\w*\.message/g),
      ].map((m) => m[1] as string);
      for (const name of carriers) {
        const toScreen = new RegExp(
          `(?:help|what|message):\\s*${name}\\b|textContent\\s*=\\s*${name}\\b|showNote\\([^)]*\\b${name}\\b`,
        );
        if (toScreen.test(code)) offenders.push(`${rel} → ${name}`);
      }
    }
    strictEqual(
      offenders.join(', '),
      '',
      '`describeUnexpected()` 를 쓰고 원문은 `console.error` 로 남기세요',
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
      // 그 파일이 잠그는 방법: 공용 helper 이거나, 직접 `disabled = true`,
      // 또는 React 의 선언형 잠금.
      const locks =
        /whilePressed\(/.test(code) || /\.disabled = true/.test(code) || locksDeclaratively(code);
      if (!locks) offenders.push(rel);
    }
    strictEqual(
      offenders.join(', '),
      '',
      '`whilePressed(button, () => …)` 로 누르는 동안 잠그세요',
    );

    // ⚠️ **위 검사는 파일 단위입니다** — "이 화면이 잠그는가" 만 봅니다.
    // 심어 보고 알았습니다: 홈에서 `만들기` 의 `disabled` 를 떼도 옆의
    // `참가` 가 아직 갖고 있어서 **통과했습니다.**
    //
    // 그게 바로 결함 89 가 적어 둔 모양입니다 — "잠그는 곳과 안 잠그는
    // 곳이 섞여 있던 것이 결함입니다." 파일 단위로 세면 그 섞임을
    // 영영 못 봅니다. 그래서 **버튼 하나씩** 봅니다.
    const loose: string[] = [];
    for (const { rel, code } of demoSources()) {
      if (!rel.endsWith('.tsx') || !/trySend\(/.test(code)) continue;
      for (const attrs of buttonTags(code)) {
        const handler = /onClick=\{([a-z]\w*)\}/.exec(attrs)?.[1];
        if (handler === undefined) continue; // 인라인 화살표는 이름이 없다
        if (!mutates(code, handler)) continue; // 서버를 안 바꾸면 잠글 것도 없다
        if (!/disabled=\{/.test(attrs)) loose.push(`${rel} → onClick={${handler}}`);
      }
    }
    strictEqual(
      loose.join(', '),
      '',
      '서버를 바꾸는 버튼인데 누르는 동안 안 잠깁니다',
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
    const source = (demoSource('lobby') ?? '');
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
    // ⚠️ HTML 에서만 찾으면 React 로 옮긴 화면에서 헛돕니다 — 요구는
    // "그 자리가 있는가" 이지 "어느 파일에 적혀 있는가" 가 아닙니다.
    for (const id of ['room-note', 'consent-note']) {
      strictEqual(screenHas('lobby', `id="${id}"`), true, `로비에 #${id} 자리가 없습니다`);
    }
  });

  it('⭐ 로그인 오류 줄이 가리키는 **칸이 실제로 있다**', () => {
    // 대표 실패 ③ — "할 일을 알려 주고 그 일을 할 자리를 안 줌".
    //
    // `validateSignup` 은 어느 칸이 비었는지 `field` 로 이미 알아냅니다.
    // 화면은 그 줄을 `<a href="#${field}">` 로 그려 누르면 그 칸으로
    // 보냅니다. 그 약속은 **`field` 이름과 `<input>` 의 id 가 같다**는
    // 것 하나에 걸려 있고, 어느 한쪽 이름만 바꾸면 링크가 조용히
    // 죽습니다 — 눌러도 아무 일이 안 일어나는데 오류는 안 납니다.
    //
    // ⚠️ 필드 목록을 여기에 손으로 적지 않습니다. `session.ts` 의 타입에서
    // 읽습니다 — 손으로 적으면 넷째 칸이 생기는 날 이 검사만 낡습니다.
    const session = readFileSync(join(LIB, 'auth', 'session.ts'), 'utf8');
    const union = /field:\s*([^;]+);/.exec(session)?.[1] ?? '';
    const fields = [...union.matchAll(/'([a-z]+)'/g)].map((m) => m[1] as string);
    ok(fields.length >= 3, `session.ts 에서 field 목록을 못 읽었습니다: ${union}`);

    const screen = demoSource('login') ?? '';
    const missing = fields.filter((f) => !screen.includes(`id="${f}"`));
    strictEqual(
      missing.join(', '),
      '',
      `오류 줄이 #${missing.join('/#')} 로 보내는데 그 id 를 가진 칸이 로그인 화면에 없습니다`,
    );

    // 그리고 줄이 정말 **링크**여야 합니다. 글자만 찍으면 갈 자리가 없습니다.
    ok(
      /href=\{`#\$\{[a-z.]+field\}`\}/.test(screen),
      '오류 줄이 `href={`#${…field}`}` 로 칸을 가리키지 않습니다',
    );
  });

  it('⭐ 안내 자리가 **낭독기에게도 들린다**', () => {
    // 대표 실패 ③ 의 소리 버전 — "저장하지 못했습니다" 를 화면에만 띄우고
    // 끝내면, 화면을 못 보는 사람에게는 아무 일도 안 일어난 것입니다.
    //
    // 실제로 이 저장소는 **화면 아홉 중 한 곳에도** live region 이 없었습니다.
    // 없는 것은 오류가 안 나서 안 보입니다.
    //
    // ⚠️ **`hidden` 과 같이 쓰면 안 됩니다.** 접근성 트리에서 요소를 빼므로
    // 안내가 뜰 때마다 region 이 새로 생기는 셈이고, 낭독기는 **이미 있던**
    // region 이 바뀔 때 읽어 줍니다. 그래서 `showNote` 는 `hidden` 을 끄기만
    // 하고, 자리를 안 차지하는 일은 `[role='status']:empty` 가 합니다.
    const offenders: string[] = [];

    // ① 명령형 화면 — 마크업의 그 자리에 역할이 붙어 있는가
    for (const [stem, ids] of [
      ['call', ['status', 'mic']],
      ['index', ['join-note', 'finish-state', 'copy-note']],
    ] as [string, string[]][]) {
      const html = readFileSync(join(PUBLIC, `${stem}.html`), 'utf8');
      for (const id of ids) {
        const tag = new RegExp(`<[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? '';
        if (!/role="(status|alert)"/.test(tag)) offenders.push(`${stem}.html #${id} 에 역할 없음`);
        if (/\bhidden\b/.test(tag)) offenders.push(`${stem}.html #${id} 이 hidden 으로 시작함`);
      }
    }

    // ② React 화면 — 공용 `NoteLine` 과 각 화면의 결과 줄
    const parts = demoSource('parts') ?? '';
    ok(/role="status"/.test(parts), '`parts.tsx` 의 `NoteLine` 에 역할이 없습니다');
    ok(
      !/return null/.test(parts.slice(parts.indexOf('export function NoteLine'))),
      '`NoteLine` 이 비었을 때 `null` 을 돌려주면 live region 이 사라집니다',
    );
    for (const stem of ['kanban', 'review', 'login']) {
      const code = demoSource(stem) ?? '';
      if (!/role="(status|alert)"/.test(code)) offenders.push(`${stem} 의 결과 줄에 역할 없음`);
    }

    // ③ 빈 자리가 여백을 남기지 않는가 — 공용 규칙이 있어야 합니다
    const appCss = readFileSync(join(PUBLIC, 'app.css'), 'utf8');
    ok(
      /\[role='status'\]:empty[\s\S]{0,120}margin:\s*0/.test(appCss),
      "`[role='status']:empty { margin: 0 }` 이 없으면 빈 안내가 빈 줄을 만듭니다",
    );

    strictEqual(offenders.join(', '), '', '안내가 낭독기에게 안 들립니다');
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

  it('⭐ 실패 문구를 **지역 변수**로도 직접 쓰지 않는다 (결함 104)', () => {
    // 결함 98 의 가드는 `$('id').textContent =` 만 봅니다. 그래서 요소를
    // **지역 변수에 담아 쓰는** 자리를 못 봤습니다.
    //
    //     const status = $('gh-backfill-status');
    //     status.textContent = unreachableText('가져오지 못했습니다');
    //
    // GitHub 지난 활동 가져오기의 진행·실패·성공이 전부 같은 회색이었고,
    // 그게 결함 98 의 **여섯 번째 자리**였습니다. 가드도 자기가 보는
    // 모양만 봅니다.
    const LOOKS_FAILED = /unreachableText\(|detailText\(|describeHttpStatus\(|못했습니다/;
    const offenders: string[] = [];
    for (const { rel, code } of demoSources()) {
      for (const m of code.matchAll(/(?<!\)['"`])\b(\w+)\.textContent\s*=([^;]*);/g)) {
        const name = m[1] as string;
        if (name === 'e' || name === 'el') continue;
        if (!LOOKS_FAILED.test(m[2] as string)) continue;
        // 그 이름이 이 파일에서 요소를 담은 변수인가
        if (!new RegExp(`const ${name}\\s*=\\s*\\$\\(`).test(code)) continue;
        offenders.push(`${rel} → ${name}.textContent`);
      }
    }
    strictEqual(
      offenders.join(', '),
      '',
      '`showNote(자리, 글자, 성공이면 \'plain\')` 을 쓰세요 — 글자와 색이 갈라집니다',
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
    ['MemberScore', 'src/lib/contribution/view.ts'],
    ['Category', 'src/lib/contribution/view.ts'],
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
    raw:
      '정규화 전 원점수다. 화면은 `team_share`(팀 안에서의 비율)를 보여준다 — ' +
      '같은 것을 뜻하는 숫자를 둘 띄우면 사람이 어느 쪽을 믿을지 모른다. ' +
      '`capture_confidence` 와 같은 이유다',
    evidence_ids:
      '근거 **건수**는 `event_count` 로 이미 보여준다. 번호 자체는 사람에게 ' +
      '읽히지 않으므로("이벤트 12, 45"), 근거를 **펼쳐 보는 화면**이 생길 때 ' +
      '읽는다. 그 화면은 아직 없다 — 없는 것을 있는 척 그리지 않는다. ' +
      '⚠️ 대신 `event_count` 와 이 목록의 길이가 갈라지지 않는지는 ' +
      '`test_scoring.py` 가 지킨다(둘은 따로 계산되는 **두 벌**이다)',
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
        else if (SCREEN_EXT.test(entry.name) && !entry.name.endsWith('.test.ts')) {
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
        else if (SCREEN_EXT.test(entry.name) && !entry.name.endsWith('.test.ts')) {
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
        else if (SCREEN_EXT.test(entry.name) && !entry.name.endsWith('.test.ts')) {
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

describe('처리되지 않은 거부 (결함 115)', () => {
  it('⭐ `void fetch(…)` 로 띄운 요청은 **`.catch` 로 닫는다**', () => {
    // 결함 87 이후 바꾸는 요청은 전부 `trySend` 를 탑니다. 남은 것은
    // **아무 말도 안 하기로 한 곁길**입니다 — 로그인 화면이 "이미
    // 로그인돼 있나" 를 물어보는 자리가 그렇습니다.
    //
    // 말을 안 하는 것은 맞습니다. 그런데 `.catch` 가 없으면 오프라인에서
    // `TypeError: Failed to fetch` 가 **처리되지 않은 거부**로 남습니다.
    // 실제로 재 보니 그랬습니다 — `pageerror` 로 잡힙니다.
    //
    //     오프라인 로그인 화면: 폼은 그대로 · 안내 없음  ← 여기까지는 맞다
    //     pageerror: TypeError: Failed to fetch          ← 이건 아니다
    //
    // **말을 안 하는 것과 오류를 흘리는 것은 다릅니다.** 로그인은 이
    // 제품의 첫 화면이고, 시연에서 개발자 도구를 열면 그 빨간 줄이
    // 첫 화면에 있습니다.
    // ⚠️ **정규식으로 문장을 자르면 안 됩니다.** 처음에 `void fetch(`
    // 부터 다음 `;` 까지로 잡았더니, 그 세미콜론이 `.then` **몸통 안**의
    // 것이라 뒤에 붙은 `.catch` 를 못 봤습니다 — 이미 고쳐 둔 코드를
    // 위반으로 신고했습니다. 괄호 깊이를 세어 문장 끝까지 갑니다.
    const statementFrom = (code: string, start: number): string => {
      let depth = 0;
      for (let i = start; i < code.length; i += 1) {
        const ch = code[i];
        if (ch === '(' || ch === '{' || ch === '[') depth += 1;
        else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
        else if (ch === ';' && depth === 0) return code.slice(start, i + 1);
      }
      return code.slice(start);
    };

    const offenders: string[] = [];

    for (const { name, source } of demoFiles()) {
      const code = codeOf(source);
      for (const hit of code.matchAll(/void\s+fetch\(/g)) {
        const statement = statementFrom(code, hit.index ?? 0);
        if (!statement.includes('.catch(')) {
          offenders.push(`${name} → ${statement.split('\n')[0]?.trim()}`);
        }
      }
    }

    strictEqual(
      offenders.join(', '),
      '',
      '`void fetch(…)` 에 `.catch` 가 없습니다 — 오프라인에서 처리되지 않은 거부가 남습니다',
    );
  });
});

describe('데스크톱 셸 (Electron)', () => {
  // 이 창은 **원격 코드**를 돌립니다 — 화면을 전부 서버가 주기 때문입니다.
  // 그래서 아래 넷은 "권장 사항" 이 아니라 서버가 뚫렸을 때 사용자 기계를
  // 지키는 **유일한 벽**입니다. 하나만 꺼도 서버의 XSS 가 곧 사용자 PC 의
  // 코드 실행이 됩니다.
  /* ⚠️ **`codeOf` 를 거칩니다.** 이 저장소의 주석은 "이렇게 하면 안
     됩니다" 를 나쁜 예와 함께 적어 둡니다 — 그대로 읽으면 규칙이 제
     설명문에 걸립니다. 실제로 그렇게 만들었다가 preload 가 `ipcRenderer`
     를 내놓는다고 잡혔습니다(결함 167). 결함 156 과 같은 실수입니다. */
  const shellCode = (file: string): string =>
    codeOf(readFileSync(join(ROOT, 'electron', file), 'utf8'));
  const mainSource = (): string => shellCode('main/index.ts');

  it('⭐ 창의 보안 기본값 넷이 켜져 있다', () => {
    const source = mainSource();
    for (const [key, want] of [
      ['contextIsolation', 'true'],
      ['nodeIntegration', 'false'],
      ['sandbox', 'true'],
      ['webSecurity', 'true'],
    ] as const) {
      const found = new RegExp(`${key}:\\s*(\\w+)`).exec(source)?.[1];
      strictEqual(found, want, `webPreferences.${key} 가 ${found} 입니다`);
    }
  });

  it('⭐ 녹음 중에 창을 닫으면 **묻는다** (결함 342)', () => {
    // 이 셸의 존재 이유는 하나뿐입니다 — 「창을 내리거나 화면이 잠겨도
    // 녹음이 안 끊기게」. 그런데 창의 X 하나면 그게 다 무너졌습니다.
    // 재 보니 녹음 중(청크 1개·절전방지 true)에 닫자 앱이 통째로 죽었고,
    // 확인도 경고도 없었습니다 — 그 구간은 영영 못 잽니다.
    const source = mainSource();
    ok(/win\.on\(\s*'close'/.test(source), "창의 `close` 를 안 잡습니다");
    ok(
      /event\.preventDefault\(\)/.test(source),
      '닫기를 막는 코드가 없습니다 — 물어도 그대로 닫히면 소용없습니다',
    );
  });

  it('⛔ 닫기 판단을 main 이 직접 하지 않는다 (결함 342)', () => {
    // main 에는 자동 검사가 안 붙습니다. 「녹음 중인가」를 여기서 직접
    // 따지면 그 판단은 영영 안 재집니다 — `@lib/desktop/closing.ts` 입니다.
    const source = mainSource();
    ok(
      /whenClosing\(/.test(source),
      'main 이 `whenClosing` 을 안 부릅니다 — 판단이 main 으로 새었습니다',
    );
    ok(
      /leavesOnAnswer\(/.test(source),
      '대화상자 응답을 main 이 직접 해석합니다 — 순서를 두 곳이 알면 갈라집니다',
    );
    // 「녹음 중인가」를 main 이 제 손으로 따지면 안 됩니다.
    ok(
      !/phase\s*===\s*'recording'|isRecording\s*=/.test(source),
      'main 이 녹음 상태를 직접 판단합니다 — 그 판단은 검사 밖입니다',
    );
  });

  it('⭐ 바깥으로 나가는 문을 전부 잠근다', () => {
    const source = mainSource();
    // 새 창은 preload 를 물려받습니다 — 남의 사이트가 이 앱의 다리 위에서
    // 돌게 두면 안 됩니다.
    ok(/setWindowOpenHandler/.test(source), '새 창 처리를 안 겁니다');
    ok(/action: 'deny'/.test(source), '새 창을 열어 주고 있습니다');
    // 서버가 뚫려 `location =` 을 실행해도 창은 안 따라가야 합니다.
    ok(/will-navigate/.test(source), '이동 잠금이 없습니다');
    // 권한은 기본이 거절이어야 합니다 — 안 걸면 Electron 이 대부분 내줍니다.
    ok(/setPermissionRequestHandler/.test(source), '권한 요청을 안 막습니다');
    ok(/setPermissionCheckHandler/.test(source), '권한 **확인** 경로가 열려 있습니다');
  });

  it('⭐ 진입을 `require.main` 으로 감싸지 않는다 (결함 166)', () => {
    // Electron 은 진입 파일을 제 모듈 시스템으로 읽어서 `require.main` 이
    // 그 모듈이 아닙니다. 감싸 두면 조건이 **언제나 거짓**이고, 앱은
    // 창을 하나도 안 연 채 살아 있습니다 — 오류는 한 줄도 안 납니다.
    ok(
      !/if\s*\(require\.main === module\)/.test(mainSource()),
      '`require.main === module` 로 감쌌습니다 — Electron 에서는 언제나 거짓입니다',
    );
  });

  it('⭐ 판단이 main 프로세스에 살지 않는다', () => {
    // main 에는 자동 검사가 안 붙습니다. 여기 판단을 두면 검증 밖입니다.
    const source = mainSource();
    ok(
      /from '\.\.\/\.\.\/src\/lib\/desktop\/server\.ts'/.test(source),
      '`lib/desktop/server.ts` 를 안 씁니다 — 판단이 main 으로 샜습니다',
    );
    ok(!/hostname ===/.test(source), '허용 주소 판단이 main 에 있습니다');
  });

  it('⭐ `--no-sandbox` 를 앱 코드에 박지 않는다', () => {
    // 검사 하네스에서는 붙입니다(컨테이너가 root 라서). 앱이 스스로 붙이면
    // 그건 위 보안 기본값을 통째로 무르는 것입니다.
    for (const file of ['main/index.ts', 'preload/index.ts']) {
      ok(!shellCode(file).includes('no-sandbox'), `${file} 이 sandbox 를 끄고 있습니다`);
    }
  });

  it('⭐ `keepsAwake` 가 참이면 절전 방지 배선이 실제로 있다', () => {
    // ⚠️ 이 짝이 깨지는 순간 녹음 화면이 "화면을 꺼도 녹음이 이어집니다"
    //    라고 **거짓말**을 시작합니다. 사람은 화면을 끄고, 그 구간은
    //    영영 못 잽니다 — 이 저장소에서 제일 비싼 실패입니다.
    //
    //    켜는 쪽이 아니라 **지우는 쪽**을 잡는 가드입니다: 나중에 누가
    //    main 의 powerSaveBlocker 나 화면의 hold 배선을 걷어내면서
    //    preload 의 값만 남겨 두는 것.
    const preload = shellCode('preload/index.ts');
    const claims = /keepsAwake:\s*true/.test(preload);
    if (!claims) return; // 거짓이면 약속이 없으므로 잴 것도 없습니다

    const main = mainSource();
    ok(/powerSaveBlocker/.test(main + shellCode('main/awake.ts')),
      'keepsAwake 가 참인데 powerSaveBlocker 가 어디에도 없습니다');
    ok(/backgroundThrottling:\s*false/.test(main),
      'keepsAwake 가 참인데 backgroundThrottling 을 안 껐습니다');

    // 화면이 실제로 잡는가 — 국면 판단(lib)을 거쳐서.
    const screen = codeOf(
      readFileSync(join(ROOT, 'src', 'demo', 'main.ts'), 'utf8'),
    );
    ok(/shouldHoldAwake/.test(screen),
      'keepsAwake 가 참인데 녹음 화면이 잡는 배선(shouldHoldAwake)이 없습니다');
  });

  it('⭐ preload 가 `ipcRenderer` 를 통째로 내놓지 않는다', () => {
    // ⚠️ **낱말을 금지하던 검사였습니다.** preload 에 IPC 가 하나도 없던
    //    동안은 그게 요구와 같아 보였지만, Phase 1 에서 보관소 다리가
    //    생기자 **올바른 코드를 막았습니다.** `ipcRenderer.invoke` 를
    //    이름 붙은 함수로 감싸는 것이 정확히 권장되는 모양입니다.
    //
    //    요구는 "낱말을 쓰지 마라" 가 아니라 **"화면에 통째로 넘기지
    //    마라"** 입니다. 아래 둘로 그 요구를 직접 잽니다.
    const source = shellCode('preload/index.ts');
    ok(/contextBridge/.test(source), 'contextBridge 를 안 씁니다');

    // ① 값으로 넘기지 않는다 — 부르는 자리(`.무엇(`)가 아닌 `ipcRenderer`
    //    가 남아 있으면 `{ ipcRenderer }` 나 `invoke: ipcRenderer.invoke`
    //    처럼 **참조를 건네주고** 있는 것입니다.
    const withoutImports = source.replace(/import[^;]*from\s*'electron';/g, '');
    const withoutCalls = withoutImports.replace(/ipcRenderer\s*\.\s*\w+\s*\(/g, '');
    ok(!withoutCalls.includes('ipcRenderer'), 'ipcRenderer 를 값으로 건네고 있습니다');

    // ② 채널 이름이 **글자로 박혀** 있다. 변수로 받으면 화면이 채널을
    //    정하게 되고, 그건 `invoke` 를 통째로 내준 것과 같습니다.
    const calls = [...withoutImports.matchAll(/ipcRenderer\s*\.\s*\w+\s*\(\s*([^,)]+)/g)];
    ok(calls.length > 0, 'IPC 가 하나도 없습니다 — 검사가 아무것도 안 재고 있습니다');
    for (const [, channel] of calls) {
      const arg = (channel ?? '').trim();
      ok(/^['"`]/.test(arg), `채널이 글자가 아닙니다: ${arg}`);
    }
  });

  /* ─────────────────────────────────────────────────────────────
     smoke.mjs 는 `npm test` 에 없습니다 (서버·디스플레이가 필요합니다).
     그래서 **화면이 바뀌어도 조용히 낡습니다** — 실제로 결함 229 가
     `#consent` 를 단추에서 링크로 바꾼 뒤, smoke 의 녹음 생존율 측정은
     **한 번도 안 돌고** 있었습니다(결함 238). 그동안 AGENTS.md 와
     docs/21 은 "생존율도 smoke 가 잽니다" 라고 적혀 있었습니다.

     아래 둘은 **서버 없이 잴 수 있는 만큼**만 잽니다 — smoke 가 무엇을
     누르는지와, 무엇으로 기다리는지가 화면과 어긋나지 않았는가.
     ───────────────────────────────────────────────────────────── */
  const smokeSource = (): string => readFileSync(join(ROOT, 'electron', 'smoke.mjs'), 'utf8');
  /**
   * ⚠️ **HTML 주석을 먼저 걷습니다.** 이 저장소의 마크업은 "예전에는 이랬고
   * 왜 바꿨다" 를 주석에 나쁜 예와 함께 적어 둡니다. 안 걷으면
   * `<!-- 예전에는 <button id="consent"> 였고… -->` 가 **진짜 태그보다
   * 먼저** 걸려, `<a>` 를 `<button>` 이라고 답합니다 — 심어 놓고 「0건」이
   * 나온 자리가 정확히 여기였습니다.
   */
  const recordingMarkup = (): string =>
    readFileSync(join(ROOT, 'public', 'index.html'), 'utf8').replace(
      /<!--[\s\S]*?-->/g,
      '',
    );

  it('⭐ smoke 가 누르는 것이 녹음 화면에 **단추로** 있다 (결함 238)', () => {
    const clicked = [...codeOf(smokeSource()).matchAll(/page\.click\('#([\w-]+)'\)/g)].map(
      (m) => m[1] as string,
    );
    ok(clicked.length > 0, 'smoke 가 아무것도 안 누릅니다 — 검사가 헛돕니다');

    const markup = recordingMarkup();
    for (const id of clicked) {
      // 로그인 화면 등 다른 화면의 것은 여기서 안 봅니다.
      if (!new RegExp(`id="${id}"`).test(markup)) continue;
      const tag = new RegExp(`<(\\w+)([^>]*\\s)?id="${id}"`).exec(markup)?.[1];
      // ⚠️ `<a>` 를 누르면 **화면 밖으로 나갑니다.** 그러면 그 뒤의 측정은
      //    다른 화면을 재고, 아무 말 없이 통과하거나 엉뚱하게 죽습니다.
      strictEqual(tag, 'button', `smoke 가 #${id}(<${tag}>)를 누릅니다 — 단추가 아닙니다`);
    }
  });

  it('⭐ smoke 가 기다리는 축이 화면이 그리는 축과 같다 (결함 238)', () => {
    const smoke = codeOf(smokeSource());
    const main = codeOf(readFileSync(join(ROOT, 'src', 'demo', 'main.ts'), 'utf8'));

    // 화면이 `aria-disabled` 로 그리는 id 들 (초점을 받아야 하는 것들)
    const ariaDriven = new Set(
      [...main.matchAll(/\$\('([\w-]+)'\)\.setAttribute\('aria-disabled'/g)].map(
        (m) => m[1] as string,
      ),
    );
    ok(ariaDriven.size > 0, '`aria-disabled` 로 그리는 버튼이 하나도 없습니다 — 검사가 헛돕니다');

    // ⚠️ `.disabled` 는 그런 버튼에서 **언제나 false** 입니다. 그것으로
    //    기다리면 기다림이 즉시 참이 되고, 다음 줄이 30초 뒤에 죽습니다.
    for (const id of ariaDriven) {
      const waitsOnDisabled = new RegExp(
        `getElementById\\('${id}'\\)\\.disabled`,
      ).test(smoke);
      ok(
        !waitsOnDisabled,
        `smoke 가 #${id} 를 \`.disabled\` 로 기다립니다 — 화면은 \`aria-disabled\` 로 그립니다`,
      );
    }
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
    const walk = (dir: string, prefix: string): void => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, name.name);
        if (name.isDirectory()) walk(full, prefix);
        else if (SCREEN_EXT.test(name.name)) {
          files.push({
            rel: full.slice(prefix.length + 1).split('\\').join('/'),
            source: readFileSync(full, 'utf8'),
          });
        }
      }
    };
    walk(join(ROOT, 'src'), join(ROOT, 'src'));
    /* ⭐ **데스크톱 셸도 부르는 쪽입니다** (`electron/`).

       여기를 안 보면 `lib/desktop/**` 이 통째로 "테스트만 씀" 으로
       잡힙니다 — 실제로는 Electron main 이 부르고 있는데요. 그리고
       반대 방향이 더 위험합니다: 셸이 부르던 것을 지웠을 때 이 가드가
       **아무 말도 안 하게** 됩니다.

       ⚠️ 화면을 옮길 때마다 이 저장소의 가드가 눈을 감았습니다(여덟 번).
       셸이 하나 늘었으면 **찾는 자리**부터 늘려야 합니다. */
    walk(join(ROOT, 'electron'), join(ROOT));

    /* ⭐ **리디자인 SPA 도 부르는 쪽입니다** (`webapp/src`, docs/22).
       그리고 지금은 주 화면 아홉이 전부 거기 있습니다.

       이 자리를 안 넣은 채로 SPA 전환을 했고, 그동안 이 가드는 **반쯤
       눈을 감고 있었습니다** — `webapp/` 만 부르는 export 는 "테스트만
       씀" 으로 잡히고(가짜 실패), 반대로 SPA 가 부르기를 그만둔 export
       는 여전히 `demo/` 가 부르는 한 아무 말도 안 했습니다(진짜 놓침).
       아홉 번째 사례입니다. */
    walk(join(ROOT, '..', 'webapp', 'src'), join(ROOT, '..', 'webapp', 'src'));

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
      // ⚠️ `.tsx` 도 봅니다 — 위 `SCREEN_EXT` 주석 참고.
      if (!SCREEN_EXT.test(name) || name.endsWith('.test.ts')) continue;
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

  it('⭐ 아무도 안 부르는 **공용 조각**이 남아 있지 않다', async () => {
    // ⚠️ 위 검사는 **한 방향만** 봅니다 — 빌드가 만든 것이 디스크에
    // 있는가. 조각을 켜기 전에는 그걸로 충분했습니다. 출력 이름이
    // 고정이라 매 빌드가 같은 파일을 덮어썼기 때문입니다.
    //
    // 조각은 이름에 **해시**가 붙습니다. 내용이 바뀌면 옛 파일이 덮이는
    // 게 아니라 **새 파일이 하나 더 생깁니다.** 지우지 않으면 아무도 안
    // 부르는 조각이 쌓이고, 오프라인 목록은 `public/` 을 세므로 그 죽은
    // 조각까지 폰에 내려받게 됩니다 — 오류는 어디에도 안 납니다.
    //
    // `build.mts` 가 빌드 전에 지웁니다. 여기서는 **정말 지워졌는지**를
    // 봅니다.
    const fresh = new Set([...(await bundle()).keys()]);
    const orphans = chunkFiles().filter((name) => !fresh.has(name));
    strictEqual(
      orphans.join(', '),
      '',
      '아무도 안 부르는 조각이 남았습니다 — `npm run build:demo` 를 실행하세요',
    );

    // ⚠️ **눈을 뜨고 있는지.** 조각이 하나도 없으면 위 0건은 아무 뜻이
    // 없습니다 — `splitting` 이 꺼졌거나 정규식이 어긋난 것입니다.
    strictEqual(chunkFiles().length > 0, true, '공용 조각을 하나도 못 찾았습니다');
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
                        '--indigo-700', '--indigo-100', '--clay-600', '--clay-100',
                        '--green-700', '--amber-800', '--red-700']) {
      strictEqual(darkTokens.has(name), true, `어두운 모드에 ${name} 이 없습니다`);
    }
  });
});

describe('메신저 셸 (docs/19)', () => {
  it('⭐ 셸이 서는 너비를 CSS 와 JS 가 **같은 숫자로** 안다', () => {
    // `.chan`(회의 채널)은 셸이 설 때만 보입니다. 그래서 `nav.ts` 는
    // 좁은 화면에서 **요청조차 보내지 않습니다** — 안 보이는 것을 위해
    // 폰의 데이터 요금을 쓰지 않으려고요.
    //
    // 그런데 그 판단이 **두 벌**입니다. CSS 는 `@media (min-width: 90rem)`
    // 로, JS 는 `matchMedia('(min-width: 90rem)')` 로 각자 압니다. CSS 에서
    // 이 숫자를 읽어 올 방법이 마땅치 않아 어쩔 수 없이 적었는데, 두 벌이
    // 있으면 한쪽만 고쳐집니다 — 이 저장소가 반복해서 당한 그것입니다.
    //
    // 갈라지면 조용합니다. CSS 만 88rem 으로 내리면 88~90rem 구간에서
    // **채널 목록이 보이는데 영영 비어 있습니다** (요청이 안 나가므로).
    const css = readFileSync(join(PUBLIC, 'app.css'), 'utf8');
    const nav = readFileSync(join(DEMO, 'nav.ts'), 'utf8');

    // ⚠️ **같은 너비의 미디어 쿼리가 여럿입니다.** 처음엔 `indexOf` 로
    // 첫 번째만 봤고, 그건 `body { padding-inline }` 하나짜리 블록이라
    // `.chan` 을 못 찾아 "0개" 가 나왔습니다 — 규칙이 아니라 **찾는
    // 방법이 틀린** 것이었습니다.
    //
    // ⚠️ 그리고 이제 셸의 너비는 **하나가 아닙니다.** 채널 목록은 90rem,
    // 맥락 패널은 100rem 부터입니다. 그래서 "첫 번째 숫자끼리" 비교하면
    // 안 되고, 두 파일이 아는 **너비 집합**을 통째로 맞춰 봅니다.
    const inCss = new Set(
      [...css.matchAll(/@media\s*\(min-width:\s*([\d.]+rem)\)/g)]
        .filter((m) => {
          const at = m.index ?? 0;
          const end = css.indexOf('\n}\n', at);
          const block = css.slice(at, end === -1 ? undefined : end);
          return /\.chan\s*\{/.test(block) || /\.ctx\s*\{/.test(block);
        })
        .map((m) => m[1] as string),
    );
    strictEqual(inCss.size, 2, `셸 열을 품은 미디어 쿼리가 ${inCss.size}개입니다 (둘이어야 합니다)`);

    const inJs = new Set(
      [...nav.matchAll(/min-width:\s*([\d.]+rem)/g)].map((m) => m[1] as string),
    );
    deepStrictEqual(
      [...inJs].sort(),
      [...inCss].sort(),
      `app.css 와 nav.ts 가 아는 셸 너비가 다릅니다 — ` +
        `그 사이 폭에서 열이 보이는데 영영 빕니다 (요청이 안 나가므로)`,
    );
  });

  it('⭐ 셸 크롬에 `<ul><li>` 를 쓰지 않는다', () => {
    // `renderNav` 가 만드는 것은 전부 `#tabs` **안에** 들어갑니다. 그런데
    // `lobby.html` 과 `index.html` 이 `ul` 에 자기 규칙을 걸어 뒀습니다 —
    // 화면별 `<style>` 은 app.css 보다 뒤에 오므로 그쪽이 이깁니다.
    // 셸에서 목록 태그를 쓰면 그 두 화면에서만 조용히 모양이 깨집니다.
    const nav = codeOf(readFileSync(join(DEMO, 'nav.ts'), 'utf8'));
    strictEqual(
      /<\s*(ul|ol|li)\b/.test(nav),
      false,
      'nav.ts 가 목록 태그를 만듭니다 — div·a 로 그리세요 (docs/19 §10)',
    );
  });

  it('⭐ 데이터가 오기 **전에** 빈 문구를 그리지 않는다', () => {
    // 빈 문구를 미리 깔아 두면 회의가 있는 사람도 잠깐 "아직 연 회의가
    // 없습니다" 를 봅니다. 텅 빈 화면이 "0건" 으로 읽히는 것과 같은
    // 결함인데, 여기서는 화면이 **거짓말을 먼저** 합니다.
    //
    // 그래서 `emptyChannelsNote()` 는 **응답을 받은 뒤에만** 불려야
    // 합니다 — `await` 보다 앞에서 부르면 그게 미리 깔린 것입니다.
    // ⚠️ 함수 **이름을 박아 두지 않습니다.** 처음엔 `fillChannels` 를
    // 찾았는데, 폰에서도 탭을 되살리려고 그 함수를 둘로 가르면서 빈 문구가
    // 다른 함수로 옮겨 갔습니다. 이름을 박아 둔 검사는 그때 아무것도 못
    // 찾고 **조용히 통과**합니다.
    const nav = codeOf(readFileSync(join(DEMO, 'nav.ts'), 'utf8'));
    const emptyAt = nav.indexOf('emptyChannelsNote(');
    strictEqual(emptyAt > -1, true, 'nav.ts 가 빈 문구를 아예 안 씁니다');

    const fnAt = nav.lastIndexOf('function ', emptyAt);
    strictEqual(fnAt > -1, true, '빈 문구를 쓰는 함수를 못 찾았습니다');
    strictEqual(
      nav.slice(fnAt, emptyAt).includes('await tryGet('),
      true,
      '응답을 받기 전에 빈 문구를 그립니다 — 회의가 있는 사람이 "없습니다" 를 봅니다',
    );
  });

  it('⭐ 회의 안에서 프로젝트를 알아내면 **탭도 다시 그린다**', () => {
    // 로비·검토는 주소에 `?meeting=` 만 있어서 처음 그릴 때 칸반·기여도·
    // 설정 셋이 흐립니다. 채널 목록을 채우려면 어차피 프로젝트를 알아내야
    // 하는데, 알고도 탭을 그대로 두면 **같은 화면이 서로 다른 말**을
    // 합니다 — 채널 링크에는 `project=1` 이 붙어 있는데 탭은 "프로젝트를
    // 고르면 열립니다" 입니다. 1600px 로비를 열어 보고 알았습니다.
    //
    // ⚠️ 그리고 이건 **폰에서도** 해야 합니다. 채널 목록은 폰에서 안
    // 보이지만 탭 넷은 보이고, 주소창 없는 PWA 에서 흐린 탭 셋은 갇히는
    // 길입니다. 그래서 너비를 보는 곳(`matchMedia`)보다 **앞에서** 다시
    // 그려야 합니다.
    // ⚠️ 처음엔 `paint({ ...context, projectId })` 를 **글자 그대로** 찾았고,
    // 인자를 하나 더 붙이자마자(`, title`) 못 찾아서 깨졌습니다. 규칙이
    // 깨진 게 아니라 **찾는 방법이 부러진** 것입니다. 지금은 순서를 봅니다:
    //
    //     await resolveProjectId(…)  →  paint(…)  →  matchMedia(…)
    //
    // 가운데가 빠지거나 마지막 뒤로 밀리면 잡습니다.
    // ⚠️ **파일 전체에서 첫 `matchMedia(` 를 찾으면 안 됩니다.** 결함 343
    // 이 `renderNav` 에 폭 감시를 하나 붙이자 그 호출이 파일 맨 앞으로
    // 와서, 요구는 하나도 안 바뀌었는데 이 검사만 빨개졌습니다. 이
    // 검사가 재려는 것은 **`fillChannels` 안의 순서**입니다 — 걷는 자리를
    // 그 함수 몸통으로 좁힙니다.
    const whole = codeOf(readFileSync(join(DEMO, 'nav.ts'), 'utf8'));
    const bodyAt = whole.indexOf('async function fillChannels(');
    strictEqual(bodyAt > -1, true, 'nav.ts 에 fillChannels 가 없습니다 — 이 검사도 고치세요');
    const nav = whole.slice(bodyAt);

    const learn = nav.indexOf('await resolveProjectId(');
    const gate = nav.indexOf('matchMedia(');
    strictEqual(learn > -1 && gate > -1, true, 'nav.ts 의 모양이 바뀌었습니다 — 이 검사도 고치세요');

    const repaint = nav.indexOf('paint(', learn);
    strictEqual(
      repaint > -1 && repaint < gate,
      true,
      '프로젝트를 알아낸 뒤 **너비를 보기 전에** 탭을 다시 그려야 합니다 — ' +
        '안 그러면 폰의 로비에서 칸반·기여도·설정 셋이 흐린 채로 남습니다',
    );
  });

  /*
   * 결함 343 — 「갈 수 없습니다」라고 적은 화면이 그 자리로 가는 링크를
   * 여섯 개 그리고 있었습니다.
   *
   * `missingLinks` 는 이제 「셸이 지금 회의 목록을 그리고 있는가」를 받아서
   * 판단합니다. 그 값을 화면이 **상수로 적으면** 판단이 통째로 죽는데,
   * `@lib` 의 검사는 순수 함수만 보므로 그것을 구조적으로 못 봅니다
   * (대표 실패 ①: 만들어 놓고 아무도 안 부름).
   *
   * ⚠️ 낱말이 아니라 **요구**를 잽니다 — 「폭을 본다」와 「프로젝트를
   * 본다」 둘 다 그 값을 정하는 자리에 있어야 합니다. 회의 목록은
   * `SHELL_WIDTH` 아래에서 접히고, 프로젝트를 모르면 채울 수가 없습니다.
   *
   * ⚠️ 레거시만 잽니다. SPA(`webapp/`)의 라우트는 전부 `:projectId` 를
   * 들고 있어 이 상태가 아예 없고, 회의 목록 열도 없습니다 — 걷는 자리를
   * 늘리기 전에 **그 뿌리에 그 상태가 있는지**부터 세었습니다.
   */
  it('⭐ 「회의 목록이 보이는가」를 상수로 적지 않는다 (결함 343)', () => {
    const whole = codeOf(readFileSync(join(DEMO, 'nav.ts'), 'utf8'));

    const call = whole.indexOf('missingLinks(');
    strictEqual(call > -1, true, 'demo/nav.ts 가 missingLinks 를 안 부릅니다');

    // 그 값을 정하는 자리 — 인자로 바로 적었든 위에서 만들었든, 같은
    // 함수 안에 있습니다. `paintNav` 몸통을 통째로 봅니다.
    const bodyAt = whole.indexOf('function paintNav(');
    strictEqual(bodyAt > -1, true, 'demo/nav.ts 에 paintNav 가 없습니다 — 이 검사도 고치세요');
    const body = whole.slice(bodyAt, whole.indexOf('\n}', bodyAt));

    const decided = body.match(/meetingListShown\s*:([^,}]*)/);
    strictEqual(decided !== null, true, 'paintNav 안에서 meetingListShown 을 안 정합니다');
    const value = (decided?.[1] ?? '').trim();

    strictEqual(
      /^(true|false)$/.test(value),
      false,
      `meetingListShown 을 상수 「${value}」로 적었습니다 — 그러면 결함 343 이 그대로 돌아옵니다`,
    );
    strictEqual(
      value.includes('matchMedia'),
      true,
      '회의 목록은 창이 좁으면 접힙니다 — 폭을 보지 않으면 좁은 창에서 안내가 통째로 사라집니다',
    );
    strictEqual(
      value.includes('projectId'),
      true,
      '프로젝트를 모르면 회의 목록을 채울 수가 없습니다 — 그때는 목록이 있다고 하면 안 됩니다',
    );
  });

  it('⭐ 빈 채널 구역이 **선을 긋지 않는다**', () => {
    // 홈에는 프로젝트 맥락이 없어서 회의를 받아 올 수 없고, 그 구역이 빈
    // 채로 남습니다. 그런데 `border-top` 은 그려져서 **아무것도 없는
    // 아래에 가로줄 하나**가 남았습니다 — 홈을 렌더해서 보고 알았습니다.
    //
    // 이 저장소에서 **두 번째**입니다. 처음은 프로젝트 레일 자리를 72px
    // 미리 비워 둔 것이었습니다. 없는 것을 위해 자리를 잡아 두면 그건
    // 빈칸이 아니라 결함입니다.
    // ⚠️ 처음엔 `.chan` **하나만** 봤습니다. 그래서 맥락 패널에서
    // `.ctx:empty` 를 지워도 **조용히 통과**했습니다 — 284px 짜리 빈 열이
    // 생기는데도요. 일부러 지워 보고 알았습니다. 셸이 세우는 열을 전부
    // 봅니다.
    const css = readFileSync(join(PUBLIC, 'app.css'), 'utf8');
    const missing: string[] = [];
    for (const name of ['chan', 'ctx', 'rail']) {
      // 자리를 차지하는 장식(선·바탕)을 걸었다면 빈 경우를 반드시 빼야 합니다.
      const rule = new RegExp(`\\.${name}\\s*\\{[^}]*(border-top|border-left|background)`);
      if (!rule.test(css)) continue;
      if (!new RegExp(`\\.${name}:empty\\s*\\{[^}]*display:\\s*none`).test(css)) {
        missing.push(`.${name}`);
      }
    }
    strictEqual(
      missing.join(', '),
      '',
      '선이나 바탕을 그리는데 `:empty { display: none }` 이 없습니다 — ' +
        '받아 올 것이 없는 화면에 빈 열·빈 줄이 남습니다',
    );
  });

  it('⭐ 레일이 **설 때만** 그 자리를 잡는다', () => {
    // 이 저장소가 같은 실수를 두 번 했습니다.
    //
    //   §11  `--shell-rail` 만큼 왼쪽을 비워 뒀는데 레일이 없어서
    //        **아무것도 없는 72px** 이 생겼습니다
    //   §13  `.chan` 이 빈 채로 `border-top` 을 그려서 **아무것도 없는
    //        아래에 가로줄 하나**가 남았습니다
    //
    // 레일이 실제로 생기면서 그 자리를 다시 잡게 됐는데, 이번에는
    // **프로젝트가 하나뿐이면 레일이 없습니다.** 그때도 자리를 잡으면
    // 처음 그 결함으로 되돌아갑니다.
    //
    // 그래서 `--shell-rail` 을 쓰는 `body` 규칙은 **`.has-rail` 이
    // 붙은 것뿐**이어야 합니다. 그 클래스는 `nav.ts` 가 프로젝트 수를
    // 보고 붙입니다 — CSS 는 그걸 모릅니다.
    const css = readFileSync(join(PUBLIC, 'app.css'), 'utf8');

    // ⚠️ **이 검사는 한 번 눈을 감을 뻔했습니다.** 처음에는 선택자가
    // `body` 로 **시작**하는 규칙만 봤습니다. 그런데 §21 에서 자리를
    // 비우는 일이 `html:has(body.has-rail)` 로 옮겨 갔습니다 — 선택자가
    // `html` 로 시작하므로 검사는 아무 말 없이 0건을 냅니다.
    //
    // "0건" 은 규칙이 지켜져서 나오기도 하고 **찾는 방법이 틀려서**
    // 나오기도 합니다. 그래서 선택자가 `body` 를 **어디에든** 품으면
    // 봅니다. 아래 `plantedTest` 가 이 검사가 실제로 눈을 뜨고 있는지
    // 확인합니다.
    const scan = (sheet: string): string[] => {
      const found: string[] = [];
      for (const rule of sheet.matchAll(/(^|\n)\s*([^{}@\n][^{}]*)\{([^}]*)\}/g)) {
        const selector = (rule[2] as string).trim();
        if (!/\bbody\b/.test(selector)) continue;
        if (!/var\(--shell-rail\)/.test(rule[3] as string)) continue;
        if (!/\.has-rail\b/.test(selector)) found.push(selector);
      }
      return found;
    };

    // ⚠️ **없다고 적기 전에 있는 것을 하나 심어 봅니다.** 이 저장소는
    // 눈감은 검사에 두 번 속았습니다 (그림자 검사는 심는 방법조차
    // 틀렸습니다). 심은 것을 못 잡으면 아래 "0건" 은 아무 뜻이 없습니다.
    deepStrictEqual(
      scan('html:has(body.foo) {\n  padding-left: var(--shell-rail);\n}'),
      ['html:has(body.foo)'],
      '이 검사가 눈을 감고 있습니다 — 심어 둔 위반을 못 잡았습니다',
    );

    const bare = scan(css);
    strictEqual(
      bare.join(', '),
      '',
      '`.has-rail` 없이 레일 자리를 잡습니다 — 프로젝트가 하나인 사람에게 ' +
        '아무것도 없는 72px 이 생깁니다 (docs/19 §11 에서 한 번 당했습니다)',
    );

    // 그리고 그 클래스를 **실제로 붙이는 코드**가 있어야 합니다.
    // 규칙만 있고 붙이는 곳이 없으면 레일은 영영 안 섭니다 — 이 저장소의
    // 대표 결함인 "만들어 놓고 아무도 안 부름" 이 그 모양입니다.
    const nav = codeOf(readFileSync(join(DEMO, 'nav.ts'), 'utf8'));
    strictEqual(
      /classList\.add\('has-rail'\)/.test(nav) && /classList\.remove\('has-rail'\)/.test(nav),
      true,
      '`has-rail` 을 붙이거나 떼는 코드가 없습니다 — 붙이기만 하면 ' +
        '프로젝트를 나간 뒤에도 72px 이 남습니다',
    );
  });

  it('⭐ 껍데기 색을 본문 색과 섞어 쓰지 않는다', () => {
    // 껍데기(`--chrome-*`)는 밝은 모드에서도 짙습니다. 본문 토큰
    // (`--text`·`--surface`·`--line`)은 모드에 따라 뒤집힙니다. 셸 안에서
    // 본문 토큰을 쓰면 **밝은 모드에서만** 글자가 사라집니다.
    //
    // 실험판 v4 에서 실제로 그랬습니다 — 실측 배경 rgb(18,33,31) 에
    // 글자 rgb(22,33,31) 이었습니다. 화면에서는 그냥 빈 줄로 보입니다.
    const css = readFileSync(join(PUBLIC, 'app.css'), 'utf8');
    const blockAt = (marker: string): string => {
      const at = css.indexOf(marker);
      strictEqual(at > -1, true, `셸 블록을 못 찾았습니다: ${marker}`);
      return css.slice(at, css.indexOf('\n}\n', at));
    };
    const paints = (block: string): string[] =>
      [...block.matchAll(/(?:color|background)\s*:\s*var\((--[a-z0-9-]+)\)/g)].map(
        (m) => m[1] as string,
      );

    // ── 왼쪽 열들은 **껍데기**입니다 ─────────────────────────
    // 이동하는 자리라 본문이 밝든 어둡든 늘 같은 짙은 면입니다.
    const chan = paints(blockAt('/* ── 회의 채널 ─')).filter((n) => !n.startsWith('--chrome-'));
    strictEqual(
      [...new Set(chan)].join(', '),
      '',
      '셸 안에서 뒤집히는 본문 토큰을 씁니다 — `--chrome-*` 를 쓰세요',
    );

    // ── 오른쪽 열은 **본문**입니다 (§21) ─────────────────────
    //
    // ⚠️ 이 검사는 위와 **반대 방향**입니다. 맥락 패널은 좌우가 다
    // 어두워 가운데가 종이 한 장으로 보이던 것을 고치며 본문 쪽으로
    // 옮겼습니다. 본문은 모드에 따라 뒤집히는데 껍데기는 안 뒤집히므로,
    // 여기에 `--chrome-*` 를 쓰면 **어두운 모드에서만** 짙은 글자가
    // 짙은 면에 얹혀 사라집니다 — 실험판 v4 에서 당한 그 모양의 거울상.
    const ctx = paints(blockAt('   맥락 패널 — 셋째 열')).filter((n) => n.startsWith('--chrome-'));
    strictEqual(
      [...new Set(ctx)].join(', '),
      '',
      '맥락 패널에 껍데기 색을 씁니다 — 이 열은 본문입니다, 뒤집히는 토큰을 쓰세요',
    );

    // ⚠️ **둘 다 "0건" 이라 방향이 바뀐 것을 못 볼 뻔했습니다.** 방향만
    // 뒤집고 대상 블록을 그대로 두면 두 검사가 같은 말을 하게 되는데,
    // 그래도 전부 통과합니다. 그래서 각 열이 **실제로 무엇으로 칠해져
    // 있는지**를 하나씩 확인합니다 — 비어 있으면 블록을 잘못 잡은 것입니다.
    strictEqual(
      paints(blockAt('/* ── 회의 채널 ─')).some((n) => n.startsWith('--chrome-')),
      true,
      '회의 채널이 껍데기 색을 하나도 안 씁니다 — 블록을 잘못 잡았습니다',
    );
    strictEqual(
      paints(blockAt('   맥락 패널 — 셋째 열')).some((n) => !n.startsWith('--chrome-')),
      true,
      '맥락 패널이 본문 색을 하나도 안 씁니다 — 블록을 잘못 잡았습니다',
    );
  });
});

describe('서비스 워커 캐시 목록 (docs/19 §24)', () => {
  /**
   * `sw.js` 의 **자동 생성 구간**에 적힌 것만.
   *
   * ⚠️ 파일 전체에서 `'/…'` 를 긁으면 `fetch` 처리기의 `'/api/'`·
   * `'/tracks/'`·`'/offline.html'` 까지 딸려 옵니다. 실제로 딸려 왔고,
   * 목록이 맞는데도 검사가 터졌습니다 — 규칙이 아니라 **읽는 범위**가
   * 틀린 것이었습니다.
   */
  function generatedShell(): string[] {
    const sw = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');
    const block = /\/\* <<< 자동 생성[^*]*\*\/\n([\s\S]*?)\n\s*\/\* >>> \*\//.exec(sw);
    strictEqual(block !== null, true, 'sw.js 에서 자동 생성 구간을 못 찾았습니다');
    return [...(block?.[1] ?? '').matchAll(/'(\/[^']+)'/g)].map((m) => m[1] as string);
  }

  it('⭐ 오프라인 목록이 `public/` 의 **실제 파일**과 어긋나지 않는다', () => {
    // ⚠️ 이 목록은 손으로 적던 것이었고 **두 번 어긋났습니다.** 빠뜨려도
    // 아무 데서도 티가 안 납니다 — 온라인에서는 서버가 주니까 멀쩡하고,
    // 오프라인에서만 안 뜹니다. 그런데 오프라인은 개발 중에 거의 안 겪습니다.
    //
    // 이제 `npm run build` 가 씁니다. 그래서 이 검사도 "빠진 것/유령"
    // 두 방향을 따로 세는 대신, **빌드가 쓸 것과 지금 적힌 것이 같은가**
    // 하나만 봅니다. 어긋나는 유일한 경우는 빌드를 안 돌린 것입니다.
    deepStrictEqual(
      generatedShell(),
      shellFiles(),
      '오프라인 캐시 목록이 지금 `public/` 과 다릅니다 — `npm run build` 를 돌리세요',
    );
  });

  it('⭐ 이 검사가 **눈을 뜨고 있는지** 확인한다', () => {
    // "0건" 은 규칙이 지켜져서 나오기도 하고 찾는 방법이 틀려서 나오기도
    // 합니다. 목록을 실제로 읽고 있는지, 화면 파일을 실제로 세고 있는지를
    // 봅니다 — 정규식이 하나만 어긋나도 위 검사는 조용히 통과합니다.
    const listed = generatedShell();
    strictEqual(listed.length > 10, true, `캐시 목록을 ${listed.length}개로 읽었습니다`);
    strictEqual(listed.includes('/tokens.css'), true, '`tokens.css` 를 못 읽었습니다');
    // 세는 쪽도 헛돌면 안 됩니다 — 빌드가 파일을 실제로 세고 있는가.
    strictEqual(shellFiles().includes('/tokens.css'), true, '`shellFiles()` 가 헛돕니다');

    const screens = readdirSync(PUBLIC).filter((n) => n.endsWith('.html'));
    strictEqual(screens.length >= 9, true, `화면을 ${screens.length}개로 셌습니다`);
  });
});

describe('React 번들 (docs/19 §24)', () => {
  it('⭐ **개발 빌드가 배포로 새어 나가지 않는다**', async () => {
    // ⚠️ React 를 넣자마자 `review.js` 가 **1206KB** 가 됐습니다
    // (다른 화면은 37~69KB). `process.env.NODE_ENV` 를 안 정해 주면
    // React 가 개발 빌드로 들어가기 때문입니다.
    //
    // **화면은 멀쩡히 돕니다.** 경고 문구·이름 추적·개발자도구 연동이
    // 통째로 실려서 크기와 런타임이 모두 나빠지는데, 눈으로는 티가 안
    // 납니다 — 폰에서 1.2MB 를 받는 것이 어떤 일인지도요.
    //
    // ⚠️ **설정을 보지 않고 결과를 봅니다.** `define` 이 있는지만 세면,
    // 나중에 누가 빌드 경로를 하나 더 만들어 그쪽에 안 넣어도 통과합니다.
    // 실제로 빌드해서 **개발 빌드에만 있는 문구**를 찾습니다.
    //
    // 이 문구가 정말 갈리는지는 재서 확인했습니다 —
    // 개발 빌드 1202KB 에 1회, 프로덕션 빌드 260KB 에 0회.
    const DEV_ONLY = 'unique \"key\" prop';

    const built = await bundle();
    const offenders = [...built.entries()]
      .filter(([, text]) => text.includes(DEV_ONLY))
      .map(([name]) => name);

    deepStrictEqual(
      offenders,
      [],
      'React 개발 빌드가 들어갔습니다 — `build.mts` 의 ' +
        "`define: { 'process.env.NODE_ENV': '\"production\"' }` 를 확인하세요",
    );

    // ⚠️ **이 검사가 눈을 뜨고 있는지** 확인합니다. React 를 쓰는 번들이
    // 하나도 없으면 위 0건은 아무 뜻이 없습니다.
    const usesReact = [...built.values()].some((text) => text.includes('react'));
    strictEqual(usesReact, true, 'React 가 들어간 번들이 없습니다 — 검사가 헛돕니다');
  });

  it('⭐ 커밋된 번들이 **압축된** 것이다', async () => {
    // ⚠️ 위 검사가 막는 것은 "개발 빌드" 뿐이고, **크기는 안 봅니다.**
    // 네 가지로 빌드해서 재 보고 알았습니다:
    //
    //     지금 그대로      review 258KB   개발빌드 문구 없음 → 통과
    //     define 만 뺌     review 258KB   없음 → 통과   ← 차이가 없다
    //     minify 만 뺌     review 719KB   없음 → 통과   ← 2.8배인데 안 잡힌다
    //     둘 다 뺌         review 1206KB  있음 → 터짐
    //
    // `minify` 를 끄고 **다시 빌드해 커밋하면** 낡은 번들 검사도
    // 통과합니다. 그래서 폰에서 719KB 를 받게 되는 변경이 아무 데서도
    // 안 걸렸습니다.
    //
    // ⚠️ **크기 상한을 숫자로 적지 않습니다.** 근거 없는 상수는 이
    // 저장소가 만들지 않기로 한 것이고, 상한은 곧 낡습니다. 대신
    // **압축을 강제해서 다시 빌드한 것**과 커밋된 것을 견줍니다. 설정을
    // 세는 게 아니라 결과를 보는 것이라, 빌드 경로를 새로 만들어도
    // 빠져나갈 수 없습니다.
    const pressed = await bundle({ minify: true });
    const offenders: string[] = [];
    for (const [name, text] of pressed) {
      const onDisk = readFileSync(join(PUBLIC, name), 'utf8');
      if (onDisk !== text) {
        offenders.push(`${name} (커밋 ${onDisk.length}B · 압축 ${text.length}B)`);
      }
    }
    strictEqual(
      offenders.join(', '),
      '',
      'public 의 번들이 압축본이 아닙니다 — `build.mts` 의 `minify` 를 확인하세요',
    );
  });
});

describe('`:empty` 로 감추기 (docs/19 §21)', () => {
  it('⭐ **빌 수 없는 것**을 `:empty` 로 감추지 않는다', () => {
    // ⚠️ 이 저장소가 실제로 당한 것입니다.
    //
    // 결함 58 을 고치며 `.note:empty { display: none }` 을 넣었습니다.
    // `<p class="note">` 가 비면 아무것도 없는 가로줄만 남기 때문입니다.
    // 옳은 규칙이었습니다.
    //
    // 그런데 검토 화면의 메모 칸이 `<input class="note">` 였습니다.
    // **`<input>` 은 자식을 가질 수 없는 태그라 언제나 `:empty` 입니다** —
    // 값이 무엇이든, 사람이 무엇을 치든. 그래서 그 입력창은 Stage F
    // 이후로 **한 번도 화면에 나온 적이 없었습니다.**
    //
    // 하필 그 칸이 "왜 이렇게 결정했는지" 를 적는 자리였습니다. 이
    // 저장소는 기여도에서 "이유 없는 조정은 근거 없는 점수와 같다" 고
    // 적어 뒀는데, 그 약속을 지킬 입력창이 조용히 사라져 있었습니다.
    //
    // CSS 는 오류를 안 냅니다. 브라우저로 띄워 보고 "저기 있어야 할
    // 상자가 없네" 를 눈으로 알아챌 때까지 아무도 모릅니다.
    const VOID = ['input', 'img', 'br', 'hr', 'source', 'track', 'embed', 'area', 'col'];

    const css = readFileSync(join(PUBLIC, 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

    // `:empty` 로 감추는 **클래스**들. 태그를 앞에 붙여 좁힌 것
    // (`p.note:empty`)은 이미 안전하므로 세지 않습니다.
    const bare = new Set<string>();
    for (const m of css.matchAll(/([a-z]*)\.([a-z][a-z0-9-]*):empty/g)) {
      if ((m[1] as string) === '') bare.add(m[2] as string);
    }

    const sources: [string, string][] = [];
    for (const name of readdirSync(PUBLIC).filter((n) => n.endsWith('.html'))) {
      sources.push([name, readFileSync(join(PUBLIC, name), 'utf8')]);
    }
    for (const { name, source } of demoFiles()) sources.push([name, source]);

    const scan = (): string[] => {
      const found: string[] = [];
      for (const [name, source] of sources) {
        for (const tag of VOID) {
          for (const m of source.matchAll(new RegExp(`<${tag}\\b[^>]*`, 'g'))) {
            const cls = /class="([^"]*)"/.exec(m[0]);
            if (cls === null) continue;
            for (const one of (cls[1] as string).split(/\s+/)) {
              if (bare.has(one)) found.push(`${name} → <${tag} class="${one}">`);
            }
          }
        }
      }
      return found;
    };

    // ⚠️ **없다고 적기 전에 있는 것을 하나 심어 봅니다.** 이 저장소는
    // 눈감은 검사에 이미 두 번 속았습니다.
    const planted = [...bare][0];
    strictEqual(
      typeof planted === 'string',
      true,
      '`:empty` 로 감추는 클래스가 하나도 없습니다 — 찾는 방법이 틀렸습니다',
    );
    sources.push(['(심은 것)', `<input class="${planted as string}" />`]);
    strictEqual(
      scan().length > 0,
      true,
      '이 검사가 눈을 감고 있습니다 — 심어 둔 위반을 못 잡았습니다',
    );
    sources.pop();

    strictEqual(
      scan().join(', '),
      '',
      '`<input>` 같은 void 태그는 **언제나** `:empty` 입니다 — ' +
        '값이 있어도 통째로 감춰집니다. 선택자에 태그를 붙여 좁히세요',
    );
  });
});

describe('그림자 (docs/19 §19)', () => {
  it('⭐ **컨트롤 경계**를 그림자로 그리지 않는다', () => {
    // `tokens.css` 가 `--line-strong` 을 만든 이유가 이것입니다 —
    // 입력창이 어디서 시작하는지를 **선 하나**가 말합니다. 거기에
    // 그림자를 얹으면 두 벌이 되고, 그림자가 안 보이는 환경(고대비
    // 모드·인쇄)에서 한쪽만 남습니다.
    //
    // ⚠️ 예전에 두 파일이 "이 저장소는 box-shadow 가 0건" 이라고 적어
    // 뒀는데, 셸을 만들며 장식용 그림자가 생겨 **그 문장이 거짓이
    // 됐습니다.** 개수를 세는 규칙은 이렇게 낡습니다. 지켜야 하는 것은
    // 개수가 아니라 **쓰임**이라, 그것을 봅니다.
    const css = readFileSync(join(PUBLIC, 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const offenders: string[] = [];
    for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const selector = (rule[1] as string).trim();
      if (!/\b(input|textarea|select|button)\b/.test(selector)) continue;
      if (/box-shadow\s*:/.test(rule[2] as string)) offenders.push(selector);
    }
    strictEqual(
      offenders.join(', '),
      '',
      '컨트롤에 그림자를 걸었습니다 — 경계는 `--line-strong` 선 하나가 말합니다',
    );
  });
});

describe('칸반 끌어 옮기기 (TASK-005)', () => {
  /**
   * ⭐ 끌기가 있으면 **버튼 경로와 공용 판단도 같이** 있다 — 짝 가드.
   *
   * HTML5 DnD 는 터치에서 아예 안 돌고, 키보드·낭독기 사용자에게는
   * 처음부터 없는 기능입니다. 끌기를 달면서 `.move` 버튼을 걷으면 그
   * 사람들은 카드를 옮길 방법 자체를 잃습니다 — 요구는 「경로를 더하라」
   * 이지 「바꿔치우라」 가 아닙니다.
   *
   * 반대 방향도 봅니다 — drop 이 lib 의 판단(`canDropOn`·`draggedTaskId`)
   * 을 안 거치고 화면에서 제 규칙을 만들면, 「끌기로는 되는데 버튼으로는
   * 안 되는 이동」 이 생기고 두 벌은 반드시 갈라집니다.
   *
   * ⚠️ 끌기를 통째로 걷어낸 미래는 통과합니다 — 그때는 지킬 짝이 없습니다.
   */
  it('⭐ 끌기가 있으면 버튼 경로와 lib 판단이 같이 있다', () => {
    const code = demoSource('kanban');
    if (code === null) throw new Error('kanban 화면이 없습니다');
    if (!/\bdraggable=/.test(code)) return;
    for (const needed of [
      'nextStatuses(', // 버튼이 그리는 허용 집합
      'className="move"', // 버튼 자체
      'canDropOn(', // 놓을 수 있는가 — lib 의 판단
      'draggedTaskId(', // 건너온 값 검증 — drop 은 아무나 일으킨다
      'onDrop', // 실제로 놓는 자리
    ]) {
      ok(
        code.includes(needed),
        `끌기(draggable)는 있는데 ${needed} 가 없습니다 — 버튼 경로나 공용 판단이 빠졌습니다`,
      );
    }
  });
});

describe('상태 화면 (지시서 §7)', () => {
  /** 목록을 **비동기로 채우는** 그릇. 화면과 그 그릇의 id. */
  const ASYNC_CONTAINERS: [string, string][] = [
    ['home.tsx', 'projects'],
    ['contributions.tsx', 'members'],
    ['kanban.tsx', 'board'],
    ['review.tsx', 'list'],
    ['lobby.tsx', 'roster'],
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

  /**
   * ⚠️ **요구는 하나인데 모양이 둘이었습니다.**
   *
   * 요구: 늦게 켜고(200ms) · 켜는 것은 뼈대이고 · 반드시 끈다.
   *
   * 명령형 화면은 그릇을 직접 붙잡았습니다 — `showSkeleton(el, …)` /
   * `clearSkeleton(el)`. React 화면은 그릇을 못 만집니다(다음 렌더에
   * 지워집니다). 그래서 같은 일을 깃발과 JSX 로 합니다.
   *
   * 검사를 헬퍼 **이름**으로 하고 있었더니, 화면 하나를 React 로 옮기는
   * 순간 규칙이 그 화면에서 통째로 눈을 감았습니다 — `.tsx` 를 못 보던
   * 것과 똑같은 부류입니다. 그래서 **요구**를 모양별로 쟀습니다.
   *
   * ⚠️ 그리고 이제 **명령형 갈래를 지웠습니다.** 목록을 비동기로 채우는
   * 화면 다섯이 전부 React 로 옮겨 가면서 `showSkeleton`·`clearSkeleton`
   * 을 부르는 곳이 0곳이 됐고, 그 둘을 지웠습니다. 갈래를 남겨 두면
   * **없는 함수를 요구하는 규칙**이 됩니다 — 다음 사람이 그걸 살아 있는
   * 길로 읽습니다.
   */

  it('⭐ 목록을 비동기로 채우는 화면은 로딩 표시를 **켠다**', () => {
    // 이 저장소의 대표 실패 방식: 맞는 모듈을 만들어 놓고 아무도
    // 부르지 않는 것 (결함 47). 그러니 모듈이 있는지가 아니라
    // **호출**을 셉니다.
    const offenders: string[] = [];
    for (const [name] of ASYNC_CONTAINERS) {
      const code = codeOf(readFileSync(join(DEMO, name), 'utf8'));
      // 늦게 켠다.
      if (!/whileLoading\(/.test(code)) offenders.push(`${name} → whileLoading 을 안 부름`);
      // 켜는 것이 **뼈대**인가. 직접 그리는 대신 같은 모듈을 씁니다 —
      // 두 벌이 되면 한쪽만 고쳐집니다.
      if (!/from '\.\.\/lib\/ui\/skeleton\.ts'/.test(code)) {
        offenders.push(`${name} → 스켈레톤 모듈을 안 씀`);
      }
      // 낭독기 쪽 짝. `showSkeleton` 이 대신 달아 주던 것입니다.
      if (!/aria-busy/.test(code)) offenders.push(`${name} → aria-busy 를 안 담`);
    }
    strictEqual(offenders.join(', '), '');
  });

  it('⭐ 켠 스켈레톤을 **끄는 짝**이 있다', () => {
    // 안 끄면 화면이 영원히 로딩 중으로 남습니다. 오류는 안 납니다.
    const offenders: string[] = [];
    for (const [name] of ASYNC_CONTAINERS) {
      const code = codeOf(readFileSync(join(DEMO, name), 'utf8'));
      {
        // `whileLoading(work, show, hide)` 의 **인자 안에서** 짝을 봅니다.
        // 파일 전체를 훑으면 아무 데나 있는 `setX(false)` 가 짝인 척합니다.
        for (const args of callArgs(code, 'whileLoading')) {
          const on = [...args.matchAll(/\bset([A-Z]\w*)\(true\)/g)].map((m) => m[1] as string);
          const off = new Set(
            [...args.matchAll(/\bset([A-Z]\w*)\(false\)/g)].map((m) => m[1] as string),
          );
          if (on.length === 0) offenders.push(`${name} → whileLoading 이 아무것도 안 켬`);
          for (const flag of on) {
            if (!off.has(flag)) offenders.push(`${name} → set${flag}(true) 의 끄는 짝이 없다`);
          }
        }
      }
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
    //
    // ⚠️ React 화면은 **직접 안 잇습니다.** 공용 `RawHtml` 에 `onRetry` 를
    // 넘기고, 그 조각이 버튼을 찾아 붙입니다. 화면마다 다시 이으면 두
    // 벌이 되고, 두 벌이면 한쪽만 고쳐집니다.
    //
    // 그래서 넘기는 것도 이었다고 봅니다 — 대신 **넘겨받는 쪽이 정말
    // 잇는지**를 아래에서 따로 못 박습니다. 안 그러면 `onRetry` 라고
    // 쓰기만 해도 통과하는 빈 규칙이 됩니다.
    const offenders: string[] = [];
    for (const { name, source } of demoFiles()) {
      const code = codeOf(source);
      if (!/retry:\s*true/.test(code)) continue;
      if (!/\.retry'\)/.test(code) && !/onRetry=/.test(code)) offenders.push(name);
    }
    strictEqual(offenders.join(', '), '');

    // ⚠️ 처음에는 `.retry')` 와 `onRetry()` 둘만 봤습니다. 그랬더니
    // **`addEventListener` 줄을 통째로 지워도 통과했습니다** — 재료는
    // 그대로 있고 잇는 동작만 사라진 것을 못 봤습니다. 심어서 알았습니다.
    const parts = codeOf(readFileSync(join(DEMO, 'parts.tsx'), 'utf8'));
    const wires =
      /\.retry'\)/.test(parts) &&
      /onRetry\(\)/.test(parts) &&
      /addEventListener\('click'/.test(parts);
    strictEqual(
      wires,
      true,
      '`parts.tsx` 의 `RawHtml` 이 [다시 불러오기] 를 안 잇습니다 — ' +
        '넘긴 화면들이 전부 헛돕니다',
    );
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
    const src = codeOf(demoSource('project') ?? '');
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
      /disabled\s*=\s*\{?\s*inviteCode === null/.test(src),
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
    const card = codeOf(demoSource('contributions') ?? '');
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
    // ⚠️ HTML 에서만 찾으면 React 로 옮긴 화면에서 헛돕니다 — 요구는
    // "정할 자리가 있는가" 이지 "어느 파일에 적혀 있는가" 가 아닙니다.
    strictEqual(screenHas('project', 'id="roles"'), true, '역할 칸이 없습니다');
    strictEqual(screenHas('project', 'id="save-roles"'), true, '저장 버튼이 없습니다');

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
    //
    // ⚠️ **HTML 에서만 찾으면 안 됩니다.** 화면을 React 로 옮기면 그
    // 버튼은 `.tsx` 안으로 들어가고, 요구는 하나도 안 바뀌었는데 이
    // 검사만 터집니다 — 이번 이전에서 실제로 그랬습니다. 요구는 "누를
    // 버튼이 있는가" 이지 "어느 파일에 적혀 있는가" 가 아닙니다.
    strictEqual(screenHas('contributions', 'id="confirm"'), true, '확정 버튼이 없습니다');
  });

  it('⭐ 3단계 동의 ②③ 을 **묻고 보낸다** (docs/07 §2.3)', () => {
    // ②③ 은 스키마에도 있고 서버도 받는데, **화면이 묻지를 않았습니다.**
    // 그래서 "3단계 분리 동의" 는 문서와 DB 에만 존재했고, 거부할
    // 방법 자체가 없었습니다. 저장만 되고 아무 효과가 없던 것도
    // 결국 아무도 거부할 수 없었기 때문입니다.
    //
    // 존재가 아니라 **호출**을 셉니다 (결함 47·63·감사 #8 교훈).
    //
    // ⚠️ **이 자는 두 번 낡았습니다** (결함 335).
    //
    //   ① 체크박스를 `id="keep-audio"` 라는 **글자**로 찾았습니다. 두
    //      로비가 글을 `@lib` 의 `EXTRA_CONSENTS` 에서 읽게 되자 그
    //      글자가 화면에서 사라졌고, 요구는 하나도 안 바뀌었는데 자만
    //      터졌습니다 — "화면을 옮기면 가드가 눈을 감는다" 의 사촌입니다.
    //   ② 걷는 자리가 **레거시뿐**이었습니다. `/app` 의 로비는 이 자가
    //      한 번도 안 보고 있었고, 그래서 SPA 가 ②③ 을 「동의하면 얻는
    //      것」으로만 설명하는 동안 이 검사는 초록이었습니다 (결함 321 과
    //      같은 모양 — **뿌리마다 따로 세십시오**).
    for (const id of ['keep-audio', 'keep-voiceprint']) {
      ok(
        EXTRA_CONSENTS.some((c) => c.id === id),
        `@lib 의 EXTRA_CONSENTS 에 ${id} 가 없습니다 — 물어보지 않으면 거부할 수 없습니다`,
      );
    }

    // 두 로비가 **그 한 벌을 실제로 그리는가**. 부르는 곳을 뿌리마다 셉니다.
    const lobbies: { root: string; code: string }[] = [
      { root: 'frontend/src/demo', code: demoSource('lobby') ?? '' },
      {
        root: 'webapp/src',
        code: readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Lobby.tsx'), 'utf8'),
      },
    ];
    for (const { root, code } of lobbies) {
      ok(code.length > 0, `${root} 의 로비를 못 읽었습니다`);
      ok(
        /EXTRA_CONSENTS\.map\(/.test(codeOf(code)),
        `${root} 의 로비가 EXTRA_CONSENTS 를 안 그립니다 — 화면이 글을 따로 적으면 두 로비가 갈라집니다`,
      );
      for (const type of ['raw_audio_retention', 'voiceprint_storage']) {
        strictEqual(
          codeOf(code).includes(type),
          true,
          `${root} 의 로비가 ${type} 을 서버로 보내지 않습니다`,
        );
      }
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

describe('문서 참조', () => {
  const DOCS = join(ROOT, '..', 'docs');

  /** `docs/19` → 그 번호로 시작하는 실제 파일. */
  const docFile = (n: string): string | null =>
    readdirSync(DOCS).find((name) => name.startsWith(`${n}-`)) ?? null;

  /**
   * 그 문서가 실제로 가진 절 번호. `## 24. 제목` · `### 24.1 제목` 둘 다.
   *
   * ⚠️ **표제 앞의 기호를 넘겨야 합니다.** 처음에는 `^#+ (\d+)` 로 봤다가
   * `docs/11` 의 `### ⚠️ 2. MinIO는…` 을 통째로 놓쳤고, **멀쩡한 참조
   * 둘을 끊어졌다고 보고할 뻔했습니다.** 이 저장소에서 네 번째입니다 —
   * 새 검사 도구는 자기가 먼저 틀립니다.
   *
   * 기호만 넘깁니다. `## 함정 4개` 처럼 **글자로 시작하는** 표제는 절
   * 번호가 없는 것으로 봅니다 — 그 `4` 는 절 번호가 아니라 개수입니다.
   */
  function sections(file: string): Set<string> {
    const text = readFileSync(join(DOCS, file), 'utf8');
    const found = new Set<string>();
    for (const [, heading] of text.matchAll(/^#{2,4}\s+(.*)$/gm)) {
      const n = /^(?:[^\p{L}\p{N}]+\s*)*(\d+(?:\.\d+)*)(?![\p{L}\p{N}])/u.exec(heading as string);
      if (n !== null) found.add(n[1] as string);
    }
    return found;
  }

  /**
   * 참조를 적을 수 있는 곳 — **소스와 문서 전부.**
   *
   * ⚠️ 오랫동안 `frontend/` 만 봤습니다. 백엔드 파이썬과 문서끼리의 참조는
   * 아무도 안 봤다는 뜻입니다. 재 보니 끊어진 것은 0건이었지만, **0건인
   * 것과 안 보는 것은 다릅니다** — 안 보는 동안 끊어져도 티가 안 납니다.
   */
  function referencingFiles(): { rel: string; text: string }[] {
    const out: { rel: string; text: string }[] = [];
    const walk = (dir: string, prefix: string, keep: RegExp): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '__pycache__') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`, keep);
        else if (keep.test(entry.name)) {
          out.push({ rel: `${prefix}${entry.name}`, text: readFileSync(full, 'utf8') });
        }
      }
    };
    const web = /\.(tsx?|css|html|mts)$/;
    walk(join(ROOT, 'src'), 'src/', web);
    walk(PUBLIC, 'public/', web);
    walk(join(ROOT, '..', 'backend'), 'backend/', /\.py$/);
    walk(DOCS, 'docs/', /\.md$/);
    return out;
  }

  it('⭐ 소스가 가리키는 `docs/NN §M` 이 실제로 있다', () => {
    // ⚠️ **적어 놓고 안 만든 절**이 실제로 있었습니다 — 셸 전환 문서의
    // 26·27 번 절을 코드 여섯 곳에서 가리키는데 그 문서는 23 에서
    // 끝났습니다. 옮기면서 "여기 쓸 것" 이라고 미리 번호를 적어 두고,
    // 정작 문서에는 다른 번호로 쓴 것입니다.
    //
    // (여기에 그 참조를 **예시로 적지 않습니다.** 적으면 이 규칙이
    //  자기 설명에 걸립니다 — 이 파일이 `codeOf` 를 만든 이유입니다.)
    //
    // 이 저장소가 반복해 당한 방식 그대로입니다 — **가리키는 곳이 없는
    // 안내.** 오류는 안 나고, 읽는 사람만 문서를 뒤지다 포기합니다.
    const cache = new Map<string, Set<string>>();
    const dangling: string[] = [];
    for (const { rel, text } of referencingFiles()) {
      // ⚠️ 세는 말이 뒤에 붙은 숫자는 **절 번호가 아닙니다.**
      //    `docs/08 §9주차` 는 "그 문서의 9주차" 라는 뜻인데, 이걸 §9 로 읽어
      //    "없는 절" 로 잡을 뻔했습니다 — 없는 결함을 만드는 쪽입니다.
      const REF = /docs\/(\d{2}) §(\d+(?:\.\d+)*)(?!주차|개|건|명|번째|장)/g;
      for (const [, doc, section] of text.matchAll(REF)) {
        const file = docFile(doc as string);
        if (file === null) {
          dangling.push(`${rel} → docs/${doc as string} 이라는 문서가 없다`);
          continue;
        }
        if (!cache.has(file)) cache.set(file, sections(file));
        if (!cache.get(file)?.has(section as string)) {
          dangling.push(`${rel} → docs/${doc as string} §${section as string}`);
        }
      }
    }
    strictEqual([...new Set(dangling)].join(', '), '');
  });

  it('⭐ IA 문서가 화면을 하나도 빠뜨리지 않는다', () => {
    // ⚠️ `docs/13` 이 **일곱 개** 기준에서 멈춰 있었습니다. 그 뒤에 만든
    // `project.html`(왼쪽 열 `설정` 탭이 가리키는 상시 노출 화면)과
    // `call.html`(로비에서 여는 통화)이 그림에도 표에도 없었습니다.
    //
    // IA 문서가 실제 IA 를 안 담으면 다음 사람은 화면을 또 하나 늘립니다 —
    // 그 문서가 경고하는 바로 그 일("만들 때마다 하나씩 늘어 막다른 길이
    // 됨")이 문서 자신 때문에 반복되는 것입니다.
    //
    // 화면을 **세는 쪽이 문서가 아니라 디렉터리**여야 합니다.
    const doc = readFileSync(join(DOCS, '13-화면-구조.md'), 'utf8');
    const missing = readdirSync(PUBLIC)
      .filter((name) => name.endsWith('.html'))
      .map((name) => name.replace(/\.html$/, ''))
      .filter((stem) => !doc.includes(`\`${stem}\``) && !doc.includes(`${stem}.html`));
    strictEqual(missing.join(', '), '', 'docs/13 에 없는 화면입니다 — 그림과 §2 표에 넣으세요');
  });
});

describe('신뢰도 한 줄은 **누구를 잰 값인지** 말한다 (결함 384)', () => {
  /*
   * ## 왜 이 검사가 있나
   *
   * `confidence` 는 **팀당 한 번** 계산됩니다 — 시연 데이터에서 세 사람의
   * 값이 소수점까지 같습니다(0.446). 그것을 **사람 이름 밑에** 그리면서
   * 범위를 안 적으면, 커버리지 100% 인 사람이 「신뢰도 낮음」을 자기 것으로
   * 읽습니다. 끊긴 트랙의 주인은 다른 사람입니다.
   *
   * 결함 344 는 이것을 **보고서**에서 고쳤고, 그 가드는 `reports/view.ts`
   * 한 파일만 봅니다. 그래서 SPA 기여도가 화면 파일 안에서 손으로 만드는
   * `신뢰도 ${label}` 은 **아무도 안 보고 있었습니다** — 세 자리 중 하나만
   * 범위를 안 적고 있었습니다(결함 384).
   *
   * ⚠️ **낱말이 아니라 자리를 셉니다.** `confidence_label` 을 **읽는** 곳을
   * 뿌리마다 따로 census 하고, 그 자리마다 범위가 붙었는지 봅니다. 새 화면이
   * 그 값을 읽기 시작하면 이 검사가 그 자리도 같이 셉니다.
   */
  const roots: { name: string; base: string }[] = [
    { name: '레거시 frontend/src', base: join(ROOT, 'src') },
    { name: 'SPA webapp/src', base: join(ROOT, '..', 'webapp', 'src') },
  ];

  /** `confidence_label` 을 읽는 소스 전부 — 검사 파일과 타입 선언은 뺍니다. */
  const readers = (base: string): { rel: string; code: string }[] => {
    const out: { rel: string; code: string }[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const code = codeOf(readFileSync(full, 'utf8'));
          // 타입 선언(`confidence_label: string;`)은 「그리는 것」이 아닙니다.
          if (/confidence_label(?!\s*:)/.test(code))
            out.push({ rel: full.slice(base.length + 1), code });
        }
      }
    };
    if (existsSync(base)) walk(base);
    return out;
  };

  it('⭐ 그 값을 그리는 **모든** 자리가 「팀」이라고 적는다 — 뿌리마다', () => {
    let total = 0;
    const bare: string[] = [];
    for (const root of roots) {
      const found = readers(root.base);
      // 한쪽 뿌리가 통째로 0곳이면 그건 자가 눈을 감은 것입니다 (결함 286).
      ok(found.length > 0, `${root.name} 에서 confidence_label 을 읽는 자리를 하나도 못 찾았습니다 — 자가 낡았습니다`);
      total += found.length;
      for (const f of found) {
        // 범위를 다는 길은 둘: `@lib` 의 한 벌을 부르거나, 보고서처럼
        // 자기 형식이 필요하면 문장에 「팀」을 직접 답니다.
        const viaLib = /teamConfidenceLine\s*\(/.test(f.code);
        const spelled = /팀\s*신뢰도/.test(f.code);
        if (!viaLib && !spelled) bare.push(`${root.name}/${f.rel}`);
      }
    }
    ok(total >= 3, `confidence_label 을 그리는 자리가 ${total}곳뿐입니다 — 셋(레거시 기여도·SPA 기여도·보고서)보다 적으면 자가 낡은 것입니다`);
    strictEqual(
      bare.join(', '),
      '',
      '신뢰도 한 줄이 **누구를 잰 값인지** 안 말합니다 — 이 값은 팀 하나를 잰 것인데 ' +
        '사람 이름 밑에 그려집니다 (결함 384). `teamConfidenceLine()` 을 부르세요',
    );
  });

  it('⭐ 팀 값과 사람 값을 **한 줄에 잇지 않는다**', () => {
    /* 「신뢰도 낮음 · 모르는 폭 23%p」 — 앞은 팀, 뒤는 사람입니다. 한 줄에
       이으면 둘 다 같은 범위로 읽힙니다(결함 331·332 의 모양). 두 함수가
       하나의 템플릿 안에서 만나는 것을 막습니다. */
    const glued: string[] = [];
    for (const root of roots)
      for (const f of readers(root.base)) {
        for (const line of f.code.split('\n')) {
          const hasTeam = /teamConfidenceLine\s*\(|팀\s*신뢰도/.test(line);
          const hasMine = /describeWidthNote\s*\(|uncertaintyDotsNote\s*\(|모르는\s*폭/.test(line);
          if (hasTeam && hasMine) glued.push(`${root.name}/${f.rel}: ${line.trim().slice(0, 70)}`);
        }
      }
    strictEqual(
      glued.join(' | '),
      '',
      '팀 값과 사람 값이 한 줄에 있습니다 — 범위가 둘인데 이름표가 하나입니다 (결함 384)',
    );
  });
});

describe('답글은 **원글이 안 보일 때도** 답글이라고 말한다 (결함 419)', () => {
  /*
   * 화면이 `messages.find((m) => m.id === message.reply_to_id)` 로 원글을
   * 찾고, **못 찾으면 인용 블록을 통째로 안 그렸습니다.** 서버는 최신
   * 50개만 주므로(`MESSAGE_PAGE`) 앞쪽 글에 단 답글은 **평범한 글처럼**
   * 보였습니다 — 55개짜리 채널을 제품 경로로 만들어 재현했습니다.
   *
   * 그 자리의 주석은 「⚠️ 답글이 무엇에 달렸는지 **여기 보여 줍니다.**
   * 안 보이면 "근거 #5" 라고 적어 놓고 원문을 볼 방법이 없던 그
   * 실패입니다」였습니다 — 해악을 적어 두고 그 갈래만 비어 있었습니다.
   */
  const chat = () => codeOf(readFileSync(join(DEMO, 'chat.tsx'), 'utf8'));

  it('⭐ 화면이 원글을 **직접 찾지 않는다** — 판단은 `@lib`', () => {
    const code = chat();
    ok(
      /quoteFor\(/.test(code),
      '화면이 `quoteFor` 를 안 거칩니다 — 화면 코드에는 자동 검사가 없습니다',
    );
    ok(
      !/messages\.find\(\s*\(m\)\s*=>\s*m\.id === message\.reply_to_id/.test(code),
      '화면이 원글을 직접 찾습니다 — 못 찾는 갈래가 다시 조용해집니다',
    );
  });

  it('⛔ 못 찾은 갈래가 **갈 자리를 가리킨다** — 그 자리가 실제로 있다', () => {
    // 말만 하고 문을 안 주면 실패 ③ 입니다. 「이전 대화 더 보기」는
    // 결함 315 가 붙인 단추이고, 그 글자가 화면에 실제로 있어야 합니다.
    const lib = codeOf(readFileSync(join(ROOT, 'src', 'lib', 'chat', 'view.ts'), 'utf8'));
    const older = /kind: 'older'[\s\S]{0,200}?note:\s*'([^']*)'/.exec(lib)?.[1] ?? '';
    ok(older !== '', '못 찾은 갈래의 문장을 못 찾았습니다 — 가드가 낡았습니다');
    const points = /「([^」]+)」/.exec(older)?.[1] ?? '';
    ok(points !== '', `그 문장이 갈 자리를 안 가리킵니다: ${older}`);
    ok(
      chat().includes(points),
      `가리키는 「${points}」 가 화면에 없습니다 — 허공을 가리킵니다`,
    );
  });
});

describe('근거 발화를 **세었으면 볼 문**도 준다 (결함 418)', () => {
  /*
   * `lib/review/evidence.ts` 머리말: 「이 제품의 **대표 주장**은 "기여도
   * 숫자에서 출발해 어느 회의 몇 번째 발언까지 거슬러 올라갈 수 있다" …
   * 오랫동안 화면은 `근거 #5` 라고 **적기만** 했습니다 — 눌러도 아무 데도
   * 못 갔습니다.」
   *
   * 검토 화면은 고쳤는데 **칸반 카드의 서랍**이 그 모양으로 남아 있었습니다:
   * `evidence_utterance_ids` 를 손에 들고 「근거 발화 1건」이라고 개수만
   * 적고, 원문으로 가는 컨트롤은 0개였습니다(렌더해서 셌습니다).
   *
   * ⚠️ 상자는 **원래 있었습니다** — `demo/evidence.tsx`. 회의를 붙일 때
   *    정하게 돼 있어서(`mountEvidence(apiBase, meetingId)`) 카드마다 회의가
   *    다른 칸반에는 붙일 수가 없었을 뿐입니다. 회의를 **부를 때** 정하게
   *    바꿔 두 화면이 같은 상자를 씁니다.
   */
  const screens = () =>
    readdirSync(DEMO)
      .filter((name) => SCREEN_EXT.test(name) && !name.endsWith('.test.ts'))
      .map((name) => ({ name, code: codeOf(readFileSync(join(DEMO, name), 'utf8')) }));

  it('⭐ `evidence_utterance_ids` 를 그리는 화면은 **원문으로 가는 문**이 있다', () => {
    const blind = screens()
      .filter(({ code }) => /evidence_utterance_ids/.test(code))
      .filter(({ code }) => !/openEvidence\(/.test(code))
      .map(({ name }) => name);
    deepStrictEqual(
      blind,
      [],
      '근거 발화를 세어 놓고 볼 자리를 안 줍니다 — 대표 실패 ③',
    );
  });

  it('⛔ `openEvidence` 를 부르는 화면은 상자를 **붙이기도** 한다', () => {
    // 가리키기만 하고 안 그리면 눌러도 아무 일이 안 납니다(결함 239 의 모양).
    const dangling = screens()
      .filter(({ code }) => /openEvidence\(/.test(code))
      .filter(({ name, code }) => name !== 'evidence.tsx' && !/mountEvidence\(/.test(code))
      .map(({ name }) => name);
    deepStrictEqual(dangling, [], '근거 상자를 안 붙였습니다 — 눌러도 아무 일이 안 납니다');
  });

  it('⚠️ 상자는 회의를 **부를 때** 받는다 — 붙일 때가 아니라', () => {
    const code = codeOf(readFileSync(join(DEMO, 'evidence.tsx'), 'utf8'));
    ok(
      /export function openEvidence\(\s*meetingId: number/.test(code),
      '`openEvidence` 가 회의를 안 받습니다 — 카드마다 회의가 다른 화면에서는 못 씁니다',
    );
    ok(
      /export function mountEvidence\(apiBase: string\): void/.test(code),
      '`mountEvidence` 가 아직 회의를 붙듭니다 — 한 화면에 회의 하나만 됩니다',
    );
  });
});

describe('셸마다 **본문 표지**가 있다 (결함 421)', () => {
  /*
   * 이 제품에는 셸이 셋입니다 — 레거시 React 화면 열셋(`demo/nav.ts` 가
   * 셸을 그립니다) · SPA 의 `AppShell` · SPA 밖 정적 화면 둘(녹음 · 통화).
   * 표지(`<main id="main-content">`)를 **레거시만** 안 그리고 있었습니다.
   *
   * 재현(브라우저): 레거시 홈은 컨트롤 스물 중 **열여섯이 어느 표지에도
   * 안 들어** 있었고, 낭독기의 표지 목록에는 내비 둘만 있고 본문이
   * 없었습니다. `#main-content` 는 화면 열셋 전부에서 **0개**였습니다.
   *
   * ⚠️ **「건너뛰기 링크가 없다」는 결함이 아닙니다 — 재 보고 갈랐습니다.**
   * WCAG 2.4.1 이 요구하는 것은 되풀이되는 덩어리를 **지나갈 수 있을 것**
   * 이고, 그 내비를 본문 **뒤에** 두는 것도 같은 요구를 만족시킵니다.
   * Tab 순서를 재니 레거시는 `Tab 1 = 본문 · 67 = #nav · 72 = #tabs`,
   * SPA 는 `Tab 1 = 건너뛰기 · 2~6 = 레일 · 7 = 본문` 이었습니다. 레거시에
   * 링크를 달면 모든 키보드 사용자에게 Tab 한 번을 더 물리면서 아무 데도
   * 안 데려갑니다. 그래서 안 달았고, **왜 안 달았는지**를 `skip.ts` 와
   * `nav.ts` 에 적어 두었습니다.
   *
   * ⛔ **이 자가 못 보는 것**: 「지나갈 수 있는가」 자체는 Tab 순서라
   * 브라우저 없이 못 잽니다. `docs/24` 에 재는 방법을 적어 두었습니다.
   */
  const libSkip = () => readFileSync(join(LIB, 'nav', 'skip.ts'), 'utf8');
  const idOf = (code: string): string => {
    const m = /export const MAIN_LANDMARK_ID = '([^']+)'/.exec(code);
    ok(m !== null, '`MAIN_LANDMARK_ID` 를 못 찾았습니다 — 자가 낡았습니다');
    return (m as RegExpExecArray)[1] ?? '';
  };
  const textOf = (code: string): string => {
    const m = /export const SKIP_TEXT = '([^']+)'/.exec(code);
    ok(m !== null, '`SKIP_TEXT` 를 못 찾았습니다 — 자가 낡았습니다');
    return (m as RegExpExecArray)[1] ?? '';
  };

  it('⭐ 레거시 셸이 본문 표지를 그린다', () => {
    const code = codeOf(readFileSync(join(DEMO, 'nav.ts'), 'utf8'));
    ok(
      /createElement\('main'\)/.test(code),
      '레거시 셸에 `main` 표지가 없습니다 — 본문이 어느 표지에도 안 들어갑니다',
    );
    ok(
      /\.id = MAIN_LANDMARK_ID/.test(code),
      '표지 id 를 `@lib` 에서 안 가져옵니다 — 사본은 갈라집니다',
    );
    // 표지로 건너뛴 초점을 받을 수 있어야 합니다.
    ok(/\.tabIndex = -1/.test(code), '표지가 초점을 못 받습니다 — 건너뛰어도 앉을 자리가 없습니다');
  });

  it('⭐ SPA 셸이 본문 표지를 그린다 — 같은 이름으로', () => {
    const code = codeOf(
      readFileSync(join(ROOT, '..', 'webapp', 'src', 'components', 'AppShell.tsx'), 'utf8'),
    );
    ok(
      /<main[^>]*id=\{MAIN_LANDMARK_ID\}/.test(code),
      'SPA 표지가 `@lib` 의 이름을 안 씁니다',
    );
    ok(/href=\{SKIP_HREF\}/.test(code), 'SPA 건너뛰기 링크가 주소를 손으로 적습니다');
    ok(/\{SKIP_TEXT\}/.test(code), 'SPA 건너뛰기 링크가 글자를 손으로 적습니다');
  });

  it('⭐ 정적 화면 둘도 **같은 글자**를 쓴다 — TS 를 못 부르므로 자가 짝을 잰다', () => {
    /* `index.html`(녹음)·`call.html`(통화)은 React 밖이라 `@lib` 를 부를 수
       없습니다. 그러면 사본이 셋이 되므로, 여기서 **글자가 같은지**를
       잽니다(결함 345 의 방법). */
    const code = libSkip();
    const id = idOf(code);
    const text = textOf(code);
    const missing: string[] = [];
    for (const name of ['index.html', 'call.html']) {
      const html = readFileSync(join(PUBLIC, name), 'utf8');
      if (!new RegExp(`<main id="${id}"[^>]*tabindex="-1"`).test(html)) {
        missing.push(`${name}: 표지(<main id="${id}" tabindex="-1">)`);
      }
      if (!new RegExp(`<a class="skip" href="#${id}">${text}</a>`).test(html)) {
        missing.push(`${name}: 건너뛰기 링크`);
      }
    }
    deepStrictEqual(missing, [], '정적 화면이 `@lib` 와 다른 글자를 씁니다 — 갈라집니다');
  });

  it('⛔ 아무도 표지 이름을 **손으로** 적지 않는다', () => {
    /* ⚠️ 정적 HTML 둘은 예외입니다 — TS 를 못 부르므로 위 검사가 짝을
       잽니다. 여기서 보는 것은 **코드**입니다. */
    const id = idOf(libSkip());
    const roots: { name: string; base: string }[] = [
      { name: '레거시', base: DEMO },
      { name: 'SPA', base: join(ROOT, '..', 'webapp', 'src') },
    ];
    const hand: string[] = [];
    for (const { name, base } of roots) {
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
            const code = codeOf(readFileSync(full, 'utf8'));
            if (new RegExp(`['"\`#]${id}['"\`]`).test(code)) {
              hand.push(`${name} ${entry.name}`);
            }
          }
        }
      };
      walk(base);
    }
    deepStrictEqual(hand, [], '표지 이름을 손으로 적은 자리가 있습니다 — `@lib` 를 부르십시오');
  });
});

describe('미해결 사안의 근거도 **문**이다 (결함 420)', () => {
  /*
   * 서버 `UnresolvedIssueOut` 의 docstring 이 왜 번호를 싣는지 적어 뒀습니다:
   * 「근거 발화를 같이 싣습니다 — 근거 없이 "이게 미해결입니다" 라고만 하면
   * 사람은 확인할 방법이 없고, 이 저장소는 그런 값을 화면에 올리지 않기로
   * 했습니다.」
   *
   * 그런데 `@lib` 의 `describeIssue` 가 그 번호를 **버리고**
   * `evidenceCount: number` 하나만 돌려줬고, 그래서 두 뿌리 다 「근거 발화
   * 1건」이라고 **적기만** 했습니다 — 눌러도 아무 데도 못 갔습니다.
   * 재현: 회의 1(씨앗)의 검토 화면. 미해결 사안의 근거는 발화 #5 인데,
   * **같은 화면 아래 후보 카드**는 그 #5 를 `근거 #5` 라는 단추로 열고
   * 있었습니다. 한 화면 안에서 같은 발화가 한 줄에서는 문이고 다른 줄에서는
   * 죽은 숫자였습니다.
   *
   * ⚠️ **결함 418 의 가드가 이걸 못 봤습니다.** 그 자는 화면 파일에
   * `evidence_utterance_ids` 라는 **글자**가 있는지 보는데, 이 값은
   * `@lib` 이 파생 개수로 바꿔서 넘겨 주므로 화면에 그 글자가 없습니다.
   * 게다가 판정이 **파일 단위**라, `openEvidence(` 를 다른 줄에서 부르는
   * `review.tsx` 는 통째로 초록이었습니다(결함 392 회차의 「파일 어딘가
   * 한 곳만 본 것」). 자(무엇을 찾나)와 판정 단위는 따로 낡습니다.
   *
   * 「옛 자 + 옛 코드 = 0건」의 증거는 **직전 커밋**입니다 — 결함이 그대로
   * 있는 채로 pytest·프런트가 전부 초록이었습니다.
   *
   * ⛔ **이 자가 못 보는 것**: 근거 개수를 사람에게 적는 다른 자리
   * (`reports.tsx` 의 「근거 N건」 · SPA 기여도의 범주 힌트)는 안 봅니다.
   * 앞엣것은 서버가 **개수만** 싣고 번호를 안 주므로 화면이 문을 낼 수
   * 없고(결함 312 의 모양), 뒤엣것은 `docs/24` 에 「결정이 필요한 자리」로
   * 적혀 있습니다. 둘 다 이 결함과 **다른 축**입니다.
   */
  const libIssueView = () =>
    codeOf(readFileSync(join(LIB, 'review', 'minutes.ts'), 'utf8'));

  it('⭐ `@lib` 의 미해결 사안 뷰는 근거를 **번호로** 낸다 — 개수가 아니라', () => {
    const code = libIssueView();
    const view = /export interface IssueView \{([\s\S]*?)\n\}/.exec(code);
    ok(view !== null, '`IssueView` 를 못 찾았습니다 — 자가 낡았습니다');
    const body = (view as RegExpExecArray)[1] ?? '';
    ok(
      /\bevidence:\s*number\[\]/.test(body),
      '`IssueView` 가 근거 **번호**를 안 냅니다 — 화면이 문을 낼 수가 없습니다',
    );
    ok(
      !/\bevidenceCount\b/.test(body),
      '파생 개수를 따로 들고 있습니다 — 사본은 갈라집니다(`evidence.length` 를 쓰십시오)',
    );
  });

  /**
   * 그 뷰를 **그리는** 파일들. 뿌리마다 따로 셉니다 — 한쪽만 고치고
   * 통과하는 것이 이 저장소에서 제일 흔한 재발 모양입니다.
   */
  const drawers = (base: string): { rel: string; code: string }[] => {
    const out: { rel: string; code: string }[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const code = codeOf(readFileSync(full, 'utf8'));
          if (/\bissueViews\(/.test(code)) out.push({ rel: full.slice(base.length + 1), code });
        }
      }
    };
    walk(base);
    return out;
  };

  /** `code[open]` 이 `(` 일 때 짝이 맞는 `)` 의 자리. 못 찾으면 -1. */
  function closeOf(code: string, open: number): number {
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /**
   * 미해결 사안 **한 줄을 그리는 자리**와 그 줄의 이름.
   *
   * ⚠️ **파일 전체를 보면 안 됩니다.** 처음 쓴 자가 그랬고, 심어 보니
   * 통과했습니다 — `review.tsx` 는 바로 아래 **관찰 줄**에서도
   * `openEvidence(meetingId, view.evidence, …)` 를 부르므로, 미해결 사안의
   * 문을 통째로 걷어내도 「파일 어딘가에 `.evidence` 를 여는 곳이 있다」로
   * 초록이었습니다. 이 검사가 막으려던 바로 그 함정(결함 392 회차)에
   * **자기가 빠진** 것입니다. 그래서 `issueViews(...)` 에서 시작해 그 줄을
   * 그리는 `.map(...)` 의 **몸통만** 잘라 냅니다.
   */
  function issueRow(code: string): { param: string; body: string } | null {
    /* ⚠️ **첫 번째를 집으면 안 됩니다.** SPA 의 첫 `issueViews(...)` 는
       여닫이 머리말의 `…).length` 입니다 — 줄을 그리는 자리가 아닙니다.
       그것만 보고 「못 읽었다」가 나왔고, 「못 읽은 것이 있으면 실패」를
       넣어 뒀기에 조용히 지나가지 않았습니다. 그리는 자리를 찾을 때까지
       전부 훑습니다. */
    for (const call of code.matchAll(/\bissueViews\(/g)) {
      const row = rowAt(code, call.index as number, call[0].length);
      if (row !== null) return row;
    }
    return null;
  }

  function rowAt(code: string, at: number, len: number): { param: string; body: string } | null {
    const open = at + len - 1;
    const end = closeOf(code, open);
    if (end < 0) return null;

    // ① `issueViews(...).map(...)` — SPA 처럼 바로 이어 그리는 모양.
    let mapOpen = -1;
    const inline = /^\s*\.map\(/.exec(code.slice(end + 1));
    if (inline !== null) {
      mapOpen = end + inline[0].length;
    } else {
      // ② `const X = issueViews(...)` 로 받아 두고 `X.map(` — 레거시.
      const before = code.slice(0, at);
      const bound = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(before.trimEnd() + ' ');
      const name = bound?.[1] ?? /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(before)?.[1];
      if (name === undefined) return null;
      const use = new RegExp(`\\b${name}\\.map\\(`).exec(code);
      if (use === null) return null;
      mapOpen = (use.index as number) + use[0].length - 1;
    }
    const mapEnd = closeOf(code, mapOpen);
    if (mapEnd < 0) return null;
    const args = code.slice(mapOpen + 1, mapEnd);
    const param = /^\s*\(?\s*([A-Za-z_$][\w$]*)/.exec(args)?.[1];
    if (param === undefined) return null;
    return { param, body: args };
  }

  /*
   * ⚠️ **걷는 자리는 「화면」입니다.** 처음엔 `src` 통째로 걸었더니
   * `lib/review/minutes.ts` 가 잡혔습니다 — 그 파일도 자기 안에서
   * `issueViews(...)` 를 부릅니다(회의록이 비었는지 보려고). `@lib` 은
   * 문을 낼 수 있는 자리가 아니므로 여기서 잴 것이 아닙니다.
   */
  const ROOTS: { name: string; base: string }[] = [
    { name: '레거시 frontend/src/demo', base: join(DEMO) },
    { name: 'SPA webapp/src', base: join(ROOT, '..', 'webapp', 'src') },
  ];

  for (const { name, base } of ROOTS) {
    it(`⭐ ${name} — 미해결 사안을 그리는 화면은 근거를 **연다**`, () => {
      const files = drawers(base);
      // 안 보고 있는 상태 자체가 실패입니다 (결함 286).
      ok(
        files.length > 0,
        `${name} 에 미해결 사안을 그리는 화면이 0개입니다 — 자가 눈을 감았습니다`,
      );
      const unreadable = files.filter(({ code }) => issueRow(code) === null).map(({ rel }) => rel);
      // 못 읽은 것을 「0건」으로 넘기면 자가 조용히 눈을 감습니다.
      deepStrictEqual(unreadable, [], `그리는 자리를 못 읽었습니다 (${name}) — 자가 낡았습니다`);

      const blind = files
        .filter(({ code }) => {
          const row = issueRow(code) as { param: string; body: string };
          /* 문이 둘 중 하나면 됩니다 — 레거시는 `openEvidence`(상자),
             SPA 는 `EvidenceChips`(칩). 어느 쪽이든 **그 줄의 `evidence`**
             가 인자로 들어가야 합니다. 다른 값을 넣고 통과하면 안 됩니다. */
          const mine = new RegExp(`\\b${row.param}\\.evidence\\b`);
          const opened = callArgs(row.body, 'openEvidence').some((a) => mine.test(a));
          const chipped = new RegExp(
            `<EvidenceChips[\\s\\S]{0,160}?ids=\\{${row.param}\\.evidence\\}`,
          ).test(row.body);
          return !opened && !chipped;
        })
        .map(({ rel }) => rel);
      deepStrictEqual(
        blind,
        [],
        `근거 발화를 세어 놓고 볼 자리를 안 줍니다 (${name}) — 대표 실패 ③`,
      );
    });
  }
});

describe('소켓이 끊기면 **화면이 말한다** (결함 416)', () => {
  /*
   * 이 저장소의 WebSocket 은 둘입니다 — 통화(`call.ts`)와 채팅(`chat.tsx`).
   * 통화는 `onclose` 에서 「통화가 끊겼습니다 · 새로고침하면 다시 붙습니다」
   * 라고 말하고 그 위에 이유까지 적어 뒀습니다: 「⚠️ 조용히 닫히면 화면은
   * 통화 중인 줄 안다.」 채팅에는 `onclose` 가 **아예 없었습니다.**
   *
   * 재현: 브라우저 둘로 같은 채널을 열고 서버를 다시 띄우면, 지켜보던
   * 사람의 화면은 아무 말도 안 하고 그 뒤에 온 글이 **영영 안 옵니다**
   * (줄 수 7 → 7). 새로고침하면 8 줄입니다.
   *
   * ⚠️ **「안 붙는 것」은 그대로 조용합니다** — 기록된 결정입니다(화면이
   *    방금 HTTP 로 읽어 와 최신이라 사람이 할 일이 없습니다). 여기서
   *    재는 것은 **붙었다가 끊긴** 갈래뿐입니다.
   */
  const sockets: [string, string][] = [
    ['통화', join(ROOT, 'src', 'demo', 'call.ts')],
    ['채팅', join(ROOT, 'src', 'demo', 'chat.tsx')],
  ];

  it('⭐ `new WebSocket` 을 여는 화면은 **전부** `onclose` 를 단다', () => {
    const missing = sockets
      .filter(([, path]) => {
        const code = codeOf(readFileSync(path, 'utf8'));
        return /new WebSocket\(/.test(code) && !/\.onclose\s*=/.test(code);
      })
      .map(([name]) => name);
    deepStrictEqual(
      missing,
      [],
      '소켓이 조용히 닫힙니다 — 화면은 살아 있는 줄 알고 사람은 낡은 것을 봅니다',
    );
  });

  it('⛔ 채팅은 **우리가 닫은 것**과 저쪽이 끊은 것을 가른다', () => {
    // 채널을 옮길 때마다 「끊겼습니다」가 뜨면 그 말이 닳습니다.
    const code = codeOf(readFileSync(join(ROOT, 'src', 'demo', 'chat.tsx'), 'utf8'));
    ok(
      /streamClosedNote\(/.test(code),
      '채팅이 `@lib` 의 판단을 안 거칩니다 — 화면이 문장을 직접 짜면 검사 밖입니다',
    );
    const cleanup = /return \(\) => \{([\s\S]{0,200}?)\};/.exec(code)?.[1] ?? '';
    ok(
      /onPurpose\s*=\s*true/.test(cleanup),
      '치울 때 「우리가 닫았다」를 안 적습니다 — 채널만 옮겨도 끊겼다고 합니다',
    );
  });
});

describe('설정 탭의 **묶음 이름**은 `title=` 에만 있으면 안 된다 (결함 412)', () => {
  /*
   * SPA 설정의 탭은 `내 설정`(역할과 가중치·GitHub 계정·내 정보)과
   * `프로젝트`(팀원·저장소 연결·이름과 초대) 둘로 나뉘고, 그 경계는
   * `aria-hidden` 인 구분선 하나입니다. 묶음 이름은 `title=` 에만
   * 있었고 주석은 「낭독기와 마우스에는 전해집니다」라고 단언했습니다 —
   * **낭독기 쪽이 거짓**입니다. 링크에 글자가 있으면 접근 이름은 그
   * 글자에서 나오고 `title` 은 안 쓰입니다.
   *
   * 렌더해서 재니 탭 여섯의 접근 이름이 눈에 보이는 글자 그대로였고
   * (`역할과 가중치`·`팀원`…), 「내 설정」은 화면 본문에 **0회**
   * 였습니다. 즉 「이건 나만 고치는 것」과 「이건 팀 것」의 구분이
   * 마우스를 올릴 수 있는 사람에게만 있었습니다 — 이 저장소가
   * `WHY_ONLY_ME` 로 못 박아 둔 바로 그 구분입니다.
   *
   * ⚠️ 고침은 **글자를 더하는 것이 아닙니다.** 바로 위 주석이 「탭 줄에
   *    머리말을 넣으면 누를 수 없는 글자가 탭처럼 보입니다」라고 이유를
   *    적어 둔 기록된 결정이라 그대로 둡니다. 이름은 묶음 자신에 답니다
   *    (`role="group" aria-label`) — `activity.tsx` 의 거르개가 이미
   *    쓰는 방법입니다.
   */
  const settings = () =>
    readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Settings.tsx'), 'utf8');

  /** `.tabs__group` 여는 태그. 주석은 미리 걷습니다. */
  function groupTag(): string {
    const code = codeOf(settings());
    const at = code.indexOf('className="tabs__group"');
    ok(at !== -1, '`.tabs__group` 을 못 찾았습니다 — 가드가 낡았습니다');
    const open = code.lastIndexOf('<', at);
    const close = code.indexOf('>', at);
    ok(open !== -1 && close !== -1, '여는 태그를 못 읽었습니다');
    return code.slice(open, close + 1);
  }

  it('⭐ 묶음이 **스스로 이름을 가진다** — `title=` 말고', () => {
    const tag = groupTag();
    ok(
      /aria-label=\{group\}/.test(tag),
      `묶음 이름이 접근성 트리에 없습니다 — 마우스에만 남습니다:\n  ${tag}`,
    );
    ok(/role="group"/.test(tag), `묶음이 묶음으로 안 읽힙니다:\n  ${tag}`);
  });

  it('⛔ 묶음 이름이 **`title=` 에만** 있지 않다', () => {
    // ⚠️ 낱말이 아니라 요구를 잽니다 — `group` 을 쓰는 자리를 전부 세어
    //    그중 **사람에게 닿는** 자리가 `title=` 밖에 하나라도 있는지
    //    봅니다. `title` 은 그대로 둡니다(마우스에는 유용합니다) — 재는
    //    것은 **거기에만** 있는가입니다.
    //
    // ⚠️ `key={group}` 은 빼야 합니다. React 내부용이라 사람에게 아무것도
    //    안 전하는데, 안 빼면 고침을 통째로 걷어내도 이 검사가 초록입니다
    //    — 심어 보고 알았습니다.
    const code = codeOf(settings());
    const uses = [...code.matchAll(/\{group\}|\$\{group\}/g)].map((m) => m.index as number);
    ok(uses.length > 0, '`group` 을 쓰는 자리가 0곳입니다 — 가드가 낡았습니다');
    const hidden = [
      ...code.matchAll(/title=\{`[^`]*`\}|title=\{[^}]*\}|key=\{[^}]*\}/g),
    ].map((m) => [m.index as number, (m.index as number) + m[0].length] as const);
    const reaches = uses.filter((i) => !hidden.some(([from, to]) => i >= from && i < to));
    ok(
      reaches.length > 0,
      '묶음 이름이 `title=`(과 `key=`) 안에만 있습니다 — 마우스 밖에서는 사라집니다',
    );
  });
});

describe('홈의 「다음에 할 일」 은 마우스 밖에서도 닿아야 한다 (결함 406)', () => {
  /*
   * `docs/22` 처방 ③ 은 「이유는 부르면 온다 — 문장을 **지우지 않고** `?`
   * 한 겹 아래로(`Why`)」이고, 같은 문서가 `Why` 를 WCAG 1.4.13 세 조건과
   * 키보드로 재 두었습니다. 그런데 SPA 홈만 그 문장을 `title=` 에 넣고
   * 있었습니다 — 다섯 줄 전부. 렌더해서 재니 본문에 0곳, 홈의 `Why` 0개,
   * `aria-label`·`aria-describedby` 도 없어 **마우스에만** 있었습니다.
   * 같은 사실을 레거시 홈은 눈에 보이는 글로 적습니다(결함 290).
   *
   * ⚠️ 뿌리마다 따로 잽니다(결함 321) — 한쪽만 지켜도 초록이면 이 부류는
   *    구조적으로 안 보입니다.
   */
  const spaHome = () =>
    readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Home.tsx'), 'utf8');
  const legacyHome = () => readFileSync(join(ROOT, 'src', 'demo', 'home.tsx'), 'utf8');

  it('⭐ SPA 홈이 이유를 `title=` 에 담지 않는다', () => {
    const code = spaHome();
    const inTitle = [...code.matchAll(/title=\{([^}]*)\}/g)]
      .map((m) => m[1] as string)
      .filter((expr) => /reason/.test(expr));
    deepStrictEqual(
      inTitle,
      [],
      `이유가 툴팁에만 있습니다 — 키보드·터치·낭독기에는 안 옵니다: ${inTitle.join(' · ')}`,
    );
  });

  it('⭐ SPA 홈이 이유를 `Why` 로 내보낸다 — 지우는 것이 아니라 옮기는 것', () => {
    const code = spaHome();
    ok(/<Why\b/.test(code), 'SPA 홈에 `Why` 가 없습니다 — 이유가 어디로도 안 나갑니다');
    const why = code.slice(code.indexOf('<Why'));
    ok(
      /lines=\{\[[^\]]*reason/.test(why),
      `\`Why\` 는 있는데 이유를 안 넘깁니다: ${why.slice(0, 160)}`,
    );
  });

  it('⭐ 레거시 홈은 그 문장을 **눈에 보이는 글**로 적는다', () => {
    // 두 뿌리가 서로 다른 방법으로 같은 사실을 말합니다 — 어느 한쪽이
    // 조용해지면 그때가 갈라진 것입니다.
    ok(
      /\{step\.reason\}/.test(legacyHome()),
      '레거시 홈이 이유를 안 그립니다',
    );
  });
});

describe('SPA 의 「안 됩니다」 는 들려야 한다 (docs/22 · WCAG 4.1.3)', () => {
  /** `webapp/src` 아래 화면·컴포넌트 소스 전부. */
  const spaSources = (): { rel: string; code: string }[] => {
    const base = join(ROOT, '..', 'webapp', 'src');
    const out: { rel: string; code: string }[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name))
          out.push({ rel: full.slice(base.length + 1), code: readFileSync(full, 'utf8') });
      }
    };
    if (!existsSync(base)) return out;
    walk(base);
    return out;
  };

  it('⭐ `disabled-reason` 을 화면이 직접 그리지 않는다 — `Problem` 을 쓴다', () => {
    // ⚠️ 이 클래스는 스무 곳 남짓에 흩어져 있었고, 그중 **둘만**
    // `role="alert"` 였습니다. 나머지는 눈으로 보는 사람에게만 나타나고
    // 낭독기에는 아무 일도 안 일어난 것과 같았습니다 — 저장이 실패해도,
    // 저장소 주소가 틀려도 조용했습니다.
    //
    // 속성을 스무 곳에 하나씩 흩뿌리면 반드시 몇 곳이 빠집니다. 그래서
    // 자리 자체를 `components/Problem.tsx` 한 벌로 올렸고, 이 검사가
    // **되돌아가는 것**을 막습니다.
    const offenders = spaSources()
      .filter(({ rel }) => rel !== join('components', 'Problem.tsx'))
      .filter(({ code }) => /className=(?:"|\{`)[^"`]*disabled-reason/.test(code))
      .map(({ rel }) => rel);
    strictEqual(
      offenders.join(', '),
      '',
      '`<Problem>` 을 쓰세요 — 라이브 영역이 붙어 있어야 낭독기에 전해집니다',
    );
  });

  it('⭐ `Problem` 은 두 톤 다 라이브 영역이다 (끼어들기 / 기다리기)', () => {
    // ⚠️ 전부 `alert` 로 하면 안 됩니다. 저장소 주소 오류는 글자를 칠
    // 때마다 다시 나타나는데, `alert` 는 끼어들어 읽으므로 한 글자마다
    // 낭독기가 말을 끊습니다 — 타자를 칠 수 없게 됩니다.
    const code = readFileSync(
      join(ROOT, '..', 'webapp', 'src', 'components', 'Problem.tsx'),
      'utf8',
    );
    ok(/role=\{tone === 'failed' \? 'alert' : 'status'\}/.test(code), '두 톤이 갈라져 있어야 합니다');
  });

  it('⭐ 칸 옆 오류는 **그 칸과 이어져** 있다 (`aria-describedby`)', () => {
    // 낭독기는 칸에 초점이 갔을 때 `aria-describedby` 가 가리키는 것만
    // 읽습니다. 바로 아래 적어 두기만 하면 화면에만 뜨고 아무도 안 듣습니다.
    const settings = readFileSync(
      join(ROOT, '..', 'webapp', 'src', 'screens', 'Settings.tsx'),
      'utf8',
    );
    for (const id of ['repo-problem', 'title-problem']) {
      ok(
        settings.includes(`aria-describedby="${id}"`),
        `${id} 을 가리키는 입력칸이 없습니다`,
      );
      ok(settings.includes(`id="${id}"`), `${id} 이라는 자리가 없습니다`);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 베타 체험에서 나온 것들 (docs/23)
// ══════════════════════════════════════════════════════════════

describe('베타 체험 QA — 화면이 터졌을 때·프로젝트가 둘일 때', () => {
  const webapp = (...parts: string[]) =>
    readFileSync(join(ROOT, '..', 'webapp', 'src', ...parts), 'utf8');
  /**
   * 주석을 걷어낸 판.
   *
   * ⚠️ 낱말만 세면 **주석에 적힌 이름**이 배선으로 잡힙니다. 심어서
   *    확인하다 알았습니다 — `watchForUncaught();` 를 주석 처리했는데
   *    가드가 그대로 통과했습니다. 가드가 요구를 재고 있지 않았던 것입니다.
   */
  const code = (...parts: string[]) =>
    webapp(...parts)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');

  it('⭐ 라우터에 **우리** 오류 화면이 걸려 있다', () => {
    // ⚠️ 안 걸면 라우터 기본 화면이 뜹니다. 베타 체험에서 찍은 실제 화면:
    //
    //     Unexpected Application Error!
    //     e.filter is not a function
    //     at ls (…/assets/index-DskNXvnA.js:12:42055)
    //
    // 영문이고, 압축된 스택이고, **나가는 문이 하나도 없습니다.** 그리고
    // 서버 로그에는 아무것도 안 남습니다 — 요청은 200 이었으니까요.
    const main = code('main.tsx');
    ok(/import Crashed from/.test(main), '`Crashed` 를 불러오지 않습니다');
    const wired = main.match(/errorElement:\s*<Crashed\s*\/>/g) ?? [];
    ok(
      wired.length >= 2,
      `errorElement 가 ${wired.length}곳뿐입니다 — 로그인 갈래와 로그인 뒤 갈래 둘 다 덮어야 합니다`,
    );
  });

  it('⭐ 렌더 **밖에서** 던져진 것도 줍는다', () => {
    // ErrorBoundary 는 렌더 중에 던진 것만 잡습니다. `setTimeout` 안,
    // 거절된 `await` 은 못 잡는데 실제로는 그쪽이 더 많습니다.
    ok(/watchForUncaught\(\)/.test(code('main.tsx')), '`watchForUncaught()` 를 안 부릅니다');
  });

  it('⚠️ 오류 보고는 실패해도 조용하다 — 보고가 또 오류를 내면 브라우저가 멈춘다', () => {
    const diag = code('api', 'diag.ts');
    ok(/\.catch\(\(\)\s*=>\s*\{\}\)/.test(diag), 'fetch 실패를 삼키지 않습니다');
    ok(/keepalive:\s*true/.test(diag), '화면이 사라지는 중이면 마지막 보고가 취소됩니다');
  });

  it('⭐ 프로젝트가 둘 이상이면 셸이 **바꿀 자리**를 그린다', () => {
    // ⚠️ 판단(`lib/nav/rail.ts`)은 처음부터 있었고 **부르는 곳만
    //    없었습니다.** 옛 화면(`demo/nav.ts`)이 부르고 있어서 "아무도 안
    //    쓰는 export" 가드도 통과했습니다 — 화면을 옮기면 가드가 눈을
    //    감는다는 그 자리입니다.
    //
    //    그 동안 사람은 프로젝트를 만들거나 초대 코드로 참가해도 거기로
    //    갈 길이 하나도 없었습니다.
    const shell = code('components', 'AppShell.tsx');
    ok(/railIsWorthIt\(/.test(shell), '하나뿐일 때 안 그리는 판단을 안 씁니다');
    ok(/railAriaLabel\(/.test(shell), '네모 안은 한 글자뿐이라 낭독기가 이름을 못 읽습니다');
    // ⚠️ `appRailHref` 라는 **낱말이 있는가**로 재면 `import` 줄 하나로
    //    통과합니다. 심어서 확인했습니다 — `railItems(..., appRailHref)` 의
    //    마지막 인자를 떼도 가드가 조용했습니다. 넘기는지를 재야 합니다.
    const call = /railItems\(([^;]*?)\)\s*:/.exec(shell)?.[1] ?? '';
    ok(call !== '', '레일 항목을 `railItems` 로 안 만듭니다');
    ok(
      /appRailHref\s*\)?\s*$/.test(call.trim()) || /,\s*appRailHref/.test(call),
      'SPA 주소 만드는 법(`appRailHref`)을 `railItems` 에 안 넘깁니다 — 옛 `/kanban.html?project=` 가 나갑니다',
    );
  });

  it('⭐ 홈이 **주소가 가리키는** 프로젝트를 그린다', () => {
    const home = code('screens', 'Home.tsx');
    ok(/homeProject\(/.test(home), '`projects[0]` 하나만 그리면 나머지로 갈 수 없습니다');
    ok(/requestedProjectId\(/.test(home), '`?project=` 를 안 읽습니다');
    ok(
      /projectId=\{project\?\.project_id\}/.test(home),
      '셸에 안 알려 주면 레일의 「지금 보는 프로젝트」 표시가 거짓말을 합니다',
    );
  });

  it('⚠️ 앱을 통째로 새로고침하지 않는다 — 터진 화면에서 빠져나올 때만 예외', () => {
    // 프로젝트를 만들 때마다 `navigate(0)` 였습니다. 재 보니 3.5초 동안
    // `/app/` · `index-*.js` · `index-*.css` 를 다시 받으며 앱이 재부팅됐고,
    // 그러고도 홈은 **방금 만든 것이 아니라** 첫 번째를 보여 줬습니다.
    // TanStack Query 가 이미 목록을 들고 있으니 무효화 한 줄이면 됩니다.
    //
    // `Crashed.tsx` 의 「다시 시도」만 예외입니다 — 터진 것이 셸일 수 있어
    // 라우터로 옮기면 같은 자리에서 또 터집니다. 거기서는 **진짜**
    // 새로고침이 하려는 일 그 자체입니다.
    const base = join(ROOT, '..', 'webapp', 'src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && entry.name !== 'Crashed.tsx') {
          // ⚠️ **주석을 먼저 걷어냅니다.** 안 그러면 "예전에는 `navigate(0)`
          //    이었습니다" 라고 **왜 안 하는지 적어 둔 주석**이 위반으로
          //    잡힙니다. 처음 쓴 판이 그랬고, 고친 코드를 가드가 위반이라고
          //    했습니다 — 규칙이 아니라 재는 법이 틀린 것이었습니다.
          const code = readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/\/\/[^\n]*/g, ' ');
          if (/navigate\(0\)|location\.reload\(/.test(code)) {
            offenders.push(full.slice(base.length + 1));
          }
        }
      }
    };
    walk(base);
    strictEqual(offenders.join(', '), '', 'TanStack Query 를 무효화하세요 — 앱을 다시 띄우지 말고');
  });
});


describe('리본 옆의 값 (결함 336)', () => {
  /** `webapp/src` 아래 화면 소스 전부 — 뿌리마다 따로 셉니다 (결함 321). */
  const spaScreens = (): { rel: string; code: string }[] => {
    const base = join(ROOT, '..', 'webapp', 'src');
    const out: { rel: string; code: string }[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name))
          out.push({ rel: full.slice(base.length + 1), code: readFileSync(full, 'utf8') });
      }
    };
    if (!existsSync(base)) return out;
    walk(base);
    return out;
  };

  it('⛔ 리본을 그리는 화면이 퍼센트를 **직접 조립**하지 않는다', () => {
    // 홈은 `${Math.round(coverage * 100)}%` 를 **두 곳에서 따로** 만들고
    // 있었습니다 — 눈에 보이는 칸과 `aria-label`. 둘이 갈라질 수 있는
    // 것도 문제지만, 더 나쁜 것은 **눈 쪽에만 축 이름이 빠진** 것이었고
    // 아무도 그걸 못 봤습니다.
    //
    // ⚠️ **낱말이 아니라 요구를 잽니다** — 「커버리지」라는 글자가 있는가가
    // 아니라 「값을 화면이 직접 조립하는가」를 봅니다. 이름 붙이는 일은
    // `@lib` 한 곳에서만 일어나야 갈라지지 않습니다 (결함 295·316).
    const offenders: string[] = [];
    for (const { rel, code } of spaScreens()) {
      const body = codeOf(code);
      if (!/<TrackRibbon\b/.test(body)) continue;
      for (const [line] of body.matchAll(/^.*Math\.round\([^\n]*\)\s*\*?\s*[^\n]*%`/gm)) {
        offenders.push(`${rel}  ${line.trim()}`);
      }
    }
    strictEqual(
      offenders.join('\n'),
      '',
      '리본을 그리는 화면이 퍼센트를 직접 만듭니다 — `@lib` 의 이름 붙은 함수를 쓰세요',
    );
  });

  it('⭐ 홈의 커버리지 값이 `@lib` 의 이름 붙은 함수에서 온다', () => {
    const home = spaScreens().find((f) => f.rel.endsWith('Home.tsx'));
    ok(home !== undefined, 'webapp 에 Home.tsx 가 없습니다');
    for (const fn of ['coverageReading(', 'describeCoverageRibbon(']) {
      ok(
        codeOf(home.code).includes(fn),
        `Home.tsx 가 ${fn} 를 안 씁니다 — 눈과 귀가 갈라집니다`,
      );
    }
  });
});

describe('귀에 없는 것에 손이 닿지 않는다 (결함 337)', () => {
  /**
   * `aria-hidden="true"` 가 붙은 요소의 **부분 나무**를 잘라 냅니다.
   *
   * ⚠️ `aria-hidden` 은 낭독기에게만 하는 말이고 **초점 순서는 안
   * 건드립니다.** 그 안에 버튼·링크·입력칸이 있으면 낭독기에는 "없는
   * 것" 인데 키보드로는 닿습니다 — 로그인 화면에서는 **첫 Tab** 이
   * 거기였습니다.
   */
  const hiddenSubtrees = (code: string): string[] => {
    const out: string[] = [];
    const open = /<([A-Za-z][\w.]*)((?:[^<>'"]|'[^']*'|"[^"]*")*?)>/g;
    let m: RegExpExecArray | null;
    while ((m = open.exec(code)) !== null) {
      const [whole, tag, attrs] = m;
      if (!/aria-hidden\s*=\s*[{"']?\s*(?:true|'true'|"true")/.test(attrs ?? '')) continue;
      if ((attrs ?? '').trimEnd().endsWith('/')) continue; // 자기 닫음 = 안이 없다
      // 같은 이름의 여닫이를 세어 짝을 찾습니다.
      const pair = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
      pair.lastIndex = m.index + whole.length;
      let depth = 1;
      let end = -1;
      let q: RegExpExecArray | null;
      while ((q = pair.exec(code)) !== null) {
        depth += q[0].startsWith('</') ? -1 : 1;
        if (depth === 0) {
          end = q.index;
          break;
        }
      }
      out.push(code.slice(m.index + whole.length, end === -1 ? code.length : end));
    }
    return out;
  };

  /** 초점을 받는 것 — 태그와, 이 저장소에서 버튼을 그리는 컴포넌트. */
  const FOCUSABLE = /<(button|a\s|a>|input|select|textarea)\b|<(EvidenceChip|Picker)\b|tabIndex=\{?0/;

  const roots: { root: string; base: string[] }[] = [
    { root: 'webapp/src', base: [ROOT, '..', 'webapp', 'src'] },
    { root: 'frontend/src/demo', base: [ROOT, 'src', 'demo'] },
  ];

  it('⭐ `aria-hidden` 안에 초점을 받는 것이 없다 — 뿌리마다', () => {
    const offenders: string[] = [];
    let walked = 0;
    for (const { root, base } of roots) {
      const dir = join(...base);
      const files: string[] = [];
      const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const full = join(d, e.name);
          if (e.isDirectory()) walk(full);
          else if (/\.tsx$/.test(e.name)) files.push(full);
        }
      };
      if (!existsSync(dir)) continue;
      walk(dir);
      for (const file of files) {
        const code = codeOf(readFileSync(file, 'utf8'));
        for (const sub of hiddenSubtrees(code)) {
          walked += 1;
          const hit = sub.match(FOCUSABLE);
          if (hit) offenders.push(`${root}/${file.slice(dir.length + 1)} → ${hit[0]}`);
        }
      }
    }
    // ⚠️ **안 보고 있는 상태 자체가 실패여야 합니다** (결함 286).
    ok(walked > 0, 'aria-hidden 이 붙은 자리를 하나도 못 찾았습니다 — 자가 낡았습니다');
    strictEqual(
      offenders.join('\n'),
      '',
      'aria-hidden 안에 키보드로 닿는 것이 있습니다 — 낭독기에는 없다고 해 놓고 손은 닿습니다',
    );
  });

  it('⛔ 근거 칩에 **아무 데도 안 가는** onOpen 을 주지 않는다', () => {
    // `EvidenceChip.tsx` 의 첫 줄이 「칩은 언제나 원문으로 이어져야
    // 합니다 (실패 ③)」입니다. 삽화용 칩은 `EvidenceChipStill` 입니다.
    const offenders: string[] = [];
    for (const { root, base } of roots) {
      const dir = join(...base);
      if (!existsSync(dir)) continue;
      const walk = (d: string): string[] =>
        readdirSync(d, { withFileTypes: true }).flatMap((e) => {
          const full = join(d, e.name);
          return e.isDirectory() ? walk(full) : /\.tsx$/.test(e.name) ? [full] : [];
        });
      for (const file of walk(dir)) {
        const code = codeOf(readFileSync(file, 'utf8'));
        for (const m of code.matchAll(/onOpen=\{\s*\(\s*\)\s*=>\s*\{\s*\}\s*\}/g)) {
          offenders.push(`${root}/${file.slice(dir.length + 1)} → ${m[0]}`);
        }
      }
    }
    strictEqual(offenders.join('\n'), '', '근거 칩이 눌러도 아무 데도 안 갑니다');
  });
});

describe('접는 폭은 읽는 사람의 글자를 따라간다 (결함 338)', () => {
  /**
   * 화면이 「한 줄이 안 들어가면 접는다」를 정하는 breakpoint 는 **`rem`**
   * 이어야 합니다.
   *
   * `px` 로 적으면 **창 폭**만 봅니다. 브라우저 기본 글자를 32px 로 키운
   * 사람은 창이 그대로 1440px 이라 넓은 배치가 유지되는데, 칸 폭은 `rem`
   * 이라 두 배가 됩니다 — 결함 213 이 **좁은 창**에서 고친 무너짐이
   * **넓은 창**에서 그대로 다시 났습니다 (홈의 회의 제목 다섯이 폭 0,
   * 주 단추 다섯이 오른끝 1624 > 1440, `.main` 이 `overflow: hidden` 이라
   * 스크롤로도 못 닿음 — WCAG 1.4.4).
   *
   * ⚠️ **낱말이 아니라 요구를 잽니다.** 「`px` 를 쓰지 마라」가 아니라
   * 「**폭 breakpoint** 가 읽는 사람의 글자를 따라가는가」입니다 —
   * 미디어 쿼리의 `rem` 은 브라우저 기본 글자를 봅니다.
   */
  const cssFiles = (): { rel: string; css: string }[] => {
    const files: { rel: string; css: string }[] = [
      { rel: 'webapp/src/app.css', css: join(ROOT, '..', 'webapp', 'src', 'app.css') },
      { rel: 'frontend/public/app.css', css: join(PUBLIC, 'app.css') },
      { rel: 'frontend/public/tokens.css', css: join(PUBLIC, 'tokens.css') },
    ]
      .filter((f) => existsSync(f.css))
      .map((f) => ({ rel: f.rel, css: readFileSync(f.css, 'utf8') }));
    // 화면의 `<style>` 도 같은 요구를 집니다 — 걷는 자리가 한쪽뿐이면 안 됩니다.
    for (const name of readdirSync(PUBLIC).filter((n) => n.endsWith('.html'))) {
      const inline = readFileSync(join(PUBLIC, name), 'utf8').match(/<style>([\s\S]*?)<\/style>/)?.[1];
      if (inline) files.push({ rel: `frontend/public/${name}`, css: inline });
    }
    return files;
  };

  it('⭐ 폭 breakpoint 가 `px` 가 아니다 — 뿌리마다', () => {
    const offenders: string[] = [];
    let queries = 0;
    for (const { rel, css } of cssFiles()) {
      for (const m of css.matchAll(/@media[^{]*?\((?:min|max)-width:\s*([\d.]+)(px|rem|em)\s*\)/g)) {
        queries += 1;
        if (m[2] === 'px') offenders.push(`${rel} → ${m[0].trim()}`);
      }
    }
    // 안 보고 있는 상태 자체가 실패여야 합니다 (결함 286).
    ok(queries >= 5, `폭 breakpoint 를 ${queries}개밖에 못 찾았습니다 — 자가 낡았습니다`);
    strictEqual(
      offenders.join('\n'),
      '',
      '접는 폭이 `px` 입니다 — 글자를 키운 사람에게는 안 접힙니다 (rem 으로 적으세요)',
    );
  });
});

describe('첫 화면 껍데기 (`webapp/index.html`)', () => {
  const raw = readFileSync(join(ROOT, '..', 'webapp', 'index.html'), 'utf8');
  // ⚠️ **주석을 걷어냅니다.** 이 파일의 주석에는 `role="status"` 같은 낱말이
  //    "왜 그렇게 했는지" 설명으로 적혀 있습니다. 안 걷으면 마크업에서
  //    지워도 가드가 통과합니다 — 심어 보다 실제로 그랬습니다.
  const html = raw.replace(/<!--[\s\S]*?-->/g, ' ');
  const css = readFileSync(join(ROOT, '..', 'webapp', 'src', 'app.css'), 'utf8');

  it('⭐ 껍데기가 실제로 있다 — 첫 방문의 흰 화면을 메우는 자리', () => {
    // 재 봤습니다: 400kbps 에서 캐시를 비우고 열면 **아무것도 없는 흰
    // 화면이 4.4초**였습니다(압축을 켠 뒤에도). 사람은 그걸 "고장" 으로
    // 읽고 새로고침을 누르고, 그러면 처음부터 다시입니다.
    ok(/<div id="boot">/.test(html), '`#boot` 이 없습니다');
    ok(/<style>/.test(html), '스타일이 인라인이 아니면 왕복이 한 번 더 늘어 의미가 없습니다');
  });

  it('⭐ 낭독기에도 무언가 말한다 — 모양은 아무 말도 안 해 준다', () => {
    ok(/role="status"/.test(html), '5초 동안 낭독기에는 아무 일도 안 일어난 것과 같습니다');
  });

  it('⭐ 껍데기 색이 팔레트와 **같은 값**이다', () => {
    // ⚠️ 여기는 `app.css` 가 도착하기 전이라 변수를 쓸 수 없어 hex 를 손으로
    //    적습니다. 그래서 **갈라질 수 있는 자리**입니다 — 팔레트를 고치고
    //    여기를 안 고치면 진짜 화면이 뜨는 순간 바탕이 번쩍입니다.
    const inline = /<style>([\s\S]*?)<\/style>/.exec(raw)?.[1] ?? '';
    const hexes = [...new Set((inline.match(/#[0-9A-Fa-f]{6}/g) ?? []).map((h) => h.toUpperCase()))];
    ok(hexes.length >= 4, `껍데기에서 색을 못 찾았습니다 (${hexes.length}개)`);
    const palette = new Set((css.match(/#[0-9A-Fa-f]{6}/g) ?? []).map((h) => h.toUpperCase()));
    const strangers = hexes.filter((h) => !palette.has(h));
    strictEqual(
      strangers.join(', '),
      '',
      'app.css 에 없는 색입니다 — 팔레트에서 가져오세요 (안 그러면 진짜 화면이 뜰 때 번쩍입니다)',
    );
  });

  it('⭐ 껍데기를 **진짜 화면이 나온 뒤에** 걷는다', () => {
    // ⚠️ "React 가 mount 됐을 때" 걷으면 안 됩니다. 로그인 판별 중에는
    //    `RequireAuth` 가 `null` 을 그리므로 걷어 놓고 **다시 흰 화면**이
    //    됩니다 — 서버가 느릴 때 그 구간이 3.2초였습니다.
    const main = readFileSync(join(ROOT, '..', 'webapp', 'src', 'main.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');
    // ⚠️ **낱말이 아니라 부르는가**를 잽니다. `dropBootShell` 이라는 글자는
    //    함수를 **정의**하기만 해도 파일에 있습니다 — 심어 보고 알았습니다.
    //    호출을 통째로 지웠는데 가드가 조용했습니다.
    ok(
      /^\s*dropBootShell\(\);\s*$/m.test(main),
      '`dropBootShell()` 을 안 부릅니다 — 함수만 있고 껍데기는 안 걷힙니다',
    );
    // ⚠️ 마찬가지로 `childElementCount` 가 파일 어딘가에 있는가가 아니라,
    //    **껍데기를 걷는 자리마다** 그 확인을 지나는가를 봅니다.
    const 걷는곳 = main.split(/boot\.remove\(\)/);
    ok(걷는곳.length >= 2, '껍데기를 걷는 코드가 없습니다');
    걷는곳.slice(0, -1).forEach((앞, i) => {
      ok(
        /childElementCount\s*>\s*0/.test(앞),
        `${i + 1}번째 \`boot.remove()\` 가 \`#root\` 에 자식이 생겼는지 안 보고 걷습니다 — ` +
          '로그인 판별 중에 걷으면 다시 흰 화면입니다(재 보니 3.2초)',
      );
    });
  });
});


describe('둘이 같이 쓸 때 (베타 QA)', () => {
  it('⭐ 창으로 돌아오면 화면이 서버를 다시 읽는다', () => {
    // ⚠️ 여태 `refetchOnWindowFocus: false` 였습니다. 혼자 쓰면 안 보이고
    //    **둘이 쓰면 보입니다** — 브라우저 둘로 재 봤습니다:
    //
    //      A 가 카드를 「완료」로 옮김
    //      → B 의 칸반은 20초가 지나도 그대로. 새로고침해야 바뀝니다.
    //
    //    그 상태에서 B 가 같은 카드를 옮기면 A 의 결정을 조용히 덮고,
    //    이 제품에서 업무 완료는 **기여도로 들어갑니다.**
    const main = readFileSync(join(ROOT, '..', 'webapp', 'src', 'main.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');
    ok(
      /refetchOnWindowFocus:\s*true/.test(main),
      '창으로 돌아와도 옛 화면을 그대로 들고 있습니다 — 둘이 쓰면 서로의 결정을 덮습니다',
    );
  });
});


// ══════════════════════════════════════════════════════════════
// 리디자인에서 조용히 떨어져 나간 판단들 (docs/24 · 결함 204~209)
//
// ⚠️ 전부 **같은 모양**입니다 — 판단은 `lib/` 에 있고, 레거시 화면이
//    부르고 있어서 "아무도 안 쓰는 export" 가드는 통과하는데, 정작
//    사람이 쓰는 SPA 만 안 부르는 것. 결함 197 로 처음 잡았고 그 뒤로
//    여섯 번 더 나왔습니다. 그래서 **부르는지를 화면별로** 못 박습니다.
// ══════════════════════════════════════════════════════════════

describe('SPA 가 lib 의 판단을 실제로 부르는가 (결함 197 계열)', () => {
  const code = (...parts: string[]) =>
    readFileSync(join(ROOT, '..', 'webapp', 'src', ...parts), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');

  it('⭐ 로그아웃이 있고, **상태를 보고 나서** 옮긴다', () => {
    // `/app` 어디에도 로그아웃이 없었습니다. 한 번 들어오면 나갈 길도,
    // 다른 계정으로 바꿀 길도 없었습니다. 레거시에는 `demo/logout.ts` 가
    // 있었고 판단도 `@lib/auth/session.ts` 에 있었습니다.
    const shell = code('components', 'AppShell.tsx');
    ok(/로그아웃/.test(shell), '`/app` 에 로그아웃이 없습니다 — 들어오면 못 나갑니다');
    ok(
      /logoutOutcome\(/.test(shell),
      '상태를 안 보고 옮기면 세션이 살아 있는데 나간 줄 압니다 (결함 82)',
    );
    ok(/describeLogoutFailure\(/.test(shell), '못 끊었을 때 이유를 말하지 않습니다');
  });

  it('⭐ 프로젝트가 없으면 레일이 **갈 곳 없는 링크**를 만들지 않는다', () => {
    // 갓 가입한 사람의 칸반·기여도·설정이 전부 `/` 를 가리켰습니다.
    // 눌러도 같은 화면에 그대로 — 이 저장소가 결함으로 세는 모양입니다.
    const shell = code('components', 'AppShell.tsx');
    ok(/rail__item--blocked/.test(shell), '갈 곳이 없을 때 표시가 없습니다');
    ok(
      /aria-disabled="true"/.test(shell),
      '링크를 지우면 "고장 났다" 로 읽힙니다 — 두고 이유를 다세요',
    );
  });

  it('⭐ 팀원 화면이 권한 3단계를 그린다 (`PROJECT-003`·`PROJECT-004`)', () => {
    const settings = code('screens', 'Settings.tsx');
    /* ⚠️ 예전에는 `canChangeRoleOf`·`assignableRoles` 를 셌습니다. 결함
       362 에서 그 둘을 `roleChoicesFor` 하나로 접었습니다 — **요구는 안
       바뀌었고 자가 낡은 것**입니다(결함 335 와 같은 부류). 지금 화면이
       부르는 이름으로 셉니다. */
    for (const fn of ['roleLabel', 'roleChoicesFor', 'canRemove']) {
      ok(new RegExp(`${fn}\\(`).test(settings), `\`${fn}\` 을 안 부릅니다 — 등급을 다룰 수 없습니다`);
    }
    // ⚠️ **부르는가가 아니라 그리는가**를 봅니다. `roleLabel` 은
    //    `<option>` 목록에서도 불리므로, 이름 옆 등급 표시를 통째로
    //    지워도 낱말은 파일에 남습니다 — 심어 보고 알았습니다.
    ok(
      /member-row__rank/.test(settings),
      '이름 옆에 등급을 안 적습니다 — 누가 소유자인지 화면에서 알 수 없습니다',
    );
    ok(
      /leaveBlockedBecause\(/.test(settings),
      '나가기가 막히는 이유를 **누르기 전에** 말해야 합니다 — 안 그러면 서버 409 로만 압니다',
    );
  });

  it('⭐ 지우기 결과 문구를 화면이 짓지 않는다 — `describeOutcome` 이 짓는다', () => {
    // 화면이 직접 찍던 시절, 0건에도 "원본 0건 · 성문 0건을 지웠습니다"
    // 였습니다. 개인정보보호법 제36조 삭제 요청의 결과 보고입니다.
    const settings = code('screens', 'Settings.tsx');
    ok(/describeOutcome\(/.test(settings), '`describeOutcome` 을 안 부릅니다');
    ok(
      !/건을 지웠습니다/.test(settings),
      '결과 문구를 화면에서 짓고 있습니다 — 0건과 성공이 같은 말이 됩니다',
    );
  });

  it('⭐ `RevokeResult` 를 두 벌로 선언하지 않는다', () => {
    // 두 벌이던 시절 SPA 복사본이 서버의 `message` 칸을 빠뜨렸습니다.
    const types = code('api', 'types.ts');
    ok(
      !/interface RevokeResult/.test(types),
      '`@lib/privacy/deletion.ts` 의 것을 다시 내보내세요 — 두 벌은 반드시 갈라집니다',
    );
  });

  it('⭐ 칸반이 붙은 PR 을 **개수 말고** 보여 준다', () => {
    const kanban = code('screens', 'Kanban.tsx');
    ok(/describePull\(/.test(kanban), '어느 PR 인지 못 봅니다 — 숫자 하나로 줄어듭니다');
    ok(
      /sortLinks\(/.test(kanban),
      '확정을 위로 올려야 합니다 — 추정이 위에 있으면 그게 사실로 보입니다',
    );
  });

  it('⭐ 칸반 머리말이 **못 받은 것을 0 이라고 단언하지 않는다**', () => {
    // `board.data?.tasks ?? []` 때문에 불러오는 중에도 못 받았을 때도
    // `회의에서 0 · PR 연결 0 · 지연 0` 이었습니다. 바로 아래 사슬은
    // "빈 칸을 0 으로 그리지 않습니다" 라고 적어 두고 `—` 를 그리는데
    // 머리말이 반대로 말하고 있었습니다 (불변식 셋째).
    const kanban = code('screens', 'Kanban.tsx');
    ok(/countText\(/.test(kanban), '머리말이 숫자를 날것으로 찍습니다');
    // ⚠️ `countText` 가 파일에 있는가로는 부족합니다 — 셋 중 하나만
    //    되돌려도 낱말이 남습니다(심어 보고 알았습니다). **날것으로 찍는
    //    자리가 없는가**를 봅니다.
    const raw = kanban.match(/\{s\.(fromMeetings|withPulls|overdue)\}/g) ?? [];
    strictEqual(raw.join(', '), '', '머리말이 세어 둔 값을 그대로 찍습니다');
    ok(
      /board\.data !== undefined/.test(kanban),
      '아직 못 받았는지를 안 봅니다 — 빈 배열과 「0건」 이 같은 말이 됩니다',
    );
  });

  it('⭐ 못 불러온 것을 **빈 값으로 그리지 않는다** (설정·기여도)', () => {
    // 서버가 **404** 를 준 프로젝트에서 설정 화면이 멀쩡히 그려지며
    // 「팀원 0명」 이라고 단언했습니다. 없는 프로젝트와 빈 팀을 사람이
    // 구별할 수 없었습니다. 기여도는 무슨 일이 있었든 "네트워크를 확인한
    // 뒤 새로고침하세요" 라고 했고요 — 네트워크는 멀쩡한데.
    const settings = code('screens', 'Settings.tsx');
    ok(/describeLoadFailure\(/.test(settings), '설정이 실패 사유를 안 가립니다');
    // ⚠️ **한 구역이라도 새면 안 됩니다.** "어딘가에 `cannotLoad` 가
    //    있는가" 로 재면 구역 하나만 되돌려도 통과합니다 — 심어 보고
    //    알았습니다. 그리는 자리를 **전부** 셉니다.
    //
    //    `general` 만 예외입니다. 그 구역은 `project.data &&` 로 이미
    //    막혀 있어(데이터가 없으면 아예 안 그림) 두 번 막을 필요가
    //    없습니다.
    const 새는곳 = (settings.match(/\{(?:cannotLoad === null && )?section === '[a-z]+' &&[^\n]*/g) ?? [])
      .filter((line) => !line.includes('cannotLoad === null &&'))
      .filter((line) => !line.includes('project.data'));
    strictEqual(
      새는곳.join('\n'),
      '',
      '못 불러왔는데 그리는 구역이 있습니다 — 빈 값들이 사실처럼 보입니다',
    );
    const contrib = code('screens', 'Contributions.tsx');
    ok(/describeLoadFailure\(/.test(contrib), '기여도가 실패 사유를 안 가립니다');
    ok(
      !/네트워크를 확인한 뒤 새로고침/.test(contrib),
      '무슨 일이 있었든 네트워크 탓을 하고 있습니다',
    );
  });

  it('⭐ 검토 화면이 관찰의 **사유와 근거**를 그린다', () => {
    // "근거 없는 지적은 반박할 수 없고, 반박할 수 없으면 잔소리입니다"
    // (`lib/review/findings.ts` 머리말).
    const review = code('screens', 'Review.tsx');
    // ⚠️ 여기도 **그리는가**입니다. `{false && (…)}` 로 막아도 낱말은
    //    남습니다 — 심어 보고 알았습니다.
    ok(/\{row\.view\.why !== null && \(/.test(review), '왜 걸렸는지를 안 그립니다');
    /* ⚠️ 처음에는 `row.view.evidence.map(` 이라는 **글자 그대로**를
       요구했습니다. 칩을 접는 컴포넌트로 옮기자(UI 패스 v3) 요구는
       그대로인데 가드만 실패했습니다 — 결함 220 의 가드와 같은 실수입니다.
       요구는 「근거 id 가 **칩으로 그려진다**」 입니다. */
    const drawsEvidence =
      /row\.view\.evidence\.map\(/.test(review) || /ids=\{row\.view\.evidence\}/.test(review);
    ok(
      /\{row\.view\.evidence\.length > 0 && \(/.test(review) &&
        drawsEvidence &&
        /<EvidenceChip\b/.test(review),
      '어느 발화가 근거인지 못 봅니다 — 근거 없는 지적은 반박할 수 없습니다',
    );
  });
});

// ══════════════════════════════════════════════════════════════
// 베타 체험 QA — 창을 반으로 줄였을 때 (docs/24)
// ══════════════════════════════════════════════════════════════

describe('좁은 폭에서 홈의 회의 줄 (`.mrow`)', () => {
  const css = readFileSync(join(ROOT, '..', 'webapp', 'src', 'app.css'), 'utf8');

  /**
   * `@media (…) { … }` 를 **전부** 뜯는다.
   *
   * ⚠️ 이 저장소의 CSS 가드가 **첫 미디어 쿼리만 보고** 통과한 적이
   *    있습니다(AGENTS.md). 정규식으로 `@media[^}]*}` 를 잡으면 중첩
   *    중괄호에서 끊깁니다 — 중괄호를 세서 짝을 찾습니다.
   */
  function mediaBlocks(source: string): { cond: string; body: string }[] {
    const out: { cond: string; body: string }[] = [];
    let at = source.indexOf('@media');
    while (at !== -1) {
      const open = source.indexOf('{', at);
      if (open === -1) break;
      let depth = 0;
      let i = open;
      for (; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      out.push({ cond: source.slice(at + 6, open).trim(), body: source.slice(open + 1, i) });
      at = source.indexOf('@media', i);
    }
    return out;
  }

  /** 선택자 하나의 선언부. 없으면 `null`. */
  function ruleFor(source: string, selector: string): string | null {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?:^|[,}])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(source);
    return m === null ? null : m[1] ?? null;
  }

  /**
   * `grid-template-columns` 에서 **못 박힌 폭의 합**(rem).
   *
   * `minmax(0, 1fr)` · `auto` · `1fr` 은 줄어들 수 있으므로 0 입니다.
   * 이 합이 창보다 크면 남은 칸이 0 이 되고, 그다음에는 내용이 화면
   * 밖으로 나갑니다.
   */
  function fixedRem(decls: string): number {
    const value = /grid-template-columns\s*:\s*([^;]+)/.exec(decls)?.[1] ?? '';
    let total = 0;
    for (const m of value.matchAll(/(\d+(?:\.\d+)?)(rem|px)\b/g)) {
      total += Number(m[1]) / (m[2] === 'px' ? 16 : 1);
    }
    return total;
  }

  it('⭐ 좁아지면 한 줄을 접는다 — 제목이 0px 이 되고 버튼이 화면 밖으로 나갔다 (결함 213)', () => {
    // 재서 확인한 것(1280px→800px→400px, 실제 브라우저):
    //
    //     [1280px] 제목폭 416 · 액션 화면밖 0개
    //     [ 800px] 제목폭   8 · 액션 화면밖 0개
    //     [ 400px] 제목폭   0 · 액션 화면밖 **5개** · 행 넘침 392px
    //
    // 400px 에서 버튼 오른쪽 끝이 776px 이었습니다. `.main` 이
    // `overflow: hidden` 이라 스크롤도 안 됩니다 — 「업무 후보 검토」를
    // 누를 방법이 **아예 없었습니다.** 결함 186 과 같은 종류입니다.
    const base = ruleFor(css, '.mrow');
    ok(base !== null, 'app.css 에 `.mrow` 규칙이 없습니다');

    const narrow = mediaBlocks(css)
      .filter((b) => /max-width/.test(b.cond))
      .map((b) => ({ cond: b.cond, decls: ruleFor(b.body, '.mrow') }))
      .filter((b): b is { cond: string; decls: string } => b.decls !== null)
      .filter((b) => /grid-template-columns/.test(b.decls));
    ok(
      narrow.length > 0,
      '좁은 폭에서 `.mrow` 의 칸 배치를 다시 정하는 곳이 없습니다 — ' +
        `고정 폭 ${fixedRem(base as string)}rem 이 그대로 남아 제목 칸이 0 이 됩니다`,
    );

    // 320px = 20rem 까지 살아야 합니다 (WCAG 1.4.10). 상태 칩·버튼이
    // 들어갈 자리를 빼면 못 박힌 폭은 **12rem 아래**여야 합니다.
    for (const { cond, decls } of narrow) {
      ok(
        fixedRem(decls) <= 12,
        `${cond} 안의 \`.mrow\` 가 아직 ${fixedRem(decls)}rem 을 못 박고 있습니다`,
      );
    }
  });

  it('⚠️ 칸 이름을 쓰면 **여섯 칸 전부** 자리를 준다 — 하나만 빠져도 딴 줄로 튄다', () => {
    // `grid-template-areas` 를 쓰면서 자식에게 `grid-area` 를 안 주면
    // 그 자식은 **자동 배치**돼 아무 빈칸에나 들어갑니다. 리본 하나가
    // 제목 자리로 올라가면 줄이 통째로 어긋납니다.
    for (const { cond, body } of mediaBlocks(css).filter((b) => /max-width/.test(b.cond))) {
      const decls = ruleFor(body, '.mrow');
      if (decls === null || !/grid-template-areas/.test(decls)) continue;
      const 빠진것 = ['status', 'title', 'date', 'ribbon', 'cov', 'action'].filter(
        (part) => !new RegExp(`\\.mrow__${part}\\s*\\{[^}]*grid-area`).test(body),
      );
      strictEqual(빠진것.join(', '), '', `${cond} 안에서 자리를 못 받은 칸이 있습니다`);
    }
  });
});

describe('로비가 회의 국면을 본다 (결함 214)', () => {
  const code = (...parts: string[]) =>
    readFileSync(join(ROOT, '..', 'webapp', 'src', ...parts), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');
  const lobby = code('screens', 'Lobby.tsx');

  it('⭐ 끝난 회의에서 「녹음 화면으로」가 막힌다', () => {
    // 재서 확인한 것 — 다섯 상태에서 화면이 **글자까지 같았습니다.**
    // 검토까지 끝난 회의(`needs_review`)에서 이 버튼이 멀쩡히 눌렸습니다.
    //
    // ⚠️ `lobbyPhase(` 라는 낱말이 있는가로 재면 `import` 줄 하나로
    //    통과합니다. **막는 값이 실제로 섞이는가**를 봅니다.
    ok(/lobbyPhase\(meeting\.data\?\.status\)/.test(lobby), '회의 상태를 국면 판단에 안 넘깁니다');
    const gate = /const canGoRecord\s*=\s*([^;]+);/.exec(lobby)?.[1] ?? '';
    ok(gate !== '', '`canGoRecord` 가 없습니다');
    ok(
      /phase\.canStart/.test(gate),
      `「녹음 화면으로」가 동의 조건만 봅니다 (\`${gate.trim()}\`) — 끝난 회의도 눌립니다`,
    );
  });

  it('⭐ 홈이 보낸 말을 **그려서** 이어받는다 — 계산만 하면 화면에는 없다', () => {
    // 홈: "처리에 실패했습니다 — 트랙이 온전한지 확인하세요"
    // → 도착 화면에 「실패」라는 낱말이 **한 번도** 없었습니다.
    ok(
      /\{phase\.note !== null && \(/.test(lobby),
      '국면 설명을 그리는 자리가 없습니다',
    );
    ok(/id="phase-note"/.test(lobby), '막힌 버튼이 가리킬 `id` 가 없습니다');
    // 막았으면 **왜 막혔는지** 낭독기도 들어야 합니다 (AGENTS.md 「아직 안 됨」).
    ok(
      /aria-describedby=\{[^}]*phase\.canStart \? 'start-conds' : 'phase-note'/.test(lobby),
      '막힌 이유가 국면일 때 가리키는 곳이 여전히 조건 칩입니다',
    );
  });

  it('⭐ 끝난 회의에는 「시작 전 확인」을 안 그린다 — 지나간 일을 준비하라는 말이었다', () => {
    ok(
      /\{phase\.canStart && room\.recording === 0/.test(lobby),
      '끝난 회의에도 「시작 전 확인」이 뜹니다',
    );
  });

  it('⚠️ 상태 낱말 표가 화면이 아니라 `@lib` 에 있다 — 화면 코드에는 자동 테스트가 없다', () => {
    // `Lobby.tsx` 안에 `VERDICT_WORD` 상수로 있었습니다. 그래서 "끝난
    // 회의의 `not_joined` 는 「대기」가 아니다" 라는 판단을 넣을 자리가
    // 검증 밖이었습니다.
    ok(!/VERDICT_WORD/.test(lobby), '낱말 표가 아직 화면에 있습니다');
    ok(
      /verdictView\(status, phase\.canStart\)/.test(lobby),
      '국면을 안 넘기면 끝난 회의에서도 「대기」라고 씁니다 — 아무도 안 기다리는데',
    );
  });

  it('⚠️ 머리줄이 아래 설명과 **반대되는 말**을 하지 않는다', () => {
    // 실패한 회의에서 머리줄은 「아직 아무도 참가하지 않았습니다」였습니다.
    // 「아직」 은 곧 들어온다는 뜻입니다.
    const meta = /meta=\{([\s\S]*?)\n      \}/.exec(lobby)?.[1] ?? '';
    ok(
      /phase\.canStart/.test(meta) && /describeMeetingStatus\(/.test(meta),
      `머리줄이 국면과 무관하게 방 상태만 말합니다 (\`${meta.trim().slice(0, 60)}\`)`,
    );
  });
});

describe('카드 표면이 경고 종류를 **가른다** (결함 319)', () => {
  /* ⚠️ 마감을 과거로 옮겨 재서 잡았습니다. 「접근성 점검」은 담당자가
     **둘**이고 경고가 「마감일(2026-08-10)이 지났습니다」 하나뿐인데,
     카드 표면은 **「기여도에 반영 안 됨」**이었습니다 — 거짓입니다.
     늦게 끝낸 업무도 `TASK_COMPLETED`(10점)를 그대로 받고, 늦음이 바꾸는
     것은 일정 준수 범주뿐입니다(`task_service`). SPA 는 처음부터 「지남」
     뱃지를 따로 답니다 — 301·308·309·313·316 에 이은 여섯 번째입니다. */
  const legacy = readFileSync(join(DEMO, 'kanban.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  it('⛔ 「경고가 있으면 무조건 기여도에 반영 안 됨」으로 그리지 않는다', () => {
    ok(
      !/warnings\.length\s*>\s*0\s*&&[\s\S]{0,80}반영 안 됨/.test(legacy),
      '경고 종류를 안 보고 한 문장으로 뭉갭니다 — 늦은 업무에도 그 말이 붙습니다',
    );
  });

  it('⭐ 표면 문구가 `@lib` 의 `cardMarks` 에서 온다', () => {
    ok(/cardMarks\(task, today\)/.test(legacy), '`cardMarks` 를 안 부릅니다');
  });

  it('⛔ 「기여도에 반영 안 됨」을 화면에 **글자로 박아 두지** 않는다', () => {
    strictEqual(
      /['"`][^'"`]*반영 안 됨[^'"`]*['"`]/.exec(legacy)?.[0] ?? null,
      null,
      '표면 문구가 화면에 박혀 있습니다 — `@lib` 를 고쳐도 그 글자가 나갑니다',
    );
  });

  it('⚠️ 늦음 표는 **결측 표시와 다르게** 그린다', () => {
    /* `.gapmark` 의 점은 「못 잰 자리」의 표시라고 그 규칙 옆에 적혀
       있습니다. 같은 모양으로 그리면 마감 지남이 결측으로 읽힙니다. */
    const css = readFileSync(join(ROOT, 'public', 'kanban.html'), 'utf8');
    ok(/\.latemark[^{]*\{[^}]*\}/.test(css), '`.latemark` 규칙이 없습니다');
    ok(
      /\.latemark::before[^{]*\{[^}]*content:\s*none/.test(css),
      '늦음 표에 결측 점이 그대로 붙어 있습니다',
    );
  });
});

describe('레거시 설정 화면도 **관리 권한을 본다** (결함 316)', () => {
  /* ⚠️ 소유자가 아닌 사람(초대 코드로 막 들어온 최소라)으로 꽉 찬
     프로젝트를 걸어 보고 잡았습니다 —

         「코드 새로 만들기」  disabled=false · aria-disabled 없음
         눌렀더니             403 {"detail":"이 작업을 할 권한이 없습니다"}
         화면이 한 말          「코드를 새로 만들지 못했습니다 (HTTP 403)」

     `manageBlockedBecause` 는 `@lib` 에 **이미 있었고**, 그 주석이 예로
     드는 것이 바로 이 단추입니다. SPA 는 셋 다 부르는데 레거시는 0번
     불렀습니다 — 301·308·309·313 에 이은 다섯 번째입니다. */
  const project = readFileSync(join(DEMO, 'project.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  it('⭐ 관리 단추 셋이 **모두** 판단을 거친다 — 하나만 빠져도 그 문이 열린다', () => {
    for (const [what, id] of [
      ['초대 코드 새로 만들기', 'rotate'],
      ['프로젝트 이름 바꾸기', 'save-title'],
      ['저장소 연결', 'save-repo'],
    ]) {
      ok(
        new RegExp(`manageBlockedBecause\\(\\s*myRole\\s*,\\s*'${what}'`).test(project),
        `\`${id}\` 가 \`manageBlockedBecause(myRole, '${what}')\` 를 안 거칩니다`,
      );
    }
  });

  it('⭐ 막힌 단추는 `aria-disabled` 이고 **사유를 가리킨다** (결함 234·239)', () => {
    for (const id of ['rotate', 'save-title', 'save-repo']) {
      const btn = new RegExp(`id="${id}"([\\s\\S]{0,400}?)</button>`).exec(project)?.[1] ?? '';
      ok(btn !== '', `\`#${id}\` 단추를 못 찾았습니다`);
      ok(/aria-disabled=/.test(btn), `\`#${id}\` 가 \`aria-disabled\` 를 안 씁니다`);
      ok(/aria-describedby=/.test(btn), `\`#${id}\` 가 사유를 안 가리킵니다`);
    }
  });

  it('⛔ 가리킨 사유가 **실제로 그려진다** — 가리키기만 하면 빈 곳을 읽습니다', () => {
    for (const id of ['rotate-why', 'title-why', 'repo-why']) {
      ok(new RegExp(`id="${id}"`).test(project), `\`#${id}\` 를 가리키는데 그리는 곳이 없습니다`);
    }
  });

  it('⚠️ `myRole` 이 **「아직 모름」을 살린다** — `?? null` 로 뭉개지 않는다 (결함 254)', () => {
    // 명단이 아직 안 왔을 때 `null` 이면 소유자에게도 「관리자에게
    // 요청하세요」라고 말합니다. 그 둘은 다른 상태입니다.
    const line = /const myRole = ([^;]+);/.exec(project)?.[1] ?? '';
    ok(line !== '', '`myRole` 을 못 찾았습니다');
    ok(!/\?\?\s*null/.test(line), `\`myRole = ${line.trim()}\` — 「아직 모름」이 「없음」으로 뭉개집니다`);
  });
});

describe('**보낸 뒤** 실패에서 서버 문장을 버리지 않는다 (결함 316)', () => {
  /* ⚠️ **결함 301 의 가드는 이걸 못 봤습니다.** 그 가드는
     `describeHttpStatus(response.status)` 라는 **낱말**을 막습니다.
     그런데 요구를 어기는 **다른 길**이 열려 있었습니다 — 화면이
     `HTTP ${'${status}'}` 를 문장에 **직접 박는** 것입니다. 여섯 곳이
     그 모양이었고, 그중 하나가 최소라에게 「HTTP 403」을 보여 줬습니다.

     결함 295 가 적어 둔 그것입니다 — 「가드를 쓸 때는 「이 요구를 어기는
     다른 길이 있나」를 같이 세십시오. 낱말 하나를 막는 것은 요구를 재는
     것이 아닙니다」. */
  const SENDING = /method:\s*'(POST|PATCH|PUT|DELETE)'|send\(|sendJson\(/;

  it('⭐ 보내고 실패한 자리는 `detailText` 를 거친다', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (SCREEN_EXT.test(entry.name) && !entry.name.includes('.test.')) {
          const code = codeOf(readFileSync(full, 'utf8'));
          for (const m of code.matchAll(/HTTP \$\{[^}]+\}/g)) {
            const at = m.index ?? 0;
            const around = code.slice(Math.max(0, at - 700), at + 80);
            if (/detailText\(/.test(around)) continue;
            /* 불러오기 실패는 서버 문장이 아니라 **다시 불러오기**가
               답입니다 (결함 301 이 적어 둔 예외). 보낸 자리만 잽니다. */
            if (!SENDING.test(around)) continue;
            offenders.push(`${entry.name}: …${code.slice(at - 40, at + 30).replace(/\s+/g, ' ')}`);
          }
        }
      }
    };
    walk(DEMO);
    strictEqual(
      offenders.join('\n    '),
      '',
      `보낸 뒤 실패에서 서버가 쓴 문장을 버립니다 — \`detailText\` 를 거치세요`,
    );
  });
});

describe('빈 상자 껍질이 격자를 **가로지른다** (결함 313)', () => {
  /* ⚠️ **짝입니다.** 한쪽만 남으면 조용히 되돌아갑니다 —
     클래스만 남으면 규칙이 없어 다시 한 칸에 갇히고, 규칙만 남으면
     붙일 곳이 없습니다.

     재서 확인한 것 (1440×900, 갓 만든 프로젝트):

         고치기 전  .empty-state 241px · .why 199px · 한글 열넷씩 일곱 줄
         고친 뒤    .empty-state 1024px · .why 544px

     `.empty-state` 의 `grid-column: 1 / -1` 은 **껍질이 아니라 안쪽
     상자**에 붙어 있어서, `RawHtml` 이 만든 껍질이 격자 항목으로
     들어가는 순간 닿지 않았습니다. 저장소가 스켈레톤에서 이미
     `.sk-wrap { display: contents }` 로 푼 문제입니다 (실패 ②). */
  const parts = readFileSync(join(DEMO, 'parts.tsx'), 'utf8');
  const css = readFileSync(join(ROOT, 'public', 'app.css'), 'utf8');

  it('⭐ `RawHtml` 껍질에 이름이 붙어 있다', () => {
    const wrap = /return <div className="([\w-]+)" ref=\{ref\}/.exec(parts)?.[1] ?? null;
    strictEqual(wrap, 'raw-wrap', '`RawHtml` 껍질에 `raw-wrap` 이 없습니다');
  });

  it('⭐ 그 이름이 격자에서 **사라진다** — `display: contents`', () => {
    const rule = /\.raw-wrap\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    ok(rule !== '', '`.raw-wrap` 규칙이 없습니다 — 껍질이 한 칸을 먹습니다');
    ok(
      /display:\s*contents/.test(rule),
      `\`.raw-wrap { ${rule.trim()} }\` — 껍질이 아직 격자 항목입니다`,
    );
  });

  it('⚠️ 스켈레톤 껍질도 같은 처리를 유지한다 — 같은 문제, 같은 답', () => {
    ok(/\.sk-wrap\s*\{[^}]*display:\s*contents/.test(css), '`.sk-wrap` 처리가 사라졌습니다');
  });
});

describe('칸반 빈 상자가 **없는 길**을 가리키지 않는다 (결함 313)', () => {
  /* ⚠️ 이번 것은 결함 312 보다 나쁜 쪽입니다. 312 는 「아직 없는 곳」을
     가리켰지만, 이것은 **제품이 일부러 막아 둔 것**을 하라고 시켰습니다 —
     업무를 만드는 코드는 `approval_service.py` 한 곳이고 그 옆에
     「승인 없이 tasks 에 쓰는 경로는 없다 — 그게 불변식이다」라고 적혀
     있습니다. SPA 는 처음부터 맞게 적고 있었고 레거시만 갈라졌습니다
     (301·308·309 에 이은 네 번째). 그래서 **두 뿌리 다** 걷습니다. */
  const strip = (code: string) =>
    code
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');
  const ROOTS: Array<[string, string]> = [
    ['레거시', strip(readFileSync(join(DEMO, 'kanban.tsx'), 'utf8'))],
    [
      'SPA',
      strip(readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Kanban.tsx'), 'utf8')),
    ],
  ];

  it('⛔ 「직접 만든/만들」 업무를 어느 화면도 말하지 않는다 — 빈 상자 **밖**도', () => {
    /* ⚠️ 처음엔 빈 상자만 고치고 **머리줄을 놓칠 뻔했습니다** —
       「회의에서 승인된 업무와 **직접 만든 업무**가 단계별로 놓입니다」.
       그 줄은 비어 있지 않을 때도 늘 보이니 더 자주 읽힙니다. 렌더해서
       눈으로 잡았습니다. 그래서 자를 파일 **전체**로 넓혔습니다. */
    for (const [name, code] of ROOTS) {
      /* ⚠️ **자를 두 번 넓혔습니다.** 처음엔 `직접 만들 수` 였고 머리줄의
         「직접 만**든**」을 놓쳤습니다(313). 넓힌 뒤에도 카드 서랍의
         「**손으로** 만든 업무입니다」를 놓쳤습니다(317) — 같은 파일
         안이었습니다. 낱말이 아니라 **뜻**을 막습니다. */
      const 걸린것 = /[^\n]*(직접|손으로|수동으로)\s*만[든들][^\n]*/.exec(code)?.[0]?.trim() ?? null;
      strictEqual(걸린것, null, `${name}: 이 제품에 없는 길을 가리킵니다 — ${걸린것}`);
    }
  });

  it('⭐ 빈 상자 문장이 **`@lib` 한 벌**에서 온다 — 두 화면이 갈라졌던 자리다', () => {
    ok(/emptyBoard\(\)/.test(ROOTS[0]![1]!), '레거시가 `emptyBoard` 를 안 씁니다');
    ok(/emptyBoardLine\(\)/.test(ROOTS[1]![1]!), 'SPA 가 `emptyBoardLine` 을 안 씁니다');
  });

  it('⛔ 업무가 어디서 오는지를 화면에 **글자로 박아 두지** 않는다', () => {
    // 박아 두면 `@lib` 를 고쳐도 그 글자가 그대로 나갑니다 (실패 ②).
    for (const [name, code] of ROOTS) {
      const 박힌것 = /['"`][^'"`]*업무 후보를 뽑고[^'"`]*['"`]/.exec(code)?.[0] ?? null;
      strictEqual(박힌것, null, `${name}: 빈 상자 문장이 화면에 박혀 있습니다`);
    }
  });
});

describe('사람 목록은 이름표를 @lib 에서 받는다 (결함 345)', () => {
  /*
   * 이 제품은 사람을 **이름으로** 부릅니다(결함 293·297). 그런데 이름은
   * 유일하지 않습니다 — 팀에 같은 이름이 둘이면 설정 화면에 되돌릴 수
   * 없는 「내보내기」 단추가 **글자까지 같은 줄** 둘에 붙고, 기여도 확정
   * 칸의 `aria-label` 도 「이하늘 확정값」으로 같아집니다.
   *
   * 재현: 팀원 둘의 이름을 같게 만들고 열었습니다.
   *
   *     설정   이하늘 | 팀원 ▾ | 내보내기
   *            이하늘 | 팀원 ▾ | 내보내기
   *     찾기   담당자: 누구든 / 김민수 / 이하늘 / 이하늘
   *
   * 손잡이는 이미 있습니다 — `github_login` 은 프로젝트 안에서 **유일**
   * 하도록 서버가 지키고(설정 화면이 그 이유를 적어 뒀습니다), 팀원
   * 목록에 실려 옵니다. 화면이 이미 쥐고 있는 것입니다(결함 294).
   *
   * ⚠️ **뿌리마다 따로 셉니다.** 「한쪽만 고쳐진다」가 이 저장소의 대표
   * 재발입니다(231·306·320·321·333·334·335·337).
   */
  const ROOTS: Array<[string, string]> = [
    ['레거시', DEMO],
    ['SPA', join(ROOT, '..', 'webapp', 'src', 'screens')],
  ];

  /**
   * 예외 — **왜 예외인가**를 같이 적습니다. 예외가 낡는 것도 재야 하므로
   * (결함 306), 아래에 그 근거를 확인하는 검사를 둡니다.
   */
  const EXEMPT: Record<string, string> = {
    'reports.tsx':
      '보고서의 `Person` 은 서버가 만든 **기록**입니다. `reports.body` 에 저장된 ' +
      '글자를 그대로 그리므로 이름표는 서버가 붙입니다 — 화면에서 붙이면 저장된 ' +
      '기록과 사람이 읽는 글이 갈라집니다. 파이썬 쪽은 `people/labels.py`.',
  };

  /** 목록을 돌며 사람 이름을 **그대로** 그리는 자리. */
  const BARE = /\{\s*(?:member|person|people\[\w+\]|m)\.name\s*\}|label:\s*\w+\.name\b/;

  for (const [rootName, dir] of ROOTS) {
    it(`⭐ ${rootName} — 사람 이름을 목록에서 **맨몸으로** 그리지 않는다`, () => {
      const guilty: string[] = [];
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.tsx'))) {
        if (EXEMPT[file] !== undefined) continue;
        const code = codeOf(readFileSync(join(dir, file), 'utf8'));
        if (BARE.test(code)) guilty.push(file);
      }
      deepStrictEqual(
        guilty,
        [],
        `${rootName}: 목록의 사람 이름을 그대로 그립니다 — 같은 이름이 둘이면 ` +
          '두 줄이 똑같아집니다. `@lib/people/labels.ts` 의 `labelInList` 를 쓰세요',
      );
    });

    it(`⭐ ${rootName} — 이름표를 @lib 에서 받는 파일이 **있다**`, () => {
      /* 위 검사는 「없는가」만 봅니다. 화면이 이름을 아예 안 그리게 되면
         그것도 통과하므로, 부르는 곳을 **세어서** 같이 봅니다(결함 306). */
      let callers = 0;
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.tsx'))) {
        if (/labelInList\(/.test(readFileSync(join(dir, file), 'utf8'))) callers += 1;
      }
      ok(callers > 0, `${rootName} 에서 labelInList 를 부르는 화면이 0개입니다`);
    });
  }

  it('⭐ 예외가 낡지 않았는가 — 서버가 정말 이름표를 붙이는가', () => {
    /* 「예외입니다」라고 적어 두고 서버가 안 붙이면, 그 화면만 조용히
       옛날로 돌아갑니다 (결함 306 이 적어 둔 그것). 파이썬 쪽이 실제로
       `label_in_list` 를 거치는지 셉니다. */
    const service = readFileSync(
      join(ROOT, '..', 'backend', 'teamflow', 'services', 'report_service.py'),
      'utf8',
    );
    ok(
      /label_in_list\(/.test(service),
      'reports.tsx 를 예외로 뒀는데 서버(report_service.py)가 이름표를 안 붙입니다',
    );
    ok(
      Object.keys(EXEMPT).length === 1,
      '예외가 늘었습니다 — 하나씩 근거를 확인하고 이 검사도 넓히세요',
    );
  });

  it('⭐ 못 가르는 줄에는 **그 사실을 적는다** — 두 뿌리 다', () => {
    /* 둘 다 GitHub 미연결이면 이름표를 붙여도 두 줄이 똑같습니다.
       「구분됩니다」인 척하면 사람이 되돌릴 수 없는 단추를 찍습니다. */
    for (const [rootName, dir] of ROOTS) {
      const files = readdirSync(dir).filter((f) => f.endsWith('.tsx'));
      const said = files.some((f) =>
        /cannotTellApartNote\(\)/.test(readFileSync(join(dir, f), 'utf8')),
      );
      ok(said, `${rootName} 에서 못 가른다는 사실을 말하는 화면이 0개입니다`);
    }
  });
});

describe('팀 전체를 잰 것은 사람 이름 밑에서도 범위를 말한다 (결함 344)', () => {
  const reports = readFileSync(join(DEMO, 'reports.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  const view = codeOf(readFileSync(join(LIB, 'reports', 'view.ts'), 'utf8'));

  /*
   * 서버는 `compute_confidence` 를 **팀당 한 번** 부릅니다 — 세 사람의
   * `confidence` 와 `confidence_reasons` 가 글자 하나까지 같습니다. 그런데
   * 보고서는 그것을 사람 이름 밑에 그립니다.
   *
   * 재현: 커버리지 1.0 · 회의 근거 6건인 김민수의 항목이 「신뢰도 47%
   * (낮음)」과 「녹음이 끊긴 트랙이 있습니다 — 해당 팀원의 발언량은 측정할
   * 수 없습니다」를 이고 있었습니다. 끊긴 트랙의 주인은 다른 사람입니다.
   *
   * 두 화면은 이미 범위를 적고 있었습니다(레거시 「팀 신뢰도」 · SPA
   * 「팀 전체」). **보고서만** 안 적었고, 그게 팀 밖으로 나가는 문서입니다.
   */
  it('⭐ 신뢰도 한 줄이 **누구의 것인지** 말한다', () => {
    const body = /export function describeConfidence[\s\S]*?\n}/.exec(view)?.[0] ?? '';
    ok(body !== '', 'reports/view.ts 에 describeConfidence 가 없습니다 — 이 검사도 고치세요');
    ok(
      /['\`][^'\`]*팀[^'\`]*신뢰도/.test(body),
      '보고서의 신뢰도 줄이 범위를 안 말합니다 — 이 값은 팀 하나를 잰 것인데 ' +
        '사람 이름 밑에 그려집니다',
    );
  });

  it('⭐ 팀 공통 사유 목록에 **머리말**을 붙인다 — 만들어만 두지 않는다', () => {
    /* `@lib` 에 이름을 만들어 놓고 화면이 안 부르면 없는 것입니다(실패 ①).
       낱말이 아니라 **부르는가**를 잽니다. */
    ok(
      /export function teamReasonsHeading/.test(view),
      '`teamReasonsHeading` 이 @lib 에 없습니다',
    );
    ok(
      /teamReasonsHeading\(\)/.test(reports),
      '보고서 화면이 `teamReasonsHeading` 을 안 부릅니다 — 사람 이름 밑의 네 줄이 ' +
        '그 사람에 대한 지적으로 읽힙니다',
    );
    /* 글자로 베껴 적으면 두 벌이 되고 반드시 갈라집니다(실패 ②). */
    ok(
      !/['"\`]팀 공통['"\`]/.test(reports),
      '머리말을 화면에 글자로 베껴 적었습니다 — `teamReasonsHeading()` 을 부르세요',
    );
  });

  it('⭐ **옆 갈래도** 이름을 붙인다 — 위만 붙이면 반쪽입니다', () => {
    /* 두 목록은 잇달아 그려집니다. 위에만 「팀 공통」을 달면 아래 줄까지
       그 머리말 아래로 읽힙니다 — 결함 301 이 「한 갈래만 고치고 옆
       갈래를 그대로 둔 것」으로 적어 둔 이 저장소에서 제일 흔한 재발
       모양입니다. 렌더해서 보고 알았습니다. */
    ok(
      /export function personGapsHeading/.test(view),
      '`personGapsHeading` 이 @lib 에 없습니다',
    );
    ok(
      /personGapsHeading\(\)/.test(reports),
      '팀 공통 목록에만 머리말을 붙이고 이 사람만의 목록은 그대로 뒀습니다',
    );
  });
});

describe('보고서 빈 상자가 회의 수를 보고 말한다 (결함 312)', () => {
  const reports = readFileSync(join(DEMO, 'reports.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  it('⛔ 「다음에 뭘」을 화면에 **박아 두지** 않는다', () => {
    /* 갓 만든 프로젝트(회의 0개)에서 이 화면이 「회의 로비에서 회의록을
       만드세요」라고 했습니다 — 갈 로비가 없습니다. 문장이 화면에 상수로
       박혀 있으면 무슨 데이터를 받아 와도 그 글자가 나갑니다 (결함 294). */
    strictEqual(
      /['"`][^'"`]*로비에서 회의록을 만드세요[^'"`]*['"`]/.exec(reports)?.[0] ?? null,
      null,
      '보고서 화면에 「로비에서 회의록을 만드세요」가 글자로 박혀 있습니다',
    );
  });

  it('⭐ 판단(`emptyReports`)을 **회의 수와 함께** 부른다', () => {
    const call = /emptyReports\(\s*([^)]*)\)/.exec(reports)?.[1] ?? '';
    ok(call !== '', '`emptyReports` 를 안 부릅니다 — 만들어 놓고 안 부르면 없는 것입니다');
    ok(/meetingCount/.test(call), `\`emptyReports(${call})\` 가 회의 수를 안 넘깁니다`);
  });

  it('⭐ 그 회의 수를 **실제로 받아 온다** — 상태만 있고 안 채우면 영영 null 이다', () => {
    /* ⚠️ 이게 없으면 `meetingCount` 는 언제나 `null` 이고, `null` 은
       「모른다」라서 회의가 있는 쪽 문장이 나갑니다 — 고치기 **전과 똑같은
       글자**입니다. 실패 ①(만들어 놓고 화면에 안 이음)의 변종입니다. */
    ok(
      /setMeetingCount\(/.test(reports),
      '`meetingCount` 를 채우는 곳이 없습니다',
    );
    ok(
      /\/api\/projects\/\$\{projectId\}\/meetings/.test(reports),
      '회의 목록을 받아 오는 곳이 없습니다',
    );
  });
});

describe('동의 칸도 회의 국면을 본다 — **두 뿌리 다** (결함 310)', () => {
  /* ⚠️ **뿌리마다 겁니다.** 결함 214 가드가 `webapp/src` 만 걸어서 레거시가
     통째로 감시 밖이었던 것이 결함 309 였습니다. 이번 결함은 처음부터
     **양쪽에 다** 있었으니 가드도 양쪽을 걷습니다.

     ⚠️ 그리고 이것은 **결함 251 의 결정을 뒤집지 않습니다.** 서버는 늦은
     동의를 그대로 받습니다(`test_late_consent_is_still_accepted_on_purpose`
     가 붙잡고 있습니다). 여기서 재는 것은 **버튼이 무엇을 누르는 것인지
     말하는가**입니다. */
  const strip = (code: string) =>
    code
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');
  const ROOTS: Array<[string, string]> = [
    ['레거시', strip(readFileSync(join(DEMO, 'lobby.tsx'), 'utf8'))],
    ['SPA', strip(readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Lobby.tsx'), 'utf8'))],
  ];

  it('⭐ 두 화면 다 `consentAffordance` 에 **국면을 넘긴다**', () => {
    /* 재서 확인한 것 — 씨앗을 새로 심고 두 회의를 나란히 놓았습니다.
         회의 2 (pending)           「동의합니다」 btn--primary rgb(61,58,174)
         회의 5 (failed · 트랙 0개)  「동의합니다」 btn--primary rgb(61,58,174)
       레거시·SPA 넷이 전부 같았습니다. */
    for (const [name, code] of ROOTS) {
      const call = /consentAffordance\(\s*([^)]*)\)/.exec(code)?.[1] ?? '';
      ok(call !== '', `${name} 로비가 \`consentAffordance\` 를 안 부릅니다`);
      strictEqual(
        call.split(',').length,
        2,
        `${name}: \`consentAffordance(${call})\` — 국면을 안 넘기면 끝난 회의도 청록입니다`,
      );
      ok(
        /stillStartable|phase\.canStart/.test(call),
        `${name}: \`consentAffordance(${call})\` 가 국면이 아닌 것을 넘깁니다`,
      );
    }
  });

  it('⭐ 청록 여부와 글자를 **둘 다** 판단에서 받는다 — 하나만 받으면 절반만 고쳐진다', () => {
    for (const [name, code] of ROOTS) {
      ok(/consentAct\.primary/.test(code), `${name}: 청록 여부를 판단에서 안 받습니다`);
      ok(/consentAct\.label/.test(code), `${name}: 동의 단추 글자를 판단에서 안 받습니다`);
      ok(/consentAct\.refuseLabel/.test(code), `${name}: 거부 단추 글자를 판단에서 안 받습니다`);
      ok(/consentAct\.note/.test(code), `${name}: 「무엇을 누르는 것인가」를 안 그립니다`);
    }
  });

  it('⛔ 동의 단추에 글자를 **박아 두지** 않는다 — 판단이 두 벌이 됩니다', () => {
    // 「동의합니다」가 화면 코드에 글자로 남아 있으면 국면과 무관하게
    // 그 글자가 나갈 길이 남습니다. 실패 ②(두 벌이 있으면 한쪽만 고쳐진다).
    for (const [name, code] of ROOTS) {
      const 박힌것 = /['"`]동의합니다['"`]/.exec(code)?.[0] ?? null;
      strictEqual(박힌것, null, `${name}: 동의 단추 글자가 화면에 박혀 있습니다 (${박힌것})`);
    }
  });

  it('⭐ 레거시의 사람별 칸도 국면을 본다 — 「대기 중」은 곧 온다는 뜻이다', () => {
    // 끝난 회의에서 세 사람이 「응답 대기 중」인데 두 줄 아래는
    // 「3명은 응답하지 않은 채였습니다」였습니다 — 한 패널의 자기모순.
    const legacy = ROOTS[0]![1]!;
    const call = /describeConsent\(\s*([^)]*)\)/.exec(legacy)?.[1] ?? '';
    ok(call !== '', '레거시가 `describeConsent` 를 안 부릅니다');
    strictEqual(
      call.split(',').length,
      2,
      `\`describeConsent(${call})\` — 국면을 안 넘기면 끝난 회의도 「대기 중」입니다`,
    );
  });
});

describe('**레거시** 로비도 회의 국면을 본다 (결함 309)', () => {
  /* ⚠️ **결함 214 가드는 `webapp/src` 만 걷고 있었습니다.** SPA 는 국면을
     제대로 보는데, 자동 테스트가 하나도 없는 레거시 화면
     (`frontend/src/demo/lobby.tsx`) 은 감시 밖이었고 실제로 안 보고
     있었습니다 — 홈이 「트랙이 온전한지 확인하세요」로 보낸 그 화면이
     트랙이 0개인 실패한 회의를 두고 「아직 아무도 참가하지 않았습니다」·
     「전원 동의 후 시작할 수 있습니다」라고 적었습니다.

     이 저장소가 반복해서 당한 「한 갈래만 고치고 옆 갈래를 그대로 둔 것」
     의 세 번째 회차입니다 (결함 301 · 308 · 309). 그래서 가드도 **뿌리
     마다** 둡니다. */
  const lobby = readFileSync(join(DEMO, 'lobby.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  it('⭐ 회의 상태를 **국면 판단에 넘긴다** — `import` 만으로는 통과 못 한다', () => {
    ok(
      /lobbyPhase\(meetingStatus\)/.test(lobby),
      '레거시 로비가 회의 상태를 `lobbyPhase` 에 안 넘깁니다',
    );
  });

  it('⭐ 사람마다 적는 판정이 `verdictView` 를 **국면과 함께** 거친다', () => {
    // 「아직 참가하지 않았습니다」 ↔ 「참가하지 않았습니다 — 녹음은 없습니다」
    // 를 가르는 것이 이 인자입니다. 날 `s.message` 를 그리면 영영 「아직」입니다.
    const call = /verdictView\(\s*([^)]*)\)/.exec(lobby)?.[1] ?? '';
    ok(call !== '', '레거시 로비가 `verdictView` 를 안 부릅니다');
    strictEqual(
      call.split(',').length,
      2,
      `\`verdictView(${call})\` — 국면을 안 넘기면 끝난 회의에도 「아직」이 붙습니다`,
    );
  });

  it('⭐ 방 상태도 국면을 받는다 — 끝난 회의에 「아직」이 붙으면 안 된다', () => {
    const call = /roomStatus\(\s*([^)]*)\)/.exec(lobby)?.[1] ?? '';
    ok(call !== '', '레거시 로비가 `roomStatus` 를 안 부릅니다');
    strictEqual(
      call.split(',').length,
      3,
      `\`roomStatus(${call})\` — 국면을 안 넘기면 「아직 아무도 참가하지 않았습니다」가 남습니다`,
    );
  });

  it('⭐ 녹음·통화 단추가 **동의만** 보고 있지 않다', () => {
    /* ⚠️ **막혀 있던 것은 우연이었습니다.** 그 회의는 마침 동의가 안 모여
       눌리지 않았을 뿐입니다. 전원이 동의한 채로 끝난 회의였다면 「녹음
       화면으로」가 청록으로 멀쩡히 눌렸습니다 — 그래서 「눌리는가」가
       아니라 **무엇을 보고 정하는가**를 잽니다. */
    const gate = /const affordance\s*=\s*([^;]+);/.exec(lobby)?.[1] ?? '';
    ok(gate !== '', '`recordAffordance` 로 라벨·막힘을 정하는 자리가 없습니다');
    ok(
      /stillStartable/.test(gate),
      `단추가 국면을 안 봅니다 (\`${gate.trim()}\`) — 끝난 회의에서도 녹음하러 갑니다`,
    );
    for (const id of ['record', 'call']) {
      const btn = new RegExp(`id="${id}"([\\s\\S]{0,400}?)</button>`).exec(lobby)?.[1] ?? '';
      ok(btn !== '', `\`#${id}\` 단추를 못 찾았습니다`);
      ok(
        /affordance\.enabled/.test(btn) && /affordance\.(label|callLabel)/.test(btn),
        `\`#${id}\` 가 아직 \`startable\` 만 보고 라벨을 정합니다`,
      );
    }
  });
});

describe('확정 막힘 사유는 **한 덩이로 읽혀야** 한다 (결함 215)', () => {
  it('⚠️ 화면이 목록 뒤에 꼬리를 붙이지 않는다 — 문제가 둘 이상이면 엉뚱한 말이 붙는다', () => {
    // 실제로 이렇게 나왔습니다:
    //
    //   기여도는 0~100 사이여야 합니다 — 음수나 100 초과는 몫이 될 수
    //   없습니다 — 사유 없는 조정은 근거 없는 점수와 같습니다
    //
    // 뒤 절반은 범위와 아무 상관이 없습니다. 문장은 **문제를 만드는 곳**에
    // 함께 두어야 문제마다 자기 설명을 갖습니다.
    const contrib = readFileSync(
      join(ROOT, '..', 'webapp', 'src', 'screens', 'Contributions.tsx'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
    const rendered = /\{problems\.join\(' · '\)\}([^<]*)</.exec(contrib)?.[1] ?? null;
    ok(rendered !== null, '문제 목록을 그리는 자리를 못 찾았습니다');
    strictEqual(
      (rendered as string).trim(),
      '',
      '목록 뒤에 고정 문구가 붙어 있습니다 — 문제마다 다른 설명이 필요합니다',
    );
  });
});

describe('⛔ 막힌 버튼은 `aria-disabled` 다 (결함 234)', () => {
  /* 이 저장소의 비활성 버튼은 `aria-disabled` 입니다 — 초점을 받고,
     눌리고, **사유를 말합니다.** `disabled` 는 초점을 못 받으므로
     키보드·낭독기 사용자가 그 자리에 닿지 못합니다.

     설정의 「저장」 넷(role · github · profile · general)이 `disabled`
     였습니다. 역할 비중의 합을 0.5 로 만들면 사유가 멀쩡히 적히는데

         합이 1 이어야 합니다 (지금 0.5)

     Tab 은 `기획 비중 → 디자인 비중 → 「왜 나만 바꿀 수 있나요」` 로
     **버튼을 건너뛰고** 패널 밖으로 나갔습니다.

     ⚠️ **`isPending` 만 막는 것은 예외입니다** — 보내는 동안 두 번
     눌리는 것을 막는 표준 방법이고, 곧 풀립니다. 판단(값·권한)으로
     막는 버튼이 규칙의 대상입니다. */
  const SCREENS = ['Settings.tsx', 'Review.tsx', 'Kanban.tsx', 'Contributions.tsx', 'Lobby.tsx', 'Home.tsx'];

  for (const name of SCREENS) {
    it(`⭐ ${name} — 판단으로 막는 버튼에 \`disabled\` 를 안 쓴다`, () => {
      const code = readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ');
      const offenders: string[] = [];
      for (const m of code.matchAll(/(?<!aria-)disabled=\{([^}]*)\}/g)) {
        const expr = (m[1] ?? '').trim();
        /* **잠깐인 상태는 면제입니다** — 보내는 동안 두 번 눌리는 것을
           막는 표준 방법이고, 곧 스스로 풀립니다. 사람이 고쳐야 할
           것이 없으니 사유를 말할 것도 없습니다.
           ⚠️ 이름으로 가르는 것이 마음에 안 들지만, "곧 풀리는가" 는
              정적으로 잴 방법이 이것뿐입니다. */
        const rest = expr
          .replace(/[\w.]*\.is(Pending|Success)/g, '')
          .replace(/\b(busy|saving|pending|submitting|loading)\b/gi, '')
          .replace(/[|&!\s()]/g, '');
        if (rest !== '') offenders.push(expr);
      }
      ok(
        offenders.length === 0,
        `${name}: 판단으로 막는데 \`disabled\` 입니다 — 초점을 못 받아 사유에 닿을 수 없습니다\n    ${offenders.join('\n    ')}`,
      );
    });
  }
});

describe('⛔ 「아직」을 빨강으로 말하지 않는다 (결함 237)', () => {
  /* 녹음 화면을 처음 여는 사람은 동의를 안 한 상태입니다. 서버는 403 을
     주고, 화면은 그것을 **모든 실패와 같이** 빨갛게 말했습니다.

         트랙에 참가하지 못했습니다: 녹음에 동의하지 않았습니다   ← 빨강
         · 녹음 동의가 필요합니다                                 ← 회색

     같은 사실이 두 번, 두 색으로. 그리고 그 빨강은 ①~④ 중 아직 안 한
     첫 단계를 가리키는 것뿐입니다 — 고장이 아니라 **순서**입니다.

     `showNote` 는 이미 `'gap'` 색조를 갖고 있었고 그 주석이 정확히 이
     경우를 말합니다. 마이크 권한 쪽만 고쳐져 있었습니다. */
  const main = readFileSync(join(ROOT, 'src', 'demo', 'main.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  it('⭐ 판단은 `@lib` 에서 온다 — 화면이 색조를 직접 고르지 않는다', () => {
    ok(/describeJoinFailure\(/.test(main), '녹음 화면이 describeJoinFailure 를 안 부릅니다');
    ok(
      !/트랙에 참가하지 못했습니다: \$\{/.test(main),
      '화면이 실패 문구를 직접 짓습니다 — 색조를 가릴 수 없습니다',
    );
  });

  it('⭐ 그 판단이 준 **색조를 실제로 쓴다** — 안 쓰면 기본값(빨강)입니다', () => {
    /* ⚠️ `showNote(slot, text)` 는 색조 기본값이 `'bad'` 입니다. 문구만
       바꾸고 색조를 안 넘기면 **여전히 빨강**입니다 — 낱말이 아니라
       세 번째 인자가 있는가를 봅니다. */
    /* ⚠️ `[^)]*` 로 인자를 훑으면 **`$('join-note')` 안의 `)`** 에 걸려
       멈춥니다 — 처음 그렇게 써서 멀쩡한 코드에 실패했습니다. 줄로 봅니다. */
    const line = main.split('\n').find((l) => /showNote\(/.test(l) && /note\.text/.test(l)) ?? '';
    ok(line !== '', 'note.text 를 showNote 로 넘기는 곳이 없습니다');
    ok(/note\.tone/.test(line), `색조를 안 넘깁니다 — 기본값 빨강으로 나갑니다: ${line.trim()}`);
  });
});

describe('⛔ 막아 놓고 **말은 하는가** (결함 235)', () => {
  /* 234 를 고치면서 다섯째를 놓쳤습니다 — 하필 그 넷의 **모범**이던
     「저장소 연결」입니다. 안 건드린 첫 화면에서 이랬습니다:

         입력값: tjgksmf1012/teamflow-demo
         연결:   aria-disabled=true · btn--unmet · aria-describedby 없음

     초점은 받는데 **아무 말도 안 합니다.** `manageBlocked` 도 `problem`
     도 `null` 인 국면(= 아직 안 바꿈)이 사유 없이 막혔습니다.

     ⚠️ 요구는 **「막혔으면 사유가 따라온다」** 입니다. 그것을 한 곳에서
     지키는 방법이 `whyCannotSave` 이고, 그 값 하나로 `aria-disabled` 와
     `aria-describedby` 를 **같이** 정하면 둘이 갈라질 수 없습니다. */
  const settings = readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Settings.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  it('⭐ `aria-disabled` 와 `aria-describedby` 가 **같은 값**에서 나온다', () => {
    // 서로 다른 값에서 나오면 「막혔는데 말은 안 하는」 국면이 생깁니다.
    const buttons = [...settings.matchAll(/aria-disabled=\{([^}]*)\}[\s\S]{0,240}?aria-describedby=\{([^}]*)\}/g)];
    ok(buttons.length > 0, '설정에 aria-disabled 버튼이 없습니다 — 가드가 낡았습니다');
    const offenders: string[] = [];
    for (const m of buttons) {
      const gate = (m[1] ?? '').match(/(\w+) !== null/)?.[1];
      const said = (m[2] ?? '').match(/(\w+) !== null/)?.[1];
      if (gate !== undefined && said !== undefined && gate !== said) {
        offenders.push(`${gate} 로 막고 ${said} 로 말합니다`);
      }
    }
    ok(
      offenders.length === 0,
      `막는 값과 말하는 값이 다릅니다 — 사유 없이 막히는 국면이 생깁니다\n    ${offenders.join('\n    ')}`,
    );
  });

  it('⭐ 막는 버튼은 **하나도 빠짐없이** 사유를 답고 있다 (SPA 전 화면)', () => {
    /* ⚠️ 처음에는 「`whyCannotSave` 를 거치는가」로 썼습니다 — 그건
       **구현**이지 요구가 아닙니다. `leaveBlocked`·`rotateBlocked` 는
       사유가 하나뿐이라 그 함수 없이도 요구를 지키는데, 가드만 실패했습니다.
       요구는 **「막혔으면 사유가 따라온다」** 입니다.

       ⚠️⚠️ 그리고 이 가드는 **설정 화면만** 보고 있었습니다. 같은 요구가
       로비에서 깨져 있었는데(「동의했습니다」가 `aria-describedby` 없이
       막혀 있었습니다 — 결함 239) 이 가드는 조용히 통과했습니다.
       `AGENTS.md` 가 적어 둔 그대로 — **요구가 아니라 찾는 자리가
       낡았습니다.** 이제 SPA 화면을 전부 걷습니다. */
    const base = join(ROOT, '..', 'webapp', 'src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.tsx')) files.push(full);
      }
    };
    walk(base);
    ok(files.length > 0, 'SPA 화면 파일을 하나도 못 찾았습니다 — 가드가 헛돕니다');

    const offenders: string[] = [];
    let seen = 0;
    for (const file of files) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
        .replace(/\/\/[^\n]*/g, ' ');
      for (const m of code.matchAll(/<button[\s\S]{0,420}?>/g)) {
        const b = m[0];
        const gate = /aria-disabled=\{([^}]*)\}/.exec(b)?.[1];
        if (gate === undefined) continue;
        seen += 1;
        // `isPending` 만으로 막는 것은 잠깐이라 사유가 필요 없습니다.
        const judged = gate.replace(/[\w.]*\.is(Pending|Success)/g, '').replace(/[|&!\s()]/g, '');
        if (judged === '') continue;
        if (!/aria-describedby=/.test(b)) {
          offenders.push(`${file.slice(base.length + 1)}: aria-disabled={${gate}} 인데 사유를 안 답니다`);
        }
      }
    }
    ok(seen > 0, '`aria-disabled` 버튼을 하나도 안 봤습니다 — 가드가 헛돕니다');
    ok(
      offenders.length === 0,
      `막아 놓고 말을 안 합니다\n    ${offenders.join('\n    ')}`,
    );
  });
});

describe('⛔ 달력은 **한 벌**이다 (결함 246)', () => {
  /* 이 제품의 마감일·달력은 팀 달력(`Asia/Seoul`)입니다(결함 109). 그런데
     홈과 기여도는 `new Date(iso).getMonth()` 로 **브라우저 달력**을 그리고
     있었습니다 — 같은 회의를 서울 사람은 09-02, 뉴욕 사람은 09-01 로
     봤습니다. 재서 확인했습니다(자정을 넘는 순간을 심어서).

     ⚠️ 판단이 화면에 있던 것이기도 합니다 — `Home.tsx` 의 `fmtDate`,
     `Contributions.tsx` 의 `fmtComputedAt`. */
  it('⭐ 화면이 **브라우저 달력**으로 날짜를 짓지 않는다', () => {
    /* ⚠️ 이 가드는 **`webapp/src` 만** 걷고 있었습니다 (결함 286).
       레거시 화면 열셋(`src/demo`)은 자동 테스트가 **하나도 없어서**
       바로 이 파일이 지켜야 하는 자리인데, 찾는 자리에서 통째로
       빠져 있었습니다 — 활동 화면에 `new Date(at).getMonth()` 를 심고
       번들까지 다시 만들었더니 **1708개가 전부 통과**했습니다.
       요구가 아니라 **찾는 자리**가 낡은 것입니다. */
    const roots = [
      { label: 'webapp', base: join(ROOT, '..', 'webapp', 'src') },
      { label: 'demo', base: DEMO },
      { label: 'lib', base: LIB },
    ];
    const files: { label: string; rel: string; full: string }[] = [];
    const walk = (label: string, base: string, dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(label, base, full);
        else if (SCREEN_EXT.test(entry.name) && !entry.name.includes('.test.')) {
          files.push({ label, rel: full.slice(base.length + 1), full });
        }
      }
    };
    for (const { label, base } of roots) walk(label, base, base);

    const offenders: string[] = [];
    for (const { label, rel, full } of files) {
      /* 팀 달력을 **만드는** 곳 한 벌은 예외입니다 — 여기가 아니면
         어디서도 시간대를 다룰 수 없습니다. */
      if (rel.replace(/\\/g, '/') === 'time/calendar.ts') continue;
      const code = codeOf(readFileSync(full, 'utf8'));
      for (const m of code.matchAll(/\.(getMonth|getDate|getFullYear|getHours|getMinutes|getDay)\(/g)) {
        offenders.push(`${label}/${rel}: ${m[1]}()`);
      }
    }
    ok(files.length > 0, '화면 파일을 하나도 못 찾았습니다 — 가드가 헛돕니다');
    /* 세 뿌리가 **다 걸렸는지** 봅니다. 한 뿌리를 못 찾으면 그 뿌리는
       조용히 감시 밖입니다 — 이 결함이 바로 그것이었습니다. */
    for (const { label } of roots) {
      ok(
        files.some((f) => f.label === label),
        `${label} 을 한 파일도 못 걷었습니다 — 가드가 그 구역에 눈을 감습니다`,
      );
    }
    ok(
      offenders.length === 0,
      `브라우저 달력으로 날짜를 짓고 있습니다 — 팀 달력(\`@lib/time/calendar\`)을 쓰세요\n    ${offenders.join('\n    ')}`,
    );
  });
});

describe('⛔ 사람이 **적어 넣은 시각**도 팀 달력으로 읽는다 (결함 409)', () => {
  /* 결함 246 은 **읽는** 쪽을 팀 달력으로 옮겼고, 결함 295 는 `slice(0,10)`
     이라는 셋째 길을 막았습니다. **넷째 길**은 반대 방향이었습니다 —
     `<input type="datetime-local">` 이 준 **시간대 없는 글자**를
     `new Date(when).toISOString()` 로 바꾸면 **브라우저 달력**으로 읽습니다.

     브라우저 시간대를 바꿔 가며 같은 「10:00」을 넣어 재 봤습니다:

         Asia/Seoul       → 저장 01:00Z → 팀 달력 10:00  ✔
         UTC              → 저장 10:00Z → 팀 달력 19:00  ✘
         America/New_York → 저장 14:00Z → 팀 달력 23:00  ✘

     노트북 시계가 팀과 다른 사람이 잡은 회의가 팀 전체에 다른 시각으로
     나갑니다. 옛 주석은 「브라우저의 시간대로 해석해 순간으로 바꿔
     보냅니다」라고 **하는 일**만 적었고 그 선택의 근거는 없었습니다. */
  const screens = (): { label: string; rel: string; code: string }[] => {
    const roots = [
      { label: 'webapp', base: join(ROOT, '..', 'webapp', 'src') },
      { label: 'demo', base: DEMO },
      { label: 'lib', base: LIB },
    ];
    const out: { label: string; rel: string; code: string }[] = [];
    const walk = (label: string, base: string, dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(label, base, full);
        else if (SCREEN_EXT.test(entry.name) && !entry.name.includes('.test.')) {
          out.push({ label, rel: full.slice(base.length + 1).replace(/\\/g, '/'), code: codeOf(readFileSync(full, 'utf8')) });
        }
      }
    };
    for (const { label, base } of roots) walk(label, base, base);
    ok(out.length > 0, '화면 파일을 하나도 못 찾았습니다 — 가드가 헛돕니다');
    for (const { label } of roots) {
      ok(out.some((f) => f.label === label), `${label} 을 한 파일도 못 걷었습니다`);
    }
    return out;
  };

  it('⭐ 시간대 없는 글자를 받는 화면은 `new Date(…)` 를 안 쓴다', () => {
    /* ⚠️ **처음엔 자를 넓게 잡아 거짓 양성을 냈습니다.**
       `new Date(x).toISOString()` 을 전부 막았더니 `recording/complete.ts`
       의 `new Date(serverTimeMs).toISOString()` 이 걸렸습니다 — 그건
       **밀리초 순간**이라 시간대와 무관하고 맞는 코드입니다. 「잡혔다」는
       「맞다」가 아닙니다.

       그래서 자를 **위험이 있는 파일**로 좁힙니다: 시간대 없는 글자
       (`datetime-local`)를 받는 화면에서는 `new Date(…)` 로 순간을 만들
       일이 없습니다. 지금 시각(`new Date()`)은 예외입니다. */
    const offenders = screens()
      .filter((f) => /datetime-local/.test(f.code))
      .filter((f) => /new Date\(\s*[^)\s]/.test(f.code))
      .map((f) => `${f.label}/${f.rel}`);
    deepStrictEqual(
      offenders,
      [],
      '시간대 없는 글자를 브라우저 달력으로 읽고 있습니다 — `teamInstantOf` 를 쓰세요',
    );
  });

  it('⭐ `datetime-local` 을 받는 화면은 `teamInstantOf` 를 거친다', () => {
    /* ⚠️ 요구를 재는 쪽입니다. 위 검사는 **한 가지 길**만 막고, 이 검사는
       「시간대 없는 입력을 받으면 팀 달력으로 읽어라」를 잽니다. */
    const asking = screens().filter((f) => /datetime-local/.test(f.code));
    ok(asking.length > 0, '`datetime-local` 을 받는 화면이 하나도 없습니다 — 가드가 낡았습니다');
    const missing = asking
      .filter((f) => !/teamInstantOf\s*\(/.test(f.code))
      .map((f) => `${f.label}/${f.rel}`);
    deepStrictEqual(
      missing,
      [],
      '시간대 없는 입력을 팀 달력으로 안 읽습니다 — 브라우저 시계가 다른 사람이 잡으면 팀에 다른 시각으로 나갑니다',
    );
  });
});

describe('⛔ 서버가 준 순간을 **글자로 잘라** 날짜를 만들지 않는다 (결함 295)', () => {
  /* 결함 246 은 `new Date(iso).getMonth()` 를 막았습니다. 그런데 달력을
     갈라놓는 **세 번째 길**이 남아 있었습니다 — `instant.slice(0, 10)`.
     그건 UTC 달력일이고, `time/calendar.ts` 는 진작 「쓰지 마세요」라고
     적어 두었는데 `reports/view.ts` 만 그걸 하고 있었습니다.

     드러난 모양: 같은 보고서 한 줄이 **두 주**를 말했습니다.

         주간 보고서   2026-08-16 ~ 2026-08-22   ← 서버가 지은 제목(팀 달력)
                      2026-08-15 ~ 2026-08-21   ← 목록 칸(UTC 로 자름)

     ⚠️ 있던 검사들이 못 본 이유가 중요합니다 — 씨앗이 전부 `T00:00:00Z`
     라 서울에서도 **같은 날**이었습니다. 두 달력이 갈라지지 않는 데이터로
     재고 있었던 것입니다. */
  it('⭐ `_at`·`_start`·`_end` 를 `slice(0, 10)` 으로 자르지 않는다', () => {
    const roots = [
      { label: 'webapp', base: join(ROOT, '..', 'webapp', 'src') },
      { label: 'demo', base: DEMO },
      { label: 'lib', base: LIB },
    ];
    const files: { label: string; rel: string; full: string }[] = [];
    const walk = (label: string, base: string, dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(label, base, full);
        else if (SCREEN_EXT.test(entry.name) && !entry.name.includes('.test.')) {
          files.push({ label, rel: full.slice(base.length + 1), full });
        }
      }
    };
    for (const { label, base } of roots) walk(label, base, base);

    const offenders: string[] = [];
    for (const { label, rel, full } of files) {
      if (rel.replace(/\\/g, '/') === 'time/calendar.ts') continue;
      const code = codeOf(readFileSync(full, 'utf8'));
      for (const m of code.matchAll(/([A-Za-z_$][\w$]*(?:_at|_start|_end)|\.at)\s*\.\s*slice\(\s*0\s*,\s*10\s*\)/g)) {
        offenders.push(`${label}/${rel}: ${m[0]}`);
      }
    }
    ok(files.length > 0, '화면 파일을 하나도 못 찾았습니다 — 가드가 헛돕니다');
    /* 뿌리마다 한 파일이라도 걸렸는지 따로 잽니다 (결함 286). */
    for (const { label } of roots) {
      ok(
        files.some((f) => f.label === label),
        `${label} 을 한 파일도 못 걷었습니다 — 가드가 그 구역에 눈을 감습니다`,
      );
    }
    ok(
      offenders.length === 0,
      `서버가 준 순간을 UTC 로 자르고 있습니다 — \`teamDateOf\` 를 쓰세요\n    ${offenders.join('\n    ')}`,
    );
  });
});

describe('⛔ 「이번 주」를 화면이 짓지 않는다 (결함 296)', () => {
  /* 보고서 화면이 `end - 6일 ~ end` 를 만들어 보내고 있었습니다. 굴러가는
     창이라 `scope_key` 가 날마다 달라져 **하루에 한 벌씩 주간 보고서가
     쌓였습니다** — 사흘 눌러 세 벌이 나오는 것을 재현했고, 그중 둘은
     제목까지 같아 사람 눈에는 구별이 안 됐습니다.

     그리고 단추는 「이번 주」라고 적혀 있는데 이 제품의 「이번 주」는
     월~일입니다 (`meeting/resolve.py` 가 「이번 주까지」를 일요일로 풀고
     검사가 지킵니다 · `lib/calendar/month.ts` 의 격자도 월요일 시작).

     팀 달력을 아는 곳은 서버(`clock.team_week`)입니다. 화면이 창을 지으면
     달력이 두 벌이 되고, 그중 한 벌에는 자동 테스트가 없습니다. */
  const screen = (): string =>
    codeOf(readFileSync(join(DEMO, 'reports.tsx'), 'utf8'));

  it('⭐ 보고서 화면이 기간을 **계산하지 않는다**', () => {
    const code = screen();
    ok(
      code.includes('report_type'),
      '보고서 화면에서 만들기 요청을 못 찾았습니다 — 가드가 헛돕니다',
    );
    /* 날짜 산술로 창을 만드는 모양. `6 * 24 * 3600 * 1000` 이 원래
       모양이었고, 낱말이 아니라 **밀리초 산술 자체**를 봅니다. */
    const arithmetic = [...code.matchAll(/24\s*\*\s*3600|86_?400|setDate\(|setUTCDate\(/g)].map(
      (hit) => hit[0],
    );
    ok(
      arithmetic.length === 0,
      `화면이 기간을 짓고 있습니다 — 「이번 주」는 서버(\`clock.team_week\`)가 정합니다\n    ${arithmetic.join(', ')}`,
    );
    ok(
      !/period_start\s*:/.test(code),
      '화면이 period_start 를 보내고 있습니다 — 기간을 안 보내면 서버가 팀 달력의 이번 주로 채웁니다',
    );
  });
});

describe('⛔ 잡아 둔 일정을 **무를 자리**가 있다 (결함 298)', () => {
  /* 서버에는 `DELETE /api/scheduled-meetings/{id}` 가 처음부터 있었고
     검사(`test_cancelling_only_works_before_it_is_opened`)까지 붙어
     있었는데 **부르는 곳이 0곳**이었습니다 — 이 저장소의 대표 실패 ①
     「만들어 놓고 아무도 안 부름」입니다.

     드러난 모양: 일정을 잘못 잡거나 두 번 잡으면 달력·홈·회의 목록에
     **영영 남았습니다.** 화면 셋(SPA 로비·레거시 로비·일정)을 열어
     「무르기/취소/삭제」를 찾았고 셋 다 없었습니다.

     ⚠️ 그래서 이 가드는 **세 갈래(만들기·이름 고치기·무르기)가 각각
     부르는 곳을 가졌는가**를 봅니다 — 낱말이 아니라 요구입니다. */
  const ROUTES = [
    { method: 'POST', path: 'scheduled-meetings', what: '일정 잡기' },
    { method: 'PATCH', path: 'scheduled-meetings', what: '이름 고치기' },
    { method: 'DELETE', path: 'scheduled-meetings', what: '일정 무르기' },
  ];

  it('⭐ 서버의 세 갈래가 모두 화면에서 불린다', () => {
    const sources: string[] = [];
    const collect = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) collect(full);
        else if (SCREEN_EXT.test(entry.name) && !entry.name.includes('.test.')) {
          sources.push(codeOf(readFileSync(full, 'utf8')));
        }
      }
    };
    collect(DEMO);
    collect(join(ROOT, '..', 'webapp', 'src'));
    collect(LIB);
    ok(sources.length > 0, '화면 파일을 하나도 못 찾았습니다 — 가드가 헛돕니다');

    const missing = ROUTES.filter(({ method, path }) =>
      !sources.some((code) => {
        if (!code.includes(path)) return false;
        /* 같은 파일 안에서 그 주소를 부르면서 그 메서드를 쓰는가.
           `fetch(..., { method: 'DELETE' })` 도 `api.patch(...)` 도 잡습니다. */
        const verb = method.toLowerCase();
        return (
          new RegExp(`['"\`]${method}['"\`]`).test(code) ||
          new RegExp(`\\.${verb}\\s*[<(]`).test(code)
        );
      }),
    );
    ok(
      missing.length === 0,
      `서버에만 있고 부르는 곳이 없습니다 — 만들어 놓고 아무도 안 부르는 것입니다:\n    ${missing
        .map((r) => `${r.method} /api/${r.path} (${r.what})`)
        .join('\n    ')}`,
    );
  });
});

describe('⛔ 서버가 쓴 문장을 화면이 버리지 않는다 (결함 300)', () => {
  /* 「지난 활동 가져오기」를 누르면 서버는 이렇게 답합니다.

       409  서버에 GitHub App 자격 증명이 없거나 App이 아직 이 저장소에
            설치되지 않았습니다. 지난 활동을 가져오려면 그것부터 필요합니다.

     그런데 화면은 「**다른 사람이 먼저 처리했습니다.** 새로고침해서 지금
     상태를 보고 다시 정해 주세요」라고 했습니다 — 없던 사람을 지어내고,
     아무리 새로고침해도 안 되는 일을 시켰습니다.

     `ApiError` 는 `status` 와 `detail` 을 **둘 다** 들고 있는데 화면들이
     `status` 만 꺼내 쓰고 있었습니다. 그래서 **상태만 꺼내는 자리는
     문장도 같이 꺼내는가**를 잽니다 — 낱말이 아니라 짝입니다. */
  it('⭐ `describeActionFailure` 에 상태를 주면 **문장도 같이** 준다', () => {
    const files: { name: string; code: string }[] = [];
    const collect = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) collect(full);
        else if (SCREEN_EXT.test(entry.name) && !entry.name.includes('.test.')) {
          files.push({ name: entry.name, code: codeOf(readFileSync(full, 'utf8')) });
        }
      }
    };
    collect(join(ROOT, '..', 'webapp', 'src'));
    collect(DEMO);
    ok(files.length > 0, '화면 파일을 하나도 못 찾았습니다 — 가드가 헛돕니다');

    const offenders: string[] = [];
    for (const { name, code } of files) {
      /* 호출 하나를 통째로 떼어 냅니다 — 괄호가 닫힐 때까지. */
      for (const hit of code.matchAll(/describeActionFailure\(/g)) {
        let depth = 0;
        let end = hit.index ?? 0;
        for (let i = (hit.index ?? 0) + 'describeActionFailure'.length; i < code.length; i++) {
          if (code[i] === '(') depth++;
          else if (code[i] === ')') {
            depth--;
            if (depth === 0) { end = i; break; }
          }
        }
        const call = code.slice(hit.index ?? 0, end + 1);
        // 상태를 꺼내 쓰는 호출인가 (`.status` 또는 `statusOf(`·`failed.status`).
        if (!/\.status\b|statusOf\(/.test(call)) continue;
        // 그렇다면 문장도 꺼내야 합니다.
        if (!/\.detail\b|detailOf\(/.test(call)) {
          offenders.push(`${name}: ${call.replace(/\s+/g, ' ').slice(0, 70)}`);
        }
      }
    }
    ok(
      offenders.length === 0,
      `서버가 쓴 문장(\`ApiError.detail\`)을 버리고 있습니다 — 409 는 그 문장이 전부입니다\n    ${offenders.join('\n    ')}`,
    );
  });

  it('⭐ 어휘가 **없는 사람을 지어내지 않는다**', () => {
    const code = codeOf(readFileSync(join(LIB, 'ui', 'load.ts'), 'utf8'));
    ok(
      !/다른 사람이 먼저/.test(code),
      '409 를 「다른 사람이 먼저 처리했습니다」로 때우고 있습니다 — 이 제품의 409 다섯은 전부 조건 미충족입니다',
    );
  });
});

describe('⛔ 400 에서 서버가 쓴 문장을 버리지 않는다 (결함 301)', () => {
  /* `describeHttpStatus` 는 **400 에 아무 말도 없습니다**(`null`). 그래서

       describeHttpStatus(response.status) ?? '채널을 못 만들었습니다'

     는 400 에서 언제나 뒤엣것이 되고, 서버가 쓴

       400  `일반` 채널이 이미 있습니다

     가 통째로 버려집니다. 채팅 화면 일곱 자리가 그 모양이었습니다.

     ⚠️ 결함 300 과 같은 병입니다 — 300 은 409 를 **틀리게** 말했고,
     이쪽은 400 을 **아무 말도 안 하고** 넘겼습니다. */
  it('⭐ 레거시 화면이 `describeHttpStatus` 를 맨몸으로 쓰지 않는다', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (SCREEN_EXT.test(entry.name) && !entry.name.includes('.test.')) {
          const code = codeOf(readFileSync(full, 'utf8'));
          /* 「보낸 뒤」의 실패에서만 잽니다 — `response.status` 를 들고
             있는 자리입니다. 불러오기 실패(`failureHtml`)는 서버 문장이
             아니라 **다시 불러오기**가 답이라 그대로 둡니다. */
          for (const m of code.matchAll(/describeHttpStatus\(\s*response\.status\s*\)/g)) {
            /* ⚠️ **이 창을 200자로 잡았다가 제 코드를 잡았습니다** — 결함
               298 의 달력 코드는 `detailText` 를 쓰는데 그 위 주석이 길어
               창 밖으로 밀려났습니다. 자를 고칠 때는 걸린 것이 진짜인지
               하나씩 보십시오. */
            const around = code.slice(Math.max(0, (m.index ?? 0) - 700), (m.index ?? 0) + 80);
            if (/detailText\(/.test(around)) continue;
            /* 불러오기 실패는 서버 문장이 아니라 **다시 불러오기**가 답입니다.
               `setFailure`·`setFeedFailure` 처럼 이름이 여럿이라 넓게 잡습니다. */
            if (/set\w*Failure\(/.test(around)) continue;
            offenders.push(`${entry.name}: …${code.slice(m.index ?? 0, (m.index ?? 0) + 56).replace(/\s+/g, ' ')}`);
          }
        }
      }
    };
    walk(DEMO);
    ok(
      offenders.length === 0,
      `400 에서 서버가 쓴 문장을 버립니다 — \`detailText\` 를 거치세요\n    ${offenders.join('\n    ')}`,
    );
  });
});

describe('⛔ 글을 옮겨 놓았으면 **초점도 데려간다** (결함 302)', () => {
  /* 채팅에서 「고치기」·「답글」을 누르면 글이 아래 작성칸으로 옮겨 가는데
     초점은 누른 단추에 그대로 있었습니다. 키보드만 쓰는 사람은 **Tab 을
     31~32번** 눌러야 그 칸에 닿습니다 — 남은 메시지마다 반응·답글·
     고치기·지우기 넷을 지나가야 하므로 메시지가 쌓일수록 멀어집니다.

     화면은 「고치는 중」이라고 말은 합니다. 실패 ③ 「할 일을 알려 주고
     그 일을 할 자리를 안 줌」 그대로입니다.

     ⚠️ **두 갈래를 같이 봅니다.** 「고치기」만 고치고 「답글」을 두면
     이 저장소에서 제일 흔한 재발 모양이 됩니다 (실패 ②). */
  const chat = (): string => codeOf(readFileSync(join(DEMO, 'chat.tsx'), 'utf8'));

  it('⭐ `onEdit`·`onReply` 둘 다 작성칸으로 초점을 옮긴다', () => {
    const code = chat();
    const missing: string[] = [];
    for (const hook of ['onReply', 'onEdit']) {
      /* 그 콜백 하나를 통째로 떼어 냅니다 — 중괄호가 닫힐 때까지. */
      const start = code.indexOf(`${hook}={(`);
      ok(start >= 0, `${hook} 을 못 찾았습니다 — 가드가 낡았습니다`);
      let depth = 0;
      let end = start;
      for (let i = code.indexOf('{', start + hook.length); i < code.length; i++) {
        if (code[i] === '{') depth++;
        else if (code[i] === '}') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      const body = code.slice(start, end + 1);
      if (!/goToDraft\s*\)?\s*[;)]|goToDraft\(\)/.test(body)) missing.push(hook);
    }
    ok(
      missing.length === 0,
      `글만 옮기고 초점을 안 데려갑니다 — 키보드로는 서른 번 넘게 Tab 해야 닿습니다: ${missing.join(', ')}`,
    );
  });

  it('⭐ 작성칸에 **닿을 손잡이**가 있다', () => {
    const code = chat();
    ok(/ref=\{draftBox\}/.test(code), '작성칸에 ref 가 없으면 초점을 옮길 방법이 없습니다');
    ok(
      /setSelectionRange\(/.test(code),
      '캐럿을 글 끝에 두지 않으면 이어 쓰려다 글 앞에 끼워 넣게 됩니다',
    );
  });
});

describe('⛔ 자리를 바꿔 놓았으면 **초점도 데려간다** — 로비 (결함 303)', () => {
  /* 「이름 고치기」를 누르면 그 단추가 사라지고 입력칸이 그 자리에
     생깁니다. 초점을 쥐고 있던 단추가 없어지므로 초점이 **`body` 로
     떨어집니다.** 「저장」·「취소」도 같습니다 — 여닫이 **셋 다**.

         이름 고치기 → BODY(초점 잃음)
         취소        → BODY(초점 잃음)
         저장        → BODY(초점 잃음)   (200 PATCH 는 나갑니다)

     낭독기 사용자는 문서 맨 위로 떨어지고, 키보드 사용자는 자기가 어디
     있었는지 잃습니다. AGENTS.md 가 손으로 지은 대화상자의 증상으로
     적어 둔 그것입니다 (결함 280 — 「닫으면 body 에 떨어집니다」).

     ⚠️ 결함 302(채팅)와 같은 부류라 **여는 쪽만 고치면 안 됩니다.**
     가드가 여는 하나와 닫는 둘을 각각 봅니다. */
  const lobby = (): string =>
    codeOf(readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Lobby.tsx'), 'utf8'));

  it('⭐ 이름 칸을 열면 **그 칸으로** 간다', () => {
    const code = lobby();
    ok(/ref=\{titleBox\}/.test(code), '이름 칸에 ref 가 없으면 초점을 옮길 방법이 없습니다');
    /* ⚠️ **낱말이 아니라 「부르는가」를 봅니다** (결함 240 의 교훈).
       처음에는 `focusTitleBox` 가 200자 안에 나오는지만 봤는데,
       `void focusTitleBox;` 로 심어도 통과했습니다 — 이름은 그대로
       있으니까요. 심어 보고서야 알았습니다. */
    ok(
      /setRenaming\(true\);[\s\S]{0,200}?(?:requestAnimationFrame\(focusTitleBox\)|focusTitleBox\(\))/.test(
        code,
      ),
      '이름 고치기를 열면서 그 칸으로 초점을 안 데려갑니다',
    );
    ok(
      /setSelectionRange\(/.test(code),
      '캐럿을 글 끝에 안 두면 고치려다 글 앞에 끼워 넣습니다',
    );
  });

  it('⭐ 닫는 **두 갈래 다** 눌렀던 자리로 되돌린다', () => {
    const code = lobby();
    const closes = [...code.matchAll(/setRenaming\(false\)/g)];
    ok(closes.length >= 2, `닫는 자리를 ${closes.length}곳만 찾았습니다 — 저장·취소 둘이어야 합니다`);
    const orphan = closes.filter((m) => {
      const after = code.slice(m.index ?? 0, (m.index ?? 0) + 220);
      return !/renameBtn\.current\?\.focus\(\)/.test(after);
    });
    ok(
      orphan.length === 0,
      `닫으면서 초점을 안 데려오는 자리가 ${orphan.length}곳 있습니다 — body 로 떨어집니다`,
    );
  });
});

describe('⛔ 빈 상자가 **화면이 안 본 것**을 단언하지 않는다 (결함 304)', () => {
  /* 활동 기록이 이렇게 말하고 있었습니다.

       아직 기록된 활동이 없습니다
       기록은 누가 무언가를 바꿀 때 쌓입니다 — **아직 아무도 안 바꿨습니다.**

     같은 순간 그 팀에는 회의 다섯 · 업무 카드 넷 · 세 사람의 기여도 근거가
     있었습니다. `what` 은 참이고 **`why` 가 거짓**입니다 — 화면은 자기
     목록이 빈 것만 확인해 놓고 **팀 전체**를 말했습니다.

     결함 294(일정 화면)와 같은 모양입니다. 그때 적어 둔 규칙:
     「빈 상자를 지을 때는 「무엇이 비었나」와 「무엇이 있나」를 갈라
     보십시오」. */
  it('⭐ 빈 상자 문구가 **아무 일도 없었다**고 말하지 않는다', () => {
    const guilty: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (SCREEN_EXT.test(entry.name) && !entry.name.includes('.test.')) {
          const code = codeOf(readFileSync(full, 'utf8'));
          for (const m of code.matchAll(
            /(아직 )?아무도 안 (바꿨|했|만들|썼)|아무 일도 (없|안 )/g,
          )) {
            /* ⚠️ **부정문을 잡으면 안 됩니다.** 기여도 화면은 「아직 이을
               활동이 하나도 없습니다 — **아무도 안 했다는 뜻이 아닙니다**」
               라고 정확히 부정하고 있는데, 처음 쓴 자가 그 부정을 물었습니다
               (거짓 양성). 「잡혔다」는 「맞다」가 아닙니다. */
            const around = code.slice(Math.max(0, (m.index ?? 0) - 20), (m.index ?? 0) + 60);
            if (/(뜻이 )?아닙니다|아니라|안 그렇/.test(around)) continue;
            guilty.push(`${entry.name}: ${m[0]}`);
          }
        }
      }
    };
    walk(DEMO);
    walk(join(ROOT, '..', 'webapp', 'src'));
    walk(LIB);
    ok(
      guilty.length === 0,
      `빈 목록을 보고 **팀 전체가 아무것도 안 했다**고 단언합니다 — 그 화면이 못 보는 일이 있습니다\n    ${guilty.join('\n    ')}`,
    );
  });

  it('⭐ 활동 화면의 빈 문구는 **한 벌**(`@lib`)에서 온다', () => {
    const code = codeOf(readFileSync(join(DEMO, 'activity.tsx'), 'utf8'));
    ok(
      /describeEmptyActivity\(\)/.test(code),
      '빈 문구를 화면이 직접 짓고 있습니다 — 판단은 `@lib` 한 벌입니다',
    );
  });

  /* 같은 회차에 쓸다가 나온 **두 번째 자리**입니다. 채팅의 빈 채널이
     「`#공지` 채널이 **방금 만들어졌습니다**」라고 적고 있었는데, 채널
     목록이 돌려주는 것은 `{id, kind, name, position}` 뿐입니다 — 화면은
     만든 시각을 **받지도 않습니다.** 지난달에 만들어 두고 아무도 안 쓴
     채널도 똑같이 「방금」이라고 말합니다.

     ⚠️ 「아무도 안 …」과 달리 이쪽은 **시각**에 대한 단언입니다. 성질은
     같습니다 — 화면이 확인하지 않은 것을 빈 상자가 말합니다. */
  it('⭐ 빈 상자가 **받지도 않은 시각**을 말하지 않는다', () => {
    const guilty: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (SCREEN_EXT.test(entry.name) && !entry.name.includes('.test.')) {
          const code = codeOf(readFileSync(full, 'utf8'));
          /* `emptyHtml({...})` 안만 봅니다 — 다른 자리의 「방금」은 진짜
             방금 일어난 일(막 보낸 메시지 등)일 수 있습니다. */
          for (const m of code.matchAll(/emptyHtml\(\{[\s\S]{0,400}?\}\)/g)) {
            if (/방금|조금 전|막 만들어/.test(m[0])) {
              guilty.push(`${entry.name}: ${m[0].replace(/\s+/g, ' ').slice(0, 90)}`);
            }
          }
        }
      }
    };
    walk(DEMO);
    walk(join(ROOT, '..', 'webapp', 'src'));
    ok(
      guilty.length === 0,
      `빈 상자가 **언제 생겼는지**를 말합니다 — 화면이 그 시각을 받는지 확인하세요\n    ${guilty.join('\n    ')}`,
    );
  });

  it('⭐ 채팅의 빈 채널 문구도 **한 벌**(`@lib`)에서 온다', () => {
    const code = codeOf(readFileSync(join(DEMO, 'chat.tsx'), 'utf8'));
    ok(
      /describeEmptyChannel\(\)/.test(code),
      '빈 채널 문구를 화면이 직접 짓고 있습니다 — 판단은 `@lib` 한 벌입니다',
    );
  });
});

describe('⛔ 기여도 리본은 **순위를 안 그린다** (결함 247)', () => {
  /* 이 저장소의 제일 무거운 불변식(①: 순위·리더보드 금지)이 걸린 자리인데
     **가드가 한 번도 안 울렸습니다.** 조각을 만드는 코드가 `@lib` 이 아니라
     화면 안(`Contributions.tsx` 의 `ribbonFor`)에 있었기 때문입니다 —
     실패 ①「만들어 놓고 아무도 안 부름」의 거울상입니다.

     재서 확인했습니다:

         1440px  세 리본의 축 `left` 가 전부 273.00 · 파랑 끝도 셋 다 44.60%
                  빗금 꼬리 끝만 67.97% / 62.84% / 58.36%
         900px   세 축이 201→731 로 **픽셀까지 동일**

     그리고 그 꼬리는 우연이 아닙니다. `confidence` 는 팀당 한 번 계산되는
     상수이고(`scoring.py`) 폭이 `share × (1 − confidence) × 0.5` 이므로
     꼬리 끝 `= c + s(1 − c)/100` 은 share 에 대해 **구조적으로 순증가**
     였습니다. 같은 축 위에 세로로 쌓인 막대그래프 = 순위표.

     ⚠️ 눈금도 같이 걷었습니다. 눈금이 서면 그 축은 사람들이 **공유하는
     자**가 되고, 게다가 그 자 위에 단위가 둘 앉아 있었습니다(파랑은
     확신도 0~1, 빗금 폭은 기여도 %p). */
  const screen = (): string =>
    codeOf(readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Contributions.tsx'), 'utf8'));

  it('⭐ 화면이 리본 조각을 **직접 짓지 않는다** — 판단은 `@lib`', () => {
    const code = screen();
    ok(/confidenceRibbon/.test(code), '기여도 화면이 `confidenceRibbon` 을 안 부릅니다');
    ok(
      /from '@lib\/contribution\/ribbon\.ts'/.test(code),
      '`@lib/contribution/ribbon.ts` 에서 가져오지 않습니다 — 판단이 화면으로 돌아왔습니다',
    );
    const homemade = [...code.matchAll(/kind:\s*'(known|unknown|empty)'/g)].map((m) => m[0]);
    strictEqual(
      homemade.join(' · '),
      '',
      '화면이 리본 조각을 직접 짓고 있습니다 — 순위가 그려져도 가드가 안 울립니다',
    );
  });

  it('⭐ 기여도 리본에는 **공유하는 자**를 세우지 않는다', () => {
    const code = screen();
    const tags = [...code.matchAll(/<TrackRibbon[\s\S]*?\/>/g)].map((m) => m[0]);
    ok(tags.length > 0, '기여도 화면에서 리본을 하나도 못 찾았습니다 — 가드가 헛돕니다');
    const withTicks = tags.filter((t) => /\bticks=/.test(t));
    strictEqual(
      withTicks.length,
      0,
      '리본에 눈금이 섰습니다 — 여러 사람이 같은 자를 공유하면 그게 순위표입니다',
    );
  });

  it('⭐ 리본 길이는 **사람마다 같다** — 기여도가 길이를 못 건드린다', () => {
    /* 길이가 share 에 딸려 가면 그 순간 다시 막대그래프입니다. 그래서
       조각을 만드는 함수는 **확신도 하나만** 받습니다.

       ⚠️ 처음에는 `confidenceRibbon.length` 로 셌습니다. **기본값이 붙은
       인자는 그 수에 안 들어갑니다** — `(c, share = 0)` 을 심었더니
       가드가 통과했습니다. 잴 도구가 틀린 자리라, 이제 선언을 읽습니다. */
    const lib = readFileSync(join(ROOT, 'src', 'lib', 'contribution', 'ribbon.ts'), 'utf8');
    const sig = /export function confidenceRibbon\(([^)]*)\)/.exec(codeOf(lib));
    ok(sig, '`confidenceRibbon` 선언을 못 찾았습니다 — 가드가 헛돕니다');
    const params = (sig?.[1] ?? '').split(',').filter((t) => t.trim() !== '');
    strictEqual(
      params.length,
      1,
      `리본이 확신도 말고 다른 값을 받고 있습니다 — 길이가 기여도에 딸려 갑니다: ${params.join(' · ')}`,
    );
    for (const c of [0, 0.2, 0.446, 1]) {
      const covered = confidenceRibbon(c).reduce((sum, p) => sum + (p.end - p.start), 0);
      ok(Math.abs(covered - 1) < 1e-9, `확신도 ${c} 에서 리본이 안 가득 찹니다`);
    }
  });
});

describe('⛔ 확신 리본은 **팀 것**이다 (결함 248)', () => {
  /* 결함 247 로 리본 길이를 고쳐 놓고 렌더해 보니, 세 사람의 리본이
     **완전히 같았습니다.** 그럴 수밖에 없었습니다 — `confidence` 는
     `compute_confidence(coverage)` 한 번으로 팀 전체에 대해 계산되고
     (`contribution/scoring.py`, 사람 반복문 **밖**입니다) 그 한 값이 세
     사람에게 그대로 실립니다. 화면에서 잰 낭독 문구도 이름만 다르고
     숫자가 전부 45% 였습니다.

     팀에 대해 아는 것을 **사람에 대해 아는 것처럼** 말한 것입니다.
     「김민수 — 확신한 몫 45%」는 「이 사람은 45%만 파악됐다」로 읽힙니다.
     불변식 ③(측정 불가 ≠ 0점)이 지키려는 것과 같은 자리 — **모르는 것의
     임자를 바꾸면 안 됩니다.**

     그래서 리본은 머리말에 **하나**만 서고, 「팀 전체」라고 적습니다. */
  const screen = (): string =>
    codeOf(readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Contributions.tsx'), 'utf8'));

  it('⭐ 리본은 **한 개**이고 사람 줄 **밖**에 선다', () => {
    const code = screen();
    const ribbons = [...code.matchAll(/<TrackRibbon\b/g)];
    strictEqual(
      ribbons.length,
      1,
      '기여도 화면의 리본은 하나입니다 — 사람마다 그리면 팀 값을 사람 값처럼 말합니다',
    );
    /* ⚠️ 처음에는 `members.map(` 을 찾았는데, 그 이름의 **임자가 다섯**
       이었습니다 — 확정 폼 초안·몫 색인·그리고 팀 확신값을 모으는 줄까지.
       맨 앞에 걸린 것이 리본보다 위에 있어서 가드가 **엉뚱한 자리**를
       기준으로 재고 실패했습니다. 사람 줄을 그리는 자리는 이것입니다. */
    const map = code.indexOf('members.map((member) =>');
    ok(map > 0, '사람 줄을 그리는 `members.map((member) =>` 를 못 찾았습니다 — 가드가 헛돕니다');
    ok(
      (ribbons[0]?.index ?? -1) < map,
      '리본이 사람 줄 안으로 들어갔습니다 — 확신도는 팀당 한 번 계산되는 값입니다',
    );
  });

  it('⭐ 리본 문구가 **사람 이름을 부르지 않는다**', () => {
    // 낭독기에 「김민수 — 확신한 몫 45%」로 읽히던 자리입니다.
    ok(!/확신한 몫/.test(describeTeamRibbon(0)), '0 일 때는 몫을 말하지 않습니다');
    ok(
      describeTeamRibbon(0.446).startsWith('팀 전체'),
      `리본 문구의 임자가 팀이 아닙니다: ${describeTeamRibbon(0.446)}`,
    );
    const lib = codeOf(
      readFileSync(join(ROOT, 'src', 'lib', 'contribution', 'ribbon.ts'), 'utf8'),
    );
    ok(
      !/export function describeRibbon\b/.test(lib),
      '사람 이름을 받는 리본 문구가 남아 있습니다',
    );
  });

  it('⭐ 값이 **갈라지면** 팀이라고 말하지 않는다', () => {
    // 「같은 값이니 하나만 그리자」가 아니라 「같은 값인지 확인하고 그린다」.
    strictEqual(sharedConfidence([0.446, 0.446, 0.446]), 0.446);
    strictEqual(sharedConfidence([0.446, 0.5, 0.446]), null);
    strictEqual(sharedConfidence([]), null);
    strictEqual(sharedConfidence([Number.NaN, Number.NaN]), null);
  });
});

describe('⛔ 안 잰 것을 **만점으로 읽지 않는다** (결함 249·250)', () => {
  /* 녹음 화면 ③ 「캡처 설정 확인」은 경고 목록이 비면 초록으로
     「캡처 설정이 요청대로 적용됐습니다」라고 적었습니다. 그 목록은
     `requestMicrophone()` 이 성공한 뒤에야 채워지는데도요.

     재현했습니다 — `getUserMedia` 를 거부시키고 화면을 열었더니
     `#blockers` 는 「마이크 권한이 거부됐습니다」인데 `#warnings` 는
     초록으로 「요청대로 적용됐습니다」였습니다. **아무것도 안 재고
     만점을 준 것**입니다 (불변식 ③).

     ⚠️ 고치고 색을 재다가 하나 더 나왔습니다 (결함 250). 화면은 심각도를
     계산해 `li.critical` 처럼 클래스로 붙이고 있었는데, 바로 위
     `#blockers li, #warnings li` 가 `color` 를 정하고 있어서 **다섯 톤이
     전부 특성도에서 지고** `--text-muted` 한 색으로 나갔습니다. 캔버스로
     픽셀을 읽어서 확인했습니다:

         ok/critical/warning/info/gap → 전부 [91, 97, 114]

     「자동 게인이 안 꺼졌습니다」가 빨강이 아니라 회색이었습니다. */
  const html = (): string => readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');

  it('⭐ 화면이 「요청대로 적용됐습니다」를 **스스로 말하지 않는다**', () => {
    const code = codeOf(readFileSync(join(ROOT, 'src', 'demo', 'main.ts'), 'utf8'));
    ok(
      /describeCaptureCheck\(/.test(code),
      '녹음 화면이 `describeCaptureCheck` 를 안 부릅니다 — 판단이 화면으로 돌아왔습니다',
    );
    ok(
      !code.includes('요청대로 적용됐습니다'),
      '화면이 캡처 결과를 직접 단언합니다 — 무엇을 말해도 되는지는 `@lib` 이 정합니다',
    );
  });

  it('⭐ 톤 규칙이 **특성도에서 지지 않는다**', () => {
    /* 잴 것: 「`#…  li` 가 색을 정하는데 `li.톤` 은 id 없이 적혀 있는가」.
       ⚠️ 낱말이 아니라 **요구**를 잽니다 — 클래스 이름 목록을 박아 두면
       톤이 하나 늘 때 가드가 조용히 눈을 감습니다. */
    const style = html();
    const idScoped = /#(?:blockers|warnings)\s+li\s*\{[^}]*\bcolor\s*:/.test(style);
    ok(idScoped, '`#warnings li` 가 색을 정하는 규칙을 못 찾았습니다 — 가드가 헛돕니다');
    const naked: string[] = [];
    for (const m of style.matchAll(/(^|[\n,{}])\s*(li\.[\w-]+)\s*(,[^{]*)?\{([^}]*)\}/g)) {
      if (!/\bcolor\s*:/.test(m[4] as string)) continue;
      naked.push(m[2] as string);
    }
    strictEqual(
      naked.join(' · '),
      '',
      'id 로 좁힌 규칙에 져서 **아무 색도 안 나갑니다** — 선택자에 `#blockers`·`#warnings` 를 같이 적으세요',
    );
  });
});

describe('⛔ 사유 제목이 **줄들과 같은 것**을 말한다 (결함 253)', () => {
  /* 검토 화면의 사유 팝오버 제목이 「확신이 낮은 이유」였습니다. 두 군데가
     틀렸습니다.

     ① 줄들이 확신도 얘기가 아닙니다 — 대개 서버 경고입니다
        (「담당자 미확정 — '저' 는 명단의 누구와도 맞지 않습니다」).
     ② 확신이 낮지도 않습니다 — 재 보니 **확신 71%** 후보에 그 제목이
        붙어 있었습니다. 저확신 기준은 `LOW_CONFIDENCE = 0.7` 입니다.

     `attentionReasons` 의 머리말이 이미 답을 적어 두고 있었습니다 —
     「사람이 이 후보를 **왜 들여다봐야 하는지**」. */
  it('⭐ 화면이 사유 제목을 **직접 짓지 않는다**', () => {
    const code = codeOf(
      readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Review.tsx'), 'utf8'),
    );
    ok(/attentionAbout\(/.test(code), '사유 제목을 `@lib` 에서 안 가져옵니다');
    ok(
      !code.includes('확신이 낮은 이유'),
      '화면이 사유를 확신도 탓으로 적습니다 — 줄들은 대개 서버 경고입니다',
    );
  });

  it('⭐ 제목이 **확신도를 단정하지 않는다**', () => {
    const said = attentionAbout({
      id: 1,
      title: '회원가입 화면 작업',
      confidence: 0.71,
      evidence_utterance_ids: [],
      review_status: 'pending',
      warnings: ["담당자 미확정 — '저' 는 명단의 누구와도 맞지 않습니다"],
    } as unknown as Parameters<typeof attentionAbout>[0]);
    ok(!said.includes('낮은'), `71% 를 낮다고 단정합니다: ${said}`);
    ok(said.includes('회원가입 화면 작업'), said);
  });
});

describe('⛔ 못 받은 목록을 **빈 목록으로 접지 않는다** (결함 255)', () => {
  /* 로비가 `tracks.data?.tracks ?? []` 로 트랙을 읽었습니다. 그 `?? []` 가
     「못 받음」과 「아무도 참가 안 함」을 같은 값으로 만듭니다.

     재현했습니다 — `/tracks` 를 500 으로 막고 **이미 녹음이 끝난** 회의의
     로비를 열었더니, 커버리지 100·98·42% 인 세 사람이 나란히 「미참가」로
     섰고 화면 어디에도 못 받았다는 말이 없었습니다. 불변식 ③ 입니다.

     ⚠️ 「참가 안 함」은 이 화면에서 **행동을 부르는 말**입니다 — 강제
     종료 버튼이 거기 달려 있습니다. 모르는 채로 되돌릴 수 없는 일을
     권하게 됩니다. */
  it('⭐ 로비가 트랙을 **`?? []` 로 읽지 않는다**', () => {
    const code = codeOf(
      readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Lobby.tsx'), 'utf8'),
    );
    const folded = [...code.matchAll(/tracks(?:Query)?\.data\?\.\w+\s*\?\?\s*\[\]/g)].map(
      (m) => m[0],
    );
    strictEqual(
      folded.join(' · '),
      '',
      '못 받은 것을 빈 목록으로 접습니다 — 전원이 「미참가」로 섭니다',
    );
    ok(/memberStatuses\(/.test(code), '로비가 `memberStatuses` 를 안 부릅니다 — 가드가 헛돕니다');
  });

  it('⭐ 판단이 **`null` 을 「모름」으로** 받는다', () => {
    const said = memberStatuses(
      [{ user_id: 1, name: '김민수', recording: true }] as unknown as Parameters<
        typeof memberStatuses
      >[0],
      null,
    );
    strictEqual(said[0]?.verdict, 'unknown');
    // 반대 방향 — 빈 배열은 그대로 「미참가」여야 합니다.
    strictEqual(
      memberStatuses(
        [{ user_id: 1, name: '김민수', recording: true }] as unknown as Parameters<
          typeof memberStatuses
        >[0],
        [],
      )[0]?.verdict,
      'not_joined',
    );
  });
});

describe('⛔ 되돌릴 수 없는 것은 **묻고, 보이고, 좁아야** 한다 (결함 256·257·258)', () => {
  const settings = (): string =>
    codeOf(readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Settings.tsx'), 'utf8'));
  const css = (): string => readFileSync(join(ROOT, '..', 'webapp', 'src', 'app.css'), 'utf8');

  it('⭐ 저장소 **연결 해제**는 묻고 나서 한다 (결함 256)', () => {
    /* 칸을 비우고 「연결」을 누르면 `PATCH {github_repo: ""}` 가 그냥
       나갔습니다 — 확인도, 알림도, 되돌릴 실마리도 없이. 게다가 버튼에는
       「연결」이라고 적혀 있어 **낱말이 하는 일과 달랐습니다.** */
    const code = settings();
    ok(/isDisconnect\(/.test(code), '연결 해제를 가려내지 않습니다');
    ok(/disconnectConfirm\(/.test(code), '연결을 끊기 전에 묻지 않습니다');
    // 물어본 답이 **막는가** — `window.confirm(...)` 이 `return` 으로 이어지는가.
    ok(
      /!window\.confirm\(disconnectConfirm\([^)]*\)\)\s*\)?\s*return/.test(code),
      '물어만 보고 그대로 보냅니다 — 아니라고 답해도 나갑니다',
    );
  });

  it('⭐ 위험한 것이 화면에서 **제일 약하지 않다** (결함 257)', () => {
    /* 남을 프로젝트에서 내보내는 버튼이 `btn--ghost` 였습니다 — 재 보니
       글자색이 `--text-muted`(본문과 같은 색)에 테두리도 배경도 없었고,
       같은 화면의 「내 녹음 지우기」만 빨강이었습니다. */
    const code = settings();
    const buttons = [...code.matchAll(/<button[\s\S]*?<\/button>/g)].map((m) => m[0]);
    const removers = buttons.filter((b) => /removeMember\.mutate\(/.test(b));
    ok(removers.length > 0, '내보내기 버튼을 못 찾았습니다 — 가드가 헛돕니다');
    for (const b of removers) {
      const cls = /className="([^"]*)"/.exec(b)?.[1] ?? '';
      ok(
        /danger/.test(cls),
        `되돌릴 수 없는 일이 조용한 버튼입니다: ${cls || '(클래스 없음)'}`,
      );
    }
  });

  it('⭐ 로그아웃 표적이 **탭바를 먹지 않는다** (결함 258)', () => {
    /* 세로 레일에서는 `width: 100%` 가 72px 열을 채우는 옳은 규칙인데,
       가로 탭바에서는 그 100% 가 **탭바 전체**를 기준으로 잡힙니다.
       700px 에서 로그아웃 상자가 436px(62%)였고, 오른쪽 빈 자리를 눌러도
       로그아웃이었습니다.

       ⚠️ **미디어 쿼리 안을 봅니다.** 이 저장소는 「CSS 가드가 첫 미디어
       쿼리만 본 것」에 한 번 당했습니다 — 좁은 폭 규칙을 이름이 아니라
       **범위**로 찾습니다. */
    const sheet = css();
    const stretches = /button\.rail__item\s*\{[^}]*width:\s*100%/.test(sheet);
    if (!stretches) return; // 아예 안 늘리면 이 결함이 생길 수 없습니다.
    const narrow = [...sheet.matchAll(/@media\s*\(max-width:[^)]*\)\s*\{/g)].map((m) => {
      // 중괄호를 세어 이 미디어 쿼리의 끝을 찾습니다.
      let depth = 1;
      let i = (m.index ?? 0) + m[0].length;
      while (i < sheet.length && depth > 0) {
        if (sheet[i] === '{') depth += 1;
        else if (sheet[i] === '}') depth -= 1;
        i += 1;
      }
      return sheet.slice((m.index ?? 0), i);
    });
    const reset = narrow.some((blockText) =>
      /button\.rail__item\s*\{[^}]*width:\s*auto/.test(blockText),
    );
    ok(
      reset,
      '가로 탭바에서 로그아웃이 남은 폭을 다 먹습니다 — 빈 자리를 눌러도 로그아웃됩니다',
    );
  });
});

describe('⛔ 글자가 있는 그대로 보여야 한다 (결함 259·261·262·263·269)', () => {
  const css = (): string => readFileSync(join(ROOT, '..', 'webapp', 'src', 'app.css'), 'utf8');

  it('⭐ 없는 **무게를 지어내지 않는다** (결함 259)', () => {
    /* JetBrains Mono 는 이 저장소에 400·500 **두 벌만** 있습니다
       (`@font-face` 둘). 600 을 적으면 브라우저가 획을 번지게 해서 만들어
       냅니다 — 기여도 화면의 28px 숫자와 칸반의 근거 개수가 그렇게 그려지고
       있었습니다.

       ⚠️ **선언된 얼굴을 세어서** 판정합니다. 나중에 600 짜리 파일을
       들이면 이 가드는 스스로 조용해져야 합니다. */
    const sheet = css();
    const faces = new Set(
      [...sheet.matchAll(/@font-face\s*\{[^}]*JetBrains Mono[^}]*\}/g)].flatMap((m) =>
        [...m[0].matchAll(/font-weight:\s*(\d+)/g)].map((w) => Number(w[1])),
      ),
    );
    ok(faces.size > 0, 'JetBrains Mono 의 `@font-face` 를 못 찾았습니다 — 가드가 헛돕니다');
    const WEIGHT: Record<string, number> = {
      '--fw-normal': 400,
      '--fw-medium': 500,
      '--fw-semibold': 600,
      '--fw-bold': 700,
    };
    const offenders: string[] = [];
    for (const m of sheet.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const body = m[2] ?? '';
      if (!/font-family:\s*var\(--font-mono\)/.test(body)) continue;
      const weight = /font-weight:\s*(?:var\((--fw-[\w-]+)\)|(\d+))/.exec(body);
      if (weight === null) continue;
      const value = weight[1] !== undefined ? (WEIGHT[weight[1]] ?? 0) : Number(weight[2]);
      if (value > 0 && !faces.has(value)) {
        offenders.push(`${(m[1] ?? '').trim().split('\n').pop()} @${value}`);
      }
    }
    strictEqual(
      offenders.join(' · '),
      '',
      `모노에 없는 무게입니다 — 브라우저가 획을 번지게 해서 만들어 냅니다 (있는 것: ${[...faces].join('·')})`,
    );
  });

  it('⭐ 시간축은 **한 벌**이다 (결함 261)', () => {
    /* 참가자 셋이면 같은 자(`0분 7 13 20 27 33 40분`)가 세 번 그려졌습니다.
       같은 회의의 같은 시간축인데요 — 값이 아니라 **잉크만** 세 배였습니다. */
    const code = codeOf(
      readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Lobby.tsx'), 'utf8'),
    );
    const map = code.indexOf('statuses.map(');
    ok(map > 0, '참가자 줄을 그리는 자리를 못 찾았습니다 — 가드가 헛돕니다');
    const inRows = [...code.matchAll(/<TrackRibbon[\s\S]*?\/>/g)].filter(
      (m) => (m.index ?? 0) > map,
    );
    ok(inRows.length > 0, '참가자 줄에 막대가 없습니다 — 가드가 헛돕니다');
    for (const m of inRows) {
      ok(!/\bticks=/.test(m[0]), '사람마다 눈금을 그립니다 — 축은 위에 한 벌만 둡니다');
    }
    ok(/ribbon-axis/.test(code), '공용 축을 안 그립니다');
  });

  it('⭐ **없는 열을 위해 자리를 비우지 않는다** (결함 263)', () => {
    /* 녹음·통화는 메신저 셸(목록 열)이 아니라 좁은 레일(`.sparail`, 72px)을
       씁니다. 그런데 `html { padding-left: var(--shell-list) }` 가 조건 없이
       걸려서 있지도 않은 목록 열 몫으로 **256px** 을 비우고 있었습니다.
       레일과 머리줄은 `position: fixed` 라 그 여백을 무시하므로, 한 화면
       안에서 왼쪽 끝이 둘이 됐습니다 — 머리줄 96px, 본문 352px.

       ⚠️ 바로 위 주석이 같은 실수를 `--shell-rail` 로 겪고 적어 둔
       자리인데 `--shell-list` 에서 다시 났습니다. */
    const sheet = readFileSync(join(ROOT, 'public', 'app.css'), 'utf8');
    const reserves = /html\s*\{[^}]*padding-left:\s*var\(--shell-list\)/.test(sheet);
    if (!reserves) return; // 아예 안 비우면 이 결함이 생길 수 없습니다.
    ok(
      /html:has\(body\.sparail-page\)\s*\{[^}]*padding-left:\s*0/.test(sheet),
      '레일 화면(녹음·통화)이 없는 목록 열 몫을 비웁니다 — 왼쪽 끝이 둘이 됩니다',
    );
  });

  it('⭐ 좁은 폭에서 **시간축이 뭉개지지 않는다** (결함 269)', () => {
    /* 로비는 1024px 아래에서도 두 판이 나란히 서는데, 그러면 막대 칸이
       **104px 에서 멈춥니다** — 눈금 일곱이 그 안에서 겹쳐 서로를 덮었습니다.
       재서 잡았습니다(800px: 최소 간격 0px · 겹침 6).

       폭을 줄여 맞추지 않고 **한 줄을 접습니다** — 홈이 좁아질 때 사슬을
       아래로 내리는 것과 같은 방식(결함 213). */
    const sheet = css();
    const wide = /\.lrow\s*\{[^}]*grid-template-columns:[^;]*1fr[^;]*;/.test(sheet);
    if (!wide) return; // 세 칸이 아니면 이 결함이 생길 수 없습니다.
    const narrow = [...sheet.matchAll(/@media\s*\(max-width:[^)]*\)\s*\{/g)].map((m) => {
      let depth = 1;
      let i = (m.index ?? 0) + m[0].length;
      while (i < sheet.length && depth > 0) {
        if (sheet[i] === '{') depth += 1;
        else if (sheet[i] === '}') depth -= 1;
        i += 1;
      }
      return sheet.slice(m.index ?? 0, i);
    });
    ok(
      narrow.some((b) => /\.lrow__ribbon\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/.test(b)),
      '좁은 폭에서 막대 칸이 104px 로 눌려 눈금 일곱이 겹칩니다 — 줄을 접으세요',
    );
  });

  it('⭐ 마크다운 표시를 **화면에서 걷는 곳이 한 벌**이다 (결함 262)', () => {
    /* 그 일을 하는 코드가 세 벌 있었고 셋 다 `**` 만 지우고 백틱은 그대로
       뒀습니다. 설정 화면에 「`GITHUB_WEBHOOK_SECRET`」 이 그대로 떠
       있었습니다 — 한국어 문장 안의 백틱은 그냥 깨진 글자입니다. */
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) files.push(full);
      }
    };
    walk(join(ROOT, 'src', 'demo'));
    walk(join(ROOT, '..', 'webapp', 'src'));
    const homemade = files.filter((f) => /replace\(\/\\\*\\\*\/g/.test(codeOf(readFileSync(f, 'utf8'))));
    strictEqual(
      homemade.map((f) => f.split('/').pop()).join(' · '),
      '',
      '화면이 표시를 직접 걷습니다 — `@lib` 의 `plainText` 한 벌을 쓰세요',
    );
  });
});

describe('⛔ 만들어 둔 길을 **화면이 부른다** (결함 264~268)', () => {
  const settings = (): string =>
    codeOf(readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Settings.tsx'), 'utf8'));

  it('⭐ 초대 코드에 **복사 단추**가 있다 (결함 264)', () => {
    /* 이 패널이 하는 일은 코드를 **남에게 보내는 것**인데 손으로 옮겨
       적어야 했습니다. `@lib/ui/copy.ts` 와 `codeToCopy` 는 진작 있었고
       레거시 화면은 부르고 있었습니다 — SPA 로 옮기며 빠진 자리입니다. */
    const code = settings();
    ok(/codeToCopy\(/.test(code), '표시용 글자를 복사하려 합니다 — 데이터에서 만드세요 (결함 71)');
    ok(/copyText\(/.test(code), '초대 코드 복사 단추가 없습니다');
    // ⚠️ **안 됐을 때 말하는가** (결함 81). `http://` 로 열면 클립보드가 없습니다.
    ok(/describeCopy\(/.test(code), '복사가 안 됐을 때 아무 말도 안 합니다');
  });

  it('⭐ 올린 **사진을 지울 자리**가 있다 (결함 265)', () => {
    const code = settings();
    ok(/avatarToShow\(/.test(code), '「지움」과 「안 고침」을 안 가릅니다');
    ok(
      /setAvatar\(''\)/.test(code),
      '사진을 지울 자리가 없습니다 — 올릴 수는 있고 내릴 수는 없는 상태입니다',
    );
  });

  it('⭐ **없는 구역 주소**에 말을 한다 (결함 266)', () => {
    ok(
      /unknownSectionNote\(/.test(settings()),
      '없는 구역이 백지입니다 — 고장인지 잘못 온 것인지 알 수 없습니다',
    );
  });

  it('⭐ 이미 고른 결정이 **고른 것으로 보인다** (결함 267)', () => {
    /* 「등록 표시됨」 뒤에도 「등록」 단추가 살아 있었고, 다시 눌러도
       요청이 안 나가고 화면도 안 바뀌었습니다. */
    const code = codeOf(
      readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Review.tsx'), 'utf8'),
    );
    const buttons = [...code.matchAll(/<button[\s\S]*?<\/button>/g)].map((m) => m[0]);
    for (const target of ['approve', 'reject']) {
      const decided = buttons.filter((btn) =>
        new RegExp(`decision:\\s*'${target}'`).test(btn),
      );
      ok(decided.length > 0, `「${target}」 단추를 못 찾았습니다 — 가드가 헛돕니다`);
      for (const btn of decided) {
        ok(
          /aria-pressed=/.test(btn),
          `이미 고른 뒤에도 그냥 살아 있습니다 (${target}) — 눌러도 아무 일이 안 일어납니다`,
        );
      }
    }
  });

  it('⭐ 회의에 **이름을 붙일 자리**가 있다 (결함 268)', () => {
    /* 「회의 열기」는 제목을 안 묻습니다. 서버에는 길이 있고 이미 연
       회의도 제목만은 고치게 허용하는데, 부르는 화면이 0곳이었습니다 —
       그래서 홈 목록에 「제목 없는 회의」가 쌓였습니다.

       ⚠️ 「열 때 물어볼 것인가」는 사람이 정할 일이라 여기서 재지
       않습니다. 재는 것은 **고칠 자리가 있는가**뿐입니다. */
    const lobby = codeOf(
      readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Lobby.tsx'), 'utf8'),
    );
    ok(/meetingTitleProblem\(/.test(lobby), '빈 이름을 그대로 보냅니다 — 서버가 400 을 줍니다');
    ok(/rename\.mutate\(/.test(lobby), '회의에 이름을 붙일 자리가 없습니다');
    const hooks = codeOf(readFileSync(join(ROOT, '..', 'webapp', 'src', 'api', 'hooks.ts'), 'utf8'));
    ok(
      /scheduled-meetings\/\$\{meetingId\}/.test(hooks),
      '이름 고치기가 서버까지 안 갑니다',
    );
  });
});

describe('⛔ 시킨 일을 **할 자리**가 있다 (결함 270·271)', () => {
  it('⭐ 참가하러 온 사람에게 **참가라는 이름의 손잡이**가 있다 (결함 270)', () => {
    /* 초대 코드로 막 들어온 사람이 되어 봤습니다. 가입을 마치면 빈 홈에
       떨어지는데, 화면은 「초대 코드로 참가하세요」라고 말하면서
       **누를 수 있는 것이 넷**(건너뛰기·홈·로그아웃·새 프로젝트)이고
       **입력칸은 0개**였습니다. 참가 칸은 「+ 새 프로젝트」 **안**에
       있는데, 그 단추 이름은 만드는 쪽만 말합니다 — 실패 ③ 그대로입니다.

       ⚠️ 문구도 두 벌이었습니다 — `@lib` 에 있는데 화면이 자기 것을 따로
       적었고, misdirect 하는 쪽은 화면의 것이었습니다(실패 ②). */
    const home = codeOf(
      readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Home.tsx'), 'utf8'),
    );
    ok(
      /emptyProjectsMessage\(\)/.test(home),
      '빈 홈 문구를 화면이 따로 적습니다 — `@lib` 한 벌을 쓰세요',
    );
    /* ⚠️ 처음에는 `setStarting('join')` 이라는 **이름**을 셌습니다. 손잡이
       배선을 `start('join')` 으로 바꿨더니(초점 되돌리기 때문에 — 결함
       280) 아무것도 안 없앴는데 이 가드가 깨졌습니다. 이름이 아니라
       **요구**를 잽니다: 「참가」라고 적힌 단추가 참가 쪽으로 연다. */
    const joinDoor = /<button[^>]*onClick=\{[^}]*'join'[^}]*\}[\s\S]{0,240}?참가/;
    ok(joinDoor.test(home), '참가하러 온 사람에게 참가라는 이름의 손잡이가 없습니다');
    // ⚠️ 손잡이만 있고 **초점이 안 가면** 코드 칸을 또 찾아야 합니다.
    ok(/autoFocus=\{focus === 'join'\}/.test(home), '참가로 열었는데 코드 칸에 초점이 안 갑니다');
  });

  it('⭐ 프로젝트 이니셜에 **마우스도 이름을 본다** (결함 271)', () => {
    /* 네모 안은 한 글자뿐입니다. 낭독기는 `aria-label` 로 전체 이름을 듣는데
       눈으로 보는 사람은 「신」 하나만 봤습니다 — 같은 글자로 시작하는
       프로젝트가 둘이면 구별이 안 됩니다.
       `RailItem.label` 의 주석이 **「툴팁·낭독기에 쓸 전체 이름」**이라고
       적혀 있었는데 툴팁 쪽이 배선 안 된 채였습니다(실패 ①). */
    const shell = codeOf(
      readFileSync(join(ROOT, '..', 'webapp', 'src', 'components', 'AppShell.tsx'), 'utf8'),
    );
    const rail = /<Link[\s\S]*?prail__item[\s\S]*?>/.exec(shell);
    ok(rail !== null, '프로젝트 이니셜을 못 찾았습니다 — 가드가 헛돕니다');
    ok(/aria-label=/.test(rail?.[0] ?? ''), '낭독기에 이름을 안 줍니다');
    ok(/title=/.test(rail?.[0] ?? ''), '마우스 쓰는 사람에게 이름을 안 줍니다');
  });
});

describe('⛔ 녹음이 **혼자 멈췄을 때**도 끝까지 간다 (결함 240·241)', () => {
  /* 회의 도중 누가 동의를 철회하면 서버는 청크마다 403 을 줍니다
     (`recording_service.store_chunk` 가 청크마다 동의를 다시 봅니다).
     그런데 화면은 그 거절을 **끊김으로 읽고** 계속 「녹음 중」이라고
     말했습니다 — 사람은 아무것도 안 담기는 회의를 끝까지 합니다.

     판단은 이미 다 있었습니다. `reduce` 의 `CONSENT/refused` 는
     `stopping` + `consent_revoked` 로 가고, `client.setConsent` 는 그때
     마이크를 끕니다. **아무도 안 불렀을 뿐입니다** — 대표 실패 ①. */
  const main = (): string =>
    codeOf(readFileSync(join(ROOT, 'src', 'demo', 'main.ts'), 'utf8'));

  it('⭐ 업로드가 **거절**당하면 서버 명부를 다시 읽는다', () => {
    const code = main();
    ok(/trackRefused\(/.test(code), '거절과 끊김을 안 가르고 있습니다');
    // ⚠️ 화면이 「철회됐다」고 **단정하면** 결함 229 로 돌아갑니다.
    //    거절을 보면 서버에 다시 물어야 합니다.
    const near = /trackRefused\([\s\S]{0,200}?refreshConsent\(/.test(code);
    ok(near, '거절을 보고도 명부를 다시 안 읽습니다 (또는 화면이 스스로 단정합니다)');
    ok(
      !/setConsent\(\s*'refused'/.test(code),
      '화면이 「철회됐다」를 스스로 넣고 있습니다 — 명부는 서버가 줍니다 (결함 229)',
    );
  });

  it('⭐ 마무리가 **「정지」 버튼 밖에서도** 불린다', () => {
    /* 스스로 멈춘 국면에서는 「정지」가 이미 비활성입니다(국면이
       `recording` 이 아니므로). 마무리가 그 버튼에만 매달려 있으면
       화면은 영영 「마무리 중」이고 결과도 커버리지도 안 나옵니다. */
    const code = main();
    /* ⚠️ 처음에는 `/finishRecording\(\)/` 를 셌습니다 — 그 조각은 **선언
       자체**(`async function finishRecording(): …`)에도 들어 있어서, 부르는
       곳을 통째로 지워도 2가 나왔습니다. 심어 보고 알았습니다. 부르는
       자리만 셉니다. */
    const calls = [...code.matchAll(/void\s+finishRecording\(\)/g)].length;
    ok(calls >= 2, `마무리를 부르는 곳이 ${calls}곳입니다 — 버튼 하나뿐이면 갇힙니다`);
    ok(
      /stopReason !== 'user'/.test(code),
      '스스로 멈춘 것과 사람이 멈춘 것을 안 가르고 있습니다',
    );
  });

  it('⭐ 다시 올렸으면 **판정을 다시 만들고 서버에 다시 알린다** (결함 244)', () => {
    /* 되찾은 조각을 반영 안 하면, 화면이 들고 있는 정지 순간의 비관이
       그대로 서버로 다시 가고 서버는 「클라이언트가 더 비관적이면 그쪽을
       존중한다」는 규칙에 따라 그 값을 저장합니다 — 소리는 다 돌아왔는데
       기록은 계속 「사용 불가」입니다. 실제로 그랬습니다(56.7% → 57.1%). */
    const code = main();
    const handler = /\$\('reupload'\)\.addEventListener\([\s\S]*?\n\}\);/.exec(code)?.[0] ?? '';
    ok(handler !== '', '재업로드 처리기를 못 찾았습니다');
    ok(/recomputeAfterRecovery\(/.test(handler), '되찾은 조각을 판정에 반영하지 않습니다');
    ok(/tellServerWeAreDone\(/.test(handler), '다시 올려 놓고 서버에 다시 안 알립니다');
  });

  it('⭐ 다시 올리기를 누르면 **무슨 일이 일어났는지 말한다** (결함 245)', () => {
    // 예전에는 실패한 seq 를 조용히 목록에 도로 넣기만 했습니다 — 화면이
    // 그대로라 사람은 "눌러도 아무 일도 안 일어난다" 고 읽습니다.
    const code = main();
    const handler = /\$\('reupload'\)\.addEventListener\([\s\S]*?\n\}\);/.exec(code)?.[0] ?? '';
    ok(/describeReupload\(/.test(handler), '누른 뒤 아무 말도 안 합니다');
    const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
    ok(/id="parked-note"/.test(html), '말할 자리가 마크업에 없습니다');
    ok(/id="parked-note"[^>]*role="status"/.test(html), '낭독기가 이 변화를 못 듣습니다');
  });

  it('⭐ 「연결이 돌아왔습니다」를 **빨강으로 말하지 않는다** (결함 243)', () => {
    const code = main();
    // 문구도 색조도 `@lib` 이 정합니다 — 화면은 넘기기만 합니다.
    ok(
      !/연결이 돌아왔습니다/.test(code),
      '화면이 재개 문구를 직접 짓고 있습니다 — 판단은 `@lib` 입니다',
    );
    ok(/describeResume\(/.test(code), '`describeResume` 를 안 부릅니다');
    /* ⚠️ `showNote` 의 기본값은 `bad` 입니다. 색조를 안 넘기면 좋은 소식이
       실패 빨강으로 뜹니다 — 줄 단위로 봅니다(괄호 안의 `)` 때문에
       정규식이 먼저 멈추는 함정을 결함 237 에서 겪었습니다). */
    const line = code
      .split('\n')
      .find((l) => l.includes('resumed.text'));
    ok(line !== undefined, '재개 알림을 안 띄웁니다');
    ok(/resumed\.tone/.test(line ?? ''), `색조를 안 넘깁니다: ${line?.trim()}`);
  });

  it('⭐ 공백 목록이 **내부 이름**을 안 띄운다 (결함 241)', () => {
    const code = main();
    // 어휘표는 `timeline.ts` 에 있었는데 한 줄 요약만 쓰고 목록은
    // `<code>chunk_lost</code>` 를 그대로 띄웠습니다.
    ok(
      !/\$\{g\.reason\}/.test(code),
      '공백의 까닭을 날것(`chunk_lost`)으로 띄웁니다 — `describeGapReason` 이 있습니다',
    );
    ok(/describeGapReason\(/.test(code), '어휘표를 안 부릅니다');
  });
});

describe('⛔ `aria-describedby` 가 **있는 것**을 가리킨다 (결함 234)', () => {
  /* 가리키는 id 가 없으면 낭독기에는 **아무 말도 안 됩니다** — 사유가
     없는 것보다 나쁩니다(있다고 믿게 되니까). 실제로 결함 234 를 고치다
     `profile-problem` 을 가리켜 놓고 그 자리를 안 만들었고, 화면에서
     사유가 `undefined` 로 나왔습니다. */
  const FILES = ['screens/Settings.tsx', 'screens/Review.tsx', 'screens/Kanban.tsx',
    'screens/Contributions.tsx', 'screens/Lobby.tsx', 'screens/Home.tsx'];

  for (const rel of FILES) {
    it(`⭐ ${rel} — 가리키는 id 가 다 있다`, () => {
      const code = readFileSync(join(ROOT, '..', 'webapp', 'src', ...rel.split('/')), 'utf8');
      // 문자열로 박힌 id 만 봅니다 — 변수로 만든 것은 여기서 못 봅니다.
      const pointed = new Set<string>();
      for (const m of code.matchAll(/aria-describedby=\{?['"]([\w-]+)['"]/g)) pointed.add(m[1] ?? '');
      for (const m of code.matchAll(/aria-describedby=\{[^}]*\?\s*['"]([\w-]+)['"]/g)) pointed.add(m[1] ?? '');
      for (const m of code.matchAll(/:\s*['"]([\w-]+)['"]\s*:\s*undefined/g)) pointed.add(m[1] ?? '');
      const defined = new Set([...code.matchAll(/\bid=['"]([\w-]+)['"]/g)].map((m) => m[1] ?? ''));
      const missing = [...pointed].filter((id) => id !== '' && !defined.has(id));
      ok(
        missing.length === 0,
        `${rel}: 없는 자리를 가리킵니다 — 낭독기에 아무 말도 안 됩니다: ${missing.join(', ')}`,
      );
    });
  }
});

describe('⛔ 검토 확정의 **답을 읽는다** (결함 233)', () => {
  /* 둘이 같은 회의를 검토하면 뒤에 누른 사람이 `approved_count: 0` 을
     받습니다(서버가 멱등이라). 그런데 화면이 그 숫자를 안 읽어서, 전부
     거절한 사람과 **글자 하나 다르지 않은** 문장을 봤습니다.

     그리고 확정 뒤 회의 상태를 다시 안 읽어서, 새로고침해야 「검토를
     마쳤습니다」가 나왔습니다. */
  const strip = (t: string): string =>
    t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const review = strip(readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Review.tsx'), 'utf8'))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
  const hooks = strip(readFileSync(join(ROOT, '..', 'webapp', 'src', 'api', 'hooks.ts'), 'utf8'));

  it('⭐ 「내가 몇 건을 승인 표시했는가」를 같이 넘긴다', () => {
    // 이것 없이는 `approved_count: 0` 의 뜻을 가를 수 없습니다.
    const call = /describeSubmitResult\(([\s\S]{0,220}?)\)\s*[,)]/.exec(review)?.[1] ?? '';
    ok(call.length > 0, 'describeSubmitResult 를 안 부릅니다');
    /* ⚠️ `/approve/` 로 쓰면 **`result.approved_count` 가 통과시킵니다** —
       그 낱말이 이미 인자 안에 있으니까요. 처음 이렇게 썼고, 인자를 지워도
       가드가 조용했습니다. `.approve` **필드**를 읽는지 봅니다. */
    ok(
      /\.approve\b/.test(call),
      'describeSubmitResult 에 승인 표시 건수를 안 넘깁니다 — 거절과 구별이 안 됩니다',
    );
  });

  it('⭐ 확정하면 **회의도 다시 읽는다** — 안 읽으면 옛 상태로 말한다', () => {
    const body = /candidates\/review[\s\S]{0,700}?\n  \}\)/.exec(hooks)?.[0] ?? '';
    ok(body.length > 0, '검토 확정 훅을 못 찾았습니다 — 가드가 낡았습니다');
    ok(
      /invalidateQueries\(\{\s*queryKey:\s*\['meetings',\s*meetingId\]\s*\}\)/.test(body),
      '확정 뒤 회의를 다시 안 읽습니다 — 화면이 옛 상태로 말합니다',
    );
  });
});

describe('⛔ 검토 화면이 **회의 상태를 본다** (결함 232)', () => {
  /* 후보를 셋 다 확정하고 「검토 끝내기」를 누른 직후의 화면이 이랬습니다:

         업무 후보 0건        결정한 후보가 없습니다   [검토 끝내기]
         검토할 후보가 없습니다 — 회의 처리가 끝나면 AI 초안이 여기 올라옵니다.

     결정을 **셋이나** 했고, 처리는 **이미 끝났습니다**(회의 상태
     `confirmed`, 서버가 `approved_task_ids:[5,6,7]` 을 돌려줬습니다).
     화면이 `candidates.length === 0` 만 보고 **상태를 안 봤습니다** —
     「아직 안 왔다」와 「다 처리했다」가 같은 문장을 받았습니다. */
  const review = readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Review.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');

  it('⭐ 빈 상태 문구를 화면이 **직접 짓지 않는다** — 판단은 `@lib`', () => {
    ok(/reviewPhase\(/.test(review), '검토 화면이 reviewPhase 를 안 부릅니다');
    ok(
      !/회의 처리가 끝나면/.test(review),
      '화면이 빈 상태 문구를 직접 적었습니다 — 상태를 안 보는 문장이 됩니다',
    );
    ok(
      !/결정한 후보가 없습니다['"`]/.test(review) || /describeReviewDone\(/.test(review),
      '끝난 회의에도 「결정한 후보가 없습니다」라고 합니다',
    );
    /* ⚠️ **위 두 줄은 「문장을 안 적었는가」만 봅니다** — 화면이 그 판단을
       **부르기는 하는가**는 안 봤습니다. 그래서 「검토 끝내기」가 막힌
       사유를 화면이 직접 짜고 있었고, 후보가 **처음부터 0건**인 회의에게
       「결정한 후보가 없습니다」라고 하는 갈래가 그 안에 조용히 남아
       있었습니다(결함 366). 부르는 것까지 봅니다. */
    ok(
      /whyCannotFinishReview\(/.test(review),
      '「왜 못 끝내나」를 화면이 직접 짜고 있습니다 — 판단은 `@lib` 에 (`whyCannotFinishReview`)',
    );
    ok(
      !/건이 아직 처리되지 않았습니다/.test(review),
      '화면이 사유 문장을 다시 적고 있습니다 — 문장은 `@lib` 한 곳에만',
    );
    /* 끝낼 검토가 없는 회의에서는 단추를 **안 그립니다** (결함 366 · 362).
       그리면 사유 칸과 빈 상자가 같은 문장을 두 번 그립니다. */
    ok(
      /showsFinishReview\(lanes\)/.test(review),
      '끝낼 검토가 없어도 「검토 끝내기」를 그립니다 — 판단은 `@lib` 의 `showsFinishReview`',
    );
  });

  it('⭐ 빈 목록의 사유는 **상태마다 다르다** — 「결정한 후보가 없습니다」가 아니라', () => {
    /* 서버는 후보가 처음부터 0건인 회의를 **일부러** `confirmed` 로 안
       옮깁니다(결함 84). 그 상태는 영영 안 바뀌므로, 「결정하라」고 하면
       할 자리가 없는 일을 시키는 것입니다(실패 ③). */
    const EMPTY = { total: 0, pending: 0, approving: 0, rejecting: 0, blocked: 0, needsAttention: 0 };
    const NO_LANES = { all: 0, pending: 0, approve: 0, reject: 0 };
    const blaming: string[] = [];
    for (const status of ['pending', 'queued', 'processing', 'needs_review', 'failed']) {
      const why = whyCannotFinishReview({ status, lanes: NO_LANES, summary: EMPTY });
      if (why !== reviewPhase(status).emptyNote) blaming.push(`${status}: ${why}`);
    }
    deepStrictEqual(
      blaming,
      [],
      `빈 목록인데 「왜 비었는지」를 안 말하는 상태가 있습니다:\n  ${blaming.join('\n  ')}`,
    );
  });

  it('⭐ 끝난 회의에서 **간 곳을 가리킨다** — 업무가 어디로 갔는지', () => {
    // 업무 셋이 칸반으로 갔는데 화면 어디에도 그 말이 없었습니다 (실패 ③).
    /* ⚠️ **`phase.go` 를 언급하는지만 보면 안 됩니다.** 처음 이 가드는
       그렇게 썼고, 조건을 `{false && …}` 로 바꿔 **죽은 가지**로 만들어도
       통과했습니다 — 결함 231 가드에서 겪은 것과 같은 약점입니다.
       **그 값으로 실제로 가르는지**를 봅니다. */
    ok(
      /phase\.go\s*!==\s*null\s*&&/.test(review),
      '검토 화면이 phase.go 로 가르지 않습니다 — 그리는 자리가 죽어 있을 수 있습니다',
    );
    ok(/kanban/.test(review), '칸반으로 가는 자리가 없습니다');
  });
});

describe('⛔ 처리에 실패한 회의에서 나갈 자리 (결함 231)', () => {
  /* 결함 114 가 `failed` 라는 막다른 길을 열었습니다 — 서버에
     `/reprocess` 가 생기고, `progress` 가 `can_reprocess` 로 **언제 다시
     할 수 있는지**를 답합니다.

     그런데 로비가 SPA 로 옮겨질 때 **버튼이 안 따라왔습니다.**

         레거시 lobby.html : 「다시 처리하기」 있음
         SPA  /app/…/lobby : 없음  ← 사람이 실제로 쓰는 화면

     그 화면은 「처리에 실패했습니다. 아래 트랙이 온전한지 확인하세요」
     라고 **시켜 놓고**, 확인한 사람에게 누를 것을 안 줬습니다 — 이
     저장소의 실패 ③ 이 결함 114 를 고친 자리에서 다시 났습니다. */
  const lobby = readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Lobby.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');

  it('⭐ SPA 로비가 다시 처리할 자리를 주고, 그 자리가 **실제로 부른다**', () => {
    ok(/useReprocess\(/.test(lobby), 'SPA 로비가 다시 처리를 안 부릅니다 — 막다른 길입니다');
    ok(/다시 처리하기/.test(lobby), '누를 것이 없습니다');
    /* ⚠️ **버튼이 있는지만 보면 안 됩니다.** 처음 이 가드는 `useReprocess`
       와 낱말만 봤고, 그래서 `reprocess.mutate()` 를 지워도 통과했습니다 —
       "만들어 놓고 아무도 안 부름" 을 가드가 그대로 허용한 것입니다.
       심어서 확인했습니다. */
    ok(
      /reprocess\.mutate\(/.test(lobby),
      '버튼은 있는데 아무것도 안 부릅니다 — 눌러도 아무 일이 안 일어납니다',
    );
  });

  it('⭐ **언제** 할 수 있는지는 서버가 정한다 — 화면이 상태로 정하지 않는다', () => {
    // 화면이 `status` 를 보고 스스로 정하면 규칙이 두 곳에 생기고
    // 한쪽만 고쳐집니다 (API 의 `can_reprocess` 주석이 적어 둔 이유).
    ok(/can_reprocess/.test(lobby), 'SPA 로비가 can_reprocess 를 안 봅니다');
    ok(
      !/status\s*===\s*['"`]failed/.test(lobby),
      '화면이 status 로 다시 처리 가능 여부를 정합니다 — 판단은 서버 한 곳',
    );
  });

  it('⛔ 되돌릴 수 없는 일이라 **묻는다** — 두 로비가 같은 말로', () => {
    // 앞판의 발화·후보·결정이 지워집니다. 각자 짓게 두면 한쪽에서만
    // 경고가 뜹니다 (실패 ②).
    const legacy = readFileSync(join(ROOT, 'src', 'demo', 'lobby.tsx'), 'utf8');
    for (const [rel, code] of [
      ['webapp Lobby.tsx', lobby],
      ['demo/lobby.tsx', legacy],
    ] as [string, string][]) {
      ok(/REPROCESS_CONFIRM/.test(code), `${rel}: 확인 문구를 @lib 에서 안 가져옵니다`);
      /* ⚠️ **`confirm(` 전부를 막으면 안 됩니다.** 레거시 로비에는
         `forceFinish`(참가 안 한 사람을 두고 끝내기)라는 **다른** 확인이
         있고, 그건 여기서 묻는 것과 아무 상관이 없습니다. 처음에 넓게
         잡았다가 그 확인을 잡았습니다 — 요구는 "다시 처리 문구가 두
         벌이 아닌가" 입니다. */
      ok(
        !/이 회의를 처음부터 다시 처리합니다/.test(code),
        `${rel}: 다시 처리 문구를 화면이 직접 적었습니다 — 두 벌이 됩니다`,
      );
    }
  });
});

describe('⛔ 녹음 화면이 동의를 **스스로 선언하지 않는다** (결함 229)', () => {
  /* `docs/07` §1: 제3자 녹음은 형사처벌 대상입니다. 그래서
     `session.blockers` 에 「녹음 동의가 필요합니다」 갈래가 있고 검사도
     붙어 있습니다.

     그런데 녹음 화면이 그 갈래를 **건너뛰고 있었습니다.**

         $('consent').addEventListener('click', () => {
           client.setConsent('all_confirmed');   // ← 화면이 스스로
         });

     서버에는 동의 명부가 이미 있고(`GET /api/meetings/{id}/consent`)
     로비가 그걸 씁니다. 녹음 화면만 안 물어봤습니다 — 실패 ①.

     재현: 아무도 동의 안 한 회의에서 혼자 그 단추를 누르면 막는 이유가
     전부 사라지고 「준비됐습니다」가 되며, 녹음이 실제로 돌았습니다
     (청크 1개). 서버는 403 으로 막지만 그 말은 화면 다른 줄에 있습니다. */
  const main = readFileSync(join(ROOT, 'src', 'demo', 'main.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  it('⛔ 화면이 동의 상태를 **글자로** 넣지 않는다', () => {
    ok(
      !/setConsent\(\s*['"`]/.test(main),
      '녹음 화면이 동의 상태를 글자로 넣습니다 — 서버 명부를 읽어야 합니다',
    );
  });

  it('⭐ 판단은 `@lib` 의 `consentStateFrom` 이 한다', () => {
    ok(/consentStateFrom\(/.test(main), 'main.ts 가 consentStateFrom 을 안 부릅니다');
  });

  it('⭐ 서버의 동의 명부를 **실제로 읽는다**', () => {
    ok(
      /\/consent(`|'|")/.test(main),
      'main.ts 가 동의 명부(/consent)를 안 읽습니다 — 만들어 놓고 아무도 안 부르는 것',
    );
  });

  it('⭐ 동의가 없으면 **동의할 자리로 보낸다** — 말만 하지 않는다', () => {
    const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, ' ');
    ok(
      /<a[^>]*id="consent"/.test(html),
      '동의할 자리가 링크가 아닙니다 — 눌러도 갈 데가 없으면 실패 ③ 입니다',
    );
    ok(/lobby/.test(main), 'main.ts 가 로비 주소를 안 만듭니다');
  });
});

describe('⛔ 세션이 죽으면 사람을 로그인 화면으로 보낸다 (결함 227)', () => {
  /* 세션이 끊긴 화면은 「로그인이 풀렸습니다. 다시 로그인해 주세요.」 라고
     말하는데, 그 화면에 **로그인으로 가는 링크가 한 개도 없습니다.**
     길잡이(홈·칸반·설정)를 눌러도 라우터가 같은 껍데기 안에서 옮길 뿐이라,
     화면 넷을 36초 동안 눌러 다녀도 그대로였습니다.

     이 저장소의 실패 ③ — **할 일을 알려 주고 그 일을 할 자리를 안 줌.**

     ⚠️ 화면 다섯이 각자 로그인 링크를 그리게 하면 반드시 몇 곳이 빠집니다
        (실패 ②). 실패를 **한 자리에서** 받는 것이 요구입니다. */
  const main = readFileSync(join(ROOT, '..', 'webapp', 'src', 'main.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  /** `new X({ … })` 의 인자 안쪽만 — 옆집 것을 보고 통과하지 않게 (결함 225). */
  function ctorArgs(source: string, ctor: string): string[] {
    const out: string[] = [];
    for (const m of source.matchAll(new RegExp(`new\\s+${ctor}\\(`, 'g'))) {
      let depth = 0;
      let i = (m.index ?? 0) + m[0].length - 1;
      const start = i + 1;
      for (; i < source.length; i += 1) {
        if (source[i] === '(') depth += 1;
        else if (source[i] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      out.push(source.slice(start, i));
    }
    return out;
  }

  for (const cache of ['QueryCache', 'MutationCache']) {
    it(`⭐ ${cache} 의 실패를 받는다 — 안 받으면 그 401 은 아무 데도 안 닿는다`, () => {
      const args = ctorArgs(main, cache);
      ok(args.length > 0, `main.tsx 에 new ${cache}( 가 없습니다`);
      ok(
        args.some((a) => /onError/.test(a)),
        `new ${cache}( 에 onError 가 없습니다 — 401 이 아무 데도 안 닿습니다`,
      );
    });
  }

  it('⭐ 판단은 `@lib` 에서 온다 — main.tsx 에 401 을 적지 않는다', () => {
    // main.tsx 에는 자동 검사가 안 붙습니다. 여기서 상태 코드를 직접
    // 비교하면 그 판단은 검증 밖으로 나갑니다.
    ok(/sessionIsOver\(/.test(main), 'main.tsx 가 sessionIsOver 를 안 부릅니다');
    ok(
      !/status\s*===\s*401/.test(main),
      'main.tsx 가 401 을 직접 비교합니다 — 판단은 @lib/ui/load.ts 한 곳',
    );
  });

  it('⭐ 세션이 끝나면 `me` 를 지운다 — 그래야 RequireAuth 가 내보낸다', () => {
    // 말만 하고 아무 값도 안 바꾸면 화면은 그대로 살아 있습니다.
    ok(
      /setQueryData\(\s*\['me'\]\s*,\s*null\s*\)/.test(main),
      "main.tsx 가 `me` 를 null 로 안 바꿉니다 — RequireAuth 가 못 내보냅니다",
    );
  });
});

describe('⛔ 「잴 수 없음」을 0 으로 접지 않는다 (결함 226)', () => {
  /* 기여도 화면 둘은 `uncertaintySpans()` 가 준 폭을 그립니다. 그 폭은
     **`null` 일 수 있고**(몫이 0 이라 서버의 구간이 접힌 경우), `null` 은
     0 이 아니라 **잴 수 없음** 입니다.

     `?? 0` 한 글자면 그것이 0 이 되고, 0 은 화면에서 이렇게 나옵니다:

         구간이 없습니다 — 이 값은 확정적입니다

     바로 윗줄에 「신뢰도 낮음」이 있는데도. 실제로 두 화면 다 `?? 0` 이었고,
     이 검사를 쓰다가 **검사 자신도** 처음에 `?? 0` 을 썼습니다.

     ⚠️ 낱말이 아니라 **요구**를 잽니다 — "폭을 span 에서 꺼내는 그 식에
     숫자 기본값이 없는가". */
  const SCREENS: [string, string][] = [
    ['webapp/src/screens/Contributions.tsx', join(ROOT, '..', 'webapp', 'src', 'screens', 'Contributions.tsx')],
    ['frontend/src/demo/contributions.tsx', join(ROOT, 'src', 'demo', 'contributions.tsx')],
  ];

  for (const [rel, path] of SCREENS) {
    it(`⭐ ${rel} 이 폭을 숫자로 접지 않는다`, () => {
      const code = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
      // 폭을 꺼내는 식 한 줄. 이름이 아니라 **`.points` 를 읽는 곳**을 찾습니다.
      const lines = code.split('\n').filter((l) => /\.points\b/.test(l));
      ok(lines.length > 0, `${rel}: \`.points\` 를 읽는 곳이 없습니다 — 검사가 낡았습니다`);
      for (const line of lines) {
        ok(
          !/\?\?\s*0\b/.test(line),
          `${rel}: 폭에 \`?? 0\` 이 붙어 있습니다 — 잴 수 없음이 "확정" 이 됩니다\n    ${line.trim()}`,
        );
      }
    });
  }

  it('⭐ 화면이 「확정적」 문구를 **직접** 짓지 않는다 — 판단은 lib 한 곳', () => {
    for (const [rel, path] of SCREENS) {
      // ⚠️ **주석을 먼저 걷어냅니다.** 안 걷으면 이 결함을 설명하는 주석이
      //    스스로 걸립니다 — 실제로 처음에 그렇게 걸렸습니다.
      const code = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
      ok(
        !/['`"][^'`"]*확정적/.test(code),
        `${rel}: 화면이 「확정적」을 직접 적었습니다 — \`uncertaintyDotsNote\` 가 정합니다`,
      );
    }
  });
});

describe('통화 화면이 **아는 것만** 말한다 (결함 216)', () => {
  const call = readFileSync(join(ROOT, 'src', 'demo', 'call.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  it('⭐ 녹음 여부를 **박아 두지 않는다** — 통화에 있는 것과 녹음이 도는 것은 다르다', () => {
    // 내 타일에 `<span class="state ok">이 기기에서 녹음됩니다</span>` 가
    // **조건 없이** 있었습니다. 아무것도 안 남는데 남는다고 말했고, 이
    // 제품에서 녹음이 한 번 끊기면 그 구간은 영영 못 잽니다.
    ok(!/이 기기에서 녹음됩니다/.test(call), '녹음 문구가 아직 화면에 박혀 있습니다');
    ok(/describeMyCapture\(/.test(call), '녹음 상태 판단을 안 씁니다');
    // ⚠️ **묻는 곳이 있어야 압니다.** 판단을 불러도 값이 언제나
    //    `undefined` 면 "아직 녹음 안 함" 을 단언하는 것이고, 그건 반대
    //    방향의 같은 거짓말입니다.
    ok(
      /\/tracks`\)/.test(call) || /\/tracks'\)/.test(call),
      '트랙을 물어보는 곳이 없습니다 — 안 묻고는 알 수 없습니다',
    );
    ok(/setInterval\(\(\) => void pollMyTrack\(\)/.test(call), '한 번만 묻고 말면 도중에 시작한 녹음을 못 봅니다');
  });

  it('⚠️ 못 물어봤을 때 「아직 녹음 안 함」 으로 뒤집지 않는다', () => {
    // 한 번 실패했다고 값을 지우면, **녹음 중인 사람에게 안 되고 있다고**
    // 말하게 됩니다. 이 저장소의 "측정 불가 ≠ 0" 과 같은 자리입니다.
    const poll = /async function pollMyTrack\(\)[\s\S]*?\n}/.exec(call)?.[0] ?? '';
    ok(poll !== '', '`pollMyTrack` 이 없습니다');
    ok(
      /if \(response === null \|\| !response\.ok\) return;/.test(poll),
      '요청이 실패해도 값을 건드립니다',
    );
  });

  it('⭐ 마이크 상태를 **한 곳에서** 그린다 — 두 곳이면 갈라진다', () => {
    // 상태줄은 `openMic()` 이 한 번 쓰고, 토글은 버튼 글자만 바꿨습니다.
    // 그래서 껐는데 상태줄이 「마이크가 켜졌습니다」였습니다.
    ok(/function paintMic\(\)/.test(call), '마이크를 그리는 자리가 한 곳이 아닙니다');
    ok(/describeMic\(/.test(call), '마이크 문장 판단을 안 씁니다');
    // 토글이 **그 자리를 부르는가** — 낱말이 아니라 호출을 봅니다.
    const toggle = /\$\('mic-toggle'\)\.addEventListener\('click'[\s\S]*?\n\}\);/.exec(call)?.[0] ?? '';
    ok(toggle !== '', '토글 처리기를 못 찾았습니다');
    ok(/paintMic\(\);/.test(toggle), '토글이 상태줄을 다시 안 그립니다 — 껐는데 켜졌다고 말합니다');
    ok(
      !/\$\('mic'\)/.test(toggle),
      '토글이 상태줄을 직접 씁니다 — 같은 사실을 두 곳에서 쓰면 갈라집니다',
    );
  });
});

describe('검토하던 것을 새로고침에 잃지 않는다 (결함 217)', () => {
  const review = readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Review.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');

  it('⭐ 되살리고 · 남기고 · 확정하면 지운다 — 셋 다 있어야 한다', () => {
    // 재서 확인한 것: 담당자를 고르면 **나간 요청 0건**(맞습니다, 검토는
    // 한 번에 확정하는 절차입니다)이고 새로고침하면 「미지정」으로
    // 돌아가며 **경고도 0건**이었습니다.
    ok(/parseDrafts\(sessionStorage\.getItem\(/.test(review), '저장된 초안을 안 읽습니다');
    ok(
      /sessionStorage\.setItem\(draftStorageKey\(meetingId\), serializeDrafts\(next\)\)/.test(review),
      '초안을 안 남깁니다',
    );
    ok(/sessionStorage\.removeItem\(draftStorageKey\(/.test(review), '확정한 뒤에도 초안이 남습니다');
    // ⚠️ **`clearDrafts()` 를 정의만 하고 안 부르면** 다음에 이 회의를
    //    열었을 때 이미 처리된 결정이 되살아난 것처럼 보입니다. 호출을
    //    봅니다 — 정의는 위에서 이미 셌습니다.
    ok(/^\s*clearDrafts\(\);\s*$/m.test(review), '확정 성공 처리에서 초안을 안 지웁니다');
  });

  it('⚠️ **바꿀 때마다** 남긴다 — 「나갈 때 저장」 은 탭이 죽으면 안 돈다', () => {
    // 잃으면 안 되는 순간이 바로 그 순간입니다.
    const update = /const update = \(id: number, patch: Partial<Draft>\) => \{[\s\S]*?\n  \};/.exec(review)?.[0] ?? '';
    ok(update !== '', '`update` 를 못 찾았습니다');
    ok(/sessionStorage\.setItem\(/.test(update), '값을 바꿀 때 안 남깁니다');
    ok(
      !/beforeunload/.test(review),
      '나갈 때만 남기고 있습니다 — 브라우저가 탭을 죽이면 그 경로는 안 돕니다',
    );
  });

  it('⛔ `localStorage` 를 쓰지 않는다 — 몇 주 전 초안이 되살아나면 잃는 것보다 나쁘다', () => {
    // 사람은 그게 오래된 값인 줄 모르고 그대로 확정합니다.
    ok(!/localStorage/.test(review), '검토 초안을 영구 보관하고 있습니다');
  });

  it('⭐ **지금 있는 후보**에만 되살린다 — 그 사이에 처리된 것은 뜻이 없다', () => {
    ok(/const liveIds = useMemo\(\(\) => candidates\.map\(/.test(review), '거를 기준을 안 만듭니다');
    ok(
      /useDraftMap\(meetingId, liveIds\)/.test(review),
      '거를 기준을 안 넘깁니다 — 처리된 후보의 초안이 되살아납니다',
    );
  });
});

describe('보낸 것이 실패하면 **화면이 말한다** (결함 218)', () => {
  /**
   * ⚠️ 이 검사는 **한 곳을 고치는 것이 아니라 모양 전체를 훑습니다.**
   *
   * 검토 화면에서 하나를 찾고(「검토 끝내기」가 500 을 받아도 화면 글자가
   * 한 글자도 안 바뀜) 같은 모양을 다 훑었더니 **둘이 더 있었습니다** —
   * 로비의 「회의 강제 종료」와 설정의 「지난 활동 가져오기」. 셋 다
   * 브라우저로 500 을 받게 해서 확인했습니다.
   *
   * 실패를 말하는 길은 두 가지고, **둘 중 하나만 있으면 됩니다**:
   *   ① `mutate(…, { onError })` 로 그 자리에서 문장을 만들거나
   *   ② `<이름>.isError` 를 그려서 화면이 알아서 나타나게 하거나
   */
  /**
   * `<이름>.mutate(…)` 의 **인자 문자열들**. 괄호를 세서 짝을 찾습니다 —
   * 글자 수로 자르면 옆 호출까지 삼킵니다 (결함 225 가 그렇게 샜습니다).
   */
  function callArgsOf(source: string, caller: string): string[] {
    const escaped = caller.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const opener = new RegExp(`${escaped}\\.mutate(?:Async)?\\(`, 'g');
    const out: string[] = [];
    for (const m of source.matchAll(opener)) {
      let depth = 0;
      let i = (m.index ?? 0) + m[0].length - 1;
      const start = i + 1;
      for (; i < source.length; i += 1) {
        if (source[i] === '(') depth += 1;
        else if (source[i] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      out.push(source.slice(start, i));
    }
    return out;
  }

  it('⭐ 모든 mutate 에 말할 자리가 있다', () => {
    const base = join(ROOT, '..', 'webapp', 'src');
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.tsx')) continue;
        const code = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/\/\/[^\n]*/g, ' ');

        // `foo.mutate(` · `m.finish.mutate(` 같은 부르는 이름들.
        const callers = new Set(
          [...code.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\.mutate(?:Async)?\(/g)].map(
            (m) => m[1] as string,
          ),
        );
        for (const caller of [...callers].sort()) {
          // ⚠️ **`onError` 라는 낱말이 파일 어딘가에 있는가**로 재면, 다른
          //    mutate 의 `onError` 하나로 전부 통과합니다. **이 호출에**
          //    붙어 있는지를 봅니다.
          //
          // ⚠️⚠️ 처음에는 "호출 뒤 600자 안" 으로 쟀는데, 그것도
          //    **옆 호출의 `onError` 를 봤습니다** — 설정 화면의 `rotate`
          //    가 실패를 말할 자리가 없는데도 통과했습니다(결함 225).
          //    괄호를 세서 **그 호출의 인자 안**만 봅니다.
          const hasOnError = callArgsOf(code, caller).some((args) => /onError/.test(args));
          const shows = code.includes(`${caller}.isError`) || code.includes(`${caller}.error`);
          if (!hasOnError && !shows) {
            offenders.push(`${full.slice(base.length + 1)} — ${caller}`);
          }
        }
      }
    };
    walk(base);

    strictEqual(
      offenders.join('\n  '),
      '',
      '실패해도 화면이 아무 말도 안 하는 곳입니다 — 사람은 됐다고 믿고 떠납니다',
    );
  });
});

describe('레거시 화면의 `<a class="btn">` 도 **언제나** 주소가 있다 (결함 238)', () => {
  /**
   * 결함 219 의 가드는 `webapp/src/**\/*.tsx` 만 걷습니다. 녹음 화면은
   * `public/index.html` + `src/demo/main.ts` 라 **그 빗자루가 안 닿는
   * 자리**였고, 거기 `<a id="consent" class="btn">동의하러 로비로</a>` 가
   * href 없이 서 있었습니다 — 눈에는 단추, 탭으로는 없는 것, 눌러도
   * 아무 일도 안 일어나는 것.
   *
   * 요구는 같습니다: **주소가 조건부면 막혔을 때 닿지 못한다.**
   */
  it('⭐ 마크업에 href 가 없으면 화면 코드가 **조건 없이** 넣는다', () => {
    const screens = readdirSync(join(ROOT, 'public'))
      .filter((f) => f.endsWith('.html'))
      .map((f) => f.replace(/\.html$/, ''));

    let checked = 0;
    for (const screen of screens) {
      // ⚠️ 주석을 먼저 걷습니다 — 주석 속 나쁜 예가 진짜 태그 행세를 합니다.
      const html = readFileSync(join(ROOT, 'public', `${screen}.html`), 'utf8').replace(
        /<!--[\s\S]*?-->/g,
        '',
      );
      // 녹음 화면만 파일 이름이 다릅니다 (`index` → `main.ts`).
      const script = join(ROOT, 'src', 'demo', screen === 'index' ? 'main.ts' : `${screen}.ts`);
      if (!existsSync(script)) continue;
      const code = codeOf(readFileSync(script, 'utf8'));

      for (const m of html.matchAll(/<a\b([^>]*)>/g)) {
        const attrs = m[1] ?? '';
        if (/\bhref=/.test(attrs)) continue;
        const id = /\bid="([\w-]+)"/.exec(attrs)?.[1];
        if (id === undefined) continue;

        // 이 id 의 href 를 넣는 자리
        const at = new RegExp(`\\$\\('${id}'\\)[^\\n]*\\)\\.href\\s*=`).exec(code);
        ok(at !== null, `${screen}.html #${id} — href 를 넣는 곳이 없습니다`);
        // ⚠️ **중괄호 깊이 0** 이어야 조건 없이 도는 자리입니다. 결함 238
        //    에서는 이 줄이 `if (meetingId) {` 안에 있었습니다.
        const before = code.slice(0, at.index);
        const depth = (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
        strictEqual(depth, 0, `${screen}.html #${id} — href 가 조건부입니다 (깊이 ${depth})`);
        checked += 1;
      }
    }
    ok(checked > 0, 'href 없는 `<a id>` 를 하나도 안 봤습니다 — 검사가 헛돕니다');
  });
});

describe('막힌 것에 **키보드로 닿는다** (결함 219)', () => {
  /**
   * 이 저장소는 「아직 안 됨」 을 `disabled` 가 아니라 `aria-disabled` 로
   * 표시합니다 — **초점을 받고 사유를 읽히게 하려고**요(AGENTS.md). 그런데
   * 그 사유를 가리키는 두 곳이 초점을 못 받고 있었습니다:
   *
   *   로비 「녹음 화면으로」  `<a>` 인데 막히면 `href` 를 안 줌
   *                          → 탭 **60번** 눌러도 안 닿음
   *   레일의 막힌 항목        `<span role="link">` 인데 `tabIndex` 없음
   *                          → 탭 **40번** 눌러도 안 닿음
   *
   * 닿지 못하면 `aria-describedby` 가 가리키는 사유를 **낭독기가 영영 못
   * 읽습니다.** 약속이 그 사람들에게만 거짓이었습니다.
   */
  it('⭐ `aria-disabled` 를 단 것은 초점을 받을 수 있어야 한다', () => {
    // ⚠️ **두 뿌리를 다 걷습니다** (결함 413). 이 가드는 오래도록
    //    `webapp/src` 만 걸었고, 그동안 레거시 셸의 막힌 탭 셋이
    //    `href` 도 `tabindex` 도 없이 **초점을 아예 못 받는** 채였습니다
    //    — `focus()` 를 직접 불러도 안 잡혔습니다. 결함 286 이 적어 둔
    //    「걷는 자리가 한쪽뿐인지 보십시오」 그대로입니다.
    const roots = [join(ROOT, '..', 'webapp', 'src'), join(ROOT, 'src', 'demo')];
    const offenders: string[] = [];
    const seen: Record<string, number> = {};

    const walk = (base: string, dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(base, full);
          continue;
        }
        if (!entry.name.endsWith('.tsx')) continue;
        if (entry.name.endsWith('.test.tsx')) continue;
        // ⚠️ **주석을 먼저 걷어냅니다.** 안 걷으면 여는 태그 사이에 낀
        //    주석의 `<a>` 같은 글자에서 `>` 를 만나 **태그가 잘립니다** —
        //    고친 코드를 위반이라고 했습니다. 규칙이 아니라 재는 법이
        //    틀린 것이었고, 이 저장소가 이미 여러 번 당한 자리입니다.
        const code = readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
        // ⚠️ `<button>` 은 기본으로 초점을 받습니다. 문제는 `<a>` 와
        //    `<span role="…">` 처럼 **직접 줘야 하는 것**들입니다.
        for (const m of code.matchAll(/<(a|span|div)\b[^>]*aria-disabled[^>]*>/gs)) {
          const tag = m[0];
          if (/tabIndex/.test(tag)) continue;
          // `<a href="…">` 처럼 **언제나** 주소가 있으면 초점을 받습니다.
          // 조건부(`? … : undefined`)면 막혔을 때 못 받습니다.
          if (m[1] === 'a' && /href=["'{][^>]*/.test(tag) && !/undefined/.test(tag)) continue;
          offenders.push(`${full.slice(base.length + 1)} — <${m[1]} aria-disabled …>`);
        }
        seen[base] = (seen[base] ?? 0) + [...code.matchAll(/aria-disabled/g)].length;
      }
    };
    for (const base of roots) walk(base, base);

    // ⚠️ **안 보고 있는 상태 자체가 실패입니다** (결함 286). 한 뿌리에서
    //    한 건도 못 봤으면 자가 낡은 것입니다.
    for (const base of roots) {
      ok((seen[base] ?? 0) > 0, `${base} 에서 aria-disabled 를 하나도 못 봤습니다 — 자가 낡았습니다`);
    }

    strictEqual(
      offenders.join('\n  '),
      '',
      '막혔는데 탭으로 닿을 수 없습니다 — 사유가 있어도 낭독기가 못 읽습니다',
    );
  });

  /*
   * ⚠️ **자가 못 보는 것**: 위 검사는 JSX 여는 태그를 정규식으로 읽으므로
   *    레거시 셸(`demo/nav.ts`)처럼 **문자열을 이어 붙여** 만드는 마크업은
   *    구조적으로 못 봅니다. 그 자리는 아래에서 요구로 잽니다.
   */
  describe('레거시 셸의 막힌 탭 (결함 413)', () => {
    const nav = () =>
      codeOf(readFileSync(join(ROOT, 'src', 'demo', 'nav.ts'), 'utf8'));

    it('⭐ 막힌 탭에 **초점을 준다** — `<a>` 는 `href` 가 없으면 못 받는다', () => {
      const code = nav();
      ok(
        /aria-disabled="true"/.test(code),
        '막힌 탭을 못 찾았습니다 — 가드가 낡았습니다',
      );
      ok(
        /tabindex="0"/.test(code),
        '막힌 탭이 초점을 못 받습니다 — 키보드로는 있는지도 모릅니다',
      );
    });

    it('⛔ 사유가 `title` **에만** 있지 않다 — 가리키는 자리도 실제로 그린다', () => {
      const code = nav();
      ok(
        /aria-describedby="\$\{escapeHtml\(whyId\(/.test(code),
        '막힌 탭이 사유를 가리키지 않습니다 — 마우스에만 남습니다',
      );
      // 가리키기만 하고 안 그리면 낭독기는 아무 말도 안 읽습니다.
      ok(
        /<p id="\$\{escapeHtml\(whyId\(/.test(code),
        '가리키는 자리를 안 그립니다 — `aria-describedby` 가 허공을 가리킵니다',
      );
    });
  });

  it('⚠️ 사유가 `title` **에만** 있지 않다 — 마우스를 올릴 수 있는 사람만 본다', () => {
    const shell = readFileSync(join(ROOT, '..', 'webapp', 'src', 'components', 'AppShell.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ');
    const blocked = /<span[\s\S]*?rail__item--blocked[\s\S]*?>/.exec(shell)?.[0] ?? '';
    ok(blocked !== '', '막힌 레일 항목을 못 찾았습니다');
    ok(/aria-describedby=/.test(blocked), '사유를 낭독기가 읽을 길이 없습니다');
    ok(
      /id="rail-blocked-why"/.test(shell),
      '가리키는 자리가 실제로 없습니다 — 가리키기만 하면 아무 말도 안 읽힙니다',
    );
  });
});

describe('녹음 결과 칸의 주인은 **서버**다 (결함 220)', () => {
  const main = readFileSync(join(ROOT, 'src', 'demo', 'main.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  it('⭐ 서버가 답한 뒤 칸을 **다시 그린다**', () => {
    // 실제로 이랬습니다 (가짜 마이크로 7초, 가로채기 없이):
    //   서버   status=unusable · coverage=0.515 · usable=false
    //   화면   커버리지 100.0% · 판정 「사용 가능」 (초록)
    //          바로 위 문장만 "서버 기준 커버리지 45.0%"
    // 한 화면에 두 숫자가 여덟 줄 사이로 있었고 큰 쪽이 틀렸습니다.
    ok(/completionView\(/.test(main), '서버 판정을 칸에 안 씁니다');
    const apply = /function applyServerVerdict\([\s\S]*?\n}/.exec(main)?.[0] ?? '';
    ok(apply !== '', '`applyServerVerdict` 가 없습니다');
    for (const slot of ['verdict', 'coverage', 'usable', 'disagree']) {
      ok(new RegExp(`\\$\\('${slot}'\\)`).test(apply), `\`${slot}\` 칸을 안 고칩니다`);
    }
    // ⚠️ **정의만 하고 안 부르면** 아무 일도 안 일어납니다 — 이 저장소가
    //    `dropBootShell` 에서 이미 당한 자리입니다. 호출 꼴을 봅니다.
    ok(
      /^\s*applyServerVerdict\(done, result\);\s*$/m.test(main),
      '종료 응답을 받은 자리에서 안 부릅니다',
    );
  });

  it('⚠️ 다시 올린 뒤 **되돌아가지 않는다** — `showResult` 는 기기 값으로 다시 쓴다', () => {
    // 재업로드 처리기가 `showResult(done)` 로 칸을 다시 그립니다. 서버
    // 판정을 안 덮으면 고친 것이 그 한 줄 때문에 풀립니다.
    const handler = /\$\('reupload'\)\.addEventListener\([\s\S]*?\n\}\);/.exec(main)?.[0] ?? '';
    ok(handler !== '', '재업로드 처리기를 못 찾았습니다');
    /* ⚠️ 처음에는 `applyServerVerdict(serverVerdict, done, true)` 라는
       **글자 그대로**를 요구했습니다. 결함 244 에서 되찾은 조각을 반영한
       새 요약(`fixed`)을 그리게 되자, 요구는 그대로인데 가드만 실패했습니다.
       요구는 **「그린 것과 같은 요약을 서버 판정으로 덮는다」** 입니다. */
    const drawn = /showResult\((\w+)\)/.exec(handler)?.[1];
    ok(drawn !== undefined, '재업로드 뒤 칸을 다시 안 그립니다');
    ok(
      new RegExp(`applyServerVerdict\\(serverVerdict,\\s*${drawn},\\s*true\\)`).test(handler),
      `다시 올리면 「사용 가능 · 100%」 로 되돌아갑니다 (그린 것: ${drawn})`,
    );
  });

  it('⭐ 차이를 말할 자리가 마크업에 **있다**', () => {
    // 만들어 놓고 붙일 자리가 없으면 아무 데도 안 나타납니다.
    const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
    ok(/id="disagree"/.test(html), '`#disagree` 자리가 없습니다');
    ok(/id="disagree"[^>]*role="status"/.test(html), '낭독기가 이 변화를 못 듣습니다');
  });
});

describe('마이크가 없어도 **협상은 된다** (결함 221)', () => {
  const call = readFileSync(join(ROOT, 'src', 'demo', 'call.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  it('⭐ 보낼 트랙이 없으면 **받는 자리**를 연다', () => {
    // 브라우저로 쟀습니다 (대조군 포함):
    //   트랙 없음        m= 줄 0개 · ICE 후보 0개  ← 영영 안 붙습니다
    //   트랙 있음        m= 줄 1개 · ICE 후보 2개
    //   recvonly 트랜시버 m= 줄 1개 · ICE 후보 2개 · a=recvonly
    //
    // ⚠️ 누가 거는지에 따라 갈립니다 — `shouldInitiate` 는 `me < other`
    //    라, 마이크 없는 사람의 번호가 작으면 그 사람이 **빈 offer** 를
    //    보내고 그 짝이 죽습니다. 번호로 운이 갈리는 것입니다.
    const setup = /function connectionFor\([\s\S]*?\n}/.exec(call)?.[0] ?? '';
    ok(setup !== '', '`connectionFor` 를 못 찾았습니다');
    ok(/needsRecvOnlyAudio\(/.test(setup), '보낼 것이 없는 경우를 안 가립니다');
    ok(
      /addTransceiver\('audio',\s*\{\s*direction:\s*'recvonly'\s*\}\)/.test(setup),
      '받는 자리를 안 엽니다 — 마이크 없는 사람은 아무 소리도 못 듣습니다',
    );
  });

  it('⚠️ 화면의 경고와 **짝이 맞는다** — "내 발언만" 안 된다고 말하고 있다', () => {
    // `callWarnings` 는 "이 상태로는 **내 발언이** 하나도 기록되지
    // 않습니다" 라고 합니다. 남의 목소리는 들려야 그 문장이 참입니다.
    const mesh = readFileSync(join(ROOT, 'src', 'lib', 'call', 'mesh.ts'), 'utf8');
    ok(/내 발언이 하나도 기록되지 않습니다/.test(mesh), '경고 문구가 바뀌었습니다');
  });
});

describe('나간 사람의 기여 기록 (결함 222)', () => {
  it('⭐ 기여도 화면이 **나간 사람도 이름으로** 부른다', () => {
    // 팀원을 내보내면 그 사람의 기록은 남지만(`remove_member` 의 결정)
    // 지금 구성원 목록에는 없습니다. 합치지 않으면 「사용자 #3」 이 뜹니다.
    const contrib = readFileSync(
      join(ROOT, '..', 'webapp', 'src', 'screens', 'Contributions.tsx'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');
    ok(/former_members/.test(contrib), '나간 사람 명단을 안 읽습니다');
    ok(
      /orderForDisplay\(score\.data\.members, everyone\)/.test(contrib),
      '줄을 그릴 때 나간 사람 이름을 못 찾습니다',
    );
    ok(/teamWarnings\(team, everyone\)/.test(contrib), '경고문에서 이름을 못 찾습니다');
    // ⚠️ **낱말이 아니라 넘기는지**를 봅니다 — 이름 찾기에 안 넘기면
    //    화면 어딘가는 여전히 번호로 부릅니다.
    const 안넘긴곳 = (contrib.match(/nameOf\([^)]*\)/g) ?? []).filter(
      (call) => !call.includes('formerPeople') && !call.includes('everyone'),
    );
    strictEqual(안넘긴곳.join(', '), '', '나간 사람을 번호로 부르는 자리가 남아 있습니다');
  });
});

describe('근거 칩은 **자기** 원문으로 간다 (결함 223)', () => {
  const review = readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Review.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  it('⭐ 후보 카드의 칩이 **누른 칩의** 발화로 간다', () => {
    // 칩 이름은 「근거 #14 원문 보기」인데 `select(candidate)` 만 부르면
    // 언제나 **첫** 근거(#1)로 갔습니다. 근거를 #1·#14 로 벌려 놓고 재서
    // 확인했습니다 — 고치기 전 두 칩 모두 scrollTop 57.
    /* ⚠️ **자리를 찾는 표지가 낡았었습니다** (결함 364). 예전에는
       `candidate.evidence_utterance_ids.map(` 이 여기 있었는데, 접는
       래퍼(`EvidenceChips`)로 감싸면서 그 글자가 사라졌습니다. **요구는
       안 바뀌었고 표지만 옮긴 것**이라 자를 고쳤습니다 — 결함 335·362 와
       같은 부류입니다. */
    const block =
      /<EvidenceChips\s+ids=\{candidate\.evidence_utterance_ids\}[\s\S]*?\n {20}\/>/.exec(review)?.[0] ??
      '';
    ok(block !== '', '후보 카드의 근거 칩을 못 찾았습니다');
    ok(
      /rowRefs\.current\.get\(id\)\?\.scrollIntoView/.test(block),
      '누른 칩의 발화로 안 갑니다 — 첫 근거로만 갑니다',
    );
    // ⚠️ **다음 프레임으로 미뤄야 먹습니다.** `select` 가 먼저 시작한
    //    스크롤이 같은 task 안의 두 번째 호출을 삼킵니다 — 처음 쓴 고침이
    //    그래서 아무 일도 안 했습니다.
    ok(
      /requestAnimationFrame\(\(\) => \{[\s\S]*?rowRefs\.current\.get\(id\)/.test(block),
      '같은 task 에서 부르면 `select` 의 스크롤에 삼켜집니다',
    );
  });
});

describe('못 받은 화면은 **빈 사실을 단언하지 않는다** — 남은 세 곳 (결함 224)', () => {
  /**
   * 결함 211 에서 설정·기여도를 고쳤는데 **칸반·로비·검토가 남아
   * 있었습니다.** 새로 가입한 사람이 남의 프로젝트/회의 주소를 열면 서버는
   * 403 인데 화면은 이렇게 말했습니다:
   *
   *   칸반  「회의에서 — · PR 연결 —」 + 텅 빈 판     (권한 이야기 없음)
   *   로비  「아직 아무도 참가하지 않았습니다 · 0명」
   *   검토  「업무 후보 0건 · **이 회의에는 기록된 발화가 없습니다 —
   *         녹음이 아직 처리되지 않았거나, 녹음 없이 열린 회의입니다**」
   *
   * 검토가 가장 나쁩니다 — 0 을 단언하는 데서 그치지 않고 **틀린 이유**를
   * 지어냈습니다.
   */
  const code = (name: string) =>
    readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');

  it('⭐ 세 화면 모두 못 받은 이유를 말한다', () => {
    for (const name of ['Kanban.tsx', 'Lobby.tsx', 'Review.tsx']) {
      const src = code(name);
      ok(/describeLoadFailure\(/.test(src), `${name} 이 실패 사유를 안 가립니다`);
      ok(/const cannotLoad =/.test(src), `${name} 에 문지기가 없습니다`);
      // ⚠️ **계산만 하고 안 쓰면** 화면은 그대로 거짓말을 합니다.
      ok(/cannotLoad !== null/.test(src), `${name} 이 문지기를 안 씁니다`);
    }
  });

  it('⚠️ **머리줄도** 숫자를 단언하지 않는다 — 판만 가리면 무색하다', () => {
    // 판을 가려도 머리줄에 「업무 후보 0건」 이 남아 있으면 같은 거짓말입니다.
    const review = code('Review.tsx');
    ok(
      /title=\{cannotLoad === null \? `\$\{title\} · 업무 후보 \$\{lanes\.all\}건` : title\}/.test(review),
      '검토 머리줄이 못 받았는데도 후보 수를 답니다',
    );
    const lobby = code('Lobby.tsx');
    ok(
      /cannotLoad !== null\s*\?\s*''/.test(lobby),
      '로비 머리줄이 못 받았는데도 방 상태를 말합니다',
    );
  });
});

describe('관리자만 되는 일을 **구성원에게 열어 두지 않는다** (결함 225)', () => {
  const settings = readFileSync(
    join(ROOT, '..', 'webapp', 'src', 'screens', 'Settings.tsx'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  it('⭐ 셋 다 막고 **왜 막혔는지** 말한다', () => {
    // 평범한 구성원에게 「프로젝트 이름 저장」·「코드 새로 만들기」·「저장소
    // 연결」이 멀쩡히 눌렸고, 누르면 서버가 403 을 주는데 화면은 아무
    // 말도 안 했습니다. `canManage` 는 처음부터 `@lib` 에 있었고 이 화면만
    // 안 불렀습니다 — "만들어 놓고 아무도 안 부름" 그 자리입니다.
    ok(/manageBlockedBecause\(/.test(settings), '관리자 판단을 안 씁니다');
    /* ⚠️ **이름이 아니라 흐름을 잽니다.** 예전에는 `id="rename-blocked"`
       라는 **글자**를 찾았는데, 결함 234 에서 사유 자리를 하나로 합치자
       요구는 그대로인데 가드만 깨졌습니다 (평범한 구성원으로 재 보니
       셋 다 막히고 사유도 뜨고 요청도 안 나갔습니다).

       요구는 이것입니다: **권한 판단의 값이 버튼의 막힘 판단으로
       흘러가고, 그 막힘이 사유로 이어진다.** */
    for (const name of ['프로젝트 이름 바꾸기', '초대 코드 새로 만들기', '저장소 연결']) {
      const assign = new RegExp(
        `const (\\w+) = manageBlockedBecause\\(myRole, '${name}'\\)`,
      ).exec(settings);
      ok(assign !== null, `「${name}」 을 안 막습니다`);
      const v = assign?.[1] ?? '';
      // 그 값이 **막힘 판단**으로 흘러가는가 — 직접이든 `whyCannotSave` 를 거치든.
      const flows =
        new RegExp(`noPermission:\\s*${v}\\b`).test(settings) ||
        new RegExp(`aria-disabled=\\{[^}]*${v}\\b`).test(settings) ||
        new RegExp(`<Problem[^>]*>\\{${v}\\}`).test(settings);
      ok(flows, `「${name}」 의 사유가 버튼까지 안 갑니다 — 막아 놓고 말을 안 합니다`);
    }
  });

  it('⚠️ 막았으면 **눌러도 요청이 안 나가야** 한다', () => {
    // `aria-disabled` 는 눌립니다(이 저장소가 일부러 그렇게 씁니다).
    // 손잡이에서 막지 않으면 403 이 그대로 나갑니다.
    //
    // ⚠️ 여기도 **이름이 아니라 요구**입니다: 세 손잡이가 각자 `!== null`
    //    로 일찍 돌아서는가. 변수 이름은 바뀔 수 있습니다.
    /* ⚠️ 처음에는 **개수만** 셌습니다(`>= 3`). 손잡이가 여섯이라
       하나를 지워도 다섯이 남아 **통과했습니다.** 개수가 아니라
       **그 값이 막는가**를 물어야 합니다. */
    const guarded = new Set(
      /* ⚠️ 손잡이 모양이 한 가지가 아닙니다 — `return;` 앞에 초점
         옮기기가 있기도 하고, 조건이 `save.isPending || X !== null` 처럼
         **복합**이기도 합니다. 조건 **안**에 `X !== null` 이 있는가를
         봅니다. */
      [...settings.matchAll(/if \(([^)]*(?:\([^)]*\)[^)]*)*)\)[\s\S]{0,160}?return;/g)].flatMap((m) =>
        [...(m[1] ?? '').matchAll(/(\w+) !== null/g)].map((x) => x[1] ?? ''),
      ),
    );
    for (const name of ['프로젝트 이름 바꾸기', '초대 코드 새로 만들기', '저장소 연결']) {
      const v =
        new RegExp(`const (\\w+) = manageBlockedBecause\\(myRole, '${name}'\\)`).exec(settings)?.[1] ??
        '';
      // 직접 막든, `whyCannotSave` 가 만든 값이 막든 — **둘 중 하나는** 있어야 합니다.
      const via = new RegExp(`const (\\w+) = whyCannotSave\\(\\{[^}]*noPermission:\\s*${v}\\b`).exec(
        settings,
      )?.[1];
      ok(
        guarded.has(v) || (via !== undefined && guarded.has(via)),
        `「${name}」 이 그냥 나갑니다 — 손잡이가 막지 않습니다`,
      );
    }
  });

  it('⚠️ 권한을 **넘겨줘야** 판단이 돕니다', () => {
    /* ⚠️ 예전에는 `myRole={mine?.project_role}` 이라는 **글자**를 셌습니다.
       결함 254 에서 그 값을 「아직 모름 / 명단에 없음」으로 가르는 변수로
       바꾸자, 요구는 그대로인데 가드만 깨졌습니다 — 이 저장소가 아홉 번
       당한 자리입니다. 이름이 아니라 **요구**를 잽니다: 두 곳 이상에
       넘기고, 넘기는 값이 **명단에서 온 것**인가. */
    const passes = [...settings.matchAll(/myRole=\{([^}]+)\}/g)].map((m) => (m[1] ?? '').trim());
    ok(
      passes.length >= 2,
      `권한을 넘기는 곳이 ${passes.length}곳뿐입니다 — 안 넘기면 판단이 undefined 로 돕니다`,
    );
    for (const expr of passes) {
      const fromRoster =
        /project_role/.test(expr) ||
        new RegExp(`const ${expr}\\s*=[^;]*project_role`).test(settings);
      ok(fromRoster, `넘기는 값이 명단에서 온 것이 아닙니다: ${expr}`);
    }
  });

  it('⭐ 명단이 **아직 안 왔을 때**를 「권한 없음」과 가른다 (결함 254)', () => {
    /* 명단이 오기 전 몇 초 동안 **소유자에게** 「팀의 관리자에게 요청
       하세요」라고 말했습니다. 재현했습니다 — `/members` 를 4초 늦추고
       설정 화면을 여니 그 문장이 떠 있었고, 명단이 오자 사라졌습니다.
       잠그는 것은 그대로입니다. 가르는 것은 **말**입니다. */
    const passes = [...settings.matchAll(/myRole=\{([^}]+)\}/g)].map((m) => (m[1] ?? '').trim());
    for (const expr of passes) {
      const decl = new RegExp(`const ${expr}\\s*=([^;]*);`).exec(settings)?.[1] ?? expr;
      ok(
        /isSuccess|isPending|isLoading|isFetched|status ===/.test(decl),
        `명단이 왔는지 안 보고 권한을 정합니다 — 모르는 것을 「없음」으로 단언하게 됩니다: ${expr}`,
      );
    }
  });
});

describe('⛔ 올릴 자리가 없는 녹음을 받아 주지 않는다 (결함 272)', () => {
  /* 재현: 녹음이 이미 끝난 회의를 다시 열면 `POST /tracks` 가 409 로
     거절됩니다. 그런데 `blockers` 는 그 사실을 몰라서 마이크만 허용하면
     「준비됐습니다」가 떴고, 10초를 녹음하면 정지 뒤에

         커버리지 100.0% · 총 공백 0.0초 · 판정 **사용 가능**

     이라고 적었습니다. 서버 로그에는 그 10초 동안 **청크 요청이 한 개도**
     없습니다 — 409 하나뿐입니다. 이 제품이 「끊긴 구간은 지어내지 않고
     『재지 못했다』로 남긴다」고 약속한 자리에서, **없는 녹음을 100%라고
     지어냈습니다.** */
  const main = (): string => codeOf(readFileSync(join(ROOT, 'src', 'demo', 'main.ts'), 'utf8'));

  it('⭐ 시작을 막는 규칙이 **트랙이 열렸는지**를 본다', () => {
    /* ⚠️ 처음에는 `blockers` 의 **본문 글자**를 봤습니다 (`state.track` 이
       있는가). 조건을 `if (false)` 로 심었더니 **글자는 그대로라 통과**
       했습니다 — 낱말 말고 요구를 재야 합니다. 그래서 실제로 부릅니다. */
    const met: SessionEvent[] = [
      { type: 'SECURE_CONTEXT', secure: true },
      { type: 'PERMISSION', state: 'granted' },
      { type: 'CONSENT', state: 'all_confirmed' },
      { type: 'CLOCK', state: 'ok' },
      { type: 'TRACK', state: 'open' },
    ];
    const opened = reduceAll(initialState(), met);
    deepStrictEqual(blockers(opened), [], '조건을 다 채웠는데 막고 있습니다');

    const rejected = reduce(opened, { type: 'TRACK', state: 'blocked' });
    ok(blockers(rejected).length > 0, '거절당한 트랙으로도 녹음을 시작할 수 있습니다');

    // solo 는 올릴 자리가 **원래** 없는 모드입니다. 여기서 막으면
    // 아무도 못 푸는 조건이 됩니다 (결함 238 과 같은 부류).
    const solo = reduceAll(initialState(), [...met.slice(0, 2), { type: 'CONSENT', state: 'solo' }, met[3] as SessionEvent]);
    deepStrictEqual(blockers(solo), [], 'solo 세션까지 막고 있습니다 — 그 모드에는 트랙이 없습니다');
  });

  it('⭐ 화면이 참가 **결과를** 실제로 넣는다 — 성공도, 실패도', () => {
    /* 대표 실패 ① — 만들어 놓고 아무도 안 부르면 상태는 영영
       `pending` 이고, 그러면 **아무도 녹음을 못 합니다.** 반대로 실패
       갈래에서 안 넣으면 이 결함이 그대로 돌아옵니다. */
    const code = main();
    const body = /async function joinMeeting\(([\s\S]*?)\n}/.exec(code)?.[1] ?? '';
    ok(body.length > 0, 'joinMeeting 을 못 찾았습니다 — 가드가 낡았습니다');
    ok(/client\.setTrack\('open'\)/.test(body), '트랙이 열려도 아무 데도 안 알립니다');
    /* ⚠️ 처음에는 `showNote($('join-note')` 를 세어 실패 갈래를 셌습니다 —
       그 조각은 **성공한 뒤 지우는 자리**(`showNote(…, '')`)와 solo 안내와
       업로드 재개 안내에도 있어서 수가 안 맞았습니다. 세는 자리가 아니라
       **요구**를 잽니다: 트랙을 못 연 채 빠져나가는 `return` 마다 바로
       앞에 「못 열었다」가 있어야 합니다. */
    const parts = body.split(/\n\s*return;/);
    // 마지막 조각은 return 뒤의 성공 경로입니다 — 실패 갈래가 아닙니다.
    const escapes = parts.slice(0, -1);
    for (const [i, part] of escapes.entries()) {
      // 로그인으로 **떠나는** 갈래는 예외입니다 — 이 화면이 남지 않습니다.
      if (/location\.href\s*=/.test(part.slice(part.lastIndexOf('\n  if')))) continue;
      const lastOpen = part.lastIndexOf("setTrack('open')");
      const lastBlocked = part.lastIndexOf("setTrack('blocked')");
      ok(
        lastBlocked > lastOpen,
        `${i + 1}번째 이탈 지점이 트랙을 못 연 채 조용히 빠져나갑니다`,
      );
    }
    ok(escapes.length >= 3, `이탈 지점이 ${escapes.length}곳뿐입니다 — 가드가 낡았습니다`);
  });

  it('⭐ 동의를 마치고 돌아오면 **다시 열어 본다**', () => {
    /* 안 그러면 이 가드가 만든 새 막다른 길이 생깁니다 — 동의 전에 녹음
       화면을 연 사람은 조건을 다 채워도 트랙이 `blocked` 인 채입니다. */
    const code = main();
    const fn = /async function refreshConsent\(([\s\S]*?)\n}/.exec(code)?.[1] ?? '';
    ok(fn.length > 0, 'refreshConsent 를 못 찾았습니다 — 가드가 낡았습니다');
    ok(
      /joinMeeting\(/.test(fn),
      '동의를 다시 읽고도 트랙을 다시 안 엽니다 — 조건은 다 찼는데 올릴 자리만 없습니다',
    );
  });
});

describe('⛔ 끝난 단계를 끝난 것으로 그린다 (결함 273·274)', () => {
  /* 렌더해서 잡았습니다. 셋이 동의하고 마이크까지 허용한 뒤에도 준비
     단계 ①은 「동의하러 로비로」, ②는 「마이크 권한 허용」이라는 **시키는
     말** 그대로였고, 동그라미도 번호 그대로였습니다. 왼쪽 막는 목록은
     「준비됐습니다」인데 오른쪽은 아직 둘을 시키고 있어, **같은 사실을 두
     곳이 다르게** 말했습니다 (사용자가 지적한 「글씨가 너무 많다」의 한
     갈래이기도 합니다 — 이미 끝난 일을 계속 읽게 만듭니다). */
  const main = (): string => codeOf(readFileSync(join(ROOT, 'src', 'demo', 'main.ts'), 'utf8'));
  const rec = (): string => readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');

  it('⭐ 단계의 끝남을 화면이 스스로 정하지 않는다 — 판단은 `@lib`', () => {
    const code = main();
    ok(/stepsDone\(/.test(code), '끝남을 아무 데서도 안 묻습니다');
    ok(
      /consentStepLabel\(/.test(code) && /permissionStepLabel\(/.test(code),
      '단계의 말을 화면이 직접 지어내고 있습니다',
    );
    /* 화면이 조건문을 복제하면 결함 229 로 돌아갑니다 — 그때는 녹음
       화면이 동의를 **스스로 선언**했습니다. */
    ok(
      !/consent\s*===\s*'all_confirmed'/.test(code),
      '화면이 동의 상태를 스스로 판정하고 있습니다',
    );
  });

  it('⭐ 표시할 자리가 실제로 있다 — 두 단계에 이름이 붙어 있는가', () => {
    const markup = rec().replace(/<!--[\s\S]*?-->/g, '');
    for (const id of ['step-consent', 'step-permission']) {
      ok(new RegExp(`<li id="${id}"`).test(markup), `${id} 가 마크업에 없습니다`);
      ok(new RegExp(`\\$\\('${id}'\\)`).test(main()), `${id} 를 아무도 안 칠합니다`);
    }
    // 끝남을 **모양**으로 말합니다. 흐림은 안 씁니다 (누를 수 있는 것들입니다).
    const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(rec())?.[1] ?? '';
    ok(
      /li\[data-done="true"\]::before/.test(style),
      '끝난 단계를 그리는 규칙이 없습니다 — 값만 붙이고 아무 일도 안 일어납니다',
    );
    ok(
      !/li\[data-done="true"\][^{]*\{[^}]*opacity/.test(style),
      '끝난 단계를 흐리게 하고 있습니다 — 여기 단추들은 끝난 뒤에도 눌립니다',
    );
  });

  it('⭐ 화면 맨 위의 `.note` 가 **아무것도 안 나누는 선**을 긋지 않는다 (결함 273)', () => {
    /* `.note` 는 절을 닫고 붙이는 각주라 위에 선을 긋습니다. 녹음·통화는
       그 문단이 `<main>` 의 첫 자식이라, 머리줄 바로 아래에 선이 하나 더
       그어지고 두 선 사이 56px 이 텅 비었습니다. 픽셀을 읽어 잡았습니다. */
    const css = readFileSync(join(ROOT, 'public', 'app.css'), 'utf8');
    const first = readdirSync(join(ROOT, 'public'))
      .filter((f) => f.endsWith('.html'))
      .filter((f) => {
        const body = readFileSync(join(ROOT, 'public', f), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
        return /<main\b[^>]*>\s*<p class="note"/.test(body);
      });
    if (first.length === 0) return; // 아무 화면도 그러지 않으면 볼 것이 없습니다
    const rule = /main\s*>\s*\.note:first-child\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    ok(
      /border-top:\s*0/.test(rule),
      `${first.join('·')} 가 맨 위에 각주 선을 긋습니다 — 위에 나눌 절이 없습니다`,
    );
    ok(/margin-top:\s*0/.test(rule), '맨 위 각주의 위 여백이 그대로라 빈 띠가 남습니다');
  });
});

describe('⛔ 서버가 확인하기 전의 결과 칸 (결함 275)', () => {
  /* 재현: 8초를 녹음하고 정지 직전에 종료 요청(`/complete`)만 끊었습니다 (청크는
     그대로 올라갑니다). 화면은 이렇게 답했습니다 —

         서버에 연결하지 못했습니다. 다시 시도를 눌러 주세요…
         녹음이 끊김 없이 완료됐습니다 (8초)          ← 초록
         커버리지 100.0% · 총 공백 0.0초 · 판정 **사용 가능**

     아래 셋은 **이 기기가 잰 값**인데 서버가 확인해 준 값과 **똑같은
     얼굴**입니다. 결함 220 과 같은 병인데 그때는 서버가 **답한** 갈래만
     고쳤습니다. 쓸 수 있는지는 서버에 무엇이 도착했는가로 정해지고,
     그건 이 기기가 모르는 값입니다. */
  const main = (): string => codeOf(readFileSync(join(ROOT, 'src', 'demo', 'main.ts'), 'utf8'));

  it('⭐ 기기만 그린 칸이 「사용 가능」을 말하지 않는다', () => {
    const code = main();
    const local = /function showResult\(([\s\S]*?)\n}/.exec(code)?.[1] ?? '';
    ok(local.length > 0, 'showResult 를 못 찾았습니다 — 가드가 낡았습니다');
    ok(
      !/'사용 가능'/.test(local),
      '기기만 아는 값으로 「사용 가능」을 단언하고 있습니다',
    );
    ok(/usableText\(null\)/.test(local), '「모름」을 아무 데서도 안 말합니다');
    // 모름은 실패가 아닙니다 — 빨강이 아니라 흙빛입니다.
    ok(/'gap'/.test(local), '「모름」을 흙빛으로 안 말합니다');
  });

  it('⭐ 커버리지 칸이 **누가 잰 값인지** 라벨로 말한다', () => {
    const code = main();
    const local = /function showResult\(([\s\S]*?)\n}/.exec(code)?.[1] ?? '';
    const server = /function applyServerVerdict\(([\s\S]*?)\n}/.exec(code)?.[1] ?? '';
    ok(server.length > 0, 'applyServerVerdict 를 못 찾았습니다 — 가드가 낡았습니다');
    ok(/coverageLabel\('device'\)/.test(local), '기기 값에 주인을 안 밝힙니다');
    ok(/coverageLabel\('server'\)/.test(server), '서버 값에 주인을 안 밝힙니다');
    // 라벨을 바꿀 자리가 마크업에 실제로 있는가.
    const markup = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '');
    ok(/id="coverage-label"/.test(markup), '라벨을 바꿀 자리가 마크업에 없습니다');
  });

  it('⭐ 같은 숫자를 두 번 읽히지 않는다', () => {
    /* 문장과 칸이 **같은 서버 값**을 나란히 말하고 있었습니다 (결함 220
       이후로는 둘 다 서버 값입니다). 사용자가 지적한 「글씨가 너무 많다」
       의 한 갈래입니다. */
    const complete = readFileSync(join(ROOT, 'src', 'lib', 'recording', 'complete.ts'), 'utf8');
    const fn = /export function describeCompletion\(([\s\S]*?)\n}/.exec(complete)?.[1] ?? '';
    ok(fn.length > 0, 'describeCompletion 을 못 찾았습니다 — 가드가 낡았습니다');
    ok(
      !/coverage \* 100/.test(fn),
      '문장이 커버리지 숫자를 다시 말합니다 — 바로 아래 칸이 이미 말합니다',
    );
  });
});

describe('⛔ 결과 칸의 읽는 순서 (결함 276)', () => {
  /* 렌더해서 봤습니다. 「회의 로비로 돌아가기」가 결과의 **두 문장 사이**에
     끼어 있었습니다 —

         녹음을 마쳤습니다. 2명이 아직 참가하지 않았습니다
         회의 로비로 돌아가기            ← 나가는 문
         녹음이 끊김 없이 완료됐습니다 (9초)
         커버리지(서버) 100.0% · … · 판정 사용 가능
         · 공백 없음
         (아직 안 올라간 조각이 있으면 여기 「다시 올리기」)

     결과를 읽다가 한 문장 만에 나가는 문을 만나고, 정작 **손봐야 할 것**은
     그 아래에 있습니다. 읽는 순서는 무슨 일이 있었나 → 값 → 남은 문제 →
     다음 걸음입니다. */
  const markup = (): string =>
    readFileSync(join(ROOT, 'public', 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');

  it('⭐ 다음 걸음이 값과 남은 문제 **뒤에** 있다', () => {
    const html = markup();
    const at = (needle: string): number => {
      const i = html.indexOf(needle);
      ok(i >= 0, `${needle} 가 없습니다 — 가드가 낡았습니다`);
      return i;
    };
    const next = at('id="finish-next"');
    for (const before of ['id="verdict"', 'id="coverage"', 'id="gaps"', 'id="reupload"']) {
      ok(at(before) < next, `${before} 가 「다음 걸음」보다 아래에 있습니다`);
    }
  });

  it('⭐ 다음 걸음이 **할 일처럼** 보인다 — 본문 링크가 아니다', () => {
    const tag = /<a id="finish-next"[^>]*>/.exec(markup())?.[0] ?? '';
    ok(tag !== '', '「다음 걸음」을 못 찾았습니다 — 가드가 낡았습니다');
    ok(/class="[^"]*\bbtn\b/.test(tag), '본문 링크로 서 있습니다');
    // ⚠️ `href` 가 없으면 눈에는 단추인데 탭으로 닿지 않습니다 (결함 238).
    ok(/href=/.test(tag), 'href 가 없습니다 — 눈에만 단추입니다');
  });
});

describe('⛔ 마이크 토글이 상태줄과 같은 말을 한다 (결함 277)', () => {
  /* 마이크를 **거부한 채** 통화 화면을 열어 재현했습니다. 상태줄은
     「마이크가 아직 꺼져 있습니다 — 권한을 허용하면 켜집니다」인데,
     바로 아래 토글은 「마이크 끄기」에 `aria-pressed="true"` 였습니다.
     눈으로 보는 사람에게는 흐린 버튼이지만 낭독기는 **「눌림」 = 켜져
     있음**이라고 읽습니다.

     `paintMic` 바로 위에 「같은 사실을 두 곳에서 쓰면 반드시
     갈라집니다」(결함 216)라고 적혀 있는데, 그 함수 **안에서** 다시
     갈라져 있었습니다 — 국면은 셋(`off`·`muted`·`on`)인데 버튼만 둘로. */
  const call = (): string => codeOf(readFileSync(join(ROOT, 'src', 'demo', 'call.ts'), 'utf8'));

  it('⭐ 토글을 국면 **셋**으로 그린다 — `micMuted` 만 보지 않는다', () => {
    const code = call();
    const paint = /function paintMic\(([\s\S]*?)\n}/.exec(code)?.[1] ?? '';
    ok(paint.length > 0, 'paintMic 을 못 찾았습니다 — 가드가 낡았습니다');
    ok(/micToggleLabel\(state\)/.test(paint), '버튼 글자를 국면에서 안 정합니다');
    ok(/micTogglePressed\(state\)/.test(paint), '「눌림」을 국면에서 안 정합니다');
    // 안 열린 마이크에는 잴 것이 없습니다 — 빈 레벨 막대를 안 그립니다.
    ok(
      [...paint.matchAll(/micOpen\(state\)/g)].length >= 2,
      '토글이나 레벨 막대 중 하나가 안 열린 마이크에도 서 있습니다',
    );
    ok(
      !/micMuted \? '마이크/.test(paint),
      '아직 `micMuted` 만 보고 버튼을 그립니다 — 국면은 셋입니다',
    );
  });

  it('⭐ 마크업의 **처음 상태**도 참이다 — `paintMic` 이 돌기 전이 있다', () => {
    const tag =
      /<button id="mic-toggle"[^>]*>/.exec(
        readFileSync(join(ROOT, 'public', 'call.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, ''),
      )?.[0] ?? '';
    ok(tag !== '', '마이크 토글을 못 찾았습니다 — 가드가 낡았습니다');
    ok(/aria-pressed="false"/.test(tag), '열리기도 전에 「눌림」으로 시작합니다');
    ok(/\bhidden\b/.test(tag), '토글할 것이 없는데 서 있습니다');
    // ⛔ 이 저장소는 누를 수 있는 것을 `disabled` 로 막지 않기로 했습니다
    //    (결함 234·236). 여기는 아예 **감춥니다** — 감출 것이 없어지면
    //    `paintMic` 이 드러냅니다.
    ok(!/\bdisabled\b/.test(tag), 'disabled 로 남아 있습니다');
  });
});

describe('⛔ 문장을 데이터 폰트 자리에 넣지 않는다 (결함 278)', () => {
  /* 렌더해서 보고 재서 잡았습니다. 통화 머리줄의

         혼자 있습니다. 다른 팀원이 들어오면 자동으로 연결됩니다.

     이 낱말 사이가 유난히 성겼습니다. `getComputedStyle` 로 재니
     `font-family` 가 **모노**(`--font-data`)였습니다 — 그 자리
     (`.spabar__meta`)는 녹음 화면의 `준비 중 0분 9초` 처럼 **숫자와 상태
     낱말**을 tabular 로 세우려고 만든 칸인데, 통화는 거기에 한글 문장을
     넣고 있었습니다. 모노는 글자 폭이 같아서 한글 문장이 성깁니다.

     ⚠️ 마크업만 봐서는 안 보입니다 — 거기 적힌 정적 글자는
     「연결하는 중…」이고, 문장은 `call.ts` 가 실행 중에 넣습니다. */
  const markup = (): string =>
    readFileSync(join(ROOT, 'public', 'call.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const css = (): string => readFileSync(join(ROOT, 'public', 'app.css'), 'utf8');

  it('⭐ 문장이 들어가는 칸은 **본문 폰트** 자리다', () => {
    const call = codeOf(readFileSync(join(ROOT, 'src', 'demo', 'call.ts'), 'utf8'));
    /* 먼저 「여기에 문장이 들어간다」가 아직 참인지 봅니다 — 아니면 이
       가드는 없는 것을 지키고 있는 것입니다. */
    ok(
      /\$\('summary'\)\.textContent\s*=/.test(call),
      '#summary 에 아무도 안 씁니다 — 가드가 낡았습니다',
    );
    const tag = /<span[^>]*id="summary"[^>]*>/.exec(markup())?.[0] ?? '';
    ok(tag !== '', '#summary 를 못 찾았습니다 — 가드가 낡았습니다');
    ok(!/spabar__meta/.test(tag), '문장이 숫자·상태용 데이터 폰트 자리에 들어 있습니다');
    ok(/spabar__note/.test(tag), '문장이 설 자리가 없습니다');
  });

  it('⭐ 두 자리가 **실제로 다른 폰트**다 — 이름만 바꾸면 아무 일도 안 일어난다', () => {
    /* 이 저장소가 이미 당한 자리입니다 (결함 164) — 규칙을 적었는데
       그 값이 이미 같아서 아무것도 안 바뀌었습니다. */
    const sheet = css();
    const rule = (sel: string): string =>
      new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`).exec(sheet)?.[1] ?? '';
    const meta = rule('.spabar__meta');
    const note = rule('.spabar__note');
    ok(meta !== '', '.spabar__meta 를 못 찾았습니다 — 가드가 낡았습니다');
    ok(note !== '', '.spabar__note 를 못 찾았습니다 — 가드가 낡았습니다');
    ok(/font-family:\s*var\(--font-data\)/.test(meta), '데이터 칸이 데이터 폰트를 안 씁니다');
    ok(
      !/font-family:\s*var\(--font-data\)/.test(note),
      '문장 칸도 데이터 폰트입니다 — 클래스만 둘이고 얼굴은 하나입니다',
    );
  });
});

describe('⛔ 모달은 손으로 짓지 않는다 (결함 280)', () => {
  /* 키보드만 쓰는 사람이 되어 봤습니다. 홈의 「프로젝트 시작하기」는
     `<div role="dialog" aria-modal="true">` 를 **손으로** 지은 것이었고,

       · Escape 를 눌러도 **안 닫혔습니다** (듣는 곳이 없었습니다)
       · 안에서 Tab 을 누르면 **뒤쪽 화면**으로 새어 나갔고, 그 자리는
         덮개에 가려져 눈에 안 보입니다. 거기서 Enter 를 눌렀더니
         `/app/meeting/6/lobby` 로 **가 버렸습니다**
       · 닫은 뒤 초점이 `body` 에 떨어져 Tab 을 처음부터 다시 밟아야 했습니다

     `aria-modal="true"` 는 낭독기에게 하는 **말**이고, 키보드는 그 말을
     안 듣습니다. `@radix-ui/react-dialog` 는 **이미 의존성에 있었고 아무도
     안 쓰고 있었습니다** — 대표 실패 ①. */
  const files = (): string[] =>
    readdirSync(join(ROOT, '..', 'webapp', 'src', 'screens'))
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => join(ROOT, '..', 'webapp', 'src', 'screens', f));

  it('⭐ `role="dialog"` 를 손으로 적은 화면이 없다', () => {
    const guilty = files().filter((f) => /role="dialog"/.test(codeOf(readFileSync(f, 'utf8'))));
    strictEqual(
      guilty.map((f) => f.split('/').pop()).join(', '),
      '',
      '모달을 손으로 짓고 있습니다 — Radix 가 초점 가두기·Escape·되돌리기를 이미 합니다',
    );
  });

  it('⭐ 만든 모달이 **Radix 로** 서 있다', () => {
    const home = readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Home.tsx'), 'utf8');
    ok(/@radix-ui\/react-dialog/.test(home), '모달을 안 씁니다 — 가드가 낡았습니다');
    const code = codeOf(home);
    ok(/Dialog\.Overlay/.test(code) && /Dialog\.Content/.test(code), '덮개나 상자가 없습니다');
    /* ⚠️ 닫혔다고 컴포넌트를 **떼면** Radix 가 초점을 되돌리다 말고,
       사람은 `body` 에 떨어집니다. 여는 것은 `open` 하나로만 말합니다. */
    ok(
      !/\{starting !== null && <StartDialog/.test(code),
      '닫힐 때 컴포넌트를 통째로 떼고 있습니다 — 초점이 돌아갈 곳을 잃습니다',
    );
    ok(/onCloseAutoFocus/.test(code), '닫은 뒤 초점을 어디로 보낼지 안 정합니다');
  });

  it('⭐ 덮개와 상자가 **형제**라 상자가 스스로 서야 한다', () => {
    /* Radix 는 `Overlay` 와 `Content` 를 포털에 **나란히** 붙입니다.
       예전 CSS 는 덮개가 상자를 감싸서 가운데로 보냈는데, 그대로 두니
       상자가 `(0, 678)` 에 앉고 덮개가 그 **위를** 덮어 「만들기」가
       마우스로 안 눌렸습니다 — 렌더해서 눌러 보고 잡았습니다. */
    const css = readFileSync(join(ROOT, '..', 'webapp', 'src', 'app.css'), 'utf8');
    const rule = (sel: string): string =>
      new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    const back = rule('.dialog-backdrop');
    const box = rule('.dialog');
    ok(back !== '' && box !== '', '대화상자 규칙을 못 찾았습니다 — 가드가 낡았습니다');
    const z = (body: string): number => Number(/z-index:\s*(\d+)/.exec(body)?.[1] ?? 0);
    ok(z(box) > z(back), `상자(${z(box)})가 덮개(${z(back)}) 아래라 눌리지 않습니다`);
    ok(/position:\s*fixed/.test(box), '상자가 스스로 서지 않습니다 — 덮개가 감싸 주지 않습니다');
    ok(
      !/place-items:\s*center/.test(back),
      '덮개가 아직 감싸서 가운데로 보내려 합니다 — 이제 형제입니다',
    );
  });
});

describe('⛔ 탭바 높이가 프로젝트 수를 따라가지 않는다 (결함 281)', () => {
  /* 확대 200%(720×450)로 보다가 **눈으로** 잡았습니다. 좁은 폭에서
     `.rail` 은 가로 탭바로 눕는데 `.prail`(프로젝트 칩)은 그대로 세로로
     쌓여서, 칩 기둥의 높이가 **탭바 전체의 높이를 끌고 갔습니다.**

         프로젝트 2개  탭바 114px
         프로젝트 4개  탭바 **210px**   = 창 높이의 47%
         프로젝트 10개 (고치기 전이라면 ~450px — 화면을 통째로)

     ⚠️ **넘침 감사로는 안 잡힙니다.** 아무것도 잘리지 않고 바가 자랄
     뿐입니다. 열두 화면 넘침 0건 옆에서 이게 있었습니다. */
  const narrow = (): string => {
    const css = readFileSync(join(ROOT, '..', 'webapp', 'src', 'app.css'), 'utf8');
    /* ⚠️ **단위를 글자로 찾지 않습니다** (결함 338). 예전에는
       `'@media (max-width: 1023.5px)'` 를 통째로 찾았는데, 접는 폭을
       `rem` 으로 바꾸자 요구는 하나도 안 바뀌었는데 이 자만 터졌습니다 —
       결함 335 가 `id="keep-audio"` 에서 겪은 것과 같은 모양입니다.
       찾는 것은 「셸을 접는 그 블록」이지 그것을 적은 글자가 아닙니다. */
    const at = (() => {
      for (const m of css.matchAll(/@media\s*\(max-width:[^)]*\)\s*\{/g)) {
        const head = css.slice(m.index ?? 0, (m.index ?? 0) + 400);
        if (/\.app\s*\{[^}]*grid-template-columns:\s*1fr/.test(head)) return m.index ?? -1;
      }
      return -1;
    })();
    ok(at >= 0, '셸을 접는 좁은 폭 규칙을 못 찾았습니다 — 가드가 낡았습니다');
    // 중괄호를 세어 그 블록만 떼어 냅니다.
    let depth = 0;
    let i = css.indexOf('{', at);
    const start = i;
    for (; i < css.length; i++) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    return css.slice(start, i);
  };

  it('⭐ 칩이 탭바와 **같은 축**으로 눕는다', () => {
    const block = narrow();
    const rule = (sel: string): string =>
      new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`).exec(block)?.[1] ?? '';
    const rail = rule('.rail');
    const prail = rule('.prail');
    ok(rail !== '', '좁은 폭의 `.rail` 규칙이 없습니다 — 가드가 낡았습니다');
    ok(
      /flex-direction:\s*row/.test(rail),
      '좁은 폭에서 레일이 안 눕습니다 — 가드가 낡았습니다',
    );
    ok(
      prail !== '' && /flex-direction:\s*row/.test(prail),
      '칩만 세로로 쌓입니다 — 그 기둥의 높이가 탭바 전체를 끌고 갑니다',
    );
    /* 많아지면 **옆으로** 흘러야 탭바 높이가 프로젝트 수와 무관해집니다.
       세로 스크롤로 두면 다시 높이가 자랍니다. */
    ok(/overflow-x:\s*auto|overflow-x:\s*scroll/.test(prail), '칩이 많아지면 갈 곳이 없습니다');
    ok(
      !/overflow-y:\s*auto/.test(prail),
      '칩이 아직 세로로 스크롤합니다 — 가로 탭바에서는 높이가 자랍니다',
    );
  });

  it('⭐ 넓은 폭은 그대로 세로다 — 좁은 폭 고치다 넓은 폭을 눕히지 않는다', () => {
    const css = readFileSync(join(ROOT, '..', 'webapp', 'src', 'app.css'), 'utf8');
    const base = /^\.prail\s*\{([^}]*)\}/m.exec(css)?.[1] ?? '';
    ok(base !== '', '기본 `.prail` 규칙을 못 찾았습니다 — 가드가 낡았습니다');
    ok(/flex-direction:\s*column/.test(base), '넓은 폭에서도 칩이 가로로 눕습니다');
  });
});

describe('⛔ 못 물어본 것을 「로그아웃」이라고 하지 않는다 (결함 282)', () => {
  /* 연결을 끊고 `/app/` 을 다시 열어 재현했습니다. 세션 쿠키는 멀쩡한데
     화면이 **로그인 화면**으로 갔습니다 — 거기서 아이디와 비밀번호를
     쳐도 같은 네트워크라 또 실패합니다. 사람은 「로그아웃됐나」 또는
     「앱이 고장났나」로 읽고, 정작 할 일(연결을 되살리는 것)은 아무도
     안 알려 줍니다.

     원인은 한 줄입니다 —

         if (me === null || me === undefined) return <Navigate to="/login" />;

     그 둘은 **다른 사실**이고 이 앱은 이미 가르고 있습니다:
     `null` 은 서버가 401 로 **답한** 것, `undefined` 는 **못 물어본**
     것입니다. 불변식 셋째(측정 불가 ≠ 0점)가 인증에도 그대로입니다. */
  const main = (): string =>
    codeOf(readFileSync(join(ROOT, '..', 'webapp', 'src', 'main.tsx'), 'utf8'));

  it('⭐ 문지기가 **네 갈래**를 가른다 — 판단은 `@lib`', () => {
    const code = main();
    ok(/authGate\(/.test(code), '문 앞의 판단을 아무 데서도 안 묻습니다');
    ok(/'unreachable'/.test(code), '못 닿은 갈래가 없습니다');
    /* ⛔ 두 값을 다시 묶으면 결함이 그대로 돌아옵니다. */
    ok(
      !/me === null \|\| me === undefined/.test(code),
      '못 물어본 것과 로그아웃을 다시 한 줄로 묶었습니다',
    );
  });

  it('⭐ 못 닿았을 때 **할 수 있는 일**을 준다 — 말만 하고 끝내지 않는다', () => {
    const code = main();
    const box = /function Unreachable\(([\s\S]*?)\n}/.exec(code)?.[1] ?? '';
    ok(box !== '', '못 닿았을 때 보여 줄 화면이 없습니다');
    /* ⚠️ 처음에는 `refetch|onRetry` 라는 **낱말**을 찾았습니다. 배선을
       `onRetry={() => {}}` 로 심었더니 낱말은 그대로라 통과했습니다 —
       단추는 있는데 눌러도 아무 일이 없는 상태입니다. 넘겨주는 값이
       **실제로 다시 묻는가**를 봅니다. */
    const passed = /<Unreachable[^>]*onRetry=\{([^}]*(?:\{[^}]*\})?[^}]*)\}/.exec(code)?.[1] ?? '';
    ok(passed !== '', '못 닿은 화면에 다시 시도를 안 넘깁니다');
    ok(
      /refetch\(/.test(passed),
      `다시 시도가 아무것도 안 합니다: ${passed.trim()}`,
    );
    /* ⛔ 로그인 화면을 보여 주면 안 됩니다 — 거기서 비밀번호를 쳐도
       같은 네트워크라 또 실패합니다 (결함 227 과 짝: 그때는 말만 하고
       갈 자리를 안 준 것이고, 여기는 **엉뚱한 자리**로 보낸 것입니다).

       ⚠️ 처음에는 `Navigate to="/login"` 과 `unreachable` 이 **가까이
       있는가**를 봤습니다. 옳게 고친 코드도 그 둘이 나란한 줄이라
       (`out` 갈래 바로 아래가 `unreachable` 갈래) 그대로 걸렸습니다.
       거리가 아니라 **그 갈래가 무엇을 돌려주는가**를 봅니다. */
    const branch = /gate === 'unreachable'\)\s*return([^;]*);/.exec(code)?.[1] ?? '';
    ok(branch !== '', '못 닿은 갈래를 못 찾았습니다 — 가드가 낡았습니다');
    ok(!/login/.test(branch), `못 닿았는데 로그인 화면으로 보냅니다: ${branch.trim()}`);
    // 문구도 한 벌입니다.
    ok(/describeLoadFailure\(/.test(code), '문구를 화면이 따로 짓습니다');
  });
});

describe('⛔ 실패는 **한 어휘**로 말한다 (결함 283)', () => {
  /* 재현: A 가 카드를 지운 뒤, 그 카드를 아직 들고 있는 B 가 옮기면
     서버가 **404** 를 줍니다. 그런데 칸반은 무슨 일이 있었든

         바꾸지 못했습니다 — 새로고침한 뒤 다시 해 보세요.

     한 줄이었습니다. 누가 지웠다는 말은 어디에도 없고, 403(권한)·
     409(남이 먼저)·끊김에도 같은 말을 합니다. `load.ts` 는 그 문구
     바로 옆에 **"다시 시도하세요" 를 아무 데나 붙이지 않습니다** 라고
     적어 두고 있었습니다 — 화면 넷 중 셋은 그 어휘를 쓰고 칸반만
     빠져 있었습니다 (실패 ②: 두 벌이 있으면 한쪽만 고쳐진다). */
  const screens = (): { name: string; code: string }[] =>
    readdirSync(join(ROOT, '..', 'webapp', 'src', 'screens'))
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => ({
        name: f,
        code: codeOf(readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', f), 'utf8')),
      }));

  it('⭐ 보낸 뒤의 실패를 **화면이 스스로 짓지 않는다**', () => {
    /* 「…못했습니다」로 끝나는 문장을 화면이 직접 들고 있으면, 그 화면은
       공용 어휘와 갈라진 것입니다. 여는 자리(`describeLoadFailure`)와
       달리 **보낸 뒤**의 실패는 상태마다 할 일이 다릅니다. */
    const guilty: string[] = [];
    for (const { name, code } of screens()) {
      const mutates = /\.mutate\(|\.mutateAsync\(/.test(code);
      if (!mutates) continue;
      // 화면 안에 박힌 실패 문장 (여는 실패는 `describeLoadFailure` 가 따로 봅니다)
      const hardcoded = /<Problem>\s*[^<{][^<]*(?:못했습니다|실패했습니다)[^<]*<\/Problem>/.exec(code);
      if (hardcoded !== null && !/describeActionFailure\(/.test(code)) {
        guilty.push(`${name}: ${hardcoded[0].slice(0, 60)}`);
      }
    }
    strictEqual(
      guilty.join(' · '),
      '',
      '보낸 뒤의 실패를 화면이 스스로 말합니다 — `describeActionFailure` 한 벌을 쓰세요',
    );
  });

  it('⭐ 칸반이 **무엇이 실패했는지**까지 가른다', () => {
    const kanban =
      screens().find((f) => f.name === 'Kanban.tsx')?.code ?? '';
    ok(kanban !== '', '칸반을 못 찾았습니다 — 가드가 낡았습니다');
    ok(/describeActionFailure\(/.test(kanban), '칸반이 공용 어휘를 안 씁니다');
    /* 세 가지 일이 있습니다 — 옮기기·담당자·지우기. 한 이름으로 묶으면
       「담당자를 못 바꿨다」와 「업무를 못 지웠다」가 같은 말이 됩니다. */
    const names = [...kanban.matchAll(/what:\s*'([^']+)'/g)].map((m) => m[1]);
    ok(
      new Set(names).size >= 3,
      `실패를 ${new Set(names).size}가지로만 가릅니다 — 옮기기·담당자·지우기는 다른 일입니다`,
    );
    /* ⚠️ 상태 코드를 안 넘기면 어휘가 있어도 **한 문장만** 나옵니다.

       처음에는 `statusOf(` 를 세었는데 그 조각은 **선언**
       (`function statusOf(`)에도 있어서, 넘기는 자리를 전부 `null` 로
       심어도 1이 나와 통과했습니다 — AGENTS.md 에 적힌 그 함정입니다.
       넘기는 자리를 직접 봅니다. */
    const passed = [...kanban.matchAll(/status:\s*([^,\n}]+)/g)].map((m) => (m[1] ?? '').trim());
    ok(passed.length >= 3, `상태를 넘기는 자리가 ${passed.length}곳입니다 — 가드가 낡았습니다`);
    const dead = passed.filter((expr) => expr === 'null' || expr === 'undefined');
    strictEqual(
      dead.join(' · '),
      '',
      '상태 코드 자리에 죽은 값이 있습니다 — 어휘가 갈래를 못 타고 한 문장만 나옵니다',
    );
  });
});

describe('⛔ 요약이 없을 때 **왜 없는지**를 말한다 (결함 284)', () => {
  /* 재현: 씨앗 회의 다섯을 나란히 열었습니다. 회의 4 는 검토까지 끝난
     `confirmed`, 회의 5 는 `failed` 인데 둘 다 요약이 없습니다. 검토
     화면은 둘 모두에게

         요약이 아직 없습니다 — 처리가 끝나면 여기 담깁니다.

     라고 했습니다. 하나는 **이미 끝났고** 하나는 **실패**해서 다시
     처리해야 하는데, 화면은 "기다리세요" 한 마디로 덮었습니다. 바로 옆
     후보 칸은 같은 병을 이미 고쳐 뒀습니다(`reviewPhase` — 결함 232) —
     요약 칸만 남은 것이니 실패 ②(두 벌이 있으면 한쪽만 고쳐진다)입니다. */
  const reviewCode = (): string =>
    codeOf(readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Review.tsx'), 'utf8'));

  it('⭐ 요약 자리의 대타가 **상태를 받는다**', () => {
    /* ⚠️ 낱말(`describeMissingSummary`)이 파일 어딘가에 있는지 세면 안
       됩니다 — import 줄에도 있습니다. `summary ??` **바로 뒤에 오는
       식**을 떼어 와서, 그것이 상태를 받는 호출인지 봅니다. */
    const fallback = /\bsummary\s*\?\?\s*([^\n}]+)/.exec(reviewCode());
    ok(fallback !== null, '요약 자리에 대타가 없습니다 — 가드가 낡았습니다');
    const expr = (fallback?.[1] ?? '').trim();
    ok(
      !/^['"`]/.test(expr),
      `요약이 없을 때 문장이 화면에 박혀 있습니다 (${expr.slice(0, 40)}) — 상태를 봐야 합니다`,
    );
    ok(
      /\bstatus\b/.test(expr),
      `대타가 상태를 안 받습니다 (${expr.slice(0, 40)}) — 네 상태에 같은 말을 하게 됩니다`,
    );
  });

  it('⭐ 상태마다 **다른 말**이 나온다', () => {
    /* 받아만 놓고 안 쓰면 결과는 같습니다. 실제로 불러 봅니다. */
    const said = new Map<string, string>();
    for (const status of ['pending', 'processing', 'needs_review', 'confirmed', 'failed']) {
      said.set(status, describeMissingSummary(status));
    }
    ok(
      new Set(said.values()).size >= 3,
      `다섯 상태가 ${new Set(said.values()).size}가지로만 말합니다 — 갈래가 죽었습니다`,
    );
    /* 제일 크게 갈라져야 하는 둘 — 아직 안 한 것과 실패한 것. */
    ok(
      said.get('pending') !== said.get('failed'),
      '녹음 전과 처리 실패에 같은 말을 합니다 — 할 일이 다릅니다',
    );
    ok(
      said.get('confirmed') !== said.get('pending'),
      '끝난 회의에게 "기다리세요" 라고 합니다',
    );
  });
});

describe('⛔ 회의를 **한 이름으로** 부른다 (결함 285)', () => {
  /* 재현: 씨앗 회의 4번은 `title` 이 `null` 입니다 (「회의 열기」가 이름을
     안 묻기 때문 — 결함 268). 그 회의 하나를 두고 이름이 **아홉 가지**
     였습니다.

         홈 목록          제목 없는 회의
         홈 리본(낭독기)   회의
         채널 목록        회의 4
         로비 머리줄·탭    회의 준비      ← 화면의 이름
         검토 머리줄·탭    회의 검토      ← 화면의 이름
         칸반 카드 출처    회의
         회의록(서버)      회의 #4
         달력·검색(서버)   회의 4
         알림(서버)        이름 없는 회의

     굵은 둘은 **회의의 이름이 아니라 화면의 이름**입니다. 브라우저 탭이
     그 글자라, 이름 없는 회의를 둘 열면 탭 둘이 글자 하나 안 틀리고
     똑같습니다 — 어느 탭이 어느 회의인지 알 방법이 없습니다. */
  const uiFiles = (): { name: string; code: string }[] => {
    const out: { name: string; code: string }[] = [];
    for (const dir of [
      join(ROOT, '..', 'webapp', 'src', 'screens'),
      DEMO,
      join(LIB, 'nav'),
    ]) {
      for (const f of readdirSync(dir)) {
        if (!SCREEN_EXT.test(f) || f.endsWith('.test.ts') || f.endsWith('.test.tsx')) continue;
        out.push({ name: f, code: codeOf(readFileSync(join(dir, f), 'utf8')) });
      }
    }
    return out;
  };

  it('⭐ 회의 이름의 **대타를 화면이 짓지 않는다**', () => {
    /* ⚠️ 낱말(`meetingLabel`)이 있는지 세면 안 됩니다 — 한 자리만 부르고
       나머지는 각자 지어도 통과합니다. **짓는 모양**을 찾습니다. */
    const guilty: string[] = [];
    for (const { name, code } of uiFiles()) {
      // `meeting.title ?? '…'` · `meeting.data?.title ?? '…'` · `meeting_title ?? '…'`
      const invented = [
        ...code.matchAll(/\bmeeting[\w.?]*\.title\s*\?\?\s*(['"`])([^'"`]*)\1/gi),
        ...code.matchAll(/\bmeeting_title\s*\?\?\s*(['"`])([^'"`]*)\1/gi),
      ];
      for (const m of invented) {
        // 빈 글자는 **이름이 아니라 입력칸 초기값**입니다 (로비의 이름 고치기).
        if ((m[2] ?? '') === '') continue;
        guilty.push(`${name}: ${m[0].slice(0, 46)}`);
      }
      /* 번호로 직접 짓는 모양 (`회의 ${id}`) 도 같은 병입니다.

         ⚠️ **이 자가 틀렸었습니다** (결함 299). 끝에 `` ` `` 를 붙여 둬서
         **번호가 템플릿의 마지막일 때만** 잡았습니다. 레거시 로비의

             `회의 ${meetingId} · 팀원 ${roster.length}명`

         은 뒤에 글자가 더 있어서 그대로 통과했고, 그 화면은 회의를
         「회의 1」이라고 부르고 있었습니다. 이름을 막는 것은 요구를 재는
         것이 아닙니다 — **어기는 다른 길**을 같이 세십시오. */
      const numbered = /`[^`]*회의\s*#?\$\{[^}]*(?:id|Id|번호)[^}]*\}/.exec(code);
      if (numbered !== null) guilty.push(`${name}: ${numbered[0].slice(0, 46)}`);
    }
    strictEqual(
      guilty.join(' · '),
      '',
      '회의 이름을 화면이 스스로 짓습니다 — `@lib/ui/naming.ts` 의 `meetingLabel` 한 벌을 쓰세요',
    );
  });

  it('⭐ **화면의 이름**이 회의 이름 자리에 오지 않는다', () => {
    /* 로비는 「회의 준비」, 검토는 「회의 검토」였습니다. 머리줄에 넣는
       값을 떼어 와서, 그것이 글자 상수가 아닌지 봅니다. */
    const heads = [
      { name: 'Lobby.tsx', screen: '준비' },
      { name: 'Review.tsx', screen: '검토' },
    ];
    for (const { name, screen } of heads) {
      const code = codeOf(
        readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', name), 'utf8'),
      );
      const decl = /\bconst title = ([^\n;]+)/.exec(code);
      ok(decl !== null, `${name}: 머리줄 이름을 못 찾았습니다 — 가드가 낡았습니다`);
      const expr = (decl?.[1] ?? '').trim();
      ok(
        !new RegExp(`['"\`][^'"\`]*${screen}`).test(expr),
        `${name}: 머리줄에 화면 이름(${screen})이 회의 이름으로 들어갑니다 — ${expr.slice(0, 50)}`,
      );
      ok(
        /meetingLabel\(/.test(expr),
        `${name}: 회의 이름을 한 벌에서 안 받습니다 — ${expr.slice(0, 50)}`,
      );
    }
  });

  it('⭐ 이름 없는 회의 **둘이 서로 다르게** 불린다', () => {
    /* 낱말만 맞추고 번호를 안 붙이면, 탭 둘이 다시 똑같아집니다. */
    strictEqual(meetingLabel(null, 4) === meetingLabel(null, 5), false);
    ok(meetingLabel(null, 4).includes('4'), '번호가 이름에 없습니다');
  });
});

describe('⛔ 「이 회의는 언제인가」는 **한 벌**이다 (결함 287)', () => {
  /* 재현: 달력에서 「회의 일정 잡기」를 **한 번** 눌렀더니

         GET /api/projects/1/meetings   → 500
         GET /api/meetings/6            → 500

     이 됐습니다. `MeetingSummary.started_at` 이 비어 있을 수 없게 잡혀
     있는데 잡아만 둔 회의는 그 값이 없기 때문입니다. 화면은 그 500 을
     이렇게 그렸습니다 —

         레거시 홈:  「회의 6개」  …  「회의를 열면 여기에 나옵니다」
         SPA 홈:     「회의 6」   …  (줄이 하나도 없음)

     **한 화면이 자기 머리말과 반대되는 말을 합니다.** 회의 다섯이 멀쩡히
     있는 팀에서 다섯이 전부 사라졌고, 사람은 데이터가 날아갔다고 읽습니다.
     씨앗에 예정 회의가 하나도 없어서 여태 안 들켰습니다.

     ⚠️ 고치면서 **둘째 병**이 드러났습니다. 두 셸이 「언제인가」를 각자
     짓고 있었고 답이 달랐습니다 — SPA 는 팀 달력(`shortTeamDate`), 레거시는
     `toLocaleString` 을 시간대 없이 부르는 **브라우저 달력**. 씨앗 회의가
     전부 `10:00Z` 라 어느 시간대에서도 날짜가 안 넘어가서, 이것도 자정을
     넘는 회의를 심고서야 나왔습니다. */
  const homes = (): { name: string; code: string }[] => [
    {
      name: 'webapp/Home.tsx',
      code: codeOf(readFileSync(join(ROOT, '..', 'webapp', 'src', 'screens', 'Home.tsx'), 'utf8')),
    },
    { name: 'demo/home.tsx', code: codeOf(readFileSync(join(DEMO, 'home.tsx'), 'utf8')) },
  ];

  it('⭐ 홈이 `started_at` 을 **직접 그리지 않는다**', () => {
    /* ⚠️ 낱말(`describeMeetingWhen`)이 파일에 있는지 세면 안 됩니다 —
       한 줄만 고치고 다른 줄이 옛 값을 그려도 통과합니다. **그리는
       자리**를 봅니다: JSX 안에서 `started_at` 을 쓰는 곳. */
    const guilty: string[] = [];
    for (const { name, code } of homes()) {
      for (const m of code.matchAll(/\{[^{}]*\bmeeting\.started_at\b[^{}]*\}/g)) {
        guilty.push(`${name}: ${m[0].slice(0, 44)}`);
      }
    }
    strictEqual(
      guilty.join(' · '),
      '',
      '홈이 `started_at` 을 직접 그립니다 — 잡아만 둔 회의는 그 값이 없습니다. `describeMeetingWhen` 한 벌을 쓰세요',
    );
  });

  it('⭐ 두 셸이 **같은 값**을 그린다', () => {
    for (const { name, code } of homes()) {
      ok(
        /describeMeetingWhen\(/.test(code),
        `${name}: 「언제인가」를 한 벌에서 안 받습니다`,
      );
    }
  });

  it('⭐ 잡아만 둔 회의에도 **시각을 지어내지 않는다**', () => {
    deepStrictEqual(meetingWhen({ started_at: null, scheduled_at: null }), {
      at: null,
      planned: true,
    });
    strictEqual(describeMeetingWhen({ started_at: null, scheduled_at: null }), '—');
  });

  it('⭐ 잡아 둔 시각은 **팀 달력**으로 그린다 — 자정을 넘겨서 잰다', () => {
    /* `16:30Z` 는 서울에서 **다음 날 01:30** 입니다. 브라우저 달력이면
       검사를 돌리는 기계의 시간대에 따라 답이 흔들립니다. */
    strictEqual(
      describeMeetingWhen({ started_at: null, scheduled_at: '2026-08-25T16:30:00Z' }),
      '예정 08-26 01:30',
    );
  });

  it('⭐ 서버 응답 타입이 **비어 있을 수 있다고** 적혀 있다', () => {
    /* 타입이 `string` 이면 화면은 `null` 을 못 보고, 그 500 이 다시
       돌아옵니다. 타입도 사실을 말해야 합니다. */
    for (const rel of [
      join('webapp', 'src', 'api', 'types.ts'),
      join('webapp', 'src', 'api', 'hooks.ts'),
    ]) {
      const code = codeOf(readFileSync(join(ROOT, '..', rel), 'utf8'));
      const decl = /\bstarted_at:\s*([^;\n]+)/.exec(code);
      ok(decl !== null, `${rel}: started_at 을 못 찾았습니다 — 가드가 낡았습니다`);
      ok(
        /\bnull\b/.test(decl?.[1] ?? ''),
        `${rel}: started_at 이 비어 있을 수 없다고 적혀 있습니다 — ${decl?.[1]}`,
      );
    }
  });
});

describe('⛔ 만든 화면에 **들어갈 문**이 있다 (결함 305)', () => {
  /* 채팅·일정·알림·활동 기록·찾기·보고서 — **여섯 화면이 제품 어디에서도
     안 닿았습니다.** 주소를 손으로 치는 것 말고는 방법이 없었습니다.

     원인은 실패 ① 그대로입니다. `@lib/nav/links.ts` 의 `navLinks` 는 그
     여섯으로 가는 링크를 **정확히 만들고 있었고**, 주석에는 「⚠️ 탭이
     아니라 여기입니다」라고 왜 여기 두는지까지 적혀 있었습니다. 그리는
     쪽(`demo/nav.ts`)도 멀쩡했습니다 —

         const host = document.getElementById('nav');
         if (!host) return;                    // ← 언제나 여기서 돌아섬

     `<nav id="nav">` 이 **열두 화면 어디에도 없었습니다.** 2026-08-07 에
     「위쪽 링크 줄을 아래로 내렸습니다」라며 탭바로 바꾸면서 그 자리를
     지웠고, 그 뒤에 만든 여섯 화면이 **이미 없어진 줄**에 등록됐습니다.
     오류도 안 나고 테스트도 다 초록이었습니다.

     ⚠️ **「부르는가」를 세는 가드는 이걸 못 잡습니다** — `nav.ts` 는
     `navLinks` 를 제대로 부릅니다. 잡히지 않은 것은 **그린 것이 갈 곳**
     입니다. 그래서 이 가드는 요구를 잽니다: 만든 화면마다 문이 있는가. */

  const shellScreens = (): string[] =>
    readdirSync(PUBLIC)
      .filter((name) => name.endsWith('.html'))
      .filter((name) => /id="tabs"/.test(readFileSync(join(PUBLIC, name), 'utf8')))
      .map((name) => name.replace(/\.html$/, ''))
      .sort();

  it('⭐ 셸을 쓰는 화면에는 **더 보기 줄이 설 자리**가 있다', () => {
    const missing = shellScreens().filter(
      (stem) => !/id="nav"/.test(readFileSync(join(PUBLIC, `${stem}.html`), 'utf8')),
    );
    ok(
      missing.length === 0,
      '`demo/nav.ts` 는 `#nav` 이 있어야 `navLinks` 를 그립니다. 이 화면에는 그 자리가 없어\n' +
        '    거기서는 채팅·일정·알림·활동·찾기·보고서로 **갈 길이 없습니다**:\n    ' +
        missing.join(', '),
    );
  });

  it('⭐ 만든 화면마다 **탭이든 더 보기 줄이든** 문이 하나는 있다', () => {
    /* 여기가 진짜 요구입니다. 화면을 새로 만들고 `navLinks` 에 안 넣으면
       그 화면은 아무도 못 갑니다 — 여섯이 그랬습니다. */
    const nav = readFileSync(join(LIB, 'nav', 'links.ts'), 'utf8');
    const doored = new Set<string>();
    // 탭 넷
    for (const m of nav.matchAll(/const TAB_ORDER: ScreenId\[\] = \[([^\]]+)\]/g)) {
      for (const q of (m[1] ?? '').matchAll(/'([a-z]+)'/g)) {
        if (q[1] !== undefined) doored.add(q[1]);
      }
    }
    // 더 보기 줄이 만드는 주소
    for (const m of nav.matchAll(/href: `\/([a-z-]+)\.html/g)) {
      if (m[1] !== undefined) doored.add(m[1]);
    }

    ok(doored.size >= 8, `문을 만드는 자리를 못 찾았습니다 — 가드가 헛돕니다 (${doored.size}개)`);

    /* 셸을 쓰는 화면 = 사람이 머무는 화면입니다. 녹음(`index`)·통화(`call`)는
       셸이 없고 회의 안에서만 뜻이 있어 여기서 뺍니다. */
    const orphans = shellScreens().filter((stem) => !doored.has(stem));
    ok(
      orphans.length === 0,
      '이 화면은 **들어갈 문이 하나도 없습니다** — 주소를 손으로 치는 수밖에 없습니다.\n' +
        '    `@lib/nav/links.ts` 의 `navLinks` 에 넣거나, 넣지 않을 이유를 여기 적으세요:\n    ' +
        orphans.join(', '),
    );
  });
});

describe('⛔ 확정 줄이 **안 잰 사람에게 `0.0%`** 라고 적지 않는다 (결함 307)', () => {
  /* 갓 만든 프로젝트에서 기여도 카드는 정확히 말합니다 —

         —                    ← 구간
         모르는 폭 100%p
         이 사람의 활동이 아직 하나도 연결되지 않았습니다
           — 0 이라는 뜻이 아니라 연결이 없다는 뜻입니다.

     그런데 **여섯 줄 아래** 확정 줄이 「시스템 **0.0%**」였습니다. 한 화면이
     같은 사실을 두고 서로 다른 말을 합니다(결함 290 과 같은 모양). 그리고
     [이 값으로 확정] 을 누르면 그 0 이 기록으로 남고, 최종 보고서가
     「측정하지 못했습니다」 두 줄 아래에서 「팀 확정 0%」라고 적었습니다 —
     불변식 ③(측정 불가 ≠ 0점)이 **팀 밖으로 나가는 문서**에서 깨진 것입니다.

     원인은 한 줄이었습니다:

         const system = (systemValues.get(ms.user_id) ?? 0).toFixed(1);

     `?? 0` 이 「모른다」를 「0」으로 바꿉니다. */
  const screen = (): string => codeOf(readFileSync(join(DEMO, 'contributions.tsx'), 'utf8'));

  it('⭐ 시스템 값 글자를 **화면이 직접 짓지 않는다** — 판단은 `@lib`', () => {
    const code = screen();
    ok(/systemLabel\(/.test(code), '`systemLabel` 을 안 부릅니다 — 판단이 화면으로 돌아왔습니다');
    ok(
      !/systemValues\.get\([^)]*\)\s*\?\?\s*0/.test(code),
      '`systemValues.get(...) ?? 0` — 「모른다」를 0 으로 바꾸고 있습니다 (결함 307)',
    );
  });

  it('⭐ **안 잰 사람**을 가르는 물음을 실제로 던진다', () => {
    const code = screen();
    ok(
      /nothingMeasured\(/.test(code),
      '`nothingMeasured` 를 안 묻습니다 — 카드와 확정 줄이 갈라집니다',
    );
    // 값을 서버로 보낼 때도 같은 물음을 넘겨야 합니다 (팀이 적은 0 이 접히지 않게).
    ok(
      /toPayload\(drafts, systemValues, unmeasured\)/.test(code),
      '`toPayload` 에 안 잰 사람 목록을 안 넘깁니다 — 팀이 적은 0 이 「안 건드렸다」로 접힙니다',
    );
  });
});

describe('⛔ 나간 사람도 **이름으로** 부른다 (결함 308)', () => {
  /* 팀원을 내보내고 화면을 열었더니 두 곳이 번호를 적고 있었습니다.

       칸반   DB 스키마 정리 · **사용자 #3** · 마감 2026-09-03
       기여도  **사용자 #3** · 개발 · 18~32%

     기여도 쪽이 더 나빴습니다 — **바로 위에서** 「박지원 님은 이 프로젝트를
     떠났지만 그때 한 일은 계산에 그대로 들어 있습니다」라고 말하면서 이름
     자리에는 번호를 적었습니다. 이름을 아는 화면이 그랬습니다.

     ⚠️ `@lib` 의 `nameOf` 는 결함 222 때 이미 나간 사람을 찾도록 고쳐졌고
     **SPA 는 넘기고 있었습니다.** 레거시 화면만 안 넘겼습니다 — 「한 갈래만
     고치고 옆 갈래를 그대로 둔 것」(결함 298→301 과 같은 부류). */

  it('⭐ 레거시 기여도 화면이 **나간 사람 명단을** `nameOf` 에 넘긴다', () => {
    const code = codeOf(readFileSync(join(DEMO, 'contributions.tsx'), 'utf8'));
    ok(
      /former_members/.test(code),
      '서버가 `former_members` 로 이름을 보내는데 화면이 안 읽습니다 (결함 308)',
    );
    const bare = [...code.matchAll(/nameOf\(([^)]*)\)/g)].map((m) => m[1] ?? '');
    const missing = bare.filter((args) => !/former/.test(args));
    ok(
      missing.length === 0,
      '`nameOf` 에 나간 사람 명단을 안 넘깁니다 — 그 줄이 「사용자 #N」이 됩니다:\n    ' +
        missing.join('\n    '),
    );
  });

  it('⭐ 칸반은 **부르는 명단**과 **고르는 명단**을 가른다', () => {
    /* ⚠️ 나간 사람을 `members` 에 섞으면 담당자를 **고르는** 자리
       (`AssigneePicker`)에도 들어가, 떠난 사람에게 새 일을 맡길 수 있게
       됩니다. 이름을 부르는 것과 고르는 것은 다른 일입니다. */
    const code = codeOf(readFileSync(join(DEMO, 'kanban.tsx'), 'utf8'));
    ok(/former_assignees/.test(code), '서버의 `former_assignees` 를 안 읽습니다 (결함 308)');
    ok(
      /assigneeText\(task\.assignee_ids, naming\)/.test(code),
      '담당자 이름을 `members` 로 찾고 있습니다 — 나간 사람이 「사용자 #N」이 됩니다',
    );
    ok(
      /<AssigneePicker[^>]*members=\{members\}/.test(code.replace(/\s+/g, ' ')),
      '담당자를 **고르는** 자리에까지 나간 사람이 섞였습니다 — 떠난 사람에게 일을 맡길 수 있습니다',
    );
  });
});

// ══════════════════════════════════════════════════════════════
// 우선순위가 **한쪽 뿌리에만** 그려지던 것 (결함 348)
// ══════════════════════════════════════════════════════════════
//
// 씨앗의 업무 넷이 전부 `priority = 2` 라 우선순위는 **한 번도 안
// 그려져 있었습니다.** 실기 경로(`PATCH /tasks/{id}`)로 `0·1·3` 을 만들고
// 두 칸반을 렌더해 보니:
//
//     SPA      긴급 · 높음 · 낮음 배지 + `⋯` 메뉴에 넷
//     레거시   **우선순위라는 글자가 한 자도 없음**
//
// 판단은 `@lib/kanban/priority.ts` 에 다 있었고(`test_repo_integrity.py`
// 가 서버 어휘와 짝까지 잽니다), **부르는 화면이 SPA 하나뿐**이었습니다.
// 실패 ①(만들어 놓고 아무도 안 부름)이 뿌리 하나에서 난 모양이고,
// 「한쪽만 고쳐진다」의 **열 번째**입니다
// (231·306·320·321·333·334·335·337·345).
//
// ⚠️ **라우트를 세는 가드는 이걸 못 봅니다** (결함 315 가 적어 둔 그것) —
// `PATCH /tasks/{id}` 는 옮기기가 이미 부르고 있어서 초록입니다. 안 불린
// 것은 **`priority` 라는 칸**이었습니다.

describe('우선순위를 두 뿌리가 다 그린다 (결함 348)', () => {
  /**
   * 뿌리마다 화면 소스 전부. **합쳐서 세면 한쪽만 고쳐도 초록입니다** —
   * 결함 321 이 바로 그렇게 통과했습니다.
   */
  const rootsOf = (): Array<[string, { rel: string; code: string }[]]> => {
    const collect = (base: string): { rel: string; code: string }[] => {
      const out: { rel: string; code: string }[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
            out.push({ rel: full.slice(base.length + 1), code: readFileSync(full, 'utf8') });
        }
      };
      walk(base);
      return out;
    };
    return [
      ['레거시', collect(DEMO)],
      ['SPA', collect(join(ROOT, '..', 'webapp', 'src'))],
    ];
  };

  /**
   * 요구를 갈라 잽니다 — **보는 것**과 **정하는 것**은 다른 일입니다.
   *
   * ⚠️ 낱말 하나(`priority`)를 세면 안 됩니다. 그 글자는 타입 선언에도
   * `PATCH` 본문에도 있어서, 화면이 아무것도 안 그려도 걸립니다 —
   * 결함 316 이 「낱말을 막는 것은 요구를 재는 것이 아니다」로 적어 둔
   * 그것입니다. **`@lib` 의 어느 함수를 거치는가**로 잽니다.
   */
  const NEEDS: Array<[string, RegExp]> = [
    ['값을 **보여 주는** 자리', /\bdescribePriority\(/],
    ['`보통` 을 안 그리는 판단', /\bshowsBadge\(/],
    ['값을 **정하는** 자리', /\bpriorityChoices\(/],
  ];

  for (const [rootName, files] of rootsOf()) {
    for (const [what, ruler] of NEEDS) {
      it(`⭐ ${rootName} — ${withJosa(what, '이가')} 있다`, () => {
        const callers = files.filter((f) => ruler.test(codeOf(f.code))).map((f) => f.rel);
        ok(
          callers.length > 0,
          `${rootName} 에서 ${ruler.source} 를 부르는 화면이 0개입니다 — ` +
            '판단은 `@lib/kanban/priority.ts` 에 있는데 이 뿌리만 안 부릅니다',
        );
      });
    }
  }

  it('⭐ 정하는 자리는 **네 값을 다** 준다 — 목록을 손으로 적지 않는다', () => {
    /* 화면이 `[0,1,2,3]` 을 직접 적으면 어휘가 늘 때 한쪽만 늘어납니다.
       `priorityChoices` 가 `PRIORITIES` 를 돌므로 그 함수를 거치면 됩니다. */
    for (const [rootName, files] of rootsOf()) {
      const hand = files.filter((f) => /\[\s*0\s*,\s*1\s*,\s*2\s*,\s*3\s*\]/.test(codeOf(f.code)));
      deepStrictEqual(
        hand.map((f) => f.rel),
        [],
        `${rootName}: 우선순위 목록을 화면이 손으로 적었습니다 — priorityChoices 를 쓰세요`,
      );
    }
  });

  it('⛔ 우선순위가 기여도에 닿지 않는다 — 드롭다운 하나가 점수 발행기가 됩니다', () => {
    /* `priority.ts` 가 주석으로 금지한 것입니다. 주석은 아무것도 안
       막으므로(결함 337·341) 여기서 잽니다 — 서버가 이 값으로 기여
       이벤트를 만들면 아무 일도 안 하고 자기 업무를 `긴급` 으로 바꾸는
       것만으로 점수가 오릅니다. */
    const scoring = join(ROOT, '..', 'backend', 'teamflow', 'contribution');
    const guilty: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.py')) {
          const py = readFileSync(full, 'utf8').replace(/#[^\n]*/g, ' ');
          if (/\.priority\b|\bpriority\s*=/.test(py)) guilty.push(entry.name);
        }
      }
    };
    walk(scoring);
    deepStrictEqual(guilty, [], '기여도 계산이 우선순위를 읽습니다');
  });
});

// ══════════════════════════════════════════════════════════════
// 누를 때마다 초점이 `body` 로 떨어지던 것 (결함 349)
// ══════════════════════════════════════════════════════════════
//
// 레거시 칸반의 카드 컨트롤은 요청이 도는 동안 `disabled` 가 됩니다.
// 브라우저는 초점을 쥔 요소가 `disabled` 가 되면 **초점을 버리고**, 다시
// `enabled` 가 돼도 돌려주지 않습니다. 키보드만 쓰는 사람은 카드를 한 칸
// 옮길 때마다 문서 맨 앞에서 다시 Tab 해야 했습니다.
//
// 재현(1440×1000, 키보드만):
//
//     담당자 체크박스에서 Space   → 200 PATCH · 초점 BODY
//     「검토 중으로」에서 Enter    → 200 PATCH · 초점 BODY
//     우선순위 라디오에서 ↓       → 200 PATCH · 초점 BODY
//
// ⚠️ 마우스로는 아무 일도 안 일어납니다 — **눈으로는 안 보입니다.**
// 결함 280·303 이 대화상자와 로비에서 적어 둔 것의 세 번째 자리입니다.
//
// ⚠️ **담당자·우선순위만 고치고 한 번 재 봤다가** 「옮기기」가 그대로
// `body` 인 것을 잡았습니다 — 그 버튼은 카드가 다른 열로 가면서 **통째로
// 사라져** 되돌릴 데가 없었습니다. 「한 갈래만 고치고 옆 갈래를 그대로 둔
// 것」(결함 298·301)이 될 뻔했습니다.

describe('일이 끝나면 초점을 되돌린다 (결함 349)', () => {
  const raw = readFileSync(join(DEMO, 'kanban.tsx'), 'utf8');
  const code = codeOf(raw);
  const count = (re: RegExp): number => (code.match(re) ?? []).length;

  it('⭐ **잴 것이 있는가** — 요청 중에 잠그는 컨트롤이 실제로 있다', () => {
    /* 이걸 먼저 봅니다. 화면이 잠금을 아예 안 쓰게 되면 아래 검사들이
       거저 통과합니다 — 결함 347 의 「빈손이면 `⊆` 는 거저 참」과 같은
       부류입니다. */
    ok(count(/disabled=\{moving\}/g) >= 3, '요청 중에 잠그는 자리가 셋도 안 됩니다');
  });

  it('⭐ 잠금을 만지는 자리가 **둘뿐**이다 — 기억하는 곳과 되돌리는 곳', () => {
    /* `setMoving(` 을 갈래마다 직접 부르면 **그 갈래만** 초점을 잃습니다.
       실제로 셋 다 그랬습니다. 판단을 한 곳으로 모으는 것이 고침입니다. */
    strictEqual(
      count(/setMoving\(/g),
      2,
      '`setMoving` 을 `lock`·`unlock` 밖에서 부릅니다 — 그 갈래는 초점을 잃습니다',
    );
  });

  it('⭐ 거는 곳과 푸는 곳의 **짝이 맞는다**', () => {
    const locks = count(/\block\(\);/g);
    const unlocks = count(/\bunlock\(\);/g);
    ok(locks >= 3, `잠그는 갈래가 ${locks}개뿐입니다 — 담당자·옮기기·우선순위 셋입니다`);
    strictEqual(locks, unlocks, `잠그는 곳 ${locks} · 푸는 곳 ${unlocks} — 짝이 안 맞습니다`);
  });

  it('⭐ 되돌릴지 말지를 **`@lib` 이 정한다** — 화면이 손으로 정하지 않는다', () => {
    ok(/focusPlan\(/.test(code), '`@lib/ui/focus.ts` 의 `focusPlan` 을 안 거칩니다');
    /* ⚠️ 그 자리가 사라진 갈래(`nearby`)까지 씁니다. 안 쓰면 카드를 옮긴
       뒤에 초점이 `body` 에 남습니다 — 고치려던 바로 그 증상입니다. */
    ok(/'nearby'/.test(code), '카드가 옮겨 간 갈래를 안 씁니다 — 옮기기는 그대로 초점을 잃습니다');
  });

  it('⚠️ 한 프레임 기다린 뒤에 되돌린다 — 안 그러면 아직 `disabled` 라 튕긴다', () => {
    ok(
      /requestAnimationFrame\(/.test(code),
      'React 가 다시 그리기 전에 `focus()` 를 부르면 그 자리가 아직 `disabled` 입니다',
    );
  });
});

// ══════════════════════════════════════════════════════════════
// 레일의 알약이 숫자만 적어서 귀가 눈보다 많이 알던 것 (결함 350)
// ══════════════════════════════════════════════════════════════
//
//     눈:  1주차 정기회의   3
//     귀:  1주차 정기회의, 검토 필요, 업무 후보 3건 검토 대기
//
// 결함 336(홈의 리본 옆 `80%`)과 **같은 모양**입니다 — 축 이름이
// `aria-label` 에만 있으면 눈으로 보는 사람이 값을 다른 뜻으로 읽습니다.
//
// 그리고 여기서는 **읽힐 다른 뜻이 이미 정해져 있습니다.** 이 셸은 일부러
// 메신저를 본떴고(`docs/19`), 그 세계에서 채널 이름 옆의 둥근 알약은
// **안 읽은 개수**입니다. 이 제품에도 안 읽은 알림이 있고 같은 모양
// (`--r-round` + 강조 채움)으로 그립니다.
//
// 세어 보고 정했습니다 — 두 뿌리의 세는 알약 여섯 중 **다섯**이 바로 앞에
// 축 이름을 답니다(「할 일 2」·「검토 필요 3」·「안 읽은 알림 3」·「{n}명」·
// 「업무 4」). 이름을 안 다는 것은 이 하나뿐이었습니다.

describe('레일의 개수 알약이 축 이름을 눈에도 적는다 (결함 350)', () => {
  const nav = codeOf(readFileSync(join(DEMO, 'nav.ts'), 'utf8'));

  it('⭐ 알약 글자를 **`@lib` 이 정한다** — 화면이 손으로 만들지 않는다', () => {
    ok(
      /channelCountText\(/.test(nav),
      '셸이 알약 글자를 스스로 만듭니다 — `@lib/nav/channels.ts` 의 `channelCountText` 를 쓰세요',
    );
  });

  it('⛔ 개수를 **숫자만** 알약에 넣지 않는다 — 그것이 결함이었다', () => {
    /* ⚠️ 낱말이 아니라 요구를 잽니다(결함 316) — 「`pending` 을 쓰는가」로
       재면 `aria-label` 쪽까지 걸립니다. 막을 것은 **숫자 하나를 알약
       상자에 그대로 넣는 것**입니다. */
    const bare = /chan-count[^`]*\$\{\s*escapeHtml\(String\((?:channel\.)?pending\)\)\s*\}/;
    strictEqual(
      bare.test(nav),
      false,
      '알약에 숫자만 넣습니다 — 메신저 셸에서 그 모양은 「안 읽은 개수」로 읽힙니다',
    );
  });

  it('⭐ 눈과 귀가 **같은 축**을 말한다', () => {
    /* 한쪽만 고치면 고친 게 아니라 옮긴 것입니다. 두 함수가 같은 낱말을
       내는지 `channels.test.ts` 가 값으로 잽니다 — 여기서는 화면이 그
       둘을 **다 쓰는지** 봅니다. */
    ok(/channelAriaLabel\(/.test(nav), '낭독기 이름표를 안 붙입니다');
    ok(/channelCountText\(/.test(nav), '눈에 보이는 글자를 `@lib` 에서 안 받습니다');
  });
});

// ══════════════════════════════════════════════════════════════
// 회의 **첫 발화**의 시각이 빈칸으로 나가던 것 (결함 353)
// ══════════════════════════════════════════════════════════════
//
// 8분짜리 회의를 실기 경로로 만들어 두 검토 화면을 열었더니, `0:00` 에
// 시작한 첫 발화의 시각 칸이 **두 뿌리 다 비어** 있었습니다.
//
//     (빈칸)  김민수 · 정보 제공   0번째로 진행 상황을 공유합니다
//      0:30   이하늘 · 정보 제공   1번째로 진행 상황을 공유합니다
//
// 빈칸은 「모른다」로 읽힙니다. 그런데 그 시각은 **정확히 압니다.**
//
// 원인은 `0` 에 두 뜻이 실려 있던 것입니다 — 같은 자(`atText`)가 **글자까지
// 똑같이 두 파일에 복사돼** 있었고(`findings.ts` · `minutes.ts`), 둘 다
// `ms <= 0` 을 `null` 로 떨어뜨렸습니다. 사건·미해결 사안에는 맞는 규칙
// 입니다(근거가 없으면 구간이 `0~0`). 그런데 발화 한 줄이 그 자를 썼습니다.
//
// ⚠️ **실기가 그 값을 만듭니다** — `to_segments` 의 `start_ms = start *
// hop_ms` 에서 `start` 는 0부터입니다. 녹음 버튼을 누르며 바로 말하면
// 첫 구간이 정확히 `0` 입니다.

describe('발화의 `0` 은 시각이고, 근거 구간의 `0` 은 「모른다」 (결함 353)', () => {
  const review = join(ROOT, 'src', 'lib', 'review');

  it('⭐ mm:ss 를 만드는 자리가 **한 곳**이다', () => {
    /* 두 벌이 있으면 다음 사람이 아무거나 가져다 씁니다 — 실제로 그래서
       발화가 「근거가 없으면 0」 쪽 자를 썼습니다 (대표 실패 ②). */
    const makers: string[] = [];
    for (const file of readdirSync(review).filter((f) => f.endsWith('.ts') && !f.includes('.test.'))) {
      const code = codeOf(readFileSync(join(review, file), 'utf8'));
      if (/padStart\(2,\s*'0'\)/.test(code) && /\/\s*60/.test(code)) makers.push(file);
    }
    deepStrictEqual(
      makers,
      ['moment.ts'],
      'mm:ss 를 만드는 자리가 여럿입니다 — 판단은 `moment.ts` 한 곳입니다',
    );
  });

  it('⭐ **발화 한 줄**은 `0` 을 시각으로 그리는 자를 쓴다', () => {
    const code = codeOf(readFileSync(join(review, 'evidence.ts'), 'utf8'));
    ok(
      /at:\s*momentText\(/.test(code),
      '발화의 시각을 `momentText` 로 안 만듭니다 — `0:00` 이 빈칸으로 나갑니다',
    );
    ok(
      !/\batText\(/.test(code),
      '발화 한 줄이 「근거가 없으면 0」 쪽 자를 씁니다 — 첫 발화가 빈칸이 됩니다',
    );
  });

  it('⭐ **사건·미해결 사안**은 `0` 을 「모른다」로 둔다 — 근거를 적어 내린 결정', () => {
    /* 이쪽을 같이 고치면 근거 없는 사건이 **회의 맨 처음에 있었던 일**로
       읽힙니다. 뒤집지 않았다는 것을 못 박아 둡니다. */
    for (const file of ['findings.ts', 'minutes.ts']) {
      const code = codeOf(readFileSync(join(review, file), 'utf8'));
      ok(
        /atText\s*=\s*evidenceMomentText/.test(code),
        `${file} 이 근거 구간용 자를 안 씁니다`,
      );
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 기여도 줄을 **점수 순으로 그리지 않는다** — 뿌리마다 (가드)
// ══════════════════════════════════════════════════════════════
//
// 불변식 ①(순위·리더보드 금지)은 이 저장소가 **두 번 어긴** 규칙입니다.
// 판단은 `@lib` 에 있고(`orderForDisplay`) 그 자체는 검사가 붙어 있으며
// (`view.test.ts` — 점수 순으로 넘겨도 이름 순), 서버 쪽 보고서도
// `test_reports.py` 가 잽니다.
//
// ⛔ **안 재던 것은 「화면이 그 함수를 거치는가」였습니다.**
//
// 그리고 이건 조용히 깨집니다 — `GET /api/projects/{id}/contributions` 는
// `sorted(events_by_user)`, 즉 **번호 순**으로 내려옵니다. 시연 데이터에서
// 그 번호 순이 하필
//
//     김민수 42.19 · 이하늘 32.95 · 박지원 24.85
//
// **내림차순**입니다. 화면이 `orderForDisplay` 를 빼먹으면 완벽한
// 리더보드가 그려지는데 **검사는 전부 초록**입니다.
//
// ⚠️ 씨앗이 「이름 순 ≠ 번호 순」이라 다행히 갈라집니다
// (이름 순 김민수·박지원·이하늘 = 번호 1·3·2). 갈라지는 데이터가 없었으면
// 이 가드도 아무것도 못 잽니다.

describe('기여도 줄은 점수 순이 아니다 — 뿌리마다 (불변식 ①)', () => {
  const ROOTS: Array<[string, string]> = [
    ['레거시', join(DEMO, 'contributions.tsx')],
    ['SPA', join(ROOT, '..', 'webapp', 'src', 'screens', 'Contributions.tsx')],
  ];

  for (const [rootName, path] of ROOTS) {
    it(`⭐ ${rootName} — 그리는 목록이 **이름 순으로 다시 세운 것**이다`, () => {
      /* ⚠️ **「파일에 그 낱말이 있는가」로 재면 안 됩니다.** 레거시는 그
         함수를 두 곳에서 부르는데(초안 하나, 그리는 목록 하나), 그리는
         쪽만 빼도 낱말은 그대로 남습니다 — 심어 보고 알았습니다.
         재야 할 것은 **JSX 에서 그리는 그 목록이** 거기서 나왔는가입니다.

         ⚠️ 자를 두 번 고쳤습니다:
         ① `= … orderForDisplay(` 사이를 `[\s\S]{0,120}` 로 뒀더니 `;` 를
            넘어가 **다음 문장의 호출을 앞 변수 것으로** 붙였습니다
         ② `.map(` 을 전부 셌더니 값 표를 만드는 `new Map(…​.map(…))` 까지
            「그린다」로 잡혔습니다 — JSX 안(`{x.map(`)만 셉니다 */
      const code = codeOf(readFileSync(path, 'utf8'));
      const ordered = new Set(
        [...code.matchAll(/(?:const|let)\s+(\w+)[^=;]*=\s*[^;}]{0,160}?orderForDisplay\(/g)].map(
          (hit) => hit[1],
        ),
      );
      ok(ordered.size > 0, `${rootName}: orderForDisplay 로 만든 목록이 없습니다`);

      /* 사람 줄을 그리는 자리 — 이 저장소가 기여도 한 줄에 쓰는 이름은
         `ms`(레거시) · `member`(SPA) 입니다. 이름을 바꾸면 아래 「찾았는가」
         가 터지므로 **조용히 통과하지는 않습니다.** */
      const rows = [...code.matchAll(/\{\s*(\w+(?:\.\w+)*)\.map\(\s*\(?\s*(\w+)/g)]
        .filter((hit) => hit[2] === 'ms' || hit[2] === 'member')
        .map((hit) => hit[1]);
      ok(
        rows.length > 0,
        `${rootName}: 사람 줄을 그리는 자리를 못 찾았습니다 — 이 가드가 낡았습니다`,
      );

      const raw = [...new Set(rows)].filter((name) => !ordered.has(name));
      deepStrictEqual(
        raw,
        [],
        `${rootName} 가 서버가 준 순서를 그대로 그립니다(${raw.join(', ')}) — 그 순서는 ` +
          '번호 순이고, 시연 데이터에서는 하필 점수 내림차순입니다(= 리더보드)',
      );
    });

    it(`⛔ ${rootName} — 사람 목록을 **값으로** 정렬하지 않는다`, () => {
      /* ⚠️ 낱말이 아니라 요구를 잽니다 — `sort` 자체는 범주·근거를 줄
         세우는 데도 씁니다. 막을 것은 **사람의 값**으로 세우는 것입니다. */
      const code = codeOf(readFileSync(path, 'utf8'));
      const byValue = code.match(
        /\.sort\(\s*\([^)]*\)\s*=>\s*[^)]*\b(share|score|ratio|range_high|range_low|confidence)\b/g,
      );
      deepStrictEqual(
        byValue ?? [],
        [],
        `${rootName}: 사람을 값으로 줄 세웁니다 — 정렬이 곧 순위입니다`,
      );
    });
  }

  it('⚠️ **갈라지는 데이터로 재고 있는가** — 이름 순과 번호 순이 다른가', () => {
    /* 씨앗이 `김민수(1)·이하늘(2)·박지원(3)` 이면 두 기준이 같아져
       번호 순으로 나가도 통과합니다. 이 저장소가 정렬 검사에서 한 번
       당한 함정입니다 — 그래서 그 전제를 여기서 못 박습니다. */
    const seed = readFileSync(join(ROOT, '..', 'scripts', 'seed_demo.py'), 'utf8');
    for (const name of ['김민수', '이하늘', '박지원']) {
      ok(seed.includes(name), `씨앗에 ${name} 이 없습니다 — 이 가드의 전제가 깨졌습니다`);
    }
    // 이름 순: 김 < 박 < 이 → 번호로는 1 · 3 · 2 (번호 순 1 · 2 · 3 과 다름)
    const byName = ['김민수', '박지원', '이하늘'];
    const byId = ['김민수', '이하늘', '박지원'];
    strictEqual(
      byName.join() === byId.join(),
      false,
      '이름 순과 번호 순이 같은 씨앗입니다 — 정렬 검사가 아무것도 안 잽니다',
    );
  });
});

// ══════════════════════════════════════════════════════════════
// 사람이 넣은 긴 글이 **페이지를 가로로 늘리던 것** (결함 354)
// ══════════════════════════════════════════════════════════════
//
// 자기소개(`USER-004`)는 이 제품에서 사람이 직접 넣는 제일 긴 글입니다
// (300자). 씨앗에는 **한 번도 없어서**(`bio` 가 전부 `null`) 아무도
// 그려진 것을 본 적이 없었습니다.
//
// 넣어 보니 — 띄어쓰기가 있는 평범한 글은 멀쩡합니다. **긴 주소를 붙여
// 넣으면** 갈라집니다:
//
//     레거시 설정   한 줄 1540px · 문서 1849px > 창 1600px
//                   `body` 가 `overflow-x: hidden` → 넘친 만큼 **영영 안 보임**
//     SPA 팀원      한 줄 1619px — `.pane__body`(auto)가 담아 줘서 스크롤로 닿음
//
// 원인은 **플렉스 항목의 기본값 `min-width: auto`** 입니다. 내용의 최소
// 크기 아래로 안 줄어들어서, `app.css` 가 `body` 에 걸어 둔
// `overflow-wrap: break-word` 가 **일할 자리가 없습니다** — 끊을 필요가
// 생기기 전에 상자가 먼저 자랍니다.
//
// ⚠️ **저장소가 이미 두 곳에 적어 둔 규칙입니다** — 「긴 URL 이나
// `owner/repository` 같은 영문 덩어리는 끊어야 가로로 안 밀립니다」와
// 「**모든** 자식에 `min-width: 0` 이 필요합니다」. 사람이 넣는 제일 긴
// 글을 그리는 자리에만 빠져 있었습니다.

describe('사람이 넣은 긴 글이 가로로 안 민다 (결함 354)', () => {
  const RULES: Array<[string, string, RegExp]> = [
    [
      '레거시 설정의 자기소개',
      join(ROOT, 'public', 'project.html'),
      /\.mbio\s*\{[^}]*\}/,
    ],
    [
      'SPA 팀원 줄의 글 칸',
      join(ROOT, '..', 'webapp', 'src', 'app.css'),
      /\.member-row\s*>\s*div\s*\{[^}]*\}/,
    ],
  ];

  for (const [what, path, ruler] of RULES) {
    it(`⭐ ${what} 은 **줄어들 수 있다** (\`min-width: 0\`)`, () => {
      const css = readFileSync(path, 'utf8');
      const rule = css.match(ruler);
      ok(
        rule !== null,
        `${what}: 규칙을 못 찾았습니다 — 이 가드가 낡았습니다(선택자가 바뀌었나요?)`,
      );
      ok(
        /min-width:\s*0/.test(rule[0]),
        `${what}: \`min-width: 0\` 이 없습니다 — 플렉스 항목의 기본값 ` +
          '`min-width: auto` 는 내용 최소 크기 아래로 안 줄어들어서, 긴 주소 하나가 ' +
          '페이지를 가로로 늘립니다',
      );
    });
  }

  it('⚠️ 끊을 규칙 자체는 **공용에 살아 있다** — 위 검사의 전제', () => {
    /* `min-width: 0` 만으로는 안 됩니다. 끊어 주는 것은 `overflow-wrap`
       이고, 그건 `body` 에 한 벌 걸려 있습니다. 그게 사라지면 위 검사가
       초록인 채로 다시 밀립니다 — **전제를 같이 재십시오.** */
    const SHARED: Array<[string, string]> = [
      ['레거시', join(ROOT, 'public', 'app.css')],
      ['SPA', join(ROOT, '..', 'webapp', 'src', 'app.css')],
    ];
    for (const [name, path] of SHARED) {
      const css = readFileSync(path, 'utf8');
      ok(
        /overflow-wrap:\s*break-word/.test(css),
        `${name}: 긴 덩어리를 끊는 규칙이 없어졌습니다`,
      );
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 칸반으로 가는 주소는 **프로젝트를 달고 있어야** 한다 (결함 355)
// ══════════════════════════════════════════════════════════════

describe('칸반 주소에 프로젝트가 실려 있다', () => {
  /**
   * 레거시 칸반은 `Number(params.get('project') ?? '1')` 입니다 —
   * 주소에 프로젝트가 없으면 **1번 프로젝트**를 엽니다. `nav/links.ts` 의
   * 머리말이 바로 이것을 금지합니다: "id 가 없는데 링크를 만들면 눌렀을 때
   * 엉뚱한 프로젝트(기본값 1)로 갑니다. **없는 링크를 안 만드는 것이
   * 여기서 하는 판단입니다.**"
   *
   * 그런데 같은 판단이 `home/next.ts`·`review/phase.ts` 에도 있었고 그쪽은
   * 안 지키고 있었습니다(대표 실패 ②). 프로젝트가 하나뿐인 시연
   * 데이터에서는 기본값 1 이 **언제나 맞아서** 아무 일도 안 일어납니다 —
   * 두 번째 프로젝트를 만들고 그쪽 회의에서 눌러야 드러납니다.
   *
   * ⚠️ **낱말이 아니라 요구를 잽니다.** "`nextStepFor` 가 인자를 둘
   * 받는가" 는 자리를 바꾸면 눈을 감습니다. 여기서 재는 것은 **주소
   * 자체**입니다 — 어디서 만들든 `?` 뒤에 `project=` 가 있어야 합니다.
   *
   * ⚠️ **주석부터 걷습니다** (결함 238). 이 저장소는 "예전에는
   * `/kanban.html?meeting=6` 이었다" 를 주석에 적어 둡니다 — 안 걷으면
   * 고쳐 놓은 자리가 자기 설명 때문에 빨개집니다.
   */
  const stripComments = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(?<![:\w])\/\/[^\n]*/g, '');

  /** 뿌리마다 따로 셉니다 — 한쪽만 고친 것이 이 저장소의 대표 실패입니다. */
  const ROOTS: Array<[string, string]> = [
    ['레거시(frontend/src)', join(ROOT, 'src')],
    ['SPA(webapp/src)', join(ROOT, '..', 'webapp', 'src')],
  ];

  for (const [name, base] of ROOTS) {
    it(`⭐ ${name} — \`kanban.html?\` 주소는 전부 \`project=\` 를 단다`, () => {
      const found: string[] = [];
      const bad: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
            continue;
          }
          if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith('.test.ts')) continue;
          const source = stripComments(readFileSync(full, 'utf8'));
          for (const m of source.matchAll(/kanban\.html(\?[^`'"\s<>]*)?/g)) {
            const where = `${full.split('/').slice(-2).join('/')}: ${m[0]}`;
            found.push(where);
            const query = m[1];
            if (query !== undefined && !query.includes('project=')) bad.push(where);
          }
        }
      };
      walk(base);

      /* ⚠️ **안 보고 있는 상태 자체가 실패입니다.** 화면을 옮기면 가드가
         눈을 감습니다 — 이 저장소에서 여덟 번 그랬습니다. */
      ok(found.length > 0, `${name}: 칸반 주소를 한 개도 못 찾았습니다 — 이 가드가 낡았습니다`);
      deepStrictEqual(
        bad,
        [],
        `${name}: 프로젝트 없이 칸반으로 보내는 주소가 있습니다 — ` +
          '레거시 칸반은 없으면 1번 프로젝트를 엽니다',
      );
    });
  }

  it('⭐ 판단 함수가 프로젝트를 **기본값 없이** 요구한다', () => {
    /* ⚠️ `Function.length` 로 세면 안 됩니다 — **기본값이 붙은 인자는 그
       수에 안 들어갑니다**(결함 247). 선언을 읽어서 잽니다.

       기본값을 두면 두 화면이 조용히 옛 동작을 이어받고 타입이 아무것도
       안 막습니다. 그게 이 결함이 오래 산 이유입니다. */
    const CASES: Array<[string, string, string]> = [
      [join(ROOT, 'src', 'lib', 'home', 'next.ts'), 'nextStepFor', 'projectId'],
      [join(ROOT, 'src', 'lib', 'review', 'phase.ts'), 'reviewEmptyState', 'projectId'],
    ];
    for (const [path, fn, param] of CASES) {
      const source = readFileSync(path, 'utf8');
      const declared = new RegExp(`export function ${fn}\\(([\\s\\S]*?)\\)\\s*:`).exec(source);
      ok(declared !== null, `${fn}: 선언을 못 찾았습니다 — 이 가드가 낡았습니다`);
      const params = declared[1] as string;
      ok(
        new RegExp(`${param}\\s*:\\s*number`).test(params),
        `${fn}: \`${param}: number\` 를 안 받습니다 — ${params}`,
      );
      ok(
        !new RegExp(`${param}\\s*:\\s*number\\s*=`).test(params),
        `${fn}: \`${param}\` 에 기본값이 붙었습니다 — 그러면 화면이 조용히 옛 동작을 이어받습니다`,
      );
    }
  });
});

// ══════════════════════════════════════════════════════════════
// SPA 셸의 탭은 **지금 보는 프로젝트를 잃지 않는다** (결함 356)
// ══════════════════════════════════════════════════════════════

describe('셸 탭이 프로젝트를 잃지 않는다', () => {
  const SHELL = join(ROOT, '..', 'webapp', 'src', 'components', 'AppShell.tsx');
  /* ⚠️ **어휘를 여기 다시 적지 않습니다.** `ScreenId` 는 타입이라 실행
     시점에 없으므로, 원본인 `nav/links.ts` 의 유니언을 읽어서 씁니다 —
     화면이 하나 늘면 이 가드도 같이 자랍니다. */
  const SCREEN_IDS: string[] = (() => {
    const source = readFileSync(join(ROOT, 'src', 'lib', 'nav', 'links.ts'), 'utf8');
    const union = /export type ScreenId =([\s\S]*?);/.exec(source);
    ok(union !== null, '`ScreenId` 유니언을 못 찾았습니다 — 이 가드가 낡았습니다');
    return [...(union[1] as string).matchAll(/'([a-z]+)'/g)].map((m) => m[1] as string);
  })();
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<![:\w])\/\/[^\n]*/g, '');

  it('⭐ 탭 주소를 화면이 **손으로 적지 않는다**', () => {
    /* 예전에는 셸이 네 칸의 주소를 직접 적었고, 그래서 「홈」만 `'/'`
       였습니다 — 프로젝트 2 의 칸반을 보다가 홈을 누르면 목록 첫 번째
       (1번)로 떨어지고, 그때부터 탭 셋이 전부 1번을 가리켰습니다.
       레일을 다시 눌러야 돌아갈 수 있었습니다.

       `appRailHref` 는 처음부터 `/?project=N` 을 만들고 있었고, 그
       머리말이 「SPA 의 홈은 프로젝트 하나의 계기판입니다 — 어느
       프로젝트의 계기판인지를 `?project=` 로 말합니다」라고 적어
       뒀습니다. 레일만 그것을 부르고 있었습니다(실패 ①·②). */
    const source = stripComments(readFileSync(SHELL, 'utf8'));
    ok(
      /appRailHref\(/.test(source),
      '셸이 `appRailHref` 를 안 부릅니다 — 주소를 손으로 적으면 레일과 갈라집니다',
    );
    const handmade = [...source.matchAll(/`\/project\/\$\{[^`]*`/g)].map((m) => m[0]);
    deepStrictEqual(
      handmade,
      [],
      '셸이 SPA 주소를 손으로 적고 있습니다 — `appRailHref` 를 쓰십시오',
    );
  });

  it('⭐ 탭이 가리키는 화면은 **전부 프로젝트를 실어 나른다**', () => {
    /* ⚠️ 이건 배선이 아니라 **요구**입니다. 탭 넷이 가리키는 화면
       각각에 대해, `@lib` 이 만드는 주소가 프로젝트 번호를 담고 있어야
       합니다. 담지 않으면 그 칸을 누르는 순간 「어느 프로젝트인가」가
       사라집니다.

       ⚠️ 7 로 잽니다 — 1 이면 레거시 칸반의 기본값(`?? '1'`)과 갈라지지
       않아 아무것도 못 잽니다(결함 355 가 같은 함정을 겪었습니다). */
    for (const screen of ['home', 'kanban', 'contributions', 'project'] as const) {
      const href = appRailHref(screen, 7);
      ok(
        href.includes('7'),
        `${screen}: 주소에 프로젝트가 없습니다 — ${href}`,
      );
    }
  });

  it('⚠️ 셸이 탭에 쓰는 화면 이름이 `@lib` 의 어휘에 **실제로 있다**', () => {
    /* 이름을 오타 내면 `appRailHref` 가 조용히 칸반으로 떨어뜨립니다
       (`STAYS` 에 없는 화면의 기본 동작). 그러면 「기여도」를 눌렀는데
       칸반이 열립니다 — 오류는 안 납니다. */
    const source = stripComments(readFileSync(SHELL, 'utf8'));
    const used = [...source.matchAll(/screen:\s*'([a-z]+)'\s*as const/g)].map((m) => m[1]);
    ok(used.length === 4, `셸의 탭이 넷이 아닙니다(${used.length}) — 이 가드가 낡았습니다`);
    for (const screen of used) {
      ok(
        SCREEN_IDS.includes(screen as string),
        `셸이 모르는 화면 이름을 씁니다: ${screen}`,
      );
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 채널을 만들 때 **종류를 고를 수 있다** (결함 360)
// ══════════════════════════════════════════════════════════════

describe('채널 종류를 화면이 고른다', () => {
  const CHAT = join(ROOT, 'src', 'demo', 'chat.tsx');
  const stripComments = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/(?<![:\w])\/\/[^\n]*/g, '');

  it('⭐ 만드는 요청이 종류를 **박아 두지 않는다**', () => {
    /* 예전에는 `kind: 'text'` 였습니다. 서버는 처음부터 둘 다 받았고
       화면은 음성 채널을 제대로 그렸는데(`voiceChannelNote`), 만들 길만
       없었습니다 — 그런데 `vocab.py` 는 「두 종류 다 화면에서 만들 수
       있고」라고, `docs/20` 은 CHANNEL-002 를 ✅ 라고 적어 뒀습니다.

       ⚠️ **주석부터 걷습니다** (결함 238) — 이 저장소는 「예전에는
       `kind: 'text'` 였다」를 주석에 적어 둡니다. */
    const source = stripComments(readFileSync(CHAT, 'utf8'));
    const pinned = [...source.matchAll(/kind:\s*'(\w+)'/g)].map((m) => m[1]);
    deepStrictEqual(
      pinned,
      [],
      `채널을 만들 때 종류가 박혀 있습니다: ${pinned.join(', ')}`,
    );
  });

  it('⭐ 종류 목록을 **서버에서 받아** 그린다 — 화면이 지어내지 않는다', () => {
    /* ⚠️ 화면이 자기 표를 만들면 서버의 `CHANNEL_LABEL` 과 두 벌이 되고,
       종류가 늘 때 한쪽만 고쳐집니다 (`/api/chat/reactions` 와 같은 이유).

       그래서 재는 것은 **낱말이 아니라 배선**입니다: 그 주소를 부르고,
       받은 것을 그대로 돌면서 그립니다. */
    const source = stripComments(readFileSync(CHAT, 'utf8'));
    ok(
      /\/api\/chat\/channel-kinds/.test(source),
      '채널 종류를 서버에서 안 받아 옵니다',
    );
    ok(
      /kinds\.map\(/.test(source),
      '받은 목록을 돌면서 그리지 않습니다 — 화면이 목록을 지어내고 있을 수 있습니다',
    );
    /* 한국어 이름표가 화면에 **적혀 있으면** 두 벌입니다. */
    for (const word of ['텍스트 채널', '음성 채널']) {
      ok(
        !source.includes(word),
        `화면이 종류 이름을 직접 적고 있습니다: ${word} — 서버의 어휘와 두 벌이 됩니다`,
      );
    }
  });

  it('⚠️ 고르는 줄이 **손가락 표적**이다 — 공용 규칙에 기댑니다', () => {
    /* `app.css` 의 `label:has(> input[type='radio'])` 가 줄 전체를
       접촉면으로 만들고 `min-height: var(--tap)` 를 줍니다. 그 규칙이
       사라지면 라디오 점만 표적이 됩니다 — **전제를 같이 잽니다**
       (결함 354 의 방법).

       ⚠️ 이 규칙은 특성도 (0,2,1)로 `.ckind label`(0,1,1)을 **이깁니다.**
       처음에 `display: grid` 로 짰다가 안 먹어서 렌더해서 잡았습니다. */
    const css = readFileSync(join(ROOT, 'public', 'app.css'), 'utf8');
    /* ⚠️ **묶인 선택자**입니다 — `label:has(> input[type='checkbox']),`
       다음 줄에 라디오가 옵니다. 붙어 있다고 가정한 첫 자는 못 찾았습니다. */
    const rule = /label:has\(> input\[type='radio'\]\)[^{]*\{[^}]*\}/.exec(css);
    ok(rule !== null, '공용 라디오 라벨 규칙을 못 찾았습니다 — 이 가드가 낡았습니다');
    ok(
      /min-height:\s*var\(--tap\)/.test(rule[0]),
      '라디오 라벨 줄에 손가락 표적 높이가 없습니다',
    );
  });
});

describe('점수에 안 들어가는 발언 유형이 실제로 다르게 그려진다 (결함 361)', () => {
  /* `review/labels.ts` 의 `ZERO_SCORE` 는 「맞장구·기타는 점수에 안
     들어간다」는 판단이고, 두 뿌리 다 그 값을 받아 클래스를 붙입니다.
     붙이기까지는 둘 다 했는데 **SPA 에서는 아무 일도 안 일어났습니다** —
     `.tally--zero { color: var(--c-ink-muted) }` 인데 그 줄이 담긴
     `.disc__body` 가 이미 `--c-ink-muted` 라, 있던 색을 그대로 다시
     칠하고 있었습니다. 열세 줄이 두 테마에서 전부 같은 색이었고, 하필
     그 회의에서 제일 큰 숫자가 「기타 5」였습니다.

     ⚠️ **낱말이 아니라 요구를 잽니다.** `.tally--zero` 라는 글자가
     있는지가 아니라, **그 규칙이 물려받는 색과 다른 색을 내는가**를
     봅니다 — 글자만 세면 이 결함은 초록입니다(결함 164 의 「심었는데
     아무 일도 안 일어난 것」이 CSS 에서 난 것입니다).

     ⚠️ **뿌리마다 따로 걷습니다** — 레거시는 처음부터 맞았고 SPA 만
     틀렸습니다. 합쳐서 세면 한쪽이 다른 쪽을 덮습니다. */

  const WEBAPP = join(ROOT, '..', 'webapp', 'src');

  const stripCss = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '');

  /** `선택자 { … }` 블록에서 `color:` 값을 꺼낸다. 없으면 `null`. */
  function colorOf(css: string, selector: string): string | null {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 선택자가 쉼표 묶음의 **어디에 있든** 잡습니다 — 첫 줄만 보면
    // 묶음의 둘째 줄에 있는 것을 통째로 놓칩니다.
    const re = new RegExp(`(?:^|[,{}])\\s*[^{}]*?${escaped}(?![-\\w])[^{}]*\\{([^}]*)\\}`, 'm');
    const block = re.exec(css);
    const body = block?.[1];
    if (body === undefined) return null;
    const decl = /(?:^|;)\s*color\s*:\s*([^;}]+)/.exec(body);
    return decl?.[1]?.trim() ?? null;
  }

  /** 같은 블록에서 `font-weight:` 값을 꺼낸다. 없으면 `null`. */
  function weightOf(css: string, selector: string): string | null {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[,{}])\\s*[^{}]*?${escaped}(?![-\\w])[^{}]*\\{([^}]*)\\}`, 'm');
    const block = re.exec(css);
    const body = block?.[1];
    if (body === undefined) return null;
    const decl = /(?:^|;)\s*font-weight\s*:\s*([^;}]+)/.exec(body);
    return decl?.[1]?.trim() ?? null;
  }

  it('⭐ 레거시 — 0점 줄의 색이 보통 줄과 다르다', () => {
    const css = stripCss(readFileSync(join(ROOT, 'public', 'review.html'), 'utf8'));
    const normal = colorOf(css, '.tname');
    const zero = colorOf(css, '.tzero .tname');
    ok(normal !== null, '.tname 의 색 규칙이 없습니다');
    ok(zero !== null, '.tzero .tname 의 색 규칙이 없습니다');
    ok(
      normal !== zero,
      `0점 줄이 보통 줄과 같은 색입니다 — 둘 다 ${String(zero)} 입니다`,
    );
  });

  it('⭐ SPA — 0점 줄의 색이 그 줄이 물려받는 색과 다르다', () => {
    const css = stripCss(readFileSync(join(WEBAPP, 'app.css'), 'utf8'));
    // `.tally` 는 스스로 색을 안 정하고 `.disc__body` 에서 물려받습니다.
    const inherited = colorOf(css, '.disc__body');
    const zero = colorOf(css, '.tally--zero');
    ok(inherited !== null, '.disc__body 의 색 규칙이 없습니다 — 물려받는 자리가 바뀌었습니다');
    ok(zero !== null, '.tally--zero 의 색 규칙이 없습니다');
    ok(
      inherited !== zero,
      `0점 줄이 물려받는 색을 그대로 다시 칠합니다 — 둘 다 ${String(zero)} 입니다`,
    );
  });

  it('⭐ 신호가 색 하나가 아니다 — 고대비에서도 남는다', () => {
    /* `forced-colors: active` 는 **색을 전부 덮습니다.** 색만으로 「안
       세는 것」을 표시하면 고대비에서 열세 줄이 같은 검정이 되고 구별이
       사라집니다 — 실제로 재 보니 SPA 가 그랬고, 레거시는 숫자의 **무게**
       까지 떨어뜨려서 살아남았습니다(400 vs 600).

       ⚠️ 그러니 뿌리마다 **무게가 갈리는지**를 봅니다. 색을 재는 위 두
       검사와 **다른 축**입니다 — 한 축만 재면 다른 축이 죽은 것을
       못 봅니다(결함 280 이 대화상자에서 적어 둔 그것). */
    const cases: Array<[string, string, string, string]> = [
      ['레거시', join(ROOT, 'public', 'review.html'), '.tnum', '.tzero .tname, .tzero .tnum'],
      ['SPA', join(WEBAPP, 'app.css'), '.tally .num', '.tally--zero .num'],
    ];
    for (const [name, file, countedSel, zeroSel] of cases) {
      const css = stripCss(readFileSync(file, 'utf8'));
      const counted = weightOf(css, countedSel);
      const zero = weightOf(css, zeroSel);
      ok(counted !== null, `${name}: ${countedSel} 에 무게가 없습니다`);
      ok(zero !== null, `${name}: ${zeroSel} 에 무게가 없습니다`);
      ok(
        counted !== zero,
        `${name}: 0점 줄과 보통 줄의 무게가 같습니다(${String(zero)}) — 고대비에서 신호가 사라집니다`,
      );
    }
  });

  it('⭐ 두 뿌리가 **다** 그 판단을 화면에 붙인다', () => {
    /* 한쪽만 붙이면 나머지 한쪽에서는 「안 세는 것」이 「세는 것」과
       구별이 안 됩니다. 「부르는가」를 뿌리마다 셉니다. */
    const roots: Array<[string, string]> = [
      ['레거시', readFileSync(join(ROOT, 'src', 'demo', 'review.tsx'), 'utf8')],
      ['SPA', readFileSync(join(WEBAPP, 'screens', 'Review.tsx'), 'utf8')],
    ];
    for (const [name, source] of roots) {
      ok(
        /row\.zero\s*\?/.test(source),
        `${name} 화면이 0점 여부를 안 쓰고 있습니다`,
      );
    }
  });
});

describe('근거 칩을 그리는 자리는 **전부** 접는 판단을 거친다 (결함 364)', () => {
  /* `splitEvidenceChips` 는 「근거가 열둘이면 숫자가 회의 내용보다 먼저
     보인다」를 막으려고 만든 판단이고, 그 머리말이 해악을 그대로 적어
     뒀습니다. 그런데 SPA 검토 화면에서 **부르는 곳이 관찰 줄 하나**였고,
     후보 카드는 `evidence_utterance_ids.map(...)` 으로 전부 그렸습니다.

     근거 열둘짜리 후보를 창 반쪽(720px)에서 열면 맨 숫자가 **세 줄**로
     깔려 제목 바로 아래 제일 넓은 자리를 먹었습니다 — 1440px 에서는 한
     줄에 들어가서 **넓은 창만 보면 안 보입니다.**

     ⚠️ **낱말이 아니라 요구를 잽니다.** 「`EvidenceChips` 라는 글자가
     있는가」가 아니라 **「`EvidenceChip` 을 직접 늘어놓는 자리가 없는가」**
     를 봅니다 — 그래야 다음 사람이 새 자리에서 또 `map` 을 써도 잡힙니다. */

  const WEBAPP2 = join(ROOT, '..', 'webapp', 'src');

  const stripJsx = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/(?<![:\w])\/\/[^\n]*/g, '');

  it('⭐ `EvidenceChip` 을 **직접** 늘어놓는 자리가 없다', () => {
    /* 접는 래퍼(`EvidenceChips`) 안에서만 낱개 칩을 씁니다. 화면이 직접
       `.map(... <EvidenceChip` 을 쓰면 그 자리는 안 접힙니다. */
    const roots: Array<[string, string]> = [
      ['SPA', join(WEBAPP2, 'screens', 'Review.tsx')],
      ['SPA(컴포넌트)', join(WEBAPP2, 'components', 'EvidenceChip.tsx')],
    ];
    const offenders: string[] = [];
    for (const [name, file] of roots) {
      if (!existsSync(file)) continue;
      let source = stripJsx(readFileSync(file, 'utf8'));
      /* ⚠️ **접는 래퍼 자신은 빼고 셉니다.** `EvidenceChips` 안의 `map` 은
         **맞는** 자리입니다 — 그것까지 세면 고쳐 놓고도 빨갛습니다(실제로
         한 번 그렇게 잡혔고, 「왜 빨간지」를 읽어서 알았습니다). */
      source = source.replace(
        /function EvidenceChips[\s\S]*?\n\}\n/,
        '',
      );
      // `…map(` 과 `<EvidenceChip` 이 같은 식 안에 있으면 낱개 나열입니다.
      for (const hit of source.matchAll(/\.map\(\s*\(?[^)]*\)?\s*=>\s*\(?\s*<EvidenceChip\b/g)) {
        offenders.push(`${name}: ${hit[0].replace(/\s+/g, ' ').slice(0, 60)}`);
      }
    }
    deepStrictEqual(
      offenders,
      [],
      `근거 칩을 접지 않고 전부 그리는 자리가 있습니다:\n  ${offenders.join('\n  ')}`,
    );
  });

  it('⭐ 접는 래퍼가 `@lib` 의 판단을 부른다', () => {
    /* 래퍼가 자기 숫자를 들고 있으면 `@lib` 을 고쳐도 안 따라옵니다
       (결함 363 이 상수에서 겪은 그것). */
    const source = readFileSync(join(WEBAPP2, 'screens', 'Review.tsx'), 'utf8');
    ok(
      /splitEvidenceChips\(/.test(source),
      '접는 래퍼가 `splitEvidenceChips` 를 안 부릅니다 — 문턱을 화면이 따로 들고 있습니다',
    );
    ok(
      !/EVIDENCE_CHIPS_SHOWN\s*=/.test(source),
      '화면이 문턱을 다시 적고 있습니다 — 값은 `@lib` 한 곳에만',
    );
  });

  it('⭐ 문턱을 넘으면 접고, 넘지 않으면 그대로 둔다', () => {
    /* 요구 자체를 `@lib` 에서 확인합니다 — 화면이 어떻게 부르든 이
       성질이 깨지면 접기가 무의미해집니다. */
    const many = splitEvidenceChips([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    strictEqual(many.head.length, EVIDENCE_CHIPS_SHOWN);
    strictEqual(many.rest.length, 7);

    // 하나 남는 것은 접지 않습니다 — 「+1」이 칩보다 넓습니다.
    const justOver = splitEvidenceChips([1, 2, 3, 4, 5, 6]);
    strictEqual(justOver.rest.length, 0);
    strictEqual(justOver.head.length, 6);
  });
});

describe('막힌 단추는 **모든** 막는 길에서 이유를 말한다 (결함 365)', () => {
  /* 레거시 검토 화면의 「제출」이 두 가지로 막힙니다 —
       ① 승인 표시한 것 중 조건이 안 찬 것이 있다 (`blocked > 0`)
       ② 아직 아무것도 안 정했다 (`approving + rejecting === 0`)
     화면은 ①만 적고 ②에는 **빈 문자열**을 그렸습니다. ②는 검토 화면을
     연 사람이 **맨 처음 보는 상태**입니다 — 후보 열둘을 앞에 두고 단추가
     죽어 있는데 왜인지는 화면 어디에도 없었습니다.

     게다가 그 단추는 **진짜 `disabled`** 였습니다. Tab 으로 문서를 한
     바퀴(146번) 돌아도 한 번도 안 닿았고, 닿지 못하니 `aria-describedby`
     로 사유를 들려줄 수도 없습니다 — 결함 234 가 설정의 「저장」 넷에서
     이미 고친 모양이 이 자리에 남아 있었습니다.

     ⚠️ 여기서 재는 것은 **낱말이 아니라 요구**입니다:
       · 화면이 사유를 `@lib` 에서 가져오는가 (화면 코드에는 검사가 없음)
       · 막는 길마다 문장이 있는가 (`@lib` 에서 전수로)
       · 단추가 초점을 받는 모양인가 (`aria-disabled`) */

  const reviewScreen = (): string => {
    const source = demoSource('review');
    ok(source !== null, '레거시 검토 화면을 못 찾았습니다');
    return source as string;
  };

  it('⭐ 레거시 검토 화면이 사유를 `@lib` 에서 가져온다', () => {
    const code = reviewScreen();
    ok(
      /whyCannotSubmitBatch\(/.test(code),
      '「왜 제출이 안 되나」를 화면이 직접 짜고 있습니다 — 판단은 `@lib` 에 (`whyCannotSubmitBatch`)',
    );
    /* ⚠️ 사유를 화면이 **다시** 적으면 두 벌입니다(실패 ②). `@lib` 이
       고쳐져도 화면은 옛 문장을 그립니다. */
    ok(
      !/건에 빠진 정보가 있어/.test(code),
      '화면이 사유 문장을 다시 적고 있습니다 — 문장은 `@lib` 한 곳에만',
    );
  });

  it('⭐ 「제출」이 초점을 받는 모양이다 (결함 234 의 규칙)', () => {
    const code = reviewScreen();
    const button = /<button\b[^>]*\bid="submit"[^>]*>/.exec(code);
    ok(button !== null, '`id="submit"` 단추를 못 찾았습니다');
    const tag = (button as RegExpExecArray)[0];
    ok(
      /aria-disabled=\{/.test(tag),
      '「제출」이 `aria-disabled` 가 아닙니다 — 진짜 `disabled` 는 초점을 못 받아 사유가 안 들립니다',
    );
    ok(
      !/(?<!aria-)\bdisabled=\{/.test(tag),
      '「제출」에 진짜 `disabled` 가 남아 있습니다 — Tab 으로 한 바퀴 돌아도 못 닿습니다',
    );
    ok(
      /aria-describedby=\{/.test(tag),
      '「제출」이 사유 칸을 안 가리킵니다 — 낭독기에는 이유 없이 「사용 불가」로만 들립니다',
    );
  });

  it('⭐ `canSubmit` 이 거짓인 **모든** 길에 문장이 있다', () => {
    /* 낱개 사례를 늘리는 대신 **막는 길을 전수로** 만듭니다 (결함 326 ·
       289 의 방법 — 「어휘의 값 집합과 문구의 키 집합이 같은가」). */
    const context: ReviewContext = { memberIds: [1, 2, 3], today: '2026-09-01' };
    const base = {
      id: 1,
      title: '무엇을 한다',
      assignee_hint: null,
      assignee_id: 1,
      deadline: '2026-09-04',
      confidence: 0.8,
      evidence_utterance_ids: [1],
      review_status: 'pending',
      warnings: [],
    };
    const paths: Array<[string, ReviewSummary]> = [
      ['후보가 0건', summarize([], new Map(), context)],
      ['아무것도 안 정함', summarize([base], new Map(), context)],
      [
        '승인했는데 조건 미충족',
        summarize(
          [{ ...base, assignee_id: null, deadline: null }],
          new Map([[1, { decision: 'approve' as const }]]),
          context,
        ),
      ],
    ];
    const silent: string[] = [];
    for (const [name, summary] of paths) {
      strictEqual(canSubmit(summary), false, `${name}: 이 사례가 안 막혀 있습니다`);
      const why = whyCannotSubmitBatch(summary);
      if (why === null || why.trim() === '') silent.push(name);
    }
    deepStrictEqual(silent, [], `막혔는데 아무 말도 안 하는 길: ${silent.join(', ')}`);
  });
});

describe('끝난 회의에게 「회의 처리가 시작됩니다」라고 하지 않는다 (결함 367)', () => {
  /* `roomStatus().message` 의 마지막 갈래는 「전원 종료했습니다. 회의
     처리가 시작됩니다」입니다. **녹음이 방금 끝난** 회의에게만 참인데,
     레거시 로비는 국면과 상관없이 언제나 그렸습니다 — 씨앗의 회의 1
     (`needs_review`, 후보 셋이 대기)에서 그대로 재현됐습니다.

     SPA 는 `phase.canStart` 로 이미 가르고 있었습니다. 「한쪽 뿌리만」의
     그 모양이라, 여기서는 **뿌리마다 따로** 걷습니다(결함 286). */

  const LOBBIES: Array<[string, string]> = [
    ['레거시', join(DEMO, 'lobby.tsx')],
    ['SPA', join(ROOT, '..', 'webapp', 'src', 'screens', 'Lobby.tsx')],
  ];

  const stripComments = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
      .replace(/(?<![:\w])\/\/[^\n]*/g, ' ');

  it('⭐ 두 뿌리의 로비 화면을 **둘 다** 보고 있다', () => {
    /* 안 보고 있는 상태 자체가 실패여야 합니다 — 파일을 옮기면 자가
       조용히 눈을 감습니다(결함 286). */
    const missing = LOBBIES.filter(([, file]) => !existsSync(file)).map(([name]) => name);
    deepStrictEqual(missing, [], `로비 화면을 못 찾았습니다: ${missing.join(', ')}`);
  });

  it('⭐ 방 소식을 그리는 자리는 **국면으로 가린다**', () => {
    /* ⚠️ 이 자가 못 보는 것: 게이트를 **다른 이름의 지역 변수**로 두면
       (`stillStartable ? room.message : …`) 거짓 양성이 납니다. 그때는
       요구가 아니라 자가 좁은 것이니 자를 넓히십시오 — 지금 두 뿌리는
       `roomLine(` 아니면 `canStart` 를 씁니다. */
    const offenders: string[] = [];
    for (const [name, file] of LOBBIES) {
      if (!existsSync(file)) continue;
      const source = stripComments(readFileSync(file, 'utf8'));
      if (/\broomLine\(/.test(source)) continue; // `@lib` 이 가려 줍니다
      for (const hit of source.matchAll(/\broom\.message\b/g)) {
        const before = source.slice(Math.max(0, hit.index - 200), hit.index);
        if (!/canStart/.test(before)) {
          offenders.push(`${name}: room.message 가 국면 없이 그려집니다`);
        }
      }
    }
    deepStrictEqual(
      offenders,
      [],
      `끝난 회의에게 「처리가 시작됩니다」라고 할 수 있습니다:\n  ${offenders.join('\n  ')}`,
    );
  });

  it('⭐ 시작할 수 없는 국면에서는 「시작됩니다」라는 말이 안 나온다', () => {
    /* 요구 자체를 `@lib` 에서 확인합니다 — 화면이 어떻게 부르든 이
       성질이 깨지면 문장이 거짓이 됩니다. */
    const room = {
      recording: 0,
      notJoined: 0,
      broken: 0,
      needsForceFinish: false,
      message: '전원 종료했습니다. 회의 처리가 시작됩니다',
    };
    const wrong: string[] = [];
    for (const status of ['queued', 'processing', 'needs_review', 'confirmed', 'failed']) {
      const line = roomLine(status, room);
      if (line.includes('시작됩니다') || line.trim() === '') wrong.push(`${status}: ${line}`);
    }
    deepStrictEqual(wrong, [], `끝난 회의에게 하는 말이 틀립니다:\n  ${wrong.join('\n  ')}`);
  });

  it('⭐ 레거시도 `lobbyPhase().note` 를 **그린다** — 만들어 놓고 안 부르던 자리', () => {
    /* 고치기 전 레거시는 `lobbyPhase` 의 `canStart` 만 쓰고 `note` 는
       한 곳에서도 안 그렸습니다(실패 ①). 끝난 회의가 무슨 국면인지
       말해 주는 문장이 그쪽에는 아예 없었습니다. */
    const legacy = stripComments(readFileSync(join(DEMO, 'lobby.tsx'), 'utf8'));
    ok(
      /\broomLine\(/.test(legacy) || /\bphase\.note\b/.test(legacy),
      '레거시 로비가 국면 문장을 한 곳에서도 안 그립니다',
    );
  });
});

describe('회의 줄이 응답을 **통째로** 판단에 넘긴다 (결함 368)', () => {
  /* `nextStepFor` 는 응답의 칸을 보고 다음에 할 일을 정합니다. 화면이
     칸을 골라 새 객체를 만들어 넘기면, 서버에 칸이 하나 늘 때 **그 화면만
     조용히 옛 갈래**로 떨어집니다 — 오류도 안 나고 글자도 그럴듯합니다.

     결함 368 에서 실제로 그럴 뻔했습니다: `utterance_count` 를 SPA 의
     응답 타입에만 안 넣었는데, 값은 JSON 이라 런타임에는 흘러가고 타입만
     거짓말을 했습니다. 칸 집합은 `test_repo_integrity.py` 가 세 자리에서
     맞춰 보고, 여기서는 **넘기는 모양**을 봅니다.

     ⚠️ 이 자가 못 보는 것: `const m = {...meeting}; nextStepFor(m, p)` 처럼
     한 번 거쳐 가면 못 봅니다. 그때는 자를 넓히십시오. */

  const HOMES: Array<[string, string]> = [
    ['레거시', join(DEMO, 'home.tsx')],
    ['SPA', join(ROOT, '..', 'webapp', 'src', 'screens', 'Home.tsx')],
  ];

  it('⭐ 두 뿌리의 홈 화면을 **둘 다** 보고 있다', () => {
    const missing = HOMES.filter(([, file]) => !existsSync(file)).map(([name]) => name);
    deepStrictEqual(missing, [], `홈 화면을 못 찾았습니다: ${missing.join(', ')}`);
  });

  it('⭐ 칸을 골라 새로 만들어 넘기지 않는다', () => {
    const offenders: string[] = [];
    for (const [name, file] of HOMES) {
      if (!existsSync(file)) continue;
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
        .replace(/(?<![:\w])\/\/[^\n]*/g, ' ');
      const calls = [...source.matchAll(/nextStepFor\(\s*([^,]+),/g)];
      if (calls.length === 0) {
        offenders.push(`${name}: nextStepFor 를 안 부릅니다`);
        continue;
      }
      for (const call of calls) {
        const arg = (call[1] as string).trim();
        // 그대로 넘기거나(`meeting`), 펼쳐서 넘기거나(`{ ...meeting`).
        if (!/^[\w.]+$/.test(arg) && !/^\{\s*\.\.\./.test(arg)) {
          offenders.push(`${name}: ${arg.replace(/\s+/g, ' ').slice(0, 50)}`);
        }
      }
    }
    deepStrictEqual(
      offenders,
      [],
      `응답을 통째로 안 넘기는 자리가 있습니다 — 칸이 늘면 이 화면만 옛 갈래로 떨어집니다:\n  ${offenders.join('\n  ')}`,
    );
  });

  it('⭐ 「후보 0건」의 두 이유가 서로 다른 말과 **다른 자리**로 간다', () => {
    /* 요구 자체를 `@lib` 에서 확인합니다 — 화면이 어떻게 부르든. */
    const base = {
      meeting_id: 7,
      title: '회의',
      status: 'needs_review',
      started_at: '2026-09-01T01:00:00Z',
      scheduled_at: null,
      pending_candidates: 0,
    };
    const spoke = nextStepFor({ ...base, utterance_count: 12 }, 4);
    const silent = nextStepFor({ ...base, utterance_count: 0 }, 4);
    ok(spoke.reason !== silent.reason, '두 이유가 같은 문장을 받습니다');
    ok(spoke.href !== silent.href, '두 이유가 같은 곳으로 보냅니다');
    ok(
      !silent.reason.includes('업무가 나오지 않았습니다'),
      '소리가 안 잡힌 회의에게 「업무가 나오지 않았습니다」라고 합니다',
    );
  });
});

describe('화면이 덧칠한 버튼도 **막힌 모양**을 갖는다 (결함 373)', () => {
  /* `app.css` 는 `button[aria-disabled="true"]` 로 「덜 채운 모양」을
     정합니다 (0,1,1). 그런데 화면의 `<style>` 이 `.acts .approve` (0,2,0)
     로 채움을 덧칠하면 **그 규칙이 이깁니다** — 막힌 등록 단추가 눌리는
     것과 **똑같이 진한 남색**이었습니다(결함 250 과 같은 자리).

     ⚠️ 이 자가 **못 보는 것**: 색이 실제로 다른지는 안 봅니다(브라우저가
     없습니다). 재는 것은 **막힌 갈래를 위한 규칙이 있는가**입니다 —
     같은 토큰을 다시 적어도 통과합니다. 색은 렌더해서 봅니다. */

  /* ⚠️ 경로를 지어내지 않습니다 — 이 파일에 `PUBLIC` 이 이미 있습니다.
     처음엔 `join(ROOT, '..', 'public')` 이라고 써서 `ENOENT` 로 터졌습니다. */
  it('⭐ 화면이 채움을 덧칠한 버튼 중 **막힐 수 있는 것**은 짝 규칙이 있다', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(PUBLIC).filter((f) => f.endsWith('.html'))) {
      const html = readFileSync(join(PUBLIC, file), 'utf8');
      const screen = join(DEMO, `${file.replace(/\.html$/, '')}.tsx`);
      if (!existsSync(screen)) continue;
      const code = readFileSync(screen, 'utf8');

      for (const style of html.match(/<style>[\s\S]*?<\/style>/g) ?? []) {
        const css = style.replace(/\/\*[\s\S]*?\*\//g, ' ');
        const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
          sel: (m[1] ?? '').replace(/\s+/g, ' ').trim(),
          body: m[2] ?? '',
        }));
        for (const { sel, body } of rules) {
          if (!/\bbackground\s*:/.test(body)) continue;
          if (/:hover|:focus|:active|::|aria-disabled/.test(sel)) continue;
          const cls = sel.match(/\.([\w-]+)\s*$/)?.[1];
          if (cls === undefined) continue;
          // 화면이 이 클래스를 가진 버튼을 **막을 수 있는가**.
          const canBlock = new RegExp(
            `className=\\{[^}]*'${cls}[^}]*\\}[\\s\\S]{0,300}?aria-disabled=|aria-disabled=[\\s\\S]{0,300}?className=\\{[^}]*'${cls}`,
          ).test(code);
          if (!canBlock) continue;
          const paired = rules.some(
            (r) => r.sel.includes(`.${cls}`) && r.sel.includes('aria-disabled') && /\bbackground\s*:/.test(r.body),
          );
          if (!paired) {
            offenders.push(`${file}: \`${sel}\` 가 채움을 덧칠하는데 막힌 갈래 규칙이 없습니다`);
          }
        }
      }
    }
    deepStrictEqual(
      offenders,
      [],
      `막힌 단추가 눌리는 것과 똑같이 보입니다:\n  ${offenders.join('\n  ')}`,
    );
  });
});

describe('보내는 값은 **지금 값**이다 — useCallback 이 안 쥔 state (결함 376)', () => {
  /* 채널 만들기 폼은 종류(텍스트·음성)를 고르게 합니다. 그런데
     `addChannel` 의 deps 가 `[newName, loadChannels]` 라, 콜백은 **이름이
     바뀔 때만** 다시 만들어집니다. 사람은 대개 **이름을 먼저 적고 종류를
     고르므로**, 클로저가 쥔 `newKind` 는 옛 값(`'text'`)입니다.

       이름먼저 → 종류  →  {"kind":"text","name":"음성A"}   ← 고른 값이 버려짐
       종류먼저 → 이름  →  {"kind":"voice","name":"음성B"}

     서버는 그 값을 받아 **201** 을 주고 화면에는 아무 오류도 안 납니다.
     즉 「음성 채널」은 사실상 만들 수 없었습니다.

     ⚠️ 이 자가 **못 보는 것**: `sendJson` 의 **본문 리터럴**만 봅니다.
     값을 헬퍼로 감싸 보내거나(`toPayload(...)`) URL 에 실어 보내면 안
     보입니다. 그리고 **함수형 갱신**(`setX((prev) => …)`)만 쓰는 state 는
     deps 가 필요 없는데 여기서는 본문에 안 나오므로 자연히 빠집니다. */

  const SCREENS = readdirSync(DEMO).filter((f) => f.endsWith('.tsx'));

  /** 짝이 맞는 닫는 괄호/중괄호까지. */
  const spanFrom = (text: string, at: number, open: string, close: string): string => {
    let depth = 0;
    for (let i = at; i < text.length; i += 1) {
      if (text[i] === open) depth += 1;
      else if (text[i] === close) {
        depth -= 1;
        if (depth === 0) return text.slice(at, i + 1);
      }
    }
    return text.slice(at);
  };

  it('⭐ `sendJson` 본문에 실리는 state 는 **모두 deps 에 있다**', () => {
    const offenders: string[] = [];
    for (const file of SCREENS) {
      const code = readFileSync(join(DEMO, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
        .replace(/(?<![:\w])\/\/[^\n]*/g, ' ');
      const states = [...code.matchAll(/const \[(\w+), set\w+\] = useState/g)].map((m) => m[1]!);
      if (states.length === 0) continue;

      for (const cb of code.matchAll(/useCallback\(\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]*)?=>\s*\{/g)) {
        const bodyStart = cb.index! + cb[0].length - 1;
        const body = spanFrom(code, bodyStart, '{', '}');
        const after = code.slice(bodyStart + body.length, bodyStart + body.length + 400);
        const deps = /^\s*,\s*\[([^\]]*)\]/.exec(after);
        if (deps === null) continue;
        const listed = new Set(
          (deps[1] ?? '').split(',').map((d) => d.trim()).filter((d) => d !== ''),
        );

        /* `sendJson(url, METHOD, {본문})` 의 **본문만** 봅니다 — URL 을 같이
           보면 `/channels` 같은 경로 글자가 state 이름과 겹쳐 **맞는 자리**를
           잡습니다(실제로 `channels` 가 그렇게 걸렸습니다). */
        for (const call of body.matchAll(/sendJson\s*\(/g)) {
          const args = spanFrom(body, call.index! + call[0].length - 1, '(', ')');
          /* ⚠️ **첫 `{` 를 본문 시작으로 삼으면 안 됩니다** — URL 이
             `` `/api/projects/${'${projectId}'}/channels` `` 라 그 안의 `${'${'}` 가
             먼저 걸리고, 그러면 경로 글자(`channels`)가 state 이름과 겹쳐
             **맞는 자리**를 잡습니다. 최상위 쉼표로 인자를 갈라 **세 번째**
             인자만 봅니다. */
          const inner = args.slice(1, -1);
          const parts: string[] = [];
          let depth = 0;
          let last = 0;
          for (let k = 0; k < inner.length; k += 1) {
            const ch = inner[k];
            if (ch === '(' || ch === '[' || ch === '{') depth += 1;
            else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
            else if (ch === ',' && depth === 0) {
              parts.push(inner.slice(last, k));
              last = k + 1;
            }
          }
          parts.push(inner.slice(last));
          const payload = parts.slice(2).join(',');
          if (payload.trim() === '') continue;
          for (const name of states) {
            if (listed.has(name)) continue;
            if (!new RegExp(`\\b${name}\\b`).test(payload)) continue;
            offenders.push(`${file}: \`${name}\` 를 보내면서 deps 에 안 넣었습니다`);
          }
        }
      }
    }
    deepStrictEqual(
      offenders,
      [],
      `고른 값이 조용히 버려지고 서버는 201 을 줍니다:\n  ${[...new Set(offenders)].join('\n  ')}`,
    );
  });
});

describe('찾기 게이트는 **두 화면이 한 벌**을 쓴다 (결함 375)', () => {
  /* 같은 「두 글자 이상」 규칙이 두 곳에 있었습니다. 찾기 화면은 `@lib` 의
     `blockedReason` 으로 이유를 말하는데, 채팅은 `query.trim().length < 2`
     를 손으로 적고 **아무 말도 안 했습니다.** 빈 칸일 때는 placeholder
     (「두 글자 이상」)가 가려 주지만, **한 글자를 적는 순간** placeholder 가
     사라지면서 이유가 화면에서 통째로 없어집니다.

     ⚠️ 이 자가 **못 보는 것**: 문장이 **맞는 말인가**는 안 봅니다 —
     그건 `view.test.ts` 가 봅니다(없는 칸을 시키지 않는가). */

  const SCREENS: Array<[string, string]> = [
    ['채팅', join(DEMO, 'chat.tsx')],
    ['찾기', join(DEMO, 'search.tsx')],
  ];

  it('⭐ 두 화면을 **둘 다** 보고 있다', () => {
    const missing = SCREENS.filter(([, f]) => !existsSync(f)).map(([n]) => n);
    deepStrictEqual(missing, [], `찾기가 있는 화면을 못 찾았습니다: ${missing.join(', ')}`);
  });

  it('⭐ 규칙을 화면이 **다시 적지 않는다**', () => {
    const offenders: string[] = [];
    for (const [name, file] of SCREENS) {
      if (!existsSync(file)) continue;
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
        .replace(/(?<![:\w])\/\/[^\n]*/g, ' ');
      /* 「두 글자」라는 **숫자를 화면이 아는 것** 자체가 사본입니다. */
      if (/\.trim\(\)\.length\s*[<>=]+\s*2/.test(code)) {
        offenders.push(`${name}: 「두 글자」 규칙을 화면이 다시 적습니다`);
      }
      if (!/canSearch\(/.test(code)) {
        offenders.push(`${name}: canSearch 를 안 씁니다`);
      }
      if (!/blockedReason\(/.test(code)) {
        offenders.push(`${name}: 막힌 이유를 안 말합니다`);
      }
      /* 진짜 `disabled` 는 초점을 못 받아 사유를 못 들려줍니다 (결함 234·373).
         ⚠️ 한 화면만 고치고 옆 화면을 두는 것이 이 저장소에서 제일 흔한
         재발 모양이라(결함 298·301), 둘 다 봅니다. */
      const tag = /<button\b[\s\S]{0,600}?>\s*찾기/.exec(code)?.[0] ?? '';
      if (tag === '') {
        offenders.push(`${name}: 찾기 단추를 못 찾았습니다 — 가드가 낡았습니다`);
      } else {
        if (/(?<!aria-)\bdisabled=\{/.test(tag)) {
          offenders.push(`${name}: 찾기 단추가 진짜 disabled 입니다 — 키보드가 못 닿습니다`);
        }
        if (!/aria-describedby=\{/.test(tag)) {
          offenders.push(`${name}: 찾기 단추가 사유를 가리키지 않습니다`);
        }
      }
    }
    deepStrictEqual(
      offenders,
      [],
      `한 글자를 적으면 이유가 화면에서 사라집니다:\n  ${offenders.join('\n  ')}`,
    );
  });
});

describe('로비의 녹음·통화 게이트는 **닿을 수 있다** (결함 374)', () => {
  /* 레거시는 `disabled={!affordance.enabled}` 였습니다. 씨앗의 다섯 회의
     **전부**에서 이 단추는 막혀 있고, Tab 으로는 한 번도 안 닿았습니다 —
     즉 「전원 동의 후 시작할 수 있습니다」·「이미 끝난 회의입니다」라는
     말을 키보드·낭독기만 쓰는 사람은 **영영 못 듣습니다.** SPA 는 결함
     219 에서 같은 자리를 이미 고쳤습니다(`aria-disabled` + `tabIndex`).

     ⚠️ 이 자가 **못 보는 것**: 막는 판단(`recordAffordance`)이 맞는지는
     안 봅니다 — 그건 `room.test.ts` 가 봅니다. 여기서는 **닿는가**와
     **누르면 되돌아가는가**만 봅니다. */

  const SCREENS: Array<[string, string, RegExp]> = [
    ['레거시', join(DEMO, 'lobby.tsx'), /id="record"[\s\S]{0,400}?\/>|id="record"[\s\S]{0,600}?<\/button>/],
    ['SPA', join(ROOT, '..', 'webapp', 'src', 'screens', 'Lobby.tsx'), /canGoRecord[\s\S]{0,800}?tabIndex/],
  ];

  it('⭐ 두 뿌리의 로비 화면을 **둘 다** 보고 있다', () => {
    const missing = SCREENS.filter(([, f]) => !existsSync(f)).map(([n]) => n);
    deepStrictEqual(missing, [], `로비 화면을 못 찾았습니다: ${missing.join(', ')}`);
  });

  it('⭐ 녹음·통화가 **진짜 `disabled` 로 막히지 않는다**', () => {
    const offenders: string[] = [];
    for (const [name, file] of SCREENS) {
      if (!existsSync(file)) continue;
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
        .replace(/(?<![:\w])\/\/[^\n]*/g, ' ');
      /* 막는 값이 `disabled` 에 들어가면 초점을 잃습니다. 이름을 세지 않고
         **막는 값이 어디에 쓰였는가**를 봅니다. */
      const gate = name === '레거시' ? 'affordance\\.enabled' : 'canGoRecord';
      const hard = new RegExp(`(?<!aria-)\\bdisabled=\\{[^}]*${gate}`).test(code);
      if (hard) offenders.push(`${name}: 막는 값이 진짜 disabled 에 들어갑니다 — 키보드가 못 닿습니다`);
      const soft = new RegExp(`aria-disabled=\\{[^}]*${gate}`).test(code);
      if (!soft) offenders.push(`${name}: 막힘을 aria-disabled 로 그리지 않습니다`);
    }
    deepStrictEqual(
      offenders,
      [],
      `막힌 녹음·통화 단추에 키보드가 못 닿습니다:\n  ${offenders.join('\n  ')}`,
    );
  });

  it('⭐ 막혔을 때 **누르면 되돌아간다** — 그리기만 하면 요청이 나갑니다', () => {
    const code = readFileSync(join(DEMO, 'lobby.tsx'), 'utf8');
    /* `aria-disabled` 는 낭독기에게 하는 말일 뿐입니다. 손이 그 값을 보고
       되돌아가지 않으면 막힌 단추가 그냥 눌립니다(결함 280·365). */
    const guarded = code.match(/if\s*\(!affordance\.enabled\)\s*return;/g) ?? [];
    strictEqual(
      guarded.length,
      2,
      `녹음·통화 둘 다 되돌아가야 합니다 — 지금 ${guarded.length}곳`,
    );
  });
});

describe('막힌 「업무로 등록」은 **닿을 수 있고 왜인지 말한다** (결함 373)', () => {
  /* 레거시는 `disabled={blockers.length > 0}` 이었습니다. 진짜 `disabled`
     는 **초점을 못 받습니다** — 문서를 한 바퀴(Tab 56번) 돌아도 막힌
     카드의 이 단추에는 **한 번도 안 닿았고**, 사유 줄은 눈에만 있었지
     단추와 이어져 있지 않았습니다(`aria-describedby` 없음). SPA 는 같은
     화면에서 `aria-disabled` + `conds-N` 으로 이미 제대로 하고 있었습니다.

     ⚠️ 이 자가 **못 보는 것**: 사유 줄이 **화면에 그려지는지**는 여기서
     안 봅니다(`check.tone !== 'none'` 갈래). 그건 `blockerLine` 의
     검사가 봅니다. */

  const SCREENS: Array<[string, string]> = [
    ['레거시', join(DEMO, 'review.tsx')],
    ['SPA', join(ROOT, '..', 'webapp', 'src', 'screens', 'Review.tsx')],
  ];

  const stripped = (file: string): string =>
    readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
      .replace(/(?<![:\w])\/\/[^\n]*/g, ' ');

  it('⭐ 두 뿌리의 검토 화면을 **둘 다** 보고 있다', () => {
    const missing = SCREENS.filter(([, f]) => !existsSync(f)).map(([n]) => n);
    deepStrictEqual(missing, [], `검토 화면을 못 찾았습니다: ${missing.join(', ')}`);
  });

  it('⭐ 등록 단추가 **진짜 `disabled` 가 아니고** 사유를 가리킨다', () => {
    const offenders: string[] = [];
    for (const [name, file] of SCREENS) {
      if (!existsSync(file)) continue;
      const code = stripped(file);
      /* ⚠️ 창은 **재 보고** 정합니다 — SPA 는 `onClick` 본문이 길어
         여는 태그에서 라벨까지 1500자입니다. 좁게 잡으면 단추를 못 찾고
         「가드가 낡았습니다」로 헛돕니다(결함 285·372 회차). */
      const tag =
        /<button\b[\s\S]{0,2000}?(업무로 등록|>\s*등록\s*<)/.exec(code)?.[0] ?? '';
      if (tag === '') {
        offenders.push(`${name}: 등록 단추를 못 찾았습니다 — 가드가 낡았습니다`);
        continue;
      }
      // 진짜 `disabled` 는 초점을 못 받아 사유를 못 들려줍니다 (결함 234).
      if (/(?<!aria-)\bdisabled=\{/.test(tag)) {
        offenders.push(`${name}: 등록 단추가 진짜 disabled 입니다 — 키보드가 못 닿습니다`);
      }
      if (!/aria-disabled=\{/.test(tag)) {
        offenders.push(`${name}: 등록 단추가 막힘을 안 그립니다`);
      }
      if (!/aria-describedby=\{/.test(tag)) {
        offenders.push(`${name}: 등록 단추가 사유를 가리키지 않습니다`);
      }
      // 알려만 주고 갈 곳이 없으면 대표 실패 ③ 입니다.
      if (!/firstApprovalGap\(/.test(code)) {
        offenders.push(`${name}: 막힌 단추를 눌러도 데려가지 않습니다`);
      }
    }
    deepStrictEqual(
      offenders,
      [],
      `막힌 등록 단추에 키보드가 못 닿거나 사유가 안 들립니다:\n  ${offenders.join('\n  ')}`,
    );
  });

  it('⭐ 데려갈 칸은 **막는 이유에서** 나온다 — 두 화면이 같은 답', () => {
    /* 화면이 각자 `assignee ?? deadline` 사슬을 짜면 갈라집니다.
       ⚠️ 첫 판은 `effectiveAssignee(…) === null ?` 를 찾았는데, 그건
       Radix `Picker` 의 `value` 를 만드는 **맞는 자리**도 잡았습니다 —
       「잡혔다」는 「맞다」가 아닙니다(결함 298). 재는 것은 **화면이
       칸 이름을 스스로 만드는가**입니다. */
    for (const [name, file] of SCREENS) {
      if (!existsSync(file)) continue;
      const code = stripped(file);
      /* ⚠️ 파일 전체에서 `'assignee'` 를 찾으면 **맞는 자리**가 걸립니다 —
         `className="assignee"` 는 CSS 이름이지 칸 이름이 아닙니다. 재는
         자리를 **막힌 단추의 `onClick` 안**으로 좁힙니다. */
      const click = /onClick=\{\(\)\s*=>\s*\{[\s\S]{0,1200}?firstApprovalGap\(/.exec(code);
      ok(
        click !== null,
        `${name}: 막힌 단추의 onClick 이 firstApprovalGap 을 안 씁니다 — 칸을 스스로 고르고 있습니다`,
      );
    }
  });
});

describe('「이 값으로 확정」은 **두 뿌리 다** 게이트를 거친다 (결함 372)', () => {
  /* v2 F1-4 — **확정값은 시스템이 아니라 팀이 적습니다.** 빈 칸은
     「시스템 값 그대로」가 아니라 「아직 안 정함」입니다.

     SPA 는 그 결정대로 막고 있었고(`3칸 남음`), 레거시는 단추가
     `disabled={saving}` 뿐이었습니다. 팀원 계정으로 **손대지 않은
     화면에서 한 번 누르니** `201 POST /contributions/final` 이 나가고
     기록이 「시스템 값 그대로입니다」로 남았습니다 — 이 제품의 불변식 ④
     (**시스템은 판정하지 않습니다**)가 사람 이름을 쓴 채 깨진 것입니다.

     ⚠️ 이 자가 못 보는 것: 게이트를 **다른 이름**으로 다시 짜면
     (`whyCannotConfirm` 을 안 부르고 손으로) 첫 항목이 잡습니다. 그러나
     `@lib` 을 부르되 **그 값을 안 쓰는** 경우는 두 번째 항목이 봅니다. */

  const SCREENS: Array<[string, string]> = [
    ['레거시', join(DEMO, 'contributions.tsx')],
    ['SPA', join(ROOT, '..', 'webapp', 'src', 'screens', 'Contributions.tsx')],
  ];

  const stripped = (file: string): string =>
    readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
      .replace(/(?<![:\w])\/\/[^\n]*/g, ' ');

  it('⭐ 두 뿌리의 기여도 화면을 **둘 다** 보고 있다', () => {
    const missing = SCREENS.filter(([, f]) => !existsSync(f)).map(([n]) => n);
    deepStrictEqual(missing, [], `기여도 화면을 못 찾았습니다: ${missing.join(', ')}`);
  });

  it('⭐ 확정 단추가 **막힌 이유**를 보고 그린다', () => {
    const offenders: string[] = [];
    for (const [name, file] of SCREENS) {
      if (!existsSync(file)) continue;
      const code = stripped(file);
      /* ⚠️ 창을 넉넉히 잡습니다 — SPA 는 `onClick` 본문이 길어 400자로는
         **단추를 못 찾고** 「가드가 낡았습니다」로 헛돌았습니다(결함 298 이
         적어 둔 「내 가드의 창이 좁아 내 고침을 잡은 것」과 같은 부류). */
      const tag = /<button\b[\s\S]{0,900}?이 값으로 확정/.exec(code)?.[0] ?? '';
      if (tag === '') {
        offenders.push(`${name}: 확정 단추를 못 찾았습니다 — 가드가 낡았습니다`);
        continue;
      }
      /* 막힌 이유를 보고 그리는가. ⚠️ **이름을 세지 않습니다** — 처음엔
         `aria-disabled={…Blocked…}` 라는 **글자**를 봤고, SPA 를 공용
         갈래(`confirmBlock`)로 옮기자 요구는 한 자도 안 바뀌었는데 자만
         빨개졌습니다(결함 335 의 부류). 재는 것은 **그 값이 `@lib` 의
         게이트에서 나왔는가**입니다. ⚠️ 창은 `;` 를 **안 넘습니다** —
         넘겼더니 SPA 가 손으로 짠 갈래를 쓰면서 옆 줄의 `confirmBlockOf(`
         를 앞 변수 것으로 붙여 **심어도 초록**이었습니다. */
      const bound = /aria-disabled=\{([^}]*)\}/.exec(tag)?.[1] ?? '';
      const names = bound.match(/[A-Za-z_$][\w$]*/g) ?? [];
      const fromGate = names.some((n) =>
        new RegExp(`\\b${n}\\b[^\\n]{0,80}=[^;]{0,200}?(whyCannotConfirm|confirmBlockOf)\\(`).test(
          code,
        ),
      );
      if (!fromGate) {
        offenders.push(`${name}: 확정 단추가 막힌 이유를 안 봅니다`);
      }
      // 진짜 `disabled` 는 초점을 못 받습니다 (결함 234).
      if (/(?<!aria-)\bdisabled=\{/.test(tag)) {
        offenders.push(`${name}: 확정 단추에 진짜 disabled 가 남아 있습니다`);
      }
    }
    deepStrictEqual(
      offenders,
      [],
      `손대지 않은 화면에서 한 번 눌러 팀 전체가 확정될 수 있습니다:\n  ${offenders.join('\n  ')}`,
    );
  });

  it('⭐ 빈 칸이 있으면 `@lib` 이 확정을 막는다', () => {
    /* 요구 자체를 `@lib` 에서 확인합니다 — 화면이 어떻게 부르든. */
    // ⚠️ 보는 사람의 등급이 있어야 합니다 — 확정은 관리자·소유자만이고 모르면
    //    잠급니다(결함 392). 안 주면 이 검사는 「권한 없음」만 재게 됩니다.
    const base = { myRole: 'owner', memberCount: 3, unfilled: 0, problems: [], blind: false };
    strictEqual(whyCannotConfirm(base), null);
    ok(whyCannotConfirm({ ...base, unfilled: 1 }) !== null, '빈 칸이 있는데 확정이 열립니다');
    ok(
      (whyCannotConfirm({ ...base, unfilled: 3 }) ?? '').includes('3'),
      '몇 칸 남았는지 안 말합니다',
    );
  });
});

describe('결함 380 — 「누르면 채웁니다」는 서버가 될 때만 (지난 활동 가져오기)', () => {
  /* ## ⛔ 화면이 못 지킬 약속을 하고 단추까지 그렸습니다
   *
   * 설정 → 저장소 연결의 경고 상자가 이렇게 끝났습니다.
   *
   *     … 아래 '지난 활동 가져오기'를 누르면 채웁니다.
   *
   * 그 아래 단추도 멀쩡히 그려집니다. 눌러 보면 **409** 입니다 —
   * 서버는 그 순간 이미 자격 증명이 없다는 것을 **알고 있습니다.**
   *
   * 화면이 못 판단한 이유는 `canBackfill` 이 **배달 수와 백필 이력만**
   * 보고 있었기 때문입니다. 그 필드의 주석은 「눌러도 아무 일이 없고,
   * 사람은 그게 고장인 줄 압니다」라고 **정확히 이 해악을 적어 두고**
   * 한쪽 길만 막고 있었습니다(결함 295 의 「막는 길을 하나만 막은 것」).
   *
   * ⚠️ **결함 300 과 다른 자리입니다** — 300 은 눌렀을 때 나오는 **말**을
   * 고쳤고, 이것은 **누르기 전**입니다.
   */

  it('⭐ `canBackfill` 을 화면 쪽에서 다시 계산하지 않는다', () => {
    /* 이 파일(`github/health.ts`) 머리말이 스스로 적어 둔 규칙입니다 —
       「화면과 서버가 같은 판단을 두 벌 가지고 있으면 언젠가 갈라지고,
       그때 사람은 화면 쪽을 믿습니다.」 그 판단이 바로 여기 있었습니다. */
    const code = readFileSync(join(ROOT, 'src', 'lib', 'github', 'health.ts'), 'utf8');
    const body = /export function describeHealth[\s\S]*?\n}/.exec(code)?.[0] ?? '';
    ok(body !== '', 'describeHealth 를 못 찾았습니다 — 가드가 낡았습니다');

    const line = /canBackfill:([^,\n]*)/.exec(body)?.[1] ?? '';
    ok(line !== '', 'describeHealth 가 canBackfill 을 안 정합니다');
    ok(
      /can_backfill/.test(line),
      `canBackfill 이 서버 값에서 안 옵니다 — 화면이 다시 재고 있습니다: ${line.trim()}`,
    );
    ok(
      !/delivery_count/.test(line),
      `canBackfill 이 배달 수로 다시 계산되고 있습니다: ${line.trim()}`,
    );
  });

  /* ⚠️ **뿌리마다 따로 셉니다.** 한 자루에 담으면 한쪽만 고쳐도 초록입니다
     — 이 저장소가 열여섯 번 당한 모양입니다(231·306·320·321·333·334·335·
     337·345·348·352·365·367·372·373·374). */
  const ROOTS: Array<[string, string]> = [
    ['레거시', join(DEMO, 'project.tsx')],
    ['SPA', join(ROOT, '..', 'webapp', 'src', 'screens', 'Settings.tsx')],
  ];

  for (const [rootName, path] of ROOTS) {
    it(`⭐ ${rootName} — 막혀 있으면 **왜인지** 그린다`, () => {
      /* 버튼만 안 그리면 사람은 기능이 없는 줄 압니다. 서버는 정확한
         문장을 보내고 있으므로(`backfill_blocked`) 그것을 그립니다 —
         결함 316 이 「버튼을 지우지 말고 이유를 말하라」로 적어 둔 그것. */
      const code = readFileSync(path, 'utf8');
      ok(
        /backfillBlocked/.test(code),
        `${rootName} 가 backfillBlocked 를 한 번도 안 그립니다 — 막힌 이유가 화면에서 사라집니다`,
      );
    });
  }
});

describe('결함 390 — 업무에만 걸리는 거르개는 **이름과 결과에서** 그렇게 말한다', () => {
  /* ## ⛔ 김민수로 걸러 놓고 박지원의 발언이 나왔습니다
   *
   * 찾기 화면의 두 거르개는 서버에서 **업무 검색의 조건**입니다
   * (`search_tasks` — SEARCH-002). 회의·회의 내용·GitHub 은 낱말만 봅니다.
   *
   *     담당자 [김민수]        ← 고른 사람
   *     회의       1  DB 스키마 확정 논의
   *     회의 내용   1  1주차 정기회의   박지원   ← 나온 사람
   *
   * 옆 칸은 「업무 상태」라고 자기 범위를 적는데 이 칸만 「담당자」였고,
   * 결과에도 아무 말이 없었습니다. 사람의 기여를 다루는 제품에서 **고른
   * 사람과 다른 사람의 이름**이 결과에 붙는 것이 이 결함입니다.
   *
   * ⚠️ 결함 331(알림의 `at`) · 332(주간 보고서) · 344(팀 값) · 384(신뢰도)
   * 와 같은 부류입니다 — **범위를 말할 때는 이름을 붙이십시오.**
   *
   * ⚠️ 이 가드가 못 보는 것: 라벨을 **다른 낱말**로 범위를 밝히는 경우
   * (「이 업무의 담당자」는 잡히고 「업무 쪽만」은 안 잡힙니다). 지금 이
   * 제품이 쓰는 낱말이 「업무」 하나뿐이라 그 낱말로 잽니다.
   */
  const code = readFileSync(join(DEMO, 'search.tsx'), 'utf8');
  /** 주석을 걷습니다 — 옛 문장을 그대로 인용해 둔 자리가 있습니다(결함 238). */
  const drawn = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  /** `htmlFor="who"` 를 가진 `<label>` 이 그리는 글자. */
  const labelFor = (id: string): string => {
    const at = drawn.indexOf(`htmlFor="${id}"`);
    ok(at !== -1, `htmlFor="${id}" 라벨이 없습니다 — 이 가드가 낡았습니다`);
    const close = drawn.indexOf('</label>', at);
    return drawn.slice(drawn.indexOf('>', at) + 1, close).trim();
  };

  it('⭐ 업무 조건 칸 **둘 다** 이름에 범위를 적는다', () => {
    /* ⚠️ 「업무 상태」 쪽도 같이 잽니다 — 한쪽만 재면 다음 사람이 옆 칸을
       고칠 때 조용히 갈라집니다(결함 298·301 의 모양). */
    for (const id of ['who', 'st']) {
      const text = labelFor(id);
      ok(
        text.includes('업무'),
        `#${id} 라벨이 범위를 안 적습니다: ${JSON.stringify(text)} — ` +
          '이 칸은 업무 검색의 조건입니다',
      );
    }
  });

  it('⭐ 안 걸린 묶음이 있으면 결과에서 **그렇게 말한다**', () => {
    /* 이름만 고치면 「업무 담당자」로 걸렀는데 회의가 왜 나오는지는
       여전히 화면 어디에도 없습니다 — 판단은 `@lib` 한 벌입니다. */
    ok(
      /filterScopeNote\(/.test(drawn),
      '찾기 화면이 filterScopeNote 를 한 번도 안 그립니다 — 거르개가 어디까지 걸렸는지 사라집니다',
    );
  });

  it('⭐ **찾은 때의 값**으로 말한다 — 고르기만 한 값이 아니라', () => {
    /* `asked` 가 입력칸이 아니라 보낸 값을 쥐는 것과 같은 이유입니다.
       고르기만 하고 안 누른 값으로 말하면 그 줄이 결과보다 앞서 갑니다. */
    ok(
      /filterScopeNote\(\s*askedFilters/.test(drawn),
      'filterScopeNote 에 지금 고른 값을 그대로 넘깁니다 — 누르기 전에 말이 바뀝니다',
    );
  });
});

describe('결함 392 — 팀 전원의 숫자를 쓰는 일은 **두 뿌리 다** 등급을 본다', () => {
  /* ## ⛔ 평범한 팀원이 자기 몫을 90% 로 확정했습니다
   *
   * `POST /contributions/final` 은 오래도록 `_require_project_member` 만
   * 봤습니다. 브라우저로 재현했습니다 — 이하늘(팀원)이 김민수 5% ·
   * 박지원 5% · 이하늘 90% 로 확정했고 `201` 이 떨어졌으며 기록은
   * 「이하늘님이 확정했습니다」였습니다.
   *
   * ⚠️ **뒤집은 것이 아니라 적어만 두고 간 숙제입니다.** 라우트 주석이
   * 「지금은 구성원 누구나 … **역할이 생기면 여기부터 좁혀야 합니다**」
   * 라고 조건을 달아 두었고, 그 뒤에 역할이 생겼습니다.
   *
   * ⚠️ 서버만 고치면 화면은 다 채우고 누른 **뒤에야** 403 을 만납니다.
   * 두 뿌리가 게이트에 **등급을 넘기는지**를 여기서 잽니다.
   */
  const ROOTS: Array<[string, string]> = [
    ['레거시', join(DEMO, 'contributions.tsx')],
    ['SPA', join(ROOT, '..', 'webapp', 'src', 'screens', 'Contributions.tsx')],
  ];

  for (const [rootName, path] of ROOTS) {
    it(`⭐ ${rootName} — 확정 게이트에 **보는 사람의 등급**을 넘긴다`, () => {
      const code = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      /* ⚠️ **부르는 자리를 전부** 봅니다. 처음에는 「어딘가 한 곳에
         `myRole` 이 실려 있는가」로 쟀는데, SPA 는 사유 문단에서도 같은
         함수를 부르기 때문에 **정작 단추를 잠그는 호출에서 빼도 초록**
         이었습니다 — 심어 보고 알았습니다(결함 306 의 「부르는 곳을
         세라」를 한 파일 안에 댄 것). */
      const calls = [...code.matchAll(/(whyCannotConfirm|confirmBlockOf)\(\{/g)];
      ok(calls.length > 0, `${rootName} 가 확정 게이트를 한 번도 안 부릅니다`);
      for (const call of calls) {
        // 그 호출의 객체 리터럴 구간만 — 다음 `})` 까지.
        const from = call.index ?? 0;
        const window = code.slice(from, code.indexOf('})', from));
        ok(
          /\bmyRole\b/.test(window),
          `${rootName} 의 ${call[1]} 호출 하나가 등급을 안 넘깁니다 — ` +
            '그 자리는 팀원에게도 열립니다: ' + window.replace(/\s+/g, ' ').slice(0, 90),
        );
      }
      /* 넘기는 값이 **명단에서 온 것**이어야 합니다 — 안 그러면 언제나
         `undefined` 라 모두가 잠깁니다. */
      ok(
        /project_role/.test(code),
        `${rootName} 가 명단에서 등급을 안 읽습니다 — 넘기는 값이 언제나 undefined 입니다`,
      );
    });
  }

  it('⭐ 서버가 **그 행동을 어휘로** 가지고 있다', () => {
    /* 화면만 막으면 API 를 직접 부르는 길이 그대로 열려 있습니다. */
    const perms = readFileSync(
      join(ROOT, '..', 'backend', 'teamflow', 'projects', 'permissions.py'),
      'utf8',
    );
    ok(/CONFIRM_CONTRIBUTIONS/.test(perms), '권한 어휘에 확정이 없습니다');
    const main = readFileSync(
      join(ROOT, '..', 'backend', 'teamflow', 'api', 'main.py'),
      'utf8',
    );
    ok(
      /_require_can\([^)]*Action\.CONFIRM_CONTRIBUTIONS/.test(main),
      '확정 라우트가 그 어휘를 안 씁니다 — 팀원이 API 로 바로 부를 수 있습니다',
    );
  });
});

describe('결함 394 — 끊긴 자리는 **글자로도** 있다 (마우스 전용이 아니다)', () => {
  /* ## ⛔ 「22~23분 · 마이크가 꺼져 있었습니다」에 닿는 길이 마우스뿐이었습니다
   *
   * 레거시 로비의 트랙 그림은 구멍마다 8px 짜리 `<i>` 를 그리고, 그 값을
   * **`title` 에만** 넣었습니다. 그 요소는 글자도 초점도 없습니다 —
   *
   *   · 키보드: 포커스 가능 목록에 없어 **닿지 못합니다**
   *   · 터치:   hover 가 없습니다
   *   · 고대비: 채움이 배경색으로 덮여 **표시 자체가 안 보입니다**(결함 393)
   *
   * 그런데 바로 위 줄은 「커버리지 42% — 이 사람의 발언량은 측정할 수
   * 없습니다」이고, 홈은 이 화면으로 보내며 「트랙이 온전한지 확인하세요」
   * 라고 합니다. 확인할 값이 마우스 뒤에 있으면 그 지시가 반쪽입니다.
   *
   * SPA 는 같은 값을 「?」 팝오버 안에 **글자로** 그리고 있었습니다 —
   * 판단(`describeGap`)은 이미 `@lib` 한 벌이고 갈린 것은 **그리는 방법**
   * 뿐이었습니다. 「한쪽 뿌리만」의 되풀이입니다.
   *
   * ⚠️ 이 가드가 못 보는 것: **다른 화면**의 `title` 전용 값. 같은 부류를
   * 화면 전체로 세는 자는 아직 없습니다.
   */
  const ROOTS: Array<[string, string]> = [
    ['레거시', join(DEMO, 'lobby.tsx')],
    ['SPA', join(ROOT, '..', 'webapp', 'src', 'screens', 'Lobby.tsx')],
  ];

  for (const [rootName, path] of ROOTS) {
    it(`⭐ ${rootName} — describeGap 을 **글자 자리**에도 그린다`, () => {
      const code = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const calls = [...code.matchAll(/describeGap\(/g)];
      ok(calls.length > 0, `${rootName} 가 describeGap 을 한 번도 안 부릅니다`);
      /* `title={describeGap(...)}` 뿐인가, 아니면 자식으로도 그리는가.
         ⚠️ 「부르는가」만 세면 `title` 하나로 초록입니다 — 결함 306 이
         라우트에서 겪은 그것을 한 파일 안에 댄 것입니다. */
      const asTitle = [...code.matchAll(/title=\{\s*describeGap\(/g)].length;
      ok(
        calls.length > asTitle,
        `${rootName} 의 describeGap 이 ${asTitle}곳 전부 title 입니다 — ` +
          '키보드·터치·고대비에서 그 값에 닿는 길이 없습니다',
      );
    });
  }

  it('⭐ `@lib` 의 주석이 「툴팁 전용」이라고 말하지 않는다', () => {
    /* 주석은 아무것도 안 막지만, **다음 사람이 그 말을 믿습니다** —
       레거시가 `title` 에만 넣은 이유가 정확히 그 한 줄이었습니다. */
    const lib = readFileSync(join(ROOT, 'src', 'lib', 'track', 'diagram.ts'), 'utf8');
    const head = lib.slice(lib.indexOf('describeGap') - 700, lib.indexOf('export function describeGap'));
    ok(
      !/툴팁에 씁니다\s*\./.test(head) || /툴팁 전용이 아닙니다/.test(head),
      '`describeGap` 주석이 아직 「툴팁에 씁니다」로 끝납니다 — 그 말이 결함 394 를 만들었습니다',
    );
  });
});

describe('결함 395 — 확신도 알약이 **축 이름을 글자로** 단다', () => {
  /* ## ⛔ `34%` 하나만 그리고 「AI 확신도」는 `title` 에 있었습니다
   *
   * 결함 394 가 「`title` 을 쓰는 다른 자리는 안 셌습니다」로 남긴 숙제를
   * 폈습니다. 두 뿌리의 `title=` 을 전수로 세고 **「그 값이 본문 글자에도
   * 있는가」**로 갈랐더니, 로비 말고 하나가 더 나왔습니다.
   *
   * 레거시 검토의 후보 카드는 업무 제목 **오른쪽**에 알약을 붙이고 그
   * 안에 `34%` 만 적었습니다. 재서 확인한 것 —
   *
   *   · 그 화면에서 `%` 가 나오는 줄은 `["34%","71%","92%"]` 셋뿐 (견줄 것 없음)
   *   · 접근성 트리에서 `%` 를 이름으로 가진 노드 **0개** (귀에는 아무것도)
   *   · `aria-label` 도 없음 — 축 이름이 사는 곳은 `title` **하나**
   *
   * 제목 옆에 붙은 맨 백분율은 **진행률**로 읽힙니다. 결함 336 이 홈의
   * 리본에서 겪은 그 모양인데, 저기는 `aria-label` 이라도 있었고 여기는
   * 마우스 전용입니다.
   *
   * ## 「저 혼자 예외인가」 — 세어서 갈랐습니다
   *
   * 이 제품이 사람에게 보이는 백분율을 전부 모으니 축을 답니다 —
   * 「팀의 32%」·「커버리지 80%」·「모르는 폭 20%p」·「팀 신뢰도 62%」·
   * 「확신 45% · 모름 55%」·「유사도 87%」·「기간 40% 지남」. **맨몸은
   * 이 하나**였고, 같은 값을 SPA 는 이미 「확신 34%」라고 적고 있었습니다.
   * 제품의 관습이 아니라 **갈라진 자리**입니다.
   *
   * ## 자는 낱말이 아니라 요구를 잽니다
   *
   * 「`확신` 이라고 적혀 있는가」로 재면 화면이 그 글자를 손으로 적는 것도
   * 통과합니다 — 그게 SPA 가 하고 있던 것이고, 그래서 갈렸습니다. 그러니
   * **「`@lib` 를 거치는가」**와 **「손으로 조립하지 않는가」** 둘을 잽니다
   * (결함 363 — 가드를 넓히는 것보다 사본을 없애는 것이 낫습니다).
   *
   * ⚠️ 이 가드가 못 보는 것: **다른 값**의 맨몸 백분율. 위 census 는 이
   * 회차에 손으로 셌고, 자로 만들어 두지는 않았습니다.
   */
  const ROOTS: Array<[string, string]> = [
    ['레거시', join(DEMO, 'review.tsx')],
    ['SPA', join(ROOT, '..', 'webapp', 'src', 'screens', 'Review.tsx')],
  ];

  for (const [rootName, path] of ROOTS) {
    it(`${rootName} — 확신도 글자를 @lib 에서 가져온다`, () => {
      const code = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      ok(
        /confidenceReading\(/.test(code),
        `${rootName} 가 confidenceReading 을 안 부릅니다 — 축 이름 없는 맨 숫자이거나 사본입니다`,
      );
      /* 손으로 조립하는 자리가 남아 있으면 그것이 곧 두 번째 벌입니다.
         `candidate.confidence * 100` 뒤에 `%` 가 오는 모양을 봅니다. */
      const handmade = [...code.matchAll(/confidence\s*\*\s*100\s*\)?\s*\}?\s*%/g)];
      strictEqual(
        handmade.length,
        0,
        `${rootName} 가 확신도 글자를 손으로 조립합니다 (${handmade.length}곳) — @lib 과 갈라집니다`,
      );
    });
  }

  it('⭐ 레거시 — 축 이름이 `title` 에만 있지 않다', () => {
    /* 요구는 「`확신` 이라는 글자가 파일에 있는가」가 아니라 **「눈에 보이는
       자리에 있는가」**입니다. `title="AI 확신도"` 는 마우스 전용입니다. */
    const code = readFileSync(join(DEMO, 'review.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    ok(
      !/title=["'][^"']*확신도["']/.test(code),
      '확신도의 축 이름이 아직 `title` 에 있습니다 — 키보드·터치·낭독기가 못 봅니다',
    );
  });

  it('⭐ `@lib` 이 축 이름을 실제로 낸다', () => {
    ok(
      confidenceReading(0.34).includes('확신'),
      'confidenceReading 이 축 이름을 안 답니다 — 맨 숫자면 고친 것이 아닙니다',
    );
    strictEqual(confidenceReading(0.34), '확신 34%');
    strictEqual(confidenceReading(0.925), '확신 93%');
  });
});
