/**
 * 데스크톱 셸이 **실제로 뜨는가** — 손으로 돌리는 검사.
 *
 * ## ⚠️ `npm test` 에 안 넣었습니다
 *
 * 이 검사는 **띄워 둔 서버**와 **디스플레이**가 있어야 합니다. `npm test`
 * 는 설치도 서버도 없이 도는 것이 이 저장소의 규칙이라, 여기 끼우면
 * 그 규칙이 깨지고 CI 가 이유 없이 빨개집니다.
 *
 * 대신 코드 쪽 규칙(보안 기본값·진입·판단 위치)은 `guards.test.ts` 의
 * `데스크톱 셸 (Electron)` 이 `npm test` 안에서 지킵니다.
 *
 * ## 돌리는 법
 *
 *     # 1) 서버를 띄웁니다 (시연 DB)
 *     # 2) 화면과 셸을 빌드합니다
 *     npm --prefix frontend run build
 *     # 3) 이 파일을 돌립니다
 *     NODE_PATH=$(npm root -g) SP=/tmp xvfb-run -a node frontend/electron/smoke.mjs
 *
 * ⚠️ `--no-sandbox` 는 **이 하네스에만** 붙습니다 — 컨테이너가 root 로
 * 돌아 Chromium 이 거부하기 때문입니다. 앱 코드에 박으면 그건 보안
 * 기본값을 통째로 무르는 것이고, 가드가 잡습니다.
 *
 * ⚠️ Playwright 는 **제 node_modules** 에서 electron 을 찾습니다. 이
 * 프로젝트에 설치한 것을 쓰려면 `executablePath` 를 직접 줘야 합니다.
 *
 * ## Phase 2 에서 여기가 자랍니다
 *
 * 자료집 §12 의 "녹음 생존율 테스트" 가 이 파일에 붙습니다 — 알려진
 * 길이의 가짜 오디오를 주입하고(`--use-file-for-fake-audio-capture`),
 * 창을 최소화·hide 한 뒤 디스크에 쌓인 청크 길이가 입력과 맞는지.
 */
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = dirname(dirname(fileURLToPath(import.meta.url)));

// ⚠️ playwright 는 이 프로젝트의 의존성이 **아닙니다**(프런트 런타임
//    의존성을 셋으로 묶어 두는 규칙 때문). 전역에 설치된 것을 씁니다 —
//    `PLAYWRIGHT_ROOT` 로 바꿀 수 있습니다.
const pwRoot =
  process.env.PLAYWRIGHT_ROOT ?? execSync('npm root -g', { encoding: 'utf8' }).trim();
const { _electron: electron } = await import(join(pwRoot, 'playwright', 'index.mjs'));

const app = await electron.launch({
  // ⚠️ Playwright 는 **제 node_modules** 에서 electron 을 찾습니다. 이
  //    프로젝트에 설치한 것을 쓰려면 경로를 직접 줘야 합니다.
  executablePath: join(FRONTEND, 'node_modules', 'electron', 'dist', 'electron'),
  args: ['out/main/index.cjs', '--no-sandbox'],
  cwd: FRONTEND,
  env: { ...process.env, TEAMFLOW_SERVER_URL: 'http://127.0.0.1:8811/home.html' },
});

const page = await app.firstWindow();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(2500);

console.log('제목      :', await page.title());
console.log('주소      :', page.url());
console.log('화면 글자 :', (await page.locator('h1').first().innerText().catch(() => '(없음)')).trim());

// preload 다리가 실제로 실행됐는가
const bridge = await page.evaluate(() => window.teamflowDesktop ?? null);
console.log('preload   :', JSON.stringify(bridge));

// ⭐ 보안 기본값을 **실행 중인 창에서** 확인합니다. 설정 파일을 읽는 것이
//    아니라 실제로 격리됐는지를 봅니다.
const isolated = await page.evaluate(() => ({
  require: typeof window.require,
  process: typeof window.process,
  module: typeof window.module,
}));
console.log('격리      :', JSON.stringify(isolated), '(전부 undefined 여야 함)');

// ⭐ 로그인해서 **실제 데이터 화면**까지 갑니다. 껍데기가 뜨는 것과
//    `/api/...` 가 same-origin 으로 도는 것은 다른 이야기입니다.
// ⚠️ **이미 로그인돼 있을 수 있습니다.** Electron 은 쿠키를 userData 에
//    남기므로, 브라우저 테스트와 달리 두 번째 실행부터는 로그인 화면이
//    안 나옵니다. 없으면 그냥 넘어갑니다 — 있다고 가정하면 이 검사가
//    **앱이 아니라 제 가정 때문에** 실패합니다.
if (await page.locator('#email').count()) {
  await page.fill('#email', 'minsu@example.com');
  await page.fill('#password', 'teamflow-demo');
  await page.click('button[type=submit]');
  await page.waitForTimeout(1500);
}
await page.goto('http://127.0.0.1:8811/kanban.html?project=1');
await page.waitForTimeout(1800);
const cards = await page.locator('.task .title').allInnerTexts();
console.log('칸반 카드 :', cards.length, '장 —', cards.join(' / '));
await page.screenshot({ path: join(process.env.SP ?? '/tmp', 'desktop-phase0.png'), fullPage: true });

// ⭐ 청크 보관소를 **실제로 써 봅니다** (docs/21 Phase 1).
//    "채널을 열었다" 와 "바이트가 디스크에 앉는다" 는 다른 이야기입니다.
const store = await page.evaluate(async () => {
  const api = window.teamflowDesktop?.chunks;
  if (!api) return { ok: false, why: '다리가 없습니다' };
  const bytes = new Uint8Array([1, 2, 3, 4, 5]).buffer;
  await api.put('smoke', 7, 1700000000123, bytes);
  const listed = await api.list('smoke');
  const back = await api.get('smoke', 7);
  await api.drop('smoke', 7);
  const after = await api.list('smoke');
  return {
    ok: true,
    listed,
    readBytes: back ? new Uint8Array(back).join(',') : null,
    afterDrop: after.length,
  };
});
console.log('보관소     :', JSON.stringify(store));

// ⭐ 경로를 벗어나려는 회의 id 가 **막히는가.** 이 창은 서버가 준 코드를
//    돌리므로, 이것이 뚫리면 임의 파일 쓰기입니다.
const traversal = await page.evaluate(async () => {
  const api = window.teamflowDesktop?.chunks;
  const out = [];
  for (const bad of ['../../evil', 'a/b', '..']) {
    try {
      await api.put(bad, 0, 0, new Uint8Array([9]).buffer);
      out.push(`${bad}: 통과함 ⚠️`);
    } catch {
      out.push(`${bad}: 막힘`);
    }
  }
  return out;
});
console.log('경로 잠금  :', traversal.join(' / '));

// ⭐ 절전 방지 (docs/21 Phase 2) — 장부 의미까지 **OS 값으로** 잽니다.
//    돌려받는 불리언은 main 이 powerSaveBlocker.isStarted() 로 잰 것입니다.
const awakeSeq = await page.evaluate(async () => {
  const a = window.teamflowDesktop?.awake;
  if (!a) return { ok: false };
  return {
    ok: true,
    hold1: await a.hold(),      // 첫 hold → 켜짐 (true)
    hold2: await a.hold(),      // 둘째 hold → 그대로 켜짐 (true)
    release1: await a.release(), // 하나 남음 → 아직 켜짐 (true)
    release2: await a.release(), // 마지막 → 꺼짐 (false)
    extra: await a.release(),    // 남발 → 여전히 꺼짐 (false)
  };
});
const awakeWant = { ok: true, hold1: true, hold2: true, release1: true, release2: false, extra: false };
const awakeGood = JSON.stringify(awakeSeq) === JSON.stringify(awakeWant);
console.log('절전 방지  :', JSON.stringify(awakeSeq), awakeGood ? 'OK' : '⚠️ 기대와 다름');

// ⭐ 녹음 화면의 안전 배너 — keepsAwake=true 가 실제 문구로 이어지는가.
await page.goto('http://127.0.0.1:8811/index.html');
await page.waitForTimeout(1500);
const banner = await page.locator('#safety').innerText().catch(() => '(못 읽음)');
console.log('안전 배너  :', banner.slice(0, 44), banner.includes('화면을 꺼도') ? '(desktop-awake OK)' : '⚠️ 꺼도 됩니다가 아님');

// 바깥 링크로 못 나가는가 — 서버가 뚫렸을 때의 마지막 벽
const before = page.url();
await page.evaluate(() => { location.href = 'https://example.com/'; });
await page.waitForTimeout(1200);
console.log('이동 잠금 :', page.url() === before ? '막힘 (그대로)' : `샘 → ${page.url()}`);
console.log('페이지 오류:', errs.length, errs.slice(0, 2).join(' / '));
await app.close();
