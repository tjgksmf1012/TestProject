import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canDropOn, draggedTaskId, dragPayload, TASK_DRAG_TYPE } from './dnd.ts';
import type { Task } from './board.ts';

const STATUSES = ['todo', 'in_progress', 'review', 'done'];

function task(status: string): Task {
  return {
    id: 7,
    title: '접근성 점검',
    assignee_ids: [],
    status,
    priority: 2,
    deadline: null,
    completed_at: null,
    origin: null,
    marker: 'TASK-7',
    github: [],
  };
}

describe('칸반 끌어 옮기기 — 판단', () => {
  it('⭐ 허용 범위가 버튼(nextStatuses)과 똑같다', () => {
    // 다른 열 전부 참, 제자리만 거짓 — 버튼이 그리는 것과 같은 집합.
    const t = task('todo');
    assert.deepEqual(
      STATUSES.map((s) => canDropOn(t, s, STATUSES)),
      [false, true, true, true],
    );
  });

  it('알 수 없는 상태 열(__unknown__)에는 못 내려놓는다', () => {
    // 서버 상태 목록에 없는 곳으로는 보낼 수 없다 — toColumns 가 만드는
    // 구조용 열이지 상태가 아니다.
    assert.equal(canDropOn(task('todo'), '__unknown__', STATUSES), false);
  });

  it('알 수 없는 상태의 카드를 아는 열로 끄는 것은 된다 — 구조 경로', () => {
    // 데이터가 손상돼 상태가 목록 밖이면, 버튼도 아무 열로나 보내
    // 되살리게 해 준다. 끌기만 막으면 규칙이 두 벌이 된다.
    assert.equal(canDropOn(task('망가진값'), 'todo', STATUSES), true);
  });

  it('실은 값이 그대로 돌아온다', () => {
    assert.equal(draggedTaskId(dragPayload(42)), 42);
  });

  it('⭐ 숫자가 아닌 것은 null — drop 은 아무나 일으킨다', () => {
    // 다른 창의 글자·파일·빈 값이 그대로 PATCH 주소에 들어가면 안 된다.
    for (const bad of [null, undefined, '', 'abc', '12.5', '-3', '1e3', '99999999999']) {
      assert.equal(draggedTaskId(bad), null, String(bad));
    }
  });

  it('형식 이름이 우리 것이다 — text/plain 을 쓰면 입력창에 숫자가 박힌다', () => {
    assert.equal(TASK_DRAG_TYPE, 'application/x-teamflow-task');
  });
});
