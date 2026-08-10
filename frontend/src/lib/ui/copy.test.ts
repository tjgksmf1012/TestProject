import { describe, it } from 'node:test';
import { strictEqual } from 'node:assert';

import { copySucceeded, copyText, describeCopy } from './copy.ts';

describe('클립보드에 넣기', () => {
  it('넣었으면 copied', async () => {
    const written: string[] = [];
    const outcome = await copyText('E2PC-AWSB', {
      writeText: async (t) => {
        written.push(t);
      },
    });
    strictEqual(outcome, 'copied');
    strictEqual(written.join(''), 'E2PC-AWSB');
  });

  it('⭐ 클립보드 자체가 없으면 unavailable — 던지지 않는다', async () => {
    // 폰에서 `http://192.168.0.5:8000` 으로 열면 `navigator.clipboard` 가
    // **undefined** 입니다. 예전 코드는 여기서 TypeError 로 죽었고 화면은
    // 아무 말도 안 했습니다.
    strictEqual(await copyText('E2PC-AWSB', undefined), 'unavailable');
    strictEqual(await copyText('E2PC-AWSB', null), 'unavailable');
  });

  it('writeText 가 없는 이상한 객체도 unavailable', async () => {
    const notClipboard = {} as unknown as { writeText(t: string): Promise<void> };
    strictEqual(await copyText('E2PC-AWSB', notClipboard), 'unavailable');
  });

  it('⭐ 거절당하면 refused — 조용히 넘어가지 않는다', async () => {
    const outcome = await copyText('E2PC-AWSB', {
      writeText: () => Promise.reject(new Error('NotAllowedError')),
    });
    strictEqual(outcome, 'refused');
  });

  it('⭐ 실패해도 예외를 던지지 않는다', async () => {
    // 던지면 부르는 쪽이 try 를 잊는 순간 다시 조용해집니다.
    const outcome = await copyText('x', {
      writeText: () => {
        throw new Error('동기적으로 터지는 경우');
      },
    });
    strictEqual(outcome, 'refused');
  });
});

describe('사람에게 할 말', () => {
  it('성공은 짧게', () => {
    strictEqual(describeCopy('copied', '코드'), '복사됨');
    strictEqual(copySucceeded('copied'), true);
  });

  it('⭐ 실패하면 왜 안 됐는지와 대신 할 일을 말한다', () => {
    const blocked = describeCopy('unavailable', '코드');
    strictEqual(blocked.includes('이 주소에서는'), true);
    strictEqual(blocked.includes('길게 눌러'), true);
    strictEqual(copySucceeded('unavailable'), false);

    const refused = describeCopy('refused', '코드');
    strictEqual(refused.includes('복사하지 못했습니다'), true);
    strictEqual(refused.includes('길게 눌러'), true);
    strictEqual(copySucceeded('refused'), false);
  });

  it('⭐ 조사를 값에 맞게 고른다', () => {
    // `코드` 는 받침이 없어 `를`, `한 줄` 은 ㄹ 받침이라 `을` 입니다.
    // 하나로 박아 두면 둘 중 하나가 틀립니다 (결함 76).
    strictEqual(describeCopy('refused', '코드').includes('코드를 길게'), true);
    strictEqual(describeCopy('refused', '한 줄').includes('한 줄을 길게'), true);
  });

  it('짝 표기를 내보내지 않는다', () => {
    for (const what of ['코드', '한 줄', '주소']) {
      strictEqual(describeCopy('refused', what).includes('('), false);
    }
  });
});
