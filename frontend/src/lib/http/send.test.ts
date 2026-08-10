import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeUnexpected, trySend, unreachableText } from './send.ts';

describe('trySend (결함 87)', () => {
  it('응답이 오면 그대로 돌려준다', async () => {
    const response = new Response('{}', { status: 200 });
    strictEqual(await trySend(() => Promise.resolve(response)), response);
  });

  it('서버가 오류를 줘도 그건 응답이다 — null 이 아니다', async () => {
    // ⚠️ `fetch` 는 500 에서도 **성공**으로 끝납니다. 그걸 `null` 로
    // 바꿔 버리면 화면이 서버가 준 이유를 못 읽습니다.
    const response = new Response('{"detail":"안 됩니다"}', { status: 500 });
    strictEqual((await trySend(() => Promise.resolve(response)))?.status, 500);
  });

  it('⭐ 서버에 닿지 못하면 던지지 않고 null', async () => {
    strictEqual(await trySend(() => Promise.reject(new TypeError('Failed to fetch'))), null);
  });

  it('⭐ 그 자리에서 던져도 null — 밖으로 새지 않는다', async () => {
    // `trySend(fetch(…))` 였다면 이게 밖으로 나갔습니다.
    strictEqual(
      await trySend(() => {
        throw new TypeError('Failed to construct Request');
      }),
      null,
    );
  });
});

describe('unreachableText', () => {
  it('무엇이 실패했는지와 무엇을 할지 둘 다 적는다', () => {
    const text = unreachableText('확정하지 못했습니다');
    strictEqual(text.startsWith('확정하지 못했습니다'), true);
    strictEqual(text.includes('연결을 확인'), true);
  });

  it('⭐ 안 되는 것을 안다고 쓰지 않는다', () => {
    // 요청이 나가기 전에 끊겼는지, 갔는데 답이 못 왔는지 브라우저는
    // 구분해 주지 않습니다. "아무것도 바뀌지 않았습니다" 는 거짓일 수
    // 있으므로 쓰지 않습니다.
    strictEqual(unreachableText('옮기지 못했습니다').includes('바뀌지 않았'), false);
  });
});

describe('describeUnexpected', () => {
  it('⭐ 브라우저의 영어 예외를 담지 않는다', () => {
    const text = describeUnexpected();
    strictEqual(/[A-Za-z]{5,}/.test(text), false, `영어가 섞였습니다: ${text}`);
    strictEqual(text.includes('알려 주세요'), true);
  });
});
