/**
 * 청크 업로드 큐.
 *
 * docs/03-시스템-아키텍처.md §4
 *
 * ## 전제
 *
 * 팀플 장소는 강의실, 카페, 스터디룸이다. 와이파이가 끊기고, LTE 로 넘어가고,
 * 엘리베이터를 탄다. **업로드가 실패하는 건 예외가 아니라 정상이다.**
 *
 * ## 규칙
 *
 * 1. **버리지 않는다.** 메모리가 찼으면 청크를 버리는 게 아니라 녹음을 멈춘다.
 *    59분짜리 온전한 녹음이 60분짜리 구멍난 녹음보다 낫다 (timeline.ts 참고).
 * 2. **순서에 기대지 않는다.** 청크는 seq 로 주소가 매겨져 있으므로 순서가
 *    뒤바뀌어 도착해도 서버가 복원한다. 그래서 동시 업로드를 해도 된다.
 * 3. **실패한 청크가 뒤를 막지 않는다.** 재시도 대기 중인 청크는 큐 뒤로 보낸다.
 *    앞에서 붙잡고 있으면 네트워크가 돌아와도 밀린 청크가 못 나간다.
 * 4. **포기한 건 기록한다.** 최대 시도 횟수를 넘긴 seq 는 `lost` 로 남고,
 *    `buildTimeline` 이 그 자리를 공백으로 표시한다. 조용히 사라지지 않는다.
 *
 * ## 보관소가 있으면 포기해도 **소리는 안 잃는다** (`docs/21` Phase 1)
 *
 * 데스크톱 앱에는 디스크가 있습니다. `store` 를 주면 청크가 들어올 때
 * 디스크에도 적고, 포기한 seq 중 **디스크에 무사히 앉은 것**은 `parked`
 * 로 따로 셉니다.
 *
 * ⚠️ **`parked` 도 `lost` 에 그대로 들어갑니다.** 지금 이 순간 서버에
 * 없다는 사실은 똑같고, `buildTimeline` 은 서버가 가진 것을 그립니다.
 * 빼 버리면 화면이 "구멍 없음" 이라고 말하는데 서버에는 구멍이 있는
 * 상태가 됩니다. `parked` 는 "되찾을 수 있다" 만 더해 주는 것입니다.
 *
 * ⚠️ 보관소가 없으면(`store` 가 `null` — 브라우저) **동작이 예전과
 * 한 글자도 다르지 않아야 합니다.**
 */

import { toBytes, type ChunkStore } from '../platform/chunk-store.ts';

export interface PendingChunk {
  seq: number;
  byteLength: number;
  /**
   * 이 청크가 도착한 시각 (동기화된 서버 시각).
   *
   * 서버가 `X-Client-At-Ms` 로 요구한다. 파일시스템에는 이 정보가 없어서,
   * 이게 빠지면 공백을 절대 시각으로 복원할 수 없다 (timeline.ts).
   */
  atMs: number;
  /** 실제 바이트. 브라우저에서는 Blob, 테스트에서는 아무거나. */
  payload: unknown;
}

export interface UploadTransport {
  /** 실패하면 reject 한다. 성공 반환 = 서버가 받았다는 뜻. */
  send(chunk: PendingChunk): Promise<void>;
}

export interface UploadQueueOptions {
  /** 동시 업로드 수. 모바일 회선에서 2 이상이면 지연을 잘 숨긴다. */
  concurrency?: number;
  /** 청크 하나당 최대 시도 횟수 (첫 시도 포함) */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /**
   * 대기 중인 바이트가 이 값을 넘으면 백프레셔를 알린다.
   * Opus 32kbps 기준 64MB ≈ 4시간치다. 여기까지 밀렸으면 회선이 죽은 것이다.
   */
  maxPendingBytes?: number;
  sleep?: (ms: number) => Promise<void>;
  /** 지터용. 테스트에서 고정하면 백오프가 결정적이 된다. */
  random?: () => number;
  /**
   * 청크를 붙잡아 둘 곳. 없으면(브라우저) `null`.
   *
   * ⚠️ 있어도 **업로드 경로를 바꾸지 않습니다.** 그대로 올리고, 올라가면
   * 지웁니다. 보관소는 실패했을 때만 쓸모가 있는 뒷문입니다.
   */
  store?: ChunkStore | null;
  onAck?: (seq: number) => void;
  onGiveUp?: (seq: number, reason: string) => void;
  onRetry?: (seq: number, attempt: number, delayMs: number) => void;
  /** 디스크에 적다 실패했을 때. 조용히 넘어가면 "보관 중" 이 거짓말이 된다. */
  onStoreError?: (seq: number, reason: string) => void;
}

export interface QueueStatus {
  pendingCount: number;
  pendingBytes: number;
  /** true 면 호출자가 녹음을 멈춰야 한다. 계속하면 메모리가 터진다. */
  backpressure: boolean;
}

export interface UploadResult {
  acked: number[];
  /**
   * 서버가 못 받은 seq. **`parked` 도 여기 들어 있습니다.**
   *
   * `buildTimeline` 이 이 목록으로 공백을 그립니다 — 서버 기준의 사실을
   * 그리는 것이므로, 디스크에 남아 있어도 지금은 공백이 맞습니다.
   */
  lost: number[];
  /**
   * 그중 **디스크에 무사히 앉아 되찾을 수 있는** seq.
   *
   * 보관소가 없으면 언제나 빈 배열입니다.
   */
  parked: number[];
  /** seq → 포기 사유 */
  failures: Map<number, string>;
  totalAttempts: number;
}

interface QueueItem {
  chunk: PendingChunk;
  attempts: number;
}

const DEFAULTS = {
  concurrency: 2,
  maxAttempts: 6,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  maxPendingBytes: 64 * 1024 * 1024,
};

/**
 * 지수 백오프 + 등분 지터.
 *
 * 지터가 없으면 팀원 5명의 폰이 회선 복구 순간에 **동시에** 재시도한다.
 * 서버 입장에선 그게 작은 스파이크다. 절반은 고정, 절반은 무작위로 흩뿌린다.
 */
export function backoffDelay(
  attempt: number,
  { baseDelayMs = DEFAULTS.baseDelayMs, maxDelayMs = DEFAULTS.maxDelayMs, random = Math.random },
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.round(exponential * (0.5 + 0.5 * random()));
}

type Hooks = 'onAck' | 'onGiveUp' | 'onRetry' | 'onStoreError' | 'store';

export class UploadQueue {
  #transport: UploadTransport;
  #options: Required<Omit<UploadQueueOptions, Hooks>> & Pick<UploadQueueOptions, Hooks>;

  #pending: QueueItem[] = [];
  #processing = new Set<number>();
  #acked = new Set<number>();
  #failures = new Map<number, string>();
  #pendingBytes = 0;
  #totalAttempts = 0;
  #closed = false;
  #waiters: Array<() => void> = [];
  #workers: Promise<void>[] | null = null;

  /**
   * seq → **디스크에 무사히 앉았는가.**
   *
   * ⚠️ 던지지 않는 약속으로 만들어 둡니다. 디스크 쓰기는 업로드보다 훨씬
   * 자주 성공하지만 실패할 수 있고(용량·권한), 그때 붙잡지 않은 거절이
   * 뜨면 Electron 이 창 위에 오류를 던집니다. **녹음 중에.**
   */
  #onDisk = new Map<number, Promise<boolean>>();

  constructor(transport: UploadTransport, options: UploadQueueOptions = {}) {
    this.#transport = transport;
    this.#options = {
      concurrency: options.concurrency ?? DEFAULTS.concurrency,
      maxAttempts: options.maxAttempts ?? DEFAULTS.maxAttempts,
      baseDelayMs: options.baseDelayMs ?? DEFAULTS.baseDelayMs,
      maxDelayMs: options.maxDelayMs ?? DEFAULTS.maxDelayMs,
      maxPendingBytes: options.maxPendingBytes ?? DEFAULTS.maxPendingBytes,
      sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      random: options.random ?? Math.random,
      store: options.store ?? null,
      onAck: options.onAck,
      onGiveUp: options.onGiveUp,
      onRetry: options.onRetry,
      onStoreError: options.onStoreError,
    };
  }

  get status(): QueueStatus {
    return {
      pendingCount: this.#pending.length + this.#processing.size,
      pendingBytes: this.#pendingBytes,
      backpressure: this.#pendingBytes > this.#options.maxPendingBytes,
    };
  }

  /**
   * 청크를 큐에 넣는다. **절대 거절하지 않는다.**
   *
   * 거절해서 버리는 대신 backpressure 를 켠다. 호출자(세션 상태 머신)가
   * 녹음을 멈추면 새 청크가 안 들어오고, 큐는 결국 빠진다.
   */
  enqueue(chunk: PendingChunk): QueueStatus {
    if (this.#acked.has(chunk.seq) || this.#failures.has(chunk.seq)) return this.status;
    this.#pending.push({ chunk, attempts: 0 });
    this.#pendingBytes += chunk.byteLength;
    this.#keep(chunk);
    this.#notify();
    return this.status;
  }

  /**
   * 디스크에도 적어 둔다. 보관소가 없으면 아무 일도 안 한다.
   *
   * ⚠️ **기다리지 않습니다.** `enqueue` 는 `MediaRecorder` 의 데이터
   * 콜백에서 불립니다. 거기서 디스크를 기다리면 다음 청크가 밀리고,
   * 밀리면 녹음이 끊깁니다 — 고치려던 바로 그 결함입니다. 대신 약속을
   * 붙잡아 뒀다가 **포기 시점과 `finish()` 에서** 확인합니다.
   */
  #keep(chunk: PendingChunk): void {
    const store = this.#options.store;
    if (!store) return;

    // ⚠️ `payload` 는 보통 **`Blob`** 입니다 (`browser-adapter.ts`).
    //    `ArrayBuffer` 만 받게 짜면 테스트는 다 통과하는데 실기에서는
    //    한 개도 안 적힙니다 — 테스트가 `ArrayBuffer` 를 넣기 때문입니다.
    const bytes = toBytes(chunk.payload);
    if (bytes === null) {
      this.#onDisk.set(chunk.seq, Promise.resolve(false));
      this.#options.onStoreError?.(chunk.seq, '보관소에 넣을 수 있는 바이트가 아닙니다');
      return;
    }

    const fail = (error: unknown): false => {
      const reason = error instanceof Error ? error.message : String(error);
      this.#options.onStoreError?.(chunk.seq, reason);
      return false;
    };

    this.#onDisk.set(
      chunk.seq,
      bytes
        .then((buffer) => store.put({ seq: chunk.seq, atMs: chunk.atMs, bytes: buffer }))
        .then(() => true, fail),
    );
  }

  /**
   * 재연결 후 서버가 "이미 가진 seq" 를 알려줬을 때 호출한다.
   * 중복 업로드를 막는다 — 모바일 데이터를 아끼는 게 아니라, 재연결마다
   * 처음부터 다시 올리면 영영 못 따라잡기 때문이다.
   */
  resumeWith(serverHasSeqs: readonly number[]): void {
    const has = new Set(serverHasSeqs);
    this.#pending = this.#pending.filter((item) => {
      if (!has.has(item.chunk.seq)) return true;
      this.#pendingBytes -= item.chunk.byteLength;
      this.#acked.add(item.chunk.seq);
      return false;
    });
    for (const seq of has) this.#acked.add(seq);
  }

  start(): void {
    if (this.#workers) return;
    this.#workers = Array.from({ length: this.#options.concurrency }, () => this.#worker());
  }

  /** 더 이상 청크가 없다고 알리고, 남은 걸 전부 처리할 때까지 기다린다. */
  async finish(): Promise<UploadResult> {
    this.start();
    this.#closed = true;
    this.#notify();
    await Promise.all(this.#workers!);

    const lost = [...this.#failures.keys()].sort((a, b) => a - b);
    return {
      acked: [...this.#acked].sort((a, b) => a - b),
      lost,
      parked: await this.#parked(lost),
      failures: new Map(this.#failures),
      totalAttempts: this.#totalAttempts,
    };
  }

  /**
   * 포기한 것 중 **디스크에 무사히 앉은** seq.
   *
   * ⚠️ 여기서 처음으로 디스크 약속을 기다립니다. 포기한 청크만 보므로
   * 보통은 빈 목록이고, 그때는 기다릴 것도 없습니다.
   */
  async #parked(lost: readonly number[]): Promise<number[]> {
    if (!this.#options.store || lost.length === 0) return [];
    const settled = await Promise.all(
      lost.map(async (seq) => ((await this.#onDisk.get(seq)) === true ? seq : null)),
    );
    return settled.filter((seq): seq is number => seq !== null);
  }

  /**
   * 서버가 받았으니 디스크에서 지운다.
   *
   * ⚠️ **지우기 실패는 조용히 넘어갑니다.** 서버가 이미 받은 청크라
   * 소리는 안전하고, 남은 것은 다음 실행에서 정리됩니다. 여기서 던지면
   * 성공한 업로드가 실패로 뒤집힙니다.
   */
  #release(seq: number): void {
    const store = this.#options.store;
    if (!store) return;
    this.#onDisk.delete(seq);
    void store.drop(seq).catch(() => {});
  }

  async #worker(): Promise<void> {
    for (;;) {
      const item = this.#pending.shift();
      if (item === undefined) {
        // 다른 워커가 아직 붙잡고 있으면 그게 큐로 되돌릴 수 있다.
        if (this.#closed && this.#processing.size === 0) return;
        if (this.#closed && this.#processing.size > 0) {
          await this.#waitForWork();
          continue;
        }
        await this.#waitForWork();
        continue;
      }
      await this.#attempt(item);
    }
  }

  async #attempt(item: QueueItem): Promise<void> {
    const { seq } = item.chunk;
    this.#processing.add(seq);
    try {
      item.attempts += 1;
      this.#totalAttempts += 1;
      await this.#transport.send(item.chunk);
      this.#acked.add(seq);
      this.#pendingBytes -= item.chunk.byteLength;
      this.#release(seq);
      this.#options.onAck?.(seq);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (item.attempts >= this.#options.maxAttempts) {
        this.#failures.set(seq, reason);
        this.#pendingBytes -= item.chunk.byteLength;
        this.#options.onGiveUp?.(seq, reason);
      } else {
        const delayMs = backoffDelay(item.attempts, this.#options);
        this.#options.onRetry?.(seq, item.attempts, delayMs);
        await this.#options.sleep(delayMs);
        // 큐 뒤로 보낸다 — 이 청크 때문에 뒤가 막히면 안 된다.
        this.#pending.push(item);
      }
    } finally {
      this.#processing.delete(seq);
      this.#notify();
    }
  }

  #waitForWork(): Promise<void> {
    return new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  #notify(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }
}
