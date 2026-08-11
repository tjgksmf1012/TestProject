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
  });

  it('⭐ ㄹ 받침은 `로` — "할 일으로" 가 화면에 떠 있었다', () => {
    // ⚠️ 여기에는 "ㄹ 예외를 **일부러 안 넣었다 — 지금 화면에 ㄹ 로
    // 끝나는 값이 들어가는 자리가 없다**" 고 적혀 있었습니다.
    //
    // **그 전제가 틀렸습니다.** 칸반의 업무 상태가 `할 일`·`진행 중`·
    // `완료` 이고, 옮기기 버튼이 그 이름에 `으로/로` 를 붙입니다. 그래서
    // 버튼에 **"할 일으로"** 가 떠 있었습니다 — 렌더해서 눈으로 볼 때까지
    // 아무도 몰랐습니다. 없는 경우라고 적어 둔 것이 실은 화면에 있었습니다.
    strictEqual(withJosa('할 일', '으로로'), '할 일로');
    strictEqual(withJosa('서울', '으로로'), '서울로');
    strictEqual(withJosa('진행 중', '으로로'), '진행 중으로'); // ㅇ 받침 — 그대로
    strictEqual(withJosa('완료', '으로로'), '완료로'); // 받침 없음

    // 숫자·로마자도 **읽었을 때** ㄹ 로 끝나면 같습니다.
    strictEqual(josa('1', '으로로'), '로'); // 일
    strictEqual(josa('7', '으로로'), '로'); // 칠
    strictEqual(josa('8', '으로로'), '로'); // 팔
    strictEqual(josa('3', '으로로'), '으로'); // 삼
    strictEqual(josa('PR', '으로로'), '로'); // 피알
    strictEqual(josa('URL', '으로로'), '로'); // 유알엘

    // ⚠️ **다른 네 쌍은 그대로입니다.** ㄹ 예외는 `으로/로` 에만 있습니다.
    strictEqual(josa('서울', '은는'), '은');
    strictEqual(josa('서울', '을를'), '을');
    strictEqual(josa('서울', '이가'), '이');
    strictEqual(josa('서울', '과와'), '과');
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
