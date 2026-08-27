import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { plainText } from './plain.ts';

describe('plainText (결함 262)', () => {
  it('⭐ **백틱**을 걷는다 — 한국어 문장 안에서는 깨진 글자입니다', () => {
    strictEqual(
      plainText('서버 관리자에게 `GITHUB_WEBHOOK_SECRET` 설정을 요청하세요.'),
      'GITHUB_WEBHOOK_SECRET'.length > 0
        ? '서버 관리자에게 GITHUB_WEBHOOK_SECRET 설정을 요청하세요.'
        : '',
    );
    strictEqual(plainText('위 칸에 `owner/repo` 형식으로'), '위 칸에 owner/repo 형식으로');
  });

  it('⭐ 강조 표시도 걷는다', () => {
    strictEqual(plainText('**확정된 기여도가 아닙니다.**'), '확정된 기여도가 아닙니다.');
  });

  it('⚠️ **낱말은 그대로 둡니다** — 요약하지 않습니다', () => {
    const long =
      '팀원과 이어 줄 수 없어 **전원의 GitHub 기여도가 0** 이 됩니다.';
    const said = plainText(long);
    strictEqual(said.includes('전원의 GitHub 기여도가 0'), true, said);
    strictEqual(said.length, long.length - 4);
  });

  it('표시가 없으면 **아무것도 안 바꿉니다**', () => {
    strictEqual(plainText('그냥 문장입니다'), '그냥 문장입니다');
    strictEqual(plainText(''), '');
  });
});
