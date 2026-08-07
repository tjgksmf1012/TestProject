/**
 * 로딩 표시가 **깜빡이지 않는가**, 그리고 **반드시 사라지는가.**
 *
 * 둘째가 더 중요합니다. 안 지워진 스켈레톤은 오류를 덮고, 화면은
 * 영원히 로딩 중으로 남고, 어디에도 오류가 안 납니다.
 */

import { strictEqual, deepStrictEqual, rejects } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LOADING_DELAY_MS, whileLoading, type Timers } from './pending.ts';

/** 시계를 손으로 돌리는 타이머. 실제로 200ms 를 기다리지 않습니다. */
class FakeTimers implements Timers {
  private queue = new Map<number, { fn: () => void; at: number }>();
  private now = 0;
  private nextId = 1;

  set(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.queue.set(id, { fn, at: this.now + ms });
    return id;
  }

  clear(id: number): void {
    this.queue.delete(id);
  }

  advance(ms: number): void {
    this.now += ms;
    for (const [id, entry] of [...this.queue]) {
      if (entry.at <= this.now) {
        this.queue.delete(id);
        entry.fn();
      }
    }
  }

  get pending(): number {
    return this.queue.size;
  }
}

/** `show`/`hide` 가 불린 순서를 그대로 적는다. */
const recorder = (): { log: string[]; show: () => void; hide: () => void } => {
  const log: string[] = [];
  return { log, show: () => log.push('show'), hide: () => log.push('hide') };
};

describe('200ms 안에 끝나면', () => {
  it('⭐ 로딩 표시를 **한 번도** 만들지 않는다', async () => {
    // 깜빡임이 아무것도 안 보여주는 것보다 나쁩니다 (지시서 §4.7).
    const timers = new FakeTimers();
    const { log, show, hide } = recorder();

    await whileLoading(Promise.resolve('데이터'), show, hide, timers, LOADING_DELAY_MS);

    deepStrictEqual(log, []);
  });

  it('⭐ 안 켠 것을 끄지도 않는다', async () => {
    // `hide()` 는 보통 컨테이너를 비웁니다. 안 켰는데 끄면 원래 있던
    // 내용을 지웁니다.
    const timers = new FakeTimers();
    const { log, show, hide } = recorder();

    await whileLoading(Promise.reject(new Error('실패')), show, hide, timers).catch(() => {});

    deepStrictEqual(log, []);
  });

  it('타이머를 남겨 두지 않는다', async () => {
    const timers = new FakeTimers();
    const { show, hide } = recorder();

    await whileLoading(Promise.resolve(1), show, hide, timers);

    strictEqual(timers.pending, 0);
  });

  it('값을 그대로 돌려준다', async () => {
    const timers = new FakeTimers();
    const { show, hide } = recorder();

    strictEqual(await whileLoading(Promise.resolve(42), show, hide, timers), 42);
  });
});

describe('오래 걸리면', () => {
  it('200ms 뒤에 로딩 표시를 켠다', async () => {
    const timers = new FakeTimers();
    const { log, show, hide } = recorder();
    let finish: (v: string) => void = () => {};
    const work = new Promise<string>((resolve) => {
      finish = resolve;
    });

    const running = whileLoading(work, show, hide, timers);
    timers.advance(199);
    deepStrictEqual(log, [], '199ms 에는 아직 아무것도');

    timers.advance(1);
    deepStrictEqual(log, ['show']);

    finish('데이터');
    await running;
    deepStrictEqual(log, ['show', 'hide']);
  });

  it('⭐ **실패해도** 로딩 표시를 지운다', async () => {
    // 오류 문구를 다른 요소에 쓰는 화면이 여럿이라, 스켈레톤이 있던
    // 자리는 아무도 안 건드립니다. 지우지 않으면 오류가 난 화면이
    // **영원히 로딩 중**으로 남습니다.
    const timers = new FakeTimers();
    const { log, show, hide } = recorder();
    let fail: (e: Error) => void = () => {};
    const work = new Promise<never>((_, reject) => {
      fail = reject;
    });

    const running = whileLoading(work, show, hide, timers);
    timers.advance(LOADING_DELAY_MS);
    fail(new Error('HTTP 500'));

    await rejects(running, /HTTP 500/);
    deepStrictEqual(log, ['show', 'hide']);
  });

  it('⭐ 오류를 삼키지 않는다', async () => {
    // 삼키면 화면은 조용히 비고, 사람은 &#34;활동이 없구나&#34; 로 읽습니다.
    const timers = new FakeTimers();
    const { show, hide } = recorder();

    await rejects(
      whileLoading(Promise.reject(new Error('403')), show, hide, timers),
      /403/,
    );
  });
});

describe('경계', () => {
  it('⭐ 끝난 **직후** 타이머가 돌아도 켜지지 않는다', async () => {
    // 199ms 에 끝나고 200ms 에 타이머가 도는 경주. 취소를 안 하면
    // 이미 그려진 실제 내용 위에 스켈레톤이 덮입니다.
    const timers = new FakeTimers();
    const { log, show, hide } = recorder();

    await whileLoading(Promise.resolve('데이터'), show, hide, timers);
    timers.advance(1000);

    deepStrictEqual(log, []);
  });

  it('지연을 0 으로 주면 바로 켠다 — 강제 표시용', async () => {
    const timers = new FakeTimers();
    const { log, show, hide } = recorder();
    let finish: (v: number) => void = () => {};
    const work = new Promise<number>((resolve) => {
      finish = resolve;
    });

    const running = whileLoading(work, show, hide, timers, 0);
    timers.advance(0);
    deepStrictEqual(log, ['show']);

    finish(1);
    await running;
  });

  it('지연 값이 한 곳에만 있다', () => {
    strictEqual(LOADING_DELAY_MS, 200);
  });
});
