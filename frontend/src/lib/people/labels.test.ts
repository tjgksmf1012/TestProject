import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cannotTellApartNote,
  labelInList,
  nameRepeatsInList,
  tellsApartInList,
  type PersonRef,
} from './labels.ts';

const 김민수: PersonRef = { user_id: 1, name: '김민수', github_login: 'minsu-dev' };
const 이하늘: PersonRef = { user_id: 2, name: '이하늘', github_login: 'haneul-fe' };
const 이하늘2: PersonRef = { user_id: 3, name: '이하늘', github_login: 'jiwon-db' };
const 이하늘_미연결: PersonRef = { user_id: 4, name: '이하늘', github_login: null };
const 이하늘_미연결2: PersonRef = { user_id: 5, name: '이하늘' };

describe('nameRepeatsInList', () => {
  it('겹치지 않으면 거짓', () => {
    strictEqual(nameRepeatsInList(김민수, [김민수, 이하늘]), false);
  });

  it('겹치면 참 — 양쪽 다', () => {
    const all = [김민수, 이하늘, 이하늘2];
    strictEqual(nameRepeatsInList(이하늘, all), true);
    strictEqual(nameRepeatsInList(이하늘2, all), true);
  });

  it('⭐ 자기 자신은 빼고 센다 — 같은 사람이 두 번 들어와도 겹친 게 아니다', () => {
    strictEqual(nameRepeatsInList(이하늘, [이하늘, 이하늘]), false);
  });
});

describe('labelInList', () => {
  it('겹치지 않으면 이름만 — 언제나 붙이면 화면이 소음이 된다', () => {
    deepStrictEqual(
      [김민수, 이하늘].map((p) => labelInList(p, [김민수, 이하늘])),
      ['김민수', '이하늘'],
    );
  });

  it('⭐ 겹치면 프로젝트 안에서 유일한 손잡이를 붙인다', () => {
    const all = [김민수, 이하늘, 이하늘2];
    deepStrictEqual(all.map((p) => labelInList(p, all)), [
      '김민수',
      '이하늘 · @haneul-fe',
      '이하늘 · @jiwon-db',
    ]);
  });

  it('⭐ 손잡이가 없는 쪽에도 이름표를 붙인다 — 소거법으로 읽게 두지 않는다', () => {
    const all = [이하늘, 이하늘_미연결];
    deepStrictEqual(all.map((p) => labelInList(p, all)), [
      '이하늘 · @haneul-fe',
      '이하늘 · GitHub 미연결',
    ]);
  });

  it('이름이 비어 있으면 마지막 수단으로 번호', () => {
    strictEqual(labelInList({ user_id: 9, name: '  ' }, [{ user_id: 9 }]), '사용자 #9');
  });
});

describe('tellsApartInList', () => {
  it('겹치지 않으면 참', () => {
    strictEqual(tellsApartInList(김민수, [김민수, 이하늘]), true);
  });

  it('겹쳐도 손잡이가 다르면 참', () => {
    const all = [이하늘, 이하늘2];
    strictEqual(tellsApartInList(이하늘, all), true);
    strictEqual(tellsApartInList(이하늘2, all), true);
  });

  it('⭐ 둘 다 GitHub 미연결이면 **못 가른다** — 그 사실을 말해야 한다', () => {
    const all = [이하늘_미연결, 이하늘_미연결2];
    strictEqual(tellsApartInList(이하늘_미연결, all), false);
    strictEqual(tellsApartInList(이하늘_미연결2, all), false);
    // 이름표를 붙여도 두 줄이 똑같습니다.
    strictEqual(labelInList(이하늘_미연결, all), labelInList(이하늘_미연결2, all));
  });

  it('못 가른다는 말에 **무엇을 하면 되는지**가 들어 있다', () => {
    const note = cannotTellApartNote();
    strictEqual(note.includes('이름이 같은'), true);
    strictEqual(note.includes('GitHub 아이디를 연결'), true);
  });
});

// ══════════════════════════════════════════════════════════════
// 짝 검사 — **파이썬과 같은 글자를 내는가** (결함 345)
// ══════════════════════════════════════════════════════════════
//
// 같은 판단이 두 곳에 있으면 반드시 갈라집니다(대표 실패 ②). 서버에도 한
// 벌이 있는 이유는 **보고서가 기록**이라 만든 순간의 글자를 저장하기
// 때문입니다 — 화면에서 이름표를 붙이면 저장된 기록과 사람이 읽는 글이
// 갈라집니다.
//
// 갈라지지 않게 하는 방법이 이 파일입니다. 두 검사가 **같은 사례**를
// 읽으므로, 한쪽 규칙만 고치면 양쪽 다 빨개집니다.
//
//     backend/tests/test_people_labels.py
//     frontend/src/lib/people/labels.test.ts  ← 여기

interface Case {
  왜: string;
  people: PersonRef[];
  labels: string[];
  tells_apart: boolean[];
}

const CASES: Case[] = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'label_cases.json'), 'utf8'),
).cases;

describe('파이썬 쪽과 같은 글자를 낸다 (결함 345)', () => {
  it('사례 파일이 비어 있지 않다 — 빈 파일이면 두 검사 다 조용히 통과한다', () => {
    strictEqual(CASES.length > 0, true);
  });

  for (const c of CASES) {
    it(`⭐ ${c.왜}`, () => {
      deepStrictEqual(c.people.map((p) => labelInList(p, c.people)), c.labels);
      deepStrictEqual(c.people.map((p) => tellsApartInList(p, c.people)), c.tells_apart);
    });
  }
});
