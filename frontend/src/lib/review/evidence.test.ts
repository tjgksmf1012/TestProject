import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  emptyEvidenceNote,
  evidenceQuery,
  evidenceView,
  missingNote,
  speakerNote,
  type Utterance,
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
