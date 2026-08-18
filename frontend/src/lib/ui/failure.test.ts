/**
 * 오류 화면이 **사람이 할 수 있는 일**을 남기는가.
 *
 * "문제가 발생했습니다" 만 뜨는 화면은 아무 말도 안 한 것과 같습니다.
 * 403 과 500 은 다른 사람이 다른 일을 해야 하는 상황인데, 화면이 그
 * 구분을 지우면 아무도 못 고칩니다.
 */

import { strictEqual, ok } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeHttpStatus, failureHtml, showNote } from './failure.ts';

describe('오류 화면', () => {
  it('무엇이 실패했는지 · 오류 코드를 같이 낸다', () => {
    const html = failureHtml({ what: '기여도를 불러오지 못했습니다', code: 500 });
    ok(html.includes('기여도를 불러오지 못했습니다'));
    ok(html.includes('500'));
  });

  it('⭐ 코드가 없으면 **빈 괄호를 남기지 않는다**', () => {
    const html = failureHtml({ what: '연결이 끊겼습니다' });
    ok(!html.includes('오류 코드'));
  });

  it('다시 하기 버튼은 요청할 때만', () => {
    ok(failureHtml({ what: 'x', retry: true }).includes('class="retry"'));
    ok(!failureHtml({ what: 'x' }).includes('class="retry"'));
  });

  it('⭐ 낭독기가 바로 읽도록 role="alert"', () => {
    // 오류는 화면 어딘가에 조용히 나타나면 안 됩니다.
    ok(failureHtml({ what: 'x' }).includes('role="alert"'));
  });

  it('문구를 이스케이프한다', () => {
    ok(!failureHtml({ what: '<b>x</b>' }).includes('<b>'));
  });
});

describe('상태 코드 설명', () => {
  it('사람이 할 일이 다른 코드를 갈라 준다', () => {
    ok(describeHttpStatus(403)?.includes('구성원만'));
    ok(describeHttpStatus(500)?.includes('팀이 고칠 수 있는 것이 아닙니다'));
    ok(describeHttpStatus(404)?.includes('찾을 수 없습니다'));
  });

  it('⭐ 모르는 코드는 **지어내지 않는다**', () => {
    // 아무 설명이나 붙이면 사람이 그 설명을 믿고 엉뚱한 데를 고칩니다.
    strictEqual(describeHttpStatus(418), null);
    strictEqual(describeHttpStatus(302), null);
  });

  it('5xx 는 전부 서버 쪽으로 묶는다', () => {
    for (const status of [500, 502, 503, 504]) {
      ok(describeHttpStatus(status)?.includes('서버 쪽'), `${status}`);
    }
  });
});

describe('showNote (결함 92)', () => {
  /** 안내 자리 대역. 실제 `HTMLElement` 의 필요한 부분만. */
  const slot = () => {
    const classes = new Set<string>();
    return {
      textContent: '' as string | null,
      hidden: true,
      classList: {
        toggle: (name: string, on: boolean) => void (on ? classes.add(name) : classes.delete(name)),
      },
      classes,
    };
  };

  it('⭐ 실패는 실패처럼 보인다', () => {
    const el = slot();
    showNote(el, '확정하지 못했습니다 — 서버에 닿지 못했습니다.');
    strictEqual(el.hidden, false);
    strictEqual(el.classes.has('bad'), true, '빨간 줄이 아니면 상태 줄로 읽힙니다');
  });

  it('⭐ 성공은 빨갛게 쓰지 않는다 — 같은 자리라도 뜻이 다르다', () => {
    const el = slot();
    showNote(el, '2개 트랙을 강제 종료했습니다', 'plain');
    strictEqual(el.hidden, false);
    strictEqual(el.classes.has('bad'), false);
  });

  it('⭐ 대기·결측은 흙빛이다 — 빨강도 회색도 아니다', () => {
    // 마이크 권한을 아직 안 준 것은 잘못이 아니라 순서상의 상태입니다.
    // 빨강이면 "고장" 으로, 회색이면 "평범한 상태 줄" 로 읽힙니다
    // (design/redesign §통화 · docs/05 §5 — 측정 불가 ≠ 0점).
    const el = slot();
    showNote(el, '마이크가 아직 꺼져 있습니다 — 권한을 허용하면 켜집니다.', 'gap');
    strictEqual(el.classes.has('gap'), true);
    strictEqual(el.classes.has('bad'), false);
    showNote(el, '');
    strictEqual(el.classes.has('gap'), false, '지울 때 색도 같이 지웁니다');
  });

  it('⭐ 지울 때 색도 같이 지운다', () => {
    // 클래스만 남으면 다음 안내가 엉뚱한 색으로 뜹니다.
    const el = slot();
    showNote(el, '복사하지 못했습니다');
    showNote(el, '');
    strictEqual(el.textContent, '');
    strictEqual(el.classes.has('bad'), false);
  });

  it('⭐ **`hidden` 으로 감추지 않는다** — 낭독기가 못 듣습니다', () => {
    // 이 자리들은 `role="status"` 를 답니다. 낭독기는 **이미 있던** live
    // region 이 바뀔 때 읽어 주는데, `hidden` 은 요소를 접근성 트리에서
    // 빼 버립니다 — 안내가 뜰 때마다 region 이 새로 생기는 셈입니다.
    //
    // 자리를 안 차지하는 일은 CSS 가 합니다
    // (`app.css` 의 `[role='status']:empty { margin: 0 }`).
    const el = slot();
    strictEqual(el.hidden, true, '대역은 마크업처럼 hidden 으로 시작합니다');
    showNote(el, '복사했습니다', 'plain');
    strictEqual(el.hidden, false, '마크업의 hidden 을 걷어야 합니다');
    showNote(el, '');
    strictEqual(el.hidden, false, '지운 뒤에도 자리는 접근성 트리에 남아야 합니다');
  });
});
