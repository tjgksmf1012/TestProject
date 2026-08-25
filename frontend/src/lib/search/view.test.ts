import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  blockedReason,
  canSearch,
  describeKind,
  excerpt,
  filterScopeNote,
  groupByKind,
  hrefFor,
  KINDS,
  type Hit,
} from './view.ts';

function hit(over: Partial<Hit> = {}): Hit {
  return {
    kind: 'task',
    task_id: 7,
    meeting_id: null,
    title: '로그인 API 구현',
    body: '',
    at: null,
    who: '김민수',
    status: '할 일',
    ...over,
  };
}

describe('보이는 모양', () => {
  it('종류를 한 단어로', () => {
    strictEqual(describeKind('utterance'), '회의 내용');
  });

  it('⚠️ 모르는 종류를 지어내지 않는다', () => {
    strictEqual(describeKind('sprint'), 'sprint');
  });

  it('⭐ 종류 순서는 고정 — 건수 순이 아니다', () => {
    const groups = groupByKind([
      hit({ kind: 'github', task_id: null }),
      hit({ kind: 'task' }),
      hit({ kind: 'task' }),
    ]);
    deepStrictEqual(
      groups.map((g) => g.kind),
      ['task', 'github'],
    );
  });

  it('빈 종류는 안 그린다', () => {
    strictEqual(groupByKind([hit()]).length, 1);
  });
});

describe('대목 자르기', () => {
  it('짧으면 그대로', () => {
    strictEqual(excerpt('짧은 말', '말'), '짧은 말');
  });

  it('⭐ 찾은 낱말이 **보이게** 가운데를 자른다', () => {
    const body = '가'.repeat(200) + '토큰만료' + '나'.repeat(200);
    const cut = excerpt(body, '토큰만료');
    strictEqual(cut.includes('토큰만료'), true);
    strictEqual(cut.startsWith('…'), true);
    strictEqual(cut.endsWith('…'), true);
  });

  it('못 찾으면 앞에서 자르고 티를 낸다', () => {
    const cut = excerpt('가'.repeat(200), '없는말');
    strictEqual(cut.endsWith('…'), true);
  });
});

describe('갈 곳', () => {
  it('회의 내용은 검토 화면으로 — 원문이 거기 있다', () => {
    strictEqual(
      hrefFor(hit({ kind: 'utterance', task_id: null, meeting_id: 9 }), 3),
      '/review.html?meeting=9',
    );
  });

  it('회의는 로비로', () => {
    strictEqual(
      hrefFor(hit({ kind: 'meeting', task_id: null, meeting_id: 9 }), 3),
      '/lobby.html?meeting=9&project=3',
    );
  });

  it('업무는 칸반으로', () => {
    strictEqual(hrefFor(hit(), 3), '/kanban.html?project=3');
  });

  it('⭐ GitHub 은 갈 곳이 없다 — 추측 주소를 링크로 걸지 않는다', () => {
    strictEqual(hrefFor(hit({ kind: 'github', task_id: null }), 3), null);
  });
});

describe('찾을 수 있는가', () => {
  const none = { assignee: '', status: '' };

  it('두 글자면 찾는다', () => {
    strictEqual(canSearch('로그', none), true);
    strictEqual(canSearch('로', none), false);
  });

  it('글자가 없어도 담당자나 상태만으로 찾는다', () => {
    strictEqual(canSearch('', { assignee: '3', status: '' }), true);
    strictEqual(canSearch('', { assignee: '', status: 'review' }), true);
  });

  it('한 글자만 적었으면 **왜 안 되는지** 말한다', () => {
    strictEqual(blockedReason('로', none), '두 글자 이상 적거나, 업무 담당자·상태를 고르세요.');
  });

  it('아무것도 안 적었으면 조용하다 — 설명할 것이 없다', () => {
    strictEqual(blockedReason('', none), null);
  });
});

// ══════════════════════════════════════════════════════════════
// 거를 칸이 없는 화면 (채팅의 대화 찾기) — 결함 375
// ══════════════════════════════════════════════════════════════

describe('거를 칸이 없는 화면', () => {
  it('⭐ 두 글자면 찾을 수 있다', () => {
    strictEqual(canSearch('로그', null), true);
  });

  it('⭐ 필터가 없으면 필터로 열리지 않는다', () => {
    /* `null` 은 「이 화면에는 거를 칸이 없다」는 뜻입니다. 빈 필터 객체와
       달리, 없는 칸으로 게이트가 열리는 일이 없어야 합니다. */
    strictEqual(canSearch('로', null), false);
    strictEqual(canSearch('', null), false);
  });

  it('⭐ **한 글자**일 때만 말한다 — 빈 칸에는 placeholder 가 이미 있다', () => {
    strictEqual(blockedReason('', null), null);
    strictEqual(blockedReason('로', null), '두 글자 이상 적어 주세요.');
    strictEqual(blockedReason('로그', null), null);
  });

  it('⭐ **없는 칸을 하라고 시키지 않는다** — 담당자·상태를 말하지 않는다', () => {
    /* 채팅에는 담당자·상태 칸이 없습니다. 찾기 화면의 문장을 그대로
       쓰면 화면에 없는 것을 하라고 시킵니다(결함 313 의 모양). */
    const said = blockedReason('로', null) ?? '';
    ok(!said.includes('담당자'), `없는 칸을 말합니다: ${said}`);
    ok(!said.includes('상태'), `없는 칸을 말합니다: ${said}`);
  });

  it('⭐ 거를 칸이 **있는** 화면은 그 칸을 말한다', () => {
    const none = { assignee: '', status: '' };
    strictEqual(blockedReason('로', none), '두 글자 이상 적거나, 업무 담당자·상태를 고르세요.');
  });
});

describe('⭐ 거르개가 **어디까지 걸렸는지** 말한다 (결함 390)', () => {
  const groups = (...kinds: string[]): { kind: string }[] => kinds.map((kind) => ({ kind }));

  it('업무만 나왔으면 할 말이 없다', () => {
    strictEqual(filterScopeNote({ assignee: '1', status: '' }, groups('task')), null);
  });

  it('거르개를 안 걸었으면 할 말이 없다', () => {
    strictEqual(filterScopeNote({ assignee: '', status: '' }, groups('task', 'meeting')), null);
  });

  it('거를 칸이 없는 화면에서는 할 말이 없다 — 채팅 (결함 313 의 모양)', () => {
    strictEqual(filterScopeNote(null, groups('meeting', 'utterance')), null);
  });

  it('⛔ 안 걸린 묶음이 있으면 **그 묶음을 이름으로** 든다', () => {
    strictEqual(
      filterScopeNote({ assignee: '1', status: '' }, groups('meeting', 'utterance')),
      '담당자·상태는 업무에만 걸립니다 — 회의·회의 내용에는 안 걸렸습니다.',
    );
    strictEqual(
      filterScopeNote({ assignee: '', status: 'todo' }, groups('task', 'github')),
      '담당자·상태는 업무에만 걸립니다 — GitHub에는 안 걸렸습니다.',
    );
  });

  it('⭐ 어느 종류가 와도 조사가 어긋나지 않는다 (결함 88)', () => {
    // 「회의」는 받침이 없고 「회의 내용」은 있습니다. `에는` 은 둘 다 맞습니다.
    for (const kind of KINDS) {
      if (kind === 'task') continue;
      const said = filterScopeNote({ assignee: '1', status: '' }, groups(kind));
      ok(said !== null, `${kind} 에 대해 아무 말도 안 합니다`);
      ok(
        said.includes(`${describeKind(kind)}에는`),
        `조사가 이름에 안 붙었습니다: ${said}`,
      );
    }
  });

  it('⭐ 이 화면이 **말할 수 있는 종류를 전부** 덮는다', () => {
    // 낱개 사례를 늘리는 대신 `KINDS` 전수를 돕니다 — 다섯째가 생기면
    // 그때 이 검사가 먼저 웁니다 (결함 326 의 방법).
    const said = filterScopeNote({ assignee: '1', status: '' }, groups(...KINDS));
    ok(said !== null);
    // ⚠️ **줄표 뒤**만 봅니다. 앞부분은 「업무에만 걸립니다」라서 '업무' 가
    //    언제나 들어 있습니다 — 문장 전체로 재면 아무것도 안 재는 자가 됩니다.
    const listed = said.split('—')[1] ?? '';
    for (const kind of KINDS) {
      if (kind === 'task') continue;
      ok(listed.includes(describeKind(kind)), `${kind} 이 빠졌습니다: ${said}`);
    }
    ok(!listed.includes(describeKind('task')), `업무는 걸린 쪽입니다: ${said}`);
  });
});
