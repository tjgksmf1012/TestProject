import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  contextFromSearch,
  labelOf,
  missingLinks,
  navLinks,
  navTabs,
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

  it('프로젝트를 알면 채팅·일정·알림·활동·칸반·기여도·보고서·설정으로 갈 수 있다', () => {
    const screens = navLinks({ current: 'home', projectId: 3 }).map((l) => l.screen);
    deepStrictEqual(screens.sort(), [
      'activity',
      'calendar',
      'chat',
      'contributions',
      'kanban',
      'notifications',
      'project',
      'reports',
    ]);
  });

  it('⭐ 채팅으로 가는 링크가 있다 — 채널이 없는 사람도 만들러 갈 수 있어야 한다', () => {
    // 채널은 셸의 왼쪽 열에서도 갈 수 있지만, 그 목록은 **회의**를 세웁니다.
    // 텍스트 채널이 아직 하나도 없는 팀에게는 이 링크가 유일한 문입니다.
    const link = navLinks({ current: 'kanban', projectId: 3 }).find((l) => l.screen === 'chat');
    strictEqual(link?.href, '/chat.html?project=3');
  });

  it('⚠️ 보고서가 생겨도 **탭은 넷 그대로**다', () => {
    // 사람은 자리를 기억해서 누릅니다. 다섯째가 끼면 그때까지 넷째였던
    // 것을 누르려던 손이 엉뚱한 화면으로 갑니다.
    const tabs = navTabs({ current: 'home', projectId: 3 }).map((t) => t.screen);
    deepStrictEqual(tabs, ['home', 'kanban', 'contributions', 'project']);
  });

  it('⭐ 설정 화면으로 가는 링크가 있다 — 회의를 여는 곳이 거기뿐이다', () => {
    // 이 링크가 없으면 프로젝트를 만들어 놓고도 회의를 열 방법이 없다.
    const link = navLinks({ current: 'kanban', projectId: 3 }).find(
      (l) => l.screen === 'project',
    );
    strictEqual(link?.href, '/project.html?project=3');
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

describe('navTabs', () => {
  it('⭐ 언제나 같은 순서로 넷 — 사람은 자리를 기억해서 누른다', () => {
    // 상황에 따라 탭이 사라지면 같은 자리에 다른 것이 오고,
    // 눌렀을 때 엉뚱한 화면으로 간다.
    const withProject = navTabs({ current: 'home', projectId: 3 }).map((t) => t.screen);
    const without = navTabs({ current: 'home' }).map((t) => t.screen);
    deepStrictEqual(withProject, ['home', 'kanban', 'contributions', 'project']);
    deepStrictEqual(without, withProject);
  });

  it('⭐ 못 가는 탭을 숨기지 않고 이유를 준다', () => {
    // 숨기면 사람은 그 화면이 **없는 줄** 안다.
    const tabs = navTabs({ current: 'home' });
    const kanban = tabs.find((t) => t.screen === 'kanban');
    strictEqual(kanban?.enabled, false);
    strictEqual(typeof kanban?.blockedReason, 'string');
    strictEqual(kanban?.blockedReason?.length ? true : false, true);
  });

  it('⭐ 못 가는 탭에는 주소를 주지 않는다', () => {
    // 주면 눌렸을 때 `?project=null` 로 가고, 서버는 404 를 주고,
    // 사람은 화면이 고장 났다고 읽는다.
    const kanban = navTabs({ current: 'home' }).find((t) => t.screen === 'kanban');
    strictEqual(kanban?.href, '');
  });

  it('홈은 언제나 갈 수 있다 — 어디서든 빠져나올 곳이 하나는 있어야 한다', () => {
    strictEqual(navTabs({ current: 'kanban' }).find((t) => t.screen === 'home')?.enabled, true);
  });

  it('지금 화면을 표시한다 — 어디 있는지 보여야 한다', () => {
    const tabs = navTabs({ current: 'contributions', projectId: 3 });
    deepStrictEqual(
      tabs.filter((t) => t.current).map((t) => t.screen),
      ['contributions'],
    );
  });

  it('회의 id 를 들고 간다 — 칸반에서 그 회의로 돌아올 수 있어야 한다', () => {
    const tabs = navTabs({ current: 'home', projectId: 3, meetingId: 7 });
    strictEqual(tabs.find((t) => t.screen === 'kanban')?.href.includes('meeting=7'), true);
  });

  it('설정 탭은 회의 id 를 들고 가지 않는다 — 프로젝트 단위 화면이다', () => {
    const tabs = navTabs({ current: 'home', projectId: 3, meetingId: 7 });
    strictEqual(tabs.find((t) => t.screen === 'project')?.href, '/project.html?project=3');
  });

  it('탭마다 그림이 있다 — 글자만 있으면 폰에서 잘 안 보인다', () => {
    for (const tab of navTabs({ current: 'home', projectId: 1 })) {
      strictEqual(tab.icon.length > 0, true, tab.screen);
      strictEqual(tab.icon, tab.icon.trim());
    }
  });

  it('⭐ 회의 화면은 탭이 아니다', () => {
    // 로비·검토·녹음은 "지금 이 회의" 안에서만 뜻이 있다. 늘 보이는
    // 자리에 두면 **어느 회의인지 모르는 채로** 눌린다.
    const screens = navTabs({ current: 'home', projectId: 1, meetingId: 2 }).map(
      (t) => t.screen,
    );
    for (const scoped of ['lobby', 'review', 'record']) {
      strictEqual(screens.includes(scoped as never), false, scoped);
    }
  });
});
