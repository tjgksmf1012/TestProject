/**
 * 데스크톱 셸 — main 프로세스 (Phase 0).
 *
 * ## 왜 Electron 인가 — 이유는 하나뿐입니다
 *
 * 화면을 예쁘게 하려는 것이 아닙니다. **브라우저가 못 고치는 결함 하나**
 * 때문입니다.
 *
 *     창을 내리거나 화면이 잠기면 녹음이 끊긴다.
 *
 * `docs/17` 이 이 제품에서 제일 비싼 실패로 적어 둔 것입니다 — 녹음이 한
 * 번 끊기면 그 구간은 **영영 못 잽니다.** 브라우저에서는 고칠 방법이
 * 없습니다(백그라운드 스로틀링은 브라우저가 정합니다). Electron 에서는
 * `powerSaveBlocker` + `backgroundThrottling: false` 로 막을 수 있습니다.
 *
 * ⚠️ **그 둘은 Phase 2 입니다.** 이 파일은 아직 창만 엽니다. 미리 켜 두면
 * **아무도 안 재는데 켜져 있는 것**이 되고, 그건 "동작한다" 는 착각을
 * 만듭니다.
 *
 * ## ⚠️ 원격 화면을 띄웁니다 — 그래서 잠금이 선택이 아닙니다
 *
 * 이 앱의 화면은 전부 서버가 줍니다(`/api/...` 를 `same-origin` 으로
 * 부르기 때문에 `file://` 로 열면 로그인부터 안 됩니다). 즉 이 창은
 * **남이 준 코드를 실행합니다.**
 *
 * 그래서 `contextIsolation`·`sandbox`·내비게이션 잠금·권한 거부는
 * "권장 사항" 이 아니라 **서버가 뚫렸을 때 사용자 기계를 지키는 유일한
 * 벽**입니다. 하나라도 끄면 서버의 XSS 가 곧 사용자 PC 의 코드 실행이
 * 됩니다. `guards.test.ts` 가 그 넷을 지킵니다.
 *
 * ## ⚠️ 판단은 여기 없습니다
 *
 * 어떤 주소가 허용인지·바깥 링크를 열어도 되는지는
 * `src/lib/desktop/server.ts` 에 있습니다. main 프로세스에는 자동 검사가
 * 안 붙기 때문입니다 — 여기 두면 그 판단이 검증 밖으로 나갑니다.
 */

import { app, BrowserWindow, session, shell } from 'electron';
import { join } from 'node:path';

import {
  offlineNotice,
  safeToOpenOutside,
  sameOrigin,
  serverUrl,
} from '../../src/lib/desktop/server.ts';

/** 이 창이 머물러도 되는 곳. 여기를 벗어나는 이동은 전부 막습니다. */
let allowedOrigin = '';

const here = (url: string): boolean => sameOrigin(url, allowedOrigin);

function createWindow(target: URL): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380, // 폰 판형(390px)이 그대로 살아 있게
    show: false, // 흰 화면 깜빡임 없이 — 그릴 준비가 되면
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.cjs'),
      // ⚠️ 아래 넷은 **끄면 안 됩니다.** 위 머리말을 읽으십시오.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // ⚠️ **못 닿으면 창을 안 보여 주는 상태로 두면 안 됩니다.**
  //
  // `show: false` + `ready-to-show` 는 깜빡임을 없애는 흔한 방법인데,
  // 로드가 실패하면 `ready-to-show` 가 **영영 안 옵니다.** 앱은 살아
  // 있는데 화면이 하나도 없고, 사용자는 아이콘을 눌렀는데 아무 일도 안
  // 일어난 것으로 봅니다.
  win.webContents.on('did-fail-load', (_e, code, description, url) => {
    if (code === -3) return; // ERR_ABORTED — 사람이 이동을 취소한 것
    win.show();
    void win.webContents.loadURL(offlineNotice(url, description));
  });

  // ⚠️ **새 창을 아예 안 엽니다.** 링크는 기본 브라우저로 —
  //    Electron 창으로 열면 그 창이 preload 를 물려받고, 남의 사이트가
  //    이 앱의 다리 위에서 돕니다.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });

  // ⚠️ 서버가 뚫려 `location = 'https://evil'` 을 실행해도 안 따라갑니다.
  win.webContents.on('will-navigate', (event, url) => {
    if (!here(url)) {
      event.preventDefault();
      openOutside(url);
    }
  });

  void win.loadURL(target.href);
  return win;
}

function openOutside(url: string): void {
  if (safeToOpenOutside(url)) void shell.openExternal(url);
}

/**
 * 권한은 **기본이 거절**입니다.
 *
 * ⚠️ 손대지 않으면 Electron 이 대부분을 내줍니다. 이 창은 원격 코드를
 * 돌리므로 그건 위치·알림·클립보드를 서버에 맡기는 것과 같습니다.
 *
 * 마이크만 엽니다 — 이 제품이 존재하는 이유이고, 그것도 **우리 서버
 * 화면일 때만** 입니다.
 *
 * ⚠️ 두 핸들러를 **모두** 겁니다. `setPermissionRequestHandler` 만 걸면
 * 확인 경로(`setPermissionCheckHandler`)로 새어 나갑니다.
 */
function lockPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((contents, permission, done) => {
    done(permission === 'media' && here(contents.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler(
    (_contents, permission, origin) => permission === 'media' && origin === allowedOrigin,
  );
}

function main(): void {
  const target = serverUrl(process.env.TEAMFLOW_SERVER_URL);
  allowedOrigin = target.origin;

  void app.whenReady().then(() => {
    lockPermissions();
    createWindow(target);

    // macOS 는 창을 다 닫아도 앱이 삽니다 — 독 아이콘을 누르면 다시.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(target);
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

// ⚠️ **`require.main === module` 로 감싸지 마십시오.**
//
// 그렇게 적었다가 앱이 **아무 창도 안 여는 채로 살아 있었습니다**
// (결함 166). Electron 은 진입 파일을 제 모듈 시스템으로 읽어서
// `require.main` 이 이 모듈이 아닙니다 — 조건이 언제나 거짓이고,
// 오류는 한 줄도 안 납니다. 순수 판단은 `src/lib/desktop/` 에 있으니
// 이 파일은 가져다 쓸 일이 없습니다. 그냥 부릅니다.
main();
