import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildTimeline,
  describeGapReason,
  describeTimeline,
  judgeTrack,
  mergeIntervals,
  MIN_USABLE_COVERAGE,
} from './timeline.ts';
import type { ChunkMeta } from './types.ts';

const START = 1_000_000;
const TIMESLICE = 5_000;

/** `atMs` 목록으로 청크를 만든다. seq 는 0부터. */
function chunksAt(...times: number[]): ChunkMeta[] {
  return times.map((atMs, seq) => ({ seq, atMs, byteLength: 40_000 }));
}

/** 끊김 없는 녹음 n 슬라이스 */
function perfect(n: number): ChunkMeta[] {
  return chunksAt(...Array.from({ length: n }, (_, i) => START + TIMESLICE * (i + 1)));
}

describe('buildTimeline — 정상 녹음', () => {
  it('끊김이 없으면 공백이 없고 커버리지가 1이다', () => {
    const chunks = perfect(12); // 1분
    const timeline = buildTimeline(chunks, {
      timesliceMs: TIMESLICE,
      startedAtMs: START,
      endedAtMs: START + 60_000,
    });

    assert.equal(timeline.gaps.length, 0);
    assert.equal(timeline.totalGapMs, 0);
    assert.equal(timeline.coverage, 1);
    assert.equal(timeline.alignmentSafe, true);
    assert.equal(timeline.segments.length, 1);
    assert.deepEqual(
      { fromSeq: timeline.segments[0]!.fromSeq, toSeq: timeline.segments[0]!.toSeq },
      { fromSeq: 0, toSeq: 11 },
    );
  });

  it('브라우저 지터(수십 ms)는 공백으로 보지 않는다', () => {
    // dataavailable 은 timeslice 를 정확히 지키지 않는다.
    const chunks = chunksAt(
      START + 5_040,
      START + 10_120,
      START + 15_060,
      START + 20_180,
      START + 25_090,
    );
    const timeline = buildTimeline(chunks, {
      timesliceMs: TIMESLICE,
      startedAtMs: START,
      endedAtMs: START + 25_100,
    });
    assert.equal(timeline.gaps.length, 0, '지터를 공백으로 오인하면 안 된다');
  });
});

describe('buildTimeline — iOS 화면 잠금', () => {
  it('레코더가 멈춘 구간을 찾아낸다', () => {
    // 10초까지 정상 → 화면 잠금 30초 → 재개
    const chunks = chunksAt(
      START + 5_000,
      START + 10_000,
      START + 45_000, // 35초 만에 도착 (실제 오디오는 마지막 5초뿐)
      START + 50_000,
    );
    const timeline = buildTimeline(chunks, {
      timesliceMs: TIMESLICE,
      startedAtMs: START,
      endedAtMs: START + 50_000,
    });

    assert.equal(timeline.gaps.length, 1);
    const gap = timeline.gaps[0]!;
    assert.equal(gap.reason, 'recorder_stalled');
    assert.equal(gap.durationMs, 30_000);
    assert.equal(gap.startMs, START + 10_000);
    assert.equal(gap.endMs, START + 40_000);
    assert.equal(gap.afterSeq, 1, '공백 직전 마지막 청크를 기록한다');
    assert.equal(timeline.alignmentSafe, false);
  });

  it('공백 앞뒤가 각각 별도 구간으로 분리된다', () => {
    const chunks = chunksAt(START + 5_000, START + 10_000, START + 45_000, START + 50_000);
    const timeline = buildTimeline(chunks, {
      timesliceMs: TIMESLICE,
      startedAtMs: START,
      endedAtMs: START + 50_000,
    });

    assert.equal(timeline.segments.length, 2);
    assert.deepEqual(
      timeline.segments.map((s) => [s.startMs - START, s.endMs - START]),
      [
        [0, 10_000],
        [40_000, 50_000],
      ],
    );
  });

  it('⭐ 이어붙이기만 하면 공백 길이만큼 뒤가 통째로 앞당겨진다', () => {
    // 이 모듈이 존재하는 이유. 순진한 구현이 정확히 이 오류를 낸다.
    const chunks = chunksAt(START + 5_000, START + 10_000, START + 45_000, START + 50_000);
    const timeline = buildTimeline(chunks, {
      timesliceMs: TIMESLICE,
      startedAtMs: START,
      endedAtMs: START + 50_000,
    });

    // 순진한 방식: 청크 4개 × 5초 = 20초짜리 파일. 마지막 청크가 15~20초에 놓인다.
    const naiveEndOfLastChunk = chunks.length * TIMESLICE;
    // 실제로 그 오디오가 있었던 시각은 45~50초다.
    const trueEndOfLastChunk = timeline.endedAtMs - timeline.startedAtMs;

    const shift = trueEndOfLastChunk - naiveEndOfLastChunk;
    assert.equal(shift, 30_000);
    assert.equal(shift, timeline.totalGapMs, '어긋나는 양은 정확히 공백 길이다');

    // GCC-PHAT 탐색창은 ±500ms 다. 30초는 비교도 안 되게 크다.
    assert.ok(shift > 500, 'GCC-PHAT 로는 절대 복구할 수 없는 크기');
  });

  it('녹음 끝 직전에 멈춰도 잡는다', () => {
    const chunks = chunksAt(START + 5_000, START + 10_000);
    const timeline = buildTimeline(chunks, {
      timesliceMs: TIMESLICE,
      startedAtMs: START,
      endedAtMs: START + 40_000, // 사용자는 40초에 정지를 눌렀는데 청크는 10초에서 끊겼다
    });

    assert.equal(timeline.gaps.length, 1);
    assert.equal(timeline.gaps[0]!.durationMs, 30_000);
    assert.equal(timeline.gaps[0]!.startMs, START + 10_000);
  });
});

describe('buildTimeline — 마이크 음소거', () => {
  it('타이밍은 정상인데 무음인 구간을 mutedIntervals 로 잡는다', () => {
    // iOS 백그라운드 전환 시 트랙이 muted 로 바뀌는 경우.
    // 청크는 계속 오므로 시간 간격만 봐서는 절대 못 찾는다.
    const chunks = perfect(12);
    const timeline = buildTimeline(chunks, {
      timesliceMs: TIMESLICE,
      startedAtMs: START,
      endedAtMs: START + 60_000,
      mutedIntervals: [{ startMs: START + 20_000, endMs: START + 35_000 }],
    });

    assert.equal(timeline.gaps.length, 1);
    assert.equal(timeline.gaps[0]!.reason, 'track_muted');
    assert.equal(timeline.gaps[0]!.durationMs, 15_000);
    assert.equal(timeline.coverage, 0.75);
  });

  it('mute 구간은 녹음 범위 밖으로 삐져나가지 않는다', () => {
    const chunks = perfect(12);
    const timeline = buildTimeline(chunks, {
      timesliceMs: TIMESLICE,
      startedAtMs: START,
      endedAtMs: START + 60_000,
      // 정지 버튼 이후에도 mute 이벤트가 늦게 도착할 수 있다
      mutedIntervals: [{ startMs: START + 50_000, endMs: START + 90_000 }],
    });
    assert.equal(timeline.gaps[0]!.endMs, START + 60_000);
    assert.equal(timeline.gaps[0]!.durationMs, 10_000);
  });
});

describe('buildTimeline — 업로드 실패', () => {
  it('끝내 못 올린 청크는 구멍으로 남는다', () => {
    const chunks = perfect(12);
    const timeline = buildTimeline(chunks, {
      timesliceMs: TIMESLICE,
      startedAtMs: START,
      endedAtMs: START + 60_000,
      lostSeqs: [4], // 25초 지점 청크
    });

    assert.equal(timeline.gaps.length, 1);
    assert.equal(timeline.gaps[0]!.reason, 'chunk_lost');
    assert.equal(timeline.gaps[0]!.startMs, START + 20_000);
    assert.equal(timeline.gaps[0]!.endMs, START + 25_000);
  });

  it('첫 청크를 잃어도 시작 시각 앞으로 넘어가지 않는다', () => {
    const timeline = buildTimeline(perfect(4), {
      timesliceMs: TIMESLICE,
      startedAtMs: START,
      endedAtMs: START + 20_000,
      lostSeqs: [0],
    });
    assert.equal(timeline.gaps[0]!.startMs, START);
  });
});

describe('buildTimeline — 공백이 겹칠 때', () => {
  it('겹치는 공백을 두 번 세지 않는다', () => {
    // 화면이 잠기면서 트랙도 mute 됐다 — 같은 구간이 두 경로로 보고된다.
    const chunks = chunksAt(START + 5_000, START + 10_000, START + 45_000, START + 50_000);
    const timeline = buildTimeline(chunks, {
      timesliceMs: TIMESLICE,
      startedAtMs: START,
      endedAtMs: START + 50_000,
      mutedIntervals: [{ startMs: START + 12_000, endMs: START + 38_000 }],
    });

    assert.equal(timeline.gaps.length, 2, '원인은 둘 다 기록한다');
    assert.equal(timeline.totalGapMs, 30_000, '길이는 합집합으로 센다');
    assert.equal(timeline.coverage, 0.4);
  });

  it('떨어져 있는 공백은 각각 더한다', () => {
    const chunks = perfect(12);
    const timeline = buildTimeline(chunks, {
      timesliceMs: TIMESLICE,
      startedAtMs: START,
      endedAtMs: START + 60_000,
      mutedIntervals: [
        { startMs: START + 5_000, endMs: START + 10_000 },
        { startMs: START + 40_000, endMs: START + 45_000 },
      ],
    });
    assert.equal(timeline.totalGapMs, 10_000);
    assert.equal(timeline.segments.length, 3);
  });
});

describe('mergeIntervals', () => {
  it('겹친 구간을 합친다', () => {
    assert.deepEqual(
      mergeIntervals([
        { startMs: 0, endMs: 100 },
        { startMs: 50, endMs: 200 },
      ]),
      [{ startMs: 0, endMs: 200 }],
    );
  });

  it('맞닿은 구간도 합친다', () => {
    assert.deepEqual(
      mergeIntervals([
        { startMs: 0, endMs: 100 },
        { startMs: 100, endMs: 200 },
      ]),
      [{ startMs: 0, endMs: 200 }],
    );
  });

  it('완전히 포함된 구간을 흡수한다', () => {
    assert.deepEqual(
      mergeIntervals([
        { startMs: 0, endMs: 500 },
        { startMs: 100, endMs: 200 },
      ]),
      [{ startMs: 0, endMs: 500 }],
    );
  });

  it('입력을 변형하지 않는다', () => {
    const input = [{ startMs: 0, endMs: 100 }];
    mergeIntervals(input);
    assert.deepEqual(input, [{ startMs: 0, endMs: 100 }]);
  });

  it('길이가 0인 구간은 버린다', () => {
    assert.deepEqual(mergeIntervals([{ startMs: 10, endMs: 10 }]), []);
  });
});

describe('judgeTrack', () => {
  it('공백이 없으면 신뢰도 1', () => {
    const timeline = buildTimeline(perfect(12), {
      timesliceMs: TIMESLICE,
      startedAtMs: START,
      endedAtMs: START + 60_000,
    });
    assert.deepEqual(judgeTrack(timeline), { usable: true, confidence: 1, reason: '공백 없음' });
  });

  it('공백이 조금 있으면 그만큼 신뢰도를 낮춘다', () => {
    const timeline = buildTimeline(perfect(12), {
      timesliceMs: TIMESLICE,
      startedAtMs: START,
      endedAtMs: START + 60_000,
      mutedIntervals: [{ startMs: START + 10_000, endMs: START + 16_000 }],
    });
    const verdict = judgeTrack(timeline);
    assert.equal(verdict.usable, true);
    assert.equal(verdict.confidence, 0.9);
  });

  it('⭐ 커버리지가 낮으면 낮은 점수를 주는 대신 트랙을 버린다', () => {
    // 폰이 잠긴 사람을 "말을 안 한 사람"으로 처리하면 그건 그냥 오답이다.
    const chunks = chunksAt(START + 5_000, START + 10_000, START + 55_000, START + 60_000);
    const timeline = buildTimeline(chunks, {
      timesliceMs: TIMESLICE,
      startedAtMs: START,
      endedAtMs: START + 60_000,
    });
    const verdict = judgeTrack(timeline);

    assert.ok(timeline.coverage < MIN_USABLE_COVERAGE);
    assert.equal(verdict.usable, false);
    assert.equal(verdict.confidence, 0, '조용히 낮은 점수를 주지 않는다');
    assert.match(verdict.reason, /사람이 확인/);
  });
});

describe('describeTimeline', () => {
  it('정상이면 그렇게 말한다', () => {
    const timeline = buildTimeline(perfect(12), {
      timesliceMs: TIMESLICE,
      startedAtMs: START,
      endedAtMs: START + 60_000,
    });
    assert.match(describeTimeline(timeline), /끊김 없이 완료/);
  });

  it('공백이 있으면 원인과 크기를 숨기지 않는다', () => {
    const chunks = chunksAt(START + 5_000, START + 10_000, START + 45_000, START + 50_000);
    const timeline = buildTimeline(chunks, {
      timesliceMs: TIMESLICE,
      startedAtMs: START,
      endedAtMs: START + 50_000,
    });
    const text = describeTimeline(timeline);
    assert.match(text, /30초/);
    assert.match(text, /화면 잠금/);
    assert.match(text, /커버리지 40\.0%/);
  });
});

describe('buildTimeline — 입력 검증', () => {
  it('timeslice 가 0 이하면 던진다', () => {
    assert.throws(
      () => buildTimeline([], { timesliceMs: 0, startedAtMs: START, endedAtMs: START + 1 }),
      /양수/,
    );
  });

  it('종료가 시작보다 빠르면 던진다', () => {
    assert.throws(
      () => buildTimeline([], { timesliceMs: 100, startedAtMs: START, endedAtMs: START - 1 }),
      /빠릅니다/,
    );
  });

  it('청크가 하나도 없으면 전체가 공백이다', () => {
    const timeline = buildTimeline([], {
      timesliceMs: TIMESLICE,
      startedAtMs: START,
      endedAtMs: START + 60_000,
    });
    assert.equal(timeline.totalGapMs, 60_000);
    assert.equal(timeline.coverage, 0);
    assert.equal(timeline.segments.length, 0);
  });

  it('seq 가 뒤섞여 들어와도 정렬해서 처리한다', () => {
    const shuffled = [
      { seq: 2, atMs: START + 15_000, byteLength: 1 },
      { seq: 0, atMs: START + 5_000, byteLength: 1 },
      { seq: 1, atMs: START + 10_000, byteLength: 1 },
    ];
    const timeline = buildTimeline(shuffled, {
      timesliceMs: TIMESLICE,
      startedAtMs: START,
      endedAtMs: START + 15_000,
    });
    assert.equal(timeline.gaps.length, 0);
  });
});

describe('공백의 까닭을 사람의 말로 (결함 241)', () => {
  it('⭐ 세 까닭 모두 한국어이고 내부 이름이 안 새어 나온다', () => {
    for (const reason of ['recorder_stalled', 'track_muted', 'chunk_lost'] as const) {
      const said = describeGapReason(reason);
      assert.equal(said.length > 0, true, reason);
      assert.equal(said.includes('_'), false, `${reason} → ${said}`);
      assert.equal(/[a-z]{4,}/.test(said), false, `${reason} → ${said}`);
    }
  });
});
