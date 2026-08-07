import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  describeActivity,
  describeHealth,
  describeHealthFailure,
  describeLastDelivery,
  type GithubHealth,
} from './health.ts';

const NOW = new Date('2026-09-01T12:00:00Z');

function health(over: Partial<GithubHealth> = {}): GithubHealth {
  return {
    code: 'connected',
    headline: '연결되어 있습니다',
    detail: '배달 12건을 받았습니다.',
    severity: 'ok',
    next_step: null,
    warnings: [],
    repo: 'team/teamflow',
    verified_at: '2026-08-01T00:00:00Z',
    delivery_count: 12,
    last_delivery_at: '2026-09-01T11:58:00Z',
    ...over,
  };
}

describe('describeLastDelivery', () => {
  it('배달이 없으면 아무 말도 하지 않는다', () => {
    assert.equal(describeLastDelivery(null, NOW), '');
  });

  it('1분 안쪽은 방금', () => {
    assert.equal(describeLastDelivery('2026-09-01T11:59:30Z', NOW), '방금');
  });

  it('분·시간·일로 올라간다', () => {
    assert.equal(describeLastDelivery('2026-09-01T11:45:00Z', NOW), '15분 전');
    assert.equal(describeLastDelivery('2026-09-01T09:00:00Z', NOW), '3시간 전');
    assert.equal(describeLastDelivery('2026-08-30T12:00:00Z', NOW), '2일 전');
  });

  it('시계가 어긋나 미래로 나와도 "-3초 전" 을 보여주지 않는다', () => {
    assert.equal(describeLastDelivery('2026-09-01T12:00:30Z', NOW), '방금');
  });

  it('망가진 값에 NaN 을 뱉지 않는다', () => {
    assert.equal(describeLastDelivery('그런 날짜 없음', NOW), '');
  });
});

describe('describeActivity', () => {
  it('배달이 0건이면 침묵한다 — headline 이 이미 말했다', () => {
    assert.equal(describeActivity(health({ delivery_count: 0 }), NOW), '');
  });

  it('건수와 마지막 시각을 한 줄로', () => {
    assert.equal(describeActivity(health(), NOW), '배달 12건 · 마지막 2분 전');
  });

  it('마지막 시각을 모르면 건수만', () => {
    assert.equal(
      describeActivity(health({ last_delivery_at: null }), NOW),
      '배달 12건',
    );
  });
});

describe('describeHealth', () => {
  it('서버의 판단을 그대로 전한다 — 두 벌로 나눠 가지지 않는다', () => {
    const view = describeHealth(
      health({
        code: 'repo_name_mismatch',
        headline: '웹훅은 오고 있는데 저장소 이름이 다릅니다',
        severity: 'bad',
        next_step: '저장소를 `a/b` 로 고치세요.',
      }),
      NOW,
    );
    assert.equal(view.headline, '웹훅은 오고 있는데 저장소 이름이 다릅니다');
    assert.equal(view.tone, 'bad');
    assert.equal(view.nextStep, '저장소를 `a/b` 로 고치세요.');
  });

  it('⚠️ 모르는 severity 를 좋은 쪽으로 넘기지 않는다', () => {
    // 연결이 정상이라고 잘못 말하는 것이 모른다고 말하는 것보다 나쁘다.
    assert.equal(describeHealth(health({ severity: 'ok!!' }), NOW).tone, 'warn');
    assert.equal(describeHealth(health({ severity: '' }), NOW).tone, 'warn');
  });

  it('경고는 상태가 정상이어도 따라온다', () => {
    const view = describeHealth(
      health({ warnings: ['GitHub 계정을 연결하지 않은 팀원이 있습니다: 이하늘'] }),
      NOW,
    );
    assert.equal(view.tone, 'ok');
    assert.equal(view.warnings.length, 1);
  });

  it('warnings 가 아예 없어도 터지지 않는다', () => {
    const raw = health();
    delete (raw as { warnings?: string[] }).warnings;
    assert.deepEqual(describeHealth(raw, NOW).warnings, []);
  });
});

describe('describeHealthFailure', () => {
  it('⚠️ 진단을 못 불러온 것과 "문제 없음" 은 다르다', () => {
    // 조용히 넘어가면 화면이 비고, 빈 화면은 정상으로 읽힌다.
    for (const status of [0, 403, 500, 502]) {
      const view = describeHealthFailure(status);
      assert.ok(view.headline.length > 0, `${status} 가 침묵했다`);
      assert.notEqual(view.tone, 'ok', `${status} 가 정상으로 보인다`);
    }
  });

  it('HTTP 오류는 정상이라는 뜻이 아니라고 못 박는다', () => {
    assert.match(describeHealthFailure(500).detail, /정상이라는 뜻은 아닙니다/);
  });

  it('403 은 고칠 것이 없으므로 할 일을 주지 않는다', () => {
    assert.equal(describeHealthFailure(403).nextStep, null);
  });
});
