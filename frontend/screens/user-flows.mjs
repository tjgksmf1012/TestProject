/** 고정 대본 대신 실제 장치/요청/초점 수명으로 회의 흐름을 검사합니다.
 * 합성 마이크와 임시 DB만 사용합니다. 외부 OAuth·실제 모델·인터넷 ICE는 못 잽니다.
 */
import assert from 'node:assert/strict';

/** ㉕ 열린 대화상자(모달)의 글자·배경 대비와 뷰포트 넘침을 검증한다 (캔버스 픽셀로 color-mix/srgb 해결). */
async function assertDialogReadable(page, dialog, label) {
  await dialog.waitFor({ state: 'visible' });
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  const issues = await dialog.evaluate((root) => {
    const cv = document.createElement('canvas');
    cv.width = 1;
    cv.height = 1;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const parseColor = (cssColor) => {
      if (!cssColor || cssColor === 'transparent' || !ctx) return [0, 0, 0, 0];
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#00000000';
      ctx.fillStyle = cssColor;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const compositeOver = (fg, bg) => {
      const a = fg[3];
      return [
        Math.round(fg[0] * a + bg[0] * (1 - a)),
        Math.round(fg[1] * a + bg[1] * (1 - a)),
        Math.round(fg[2] * a + bg[2] * (1 - a)),
        1,
      ];
    };
    const effectiveBg = (el) => {
      const chain = [];
      for (let cur = el; cur; cur = cur.parentElement) {
        chain.push(parseColor(getComputedStyle(cur).backgroundColor));
      }
      let out = [255, 255, 255, 1];
      for (let i = chain.length - 1; i >= 0; i -= 1) {
        if (chain[i][3] > 0) out = compositeOver(chain[i], out);
      }
      return out;
    };
    const lum = ([r, g, b]) => {
      const lin = [r, g, b].map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    };
    const ratio = (a, b) => {
      const [la, lb] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (la + 0.05) / (lb + 0.05);
    };
    const out = [];
    const box = root.getBoundingClientRect();
    if (box.width < 100 || box.height < 80) {
      out.push(`크기 비정상 (${Math.round(box.width)}x${Math.round(box.height)})`);
    }
    if (box.right > window.innerWidth + 2 || box.left < -2) {
      out.push(`가로 뷰포트 이탈 (${Math.round(box.left)}..${Math.round(box.right)} / ${window.innerWidth})`);
    }
    const candidates = root.querySelectorAll(
      'h1, h2, h3, button, [role="option"], [role="tab"], label, .dc-sec-title, .dc-cmdk__title, .dc-r-title',
    );
    for (const el of candidates) {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) continue;
      if (!(el.textContent ?? '').trim()) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const fg = parseColor(st.color);
      const bg = effectiveBg(el);
      const effFg = fg[3] < 1 ? compositeOver(fg, bg) : fg;
      const cr = ratio(effFg, bg);
      if (cr < 3.0) {
        out.push(`저대비(${cr.toFixed(2)}:1): "${el.textContent.trim().slice(0, 24)}"`);
      }
    }
    return out;
  });
  assert.deepEqual(issues, [], `${label} 모달 가독성/배치 실패: ${issues.join('; ')}`);
}

export async function exerciseUserFlows(browser, base) {
  const contexts = [];
  const context = async () => {
    const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1440, height: 900 } });
    contexts.push(ctx);
    await ctx.addInitScript(() => {
      window.__testStreams = [];
      const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (...args) => {
        const stream = await getMedia(...args); window.__testStreams.push(stream); return stream;
      };
    });
    return ctx;
  };
  const login = async (ctx, email) => {
    const response = await ctx.request.post(`${base}/api/auth/login`, { data: { email, password: 'teamflow-demo' } });
    assert.equal(response.status(), 200);
  };
  try {
    const fresh = await context();
    const signup = await fresh.newPage();
    await signup.goto(`${base}/app/login`);
    await signup.getByRole('button', { name: '가입하기', exact: true }).click();
    await signup.getByLabel('이름', { exact: true }).fill('새 팀원');
    await signup.getByLabel('이메일', { exact: true }).fill(`flow-${Date.now()}@example.test`);
    await signup.getByLabel('비밀번호', { exact: true }).fill('synthetic-password-only');
    await signup.getByRole('button', { name: '가입하고 로그인', exact: true }).click();
    await signup.waitForURL(/\/app\/?$/);
    assert.deepEqual(await (await fresh.request.get(`${base}/api/projects`)).json(), []);

    const owner = await context();
    const teammate = await context();
    const third = await context();
    await login(owner, 'minsu@example.com');
    await login(teammate, 'haneul@example.com');
    await login(third, 'jiwon@example.com');
    const page = await owner.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/app/`);
    await page.getByRole('button', { name: '회의실 열기', exact: true }).click();
    const created = page.waitForResponse((response) => response.request().method() === 'POST'
      && /\/api\/projects\/1\/meetings$/.test(response.url()));
    await page.getByRole('button', { name: '새 회의 열기', exact: true }).click();
    const meetingId = (await (await created).json()).meeting_id;
    const lobby = await owner.newPage();
    await lobby.goto(`${base}/app/meeting/${meetingId}/lobby`);
    const optional = lobby.getByRole('checkbox');
    await optional.first().waitFor();
    for (const box of await optional.all()) assert.equal(await box.isChecked(), false);
    await lobby.close();
    const consentUrl = `${base}/api/meetings/${meetingId}/consent`;
    await page.getByLabel('회의 녹음과 전사에 동의합니다').click();
    for (const [ctx, consented] of [[teammate, false], [third, true]]) {
      assert.equal((await ctx.request.post(consentUrl, { data: { consent_type: 'recording', consented } })).status(), 200);
    }
    assert.equal((await owner.request.post(`${base}/api/meetings/${meetingId}/instant-join`)).status(), 403);
    const before = await (await owner.request.get(consentUrl)).json();
    assert.equal(before.roster.find((row) => row.name === '이하늘').recording, false);
    assert(before.roster.every((row) => row.raw_audio_retention === null && row.voiceprint_storage === null));
    await teammate.request.post(consentUrl, { data: { consent_type: 'recording', consented: true } });
    const enter = page.getByRole('button', { name: '통화와 녹음 화면 열기', exact: true });
    await enter.waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-describedby="room-consent-help"]')?.getAttribute('aria-disabled') === 'false');
    await enter.click();
    const record = page.frameLocator('iframe[title="개별 트랙 녹음"]');
    const call = page.frameLocator('iframe[title="실제 음성 통화"]');
    const peer = await teammate.newPage();
    await peer.goto(`${base}/call.html?meeting=${meetingId}`);
    await call.getByText('1명과 통화 중입니다.', { exact: true }).waitFor({ timeout: 20000 });
    await peer.getByText('1명과 통화 중입니다.', { exact: true }).waitFor({ timeout: 20000 });

    await page.getByRole('tab', { name: '녹음 시작·종료', exact: true }).click();
    await record.locator('#permission').click();
    await record.locator('#start[aria-disabled="false"]').waitFor();
    await record.locator('#start').click();
    await record.getByText('녹음 중', { exact: true }).waitFor();
    await record.locator('#chunks').filter({ hasText: /^[1-9]\d*$/ }).waitFor({ timeout: 15000 });
    const extendedSeconds = Number(process.env.SMOKE_RECORD_SECONDS ?? 0);
    const extraRecorders = [];
    if (extendedSeconds > 0) {
      for (const ctx of [teammate, third]) {
        const recorder = await ctx.newPage();
        await recorder.goto(`${base}/index.html?meeting=${meetingId}`);
        await recorder.locator('#permission').click();
        await recorder.locator('#start[aria-disabled="false"]').waitFor();
        await recorder.locator('#start').click();
        await recorder.getByText('녹음 중', { exact: true }).waitFor();
        extraRecorders.push(recorder);
      }
      let blockedUploads = 0;
      const uploads = '**/api/meetings/*/tracks/*/chunks/*';
      await owner.route(uploads, (route) => {
        blockedUploads += 1;
        return route.abort('connectionfailed');
      });
      await page.waitForTimeout(8000);
      await owner.unroute(uploads);
      assert(blockedUploads > 0, '실제 업로드를 끊었는지 확인');
      await record.getByText('녹음 중', { exact: true }).waitFor();
      await page.waitForTimeout(Math.max(0, extendedSeconds * 1000 - 8000));
    }
    const frame = page.frames().find((entry) => entry.url().includes(`/index.html?meeting=${meetingId}`));
    assert(frame);
    await frame.evaluate(() => { window.__sameRecordingFrame = true; });
    await page.getByRole('button', { name: '작게 두기', exact: true }).click();
    assert.equal(await page.locator('body').evaluate((body) => getComputedStyle(body).pointerEvents), 'auto');
    await page.getByRole('link', { name: '칸반', exact: true }).click();
    const filter = page.getByRole('combobox', { name: '담당자별 필터' });
    assert.match(await filter.innerText(), /전체 담당자/);
    await filter.click();
    await page.getByRole('option').filter({ hasText: '김민수' }).click();
    assert.match(await filter.innerText(), /김민수/);
    await filter.click();
    await page.getByRole('option').filter({ hasText: '전체 담당자' }).click();
    await page.getByRole('button', { name: '회의 창 다시 열기', exact: true }).click();
    assert.equal(await frame.evaluate(() => window.__sameRecordingFrame), true);
    await record.getByText('녹음 중', { exact: true }).waitFor();
    await record.locator('#stop').click();
    await record.locator('#finish-state').filter({ hasText: '녹음을 마쳤습니다' }).waitFor();
    for (const recorder of extraRecorders) {
      await recorder.locator('#stop').click();
      await recorder.locator('#finish-state').filter({ hasText: '녹음을 마쳤습니다' }).waitFor();
    }
    const tracks = await (await owner.request.get(`${base}/api/meetings/${meetingId}/tracks`)).json();
    assert(tracks.tracks.some((track) => track.chunk_count > 0 && track.status === 'completed'));
    if (extendedSeconds > 0) {
      assert.equal(tracks.tracks.length, 3);
      for (const track of tracks.tracks) {
        assert(track.chunk_count >= Math.floor(extendedSeconds / 5), JSON.stringify(track));
        assert(track.status === 'completed' && track.coverage >= 0.99, JSON.stringify(track));
      }
      console.log(`✅ 3인 ${extendedSeconds}초 동시 녹음·8초 업로드 차단 후 복귀·서버 커버리지 99% 이상`);
    }

    await page.getByRole('button', { name: '작게 두기', exact: true }).click();
    const settingsButton = page.getByRole('button', { name: '환경 설정', exact: true });
    await settingsButton.click();
    await assertDialogReadable(page, page.getByRole('dialog', { name: '환경 설정' }), '환경 설정(음성)');
    await page.getByRole('button', { name: '마이크 점검 시작', exact: true }).click();
    await page.getByRole('button', { name: '마이크 점검 종료', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: '환경 설정' }).waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('title') === '환경 설정');
    assert.equal(await settingsButton.evaluate((button) => document.activeElement === button), true);
    assert.equal(await page.evaluate(() => window.__testStreams.at(-1).getTracks().every((track) => track.readyState === 'ended')), true);

    await page.keyboard.press('Control+k');
    const cmdDialog = page.getByRole('dialog', { name: '빠른 명령 및 통합 검색' });
    await assertDialogReadable(page, cmdDialog, '명령 팔레트(라이트)');
    await cmdDialog.getByRole('searchbox', { name: '검색어 입력' }).fill('로그인');
    await cmdDialog.getByRole('option', { name: /로그인/ }).first().waitFor();
    await page.keyboard.press('Escape');
    await cmdDialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('title') === '환경 설정');
    assert.equal(await settingsButton.evaluate((button) => document.activeElement === button), true);

    await settingsButton.click();
    await page.getByRole('tab', { name: '계정', exact: true }).click();
    await page.getByRole('tab', { name: '화면', exact: true }).click();
    await page.getByRole('radio', { name: /어두운 화면/ }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await assertDialogReadable(page, page.getByRole('dialog', { name: '환경 설정' }), '환경 설정(다크)');
    await page.getByRole('radio', { name: /밝은 화면/ }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: '환경 설정' }).waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('title') === '환경 설정');
    assert.equal(await settingsButton.evaluate((button) => document.activeElement === button), true);

    assert.deepEqual(errors, []);
    const denied = await context();
    const demo = await denied.newPage();
    await demo.goto(`${base}/app/demo`);
    await demo.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
    });
    await demo.getByRole('button', { name: '샘플 A 녹음', exact: true }).click();
    await demo.getByText(/샘플은 생성하지 않았습니다/).waitFor();
    assert.equal(await demo.getByRole('button', { name: '벡터 유사도 계산', exact: true }).isDisabled(), true);
    await demo.route('**/api/ai/demo/analyze', (route) => route.abort('connectionfailed'));
    await demo.getByRole('button', { name: '규칙 예시 실행', exact: true }).click();
    await demo.getByText(/서버에 연결하지 못했습니다/).waitFor();
    assert.equal(await demo.getByRole('heading', { name: '업무 키워드가 있는 발언' }).count(), 0);
    await demo.unroute('**/api/ai/demo/analyze');
    await demo.getByRole('button', { name: '예시: 스프린트 회의', exact: true }).click();
    await demo.getByRole('button', { name: '규칙 예시 실행', exact: true }).click();
    await demo.getByRole('heading', { name: '업무 키워드가 있는 발언' }).waitFor();
    console.log('✅ 가입 격리·선택 동의 기본값·개별 동의·2인 통화·녹음/최소화/이동·필터·마이크 해제·초점·Ctrl+K·테마·권한/연결/데모 통과');
  } finally {
    for (const ctx of contexts) await ctx.close();
  }
}
