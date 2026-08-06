import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  contextFromSearch,
  labelOf,
  missingLinks,
  navLinks,
  type ScreenId,
} from './links.ts';

const ALL: ScreenId[] = ['home', 'lobby', 'record', 'review', 'kanban', 'contributions'];

describe('navLinks', () => {
  it('⭐ 홈은 언제나 있다 — 어디서든 빠져나올 곳이 하나는 있어야 한다', () => {
    for (const current of ALL) {
      if (current === 'home') continue;
      const links = navLinks({ current });
      strictEqual(links.some((l) => l.screen === 'home'), true, current);
    }
  });

  it('⭐ 지금 화면으로 가는 링크는 만들지 않는다', () => {
    // 자기 자신으로 가는 링크는 새로고침일 뿐인데 사용자는 뭔가
    // 일어날 거라고 기대한다.
    for (const current of ALL) {
      const links = navLinks({ current, projectId: 1, meetingId: 2 });
      strictEqual(links.some((l) => l.screen === current), false, current);
    }
  });

  it('회의를 알면 로비·검토로 갈 수 있다', () => {
    const screens = navLinks({ current: 'kanban', meetingId: 7 }).map((l) => l.screen);
    deepStrictEqual(screens.sort(), ['home', 'lobby', 'review']);
  });

  it('프로젝트를 알면 칸반·기여도로 갈 수 있다', () => {
    const screens = navLinks({ current: 'home', projectId: 3 }).map((l) => l.screen);
    deepStrictEqual(screens.sort(), ['contributions', 'kanban']);
  });

  it('⭐ id 가 없으면 링크를 만들지 않는다', () => {
    // 만들면 눌렀을 때 기본값(대개 1)인 엉뚱한 프로젝트로 간다.
    const screens = navLinks({ current: 'record' }).map((l) => l.screen);
    deepStrictEqual(screens, ['home']);
  });

  it('⭐ 0·음수·NaN 은 id 가 아니다', () => {
    for (const bad of [0, -1, Number.NaN]) {
      const screens = navLinks({ current: 'home', projectId: bad, meetingId: bad }).map(
        (l) => l.screen,
      );
      deepStrictEqual(screens, [], String(bad));
    }
  });

  it('null·undefined 도 마찬가지', () => {
    deepStrictEqual(navLinks({ current: 'home', projectId: null }).length, 0);
    deepStrictEqual(navLinks({ current: 'home', projectId: undefined }).length, 0);
  });

  it('⭐ 칸반·기여도로 갈 때 회의 id 를 들고 간다', () => {
    // 그래야 칸반에서 다시 그 회의로 돌아올 수 있다. 안 들고 가면
    // 칸반이 막다른 길이 된다.
    const kanban = navLinks({ current: 'review', projectId: 3, meetingId: 7 }).find(
      (l) => l.screen === 'kanban',
    );
    strictEqual(kanban?.href, '/kanban.html?project=3&meeting=7');
  });

  it('회의를 모르면 프로젝트만 붙인다', () => {
    const kanban = navLinks({ current: 'home', projectId: 3 }).find(
      (l) => l.screen === 'kanban',
    );
    strictEqual(kanban?.href, '/kanban.html?project=3');
  });

  it('⭐ 왕복이 성립한다 — 링크를 따라가면 맥락이 유지된다', () => {
    const start = { current: 'lobby' as ScreenId, projectId: 3, meetingId: 7 };
    const kanban = navLinks(start).find((l) => l.screen === 'kanban');
    const arrived = contextFromSearch('kanban', kanban!.href.split('?')[1] ?? '');

    strictEqual(arrived.projectId, 3);
    strictEqual(arrived.meetingId, 7);
    // 도착한 화면에서 다시 로비로 돌아올 수 있어야 한다.
    strictEqual(navLinks(arrived).some((l) => l.screen === 'lobby'), true);
  });

  it('모든 링크에 사람이 읽을 이름이 있다', () => {
    for (const link of navLinks({ current: 'home', projectId: 1, meetingId: 2 })) {
      strictEqual(link.label.length > 0, true);
      strictEqual(link.label, labelOf(link.screen));
    }
  });
});

describe('missingLinks', () => {
  it('⭐ 못 가는 이유를 말한다 — 조용히 빼면 화면이 없는 줄 안다', () => {
    const notes = missingLinks({ current: 'record' });
    strictEqual(notes.length, 2);
    strictEqual(notes.some((n) => n.includes('회의')), true);
    strictEqual(notes.some((n) => n.includes('프로젝트')), true);
  });

  it('다 갈 수 있으면 조용하다', () => {
    deepStrictEqual(missingLinks({ current: 'review', projectId: 1, meetingId: 2 }), []);
  });

  it('홈에서는 아무 말도 하지 않는다 — 거기서는 id 가 없는 게 정상이다', () => {
    deepStrictEqual(missingLinks({ current: 'home' }), []);
  });
});

describe('contextFromSearch', () => {
  it('주소에서 id 를 읽는다', () => {
    const context = contextFromSearch('kanban', '?project=3&meeting=7');
    strictEqual(context.projectId, 3);
    strictEqual(context.meetingId, 7);
  });

  it('없으면 null', () => {
    const context = contextFromSearch('home', '');
    strictEqual(context.projectId, null);
    strictEqual(context.meetingId, null);
  });

  it('⭐ 숫자가 아닌 값을 그대로 넘기지 않는다', () => {
    // `Number('abc')` 는 NaN 이고, 그대로 링크에 넣으면 `?project=NaN` 이
    // 만들어진다. 서버는 404 를 주고 사용자는 고장으로 읽는다.
    const context = contextFromSearch('kanban', '?project=abc&meeting=0');
    strictEqual(context.projectId, null);
    strictEqual(context.meetingId, null);
  });
});
