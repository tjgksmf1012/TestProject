import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  audioNote,
  clipOf,
  emptyTimelineNote,
  noAudioNote,
  pastClipEnd,
  timelineRows,
  trackAudioUrl,
  type TimelineUtterance,
} from './timeline.ts';
import type { Finding } from './findings.ts';

function utter(over: Partial<TimelineUtterance> = {}): TimelineUtterance {
  return {
    id: 1,
    start_ms: 10_000,
    end_ms: 13_000,
    text: '그럼 마감은 금요일로 하죠',
    speaker_id: 1,
    speaker_name: '김민수',
    speaker_source: 'track',
    speaker_confidence: null,
    is_overlap: false,
    utterance_type: null,
    audio: null,
    ...over,
  };
}

function finding(start_ms: number): Finding {
  return {
    kind: 'repeated_discussion',
    start_ms,
    end_ms: start_ms + 60_000,
    evidence_utterance_ids: [1],
    detail: { shared_words: ['배포'] },
  };
}

describe('구간 재생 (REVIEW-004)', () => {
  it('⭐ 재생 위치는 start_ms 가 아니라 서버가 준 position_ms 다', () => {
    // 이어 붙인 소리에는 공백이 없어 뒤가 앞당겨져 있다. start_ms 로
    // 틀면 엉뚱한 말이 나온다 — 이 구분이 이 기능의 존재 이유다.
    const clip = clipOf(utter({ start_ms: 17_000, end_ms: 19_000, audio: { track_id: 3, position_ms: 12_000 } }));
    assert.deepEqual(clip, { trackId: 3, startSec: 12, endSec: 14 });
  });

  it('들을 자리가 없으면 null — 이유는 서버가 이미 골랐다', () => {
    assert.equal(clipOf(utter({ audio: null })), null);
  });

  it('끝이 시작보다 앞서는 망가진 구간은 길이 0으로 잡는다', () => {
    const clip = clipOf(utter({ start_ms: 5_000, end_ms: 4_000, audio: { track_id: 1, position_ms: 1_000 } }));
    assert.deepEqual(clip, { trackId: 1, startSec: 1, endSec: 1 });
  });

  it('구간 끝을 지나면 멈출 때다', () => {
    const clip = { trackId: 1, startSec: 12, endSec: 14 };
    assert.equal(pastClipEnd(13.9, clip), false);
    assert.equal(pastClipEnd(14, clip), true);
  });

  it('소리 주소는 트랙 단위다', () => {
    assert.equal(trackAudioUrl('', 7, 3), '/api/meetings/7/tracks/3/audio');
  });
});

describe('타임라인 (REVIEW-002)', () => {
  it('⭐ 발화와 비효율 구간이 시간 순 한 줄기로 섞인다', () => {
    // 갈라지는 데이터 — 구간(60초)이 발화 둘(10초·90초) 사이에 선다.
    // 입력 순서(발화 먼저)와 시간 순서가 다르므로 정렬을 실제로 잰다.
    const rows = timelineRows(
      [utter({ id: 1, start_ms: 90_000 }), utter({ id: 2, start_ms: 10_000 })],
      [finding(60_000)],
    );
    assert.deepEqual(
      rows.map((r) => (r.kind === 'finding' ? '구간' : `발화${(r.view as { id: number }).id}`)),
      ['발화2', '구간', '발화1'],
    );
  });

  it('같은 시각이면 구간 머리말이 발화보다 앞에 선다', () => {
    const rows = timelineRows([utter({ start_ms: 60_000 })], [finding(60_000)]);
    assert.deepEqual(
      rows.map((r) => r.kind),
      ['finding', 'utterance'],
    );
  });

  it('발화 줄은 근거 대화상자와 같은 모양이다 — 판단 두 벌 금지', () => {
    const [row] = timelineRows([utter({ speaker_source: 'diarization' })], []);
    assert.ok(row !== undefined && row.kind === 'utterance');
    assert.equal(row.view.speaker, '김민수');
    // evidenceView 를 그대로 쓰므로 화자 판정 주석도 같이 온다.
    assert.match(row.view.speakerNote ?? '', /확정하지 못했습니다/);
  });

  it('빈 회의와 소리 없는 회의는 이유를 말한다', () => {
    // ⭐ 결함 346 — 상태를 받습니다. 「빈 목록은 고장과 구별이 안 된다」는
    //    요구는 그대로이므로 **상태마다** 확인합니다.
    // ⚠️ 낱말 목록으로 재지 않습니다 — 처음에 `/없습니다|쌓입니다/` 로
    //    적었다가 「…기다리는 중입니다」에 걸려 빨개졌습니다. 요구는
    //    「빈 목록이 고장으로 안 읽히게 **이유를 말한다**」입니다.
    for (const status of ['pending', 'queued', 'processing', 'failed', 'needs_review', 'confirmed', null]) {
      const text = emptyTimelineNote(status);
      assert.ok(text.length > 15, `${status}: 너무 짧아 이유가 안 됩니다 — ${text}`);
      assert.match(text, / — /, `${status}: 이유를 안 붙였습니다 — ${text}`);
      assert.doesNotMatch(text, /[A-Za-z_]{3,}/, `${status}: 내부 식별자가 샜습니다 — ${text}`);
    }
    // ⛔ 처리에 **실패한** 회의에게 「기다리면 온다」로 읽히면 안 됩니다.
    assert.doesNotMatch(emptyTimelineNote('failed'), /아직 처리되지 않았거나/);
    // ⭐ 상태마다 다른 말이어야 합니다 — 한 문장이면 상태를 안 본 것입니다.
    const 말들 = ['pending', 'queued', 'processing', 'failed'].map((s) => emptyTimelineNote(s));
    assert.equal(new Set(말들).size, 4, JSON.stringify(말들));
    assert.match(noAudioNote(), /보관돼 있지 않습니다/);
  });

  it('⭐ 소리 없음과 연결 안 됨은 다른 안내다 — 들을 수 있으면 침묵한다', () => {
    const silent = timelineRows([utter({ audio: null })], []);
    const playable = timelineRows(
      [utter({ audio: { track_id: 1, position_ms: 0 } })],
      [],
    );
    // 소리가 아예 없다: 보관 안내.
    assert.match(audioNote(false, silent) ?? '', /보관돼 있지 않습니다/);
    // 소리는 있는데 어느 발화도 못 듣는다: "없다" 고 하면 거짓말이다.
    assert.match(audioNote(true, silent) ?? '', /연결되지 않아/);
    // 들을 수 있으면 아무 말도 안 한다.
    assert.equal(audioNote(true, playable), null);
  });
});
