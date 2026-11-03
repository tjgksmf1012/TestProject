/** 고정 대본 대신 실제 장치/요청/초점 수명으로 회의 흐름을 검사합니다.
 * 합성 마이크와 임시 DB만 사용합니다. 외부 OAuth·실제 모델·인터넷 ICE는 못 잽니다.
 */
import assert from 'node:assert/strict';

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
    const settingsButton = page.getByRole('button', { name: '설정', exact: true });
    await settingsButton.click();
    await page.getByRole('button', { name: '마이크 점검 시작', exact: true }).click();
    await page.getByRole('button', { name: '마이크 점검 종료', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: '환경 설정' }).waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('title') === '설정');
    assert.equal(await settingsButton.evaluate((button) => document.activeElement === button), true);
    assert.equal(await page.evaluate(() => window.__testStreams.at(-1).getTracks().every((track) => track.readyState === 'ended')), true);
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
    console.log('✅ 가입 격리·선택 동의 기본값·개별 동의·2인 통화·녹음/최소화/이동·필터·마이크 해제·초점·권한/연결 실패 통과');
  } finally {
    for (const ctx of contexts) await ctx.close();
  }
}
