import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeActionFailure, describeLoadFailure } from './load.ts';

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

describe('보냈는데 안 됐을 때 (결함 218)', () => {
  it('⭐ 무슨 일이 있었는지 **말한다** — 예전에는 한 글자도 안 바뀌었다', () => {
    // 「검토 끝내기」가 500 을 받아도 화면 글자가 한 글자도 안 바뀌었고
    // 버튼은 다시 눌리는 상태로 돌아갔습니다. 사람은 확정된 줄 압니다.
    strictEqual(
      describeActionFailure('검토 확정', 500),
      '검토 확정을 처리하지 못했습니다. 잠시 뒤 다시 시도하세요.',
    );
  });

  it('⛔ 닿았는지 모를 때 「안 됐다」 고 단언하지 않는다', () => {
    // 요청이 서버에 닿은 뒤 답만 못 받았을 수도 있습니다. 두 번 하면
    // 안 되는 일(확정·삭제)에서 "실패했으니 다시" 는 위험합니다.
    const text = describeActionFailure('검토 확정', null);
    strictEqual(/처리됐는지 보세요/.test(text), true);
    strictEqual(/실패했습니다/.test(text), false);
  });

  it('⛔ 다시 눌러도 안 되는 실패에 「다시 시도하세요」 를 붙이지 않는다', () => {
    // 되지 않는 것을 반복하다 사람은 제품을 불신하게 됩니다.
    for (const status of [403, 404, 409]) {
      strictEqual(
        /다시 시도하세요/.test(describeActionFailure('검토 확정', status)),
        false,
        `HTTP ${status} 에 다시 시도하라고 합니다`,
      );
    }
  });

  it('⚠️ 같은 코드라도 **불러오기와 할 일이 다르다**', () => {
    // 못 불러온 화면의 404 는 "주소를 고쳐라", 보낸 뒤의 404 는
    // "정하는 사이에 없어졌다" 입니다.
    const load = describeLoadFailure('업무', 404);
    const action = describeActionFailure('업무 옮기기', 404);
    strictEqual(load === action, false);
    strictEqual(/주소가 맞는지/.test(load), true);
    strictEqual(/새로고침/.test(action), true);
  });

  it('409 는 **여기서만** 뜻이 있다 — 남이 먼저 했다', () => {
    strictEqual(/다른 사람이 먼저/.test(describeActionFailure('업무 옮기기', 409)), true);
  });

  it('⚠️ 조사를 앞말에 맞춰 붙인다', () => {
    strictEqual(describeActionFailure('회의 강제 종료', 500).startsWith('회의 강제 종료를'), true);
    strictEqual(describeActionFailure('백필', 500).startsWith('백필을'), true);
  });

  it('모르는 상태는 숨기지 않는다', () => {
    strictEqual(describeActionFailure('확정', 418), '확정을 처리하지 못했습니다 (HTTP 418).');
  });
});
