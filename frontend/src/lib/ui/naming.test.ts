import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { meetingLabel } from './naming.ts';

describe('meetingLabel — 회의를 부르는 이름 한 벌 (결함 285)', () => {
  it('이름이 있으면 그 이름', () => {
    strictEqual(meetingLabel('1주차 정기회의', 1), '1주차 정기회의');
  });

  it('⭐ 이름이 없으면 **어느 회의인지**를 남긴다', () => {
    /* 예전에는 「제목 없는 회의」였습니다. 이름 없는 회의가 둘이면
       목록에서도 탭에서도 구별할 수 없었습니다. */
    strictEqual(meetingLabel(null, 4), '제목 없는 회의 #4');
    strictEqual(meetingLabel(undefined, 5), '제목 없는 회의 #5');
  });

  it('⭐ 이름 없는 회의 둘은 **서로 다르게** 불린다', () => {
    strictEqual(meetingLabel(null, 4) === meetingLabel(null, 5), false);
  });

  it('공백뿐인 이름은 이름이 아니다', () => {
    strictEqual(meetingLabel('   ', 7), '제목 없는 회의 #7');
    strictEqual(meetingLabel('\n\t', 7), '제목 없는 회의 #7');
  });

  it('⭐ 화면 이름을 회의 이름 자리에 쓰지 않는다', () => {
    /* 로비는 「회의 준비」, 검토는 「회의 검토」라고 불렀습니다. */
    const label = meetingLabel(null, 4);
    strictEqual(label.includes('준비'), false);
    strictEqual(label.includes('검토'), false);
  });

  it('번호를 모르면 번호를 붙이지 않는다 (없는 값을 짓지 않음)', () => {
    strictEqual(meetingLabel(null, null), '제목 없는 회의');
    strictEqual(meetingLabel(null, undefined), '제목 없는 회의');
  });

  it('이름 앞뒤 공백은 다듬는다', () => {
    strictEqual(meetingLabel('  스프린트 2 계획  ', 2), '스프린트 2 계획');
  });
});
