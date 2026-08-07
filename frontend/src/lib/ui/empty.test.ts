/**
 * 빈 화면이 **고장으로 읽히지 않는가.**
 *
 * 이 저장소가 반복해 당한 결함은 전부 같은 모양이었습니다 — 없는 것을
 * 빈 것으로 답한다. 사람은 빈 화면을 "아무도 아무것도 안 했구나" 로
 * 읽습니다. 이 값이 성적에 쓰일 수 있으므로 그건 버그가 아니라 오답입니다.
 */

import { strictEqual, ok } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { emptyHtml } from './empty.ts';

const BASE = {
  what: '여기에는 업무 카드가 나옵니다',
  why: '아직 승인된 업무가 하나도 없습니다',
  how: '회의를 열고 업무 후보를 승인하면 여기에 쌓입니다',
};

describe('빈 상태는 셋을 다 말한다', () => {
  it('⭐ **왜 비어 있는지**가 언제나 들어간다', () => {
    // 이게 빠지면 화면이 고장 난 것처럼 보입니다. 타입이 강제하지만,
    // 실제로 출력에 나오는지는 별개입니다.
    const html = emptyHtml(BASE);
    ok(html.includes(BASE.what));
    ok(html.includes(BASE.why));
    ok(html.includes(BASE.how));
  });

  it('주 버튼은 있으면 하나만', () => {
    const html = emptyHtml({ ...BASE, action: { label: '회의 열기', href: '/project.html?p=1' } });
    strictEqual([...html.matchAll(/class="btn btn-primary"/g)].length, 1);
    ok(html.includes('href="/project.html?p=1"'));
  });

  it('⭐ 갈 곳이 없으면 버튼을 만들지 않는다', () => {
    // 눌러 보고 제자리로 돌아오는 버튼은 없는 것만 못합니다.
    ok(!emptyHtml(BASE).includes('<a'));
  });
});

describe('문구를 그대로 믿지 않는다', () => {
  it('⭐ 이스케이프한다 — 회의 제목이 여기로 들어온다', () => {
    // 회의 제목은 LLM 이 발화에서 만든 문자열입니다. 사람이 회의 중에
    // 태그처럼 생긴 말을 하면 그게 그대로 옵니다.
    const html = emptyHtml({
      ...BASE,
      why: '<img src=x onerror=alert(1)> 회의에 후보가 없습니다',
    });
    ok(!html.includes('<img'));
    ok(html.includes('&lt;img'));
  });

  it('주소도 이스케이프한다', () => {
    const html = emptyHtml({ ...BASE, action: { label: '가기', href: '"><script>' } });
    ok(!html.includes('"><script>'));
  });
});
