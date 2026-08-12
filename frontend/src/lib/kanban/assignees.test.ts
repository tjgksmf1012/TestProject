import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  NAME_JOIN,
  assigneeText,
  nameOf,
  splitNote,
  toggled,
  type Person,
} from './assignees.ts';

const PEOPLE: Person[] = [
  { user_id: 1, name: '김민수' },
  { user_id: 2, name: '이하늘' },
  { user_id: 3, name: '박지원' },
];

// ══════════════════════════════════════════════════════════════
// 이름 줄
// ══════════════════════════════════════════════════════════════

test('한 사람이면 이름 하나', () => {
  assert.equal(assigneeText([1], PEOPLE), '김민수');
});

test('여럿이면 받은 순서 그대로 잇는다', () => {
  // ⚠️ 서버가 이름 순으로 줍니다. **여기서 정렬하면 안 됩니다** —
  //    정렬하는 순간 맨 앞이 "주담당" 이라는 없는 뜻이 생깁니다.
  assert.equal(assigneeText([2, 1], PEOPLE), `이하늘${NAME_JOIN}김민수`);
});

test('비어 있으면 빈칸이 아니라 "담당자 없음"', () => {
  // ⚠️ 빈칸으로 두면 사람은 화면이 덜 그려진 것으로 읽고, **아무도 안
  //    맡았다**는 사실 자체가 안 보입니다. 그게 제일 위험한 업무입니다.
  assert.equal(assigneeText([], PEOPLE), '담당자 없음');
});

test('명단에 없는 사람도 자리를 받는다', () => {
  // 나간 사람이 담당자로 남아 있을 수 있습니다. 빈칸을 그리면 화면은
  // 담당자가 없다고 말하는데 기여 이벤트는 그 사람에게 갑니다.
  assert.equal(nameOf(99, PEOPLE), '사용자 #99');
  assert.equal(assigneeText([1, 99], PEOPLE), `김민수${NAME_JOIN}사용자 #99`);
});

// ══════════════════════════════════════════════════════════════
// 나눠 셌다는 안내 — 이 파일에서 제일 중요한 것
// ══════════════════════════════════════════════════════════════

test('혼자 맡았으면 아무 말도 안 한다', () => {
  assert.equal(splitNote([1]), null);
  assert.equal(splitNote([]), null);
});

test('둘이 맡으면 몇 분의 몇인지 적는다', () => {
  // ⚠️ "공동 담당" 같은 말로는 **배분이 일어났다는 사실**이 전달되지
  //    않습니다. 사람은 자기 기여도가 낮은 이유를 알 수 있어야 합니다.
  const note = splitNote([1, 2]);
  assert.ok(note !== null);
  assert.ok(note.includes('2명'));
  assert.ok(note.includes('2분의 1'));
});

test('안내에 사람 이름이 안 들어간다', () => {
  // ⚠️ 누가 더 했는지는 시스템이 모릅니다. 이름을 실으면 그 순간
  //    사람에 대한 판정이 됩니다 (`AGENTS.md` 불변식 4).
  const note = splitNote([1, 2, 3]) ?? '';
  for (const person of PEOPLE) {
    assert.ok(!note.includes(person.name), `안내에 "${person.name}" 이 들어 있습니다`);
  }
});

// ══════════════════════════════════════════════════════════════
// 넣고 빼기
// ══════════════════════════════════════════════════════════════

test('없던 사람은 들어오고 있던 사람은 빠진다', () => {
  assert.deepEqual(toggled([1], 2), [1, 2]);
  assert.deepEqual(toggled([1, 2], 1), [2]);
});

test('넣고 빼도 원본을 안 건드린다', () => {
  const before = [1, 2];
  toggled(before, 3);
  assert.deepEqual(before, [1, 2]);
});

test('여기서 정렬하지 않는다', () => {
  // ⚠️ 미리 정렬하면 저장 전후로 순서가 달라 보이고, 사람은 "뭔가
  //    바뀌었나" 하며 다시 누릅니다. 순서는 서버가 정합니다.
  assert.deepEqual(toggled([3, 1], 2), [3, 1, 2]);
});
