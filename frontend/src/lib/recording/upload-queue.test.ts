import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  UploadQueue,
  backoffDelay,
  type PendingChunk,
  type UploadTransport,
} from './upload-queue.ts';

/** 지정한 시도 횟수까지 실패하는 가짜 전송기. 모든 시도를 순서대로 기록한다. */
class FakeTransport implements UploadTransport {
  readonly log: number[] = [];
  readonly attempts = new Map<number, number>();
  /** seq → 이 횟수까지는 실패한다. Infinity 면 영원히. */
  readonly failUntil: Map<number, number>;

  constructor(failUntil: Iterable<[number, number]> = []) {
    this.failUntil = new Map(failUntil);
  }

  async send(chunk: PendingChunk): Promise<void> {
    const n = (this.attempts.get(chunk.seq) ?? 0) + 1;
    this.attempts.set(chunk.seq, n);
    this.log.push(chunk.seq);
    if (n <= (this.failUntil.get(chunk.seq) ?? 0)) {
      throw new Error(`네트워크 오류 (seq=${chunk.seq}, 시도 ${n})`);
    }
  }
}

/** 즉시 resolve 하지만 요청된 지연을 기록한다. */
function fakeSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

function chunks(count: number, byteLength = 1000): PendingChunk[] {
  return Array.from({ length: count }, (_, seq) => ({
    seq,
    byteLength,
    atMs: 1_700_000_000_000 + seq * 5_000,
    payload: `c${seq}`,
  }));
}

describe('UploadQueue — 정상 경로', () => {
  it('모든 청크를 올리고 acked 로 보고한다', async () => {
    const transport = new FakeTransport();
    const queue = new UploadQueue(transport, { sleep: fakeSleep().sleep });
    for (const c of chunks(5)) queue.enqueue(c);

    const result = await queue.finish();
    assert.deepEqual(result.acked, [0, 1, 2, 3, 4]);
    assert.deepEqual(result.lost, []);
    assert.equal(result.totalAttempts, 5);
  });

  it('청크가 없어도 정상 종료한다', async () => {
    const result = await new UploadQueue(new FakeTransport()).finish();
    assert.deepEqual(result.acked, []);
    assert.deepEqual(result.lost, []);
  });

  it('녹음 중에 들어오는 청크도 처리한다', async () => {
    const transport = new FakeTransport();
    const queue = new UploadQueue(transport, { sleep: fakeSleep().sleep });
    queue.start();

    for (const c of chunks(3)) {
      queue.enqueue(c);
      await Promise.resolve(); // 다음 청크가 나올 때까지의 틈
    }
    const result = await queue.finish();
    assert.deepEqual(result.acked, [0, 1, 2]);
  });

  it('같은 seq 를 두 번 넣어도 한 번만 올린다', async () => {
    const transport = new FakeTransport();
    const queue = new UploadQueue(transport, { sleep: fakeSleep().sleep, concurrency: 1 });
    queue.enqueue({ seq: 0, byteLength: 10, atMs: 1_700_000_000_000, payload: 'a' });
    queue.start();
    await Promise.resolve();
    await Promise.resolve();
    queue.enqueue({ seq: 0, byteLength: 10, atMs: 1_700_000_000_000, payload: 'a' });

    const result = await queue.finish();
    assert.deepEqual(result.acked, [0]);
    assert.deepEqual(transport.log, [0]);
  });
});

describe('UploadQueue — 재시도', () => {
  it('일시적 실패는 재시도해서 결국 성공한다', async () => {
    const transport = new FakeTransport([[2, 3]]); // seq 2 는 3번 실패
    const { sleep, delays } = fakeSleep();
    const queue = new UploadQueue(transport, { sleep, concurrency: 1, random: () => 1 });
    for (const c of chunks(4)) queue.enqueue(c);

    const result = await queue.finish();
    assert.deepEqual(result.acked, [0, 1, 2, 3]);
    assert.deepEqual(result.lost, []);
    assert.equal(transport.attempts.get(2), 4);
    assert.deepEqual(delays, [500, 1000, 2000], '지수 백오프');
  });

  it('⭐ 실패한 청크가 뒤에 있는 청크를 막지 않는다', async () => {
    // 실패한 걸 붙잡고 재시도하면, 회선이 돌아와도 밀린 청크가 못 나간다.
    const transport = new FakeTransport([[0, 2]]);
    const queue = new UploadQueue(transport, {
      sleep: fakeSleep().sleep,
      concurrency: 1,
      random: () => 1,
    });
    for (const c of chunks(6)) queue.enqueue(c);

    const result = await queue.finish();
    assert.deepEqual(
      transport.log,
      [0, 1, 2, 3, 4, 5, 0, 0],
      'seq 0 이 재시도를 기다리는 동안 1~5 가 먼저 나간다',
    );
    assert.deepEqual(result.acked, [0, 1, 2, 3, 4, 5]);
  });

  it('최대 시도 횟수를 넘기면 포기하고 lost 로 남긴다', async () => {
    const transport = new FakeTransport([[1, Infinity]]);
    const given: Array<[number, string]> = [];
    const queue = new UploadQueue(transport, {
      sleep: fakeSleep().sleep,
      maxAttempts: 3,
      concurrency: 1,
      onGiveUp: (seq, reason) => given.push([seq, reason]),
    });
    for (const c of chunks(3)) queue.enqueue(c);

    const result = await queue.finish();
    assert.deepEqual(result.acked, [0, 2]);
    assert.deepEqual(result.lost, [1], '잃은 건 조용히 사라지지 않고 기록된다');
    assert.equal(transport.attempts.get(1), 3);
    assert.equal(given.length, 1);
    assert.match(given[0]![1], /네트워크 오류/);
  });

  it('포기한 seq 는 buildTimeline 의 lostSeqs 로 그대로 넘어간다', async () => {
    // upload-queue → timeline 의 계약. 여기가 어긋나면 구멍이 보고되지 않는다.
    const transport = new FakeTransport([[4, Infinity]]);
    const queue = new UploadQueue(transport, {
      sleep: fakeSleep().sleep,
      maxAttempts: 2,
      concurrency: 1,
    });
    for (const c of chunks(6)) queue.enqueue(c);

    const { lost } = await queue.finish();
    assert.deepEqual(lost, [4]);
    assert.ok(Array.isArray(lost), 'lostSeqs 로 바로 쓸 수 있는 형태');
  });

  it('재시도 콜백으로 진행 상황을 알린다', async () => {
    const transport = new FakeTransport([[0, 2]]);
    const retries: Array<[number, number]> = [];
    const queue = new UploadQueue(transport, {
      sleep: fakeSleep().sleep,
      concurrency: 1,
      random: () => 1,
      onRetry: (seq, attempt) => retries.push([seq, attempt]),
    });
    queue.enqueue(chunks(1)[0]!);
    await queue.finish();
    assert.deepEqual(retries, [
      [0, 1],
      [0, 2],
    ]);
  });
});

describe('backoffDelay', () => {
  it('시도마다 두 배로 늘어난다', () => {
    const opts = { baseDelayMs: 500, maxDelayMs: 30_000, random: () => 1 };
    assert.deepEqual(
      [1, 2, 3, 4, 5].map((n) => backoffDelay(n, opts)),
      [500, 1000, 2000, 4000, 8000],
    );
  });

  it('상한을 넘지 않는다', () => {
    const opts = { baseDelayMs: 500, maxDelayMs: 30_000, random: () => 1 };
    assert.equal(backoffDelay(20, opts), 30_000);
  });

  it('⭐ 지터로 흩뿌린다 — 팀원 5명이 동시에 재시도하면 안 된다', () => {
    const opts = { baseDelayMs: 1000, maxDelayMs: 30_000 };
    const shortest = backoffDelay(3, { ...opts, random: () => 0 });
    const longest = backoffDelay(3, { ...opts, random: () => 1 });
    assert.equal(shortest, 2000);
    assert.equal(longest, 4000);
    assert.ok(shortest < longest, '무작위 성분이 실제로 폭을 만든다');
  });

  it('지터가 있어도 절반 아래로는 안 내려간다', () => {
    const opts = { baseDelayMs: 1000, maxDelayMs: 30_000, random: () => 0 };
    assert.equal(backoffDelay(1, opts), 500, '즉시 재시도로 서버를 때리지 않는다');
  });
});

describe('UploadQueue — 재연결', () => {
  it('서버가 이미 가진 청크는 다시 올리지 않는다', async () => {
    const transport = new FakeTransport();
    const queue = new UploadQueue(transport, { sleep: fakeSleep().sleep });
    for (const c of chunks(6)) queue.enqueue(c);

    // 재연결: 서버가 "0,1,2 는 이미 있다"고 알려줬다
    queue.resumeWith([0, 1, 2]);

    const result = await queue.finish();
    assert.deepEqual(transport.log, [3, 4, 5]);
    assert.deepEqual(result.acked, [0, 1, 2, 3, 4, 5]);
  });

  it('재연결 후 대기 바이트도 줄어든다', () => {
    const queue = new UploadQueue(new FakeTransport());
    for (const c of chunks(4, 1000)) queue.enqueue(c);
    assert.equal(queue.status.pendingBytes, 4000);

    queue.resumeWith([0, 1]);
    assert.equal(queue.status.pendingBytes, 2000);
  });

  it('⭐ 재연결마다 처음부터 다시 올리면 영영 못 따라잡는다', () => {
    // resumeWith 가 없을 때 벌어지는 일을 수치로 고정해 둔다.
    const queue = new UploadQueue(new FakeTransport());
    for (const c of chunks(100, 20_000)) queue.enqueue(c);
    const beforeBytes = queue.status.pendingBytes;

    queue.resumeWith(Array.from({ length: 90 }, (_, i) => i));
    assert.equal(beforeBytes, 2_000_000);
    assert.equal(queue.status.pendingBytes, 200_000, '남은 10개만 올린다');
  });
});

describe('UploadQueue — 백프레셔', () => {
  it('한도 안에서는 백프레셔가 꺼져 있다', () => {
    const queue = new UploadQueue(new FakeTransport(), { maxPendingBytes: 10_000 });
    for (const c of chunks(5, 1000)) queue.enqueue(c);
    assert.equal(queue.status.backpressure, false);
    assert.equal(queue.status.pendingCount, 5);
  });

  it('⭐ 한도를 넘으면 청크를 버리는 게 아니라 신호를 올린다', () => {
    const queue = new UploadQueue(new FakeTransport(), { maxPendingBytes: 3_000 });
    let status = queue.status;
    for (const c of chunks(5, 1000)) status = queue.enqueue(c);

    assert.equal(status.backpressure, true);
    assert.equal(status.pendingCount, 5, '넘쳐도 다섯 개 전부 큐에 있다');
    assert.equal(status.pendingBytes, 5000);
  });

  it('업로드가 되면 대기 바이트가 줄어 백프레셔가 풀린다', async () => {
    const queue = new UploadQueue(new FakeTransport(), {
      maxPendingBytes: 3_000,
      sleep: fakeSleep().sleep,
    });
    for (const c of chunks(5, 1000)) queue.enqueue(c);
    assert.equal(queue.status.backpressure, true);

    await queue.finish();
    assert.equal(queue.status.backpressure, false);
    assert.equal(queue.status.pendingBytes, 0);
  });

  it('포기한 청크의 바이트도 회수한다', async () => {
    const queue = new UploadQueue(new FakeTransport([[0, Infinity]]), {
      sleep: fakeSleep().sleep,
      maxAttempts: 2,
    });
    queue.enqueue({ seq: 0, byteLength: 5000, atMs: 1_700_000_000_000, payload: 'x' });
    await queue.finish();
    assert.equal(queue.status.pendingBytes, 0, '메모리가 새면 안 된다');
  });
});

describe('UploadQueue — 동시 업로드', () => {
  it('동시성이 높아도 모든 청크가 정확히 한 번 올라간다', async () => {
    const transport = new FakeTransport();
    const queue = new UploadQueue(transport, { sleep: fakeSleep().sleep, concurrency: 4 });
    for (const c of chunks(20)) queue.enqueue(c);

    const result = await queue.finish();
    assert.equal(result.acked.length, 20);
    assert.equal(transport.log.length, 20);
    assert.equal(new Set(transport.log).size, 20, '중복 전송 없음');
  });

  it('동시 업로드 중에 실패가 섞여도 나머지는 다 올라간다', async () => {
    const transport = new FakeTransport([
      [3, 2],
      [11, Infinity],
      [17, 1],
    ]);
    const queue = new UploadQueue(transport, {
      sleep: fakeSleep().sleep,
      concurrency: 3,
      maxAttempts: 4,
    });
    for (const c of chunks(20)) queue.enqueue(c);

    const result = await queue.finish();
    assert.deepEqual(result.lost, [11]);
    assert.equal(result.acked.length, 19);
  });
});
