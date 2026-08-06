import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MIN_USABLE_COVERAGE,
  canStart,
  consentStateOf,
  describeConsent,
  memberStatuses,
  roomStatus,
  startBlockers,
  summarizeConsent,
  type RosterEntry,
  type TrackHealth,
} from './room.ts';

function member(
  userId: number,
  name: string,
  recording: boolean | null = null
): RosterEntry {
  return { user_id: userId, name, recording };
}

function track(userId: number, over: Partial<TrackHealth> = {}): TrackHealth {
  return {
    track_id: userId * 10,
    user_id: userId,
    status: 'recording',
    coverage: null,
    total_gap_ms: 0,
    capture_confidence: 1.0,
    warnings: [],
    stop_reason: null,
    ...over,
  };
}

const ROSTER = [member(1, '김민수'), member(2, '이하늘'), member(3, '박지원')];

// ══════════════════════════════════════════════════════════════
// 동의
// ══════════════════════════════════════════════════════════════

describe('consentStateOf', () => {
  it('⭐ 미응답과 거부를 구분한다', () => {
    strictEqual(consentStateOf(member(1, 'A', null)), 'pending');
    strictEqual(consentStateOf(member(1, 'A', false)), 'refused');
    strictEqual(consentStateOf(member(1, 'A', true)), 'granted');
  });

  it('필드가 아예 없어도 미응답으로 본다', () => {
    strictEqual(consentStateOf({ user_id: 1, name: 'A' } as RosterEntry), 'pending');
  });
});

describe('describeConsent', () => {
  it('셋 다 다른 말을 한다', () => {
    const said = (['granted', 'refused', 'pending'] as const).map(describeConsent);
    strictEqual(new Set(said).size, 3);
  });
});

describe('summarizeConsent', () => {
  it('상태별로 센다', () => {
    const summary = summarizeConsent([
      member(1, '김민수', true),
      member(2, '이하늘', false),
      member(3, '박지원', null),
    ]);
    strictEqual(summary.total, 3);
    strictEqual(summary.granted, 1);
    strictEqual(summary.refused, 1);
    strictEqual(summary.pending, 1);
  });

  it('⭐ 이름을 남긴다 — 회의실에서 그 사람을 불러야 하므로', () => {
    const summary = summarizeConsent([
      member(1, '김민수', true),
      member(2, '이하늘', null),
      member(3, '박지원', false),
    ]);
    deepStrictEqual(summary.pendingNames, ['이하늘']);
    deepStrictEqual(summary.refusedNames, ['박지원']);
  });
});

describe('startBlockers', () => {
  it('전원 동의하면 비어 있다', () => {
    deepStrictEqual(startBlockers(ROSTER.map((r) => ({ ...r, recording: true }))), []);
    strictEqual(canStart(ROSTER.map((r) => ({ ...r, recording: true }))), true);
  });

  it('⭐ 아무도 응답 안 했으면 시작할 수 없다', () => {
    // 빈 집합에 전칭명제를 적용하면 참이 되지만 여기서는 그게 곧 사고다.
    strictEqual(canStart(ROSTER), false);
  });

  it('⭐ 팀원이 0명이면 시작할 수 없다', () => {
    deepStrictEqual(startBlockers([]), ['이 프로젝트에 팀원이 없습니다']);
  });

  it('막는 사람의 이름이 문구에 들어간다', () => {
    const blockers = startBlockers([
      member(1, '김민수', true),
      member(2, '이하늘', null),
      member(3, '박지원', false),
    ]);
    strictEqual(blockers.some((b) => b.includes('박지원') && b.includes('거부')), true);
    strictEqual(blockers.some((b) => b.includes('이하늘') && b.includes('응답')), true);
  });

  it('한 명만 안 했어도 막는다', () => {
    strictEqual(
      canStart([member(1, 'A', true), member(2, 'B', true), member(3, 'C', null)]),
      false
    );
  });
});

// ══════════════════════════════════════════════════════════════
// 회의 중 트랙 상태
// ══════════════════════════════════════════════════════════════

describe('memberStatuses', () => {
  const consented = ROSTER.map((r) => ({ ...r, recording: true }));

  it('⭐ 참가하지 않은 사람이 목록에서 사라지지 않는다', () => {
    // 트랙 기준으로 만들면 이 사람이 안 보인다. 지금 확인해야 할 대상인데도.
    const statuses = memberStatuses(consented, [track(1)]);

    strictEqual(statuses.length, 3);
    strictEqual(statuses[1]?.verdict, 'not_joined');
    strictEqual(statuses[1]?.message.includes('참가하지 않았'), true);
  });

  it('정상 녹음 중', () => {
    const statuses = memberStatuses(consented, [track(1)]);
    strictEqual(statuses[0]?.verdict, 'healthy');
  });

  it('⭐ 공백이 쌓이면 회의 중에 경고한다', () => {
    // 회의가 끝난 뒤에 알면 그 발언은 이미 사라진 뒤다.
    const statuses = memberStatuses(consented, [track(1, { total_gap_ms: 45_000 })]);

    strictEqual(statuses[0]?.verdict, 'at_risk');
    strictEqual(statuses[0]?.message.includes('폰 화면'), true);
    strictEqual(statuses[0]?.message.includes('45초'), true);
  });

  it('커버리지가 기준 아래면 broken', () => {
    const statuses = memberStatuses(consented, [track(1, { coverage: 0.42 })]);
    strictEqual(statuses[0]?.verdict, 'broken');
  });

  it('⭐ broken 은 "0" 이 아니라 "측정 불가" 라고 말한다', () => {
    const statuses = memberStatuses(consented, [track(1, { coverage: 0.42 })]);
    const message = statuses[0]?.message ?? '';

    strictEqual(message.includes('측정할 수 없습니다'), true);
    strictEqual(message.includes('42%'), true);
    strictEqual(/발언.*0|0점|말.*안 한/.test(message), false);
  });

  it('경계값 바로 위는 정상이다', () => {
    const statuses = memberStatuses(consented, [
      track(1, { coverage: MIN_USABLE_COVERAGE }),
    ]);
    strictEqual(statuses[0]?.verdict, 'healthy');
  });

  it('종료된 트랙은 finished', () => {
    const statuses = memberStatuses(consented, [
      track(1, { status: 'completed', coverage: 0.97 }),
    ]);
    strictEqual(statuses[0]?.verdict, 'finished');
    strictEqual(statuses[0]?.message.includes('97%'), true);
  });

  it('unusable / aborted 는 broken 이다', () => {
    for (const status of ['unusable', 'aborted']) {
      const statuses = memberStatuses(consented, [track(1, { status, coverage: 0.3 })]);
      strictEqual(statuses[0]?.verdict, 'broken', status);
    }
  });

  it('동의 상태를 같이 실어 보낸다', () => {
    const statuses = memberStatuses(
      [member(1, '김민수', true), member(2, '이하늘', false), member(3, '박지원', null)],
      []
    );
    deepStrictEqual(
      statuses.map((s) => s.consent),
      ['granted', 'refused', 'pending']
    );
  });
});

// ══════════════════════════════════════════════════════════════
// 회의를 끝낼 수 있는가
// ══════════════════════════════════════════════════════════════

describe('roomStatus', () => {
  const consented = ROSTER.map((r) => ({ ...r, recording: true }));

  it('시작 전에는 강제 종료가 필요 없다', () => {
    const status = roomStatus(memberStatuses(consented, []));
    strictEqual(status.needsForceFinish, false);
    strictEqual(status.message.includes('아직 아무도'), true);
  });

  it('녹음 중이면 기다린다', () => {
    const status = roomStatus(memberStatuses(consented, [track(1), track(2)]));
    strictEqual(status.recording, 2);
    strictEqual(status.needsForceFinish, false);
  });

  it('⭐ 브라우저를 그냥 닫은 사람이 있으면 강제 종료가 필요하다', () => {
    // 서버는 "동의한 사람 전원이 트랙을 끝냈는가" 로 판정한다.
    // 참가조차 안 한 사람이 하나 있으면 회의가 영영 처리되지 않는다.
    const statuses = memberStatuses(consented, [
      track(1, { status: 'completed', coverage: 1 }),
      track(2, { status: 'completed', coverage: 1 }),
    ]);
    const status = roomStatus(statuses);

    strictEqual(status.notJoined, 1);
    strictEqual(status.needsForceFinish, true);
    strictEqual(status.message.includes('강제 종료'), true);
  });

  it('전원 종료하면 처리가 시작된다고 말한다', () => {
    const statuses = memberStatuses(
      consented,
      ROSTER.map((r) => track(r.user_id, { status: 'completed', coverage: 1 }))
    );
    const status = roomStatus(statuses);

    strictEqual(status.needsForceFinish, false);
    strictEqual(status.message.includes('처리가 시작'), true);
  });

  it('⭐ 동의하지 않은 사람은 기다리지 않는다', () => {
    // 거부한 사람이 참가하지 않는 건 정상이다. 그것 때문에 강제 종료
    // 버튼을 띄우면 사람이 매번 눌러야 한다.
    const roster = [
      member(1, '김민수', true),
      member(2, '이하늘', true),
      member(3, '박지원', false),
    ];
    const statuses = memberStatuses(roster, [
      track(1, { status: 'completed', coverage: 1 }),
      track(2, { status: 'completed', coverage: 1 }),
    ]);
    const status = roomStatus(statuses);

    strictEqual(status.notJoined, 0);
    strictEqual(status.needsForceFinish, false);
  });

  it('망가진 트랙 수를 센다', () => {
    const statuses = memberStatuses(consented, [
      track(1, { coverage: 0.2 }),
      track(2),
      track(3, { status: 'aborted', coverage: 0 }),
    ]);
    strictEqual(roomStatus(statuses).broken, 2);
  });
});
