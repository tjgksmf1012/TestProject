import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assignableRoles,
  canChangeRoleOf,
  canManage,
  manageBlockedBecause,
  canRemove,
  deleteTaskConfirm,
  LEAVE_CONFIRM,
  leaveBlockedBecause,
  roleChoicesFor,
  roleLabel,
} from './roles.ts';

describe('이름', () => {
  it('사람 말로 부른다', () => {
    strictEqual(roleLabel('owner'), '소유자');
    strictEqual(roleLabel('admin'), '관리자');
    strictEqual(roleLabel('member'), '팀원');
  });

  it('⭐ 모르는 값을 **지어내지 않는다**', () => {
    // 빈 칸으로 두면 화면에 아무 말도 없는 자리가 생깁니다.
    strictEqual(roleLabel('superuser'), 'superuser');
    strictEqual(roleLabel(null), '');
  });
});

describe('무엇을 보여 줄 것인가', () => {
  it('팀원에게는 관리 버튼을 안 보여 준다', () => {
    strictEqual(canManage('member'), false);
    strictEqual(canManage('admin'), true);
    strictEqual(canManage('owner'), true);
  });

  it('⭐ 모르는 값은 **제일 낮게** 본다', () => {
    // 관대하게 보면 못 누르는 버튼이 생기고, 누르면 403 이 뜹니다 —
    // 사람에게는 그게 "고장" 으로 읽힙니다.
    strictEqual(canManage('superuser'), false);
    strictEqual(canManage(null), false);
    strictEqual(canManage(undefined), false);
  });
});

describe('⭐ 권한 바꾸기', () => {
  it('자기 자신은 못 바꾼다', () => {
    strictEqual(canChangeRoleOf('owner', 'owner', { isMe: true }), false);
    strictEqual(canChangeRoleOf('admin', 'admin', { isMe: true }), false);
  });

  it('⭐ 같은 등급끼리도 못 바꾼다', () => {
    // 관리자 둘이 서로를 강등할 수 있으면 먼저 누른 쪽이 이기는 경주가
    // 되고, 소유자가 잠든 사이에 팀이 뒤집힙니다.
    strictEqual(canChangeRoleOf('admin', 'admin', { isMe: false }), false);
  });

  it('위에서 아래로만 된다', () => {
    strictEqual(canChangeRoleOf('owner', 'admin', { isMe: false }), true);
    strictEqual(canChangeRoleOf('admin', 'member', { isMe: false }), true);
    strictEqual(canChangeRoleOf('member', 'admin', { isMe: false }), false);
  });

  it('⭐ 자기 등급 이상은 **줄 수 없다**', () => {
    // 안 막으면 관리자가 팀원을 소유자로 만들어 놓고 그 사람을 통해
    // 자기를 올릴 수 있습니다.
    deepStrictEqual(assignableRoles('admin'), ['member']);
    deepStrictEqual(assignableRoles('owner'), ['admin', 'member']);
    deepStrictEqual(assignableRoles('member'), []);
  });

  it('내보내기도 같은 규칙', () => {
    strictEqual(canRemove('owner', 'admin', { isMe: false }), true);
    strictEqual(canRemove('admin', 'admin', { isMe: false }), false);
    strictEqual(canRemove('owner', 'owner', { isMe: true }), false);
  });
});

describe('⭐ 나가기', () => {
  it('보통은 막지 않는다', () => {
    strictEqual(leaveBlockedBecause('member', ['owner', 'member']), null);
    strictEqual(leaveBlockedBecause('admin', ['owner', 'admin']), null);
  });

  it('⭐ 마지막 소유자는 막는다', () => {
    // 나가면 아무도 팀원을 못 다루는 프로젝트가 남고, 되돌릴 화면이
    // 없습니다.
    const why = leaveBlockedBecause('owner', ['owner', 'member']);
    strictEqual(why !== null, true);
    strictEqual((why as string).includes('마지막 소유자'), true);
  });

  it('소유자가 둘이면 나갈 수 있다', () => {
    strictEqual(leaveBlockedBecause('owner', ['owner', 'owner']), null);
  });

  it('⭐ 한 일이 남는다고 **먼저 말한다**', () => {
    // 안 적으면 사람은 나가면 자기 기록도 지워진다고 믿거나, 반대로
    // 지워질까 봐 못 나갑니다.
    strictEqual(LEAVE_CONFIRM.includes('그대로 남습니다'), true);
  });
});

describe('업무 삭제 확인', () => {
  it('되돌릴 수 없다고 먼저 말한다', () => {
    strictEqual(deleteTaskConfirm('배포 스크립트').includes('되돌릴 수 없습니다'), true);
  });

  it('⭐ `을(를)` 이라고 적지 않는다 (결함 76)', () => {
    // 받침을 보고 고릅니다. `은(는)` 은 미완성 소프트웨어로 읽힙니다.
    strictEqual(deleteTaskConfirm('배포').startsWith('배포를 '), true);
    strictEqual(deleteTaskConfirm('문서 정리').startsWith('문서 정리를 '), true);
    strictEqual(deleteTaskConfirm('로그인 화면').startsWith('로그인 화면을 '), true);
    strictEqual(deleteTaskConfirm('배포').includes('(를)'), false);
  });
});


describe('결함 254 — 모르는 것을 「권한 없음」이라고 단언하던 자리', () => {
  it('⭐ **아직 모르면** 없다고 하지 않는다', () => {
    // 명단이 오기 전 몇 초 동안 **소유자에게** 「팀의 관리자에게 요청
    // 하세요」라고 말했습니다. 재현했습니다 — `/members` 를 4초 늦추고
    // 설정 화면을 여니 그 문장이 떠 있었습니다.
    const said = manageBlockedBecause(undefined, '저장소 연결');
    strictEqual(said?.includes('관리자에게 요청'), false, said ?? '');
    strictEqual(said?.includes('아직'), true, said ?? '');
  });

  it('⭐ **명단에 없는 것이 확실하면** 그대로 말한다', () => {
    // 반대 방향입니다. 이걸 안 보면 전부 「확인하는 중」으로 덮어도
    // 검사가 통과합니다.
    const said = manageBlockedBecause(null, '저장소 연결');
    strictEqual(said?.includes('관리자에게 요청'), true, said ?? '');
    strictEqual(manageBlockedBecause('member', '저장소 연결')?.includes('관리자에게 요청'), true);
  });

  it('⚠️ 말이 바뀌어도 **잠그는 것은 그대로** — 모르면 잠급니다', () => {
    strictEqual(canManage(undefined), false);
    strictEqual(canManage(null), false);
    strictEqual(manageBlockedBecause(undefined, '저장소 연결') === null, false);
    // 관리자·소유자는 그대로 열립니다.
    strictEqual(manageBlockedBecause('owner', '저장소 연결'), null);
    strictEqual(manageBlockedBecause('admin', '저장소 연결'), null);
  });
});

describe('⭐ 고를 것이 없으면 고르라고 하지 않는다 (결함 362)', () => {
  /* `assignableRoles('admin')` 은 `['member']` 하나입니다. 관리자가
     팀원을 볼 때 그것을 그대로 select 에 넣으면 **지금 등급 하나뿐인
     선택지**가 나가고, 눌러도 아무 일도 일어나지 않습니다.

     실제로 두 뿌리 다 그랬고, 관리자가 제품 전체에서 보는 select 는
     그것 하나였습니다 — 즉 관습이 아니라 저 혼자 예외였습니다. */

  it('관리자가 팀원을 볼 때는 고를 것이 없다', () => {
    deepStrictEqual(roleChoicesFor('admin', 'member', { isMe: false }), []);
  });

  it('소유자는 팀원에게 관리자를 줄 수 있다', () => {
    deepStrictEqual(roleChoicesFor('owner', 'member', { isMe: false }), ['admin', 'member']);
  });

  it('소유자가 관리자를 볼 때도 고를 것이 있다 (팀원으로 강등)', () => {
    deepStrictEqual(roleChoicesFor('owner', 'admin', { isMe: false }), ['admin', 'member']);
  });

  it('나 자신은 못 바꾼다', () => {
    deepStrictEqual(roleChoicesFor('owner', 'owner', { isMe: true }), []);
  });

  it('팀원은 아무에게도 못 준다', () => {
    deepStrictEqual(roleChoicesFor('member', 'member', { isMe: false }), []);
  });

  it('⭐ 돌려준 목록에는 **지금 등급과 다른 것**이 반드시 있다', () => {
    /* 이것이 요구입니다 — 낱말이 아니라. 어떤 (내 등급 · 상대 등급)
       조합이 와도, 목록이 비어 있지 않다면 그 안에 지금 등급이 아닌
       것이 하나는 있어야 합니다. 아니면 그 select 는 아무것도 못 합니다. */
    const roles = ['owner', 'admin', 'member', null, 'nonsense'];
    for (const mine of roles) {
      for (const theirs of roles) {
        for (const isMe of [true, false]) {
          const choices = roleChoicesFor(mine, theirs, { isMe });
          if (choices.length === 0) continue;
          ok(
            choices.some((r) => r !== theirs),
            `(${String(mine)} → ${String(theirs)}, isMe=${isMe}) 선택지가 지금 등급뿐입니다: ${JSON.stringify(choices)}`,
          );
        }
      }
    }
  });
});
