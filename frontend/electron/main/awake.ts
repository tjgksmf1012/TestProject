/**
 * 데스크톱 셸 — 재우기 방지의 **손** (`docs/21` Phase 2).
 *
 * ## ⚠️ `prevent-display-sleep` 이 아닙니다
 *
 * 목적이 「화면을 꺼도 녹음이 산다」 입니다. 화면을 켜 두는 것은 목적이
 * 아니라 **막으려던 낭비**입니다 — `prevent-app-suspension` 은 화면은
 * 자게 두고 앱만 살립니다. 녹음에 필요한 것은 그쪽입니다.
 *
 * ## ⚠️ 판단은 여기 없습니다
 *
 * 언제 켜고 끌지(참조 계수·음수 방지)는 `src/lib/desktop/awake.ts` 의
 * 장부가 정합니다 — main 에는 자동 검사가 안 붙습니다. 이 파일은 장부가
 * "켜라/꺼라" 할 때 `powerSaveBlocker` 를 만지는 손입니다.
 *
 * ## ⚠️ 돌려주는 값은 장부가 아니라 **OS 를 잰 것**입니다
 *
 * `hold()`/`release()` 는 `powerSaveBlocker.isStarted()` 를 다시 물어
 * 돌려줍니다. 장부가 "켰다" 고 믿는 것과 OS 가 켰다는 것은 다르고,
 * 화면은 잰 값을 받아야 합니다 — 검사(smoke)도 이 값을 잽니다.
 */

import { ipcMain, powerSaveBlocker, type IpcMainInvokeEvent } from 'electron';

import { AwakeLedger } from '../../src/lib/desktop/awake.ts';
import { sameOrigin } from '../../src/lib/desktop/server.ts';

const ledger = new AwakeLedger();
let blockerId: number | null = null;

function started(): boolean {
  return blockerId !== null && powerSaveBlocker.isStarted(blockerId);
}

/** 재우기 방지 채널을 연다. `registerChunkStore` 와 같은 origin 잠금. */
export function registerAwake(allowedOrigin: () => string): void {
  const fromOurWindow = (event: IpcMainInvokeEvent): boolean =>
    sameOrigin(event.senderFrame?.url ?? '', allowedOrigin());

  ipcMain.handle('awake:hold', (event): boolean => {
    if (!fromOurWindow(event)) throw new Error('이 창에서 온 요청이 아닙니다');
    if (ledger.hold() && !started()) {
      blockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
    return started();
  });

  ipcMain.handle('awake:release', (event): boolean => {
    if (!fromOurWindow(event)) throw new Error('이 창에서 온 요청이 아닙니다');
    if (ledger.release() && started()) {
      // blockerId 는 위 started() 가 참이면 null 이 아닙니다.
      powerSaveBlocker.stop(blockerId as number);
      blockerId = null;
    }
    return started();
  });
}
