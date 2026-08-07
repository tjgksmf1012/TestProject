/**
 * 서버 오류가 화면에 사람 말로 나오는가.
 *
 * 이 파일이 고정하는 것: **`[object Object]` 가 화면에 안 나온다.**
 *
 * 화면 여섯 곳이 `as { detail?: string }` 로 단언하고 그대로 `textContent`
 * 에 넣고 있었습니다. FastAPI 의 422 는 `detail` 이 **객체 배열**이라
 * 전부 `[object Object]` 가 됩니다. 타입 단언은 런타임에 아무것도 확인
 * 하지 않으므로 `tsc` 도 조용했습니다.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detailText } from './detail.ts';

const FALLBACK = '실패했습니다 (HTTP 500)';

describe('오류 본문 읽기', () => {
  it('서버가 사람을 위해 쓴 문장은 그대로', () => {
    strictEqual(
      detailText({ detail: '저장소가 연결되지 않았습니다' }, FALLBACK),
      '저장소가 연결되지 않았습니다',
    );
  });

  it('⭐ 422 의 객체 배열이 `[object Object]` 가 되지 않는다', () => {
    const body = {
      detail: [
        {
          type: 'model_attributes_type',
          loc: ['body'],
          msg: 'Input should be a valid dictionary',
          input: '{}',
        },
      ],
    };
    const text = detailText(body, FALLBACK);
    strictEqual(text.includes('[object Object]'), false);
    strictEqual(text.includes('올바르지 않습니다'), true);
  });

  it('어느 칸이 문제인지 말해 준다', () => {
    const body = {
      detail: [{ loc: ['body', 'limit'], msg: 'Input should be less than 1000' }],
    };
    strictEqual(detailText(body, FALLBACK).includes('limit'), true);
  });

  it('`body` 는 칸 이름으로 쓰지 않는다 — 사람에게 아무 뜻이 없다', () => {
    const body = { detail: [{ loc: ['body'], msg: 'x' }] };
    strictEqual(detailText(body, FALLBACK).includes('(body)'), false);
  });

  it('pydantic 의 영어 원문을 화면에 붙이지 않는다', () => {
    // 사용자가 고칠 수 있는 것이 아니고, 붙여 봐야 "무엇을 하라" 가
    // 안 나옵니다.
    const body = {
      detail: [{ loc: ['body', 'limit'], msg: 'Input should be less than 1000' }],
    };
    strictEqual(detailText(body, FALLBACK).includes('Input should be'), false);
  });

  it('아무 말도 없으면 준비해 둔 문장', () => {
    strictEqual(detailText({}, FALLBACK), FALLBACK);
    strictEqual(detailText(null, FALLBACK), FALLBACK);
    strictEqual(detailText(undefined, FALLBACK), FALLBACK);
    strictEqual(detailText('그냥 문자열', FALLBACK), FALLBACK);
  });

  it('빈 문자열은 말한 것이 아니다', () => {
    // 빈 칸을 그대로 넣으면 화면에 **아무것도 안 나오고**, 사람은 그걸
    // "성공" 으로 읽습니다.
    strictEqual(detailText({ detail: '' }, FALLBACK), FALLBACK);
    strictEqual(detailText({ detail: '   ' }, FALLBACK), FALLBACK);
  });

  it('빈 배열도 말한 것이 아니다', () => {
    strictEqual(detailText({ detail: [] }, FALLBACK), FALLBACK);
  });

  it('detail 이 숫자나 객체여도 안 깨진다', () => {
    strictEqual(detailText({ detail: 42 }, FALLBACK), FALLBACK);
    strictEqual(detailText({ detail: { msg: 'x' } }, FALLBACK), FALLBACK);
  });
});
