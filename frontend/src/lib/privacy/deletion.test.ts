import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  confirmPrompt,
  describeFreed,
  describeOutcome,
  describeRequestFailure,
  whatGetsDeleted,
  whatHappensToMyScore,
  whatRemains,
  type RevokeResult,
} from './deletion.ts';

function result(over: Partial<RevokeResult> = {}): RevokeResult {
  return {
    deleted_assets: 2,
    revoked_voiceprints: 1,
    freed_bytes: 3 * 1024 * 1024,
    failed: {},
    kept: [],
    message: '',
    ...over,
  };
}

describe('누르기 전에 말하는 것', () => {
  it('지워지는 것과 남는 것을 둘 다 말한다', () => {
    strictEqual(whatGetsDeleted().length > 0, true);
    strictEqual(whatRemains().length > 0, true);
  });

  it('⭐ 남는 것에 회의록이 들어 있다 — 다른 사람의 기록이기도 하다', () => {
    strictEqual(whatRemains().some((line) => line.includes('발화 텍스트')), true);
  });

  it('⭐ 성문을 빠뜨리지 않는다 — 가장 민감한 데이터다', () => {
    strictEqual(whatGetsDeleted().some((line) => line.includes('성문')), true);
  });
});

describe('whatHappensToMyScore', () => {
  it('⭐ 기여도에 무슨 일이 일어나는지 **미리** 말한다', () => {
    // 안 말하면 나중에 기여도 화면에서 "측정하지 못했습니다" 를 보고
    // 놀라게 된다.
    strictEqual(whatHappensToMyScore().includes('측정 불가'), true);
  });

  it('⭐ 0점이 된다고 쓰지 않는다', () => {
    // 사실이 아니고, 사람을 겁줘서 권리 행사를 막는 것이다.
    const text = whatHappensToMyScore();
    strictEqual(text.includes('0점이 되는 것은 아니'), true);
    strictEqual(/0점이 됩니다|0점으로/.test(text), false, text);
  });

  it('이미 처리된 회의는 그대로라는 것도 말한다', () => {
    strictEqual(whatHappensToMyScore().includes('그대로 계산'), true);
  });
});

describe('confirmPrompt', () => {
  it('⭐ 되돌릴 수 없다는 것을 마지막에 한 번 더 말한다', () => {
    strictEqual(confirmPrompt().includes('되돌릴 수 없'), true);
  });

  it('무엇이 남는지도 말한다 — 다 지워진다고 오해하면 안 된다', () => {
    strictEqual(confirmPrompt().includes('남습니다'), true);
  });
});

describe('describeFreed', () => {
  it('0 은 "없음" 이라고 쓴다 — 0.0MB 는 사람이 읽는 말이 아니다', () => {
    strictEqual(describeFreed(0), '없음');
    strictEqual(describeFreed(-1), '없음');
  });

  it('크기에 맞는 단위를 쓴다', () => {
    strictEqual(describeFreed(500), '500바이트');
    strictEqual(describeFreed(2048), '2KB');
    strictEqual(describeFreed(3 * 1024 * 1024), '3.0MB');
  });
});

describe('describeOutcome', () => {
  it('지웠으면 무엇을 얼마나 지웠는지 말한다', () => {
    const outcome = describeOutcome(result());
    strictEqual(outcome.deletedSomething, true);
    strictEqual(outcome.needsRetry, false);
    strictEqual(outcome.text.includes('녹음 원본 2건'), true);
    strictEqual(outcome.text.includes('성문 1건'), true);
    strictEqual(outcome.text.includes('3.0MB'), true);
  });

  it('⭐ 0건을 성공으로만 답하지 않는다', () => {
    // "지울 녹음이 없습니다" 와 "지웠습니다" 는 완전히 다른 사실이다.
    const outcome = describeOutcome(
      result({ deleted_assets: 0, revoked_voiceprints: 0, freed_bytes: 0 }),
    );
    strictEqual(outcome.deletedSomething, false);
    strictEqual(outcome.text.includes('없습니다'), true);
    strictEqual(outcome.text.includes('지웠습니다'), false);
  });

  it('⭐ 일부 실패를 성공으로 뭉뚱그리지 않는다', () => {
    // 다섯 중 셋만 지워졌는데 "지웠습니다" 라고 하면 사람은 남은 둘이
    // 있다는 걸 영영 모른다.
    const outcome = describeOutcome(
      result({ deleted_assets: 3, failed: { 4: '권한 없음', 5: '경로 오류' } }),
    );
    strictEqual(outcome.needsRetry, true);
    strictEqual(outcome.text.includes('2건을 지우지 못했습니다'), true);
    strictEqual(outcome.text.includes('다시 시도'), true);
  });

  it('성문만 지워진 경우도 말이 된다', () => {
    const outcome = describeOutcome(
      result({ deleted_assets: 0, revoked_voiceprints: 2, freed_bytes: 0 }),
    );
    strictEqual(outcome.deletedSomething, true);
    strictEqual(outcome.text.includes('성문 2건'), true);
    strictEqual(outcome.text.includes('녹음 원본'), false);
  });

  it('failed 가 없어도 터지지 않는다', () => {
    const outcome = describeOutcome({ ...result(), failed: undefined as never });
    strictEqual(outcome.needsRetry, false);
  });
});

describe('describeRequestFailure', () => {
  it('⭐ 아무것도 안 지워졌다는 것을 말한다', () => {
    // 조용히 넘어가면 사람은 지워진 줄 안다. 이 화면에서 가장 나쁜 실패다.
    strictEqual(describeRequestFailure(0).includes('아무것도 지워지지 않았'), true);
    strictEqual(describeRequestFailure(500).includes('아무것도 지워지지 않았'), true);
  });

  it('401 은 로그인을 말한다 — 다시 눌러 봐야 똑같다', () => {
    strictEqual(describeRequestFailure(401).includes('로그인'), true);
  });

  it('403 은 구성원이 아니라고 말한다', () => {
    strictEqual(describeRequestFailure(403).includes('구성원'), true);
  });

  it('서버가 준 문구를 우선한다', () => {
    strictEqual(describeRequestFailure(400, '이상한 요청').includes('이상한 요청'), true);
  });

  it('모르는 상태 코드도 삼키지 않는다', () => {
    strictEqual(describeRequestFailure(418).includes('418'), true);
  });
});
