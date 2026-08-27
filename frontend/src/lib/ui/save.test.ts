import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { whyCannotSave } from './save.ts';

describe('⛔ 「저장」이 안 되는 이유 (결함 234)', () => {
  it('⭐ 아무 문제가 없으면 `null` — 그때만 눌립니다', () => {
    strictEqual(whyCannotSave({ dirty: true }), null);
    strictEqual(whyCannotSave({ problem: null, noPermission: null, dirty: true, saving: false }), null);
  });

  it('⛔ **권한이 맨 앞이다** — 고쳐도 안 되는 일을 시키지 않는다', () => {
    // 권한이 없는 사람에게 「합이 1 이어야 합니다」라고 하면, 고쳐 봐야
    // 서버가 403 을 줍니다.
    const why = whyCannotSave({
      noPermission: '이름 바꾸기는 관리자와 소유자만 할 수 있습니다',
      problem: '합이 1 이어야 합니다 (지금 0.5)',
      dirty: true,
    });
    strictEqual(why?.includes('관리자'), true, why ?? '');
    strictEqual(why?.includes('합이 1'), false, why ?? '');
  });

  it('⭐ 값에 문제가 있으면 **그것**을 말한다 — 「바꾼 것이 없습니다」가 아니라', () => {
    const why = whyCannotSave({ problem: '합이 1 이어야 합니다 (지금 0.5)', dirty: false });
    strictEqual(why, '합이 1 이어야 합니다 (지금 0.5)');
  });

  it('⭐ 안 바꿨으면 그렇게 말한다 — 빈 이유로 두지 않는다', () => {
    strictEqual(whyCannotSave({ dirty: false }), '바꾼 것이 없습니다');
  });

  it('⭐ 보내는 중이면 그렇게 말한다', () => {
    strictEqual(whyCannotSave({ dirty: true, saving: true }), '저장하는 중입니다');
  });

  it('⚠️ 빈 문자열은 **이유가 아니다** — 빈 말풍선을 만들지 않는다', () => {
    strictEqual(whyCannotSave({ noPermission: '', problem: '', dirty: true }), null);
  });
});
