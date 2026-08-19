import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { APP_NAME, pageTitle } from './title.ts';

describe('pageTitle', () => {
  it('⭐ 화면 이름이 앞에, 제품 이름이 뒤에 — 레거시 `.html` 열넷과 같은 형식', () => {
    strictEqual(pageTitle('녹음'), '녹음 — TeamFlow');
    strictEqual(pageTitle('칸반'), '칸반 — TeamFlow');
  });

  it('⚠️ 구분자는 em 대시다 — 하이픈으로 바뀌면 레거시와 갈라진다', () => {
    strictEqual(pageTitle('검토').includes(' — '), true);
    strictEqual(pageTitle('검토').includes(' - '), false);
  });

  it('⭐ 이름이 없으면 꼬리만 — `" — TeamFlow"` 가 뜨면 그게 결함으로 보인다', () => {
    strictEqual(pageTitle(null), APP_NAME);
    strictEqual(pageTitle(undefined), APP_NAME);
    strictEqual(pageTitle(''), APP_NAME);
    strictEqual(pageTitle('   '), APP_NAME);
  });

  it('앞뒤 공백은 다듬는다', () => {
    strictEqual(pageTitle('  로비  '), '로비 — TeamFlow');
  });
});
