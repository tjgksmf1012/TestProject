/**
 * 데스크톱 셸 — preload (Phase 0).
 *
 * renderer 와 main 사이의 **좁은 다리**입니다. 지금은 건널 것이 거의
 * 없습니다 — 화면이 데스크톱인지 알아보는 것뿐입니다.
 *
 * ## ⚠️ `ipcRenderer` 를 통째로 내놓지 않습니다
 *
 *     // 이렇게 하면 안 됩니다
 *     contextBridge.exposeInMainWorld('api', { invoke: ipcRenderer.invoke })
 *
 * 이러면 서버가 뚫렸을 때 남의 코드가 **아무 채널이나** 부를 수 있습니다.
 * 채널 하나에 함수 하나씩, 인자를 정해서 내놓습니다. 지금 내놓는 것은
 * 함수가 아니라 **읽기 전용 값 셋**뿐입니다.
 *
 * ## ⚠️ 이 파일은 CommonJS 로 빌드됩니다
 *
 * `sandbox: true` 인 preload 는 ESM 을 못 씁니다. `build.mts` 가 이
 * 파일만 `.cjs` 로 내보내는 이유입니다 — 확장자를 바꾸면 창이 뜨긴
 * 하는데 preload 가 **조용히 안 실행됩니다.**
 */

import { contextBridge, ipcRenderer } from 'electron';

/**
 * 청크 보관소 다리 (`docs/21` Phase 1).
 *
 * ⚠️ **경로를 받지 않습니다.** 회의 id·seq·시각·바이트만 건너갑니다.
 * 어디에 쓸지는 main 이 `lib/desktop/chunk-paths.ts` 로 정합니다 — 이
 * 창은 서버가 준 코드를 돌리므로, 경로를 받는 함수를 하나라도 열면 그게
 * 곧 임의 파일 쓰기입니다.
 *
 * ⚠️ 채널 하나에 함수 하나입니다. `invoke` 를 그대로 내주면 서버가
 * 뚫렸을 때 **아무 채널이나** 부를 수 있습니다.
 */
const chunks = {
  put: (sessionId: string, seq: number, atMs: number, bytes: ArrayBuffer): Promise<void> =>
    ipcRenderer.invoke('chunk:put', sessionId, seq, atMs, bytes),
  list: (sessionId: string) => ipcRenderer.invoke('chunk:list', sessionId),
  get: (sessionId: string, seq: number) => ipcRenderer.invoke('chunk:get', sessionId, seq),
  drop: (sessionId: string, seq: number): Promise<void> =>
    ipcRenderer.invoke('chunk:drop', sessionId, seq),
};

/**
 * 재우기 방지 다리 (`docs/21` Phase 2).
 *
 * ⚠️ 돌려받는 불리언은 **main 이 `powerSaveBlocker.isStarted()` 로 잰
 * 값**입니다 — 화면이 "켰다" 고 믿는 것과 OS 가 켰다는 것은 다릅니다.
 */
const awake = {
  hold: (): Promise<boolean> => ipcRenderer.invoke('awake:hold'),
  release: (): Promise<boolean> => ipcRenderer.invoke('awake:release'),
};


/**
 * 화면이 "나는 지금 데스크톱에 있다" 를 알아보는 자리.
 *
 * ⚠️ userAgent 로 알아보지 않습니다. Electron 은 userAgent 에 `Electron/`
 * 을 넣지만 그건 서버가 바꿀 수도 있고 흉내 낼 수도 있습니다. **이 값이
 * 있다는 것 자체**가 preload 가 실행됐다는 증거입니다.
 *
 * ⚠️ 값만 있고 **부르는 화면이 아직 없습니다.** Phase 1 에서 녹음 화면이
 * 이걸 보고 갈라집니다(`lib/platform/`). 그때까지는 "만들어 놓고 아무도
 * 안 부름" 상태이고, 그 사실을 여기 적어 둡니다 — 이 저장소의 대표
 * 실패 ① 이라 숨기면 안 됩니다.
 */
contextBridge.exposeInMainWorld('teamflowDesktop', {
  /** 셸 규약 판. 화면이 기능 유무를 이 숫자로 가릅니다. */
  shell: 1,
  /** `darwin` · `win32` · `linux`. 안내 문구가 OS 마다 다릅니다. */
  platform: process.platform,
  /** 진단 화면에 적습니다 — 오디오 결함은 Electron 판에 크게 얽힙니다. */
  electron: process.versions.electron,
  /**
   * ⚠️ **이 셸이 녹음 중 재우기를 막는가.** 창이 있다는 뜻이 아닙니다.
   *
   * Phase 2 부터 **참**입니다 — 녹음 화면이 국면에 따라 `awake.hold()` 를
   * 잡으면 main 이 `powerSaveBlocker('prevent-app-suspension')` 를 켭니다
   * (`main/awake.ts` · `lib/platform/awake.ts`). 이 값이 참이 되는 순간
   * 녹음 화면이 "화면을 꺼도 녹음이 이어집니다" 라고 말하므로,
   * ⛔ **blocker 배선을 지우면 이 값도 같은 커밋에서 거짓으로** 되돌려야
   * 합니다 — guards.test.ts 가 그 짝을 잽니다.
   */
  keepsAwake: true,
  awake,
  /**
   * 청크를 디스크에 붙잡아 두는 곳 (`docs/21` Phase 1).
   *
   * ⚠️ **이것이 있다는 것만으로 "안전" 이 되지 않습니다.** 업로드를
   * 포기한 청크를 되찾을 수 있다는 뜻이고, 화면이 그 사실과 다시 올릴
   * 자리를 같이 줘야 합니다.
   */
  chunks,
});
