/**
 * 녹음 청크를 **잃지 않고 어딘가 붙잡아 둘 곳이 있는가.**
 *
 * `docs/21` Phase 1.
 *
 * ## 무엇을 고치는 것인가
 *
 * 지금 `UploadQueue` 는 여섯 번 시도하고 실패하면 그 청크를 `lost` 로
 * 적습니다. `buildTimeline` 이 그 자리를 공백으로 그리고, **그 소리는
 * 영영 없습니다.** 브라우저에서는 그게 최선입니다 — 붙잡아 둘 곳이
 * 없으니까요. 탭을 닫으면 메모리도 같이 사라집니다.
 *
 * **데스크톱 앱에는 디스크가 있습니다.** 서버가 3분 꺼져 있었다는 이유로
 * 회의 한 구간을 잃는 것은 이 셸이 존재하는 이유와 정면으로 어긋납니다.
 *
 * ## ⚠️ 셸이 있다는 것과 보관할 수 있다는 것은 다릅니다
 *
 * `recording.ts` 가 `keepsAwake` 로 겪은 것과 같은 함정입니다. 셸이
 * 있어도 이 다리가 없을 수 있고(판이 낮거나, 디스크가 꽉 찼거나),
 * 그때 "보관됩니다" 라고 말하면 **거짓말**입니다. 그래서 여기서도
 * 이름이 아니라 **다리가 실제로 있는지**만 봅니다.
 *
 * ## ⚠️ 보관소가 없을 때의 동작은 **오늘과 똑같아야 합니다**
 *
 * 브라우저에서 도는 화면이 이 변경으로 달라지면 안 됩니다. 그래서
 * `null` 이 정상값이고, `null` 이면 큐는 예전 그대로 `lost` 로 적습니다.
 */

/** 디스크에 앉아 있는 청크 하나. */
export interface StoredChunk {
  seq: number;
  atMs: number;
  byteLength: number;
}

/**
 * 청크를 잃지 않게 붙잡아 두는 곳.
 *
 * ⚠️ **경로가 없습니다.** renderer 는 어디에 쓸지 못 정합니다 — 이 창은
 * 서버가 준 코드를 돌리므로, 경로를 받는 API 를 열면 그게 곧 임의 파일
 * 쓰기입니다. 어디에 쓸지는 `lib/desktop/chunk-paths.ts` 가 정하고
 * main 이 실행합니다.
 */
export interface ChunkStore {
  /** 적는다. 실패하면 reject — 삼키지 않습니다. */
  put(chunk: { seq: number; atMs: number; bytes: ArrayBuffer }): Promise<void>;
  /** 보관 중인 것. seq 순. */
  list(): Promise<StoredChunk[]>;
  /** 하나 읽어 온다. 없으면 `null`. */
  get(seq: number): Promise<ArrayBuffer | null>;
  /** 서버가 받았으니 지운다. */
  drop(seq: number): Promise<void>;
}

/**
 * 바이트를 내놓을 수 있는 것. **`Blob` 이 이 모양입니다.**
 *
 * ⚠️ 이것이 왜 있는가 — `MediaRecorder` 가 주는 청크는 `ArrayBuffer` 가
 * 아니라 `Blob` 입니다(`browser-adapter.ts`). 처음에 `ArrayBuffer` 만
 * 받게 짰다가 **실기에서 청크가 한 개도 안 적히는데 테스트는 전부
 * 통과하는** 상태를 만들 뻔했습니다 — 테스트는 `ArrayBuffer` 를 넣으니까요.
 */
export interface BytesLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * 이 payload 에서 바이트를 꺼낼 수 있는가. 못 꺼내면 `null`.
 *
 * `null` 을 돌려주는 것이 던지는 것보다 낫습니다 — 부르는 자리가 녹음
 * 데이터 콜백이라, 거기서 던지면 다음 청크가 밀립니다.
 */
export function toBytes(payload: unknown): Promise<ArrayBuffer> | null {
  if (payload instanceof ArrayBuffer) return Promise.resolve(payload);
  if (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as BytesLike).arrayBuffer === 'function'
  ) {
    return (payload as BytesLike).arrayBuffer();
  }
  return null;
}

/** 데스크톱 셸이 preload 로 내놓는 보관소 다리. `electron/preload` 와 짝. */
export interface ChunkBridge {
  put(sessionId: string, seq: number, atMs: number, bytes: ArrayBuffer): Promise<void>;
  list(sessionId: string): Promise<StoredChunk[]>;
  get(sessionId: string, seq: number): Promise<ArrayBuffer | null>;
  drop(sessionId: string, seq: number): Promise<void>;
}

/**
 * 다리가 **네 칸 다 있는지** 본다.
 *
 * ⚠️ 객체가 있는지만 보면 안 됩니다. 셸 판이 낮아 `drop` 하나가 없으면
 * 올라간 청크를 못 지우고 디스크가 계속 찹니다 — 그런데 화면은 "보관
 * 중" 이라고 말합니다. 넷이 다 있을 때만 보관소로 인정합니다.
 */
export function chunkBridge(bridge: unknown): ChunkBridge | null {
  if (typeof bridge !== 'object' || bridge === null) return null;
  const b = bridge as Record<string, unknown>;
  for (const fn of ['put', 'list', 'get', 'drop']) {
    if (typeof b[fn] !== 'function') return null;
  }
  return b as unknown as ChunkBridge;
}

/**
 * 이 회의의 보관소를 연다. 보관할 수 없는 환경이면 `null`.
 *
 * @param sessionId 회의 id. **모양 검사는 main 이 다시 합니다** — 여기서
 * 걸러도 renderer 코드는 서버가 준 것이라 믿을 수 없습니다. 두 벌로
 * 두는 것이 아니라, 믿을 수 있는 쪽이 한쪽뿐인 것입니다.
 */
export function openChunkStore(bridge: unknown, sessionId: string): ChunkStore | null {
  const api = chunkBridge(bridge);
  if (api === null) return null;
  return {
    put: ({ seq, atMs, bytes }) => api.put(sessionId, seq, atMs, bytes),
    list: () => api.list(sessionId),
    get: (seq) => api.get(sessionId, seq),
    drop: (seq) => api.drop(sessionId, seq),
  };
}

/**
 * 업로드를 포기했을 때 그 청크는 어떻게 되는가.
 *
 * ⚠️ **`'parked'` 는 "괜찮다" 가 아닙니다.** 서버에 아직 없다는 뜻이고,
 * 누군가 다시 올려야 합니다. 화면이 그 사실과 **다시 올릴 자리**를 같이
 * 줘야 합니다 — 알려만 주고 할 자리를 안 주는 것이 이 저장소의 대표
 * 실패 ③ 입니다.
 */
export type GiveUpOutcome = 'lost' | 'parked';

/**
 * 사람에게 하는 말.
 *
 * ⚠️ **`'lost'` 에 "다시 올릴 수 있습니다" 를 쓰면 안 됩니다.** 올릴
 * 것이 없습니다. 없는 길을 알려 주는 것이 없는 것보다 나쁩니다.
 */
export function describeGiveUp(outcome: GiveUpOutcome, count: number): string {
  if (count === 0) return '';
  return outcome === 'parked'
    ? `${count}개가 이 컴퓨터에 남아 있습니다 — 서버가 돌아오면 다시 올립니다.`
    : `${count}개를 못 올렸습니다. 그 구간은 회의록에 공백으로 남습니다.`;
}

/**
 * 「남은 청크 다시 올리기」를 누른 **뒤에** 뭐라고 할지 (결함 245).
 *
 * ⛔ 예전에는 실패한 seq 를 조용히 목록에 도로 넣기만 했습니다. 화면은
 * 그대로였고(같은 「N개가 남아 있습니다」), 사람은 **눌러도 아무 일도 안
 * 일어난다**고 읽습니다. 하필 그 조각들은 회의의 소리이고, 이 버튼이
 * 그것을 되찾는 유일한 길입니다.
 */
export function describeReupload(sent: number, still: number): string {
  if (sent === 0 && still === 0) return '올릴 것이 없습니다';
  if (still === 0) return `${sent}개를 올렸습니다 — 이 컴퓨터에 남은 것이 없습니다`;
  if (sent === 0) {
    return `${still}개를 아직 못 올렸습니다 — 서버가 돌아온 뒤 다시 눌러 보세요`;
  }
  return `${sent}개를 올렸습니다. ${still}개는 아직 못 올렸습니다 — 다시 눌러 보세요`;
}
