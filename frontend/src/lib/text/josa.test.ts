import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasFinalConsonant, josa, withJosa } from './josa.ts';

describe('받침이 있는가', () => {
  it('한글은 계산으로 판단한다', () => {
    // 받침 있음
    strictEqual(hasFinalConsonant('김민수'), false); // 수
    strictEqual(hasFinalConsonant('이하늘'), true); // 늘
    strictEqual(hasFinalConsonant('박지원'), true); // 원
    strictEqual(hasFinalConsonant('회의'), false); // 의
    strictEqual(hasFinalConsonant('사람'), true); // 람
  });

  it('숫자는 **읽는 소리**로 판단한다', () => {
    strictEqual(hasFinalConsonant('후보 3'), true); // 삼
    strictEqual(hasFinalConsonant('후보 4'), false); // 사
    strictEqual(hasFinalConsonant('TASK-1'), true); // 일
    strictEqual(hasFinalConsonant('HTTP 500'), true); // 영
    strictEqual(hasFinalConsonant('502'), false); // 이
  });

  it('⚠️ 판단할 수 없으면 null 이다 — 아무 쪽이나 고르지 않는다', () => {
    strictEqual(hasFinalConsonant(''), null);
    strictEqual(hasFinalConsonant('   '), null);
    strictEqual(hasFinalConsonant('...'), null);
    strictEqual(hasFinalConsonant('(없음)'), null); // 괄호로 끝남
  });
});

describe('조사를 고른다', () => {
  it('은/는', () => {
    strictEqual(josa('김민수', '은는'), '는');
    strictEqual(josa('이하늘', '은는'), '은');
  });

  it('이/가', () => {
    strictEqual(josa('12초', '이가'), '가'); // 초 — 받침 없음
    strictEqual(josa('3분', '이가'), '이'); // 분 — 받침 있음
  });

  it('을/를', () => {
    strictEqual(josa('후보 3', '을를'), '을'); // 삼
    strictEqual(josa('후보 2', '을를'), '를'); // 이
    strictEqual(josa('TASK-3', '을를'), '을');
  });

  it('과/와', () => {
    strictEqual(josa('박지원', '과와'), '과');
    strictEqual(josa('김민수', '과와'), '와');
  });

  it('으로/로', () => {
    strictEqual(josa('500', '으로로'), '으로'); // 영
    strictEqual(josa('502', '으로로'), '로'); // 이
    // ⚠️ ㄹ 받침은 '로' 를 쓰는 것이 한국어 규칙이지만, 이 함수는
    // 그 예외를 **일부러 안 넣었습니다** — 지금 화면에 ㄹ 로 끝나는 값이
    // 들어가는 자리가 없고, 없는 경우를 위한 규칙은 검증할 수 없습니다.
    // 그런 자리가 생기면 그때 경우를 넣으면서 이 주석을 지우세요.
  });

  it('⚠️ 판단 못 하면 받침 없는 쪽 — 짝 표기를 화면에 내보내지 않는다', () => {
    strictEqual(josa('...', '은는'), '는');
    strictEqual(josa('', '은는'), '는');
    // 이 함수가 존재하는 이유가 화면에 `은(는)` 이 나온 것이었습니다.
    strictEqual(josa('아무거나', '은는').includes('('), false);
  });
});

describe('붙여 쓴다', () => {
  it('값과 조사 사이에 공백이 없다', () => {
    strictEqual(withJosa('김민수', '은는'), '김민수는');
    strictEqual(withJosa('이하늘', '은는'), '이하늘은');
    // 띄우면 조사가 다음 낱말처럼 보입니다 — 그게 원래 결함이었습니다.
    strictEqual(withJosa('김민수', '은는').includes(' '), false);
  });
});
