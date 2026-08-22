import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TEAM_TIMEZONE, teamDateOf } from '../time/calendar.ts';

import {
  countText,
  daysBetween,
  describeLinkState,
  describePull,
  describeStatus,
  isDueSoon,
  isOverdue,
  moveDirection,
  nextStatuses,
  sortForBoard,
  sortLinks,
  statusPatch,
  summarize,
  taskWarnings,
  toColumns,
  type Task,
  type TaskGithubLink,
  emptyBoard,
  emptyBoardLine,
  unknownOriginNote,
} from './board.ts';

const TODAY = '2026-09-10';
const STATUSES = ['todo', 'in_progress', 'done'];

function task(over: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: '로그인 API 구현',
    assignee_ids: [1],
    status: 'todo',
    priority: 2,
    deadline: '2026-09-20',
    completed_at: null,
    origin: null,
    marker: 'TASK-1',
    github: [],
    ...over,
  };
}

const ORIGIN = {
  candidate_id: 7,
  meeting_id: 3,
  meeting_title: '1주차 정기회의',
  evidence_utterance_ids: [11, 12],
};

// ══════════════════════════════════════════════════════════════
// 열
// ══════════════════════════════════════════════════════════════

describe('toColumns', () => {
  it('상태별로 나눈다', () => {
    const columns = toColumns(
      [task({ id: 1 }), task({ id: 2, status: 'done' }), task({ id: 3, status: 'done' })],
      STATUSES,
    );
    deepStrictEqual(columns.map((c) => c.tasks.length), [1, 0, 2]);
    deepStrictEqual(columns.map((c) => c.status), STATUSES);
  });

  it('빈 열도 남긴다 — 사라지면 옮길 곳이 없어진다', () => {
    strictEqual(toColumns([], STATUSES).length, 3);
  });

  it('⭐ 모르는 상태의 업무를 버리지 않는다', () => {
    // 칸반에서 사라진 업무는 "없는 업무" 로 읽힌다.
    const columns = toColumns([task({ id: 9, status: 'archived' })], STATUSES);
    strictEqual(columns.length, 4);
    strictEqual(columns[3]?.tasks[0]?.id, 9);
    strictEqual(columns[3]?.label.includes('알 수 없는'), true);
  });

  it('모르는 상태가 없으면 여분의 열도 없다', () => {
    strictEqual(toColumns([task()], STATUSES).length, 3);
  });

  it('열 이름을 한국어로 — 모르는 것은 그대로', () => {
    strictEqual(describeStatus('in_progress'), '진행 중');
    strictEqual(describeStatus('archived'), 'archived');
  });
});

// ══════════════════════════════════════════════════════════════
// 순서
// ══════════════════════════════════════════════════════════════

describe('sortForBoard', () => {
  it('마감일이 이른 것부터', () => {
    const sorted = sortForBoard([
      task({ id: 1, deadline: '2026-09-30' }),
      task({ id: 2, deadline: '2026-09-11' }),
    ]);
    deepStrictEqual(sorted.map((t) => t.id), [2, 1]);
  });

  it('⭐ 마감일 없는 업무는 뒤로 — 급한 것이 밀리면 안 된다', () => {
    const sorted = sortForBoard([
      task({ id: 1, deadline: null }),
      task({ id: 2, deadline: '2026-12-31' }),
    ]);
    deepStrictEqual(sorted.map((t) => t.id), [2, 1]);
  });

  it('마감일이 같으면 id 순 — 새로고침할 때마다 움직이면 안 된다', () => {
    const sorted = sortForBoard([task({ id: 5 }), task({ id: 2 })]);
    deepStrictEqual(sorted.map((t) => t.id), [2, 5]);
  });

  it('원본을 바꾸지 않는다', () => {
    const tasks = [task({ id: 5 }), task({ id: 2 })];
    sortForBoard(tasks);
    deepStrictEqual(tasks.map((t) => t.id), [5, 2]);
  });
});

// ══════════════════════════════════════════════════════════════
// 마감
// ══════════════════════════════════════════════════════════════

describe('isOverdue', () => {
  it('마감일이 지났으면 지연', () => {
    strictEqual(isOverdue(task({ deadline: '2026-09-09' }), TODAY), true);
  });

  it('오늘이 마감이면 아직 지연이 아니다', () => {
    strictEqual(isOverdue(task({ deadline: TODAY }), TODAY), false);
  });

  it('마감일이 없으면 지연이 없다', () => {
    strictEqual(isOverdue(task({ deadline: null }), TODAY), false);
  });

  it('⭐ 완료된 업무는 **완료 시점** 으로 판단한다', () => {
    // 오늘 날짜로 보면 지난달에 제때 끝낸 업무가 시간이 갈수록 "지연" 이 된다.
    const onTime = task({
      status: 'done',
      deadline: '2026-09-01',
      completed_at: '2026-08-31T10:00:00Z',
    });
    strictEqual(isOverdue(onTime, TODAY), false);

    const late = task({
      status: 'done',
      deadline: '2026-09-01',
      completed_at: '2026-09-03T10:00:00Z',
    });
    strictEqual(isOverdue(late, TODAY), true);
  });

  it('⭐ 마감 다음날 새벽에 끝낸 것은 지연이다', () => {
    // 서버는 `completed_at` 을 UTC 순간으로 주고 `deadline` 은 달력 날짜로
    // 준다. 앞 10자를 자르면 UTC 달력일이 나오는데, 한국 시각 9월 5일
    // 01:00 은 UTC 로 9월 4일이다 — 그대로 비교하면 마감 9월 4일을 넘긴
    // 업무가 "제때" 로 읽힌다. 오차가 한쪽으로만 나서 **지연을 과소보고만
    // 한다.**
    const late = task({
      status: 'done',
      deadline: '2026-09-04',
      completed_at: '2026-09-04T16:00:00Z', // KST 09-05 01:00
    });
    strictEqual(teamDateOf('2026-09-04T16:00:00Z'), '2026-09-05');
    strictEqual(isOverdue(late, TODAY), true);

    // 같은 날 안에서 끝낸 것은 지연이 아니다 (KST 09-04 23:00).
    const onTime = task({
      status: 'done',
      deadline: '2026-09-04',
      completed_at: '2026-09-04T14:00:00Z',
    });
    strictEqual(isOverdue(onTime, TODAY), false);
  });

  it('⭐ 보는 사람의 시간대를 바꿔도 판정이 달라지지 않는다 (결함 109)', () => {
    // 예전에는 `Date#getFullYear()` 를 썼다 — **보는 사람의 달력**이다.
    // 그래서 같은 업무가 서울에서는 "지연", 뉴욕에서는 "제때" 였다.
    // 서버는 결함 107 을 고치며 팀 달력 하나를 정했는데 화면은 몰랐다.
    const late = task({
      status: 'done',
      deadline: '2026-09-04',
      completed_at: '2026-09-04T16:00:00Z',
    });

    const previous = process.env.TZ;
    try {
      for (const zone of ['Asia/Seoul', 'America/New_York', 'UTC', 'Pacific/Kiritimati']) {
        process.env.TZ = zone;
        strictEqual(teamDateOf('2026-09-04T16:00:00Z'), '2026-09-05', zone);
        strictEqual(isOverdue(late, TODAY), true, zone);
      }
    } finally {
      process.env.TZ = previous;
    }
  });

  it('팀 달력은 한국 시간이다 — 서버 `project_timezone` 과 같은 값', () => {
    strictEqual(TEAM_TIMEZONE, 'Asia/Seoul');
  });

  it('완료 시각이 이상한 문자열이면 지연으로 몰지 않는다', () => {
    strictEqual(
      isOverdue(task({ status: 'done', deadline: '2026-09-01', completed_at: 'x' }), TODAY),
      false,
    );
    strictEqual(teamDateOf('x'), null);
  });

  it('완료됐는데 완료 시각이 없으면 지연으로 몰지 않는다', () => {
    strictEqual(
      isOverdue(task({ status: 'done', deadline: '2026-09-01', completed_at: null }), TODAY),
      false,
    );
  });
});

describe('isDueSoon', () => {
  it('이틀 안이면 임박', () => {
    strictEqual(isDueSoon(task({ deadline: '2026-09-12' }), TODAY), true);
  });

  it('사흘 뒤면 아직 아니다', () => {
    strictEqual(isDueSoon(task({ deadline: '2026-09-13' }), TODAY), false);
  });

  it('⭐ 이미 지난 것은 임박이 아니다 — 문구가 다르다', () => {
    strictEqual(isDueSoon(task({ deadline: '2026-09-01' }), TODAY), false);
  });

  it('완료된 업무는 재촉하지 않는다', () => {
    strictEqual(isDueSoon(task({ deadline: TODAY, status: 'done' }), TODAY), false);
  });
});

describe('daysBetween', () => {
  it('일수를 센다', () => {
    strictEqual(daysBetween('2026-09-10', '2026-09-13'), 3);
    strictEqual(daysBetween('2026-09-10', '2026-09-10'), 0);
  });

  it('⭐ 월·연 경계를 넘어도 맞는다', () => {
    strictEqual(daysBetween('2026-08-30', '2026-09-01'), 2);
    strictEqual(daysBetween('2026-12-31', '2027-01-01'), 1);
  });

  it('망가진 값에서 터지지 않는다', () => {
    strictEqual(daysBetween('아무거나', '2026-09-10'), 0);
  });
});

// ══════════════════════════════════════════════════════════════
// 경고
// ══════════════════════════════════════════════════════════════

describe('taskWarnings', () => {
  it('정상이면 조용하다', () => {
    deepStrictEqual(taskWarnings(task({ deadline: '2026-12-31' }), TODAY), []);
  });

  it('⭐ 담당자가 없으면 기여도에 안 잡힌다고 말한다', () => {
    // 서버가 실제로 그렇게 동작한다 (task_service._record_completion).
    // 화면이 말해 주지 않으면 사람은 완료했으니 반영됐다고 생각한다.
    const warnings = taskWarnings(task({ assignee_ids: [], deadline: '2026-12-31' }), TODAY);
    strictEqual(warnings.length, 1);
    strictEqual(warnings[0]?.includes('기여도에 반영되지 않습니다'), true);
  });

  it('지난 마감과 임박한 마감의 문구가 다르다', () => {
    const late = taskWarnings(task({ deadline: '2026-09-01' }), TODAY);
    const soon = taskWarnings(task({ deadline: '2026-09-11' }), TODAY);
    strictEqual(late[0]?.includes('지났습니다'), true);
    strictEqual(soon[0]?.includes('1일 남았습니다'), true);
  });

  it('오늘 마감은 그렇게 말한다', () => {
    strictEqual(taskWarnings(task({ deadline: TODAY }), TODAY)[0], '오늘이 마감입니다');
  });

  it('⭐ 늦게 완료한 것도 말한다 — 완료했다고 덮이면 안 된다', () => {
    const warnings = taskWarnings(
      task({ status: 'done', deadline: '2026-09-01', completed_at: '2026-09-05T00:00:00Z' }),
      TODAY,
    );
    strictEqual(warnings[0]?.includes('늦게 완료'), true);
  });

  it('회의에서 나오지 않은 업무는 경고가 아니다', () => {
    // 사람이 손으로 만든 업무는 정상이다.
    deepStrictEqual(taskWarnings(task({ origin: null, deadline: '2026-12-31' }), TODAY), []);
  });
});

// ══════════════════════════════════════════════════════════════
// 요약과 이동
// ══════════════════════════════════════════════════════════════

describe('summarize', () => {
  it('⭐ 회의에서 나온 업무 수를 센다 — 이 프로젝트의 주장이 도는지의 숫자', () => {
    const summary = summarize(
      [
        task({ id: 1, origin: ORIGIN }),
        task({ id: 2, origin: null }),
        task({ id: 3, origin: ORIGIN, status: 'done', completed_at: '2026-09-01T00:00:00Z' }),
      ],
      TODAY,
    );
    strictEqual(summary.total, 3);
    strictEqual(summary.fromMeetings, 2);
    strictEqual(summary.done, 1);
  });

  it('지연과 미배정을 센다', () => {
    const summary = summarize(
      [task({ id: 1, deadline: '2026-09-01' }), task({ id: 2, assignee_ids: [] })],
      TODAY,
    );
    strictEqual(summary.overdue, 1);
    strictEqual(summary.unassigned, 1);
  });

  it('빈 보드에서 0 을 돌려준다', () => {
    deepStrictEqual(summarize([], TODAY), {
      total: 0,
      done: 0,
      overdue: 0,
      fromMeetings: 0,
      unassigned: 0,
      withPulls: 0,
    });
  });
});

describe('nextStatuses', () => {
  it('지금 상태는 빼고 준다', () => {
    deepStrictEqual(nextStatuses(task({ status: 'todo' }), STATUSES), [
      'in_progress',
      'done',
    ]);
  });

  it('모르는 상태여도 옮길 곳은 전부 준다', () => {
    deepStrictEqual(nextStatuses(task({ status: 'archived' }), STATUSES), STATUSES);
  });
});

describe('moveDirection (브리프 §14)', () => {
  it('뒤 칸으로 가면 앞으로다', () => {
    strictEqual(moveDirection('todo', 'in_progress', STATUSES), 'forward');
    strictEqual(moveDirection('todo', 'done', STATUSES), 'forward');
    strictEqual(moveDirection('in_progress', 'done', STATUSES), 'forward');
  });

  it('앞 칸으로 가면 되돌리는 것이다', () => {
    strictEqual(moveDirection('done', 'todo', STATUSES), 'back');
    strictEqual(moveDirection('in_progress', 'todo', STATUSES), 'back');
  });

  it('⭐ 이름이 아니라 **배열 순서**로 판단한다', () => {
    // 상태 이름은 서버가 줍니다. 여기서 `done` 을 글자로 찾으면 그
    // 순간 두 벌이 되고, 프로젝트마다 다른 이름을 쓰면 조용히 틀립니다.
    const 우리말 = ['접수', '작업중', '끝'];
    strictEqual(moveDirection('접수', '끝', 우리말), 'forward');
    strictEqual(moveDirection('끝', '접수', 우리말), 'back');
  });

  it('⭐ 모르는 상태는 **조용한 쪽**으로 둔다', () => {
    // 앞으로 가는 것처럼 강조해 놓고 실제로는 어디로 가는지 모르는 것보다,
    // 되돌리기로 그리는 편이 안전합니다.
    strictEqual(moveDirection('archived', 'done', STATUSES), 'back');
    strictEqual(moveDirection('todo', 'archived', STATUSES), 'back');
  });

  it('같은 자리로는 앞으로가 아니다', () => {
    strictEqual(moveDirection('done', 'done', STATUSES), 'back');
  });
});

describe('statusPatch', () => {
  it('⭐ deadline 키를 넣지 않는다', () => {
    // 서버는 키가 있으면 "마감일을 바꾼다" 로 읽는다. `deadline: null` 이
    // 실려 가면 상태만 바꾸려던 요청이 **마감일을 조용히 지운다.**
    const body = statusPatch('done');
    deepStrictEqual(body, { status: 'done' });
    strictEqual('deadline' in body, false);
  });
});

// ══════════════════════════════════════════════════════════════
// GitHub 연결 — docs/08 §5.1 필수 경로의 마지막 눈에 보이는 칸
// ══════════════════════════════════════════════════════════════

function link(over: Partial<TaskGithubLink> = {}): TaskGithubLink {
  return {
    event_id: 1,
    repo: 'team/teamflow',
    number: 42,
    title: '로그인 API',
    actor_login: 'minsu-dev',
    merged_at: '2026-09-01T12:00:00Z',
    relevance: 1,
    confirmed: true,
    why: 'PR 에 TASK 번호가 적혀 있습니다',
    ...over,
  };
}

describe('describePull', () => {
  it('저장소#번호 제목', () => {
    strictEqual(describePull(link()), 'team/teamflow#42 로그인 API');
  });

  it('번호를 모르면 저장소만', () => {
    strictEqual(describePull(link({ number: null, title: null })), 'team/teamflow');
  });
});

describe('sortLinks', () => {
  it('⭐ 확정이 추정보다 위에 온다', () => {
    // 사람은 위에서부터 읽는다. 추정이 위에 있으면 그게 사실로 보인다.
    const sorted = sortLinks([
      link({ event_id: 1, relevance: 0.3, confirmed: false }),
      link({ event_id: 2, relevance: 1, confirmed: true }),
    ]);
    deepStrictEqual(
      sorted.map((l) => l.event_id),
      [2, 1],
    );
  });

  it('같은 확신도면 최근 것이 위', () => {
    const sorted = sortLinks([
      link({ event_id: 1, merged_at: '2026-09-01T00:00:00Z' }),
      link({ event_id: 2, merged_at: '2026-09-05T00:00:00Z' }),
    ]);
    deepStrictEqual(
      sorted.map((l) => l.event_id),
      [2, 1],
    );
  });

  it('원본을 건드리지 않는다', () => {
    const original = [link({ event_id: 1, relevance: 0.3 }), link({ event_id: 2 })];
    sortLinks(original);
    deepStrictEqual(
      original.map((l) => l.event_id),
      [1, 2],
    );
  });
});

describe('describeLinkState', () => {
  it('⭐ 붙은 게 없으면 무엇을 적어야 하는지 알려준다', () => {
    // ⚠️ 여기서 침묵하면 아무도 표식을 안 적고, 자동 연결은 영영 안 일어난다.
    const text = describeLinkState(task({ marker: 'TASK-7' }));
    strictEqual(text.includes('TASK-7'), true);
  });

  it('전부 확정이면 건수만', () => {
    strictEqual(describeLinkState(task({ github: [link(), link()] })), 'PR 2건');
  });

  it('⭐ 전부 추정이면 확인이 필요하다고 말한다', () => {
    const text = describeLinkState(
      task({ github: [link({ confirmed: false, relevance: 0.3 })] }),
    );
    strictEqual(text.includes('추정'), true);
    strictEqual(text.includes('확인'), true);
  });

  it('섞여 있으면 몇 건씩인지', () => {
    const text = describeLinkState(
      task({ github: [link(), link({ confirmed: false, relevance: 0.6 })] }),
    );
    strictEqual(text, 'PR 2건 (확정 1 · 추정 1)');
  });

  it('서버가 github 를 안 보내도 터지지 않는다', () => {
    const broken = task();
    delete (broken as { github?: TaskGithubLink[] }).github;
    strictEqual(describeLinkState(broken).includes('없습니다'), true);
  });
});

describe('summarize — withPulls', () => {
  it('⭐ 회의→업무→GitHub 이 끝까지 도는 업무가 몇 개인가', () => {
    const summary = summarize(
      [task({ id: 1, github: [link()] }), task({ id: 2 }), task({ id: 3, github: [link()] })],
      TODAY,
    );
    strictEqual(summary.withPulls, 2);
  });
});

describe('countText — 못 잰 것을 0 으로 말하지 않는다 (불변식 셋째)', () => {
  it('⭐ 아직 모르면 `—`', () => {
    // 칸반 머리말이 불러오는 중에 `회의에서 0 · PR 연결 0 · 지연 0` 이라고
    // **단언**하고 있었습니다. 같은 화면의 사슬은 `—` 를 그리는데.
    strictEqual(countText(null), '—');
    strictEqual(countText(undefined), '—');
  });

  it('⭐ **진짜 0 은 0 입니다** — 모르는 것과 없는 것은 다릅니다', () => {
    strictEqual(countText(0), '0');
  });

  it('숫자는 그대로', () => {
    strictEqual(countText(3), '3');
  });
});

describe('업무가 없을 때 뭐라고 적는가 (결함 313)', () => {
  it('⛔ 「직접 만들」 길이 있다고 하지 않는다 — 이 제품에 그 길은 없다', () => {
    /* 재서 확인한 것: 갓 만든 프로젝트의 레거시 칸반에서 보이는 컨트롤
       열셋을 전부 세었는데 업무를 만드는 것이 하나도 없었습니다. 서버도
       같습니다 — `approval_service.py` 가 유일한 자리이고 그 옆에
       「승인 없이 tasks 에 쓰는 경로는 없다 — 그게 불변식이다」. */
    const empty = emptyBoard();
    const all = `${empty.what} ${empty.why} ${empty.how}`;
    ok(!/직접 만들 수/.test(all), all);
    ok(/승인/.test(all), `업무가 어디서 오는지 안 적습니다: ${all}`);
  });

  it('⭐ **왜** 그 길이 없는지 적는다 — 「안 됩니다」만 적으면 고장처럼 읽힌다', () => {
    ok(/일부러/.test(emptyBoard().why), emptyBoard().why);
  });

  it('⛔ 마크다운 별표를 쓰지 않는다 — 이 자리는 글자 그대로 그려진다 (결함 292)', () => {
    const empty = emptyBoard();
    for (const [key, text] of Object.entries(empty)) {
      ok(!/\*\*/.test(text), `${key} 에 별표가 있습니다: ${text}`);
    }
    ok(!/\*\*/.test(emptyBoardLine()), emptyBoardLine());
  });

  it('⭐ 한 줄짜리와 세 줄짜리가 **같은 사실**을 말한다 — 두 화면이 갈라지지 않게', () => {
    // 레거시는 세 줄, SPA 는 한 줄입니다. 갈라지면 결함 313 이 그대로입니다.
    ok(emptyBoardLine().includes(emptyBoard().how), `${emptyBoardLine()} ↔ ${emptyBoard().how}`);
  });
});

describe('출처 기록이 없는 카드 (결함 317)', () => {
  it('⛔ 「손으로 만들었다」고 **단언하지 않는다** — 그 길은 없다', () => {
    /* 결함 313 의 셋째·넷째 자리입니다. 레거시 카드 서랍과 SPA 카드 힌트가
       `task.origin` 이 비면 「사람이 손으로 만든 업무입니다」라고 적었습니다. */
    const note = unknownOriginNote();
    ok(!/(직접|손으로|수동으로)\s*만[든들]/.test(note), note);
  });

  it('⭐ 모르는 것을 **모른다고** 적는다 (불변식 ③ 과 같은 자리)', () => {
    ok(/출처 기록이 없습니다/.test(unknownOriginNote()), unknownOriginNote());
    // 「왜 이런 일이 생기나」까지 적습니다 — 안 적으면 고장으로 읽힙니다.
    ok(/회의 승인으로만/.test(unknownOriginNote()), unknownOriginNote());
  });
});
