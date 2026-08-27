import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { authGate, describeActionFailure, describeLoadFailure,
  sessionIsOver,
} from './load.ts';

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

  /* ⚠️ **여기 있던 검사를 바꿨습니다** (결함 300).

     예전에는 「409 는 여기서만 뜻이 있다 — **남이 먼저 했다**」였고,
     `/다른 사람이 먼저/` 를 못 박고 있었습니다. 그런데 이 제품이 실제로
     내보내는 409 를 **전부 세어 보니 다섯인데 하나도 그 뜻이 아닙니다** —

         다른 프로젝트가 이미 이 저장소를 쓰고 있습니다
         저장소가 연결되지 않았습니다. 먼저 owner/repo를 저장하세요.
         서버에 GitHub App 자격 증명이 없거나 App이 아직 …
         처리에 실패했거나 큐에 걸린 회의만 다시 처리할 수 있습니다
         확정할 기여도가 없습니다. 활동 기록이 하나도 없습니다

     전부 **조건이 안 맞는다**이고 새로고침해도 영원히 그대로입니다.
     검사가 못 박고 있던 것은 근거를 적어 둔 결정이 아니라 **틀린 가정**
     이었습니다. 지키려던 것(409 는 일반론으로 때우지 않는다)은 아래
     둘이 그대로 잽니다. */
  it('⭐ 409 는 **서버가 쓴 문장**을 그대로 보여 준다 (결함 300)', () => {
    const said = '서버에 GitHub App 자격 증명이 없거나 App이 아직 이 저장소에 설치되지 않았습니다.';
    strictEqual(describeActionFailure('지난 활동 가져오기', 409, said), said);
  });

  it('⚠️ 409 에서 **없는 사람을 지어내지 않는다**', () => {
    const generic = describeActionFailure('업무 옮기기', 409);
    strictEqual(/다른 사람이 먼저/.test(generic), false);
    // 다시 눌러도 안 되는 실패에 「다시」 를 붙이지 않습니다 (`load.ts` 머리말).
    strictEqual(/다시|새로고침/.test(generic), false);
    strictEqual(generic, '지금 상태에서는 업무 옮기기를 할 수 없습니다.');
  });

  it('⚠️ 빈 문장은 문장이 아니다 — 일반론으로 돌아갑니다', () => {
    strictEqual(describeActionFailure('업무 옮기기', 409, '   '), '지금 상태에서는 업무 옮기기를 할 수 없습니다.');
    strictEqual(describeActionFailure('업무 옮기기', 409, null), '지금 상태에서는 업무 옮기기를 할 수 없습니다.');
  });

  it('⚠️ 다른 상태 코드는 서버 문장에 안 흔들린다 — 문구가 한 벌이어야 합니다', () => {
    // 500 의 서버 문장은 사람에게 쓴 것이 아닙니다 (스택·내부 이름).
    strictEqual(
      describeActionFailure('검토 확정', 500, 'IntegrityError: UNIQUE constraint failed'),
      describeActionFailure('검토 확정', 500),
    );
  });

  it('⚠️ 조사를 앞말에 맞춰 붙인다', () => {
    strictEqual(describeActionFailure('회의 강제 종료', 500).startsWith('회의 강제 종료를'), true);
    strictEqual(describeActionFailure('백필', 500).startsWith('백필을'), true);
  });

  it('모르는 상태는 숨기지 않는다', () => {
    strictEqual(describeActionFailure('확정', 418), '확정을 처리하지 못했습니다 (HTTP 418).');
  });
});

describe('⛔ 세션이 끝났는지 (결함 227)', () => {
  it('⭐ 401 은 세션이 끝난 것이다 — 앱이 사람을 로그인 화면으로 보내야 한다', () => {
    // 안 보내면 「다시 로그인해 주세요」 라고 말해 놓고 로그인할 자리를
    // 안 주는 것이 됩니다. 실제로 스무 바퀴를 돌아도 못 나갔습니다.
    strictEqual(sessionIsOver(401), true);
  });

  it('⛔ 403 은 **아니다** — 멀쩡한 세션을 끊는 것이 된다', () => {
    // "로그인은 됐는데 이 일은 못 한다" 입니다. 내보내면 할 수 있는 다른
    // 일까지 같이 뺏습니다.
    strictEqual(sessionIsOver(403), false);
  });

  it('네트워크가 끊긴 것(null·0)은 세션과 무관하다', () => {
    strictEqual(sessionIsOver(null), false);
    strictEqual(sessionIsOver(0), false);
  });

  it('나머지 실패도 세션을 안 끊는다', () => {
    for (const s of [404, 409, 422, 500, 503]) strictEqual(sessionIsOver(s), false, String(s));
  });
});

describe('authGate — 못 물어본 것과 로그아웃을 가른다 (결함 282)', () => {
  it('⭐ **못 닿은 것을 「로그아웃」이라고 하지 않는다**', () => {
    /* 연결을 끊고 `/app/` 을 다시 열어 재현했습니다 — 세션 쿠키는
       멀쩡한데 화면이 로그인으로 갔습니다. 거기서 비밀번호를 쳐도
       같은 네트워크라 또 실패합니다. */
    strictEqual(authGate(false, undefined, true), 'unreachable');
  });

  it('서버가 401 로 **답한** 것은 정말 로그아웃이다', () => {
    // `useMe` 가 401 을 `null` 로 접습니다 — 「로그인 전」은 오류가 아닙니다.
    strictEqual(authGate(false, null, false), 'out');
  });

  it('사람이 있으면 들여보낸다', () => {
    strictEqual(authGate(false, { user_id: 1 }, false), 'in');
  });

  it('⚠️ 아직 도는 중인 것을 「못 닿았다」로 읽지 않는다', () => {
    // 느린 회선에서 멀쩡한 앱이 오류 화면부터 보여 주면 안 됩니다.
    strictEqual(authGate(true, undefined, false), 'checking');
    strictEqual(authGate(true, undefined, true), 'checking');
    // 실패로 끝나지 **않았는데** 값이 없는 잠깐도 아직 확인 중입니다.
    strictEqual(authGate(false, undefined, false), 'checking');
  });

  it('⛔ 못 닿은 것과 로그아웃은 **다른 값**이다 — 한 값으로 묶으면 결함 282 다', () => {
    const 끊김 = authGate(false, undefined, true);
    const 로그아웃 = authGate(false, null, false);
    strictEqual(끊김 === 로그아웃, false);
  });
});
