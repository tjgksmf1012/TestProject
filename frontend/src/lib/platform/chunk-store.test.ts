import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  chunkBridge,
  describeGiveUp,
  openChunkStore,
  toBytes,
  type ChunkBridge,
} from './chunk-store.ts';

const fakeBridge = (): ChunkBridge & { calls: unknown[][] } => {
  const calls: unknown[][] = [];
  return {
    calls,
    put: async (...a) => void calls.push(['put', ...a]),
    list: async (...a) => {
      calls.push(['list', ...a]);
      return [];
    },
    get: async (...a) => {
      calls.push(['get', ...a]);
      return null;
    },
    drop: async (...a) => void calls.push(['drop', ...a]),
  };
};

describe('보관소 다리 — 네 칸이 다 있어야 인정한다', () => {
  it('넷 다 있으면 다리다', () => {
    assert.ok(chunkBridge(fakeBridge()) !== null);
  });

  it('⭐ 한 칸이라도 빠지면 다리가 아니다', () => {
    // ⚠️ `drop` 하나가 없으면 올라간 청크를 못 지워 디스크가 계속 찹니다.
    //    그런데 화면은 "보관 중" 이라고 말합니다 — 그게 제일 나쁩니다.
    for (const missing of ['put', 'list', 'get', 'drop']) {
      const bridge = fakeBridge() as unknown as Record<string, unknown>;
      delete bridge[missing];
      assert.equal(chunkBridge(bridge), null, missing);
    }
  });

  it('브라우저에는 아예 없다', () => {
    for (const nothing of [undefined, null, 0, 'x', {}]) {
      assert.equal(chunkBridge(nothing), null, String(nothing));
    }
  });

  it('보관할 수 없으면 `null` 이 정상값이다', () => {
    // 브라우저에서 이 값이 `null` 이어야 큐가 예전 그대로 돕니다.
    assert.equal(openChunkStore(undefined, 'm1'), null);
  });

  it('회의 id 를 다리에 그대로 넘긴다', async () => {
    const bridge = fakeBridge();
    const store = openChunkStore(bridge, 'meeting-7');
    assert.ok(store);
    await store.put({ seq: 3, atMs: 100, bytes: new ArrayBuffer(2) });
    await store.drop(3);
    assert.deepEqual(bridge.calls[0]?.slice(0, 2), ['put', 'meeting-7']);
    assert.deepEqual(bridge.calls[1], ['drop', 'meeting-7', 3]);
  });
});

describe('바이트 꺼내기', () => {
  it('ArrayBuffer 는 그대로', async () => {
    const buf = new ArrayBuffer(4);
    assert.equal(await toBytes(buf), buf);
  });

  it('⭐ `Blob` 도 받는다 — 실제 청크가 이 모양이다', async () => {
    // ⚠️ 이 검사가 왜 있는가: `MediaRecorder` 는 `Blob` 을 줍니다
    //    (`browser-adapter.ts`). `ArrayBuffer` 만 받게 짰다가 **실기에서
    //    청크가 한 개도 안 적히는데 테스트는 전부 통과하는** 상태를 만들
    //    뻔했습니다 — 테스트만 `ArrayBuffer` 를 넣고 있었기 때문입니다.
    const blobLike = { arrayBuffer: async () => new ArrayBuffer(8) };
    const bytes = await toBytes(blobLike);
    assert.equal(bytes?.byteLength, 8);
  });

  it('바이트를 못 내놓는 것은 `null`', () => {
    for (const junk of [undefined, null, 42, 'x', {}, { arrayBuffer: 1 }]) {
      assert.equal(toBytes(junk), null, String(junk));
    }
  });
});

describe('사람에게 하는 말', () => {
  it('없으면 아무 말도 안 한다', () => {
    assert.equal(describeGiveUp('parked', 0), '');
    assert.equal(describeGiveUp('lost', 0), '');
  });

  it('⭐ `lost` 에 "다시 올릴 수 있다" 를 쓰지 않는다', () => {
    // 올릴 것이 없습니다. 없는 길을 알려 주는 것이 없는 것보다 나쁩니다.
    const text = describeGiveUp('lost', 3);
    for (const lie of ['다시 올립니다', '남아 있습니다', '되찾']) {
      assert.ok(!text.includes(lie), `${lie} 가 들어 있습니다: ${text}`);
    }
    assert.ok(text.includes('공백'));
  });

  it('`parked` 는 되찾을 수 있다고 말한다', () => {
    const text = describeGiveUp('parked', 2);
    assert.ok(text.includes('2'));
    assert.ok(text.includes('남아 있습니다'));
  });

  it('⭐ 둘의 말이 서로 다르다', () => {
    // 같은 문장이면 가른 의미가 없습니다.
    assert.notEqual(describeGiveUp('parked', 1), describeGiveUp('lost', 1));
  });
});
