import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { presenceDot, presenceLabel, worthShowing } from './presence.ts';

describe('상태 이름', () => {
  it('사람 말로 부른다', () => {
    strictEqual(presenceLabel('online'), '접속 중');
    strictEqual(presenceLabel('away'), '자리 비움');
    strictEqual(presenceLabel('in_meeting'), '회의 중');
    strictEqual(presenceLabel('offline'), '오프라인');
  });

  it('⭐ 모르는 값을 **지어내지 않는다**', () => {
    strictEqual(presenceLabel('busy'), '');
    strictEqual(presenceLabel(null), '');
  });
});

describe('⭐ 근태 표시가 되지 않게', () => {
  it('오프라인은 안 그린다', () => {
    // 팀 대부분이 오프라인인 것이 보통입니다. 다 그리면 목록이 회색
    // 점으로 덮이고, "누가 없는지" 를 한눈에 세게 만듭니다.
    strictEqual(worthShowing('offline'), false);
    strictEqual(worthShowing(null), false);
    strictEqual(worthShowing('online'), true);
    strictEqual(worthShowing('away'), true);
    strictEqual(worthShowing('in_meeting'), true);
  });

  it('⭐ 오프라인에 **빨간 표시를 안 붙인다**', () => {
    // 이 저장소에서 빨강은 "네가 뭘 잘못했다" 이고, 자리에 없는 것은
    // 잘못이 아닙니다. 클래스 자체를 안 줍니다.
    strictEqual(presenceDot('offline'), '');
    strictEqual(presenceDot(null), '');
  });

  it('붙어 있는 것과 자리 비움을 가른다', () => {
    strictEqual(presenceDot('online'), 'here');
    strictEqual(presenceDot('in_meeting'), 'here');
    strictEqual(presenceDot('away'), 'away');
  });
});
