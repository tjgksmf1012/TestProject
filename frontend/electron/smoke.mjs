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
 * ## 녹음 생존율 (자료집 §12 · docs/21 Phase 1~2 의 마지막 반쪽)
 *
 * 맨 아래에서 알려진 가짜 오디오를 주입하고(`--use-file-for-fake-audio-capture`
 * — WAV 는 이 파일이 직접 만듭니다), 녹음을 시작한 뒤 **창을 hide 한 채**
 * 청크가 계속 쌓이는지 잽니다. `backgroundThrottling: false` 가 참말인지는
 * 설정 파일이 아니라 **숨긴 창에서 늘어나는 청크 수**로만 알 수 있습니다.
 *
 * ⚠️ 실제 절전·화면 잠금은 이 컨테이너(Xvfb)에서 못 일으킵니다. 여기서
 * 재는 것은 「창을 숨겨도 산다」까지고, 「뚜껑을 덮어도 산다」는 실기기
 * 몫입니다 (docs/21 §5).
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = dirname(dirname(fileURLToPath(import.meta.url)));

// ⚠️ playwright 는 이 프로젝트의 의존성이 **아닙니다**(프런트 런타임
//    의존성을 셋으로 묶어 두는 규칙 때문). 전역에 설치된 것을 씁니다 —
//    `PLAYWRIGHT_ROOT` 로 바꿀 수 있습니다.
const pwRoot =
  process.env.PLAYWRIGHT_ROOT ?? execSync('npm root -g', { encoding: 'utf8' }).trim();
const { _electron: electron } = await import(join(pwRoot, 'playwright', 'index.mjs'));

/**
 * 길이를 **아는** 오디오를 만든다 — 16bit PCM 모노 WAV, 440Hz.
 *
 * ffmpeg 없이 만듭니다(이 환경에 없습니다). Chromium 은 이 파일을
 * 반복 재생하므로 녹음이 파일보다 길어도 소리는 계속 들어옵니다.
 */
function makeWav(path, seconds) {
  const rate = 44100;
  const n = rate * seconds;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // 모노
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([head, data]));
}

const SP = process.env.SP ?? '/tmp';
const wavPath = join(SP, 'smoke-tone.wav');
makeWav(wavPath, 20);

const app = await electron.launch({
  // ⚠️ Playwright 는 **제 node_modules** 에서 electron 을 찾습니다. 이
  //    프로젝트에 설치한 것을 쓰려면 경로를 직접 줘야 합니다.
  executablePath: join(FRONTEND, 'node_modules', 'electron', 'dist', 'electron'),
  args: [
    'out/main/index.cjs',
    '--no-sandbox',
    // ⭐ 아래 셋은 **이 하네스에만** 붙는 가짜 마이크입니다. 앱 코드가 아니라
    //    Chromium 에게 주는 것이라 Electron 이 그대로 넘깁니다.
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${wavPath}`,
  ],
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

// ⭐ 녹음 생존율 (자료집 §12) — 가짜 마이크로 **실제 녹음**을 돌리고, 창을
//    hide 한 채 청크가 계속 쌓이는지 잽니다. `backgroundThrottling: false`
//    와 `keepsAwake` 가 참말인지는 설정이 아니라 **이 숫자**가 말합니다.
//    ?meeting= 없이 열었으므로 서버 없이 도는 로컬 모드입니다 — 업로드는
//    로컬 카운터로 가고, 청크는 디스크 보관소를 스쳐 갑니다(Phase 1).
await page.click('#consent');
await page.click('#permission');
// requestMicrophone(getUserMedia)이 끝나야 시작 버튼이 열립니다.
await page.waitForFunction(() => !document.getElementById('start').disabled, null, { timeout: 10_000 });
await page.click('#start');
await page.waitForTimeout(6_500); // 타임슬라이스 5초 → 첫 청크가 앉을 시간
const chunksShown = Number(await page.locator('#chunks').innerText());

await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
await page.waitForTimeout(11_000); // 숨긴 채 두 타임슬라이스
const chunksHidden = Number(await page.locator('#chunks').innerText());
const phaseHidden = await page.locator('#phase').innerText();
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());

await page.click('#stop');
await page.waitForFunction(() => !document.getElementById('result').hidden, null, { timeout: 10_000 });
const survival = {
  before: chunksShown,          // 보이는 채 6.5초 → 1개 이상
  hidden: chunksHidden,         // 숨긴 채 11초 → 2개 이상 **늘어야** 합니다
  phaseHidden,                  // '녹음 중' 이어야 — '화면이 가려짐' 이면 스로틀이 도로 켜진 것
  coverage: await page.locator('#coverage').innerText(),
  totalGap: await page.locator('#totalgap').innerText(),
  usable: await page.locator('#usable').innerText(),
  uploaded: await page.locator('#uploaded').innerText(),
};
// ⚠️ coverage 도 봅니다 — 결함 173(정지 직후 마지막 조각이 버려짐)이
//    돌아오면 여기서 ~86% 로 떨어집니다. 첫 측정이 정확히 그랬습니다.
//    (번들을 다시 만들었으면 `rm -rf ~/.config/Electron` — 서비스 워커가
//    옛 번들을 물고 있어 고친 것이 안 재집니다)
const survived =
  survival.hidden - survival.before >= 2 &&
  survival.phaseHidden === '녹음 중' &&
  parseFloat(survival.coverage) >= 99;
console.log('생존율     :', JSON.stringify(survival), survived ? 'OK' : '⚠️ 숨기면 죽거나 꼬리가 사라짐');

// 바깥 링크로 못 나가는가 — 서버가 뚫렸을 때의 마지막 벽
const before = page.url();
await page.evaluate(() => { location.href = 'https://example.com/'; });
await page.waitForTimeout(1200);
console.log('이동 잠금 :', page.url() === before ? '막힘 (그대로)' : `샘 → ${page.url()}`);
console.log('페이지 오류:', errs.length, errs.slice(0, 2).join(' / '));
await app.close();
