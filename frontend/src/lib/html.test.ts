/**
 * 이 테스트가 존재하는 이유는 실제 결함 하나입니다.
 *
 * `review.ts` 의 `escapeHtml` 이 `document.createElement('div').textContent`
 * 방식이라 **따옴표를 이스케이프하지 않았고**, 그 결과가 두 군데(`:143`,
 * `:181`)에서 **속성 자리**에 들어가고 있었습니다. 그 값은 LLM 이 회의
 * 발화에서 뽑은 업무 제목입니다.
 *
 * DOM 방식으로 두는 한 이 결함은 Node 에서 테스트할 수 없습니다. 그게
 * 이 함수가 `src/lib` 으로 내려온 진짜 이유입니다 — 화면 안에 있는 코드는
 * 198개 테스트 그물 밖입니다.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { attr, escapeHtml } from './html.ts';

describe('escapeHtml', () => {
  it('⭐ 따옴표를 이스케이프한다 — 속성 자리에서 이게 전부다', () => {
    strictEqual(escapeHtml('로그인 " 기능'), '로그인 &quot; 기능');
    strictEqual(escapeHtml("로그인 ' 기능"), '로그인 &#39; 기능');
  });

  it('홑따옴표도 이스케이프한다', () => {
    strictEqual(escapeHtml("it's"), 'it&#39;s');
  });

  it('꺾쇠와 앰퍼샌드를 이스케이프한다', () => {
    strictEqual(escapeHtml('<script>'), '&lt;script&gt;');
    strictEqual(escapeHtml('a & b'), 'a &amp; b');
  });

  it('⭐ 앰퍼샌드를 두 번 이스케이프하지 않는다', () => {
    // 순서를 틀리면 '&lt;' 의 & 를 다시 건드려 '&amp;lt;' 가 된다.
    strictEqual(escapeHtml('<'), '&lt;');
    strictEqual(escapeHtml('&lt;'), '&amp;lt;');
  });

  it('평범한 한국어는 그대로 둔다', () => {
    strictEqual(escapeHtml('로그인 API 구현'), '로그인 API 구현');
  });

  it('빈 문자열을 견딘다', () => {
    strictEqual(escapeHtml(''), '');
  });

  it('⭐ 속성을 탈출하는 실제 공격 문자열을 막는다', () => {
    // 회의에서 누군가 이렇게 말하기만 하면 LLM 이 제목으로 뽑을 수 있다.
    const evil = '로그인 " onmouseover="alert(1)';
    const html = `<input value="${escapeHtml(evil)}">`;

    // 따옴표가 정확히 둘 — value 를 여는 것과 닫는 것뿐이다.
    // 즉 속성이 중간에서 끊기지 않고, `onmouseover=` 는 속성이 아니라
    // value 안의 무해한 텍스트로 남는다. (문자열 자체는 당연히 남아 있다)
    strictEqual(html.match(/"/g)?.length, 2);
    strictEqual(html, '<input value="로그인 &quot; onmouseover=&quot;alert(1)">');
  });
});

describe('attr', () => {
  it('따옴표를 포함해 돌려준다 — 빠뜨릴 수 없게', () => {
    strictEqual(attr('제목'), '"제목"');
  });

  it('안쪽 따옴표를 이스케이프한다', () => {
    strictEqual(attr('로그인 " 기능'), '"로그인 &quot; 기능"');
  });

  it('숫자도 받는다', () => {
    strictEqual(attr(12), '"12"');
  });

  it('⭐ 공격 문자열을 넣어도 속성 하나로 유지된다', () => {
    const html = `<input value=${attr('" onmouseover="alert(1)')}>`;
    strictEqual(html.match(/"/g)?.length, 2);
  });
});

describe('DOM 방식과의 차이 (이 파일이 존재하는 이유)', () => {
  it('예전 방식이 남기던 문자들을 전부 처리한다', () => {
    // textContent → innerHTML 은 & < > 만 치환하고 따옴표는 남긴다.
    const domWouldLeave = ['"', "'"];
    const escaped = escapeHtml(domWouldLeave.join(''));

    deepStrictEqual(
      domWouldLeave.filter((ch) => escaped.includes(ch)),
      [],
      '속성 자리를 깨뜨릴 수 있는 문자가 남아 있습니다'
    );
  });
});
