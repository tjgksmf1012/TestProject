import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  emptyEvidenceNote,
  EVIDENCE_CHIPS_SHOWN,
  evidenceQuery,
  evidenceView,
  missingNote,
  speakerNote,
  splitEvidenceChips,
  type Utterance,
  withContext,
} from './evidence.ts';

function utterance(overrides: Partial<Utterance> = {}): Utterance {
  return {
    id: 5,
    start_ms: 32_000,
    end_ms: 38_000,
    text: '배포 방식은 다음 회의로 미룹시다',
    speaker_id: 1,
    speaker_name: '김민수',
    speaker_source: 'track',
    speaker_confidence: 1,
    is_overlap: false,
    utterance_type: 'decision',
    ...overrides,
  };
}

describe('evidenceQuery', () => {
  it('쉼표로 잇는다', () => {
    strictEqual(evidenceQuery([5, 2]), '5,2');
  });

  it('중복을 지운다 — 같은 발화를 두 번 물을 이유가 없다', () => {
    strictEqual(evidenceQuery([5, 5, 2]), '5,2');
  });

  it('⭐ 빈 목록이면 빈 문자열 — 요청 자체를 안 보내게', () => {
    // `?ids=` 로 부르면 서버는 빈 배열을 주는데, 그건 왕복 한 번을
    // 아무것도 아닌 일에 쓰는 것입니다.
    strictEqual(evidenceQuery([]), '');
  });

  it('⭐ 쓰레기 값을 서버로 보내지 않는다', () => {
    // 서버는 정수가 아니면 400 을 냅니다. 화면이 먼저 걸러야 사람이
    // 이유 없는 오류를 안 봅니다.
    strictEqual(evidenceQuery([5, Number.NaN, -1, 0, 2.5, 2]), '5,2');
  });
});

describe('speakerNote', () => {
  it('⭐ 멀티트랙 확정은 **아무 말도 하지 않는다**', () => {
    // 멀티트랙은 이 제품의 기본 전제라 그게 정상입니다. 정상에 꼬리표를
    // 달면 정작 불확실한 셋이 안 보입니다.
    strictEqual(speakerNote('track', 1), null);
  });

  it('목소리 추정은 유사도까지 말한다', () => {
    strictEqual(speakerNote('voiceprint', 0.82), '목소리로 추정한 화자입니다 (유사도 82%)');
  });

  it('유사도가 없으면 지어내지 않는다', () => {
    strictEqual(speakerNote('voiceprint', null), '목소리로 추정한 화자입니다');
  });

  it('사람이 지정한 것은 그렇게 말한다', () => {
    strictEqual(speakerNote('manual', null), '사람이 지정한 화자입니다');
  });

  it('⭐ 모르는 출처를 조용히 "확정" 으로 그리지 않는다', () => {
    // 서버가 새 출처를 추가했는데 화면이 모를 수 있습니다. 그때 아무
    // 말도 안 하면 **추측한 화자가 확정처럼** 보입니다 — 그쪽이 훨씬
    // 위험하므로 모르는 것은 불확실 쪽으로 넘깁니다.
    strictEqual(speakerNote('diarization', 0.41)?.includes('확정하지 못했'), true);
    strictEqual(speakerNote('무언가_새로운_것', null)?.includes('확정하지 못했'), true);
  });
});

describe('evidenceView', () => {
  it('시각을 분:초로 준다', () => {
    strictEqual(evidenceView(utterance()).at, '0:32');
  });

  it('⭐ 이름이 없으면 지어내지 않는다', () => {
    // `사용자 #3` 같은 것도 안 씁니다 — 사람 이름처럼 읽힙니다.
    const view = evidenceView(utterance({ speaker_name: null, speaker_source: 'diarization' }));
    strictEqual(view.speaker, '화자 미확정');
    strictEqual(view.speaker.includes('#'), false);
  });

  it('확정 화자에는 꼬리표가 없다', () => {
    strictEqual(evidenceView(utterance()).speakerNote, null);
  });

  it('동시 발언을 표시로 남긴다', () => {
    strictEqual(evidenceView(utterance({ is_overlap: true })).overlap, true);
  });

  it('⭐ 무슨 발언인지 사람 말로 붙인다 — 규칙은 틀리고, 보여야 고쳐진다', () => {
    // 서버는 `utterance_type` 을 오래전부터 보내고 있었는데 화면이 안
    // 썼습니다(대표 실패 ①). 잘못 매겨진 라벨을 아무도 못 보면 영영
    // 안 고쳐집니다.
    strictEqual(evidenceView(utterance()).type, '결정');
    strictEqual(evidenceView(utterance({ utterance_type: 'objection' })).type, '반대 의견');
  });

  it('⭐ 아직 분류 전이면 **아무 말도 안 한다**', () => {
    // `기타` 라고 적으면 재고 나서 모르는 것처럼 보입니다 (불변식 3).
    strictEqual(evidenceView(utterance({ utterance_type: null })).type, null);
  });

  it('원문을 손대지 않는다', () => {
    const text = '  띄어쓰기가  이상해도   그대로  ';
    strictEqual(evidenceView(utterance({ text })).text, text);
  });
});

describe('missingNote', () => {
  it('다 받았으면 아무 말도 안 한다', () => {
    strictEqual(missingNote([5, 2], [utterance({ id: 5 }), utterance({ id: 2 })]), null);
  });

  it('⭐ 못 받은 것을 삼키지 않는다', () => {
    // 서버는 못 찾은 id 를 조용히 버립니다. 화면까지 삼키면 후보가
    // **남의 회의 발화**를 근거로 달고 있어도 근거가 하나 적은 것처럼
    // 보일 뿐입니다.
    const note = missingNote([5, 2, 9], [utterance({ id: 5 })]);
    strictEqual(note?.startsWith('2건은'), true, String(note));
    strictEqual(note?.includes('다른 회의'), true, String(note));
  });

  it('중복해서 물은 것을 두 번 세지 않는다', () => {
    strictEqual(missingNote([9, 9], []), '1건은 이 회의에서 찾지 못했습니다 — 다른 회의의 발화를 가리키고 있을 수 있습니다');
  });
});

describe('emptyEvidenceNote', () => {
  it('⭐ 근거가 애초에 없는 것과 못 찾은 것을 가른다', () => {
    // 앞은 이 후보가 환각일 수 있다는 뜻이고, 뒤는 목록이 낡았다는
    // 뜻입니다. 사람이 할 일이 다릅니다.
    strictEqual(emptyEvidenceNote([]).includes('회의에 없던 내용'), true);
    strictEqual(emptyEvidenceNote([5]).includes('새로 고쳐'), true);
  });
});

describe('withContext', () => {
  const all = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it('⭐ 근거 앞뒤 2건까지 딸려 온다 — 한 줄만 보면 합의인지 반문인지 모른다', () => {
    const picked = withContext(all, [5]);
    deepStrictEqual(picked.map((p) => p.id), [3, 4, 5, 6, 7]);
    deepStrictEqual(
      picked.filter((p) => p.isEvidence).map((p) => p.id),
      [5],
    );
  });

  it('⭐ 창이 겹치면 합친다 — 같은 발화를 두 번 그리지 않는다', () => {
    // 5 와 6 이 근거면 창은 3~7 과 4~8. 합쳐서 3~8, 여섯 건.
    const picked = withContext(all, [5, 6]);
    deepStrictEqual(picked.map((p) => p.id), [3, 4, 5, 6, 7, 8]);
    deepStrictEqual(
      picked.filter((p) => p.isEvidence).map((p) => p.id),
      [5, 6],
    );
  });

  it('목록 순서를 그대로 지킨다 — 근거를 뒤죽박죽 줘도', () => {
    // 시간축은 timeline.ts 가 정한다. 여기서 다시 정렬하면 두 벌이 된다.
    deepStrictEqual(withContext(all, [6, 2]).map((p) => p.id), [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('가장자리에서 넘어가지 않는다', () => {
    deepStrictEqual(withContext(all, [1]).map((p) => p.id), [1, 2, 3]);
    deepStrictEqual(withContext(all, [10]).map((p) => p.id), [8, 9, 10]);
  });

  it('⚠️ 목록에 없는 근거 id 는 조용히 건너뛴다 — missingNote 가 말한다', () => {
    // 지워진 발화·다른 회의의 id. 여기서 던지면 패널 전체가 빈다.
    deepStrictEqual(withContext(all, [999]).map((p) => p.id), []);
    deepStrictEqual(withContext(all, [999, 5]).map((p) => p.id), [3, 4, 5, 6, 7]);
  });

  it('span 0 이면 근거만', () => {
    deepStrictEqual(withContext(all, [5], 0).map((p) => p.id), [5]);
  });

  it('span 이 음수면 던진다 — 조용히 0 으로 만들지 않는다', () => {
    throws(() => withContext(all, [5], -1), RangeError);
  });

  it('근거가 없으면 빈 목록', () => {
    deepStrictEqual(withContext(all, []), []);
  });
});

describe('근거 칩을 접는 규칙 (UI 패스 v3)', () => {
  it('적으면 **그대로 다 보여 준다**', () => {
    for (const n of [0, 1, 3, EVIDENCE_CHIPS_SHOWN]) {
      const ids = Array.from({ length: n }, (_, i) => i);
      const { head, rest } = splitEvidenceChips(ids);
      strictEqual(head.length, n);
      strictEqual(rest.length, 0);
    }
  });

  it('⛔ 하나 남는 것을 「+1」로 접지 않는다 — 접는 쪽이 더 넓다', () => {
    const ids = Array.from({ length: EVIDENCE_CHIPS_SHOWN + 1 }, (_, i) => i);
    strictEqual(splitEvidenceChips(ids).rest.length, 0);
  });

  it('많으면 접되 **버리지 않는다**', () => {
    const ids = Array.from({ length: 12 }, (_, i) => i);
    const { head, rest } = splitEvidenceChips(ids);
    strictEqual(head.length, EVIDENCE_CHIPS_SHOWN);
    strictEqual(head.length + rest.length, ids.length);
    deepStrictEqual([...head, ...rest], ids);
  });
});
