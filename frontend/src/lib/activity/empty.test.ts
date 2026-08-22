import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeEmptyActivity } from './empty.ts';

describe('활동 기록이 비었을 때 (결함 304)', () => {
  it('⭐ **「아무도 안 바꿨다」고 단언하지 않는다**', () => {
    const { why } = describeEmptyActivity();
    /* 화면은 자기 목록이 빈 것만 확인해 놓고 팀 전체가 아무것도 안 했다고
       말하고 있었습니다. 같은 순간 회의 다섯·업무 넷·기여도 근거가
       있었습니다. */
    strictEqual(/아무도 안 바[꿨꾼]/.test(why), false);
    strictEqual(/아무 일도 없/.test(why), false);
  });

  it('⭐ **이 기록이 무엇을 받는지** 말한다 — 바쁜 팀도 비어 있을 수 있습니다', () => {
    const { why } = describeEmptyActivity();
    strictEqual(why.includes('사람이 손으로 내린 결정'), true);
    // 회의·녹음은 여기 안 남는다는 것이 이 화면의 놀라움을 푸는 열쇠입니다.
    strictEqual(/회의/.test(why), true);
  });

  it('⭐ **범위를 좁혀 말하지 않는다** — 「숫자」는 열넷 중 둘뿐이었습니다', () => {
    /* 이 결함을 고치면서 「사람의 **숫자**를 건드린 일만 쌓입니다」라고 썼는데,
       서버가 쓰는 열네 갈래 중 숫자를 건드리는 것은 `score_adjusted`·
       `weights_changed` 둘뿐입니다. 업무를 완료로 옮긴 사람은 그 문장을 읽고
       또 한 번 거짓말을 들었을 것입니다. */
    const { why } = describeEmptyActivity();
    strictEqual(/숫자를 건드린/.test(why), false);
    // 업무 갈래(여섯)가 이 기록의 절반입니다 — 이름이 나와야 합니다.
    strictEqual(why.includes('업무'), true);
  });

  it('무엇을 하면 남는지 말한다 — 알려만 주고 갈 곳을 안 주지 않습니다', () => {
    const { how } = describeEmptyActivity();
    // 어느 화면에서 무엇을 누르는지까지 말합니다 (실패 ③).
    strictEqual(/칸반|검토/.test(how), true);
    strictEqual(how.includes('업무 후보'), true);
  });
});
