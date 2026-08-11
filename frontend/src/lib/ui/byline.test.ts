import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { avatarInitial, bylineHtml } from './byline.ts';

describe('avatarInitial', () => {
  it('첫 글자를 뗀다', () => {
    strictEqual(avatarInitial('김민수'), '김');
    strictEqual(avatarInitial('Minsu'), 'M');
  });

  it('⭐ 두 칸을 쓰는 글자를 반으로 자르지 않는다', () => {
    // `name[0]` 은 UTF-16 코드 단위 하나라 대리쌍(surrogate pair)의
    // 앞쪽 반만 떼어 옵니다 — 화면에는 깨진 네모가 뜹니다.
    // 프로젝트 레일에서 같은 함정을 한 번 밟았습니다.
    const 이름 = '𝒜리스';
    strictEqual(이름[0] === avatarInitial(이름), false, 'name[0] 과 같으면 안 됩니다');
    strictEqual(avatarInitial(이름), '𝒜');
    strictEqual(avatarInitial('🙂민수'), '🙂');
  });

  it('앞뒤 공백은 글자로 세지 않는다', () => {
    strictEqual(avatarInitial('  김민수  '), '김');
  });

  it('⭐ 빈 이름에 빈 동그라미를 그리지 않는다', () => {
    // 아무것도 없는 동그라미는 "앱이 뭔가 잃어버렸다" 로 읽힙니다.
    strictEqual(avatarInitial(''), '?');
    strictEqual(avatarInitial('   '), '?');
  });
});

describe('bylineHtml', () => {
  it('아바타 + 이름 + 하는 일', () => {
    strictEqual(
      bylineHtml('김민수', '검토 중'),
      '<span class="avatar" aria-hidden="true">김</span>김민수 · 검토 중',
    );
  });

  it('하는 일이 없으면 이름만', () => {
    strictEqual(
      bylineHtml('김민수'),
      '<span class="avatar" aria-hidden="true">김</span>김민수',
    );
  });

  it('⭐ 아바타는 낭독기에서 읽지 않는다', () => {
    // 바로 옆에 이름이 글자로 있습니다. 그림까지 읽으면 "김 김민수" 가
    // 됩니다.
    strictEqual(bylineHtml('김민수').includes('aria-hidden="true"'), true);
  });

  it('⭐ 이름을 이스케이프한다 — 아바타 글자까지', () => {
    // 이름은 서버가 준 값입니다. 첫 글자가 `<` 일 수 있습니다.
    const html = bylineHtml('<script>alert(1)</script>');
    strictEqual(html.includes('<script'), false, html);
    strictEqual(html.includes('&lt;'), true, html);
  });

  it('하는 일도 이스케이프한다', () => {
    strictEqual(bylineHtml('김민수', '<b>').includes('<b>'), false);
  });
});
