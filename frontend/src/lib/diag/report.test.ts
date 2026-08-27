import { strictEqual, deepStrictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_MESSAGE,
  MAX_ROUTE,
  MAX_STACK,
  clientErrorPayload,
  crashMessage,
  messageOf,
  routeOf,
} from './report.ts';

describe('routeOf — 보내지 않는 것', () => {
  it('⭐ 물음표 뒤를 뗀다 — 주소에 실린 것이 로그로 새지 않게', () => {
    strictEqual(routeOf('/app/project/3/kanban?project=3'), '/app/project/3/kanban');
    strictEqual(routeOf('http://127.0.0.1:8811/app/?project=3'), '/app/');
  });

  it('⭐ 우물 정 뒤도 뗀다', () => {
    strictEqual(routeOf('/app/review#근거-5'), '/app/review');
    strictEqual(routeOf('/app/x?a=1#b'), '/app/x');
  });

  it('호스트가 없어도 된다 — `location.pathname` 이 그렇게 들어온다', () => {
    strictEqual(routeOf('/app/'), '/app/');
  });

  it('빈 값은 `/`', () => {
    strictEqual(routeOf(''), '/');
  });

  it('길면 자른다', () => {
    strictEqual(routeOf(`/${'가'.repeat(400)}`).length, MAX_ROUTE);
  });
});

describe('messageOf', () => {
  it('Error 는 메시지를', () => {
    strictEqual(messageOf(new TypeError('e.filter is not a function')), 'e.filter is not a function');
  });

  it('메시지가 비면 이름이라도 — 빈 줄을 남기지 않는다', () => {
    strictEqual(messageOf(new RangeError('')), 'RangeError');
  });

  it('⚠️ 평범한 객체가 `[object Object]` 로 남지 않는다 — 그건 아무 말도 아니다', () => {
    strictEqual(messageOf({ status: 500, detail: '앗' }), '알 수 없는 오류 객체 {status,detail}');
  });

  it('문자열·null·undefined 도 받는다', () => {
    strictEqual(messageOf('그냥 문자열'), '그냥 문자열');
    strictEqual(messageOf(null), 'null');
    strictEqual(messageOf(undefined), 'undefined');
  });

  it('길면 자른다', () => {
    strictEqual(messageOf(new Error('가'.repeat(900))).length, MAX_MESSAGE);
  });
});

describe('clientErrorPayload', () => {
  it('⭐ 서버가 받는 모양 그대로', () => {
    const err = new Error('터졌다');
    err.stack = 'Error: 터졌다\n  at foo';
    deepStrictEqual(clientErrorPayload(err, 'render', '/app/?project=2'), {
      kind: 'render',
      message: '터졌다',
      stack: 'Error: 터졌다\n  at foo',
      route: '/app/',
    });
  });

  it('⚠️ 모르는 kind 는 `error` 로 눕힌다 — 서버 쪽 상한을 넘겨 422 가 되지 않게', () => {
    strictEqual(clientErrorPayload(new Error('x'), '이상한값', '/').kind, 'error');
    strictEqual(clientErrorPayload(new Error('x'), 'unhandledrejection', '/').kind, 'unhandledrejection');
  });

  it('Error 가 아니면 스택은 null — 없는 것을 지어내지 않는다', () => {
    strictEqual(clientErrorPayload('문자열', 'error', '/').stack, null);
  });

  it('스택이 길면 자른다 — 렌더 루프 한 번이 로그를 채우지 않게', () => {
    const err = new Error('x');
    err.stack = 'a'.repeat(9000);
    strictEqual((clientErrorPayload(err, 'render', '/').stack as string).length, MAX_STACK);
  });
});

describe('crashMessage', () => {
  it('⚠️ 원래 오류 문구를 사람에게 들이밀지 않는다', () => {
    const text = crashMessage();
    strictEqual(text.includes('Error'), false);
    strictEqual(text.length > 10, true);
  });
});
