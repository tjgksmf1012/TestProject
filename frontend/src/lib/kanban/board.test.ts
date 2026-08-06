import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  daysBetween,
  describeStatus,
  isDueSoon,
  isOverdue,
  nextStatuses,
  sortForBoard,
  statusPatch,
  summarize,
  taskWarnings,
  toColumns,
  type Task,
} from './board.ts';

const TODAY = '2026-09-10';
const STATUSES = ['todo', 'in_progress', 'done'];

function task(over: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: '로그인 API 구현',
    assignee_id: 1,
    status: 'todo',
    deadline: '2026-09-20',
    completed_at: null,
    origin: null,
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
    const warnings = taskWarnings(task({ assignee_id: null, deadline: '2026-12-31' }), TODAY);
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
      [task({ id: 1, deadline: '2026-09-01' }), task({ id: 2, assignee_id: null })],
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

describe('statusPatch', () => {
  it('⭐ deadline 키를 넣지 않는다', () => {
    // 서버는 키가 있으면 "마감일을 바꾼다" 로 읽는다. `deadline: null` 이
    // 실려 가면 상태만 바꾸려던 요청이 **마감일을 조용히 지운다.**
    const body = statusPatch('done');
    deepStrictEqual(body, { status: 'done' });
    strictEqual('deadline' in body, false);
  });
});
