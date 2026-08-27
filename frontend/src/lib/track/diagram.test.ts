/**
 * 운행도표의 **축이 맞는가.**
 *
 * 서버는 구멍을 트랙 자기 시작 기준 밀리초로 줍니다. 그런데 사람마다
 * 녹음을 시작한 시각이 다릅니다. 그대로 그리면 나중에 들어온 사람의
 * 구멍이 **회의 앞쪽**에 찍힙니다.
 *
 * 축이 틀리면 "그 결정이 나올 때 이 사람 녹음이 끊겨 있었다" 가 통째로
 * 거짓이 됩니다. 이 파일의 절반이 그 한 가지를 봅니다.
 */

import { strictEqual, deepStrictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { axisTicks, buildDiagram, describeGap, meetingWindow } from './diagram.ts';
import type { TrackInput } from './diagram.ts';

const T0 = '2026-09-01T10:00:00.000Z';
const T30 = '2026-09-01T10:30:00.000Z';
const MIN = 60_000;

const track = (userId: number, over: Partial<TrackInput> = {}): TrackInput => ({
  userId,
  startedAt: T0,
  endedAt: T30,
  gaps: [],
  ...over,
});

describe('시간축', () => {
  it('가장 먼저 시작해서 가장 늦게 끝난 데까지', () => {
    const w = meetingWindow([
      track(1, { startedAt: T0, endedAt: '2026-09-01T10:20:00.000Z' }),
      track(2, { startedAt: '2026-09-01T10:05:00.000Z', endedAt: T30 }),
    ]);
    strictEqual(w?.startMs, Date.parse(T0));
    strictEqual(w?.endMs, Date.parse(T30));
  });

  it('⭐ 아직 녹음 중인 트랙은 축을 넓히지 않는다', () => {
    // "지금" 을 끝으로 잡으면 화면을 볼 때마다 축이 움직이고, 이미
    // 그려진 구멍의 위치가 계속 바뀝니다.
    const w = meetingWindow([
      track(1, { endedAt: T30 }),
      track(2, { endedAt: null }),
    ]);
    strictEqual(w?.endMs, Date.parse(T30));
  });

  it('끝난 트랙이 하나도 없으면 축을 못 정한다', () => {
    strictEqual(meetingWindow([track(1, { endedAt: null })]), null);
  });

  it('시각이 깨져 있어도 죽지 않는다', () => {
    strictEqual(meetingWindow([track(1, { startedAt: 'not-a-date' })]), null);
  });
});

describe('구멍의 위치', () => {
  it('30분 회의의 10~15분 구멍은 33%~50%', () => {
    const d = buildDiagram([
      track(1, { gaps: [{ startMs: 10 * MIN, endMs: 15 * MIN }] }),
    ]);
    const [span] = d.gaps.get(1) ?? [];
    strictEqual(Math.round(span!.left), 33);
    strictEqual(Math.round(span!.left + span!.width), 50);
  });

  it('⭐ **늦게 시작한 사람의 구멍이 앞으로 밀려오지 않는다**', () => {
    // 이게 이 파일의 핵심입니다. 서버가 주는 `startMs` 는 그 트랙
    // 자기 기준이라, 오프셋을 안 더하면 5분 늦게 들어온 사람의
    // "내 기준 0~5분" 구멍이 회의 맨 앞에 찍힙니다.
    const late = track(2, {
      startedAt: '2026-09-01T10:05:00.000Z',
      endedAt: T30,
      gaps: [{ startMs: 0, endMs: 5 * MIN }], // 그 사람 기준 0~5분
    });
    const d = buildDiagram([track(1), late]);
    const [span] = d.gaps.get(2) ?? [];
    // 회의 기준으로는 5~10분 → 16.7%~33.3%
    strictEqual(Math.round(span!.left), 17);
    strictEqual(Math.round(span!.left + span!.width), 33);
  });

  it('축을 못 정하면 **빈 도표** — 거짓 위치보다 낫다', () => {
    const d = buildDiagram([track(1, { endedAt: null, gaps: [{ startMs: 0, endMs: MIN }] })]);
    strictEqual(d.durationMs, 0);
    strictEqual(d.gaps.size, 0);
  });

  it('창 밖으로 삐져나간 구멍은 잘라 넣는다', () => {
    const d = buildDiagram([
      track(1, { gaps: [{ startMs: -5 * MIN, endMs: 5 * MIN }] }),
    ]);
    const [span] = d.gaps.get(1) ?? [];
    strictEqual(span!.left, 0);
  });

  it('완전히 창 밖인 구멍은 안 그린다', () => {
    const d = buildDiagram([
      track(1, { gaps: [{ startMs: 60 * MIN, endMs: 70 * MIN }] }),
    ]);
    strictEqual(d.gaps.has(1), false);
  });

  it('거꾸로거나 길이 0 인 구멍은 버린다', () => {
    const d = buildDiagram([
      track(1, { gaps: [{ startMs: 10 * MIN, endMs: 10 * MIN }, { startMs: 5 * MIN, endMs: MIN }] }),
    ]);
    strictEqual(d.gaps.has(1), false);
  });

  it('⭐ 아주 짧은 구멍도 보이되 길이를 과장하지 않는다', () => {
    // 1초 끊긴 것과 안 끊긴 것은 다릅니다. 그렇다고 최소 폭을 크게
    // 주면 **없는 길이를 지어내는** 것이 됩니다.
    const d = buildDiagram([track(1, { gaps: [{ startMs: MIN, endMs: MIN + 1000 }] })]);
    const [span] = d.gaps.get(1) ?? [];
    strictEqual(span!.width > 0, true);
    strictEqual(span!.width < 1, true);
  });

  it('구멍이 없는 사람은 목록에 안 들어간다', () => {
    const d = buildDiagram([track(1), track(2)]);
    strictEqual(d.gaps.size, 0);
  });

  it('gaps 가 없어도 죽지 않는다', () => {
    const d = buildDiagram([{ userId: 1, startedAt: T0, endedAt: T30 } as TrackInput]);
    strictEqual(d.durationMs > 0, true);
  });
});

describe('축 눈금', () => {
  it('30분 회의는 0·5·10·15·20·25·30', () => {
    deepStrictEqual(axisTicks(30 * MIN), ['0분', '5', '10', '15', '20', '25', '30분']);
  });

  it('길이가 0 이면 눈금도 없다', () => {
    deepStrictEqual(axisTicks(0), []);
  });

  it('⭐ 1분보다 짧으면 **초로** 말한다 (결함 242)', () => {
    // 베타 참가자가 제일 먼저 하는 30초짜리 시험 녹음에서 축이
    // `0분 0 0 0 0 0 0분` 이었습니다 — 아무것도 안 말하고, 고장으로 읽힙니다.
    deepStrictEqual(axisTicks(30_000), ['0초', '5', '10', '15', '20', '25', '30초']);
    deepStrictEqual(axisTicks(12_000), ['0초', '2', '4', '6', '8', '10', '12초']);
  });

  it('경계에서 단위가 바뀐다 — 1분부터는 분', () => {
    strictEqual(axisTicks(59_999).at(-1)?.endsWith('초'), true);
    strictEqual(axisTicks(60_000).at(-1)?.endsWith('분'), true);
  });

  it('단위가 무엇이든 눈금은 **커지기만** 하고 끝이 전체 길이다', () => {
    /* ⚠️ 처음에는 「간격이 전부 같다」로 썼다가 5분짜리에서 걸렸습니다 —
       `round(5*i/6)` 은 `1 2 3 3 4` 라 라벨이 겹칩니다. 자리는 등간격이고
       **라벨만** 반올림된 것이라 거짓말은 아닙니다(등간격 거짓말은 자리를
       속이는 것입니다). 요구가 아니라 제가 잰 것이 틀렸습니다. */
    for (const [ms, unit] of [
      [12_000, '초'],
      [30_000, '초'],
      [5 * MIN, '분'],
      [30 * MIN, '분'],
    ] as const) {
      const ticks = axisTicks(ms);
      const values = ticks.map((t) => Number.parseInt(t, 10));
      for (let i = 1; i < values.length; i += 1) {
        strictEqual(values[i]! >= values[i - 1]!, true, `${ms} → ${ticks.join(' ')}`);
      }
      strictEqual(ticks.at(-1), `${ms / (unit === '초' ? 1_000 : 60_000)}${unit}`);
    }
  });
});

describe('구멍 설명', () => {
  it('언제·왜 를 사람의 말로', () => {
    const d = buildDiagram([
      track(1, { gaps: [{ startMs: 10 * MIN, endMs: 15 * MIN, reason: 'recorder_stalled' }] }),
    ]);
    const [span] = d.gaps.get(1) ?? [];
    const text = describeGap(span!, d.durationMs);
    strictEqual(text.includes('10~15분'), true);
    strictEqual(text.includes('화면이 꺼졌거나'), true);
  });

  it('⭐ 우리 용어를 화면에 내보내지 않는다', () => {
    // `recorder_stalled` 는 사람에게 아무 뜻이 없고 할 일도 안 알려
    // 줍니다 (지시서 §8 — 시스템 용어 금지).
    const d = buildDiagram([
      track(1, { gaps: [{ startMs: MIN, endMs: 2 * MIN, reason: 'recorder_stalled' }] }),
    ]);
    const text = describeGap(d.gaps.get(1)![0]!, d.durationMs);
    strictEqual(text.includes('recorder_stalled'), false);
  });

  it('모르는 원인도 문장이 된다', () => {
    const d = buildDiagram([
      track(1, { gaps: [{ startMs: MIN, endMs: 2 * MIN, reason: 'martian_ray' }] }),
    ]);
    const text = describeGap(d.gaps.get(1)![0]!, d.durationMs);
    strictEqual(text.includes('martian_ray'), false);
    strictEqual(text.includes('끊겼습니다'), true);
  });
});

describe('짧은 회의의 구멍도 초로 말한다 (결함 242)', () => {
  it('⛔ 「0분쯤」은 구멍이 어디인지 하나도 안 알려 준다', () => {
    const d = buildDiagram([
      {
        userId: 1,
        startedAt: '2026-09-01T10:00:00.000Z',
        endedAt: '2026-09-01T10:00:12.000Z',
        gaps: [{ startMs: 5_000, endMs: 10_000, reason: 'chunk_lost' }],
      },
    ]);
    const [span] = d.gaps.get(1) ?? [];
    const text = describeGap(span!, d.durationMs);
    strictEqual(text.includes('분'), false, text);
    strictEqual(text.includes('초'), true, text);
    strictEqual(text.includes('5~10초'), true, text);
  });
});
