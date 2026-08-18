import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHUNK_EXT,
  chunkFileName,
  isSafeSessionId,
  listChunks,
  parseChunkName,
  sessionDirName,
} from './chunk-paths.ts';

describe('회의 id — 허용할 것만 센다', () => {
  it('평범한 id 는 통과한다', () => {
    for (const ok of ['abc', 'meeting-42', 'A_b-9', '0', 'x'.repeat(64)]) {
      assert.equal(isSafeSessionId(ok), true, ok);
      assert.equal(sessionDirName(ok), ok);
    }
  });

  it('⭐ 경로를 벗어나려는 값은 전부 막힌다', () => {
    // ⚠️ 이 창은 **서버가 준 화면**을 띄웁니다. 서버가 뚫리면 이 문자열은
    //    공격자가 정합니다. 하나라도 통과하면 임의 파일 쓰기입니다.
    const attacks = [
      '..',
      '../..',
      'a/../../etc',
      'a/b',
      'a\\b',
      '/etc/passwd',
      'C:\\Windows',
      '%2e%2e',
      '....//',
      'a\0b',
      'a\nb',
      '.',
      '~',
      '$HOME',
      'a b',
      '회의1', // 한글도 안 됩니다 — 허용 집합에 없으면 그냥 막힙니다
    ];
    for (const bad of attacks) {
      assert.equal(isSafeSessionId(bad), false, bad);
      assert.throws(() => sessionDirName(bad), /회의 id/, bad);
    }
  });

  it('⭐ 빈 값과 너무 긴 값도 막힌다', () => {
    assert.equal(isSafeSessionId(''), false);
    assert.equal(isSafeSessionId('x'.repeat(65)), false);
  });

  it('⚠️ 이상한 값을 슬러그로 고쳐 주지 않는다', () => {
    // 고쳐 주면 `a/b` 와 `a-b` 가 **같은 폴더**를 쓰게 되고, 두 회의의
    // 청크가 한 곳에 섞입니다. 섞인 뒤에는 되돌릴 방법이 없습니다.
    assert.throws(() => sessionDirName('a/b'));
  });
});

describe('청크 파일 이름 — seq 와 atMs 를 같이 들고 있다', () => {
  it('되읽으면 넣은 값이 그대로 나온다', () => {
    const name = chunkFileName(42, 1_700_000_000_123);
    assert.equal(name, `c42@1700000000123${CHUNK_EXT}`);
    assert.deepEqual(parseChunkName(name), { seq: 42, atMs: 1_700_000_000_123 });
  });

  it('atMs 를 정수로 반올림한다', () => {
    // 공백 판정 임계가 100ms 라 1ms 반올림은 판정을 못 바꿉니다.
    assert.deepEqual(parseChunkName(chunkFileName(0, 12.4)), { seq: 0, atMs: 12 });
    assert.deepEqual(parseChunkName(chunkFileName(0, 12.6)), { seq: 0, atMs: 13 });
  });

  it('음수 시각도 되읽힌다', () => {
    // 시계 동기화 전 구간은 서버 epoch 기준으로 음수가 될 수 있습니다.
    assert.deepEqual(parseChunkName(chunkFileName(3, -5)), { seq: 3, atMs: -5 });
  });

  it('말이 안 되는 값은 만들지 않는다', () => {
    assert.throws(() => chunkFileName(-1, 0), /seq/);
    assert.throws(() => chunkFileName(1.5, 0), /seq/);
    assert.throws(() => chunkFileName(0, Number.NaN), /atMs/);
    assert.throws(() => chunkFileName(0, Number.POSITIVE_INFINITY), /atMs/);
  });

  it('남의 파일은 우리 것으로 안 읽는다', () => {
    for (const other of [
      '.DS_Store',
      'c1.chunk',
      'c1@2.webm',
      'c@1.chunk',
      'cx@1.chunk',
      'c1@1.chunk.bak',
      '',
    ]) {
      assert.equal(parseChunkName(other), null, other);
    }
  });
});

describe('목록 — 글자순이 아니라 숫자순', () => {
  it('⭐ 자리수를 넘겨도 순서가 안 뒤집힌다', () => {
    // ⚠️ 0 을 채워 정렬하는 흔한 방법은 자리수를 넘기는 순간 깨집니다.
    //    `c9@..` 와 `c10@..` 를 글자로 비교하면 `c10` 이 앞입니다.
    const names = [
      chunkFileName(10, 100),
      chunkFileName(9, 90),
      chunkFileName(1_000_000, 999),
      chunkFileName(999_999, 998),
    ];
    const { chunks } = listChunks(names);
    assert.deepEqual(
      chunks.map((c) => c.seq),
      [9, 10, 999_999, 1_000_000],
    );
  });

  it('남의 파일은 빼되 **몇 개를 뺐는지 말한다**', () => {
    const { chunks, skipped } = listChunks([
      '.DS_Store',
      chunkFileName(2, 20),
      'thumbs.db',
      chunkFileName(1, 10),
    ]);
    assert.deepEqual(
      chunks.map((c) => c.seq),
      [1, 2],
    );
    assert.equal(skipped, 2);
  });

  it('빈 폴더', () => {
    assert.deepEqual(listChunks([]), { chunks: [], skipped: 0 });
  });
});
