import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
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
