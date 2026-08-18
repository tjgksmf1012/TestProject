/**
 * 데스크톱 셸 — 청크 보관소의 **손** (`docs/21` Phase 1).
 *
 * ## ⚠️ 판단은 여기 없습니다
 *
 * 어디에 쓸지·어떤 이름을 붙일지는 전부 `src/lib/desktop/chunk-paths.ts`
 * 가 정합니다. main 프로세스에는 자동 검사가 안 붙어서, 판단을 여기 두면
 * **검증 밖으로 나갑니다.** 이 파일은 정해진 이름으로 파일을 만들고
 * 지우는 일만 합니다.
 *
 * ## ⚠️ 부르는 쪽은 **원격 코드**입니다
 *
 * 이 창은 서버가 준 화면을 띄웁니다. 그래서 renderer 가 주는 값은 전부
 * 공격자가 정할 수 있다고 보고 다룹니다.
 *
 *   - 경로를 **안 받습니다.** 회의 id 만 받고 폴더는 여기서 만듭니다
 *   - 회의 id 는 `sessionDirName` 이 허용 집합으로 거릅니다 — 통과 못
 *     하면 던집니다. 조용히 슬러그로 고쳐 주면 서로 다른 두 회의가 같은
 *     폴더를 쓰게 됩니다
 *   - **보낸 창이 우리 창인지** 봅니다. 다른 origin 의 프레임이 끼어들면
 *     거절합니다
 */

import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  chunkFileName,
  listChunks,
  parseChunkName,
  sessionDirName,
} from '../../src/lib/desktop/chunk-paths.ts';
import { sameOrigin } from '../../src/lib/desktop/server.ts';
import type { StoredChunk } from '../../src/lib/platform/chunk-store.ts';

/** 회의 폴더들이 사는 곳. OS 가 정해 주는 이 앱 전용 자리입니다. */
function root(): string {
  return join(app.getPath('userData'), 'chunks');
}

function sessionDir(sessionId: unknown): string {
  if (typeof sessionId !== 'string') throw new Error('회의 id가 문자열이 아닙니다');
  return join(root(), sessionDirName(sessionId));
}

/**
 * 보낸 쪽이 우리 창인가.
 *
 * ⚠️ `will-navigate` 로 이동은 막았지만 **iframe 은 다른 이야기**입니다.
 * 서버 화면이 남의 페이지를 프레임으로 물고 있으면 그 프레임도 preload
 * 를 못 받긴 하나, 채널은 프로세스 단위라 한 겹 더 겁니다.
 */
function fromOurWindow(event: IpcMainInvokeEvent, origin: string): boolean {
  const url = event.senderFrame?.url ?? '';
  return sameOrigin(url, origin);
}

/**
 * 보관소 채널을 연다.
 *
 * @param allowedOrigin 이 창이 머무는 곳. 여기서 온 요청만 받습니다.
 */
export function registerChunkStore(allowedOrigin: () => string): void {
  const guard =
    <T>(handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<T>) =>
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<T> => {
      if (!fromOurWindow(event, allowedOrigin())) {
        throw new Error('이 창에서 온 요청이 아닙니다');
      }
      return handler(event, ...args);
    };

  ipcMain.handle(
    'chunk:put',
    guard(async (_event, sessionId, seq, atMs, bytes) => {
      if (!(bytes instanceof ArrayBuffer)) throw new Error('바이트가 아닙니다');
      const dir = sessionDir(sessionId);
      await mkdir(dir, { recursive: true });
      // ⚠️ 이름 만들기가 seq·atMs 의 모양까지 검사합니다. 먼저 부릅니다 —
      //    폴더만 만들어 놓고 던지면 빈 폴더가 쌓입니다.
      const name = chunkFileName(seq as number, atMs as number);
      await writeFile(join(dir, name), Buffer.from(bytes as ArrayBuffer));
    }),
  );

  ipcMain.handle(
    'chunk:list',
    guard(async (_event, sessionId): Promise<StoredChunk[]> => {
      const dir = sessionDir(sessionId);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return []; // 아직 아무것도 안 적었으면 폴더가 없습니다. 오류가 아닙니다.
      }
      const { chunks } = listChunks(names);
      return Promise.all(
        chunks.map(async (c) => ({
          ...c,
          byteLength: (await stat(join(dir, chunkFileName(c.seq, c.atMs)))).size,
        })),
      );
    }),
  );

  ipcMain.handle(
    'chunk:get',
    guard(async (_event, sessionId, seq): Promise<ArrayBuffer | null> => {
      const dir = sessionDir(sessionId);
      // ⚠️ 이름에 atMs 가 들어 있어 seq 만으로는 파일명을 못 만듭니다.
      //    폴더를 훑어 찾습니다 — 목록이 두 벌이 되지 않게 한 값입니다.
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return null;
      }
      const hit = names.find((n) => parseChunkName(n)?.seq === seq);
      if (hit === undefined) return null;
      const buf = await readFile(join(dir, hit));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    }),
  );

  ipcMain.handle(
    'chunk:drop',
    guard(async (_event, sessionId, seq) => {
      const dir = sessionDir(sessionId);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return;
      }
      for (const n of names) {
        if (parseChunkName(n)?.seq === seq) await rm(join(dir, n), { force: true });
      }
    }),
  );
}
