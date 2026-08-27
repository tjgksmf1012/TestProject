import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { focusPlan, whoHasFocus } from './focus.ts';

describe('누른 자리로 초점을 되돌린다 (결함 349)', () => {
  const here = { isConnected: true };
  const gone = { isConnected: false };

  it('⭐ 초점이 `body` 로 떨어졌고 그 자리가 살아 있으면 **되돌린다**', () => {
    // 재현: 담당자 체크박스에서 Space → `disabled` 가 붙는 순간 브라우저가
    // 초점을 버리고, 요청이 끝나도 안 돌아옵니다. 카드를 한 칸 옮길 때마다
    // 문서 맨 앞에서 다시 Tab 해야 했습니다.
    strictEqual(focusPlan(here, 'nobody', true), 'remembered');
  });

  it('⛔ 사람이 그 사이 **다른 곳을 눌렀으면** 건드리지 않는다', () => {
    // 되돌리면 사람이 하려던 일을 가로챕니다 — 고치려던 것보다 나쁩니다.
    strictEqual(focusPlan(here, 'someone', true), 'nowhere');
    strictEqual(focusPlan(gone, 'someone', true), 'nowhere');
  });

  it('⭐ 그 자리는 사라졌어도 **카드가 살아 있으면** 카드 안으로', () => {
    // 카드를 다른 열로 옮기면 눌렀던 버튼이 통째로 사라집니다
    // (`nextStatuses` 가 달라져 다시 그려집니다). 여기서 멈추면 초점이
    // `body` 에 남아 **고치려던 바로 그 증상**이 그대로입니다 —
    // 담당자·우선순위만 고쳐 놓고 재 봤다가 잡았습니다.
    strictEqual(focusPlan(gone, 'nobody', true), 'nearby');
    strictEqual(focusPlan(null, 'nobody', true), 'nearby');
  });

  it('⛔ 카드마저 사라졌으면 아무 데도 안 보낸다 — 지운 카드', () => {
    strictEqual(focusPlan(gone, 'nobody', false), 'nowhere');
    strictEqual(focusPlan(null, 'nobody', false), 'nowhere');
    strictEqual(focusPlan(undefined, 'nobody', false), 'nowhere');
  });

  it('⚠️ `body` 와 `null` 을 **같이** 본다 — 브라우저마다 떨어뜨리는 곳이 다르다', () => {
    const body = { tag: 'body' };
    const button = { tag: 'button' };
    strictEqual(whoHasFocus(body, body), 'nobody');
    strictEqual(whoHasFocus(null, body), 'nobody');
    strictEqual(whoHasFocus(undefined, body), 'nobody');
    strictEqual(whoHasFocus(button, body), 'someone');
  });
});
