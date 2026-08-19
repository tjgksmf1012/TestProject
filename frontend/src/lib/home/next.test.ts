import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeMeetingStatus,
  describeProject,
  emptyProjectsMessage,
  formatMeetingTime,
  hasLane,
  homeProject,
  nextStepFor,
  orderProjects,
  requestedProjectId,
  sectionMeetings,
  type Meeting,
  type Project,
} from './next.ts';

function meeting(over: Partial<Meeting> = {}): Meeting {
  return {
    meeting_id: 7,
    title: '1주차 정기회의',
    status: 'needs_review',
    started_at: '2026-09-01T01:00:00Z',
    pending_candidates: 3,
    ...over,
  };
}

function project(over: Partial<Project> = {}): Project {
  return {
    project_id: 1,
    title: 'TeamFlow',
    member_count: 3,
    meeting_count: 2,
    needs_review: 0,
    ...over,
  };
}

// ══════════════════════════════════════════════════════════════
// 어디로 보낼 것인가
// ══════════════════════════════════════════════════════════════

describe('nextStepFor', () => {
  it('녹음 전이면 로비로', () => {
    const step = nextStepFor(meeting({ status: 'pending' }));
    strictEqual(step.href, '/lobby.html?meeting=7');
    strictEqual(step.actionable, true);
  });

  it('검토할 후보가 있으면 승인 화면으로 — 몇 건인지 같이', () => {
    const step = nextStepFor(meeting({ status: 'needs_review', pending_candidates: 3 }));
    strictEqual(step.href, '/review.html?meeting=7');
    strictEqual(step.label.includes('3건'), true);
    strictEqual(step.actionable, true);
  });

  it('⭐ needs_review 인데 후보가 0건이면 승인 화면으로 보내지 않는다', () => {
    // 보내면 빈 목록이 뜨고 사용자는 화면이 고장 났다고 생각한다.
    // 실제로는 "AI 가 업무로 뽑을 만한 게 없었다" 이고 그건 정상이다.
    const step = nextStepFor(meeting({ status: 'needs_review', pending_candidates: 0 }));
    strictEqual((step.href ?? '').includes('review.html'), false);
    strictEqual(step.actionable, false);
    strictEqual(step.reason.includes('업무가 나오지 않았습니다'), true);
  });

  it('⭐ 처리 중이면 버튼을 만들지 않는다', () => {
    // 눌러도 아직 아무것도 없는 곳으로 갈 뿐이다.
    for (const status of ['queued', 'processing']) {
      const step = nextStepFor(meeting({ status }));
      strictEqual(step.href, null, status);
      strictEqual(step.actionable, false, status);
      strictEqual(step.reason.includes('처리 중'), true, status);
    }
  });

  it('검토를 마쳤으면 칸반으로', () => {
    strictEqual(nextStepFor(meeting({ status: 'confirmed' })).href, '/kanban.html?meeting=7');
  });

  it('⭐ 실패한 회의는 트랙을 확인하게 보낸다', () => {
    // 실패의 가장 흔한 원인이 트랙이 비었거나 망가진 것이다.
    const step = nextStepFor(meeting({ status: 'failed' }));
    strictEqual((step.href ?? '').includes('lobby.html'), true);
    strictEqual(step.reason.includes('트랙'), true);
  });

  it('⭐ 모르는 상태를 숨기지 않는다', () => {
    // 숨기면 그 회의가 화면에서 사라진다. 상태 값이 늘거나 데이터가
    // 손상됐을 때 가장 확인이 필요한 회의가 바로 그것이다.
    const step = nextStepFor(meeting({ status: 'archived' }));
    strictEqual(step.reason.includes('archived'), true);
    strictEqual((step.href ?? '').length > 0, true);
  });

  it('버튼이 없어도 이유는 항상 있다', () => {
    for (const status of ['pending', 'queued', 'processing', 'needs_review', 'confirmed', 'failed', '무엇']) {
      strictEqual(nextStepFor(meeting({ status })).reason.length > 0, true, status);
    }
  });
});

describe('describeMeetingStatus', () => {
  it('아는 상태는 한국어로', () => {
    strictEqual(describeMeetingStatus('needs_review'), '검토 필요');
  });

  it('모르는 것은 그대로 — 삼키면 원인을 못 본다', () => {
    strictEqual(describeMeetingStatus('archived'), 'archived');
  });
});

// ══════════════════════════════════════════════════════════════
// 프로젝트 목록
// ══════════════════════════════════════════════════════════════

describe('orderProjects', () => {
  it('⭐ 할 일이 있는 프로젝트를 위로', () => {
    const ordered = orderProjects([
      project({ project_id: 1, needs_review: 0 }),
      project({ project_id: 2, needs_review: 2 }),
    ]);
    deepStrictEqual(ordered.map((p) => p.project_id), [2, 1]);
  });

  it('같은 조건이면 id 순 — 순서가 흔들리면 안 된다', () => {
    const ordered = orderProjects([
      project({ project_id: 5, needs_review: 1 }),
      project({ project_id: 2, needs_review: 3 }),
    ]);
    deepStrictEqual(ordered.map((p) => p.project_id), [2, 5]);
  });

  it('원본을 바꾸지 않는다', () => {
    const projects = [project({ project_id: 1 }), project({ project_id: 2, needs_review: 1 })];
    orderProjects(projects);
    deepStrictEqual(projects.map((p) => p.project_id), [1, 2]);
  });
});

describe('describeProject', () => {
  it('회의가 없으면 그렇게 말한다', () => {
    strictEqual(
      describeProject(project({ meeting_count: 0 })).includes('아직 회의가 없습니다'),
      true,
    );
  });

  it('⭐ 할 일이 있으면 그 숫자를 말한다', () => {
    const text = describeProject(project({ needs_review: 2 }));
    strictEqual(text.includes('검토할 회의 2개'), true);
  });

  it('할 일이 없으면 검토 문구를 붙이지 않는다', () => {
    strictEqual(describeProject(project({ needs_review: 0 })).includes('검토할'), false);
  });
});

describe('emptyProjectsMessage', () => {
  it('⭐ "없습니다" 로 끝내지 않고 다음 할 일을 말한다', () => {
    const text = emptyProjectsMessage();
    strictEqual(text.includes('없습니다'), true);
    strictEqual(text.includes('만들'), true);
  });

  it('⭐ 남을 기다리라고 하지 않는다 — 그 남도 같은 화면을 보고 있다', () => {
    // 예전 문구는 "팀원 중 한 명이 만들고 당신을 넣어야 합니다" 였다.
    // 모두가 서로를 기다리다 아무도 시작하지 못한다.
    const text = emptyProjectsMessage();
    strictEqual(/기다|팀원 중 한 명/.test(text), false);
    strictEqual(text.includes('초대 코드'), true);
  });
});

// ══════════════════════════════════════════════════════════════
// 시각
// ══════════════════════════════════════════════════════════════

describe('formatMeetingTime', () => {
  it('⭐ 로컬 시간대로 보여준다', () => {
    // 서버는 UTC 로 준다. 그대로 쓰면 한국에서 9시간 어긋나 오전 회의가
    // 전날로 보인다. 이 테스트는 시간대가 무엇이든 "UTC 문자열 그대로가
    // 아니다" 만 확인한다 — CI 시간대에 흔들리면 안 된다.
    const shown = formatMeetingTime('2026-09-01T01:00:00Z');
    strictEqual(shown.includes('T'), false);
    strictEqual(shown.includes('Z'), false);
    strictEqual(shown.length > 0, true);
  });

  it('망가진 값은 그대로 보여준다 — 삼키지 않는다', () => {
    strictEqual(formatMeetingTime('어제'), '어제');
  });
});

describe('sectionMeetings', () => {
  it('⭐ 검토 필요만 따로 올리고 나머지는 최근 것부터 한 덩어리', () => {
    // 상태 순으로 묶던 시절 데모 데이터의 날짜 순서가 그대로다 —
    // 09-01(검토 필요) · 09-05(처리 중) · 09-02(실패) · 09-08(녹음 전) · 09-03(완료).
    const list = [
      meeting({ meeting_id: 1, status: 'needs_review', started_at: '2026-09-01T01:00:00Z' }),
      meeting({ meeting_id: 2, status: 'processing', started_at: '2026-09-05T01:00:00Z' }),
      meeting({ meeting_id: 3, status: 'failed', started_at: '2026-09-02T01:00:00Z' }),
      meeting({ meeting_id: 4, status: 'pending', started_at: '2026-09-08T01:00:00Z' }),
      meeting({ meeting_id: 5, status: 'confirmed', started_at: '2026-09-03T01:00:00Z' }),
    ];
    const { needsReview, rest } = sectionMeetings(list);
    deepStrictEqual(needsReview.map((m) => m.meeting_id), [1]);
    // 09-08 · 09-05 · 09-03 · 09-02 — 내림차순. 상태는 섞여 있어도 된다.
    deepStrictEqual(rest.map((m) => m.meeting_id), [4, 2, 5, 3]);
  });

  it('검토 필요가 여럿이면 그 안에서도 최근 것부터', () => {
    const list = [
      meeting({ meeting_id: 1, status: 'needs_review', started_at: '2026-09-01T01:00:00Z' }),
      meeting({ meeting_id: 2, status: 'needs_review', started_at: '2026-09-09T01:00:00Z' }),
    ];
    deepStrictEqual(sectionMeetings(list).needsReview.map((m) => m.meeting_id), [2, 1]);
  });

  it('⚠️ 날짜가 같으면 id 큰 쪽이 위 — 정렬이 흔들리면 목록이 춤춘다', () => {
    const same = '2026-09-04T01:00:00Z';
    const list = [
      meeting({ meeting_id: 1, status: 'confirmed', started_at: same }),
      meeting({ meeting_id: 9, status: 'confirmed', started_at: same }),
      meeting({ meeting_id: 5, status: 'confirmed', started_at: same }),
    ];
    deepStrictEqual(sectionMeetings(list).rest.map((m) => m.meeting_id), [9, 5, 1]);
  });

  it('원본 배열을 건드리지 않는다', () => {
    const list = [
      meeting({ meeting_id: 1, status: 'confirmed', started_at: '2026-09-01T01:00:00Z' }),
      meeting({ meeting_id: 2, status: 'confirmed', started_at: '2026-09-09T01:00:00Z' }),
    ];
    sectionMeetings(list);
    deepStrictEqual(list.map((m) => m.meeting_id), [1, 2]);
  });

  it('빈 목록', () => {
    const { needsReview, rest } = sectionMeetings([]);
    deepStrictEqual(needsReview, []);
    deepStrictEqual(rest, []);
  });
});

describe('hasLane', () => {
  it('⭐ 값이 없으면 레인을 그리지 않는다 — 빈 막대가 무게중심을 먹었다', () => {
    strictEqual(hasLane(null), false);
  });

  it('0 은 값이다 — 재 봤더니 0% 인 것과 못 잰 것은 다르다', () => {
    // 이 구분이 기여도 불변식 ③ 과 같은 것이다. `0` 을 떨어뜨리면
    // "커버리지 0%" 인 회의가 "안 쟀음" 으로 둔갑한다.
    strictEqual(hasLane(0), true);
  });

  it('NaN·Infinity 는 값이 아니다', () => {
    strictEqual(hasLane(Number.NaN), false);
    strictEqual(hasLane(Number.POSITIVE_INFINITY), false);
  });

  it('보통 값', () => {
    strictEqual(hasLane(0.8), true);
  });
});

// ══════════════════════════════════════════════════════════════
// 홈이 보여 줄 프로젝트 — 베타에서 "내 프로젝트가 사라졌다" 가 나온 자리
// ══════════════════════════════════════════════════════════════

describe('homeProject', () => {
  // ⚠️ **두 기준이 갈라지는 데이터**로 잽니다. 예전에 순서를 재면서
  //    이름 순과 번호 순이 같은 명단을 써서 아무것도 못 잡은 적이
  //    있습니다. 여기서는 `orderProjects` 의 첫 번째(#9 — 검토 있음)와
  //    목록의 첫 번째(#3)와 사람이 고른 것(#5)이 전부 다릅니다.
  const 내것 = project({ project_id: 3, title: '내가 만든 프로젝트', needs_review: 0 });
  const 고른것 = project({ project_id: 5, title: '고른 프로젝트', needs_review: 0 });
  const 팀것 = project({ project_id: 9, title: '팀 프로젝트', needs_review: 2 });
  const 셋 = [내것, 고른것, 팀것];

  it('갈라지는 데이터인지 먼저 확인한다 — 안 그러면 이 검사는 아무것도 안 잰다', () => {
    strictEqual(orderProjects(셋)[0]?.project_id, 9);
    strictEqual(셋[0]?.project_id, 3);
  });

  it('⭐ 주소가 가리키는 것을 보여 준다 — 검토거리가 있는 팀 프로젝트가 밀어내지 않는다', () => {
    strictEqual(homeProject(셋, 5)?.project_id, 5);
    strictEqual(homeProject(셋, 3)?.project_id, 3);
  });

  it('주소에 아무 말 없으면 할 일이 있는 것부터 — 예전 동작 그대로', () => {
    strictEqual(homeProject(셋, null)?.project_id, 9);
  });

  it('⚠️ 내 목록에 없는 id 는 조용히 첫 번째로 — 남의 프로젝트를 넘겨다볼 수 없다', () => {
    strictEqual(homeProject(셋, 99999)?.project_id, 9);
    strictEqual(homeProject(셋, -1)?.project_id, 9);
  });

  it('프로젝트가 없으면 undefined — 화면이 안내 문구를 그린다', () => {
    strictEqual(homeProject([], 5), undefined);
    strictEqual(homeProject([], null), undefined);
  });
});

describe('requestedProjectId', () => {
  it('숫자를 읽는다 — 앞에 `?` 가 있든 없든', () => {
    strictEqual(requestedProjectId('?project=5'), 5);
    strictEqual(requestedProjectId('project=5'), 5);
    strictEqual(requestedProjectId('?tab=x&project=12'), 12);
  });

  it('⚠️ 빈 값은 `null` 이다 — `Number("")` 은 0 이라 그냥 넘기면 "0번 프로젝트" 가 된다', () => {
    strictEqual(requestedProjectId('?project='), null);
    strictEqual(requestedProjectId('?project=   '), null);
  });

  it('말이 안 되는 값도 null', () => {
    strictEqual(requestedProjectId(''), null);
    strictEqual(requestedProjectId('?project=abc'), null);
    strictEqual(requestedProjectId('?project=1.5'), null);
    strictEqual(requestedProjectId('?project=0'), null);
    strictEqual(requestedProjectId('?project=-3'), null);
  });
});
