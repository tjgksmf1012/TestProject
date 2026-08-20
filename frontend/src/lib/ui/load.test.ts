import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeLoadFailure } from './load.ts';

describe('describeLoadFailure', () => {
  it('⭐ **403 과 404 를 같은 말로 덮지 않는다** — 사람이 할 일이 다르다', () => {
    strictEqual(describeLoadFailure('프로젝트', 403), '이 프로젝트를 볼 권한이 없습니다.');
    strictEqual(
      describeLoadFailure('프로젝트', 404),
      '이 프로젝트를 찾을 수 없습니다. 주소가 맞는지 확인해 주세요.',
    );
  });

  it('⭐ 네트워크가 끊긴 것(`null`)만 네트워크 탓을 한다', () => {
    // 기여도 화면은 무슨 일이 있었든 "네트워크를 확인한 뒤 새로고침하세요"
    // 라고 했습니다 — 없는 프로젝트를 열어도. 네트워크는 멀쩡한데 사람은
    // 와이파이를 껐다 켭니다.
    strictEqual(
      describeLoadFailure('기여도', null),
      '서버에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 시도하세요.',
    );
    strictEqual(describeLoadFailure('기여도', 0), describeLoadFailure('기여도', null));
    strictEqual(describeLoadFailure('기여도', 404).includes('네트워크'), false);
  });

  it('로그인이 풀린 것은 그렇게 말한다', () => {
    strictEqual(describeLoadFailure('회의', 401), '로그인이 풀렸습니다. 다시 로그인해 주세요.');
  });

  it('서버 잘못은 사람 탓으로 읽히지 않게', () => {
    strictEqual(describeLoadFailure('칸반', 500), '서버에 문제가 있습니다. 잠시 뒤 다시 시도하세요.');
    strictEqual(describeLoadFailure('칸반', 503), describeLoadFailure('칸반', 500));
  });

  it('⚠️ 조사를 앞말에 맞춰 붙인다 — 받침에 따라 을/를', () => {
    // 받침 있음 → 을, 없음 → 를. 손으로 `를` 을 박으면 "회의록을" 이
    // "회의록를" 이 됩니다.
    strictEqual(describeLoadFailure('회의록', 404).startsWith('이 회의록을'), true);
    strictEqual(describeLoadFailure('기여도', 404).startsWith('이 기여도를'), true);
  });

  it('모르는 상태는 숨기지 않는다 — 제보할 때 쓸 유일한 단서', () => {
    strictEqual(describeLoadFailure('설정', 418), '설정을 불러오지 못했습니다 (HTTP 418).');
  });
});
