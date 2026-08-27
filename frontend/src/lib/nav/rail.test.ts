import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  appRailHref,
  railAriaLabel,
  railHref,
  railInitial,
  railIsWorthIt,
  railItems,
  type RailProject,
} from './rail.ts';
import { orderProjects, type Project } from '../home/next.ts';

function project(over: Partial<RailProject> = {}): RailProject {
  return { project_id: 1, title: '졸업작품 TeamFlow', needs_review: 0, ...over };
}

// ══════════════════════════════════════════════════════════════
// 자리를 되찾는 조건
// ══════════════════════════════════════════════════════════════

describe('railIsWorthIt', () => {
  it('⭐ 프로젝트가 하나면 레일을 세우지 않는다', () => {
    // 갈 곳이 없는 72px 열은 한 번 걷어낸 그 빈칸입니다 (docs/19 §11).
    strictEqual(railIsWorthIt([]), false);
    strictEqual(railIsWorthIt([project()]), false);
  });

  it('둘부터 세운다 — 그때부터 "다른 데 볼 게 있나" 가 생긴다', () => {
    strictEqual(railIsWorthIt([project({ project_id: 1 }), project({ project_id: 2 })]), true);
  });
});

// ══════════════════════════════════════════════════════════════
// 어디로 가는가
// ══════════════════════════════════════════════════════════════

describe('railHref', () => {
  it('프로젝트 화면이면 그 화면 그대로 다른 프로젝트를 연다', () => {
    strictEqual(railHref('kanban', 7), '/kanban.html?project=7');
    strictEqual(railHref('contributions', 7), '/contributions.html?project=7');
    strictEqual(railHref('project', 7), '/project.html?project=7');
  });

  it('⭐ 회의 화면에서는 그 프로젝트의 칸반으로 — 홈이 아니다', () => {
    // 회의는 프로젝트에 딸려 있어 다른 프로젝트로 그 화면을 열 수 없습니다.
    // 홈으로 보내면 방금 고른 프로젝트가 어디로 갔는지 알 수 없습니다.
    for (const screen of ['lobby', 'review', 'record', 'home'] as const) {
      strictEqual(railHref(screen, 7), '/kanban.html?project=7');
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 네모 안 한 글자
// ══════════════════════════════════════════════════════════════

describe('railInitial', () => {
  it('첫 글자를 쓴다', () => {
    strictEqual(railInitial('졸업작품 TeamFlow'), '졸');
    strictEqual(railInitial('  TeamFlow'), 'T');
  });

  it('⭐ 두 칸짜리 문자를 반으로 자르지 않는다', () => {
    // `'🚀팀'[0]` 은 깨진 반쪽이라 화면에 `` 가 뜹니다.
    strictEqual(railInitial('🚀 로켓팀'), '🚀');
  });

  it('이름이 비면 `?` — 무엇인지 알 수 없는 빈 네모를 만들지 않는다', () => {
    strictEqual(railInitial(''), '?');
    strictEqual(railInitial('   '), '?');
  });
});

// ══════════════════════════════════════════════════════════════
// 자리는 고정, 할 일은 점으로
// ══════════════════════════════════════════════════════════════

describe('railItems', () => {
  it('⭐ 검토거리가 생겨도 자리가 안 바뀐다 — id 순 고정', () => {
    const items = railItems(
      [
        project({ project_id: 3, needs_review: 0 }),
        project({ project_id: 1, needs_review: 9 }),
        project({ project_id: 2, needs_review: 0 }),
      ],
      'kanban',
    );
    deepStrictEqual(items.map((i) => i.projectId), [1, 2, 3]);
  });

  it('⭐ 홈과 순서가 다른 것은 **의도한 것**이다', () => {
    // 홈은 "무엇을 먼저 볼까" 라 할 일 있는 것을 위로 올립니다.
    // 레일은 "어디를 눌러야 하나" 라 자리를 고정합니다. 이 검사는 둘이
    // 정말 다른 답을 내는지 고정합니다 — 어느 날 레일이 홈을 따라가면
    // 사람이 누르던 자리를 잃습니다.
    const raw: Project[] = [
      { project_id: 1, title: 'A', member_count: 1, meeting_count: 1, needs_review: 0 },
      { project_id: 2, title: 'B', member_count: 1, meeting_count: 1, needs_review: 5 },
    ];
    deepStrictEqual(orderProjects(raw).map((p) => p.project_id), [2, 1]);
    deepStrictEqual(
      railItems(raw, 'kanban').map((i) => i.projectId),
      [1, 2],
    );
  });

  it('할 일이 있는지는 있다/없다로만 말한다 — 개수가 아니다', () => {
    const [none, some] = railItems(
      [
        project({ project_id: 1, needs_review: 0 }),
        project({ project_id: 2, needs_review: 4 }),
      ],
      'kanban',
    );
    strictEqual(none?.needsReview, false);
    strictEqual(some?.needsReview, true);
  });

  it('지금 보는 프로젝트 하나만 current 다', () => {
    const items = railItems(
      [project({ project_id: 1 }), project({ project_id: 2 })],
      'kanban',
      2,
    );
    deepStrictEqual(items.filter((i) => i.current).map((i) => i.projectId), [2]);
  });

  it('맥락이 없으면 아무것도 current 가 아니다', () => {
    const items = railItems([project({ project_id: 1 }), project({ project_id: 2 })], 'kanban');
    deepStrictEqual(items.filter((i) => i.current), []);
  });

  it('⚠️ 원본 배열을 뒤집지 않는다', () => {
    // 같은 배열을 홈도 씁니다. 여기서 제자리 정렬하면 홈의 순서가 바뀝니다.
    const raw = [project({ project_id: 3 }), project({ project_id: 1 })];
    railItems(raw, 'kanban');
    deepStrictEqual(raw.map((p) => p.project_id), [3, 1]);
  });
});

describe('railAriaLabel', () => {
  it('⭐ 네모 안 한 글자만으로는 알 수 없는 것을 말로 옮긴다', () => {
    const [item] = railItems([project({ title: '졸업작품 TeamFlow', needs_review: 2 })], 'kanban', 1);
    ok(item);
    const label = railAriaLabel(item);
    ok(label.includes('졸업작품 TeamFlow'), label);
    ok(label.includes('검토'), label);
    ok(label.includes('지금 보는'), label);
  });

  it('할 일도 없고 현재도 아니면 이름만 읽는다', () => {
    const [item] = railItems([project({ title: '옆 팀' })], 'kanban');
    ok(item);
    strictEqual(railAriaLabel(item), '옆 팀');
  });
});

describe('appRailHref — 같은 판단, SPA 주소 (베타 QA)', () => {
  it('⭐ basename 을 적지 않는다 — 라우터가 붙이므로 적으면 `/app/app/…` 이 된다', () => {
    strictEqual(appRailHref('kanban', 7), '/project/7/kanban');
    strictEqual(appRailHref('contributions', 7), '/project/7/contributions');
  });

  it('⭐ 설정은 구역까지 — `/settings` 만 주면 라우터가 한 번 더 튕긴다', () => {
    strictEqual(appRailHref('project', 7), '/project/7/settings/role');
  });

  it('⭐ 홈은 홈에 머무른다 — SPA 홈은 프로젝트 하나의 계기판이다', () => {
    // ⚠️ 옛 셸(`railHref`)과 **일부러 다릅니다.** 옛 홈은 모든 프로젝트를
    //    늘어놓는 화면이라 고른 직후 홈으로 보내면 어디 있는지 몰랐습니다.
    strictEqual(appRailHref('home', 7), '/?project=7');
    strictEqual(railHref('home', 7), '/kanban.html?project=7');
  });

  it('회의 화면에서 프로젝트를 바꾸면 그 프로젝트의 칸반으로', () => {
    for (const screen of ['lobby', 'review', 'record', 'chat'] as const) {
      strictEqual(appRailHref(screen, 7), '/project/7/kanban', screen);
    }
  });
});

describe('railItems — 주소 만드는 법만 갈아 끼운다', () => {
  it('⭐ 셸이 달라도 목록·순서·머리글자는 한 벌이다', () => {
    const raw = [project({ project_id: 2, title: '옆 팀' }), project({ project_id: 1, title: '졸업작품' })];
    const legacy = railItems(raw, 'kanban', 1);
    const spa = railItems(raw, 'kanban', 1, appRailHref);
    deepStrictEqual(spa.map((i) => i.projectId), legacy.map((i) => i.projectId));
    deepStrictEqual(spa.map((i) => i.initial), legacy.map((i) => i.initial));
    deepStrictEqual(spa.map((i) => i.current), legacy.map((i) => i.current));
    // 다른 것은 주소뿐.
    deepStrictEqual(spa.map((i) => i.href), ['/project/1/kanban', '/project/2/kanban']);
    deepStrictEqual(legacy.map((i) => i.href), ['/kanban.html?project=1', '/kanban.html?project=2']);
  });

  it('넘기지 않으면 옛 주소 — 이미 쓰는 화면이 안 깨진다', () => {
    strictEqual(railItems([project({ project_id: 3 })], 'kanban')[0]?.href, '/kanban.html?project=3');
  });
});
