import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeMeetingStatus,
  emphasisFor,
  describeProject,
  emptyProjectsMessage,
  describeMeetingWhen,
  formatMeetingTime,
  meetingWhen,
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
    scheduled_at: null,
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
      ok(step.reason.length > 0, status);
    }
  });

  it('⭐ **차례를 기다리는 것**과 **하고 있는 것**을 다르게 말한다 (결함 325)', () => {
    /* 예전에는 둘이 한 갈래라 `queued` 에도 「처리 중입니다」라고 했습니다.
       상태 이름표는 「처리 대기」라서 한 줄 안에서 **「처리 대기 — 처리
       중입니다」**로 스스로 모순됐고, 워커가 안 돌면 그 회의는 영영
       시작되지 않는데 화면은 계속 「처리 중」이라고 말했습니다. */
    const queued = nextStepFor(meeting({ status: 'queued' })).reason;
    const processing = nextStepFor(meeting({ status: 'processing' })).reason;
    ok(queued !== processing, `둘이 같은 말을 합니다: ${queued}`);
    // 아직 시작 안 한 것을 「하고 있다」고 말하지 않습니다.
    strictEqual(queued.includes('처리 중입니다'), false, queued);
    strictEqual(processing.includes('처리 중입니다'), true, processing);
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
  /* ⚠️ 예전 검사는 「`T` 도 `Z` 도 없고 길이가 0 이 아니다」만 봤습니다.
     CI 시간대에 안 흔들리게 하려던 것인데, 그 자는 **브라우저 달력이든
     팀 달력이든 똑같이 통과**합니다 — 실제로 이 함수는 오래도록
     `toLocaleString` 을 시간대 없이 부르고 있었고 검사는 초록이었습니다.

     그래서 **자정을 넘는 순간**으로 잽니다. `16:30Z` 는 서울에서 **다음
     날 01:30** 이라 팀 달력과 UTC 가 날짜부터 갈립니다 — 검사를 돌리는
     기계의 시간대가 무엇이든 답이 하나입니다. */
  it('⭐ 팀 달력(`Asia/Seoul`)으로 보여준다 — 자정을 넘겨서 잰다', () => {
    strictEqual(formatMeetingTime('2026-08-25T16:30:00Z'), '08-26 01:30');
  });

  it('⭐ 브라우저 달력이면 나올 값이 **안 나온다**', () => {
    const shown = formatMeetingTime('2026-08-25T16:30:00Z');
    strictEqual(shown.startsWith('08-25'), false);
    strictEqual(shown.includes('T'), false);
    strictEqual(shown.includes('Z'), false);
  });

  it('망가진 값은 그대로 보여준다 — 삼키지 않는다', () => {
    strictEqual(formatMeetingTime('어제'), '어제');
  });
});

describe('meetingWhen · describeMeetingWhen — 이 회의는 언제인가 (결함 287)', () => {
  /* 달력에서 「회의 일정 잡기」로 잡은 회의는 `started_at` 이 없습니다.
     서버 스키마가 그 칸을 비어 있을 수 없게 잡아 두어, 일정을 **하나**
     잡는 순간 회의 목록 전체가 500 이 되고 홈이 「회의를 열면 여기에
     나옵니다」로 바뀌었습니다 — 회의 다섯이 멀쩡히 있는 팀에서. */
  it('⭐ 연 회의는 연 시각', () => {
    const w = meetingWhen({ started_at: '2026-08-25T16:30:00Z', scheduled_at: null });
    deepStrictEqual(w, { at: '2026-08-25T16:30:00Z', planned: false });
  });

  it('⭐ 안 연 회의는 **잡아 둔 시각**이고 「예정」이다', () => {
    const w = meetingWhen({ started_at: null, scheduled_at: '2026-08-25T16:30:00Z' });
    deepStrictEqual(w, { at: '2026-08-25T16:30:00Z', planned: true });
    strictEqual(describeMeetingWhen({ started_at: null, scheduled_at: '2026-08-25T16:30:00Z' }),
      '예정 08-26 01:30');
  });

  it('⭐ 둘 다 없으면 **시각을 지어내지 않는다**', () => {
    deepStrictEqual(meetingWhen({ started_at: null, scheduled_at: null }), { at: null, planned: true });
    strictEqual(describeMeetingWhen({ started_at: null, scheduled_at: null }), '—');
  });

  it('연 회의에는 「예정」이 안 붙는다', () => {
    strictEqual(describeMeetingWhen({ started_at: '2026-08-25T16:30:00Z', scheduled_at: null }),
      '08-26 01:30');
  });

  it('⭐ 잡아만 둔 회의는 **지금 할 일이 아니다**', () => {
    /* `pending` 이라고 「동의를 받고 녹음을 시작합니다」라고 하면
       아직 오지 않은 날의 일을 지금 하라는 말이 됩니다. */
    const step = nextStepFor(meeting({
      status: 'pending', started_at: null, scheduled_at: '2026-09-30T01:00:00Z',
    }));
    strictEqual(step.actionable, false);
    strictEqual(step.label, '회의 열기');
    strictEqual(step.reason.includes('잡아 둔'), true);
  });

  it('연 `pending` 회의는 지금 할 일이 맞다', () => {
    const step = nextStepFor(meeting({
      status: 'pending', started_at: '2026-09-01T01:00:00Z', scheduled_at: null,
    }));
    strictEqual(step.actionable, true);
    strictEqual(step.label, '회의 로비로');
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


describe('결함 252 — 화면이 `actionable` 을 뒤집던 자리', () => {
  it('⭐ 검토할 후보가 **0건**이면 「검토 필요」 덩어리에 안 넣는다', () => {
    // 이 함수의 머리말은 「가르는 기준은 상태가 아니라 사람이 할 일이
    // 있는가」인데, 코드는 상태만 봤습니다. 그래서 머리말이 「검토 필요 2」
    // 라고 세면서 한 건은 검토할 것이 없었습니다.
    const list = [
      meeting({ meeting_id: 1, status: 'needs_review', pending_candidates: 3 }),
      meeting({ meeting_id: 2, status: 'needs_review', pending_candidates: 0 }),
    ];
    const { needsReview, rest } = sectionMeetings(list);
    deepStrictEqual(needsReview.map((m) => m.meeting_id), [1]);
    deepStrictEqual(rest.map((m) => m.meeting_id), [2]);
  });

  it('⭐ **`actionable` 이 아니면 강조하지 않는다** — 덩어리 안이어도', () => {
    const nothing = nextStepFor(meeting({ status: 'needs_review', pending_candidates: 0 }));
    strictEqual(nothing.actionable, false);
    strictEqual(emphasisFor(nothing, true), 'ghost');
    strictEqual(emphasisFor(nothing, false), 'ghost');
  });

  it('primary 는 **검토 필요 덩어리 안의 할 일**에만', () => {
    const todo = nextStepFor(meeting({ status: 'needs_review', pending_candidates: 3 }));
    strictEqual(emphasisFor(todo, true), 'primary');
    // 덩어리 밖의 갈 수 있는 줄은 테두리 버튼입니다 (v2 F9).
    strictEqual(emphasisFor(nextStepFor(meeting({ status: 'pending' })), false), 'secondary');
  });
});
