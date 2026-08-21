import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CODE_LENGTH,
  NO_CODE,
  codeProblem,
  codeToCopy,
  disconnectConfirm,
  isDisconnect,
  formatCode,
  nextStepAfterCreate,
  normalizeCode,
  normalizeRepo,
  repoProblem,
  titleProblem,
  githubLoginStatus,
} from './setup.ts';

describe('normalizeCode', () => {
  it('⭐ 화면이 하이픈을 보여주므로 사람은 하이픈을 친다', () => {
    // 그걸 "틀린 코드" 로 처리하면 맞는 코드를 들고도 못 들어온다.
    strictEqual(normalizeCode('ABCD-EFGH'), 'ABCDEFGH');
  });

  it('카톡에서 복사하면 붙는 공백을 걷어낸다', () => {
    strictEqual(normalizeCode('  abcd efgh \n'), 'ABCDEFGH');
  });

  it('대문자로 올린다', () => {
    strictEqual(normalizeCode('abcdefgh'), 'ABCDEFGH');
  });
});

describe('formatCode', () => {
  it('네 글자마다 끊는다 — 여덟을 한 번에 읽으면 틀린다', () => {
    strictEqual(formatCode('ABCDEFGH'), 'ABCD-EFGH');
  });

  it('길이가 안 맞으면 꾸미지 않는다 — 꾸미면 원인을 못 본다', () => {
    strictEqual(formatCode('ABC'), 'ABC');
  });
});

describe('codeProblem', () => {
  it('맞는 코드는 통과', () => {
    strictEqual(codeProblem('ABCD-EFGH'), null);
    strictEqual(codeProblem('23456789'), null);
  });

  it('빈 칸을 잡는다', () => {
    strictEqual(codeProblem('   '), '초대 코드를 입력하세요');
  });

  it('⭐ 길이가 틀리면 지금 몇 자인지 말한다', () => {
    // "형식이 틀렸습니다" 만으로는 무엇을 고쳐야 할지 알 수 없다.
    const problem = codeProblem('ABCDEFG');
    strictEqual(problem?.includes('7자'), true);
    strictEqual(problem?.includes(String(CODE_LENGTH)), true);
  });

  it('⭐ 쓰지 않는 글자를 **어떤 글자인지** 말한다', () => {
    const problem = codeProblem('ABCDEFG0');
    strictEqual(problem?.includes('0'), true);
    // 왜 그 글자가 없는지도 말한다 — 사람은 대개 O 와 헷갈린 것이다.
    strictEqual(problem?.includes('0·O·1·I·L'), true);
  });

  it('같은 글자가 여러 번 틀려도 한 번만 말한다', () => {
    const problem = codeProblem('OOOOOOOO');
    strictEqual((problem?.match(/O/g) ?? []).length, 2); // 목록 1 + 설명 1
  });
});

describe('titleProblem', () => {
  it('이름이 있으면 통과', () => {
    strictEqual(titleProblem('졸업작품'), null);
  });

  it('공백만 넣은 것은 빈 것이다', () => {
    strictEqual(titleProblem('   '), '프로젝트 이름을 입력하세요');
  });

  it('너무 길면 잡는다 — 서버 한계와 같은 숫자로', () => {
    strictEqual(titleProblem('가'.repeat(201))?.includes('200자'), true);
  });
});

describe('normalizeRepo', () => {
  it('⭐ 주소를 붙여넣어도 고쳐 준다', () => {
    // 웹훅은 `repository.full_name` 으로 프로젝트를 찾는다. 주소 전체를
    // 넣으면 웹훅이 영원히 못 찾고, 오류도 안 나고 기여도만 빈다.
    for (const raw of [
      'https://github.com/team/teamflow',
      'http://github.com/team/teamflow',
      'https://www.github.com/team/teamflow',
      'https://github.com/team/teamflow.git',
      'https://github.com/team/teamflow/',
      'git@github.com:team/teamflow.git',
      '  team/teamflow  ',
    ]) {
      strictEqual(normalizeRepo(raw), 'team/teamflow', raw);
    }
  });

  it('빈 값은 빈 값 — 연결 끊기다', () => {
    strictEqual(normalizeRepo('   '), '');
  });
});

describe('repoProblem', () => {
  it('owner/repo 는 통과', () => {
    strictEqual(repoProblem('team/teamflow'), null);
  });

  it('주소를 넣어도 통과한다 — 고쳐서 보내기 때문', () => {
    strictEqual(repoProblem('https://github.com/team/teamflow'), null);
  });

  it('⭐ 비우는 건 오류가 아니다 — 연결 끊기다', () => {
    strictEqual(repoProblem(''), null);
    strictEqual(repoProblem('   '), null);
  });

  it('고칠 수 없는 것은 거절한다', () => {
    for (const raw of ['teamflow', 'team/', '/teamflow', 'team/repo/extra']) {
      strictEqual(repoProblem(raw) !== null, true, raw);
    }
  });
});

describe('nextStepAfterCreate', () => {
  it('⭐ 혼자면 회의를 열라고 하지 않는다', () => {
    // 혼자 회의를 열면 동의도 혼자 하고 녹음도 혼자 한다 —
    // 그건 이 시스템이 하려는 일이 아니다.
    const text = nextStepAfterCreate(1);
    strictEqual(text.includes('초대 코드'), true);
    strictEqual(text.includes('회의를 여는 게 좋'), true);
  });

  it('모이면 회의를 열라고 한다', () => {
    strictEqual(nextStepAfterCreate(3).includes('회의를 열면'), true);
  });

  it('0명이어도 터지지 않는다', () => {
    strictEqual(nextStepAfterCreate(0).length > 0, true);
  });
});

describe('클립보드에 넣을 코드', () => {
  it('⭐ 코드가 없으면 **null** — 화면 글자를 복사하면 `(없음)` 이 나간다', () => {
    strictEqual(codeToCopy(null), null);
    strictEqual(codeToCopy(undefined), null);
    strictEqual(codeToCopy(''), null);
    strictEqual(codeToCopy('   '), null);
  });

  it('⚠️ 표시용 문구 자체를 넘겨도 복사하지 않는다', () => {
    // 화면에서 읽어 오던 실수를 그대로 재현한다. `(없음)` 은 여덟 자가
    // 아니고 알파벳 밖 글자가 섞여 있으므로 코드일 수 없다.
    strictEqual(codeToCopy(NO_CODE), null);
  });

  it('있으면 사람이 받아 적기 쉬운 형태로', () => {
    strictEqual(codeToCopy('ABCDEFGH'), 'ABCD-EFGH');
    strictEqual(codeToCopy('  abcd-efgh '), 'ABCD-EFGH');
  });
});


describe('githubLoginStatus', () => {
  it('⭐ 비어 있으면 **왜 문제인지**까지 말한다', () => {
    // 아무 말도 안 하면 안 적어도 되는 칸으로 읽힙니다. 그 상태가 바로
    // 그 사람의 PR 이 주인을 못 찾는 상태입니다.
    const text = githubLoginStatus(null);
    strictEqual(text.includes('아직 연결하지 않았습니다'), true, text);
    strictEqual(text.includes('기여도'), true, text);
  });

  it('공백만 있는 것도 비어 있는 것이다', () => {
    strictEqual(githubLoginStatus('   '), githubLoginStatus(null));
  });

  it('이어져 있으면 어떤 아이디인지 그대로 보여준다', () => {
    strictEqual(githubLoginStatus('minsu-dev'), '지금 minsu-dev로 이어져 있습니다.');
  });

  it('⭐ 조사를 **계산**한다 — 끝소리가 무엇이냐로 갈린다', () => {
    // ⚠️ 여기는 `hong7` 이 "hong7으로" 라고 적혀 있었습니다. **틀린
    // 한국어였습니다.** `7` 은 "칠" 이고 칠은 **ㄹ 받침**이라 `로` 입니다 —
    // 받침이 없을 때만 `로` 인 줄 알고 적은 것입니다.
    //
    // 같은 착각이 칸반 버튼에 "할 일으로" 를 띄우고 있었습니다.
    strictEqual(githubLoginStatus('hong7'), '지금 hong7로 이어져 있습니다.'); // 칠 → ㄹ
    strictEqual(githubLoginStatus('hong3'), '지금 hong3으로 이어져 있습니다.'); // 삼 → ㅁ
    strictEqual(githubLoginStatus('minsu-dev'), '지금 minsu-dev로 이어져 있습니다.'); // 브이
  });
});


describe('결함 256 — 확인 없이 끊기던 저장소 연결', () => {
  it('⭐ **비우는 것**만 연결 해제다', () => {
    strictEqual(isDisconnect('owner/repo', ''), true);
    strictEqual(isDisconnect('owner/repo', '   '), true);
    // 다른 저장소로 **바꾸는** 것은 해제가 아닙니다.
    strictEqual(isDisconnect('owner/repo', 'owner/other'), false);
    // 원래 연결이 없으면 끊을 것도 없습니다.
    strictEqual(isDisconnect(null, ''), false);
    strictEqual(isDisconnect('', ''), false);
    strictEqual(isDisconnect(undefined, ''), false);
  });

  it('⭐ 물을 때 **무엇이 사라지는지** 적는다', () => {
    const said = disconnectConfirm('owner/repo');
    strictEqual(said.includes('owner/repo'), true, said);
    // 되돌릴 수 있는 것과 없는 것을 **둘 다** 말합니다.
    strictEqual(said.includes('남지만'), true, said);
    strictEqual(said.includes('연결 전'), true, said);
  });
});
