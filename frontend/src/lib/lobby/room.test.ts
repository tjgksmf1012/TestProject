import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';

import {
  EXTRA_CONSENTS,
  MIN_USABLE_COVERAGE,
  WARN_GAP_MS,
  canStart,
  captureAlerts,
  consentStateOf,
  describeConsent,
  whyConsentBlocked,
  isSilentTooLong,
  lobbyPhase,
  meetingTitleProblem,
  memberStatuses,
  roomStatus,
  savedExtraConsents,
  startBlockers,
  summarizeConsent,
  verdictView,
  type MemberStatus,
  type RosterEntry,
  type TrackHealth,
  recordAffordance,
  consentAffordance,
  discardAffordance,
  DISCARD_CONFIRM,
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
  const STATES = ['granted', 'refused', 'pending'] as const;

  it('셋 다 다른 말을 한다', () => {
    const said = STATES.map((state) => describeConsent(state));
    strictEqual(new Set(said).size, 3);
  });

  it('⭐ 끝난 회의에서는 「대기 중」이라고 하지 않는다 (결함 310)', () => {
    // 「대기 중」은 곧 온다는 뜻입니다. 같은 화면 두 줄 아래가 이미
    // 「N명은 응답하지 않은 채였습니다」라고 과거형으로 적고 있었습니다.
    strictEqual(describeConsent('pending', false), '응답 안 함');
    ok(!/대기/.test(describeConsent('pending', false)));
    // 동의·거부는 사실이라 시제가 없습니다 — 국면이 바뀌어도 그대로입니다.
    strictEqual(describeConsent('granted', false), '동의함');
    strictEqual(describeConsent('refused', false), '거부함');
  });

  it('⚠️ 시작 전에는 「대기 중」 그대로다 — 두 국면이 갈라진다', () => {
    strictEqual(describeConsent('pending', true), '응답 대기 중');
    ok(describeConsent('pending', true) !== describeConsent('pending', false));
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

describe('회의 중에 폰이 죽었는가 (결함 83)', () => {
  // ⭐ 이 저장소의 대표 실패 방식이 로비에서 일어났습니다.
  //
  // `verdictOf` 의 `broken`·`at_risk` 가지는 `coverage` 와 `total_gap_ms`
  // 를 보는데, 그 둘은 `complete_track` 에서만 채워집니다. 즉 **회의가
  // 끝나야** 값이 생깁니다. 그동안 로비는 모든 트랙을 "녹음 중" 이라고
  // 불렀습니다 — 조각이 한 개도 안 와도 똑같이.
  //
  // 로비의 존재 이유가 회의 **중에** 망가지는 폰을 찾는 것인데, 그걸 할
  // 수 있는 시점이 회의가 끝난 뒤였습니다. 그때는 못 살립니다.
  const recording = (extra: Partial<TrackHealth>): TrackHealth => ({
    track_id: 1,
    user_id: 3,
    status: 'recording',
    coverage: null,
    total_gap_ms: null,
    capture_confidence: null,
    warnings: [],
    stop_reason: null,
    ...extra,
  });

  const roster = [{ user_id: 3, name: '박지원', recording: true }];

  const only = (track: TrackHealth): MemberStatus => {
    const [status] = memberStatuses(roster as never, [track]);
    if (status === undefined) throw new Error('상태가 없습니다');
    return status;
  };

  it('⭐ 조각이 한 개도 안 오면 "녹음 중" 이라고 하지 않는다', () => {
    const status = only(recording({ chunk_count: 0, silent_ms: 90_000 }));
    strictEqual(status.verdict, 'at_risk');
    strictEqual(status.message.includes('한 조각도 안 왔습니다'), true);
    strictEqual(status.message.includes('녹음을 시작했는지'), true);
  });

  it('⭐ 오다가 끊긴 것은 다른 말을 한다 — 할 일이 다르다', () => {
    const status = only(recording({ chunk_count: 42, silent_ms: 75_000 }));
    strictEqual(status.verdict, 'at_risk');
    strictEqual(status.message.includes('안 올라옵니다'), true);
    strictEqual(status.message.includes('폰 화면을 켜'), true);
  });

  it('막 참가해 아직 조용한 것은 경고하지 않는다', () => {
    // 문턱(WARN_GAP_MS) 아래면 정상입니다. 참가 직후마다 경고를 띄우면
    // 사람이 이 경고를 안 믿게 됩니다.
    const status = only(recording({ chunk_count: 0, silent_ms: 3_000 }));
    strictEqual(status.verdict, 'healthy');
    strictEqual(status.message, '녹음 중');
  });

  it('문턱 정확히 위/아래', () => {
    strictEqual(isSilentTooLong(recording({ silent_ms: WARN_GAP_MS })), true);
    strictEqual(isSilentTooLong(recording({ silent_ms: WARN_GAP_MS - 1 })), false);
  });

  it('⭐ 서버가 이 값을 안 주면 판단하지 않는다', () => {
    // 없는 근거로 "폰을 확인하세요" 를 띄우면 다음부터 아무도 안 믿습니다.
    strictEqual(isSilentTooLong(recording({})), false);
    strictEqual(isSilentTooLong(recording({ silent_ms: null })), false);
    strictEqual(only(recording({})).verdict, 'healthy');
  });

  it('⭐ 분 단위로 넘어가면 분으로 읽는다', () => {
    const status = only(recording({ chunk_count: 5, silent_ms: 300_000 }));
    strictEqual(status.message.includes('5분째'), true);
  });

  it('끝난 트랙에는 이 판단을 쓰지 않는다', () => {
    // 종료된 트랙은 서버가 실제 청크로 커버리지를 다시 계산한 뒤다.
    const done = recording({ status: 'completed', coverage: 0.98, silent_ms: null });
    strictEqual(only(done).verdict, 'finished');
  });
});

describe('기기가 남긴 경고 (결함 93)', () => {
  const track = (warnings: unknown): TrackHealth =>
    ({
      track_id: 1,
      user_id: 1,
      status: 'completed',
      coverage: 1,
      total_gap_ms: 0,
      capture_confidence: 1,
      stop_reason: null,
      warnings,
    }) as TrackHealth;

  it('⭐ critical 만 올린다', () => {
    const alerts = captureAlerts(
      track([
        { severity: 'critical', message: '마이크가 회의 중에 바뀌었습니다' },
        { severity: 'warning', message: '표본율이 권장값과 다릅니다' },
      ]),
    );
    deepStrictEqual(alerts, ['마이크가 회의 중에 바뀌었습니다']);
  });

  it('문구를 여기서 만들지 않는다 — 기기가 남긴 말을 그대로', () => {
    deepStrictEqual(captureAlerts(track([{ severity: 'critical', message: '가나다' }])), ['가나다']);
  });

  it('⭐ 모양이 이상하면 버린다 — `[object Object]` 를 띄우지 않는다', () => {
    deepStrictEqual(
      captureAlerts(track([null, 'text', { severity: 'critical' }, { severity: 'critical', message: '   ' }])),
      [],
    );
  });

  it('경고가 없거나 트랙이 없으면 빈 배열', () => {
    deepStrictEqual(captureAlerts(track([])), []);
    deepStrictEqual(captureAlerts(track(undefined)), []);
    deepStrictEqual(captureAlerts(undefined), []);
  });
});

describe('저장된 ②③ 선택 (결함 94)', () => {
  const entry = (over: Partial<RosterEntry>): RosterEntry =>
    ({ user_id: 1, name: '김민수', recording: true, ...over }) as RosterEntry;

  it('⭐ 저장된 거부를 그대로 돌려준다', () => {
    const saved = savedExtraConsents(
      [entry({ raw_audio_retention: false, voiceprint_storage: false })],
      1,
    );
    deepStrictEqual(saved, { rawAudio: false, voiceprint: false });
  });

  it('⭐ 아직 답 안 한 것은 `null` — 거부와 다르다', () => {
    // `null` 을 `false` 로 접으면 화면이 "거부함" 으로 그립니다.
    deepStrictEqual(savedExtraConsents([entry({})], 1), { rawAudio: null, voiceprint: null });
  });

  it('남의 답을 내 것으로 쓰지 않는다', () => {
    const roster = [
      entry({ user_id: 2, name: '이하늘', raw_audio_retention: false }),
      entry({ user_id: 1, raw_audio_retention: true }),
    ];
    deepStrictEqual(savedExtraConsents(roster, 1).rawAudio, true);
  });

  it('명단에 내가 없으면 둘 다 `null`', () => {
    deepStrictEqual(savedExtraConsents([entry({ user_id: 9 })], 1), {
      rawAudio: null,
      voiceprint: null,
    });
  });
});

describe('회의 국면 — 로비가 「시작 전」을 그릴지 「끝난 뒤」를 그릴지 (결함 214)', () => {
  it('⭐ 녹음 전에는 아무 말도 덧붙이지 않는다', () => {
    // `pending` 은 "녹음 전 · 녹음 중" 둘 다입니다. 그때는 화면에 이미
    // 「시작 전 확인」이 있고, 거기에 문장을 하나 더 얹으면 같은 말을
    // 두 번 하게 됩니다.
    deepStrictEqual(lobbyPhase('pending'), { canStart: true, note: null, go: null });
  });

  it('⭐ 끝난 회의에서는 녹음을 시작할 수 없다 — 넷 전부', () => {
    // 이 넷 전부에서 「녹음 화면으로」가 멀쩡히 눌렸습니다. 검토까지 끝난
    // 회의를 다시 녹음하러 갈 수 있었다는 뜻입니다.
    for (const status of ['queued', 'processing', 'needs_review', 'confirmed', 'failed']) {
      strictEqual(lobbyPhase(status).canStart, false, `${status} 에서 아직 시작할 수 있습니다`);
    }
  });

  it('⭐ 실패한 회의는 **실패라고 말한다** — 홈이 보낸 말을 이어받는다', () => {
    // 홈: "처리에 실패했습니다 — 트랙이 온전한지 확인하세요"
    // → 도착한 화면에 「실패」라는 낱말이 **한 번도 없었습니다.**
    const note = lobbyPhase('failed').note ?? '';
    strictEqual(/실패/.test(note), true, '실패를 말하지 않습니다');
    strictEqual(/트랙/.test(note), true, '무엇을 확인하라는 것인지 안 말합니다');
  });

  it('⚠️ 막았으면 **갈 곳을 준다** — 실패만 예외이고 그건 확인할 것이 이 화면에 있어서다', () => {
    strictEqual(lobbyPhase('needs_review').go?.screen, 'review');
    strictEqual(lobbyPhase('confirmed').go?.screen, 'kanban');
    strictEqual(lobbyPhase('failed').go, null);
    // 처리 중은 사람이 할 일이 없습니다 — 기다리는 것뿐입니다.
    strictEqual(lobbyPhase('processing').go, null);
  });

  it('⛔ 모르는 상태는 **막지 않는다** — 녹음이 끊기면 그 구간은 영영 못 잰다', () => {
    // 반대로 하면 상태가 하나 늘 때마다 그 회의는 녹음을 못 하게 됩니다.
    for (const status of ['scheduled', '', 'ARCHIVED', null, undefined]) {
      strictEqual(lobbyPhase(status).canStart, true, `${String(status)} 에서 녹음을 막고 있습니다`);
      strictEqual(lobbyPhase(status).note, null);
    }
  });
});

describe('참가자 낱말 — 끝난 회의의 「대기」는 거짓말이다 (결함 214)', () => {
  const status = (verdict: MemberStatus['verdict'], message: string): MemberStatus => ({
    userId: 1,
    name: '김민수',
    consent: 'granted',
    verdict,
    coverage: null,
    message,
  });

  it('⭐ 녹음 전에는 「대기」 — 곧 들어올 사람이다', () => {
    const view = verdictView(status('not_joined', '아직 참가하지 않았습니다'), true);
    strictEqual(view.word, '대기');
    strictEqual(view.message, '아직 참가하지 않았습니다');
  });

  it('⭐ 끝난 회의에서는 「미참가」 — 아무도 기다리고 있지 않다', () => {
    // 실패한 회의의 로비에서 세 사람이 나란히 「대기 · 아직 참가하지
    // 않았습니다」 였습니다. 그 화면은 "트랙이 온전한지 확인하세요" 라고
    // 보낸 곳이고, **아무도 참가 안 한 것이 바로 그 답**입니다.
    const view = verdictView(status('not_joined', '아직 참가하지 않았습니다'), false);
    strictEqual(view.word, '미참가');
    strictEqual(/아직/.test(view.message), false, '아직이라고 말하면 곧 들어온다는 뜻입니다');
    strictEqual(/녹음은 없습니다/.test(view.message), true);
  });

  it('참가한 사람의 낱말과 문장은 국면과 무관하게 그대로다', () => {
    for (const canStart of [true, false]) {
      strictEqual(verdictView(status('finished', '녹음 종료 (커버리지 92%)'), canStart).word, '종료');
      strictEqual(
        verdictView(status('finished', '녹음 종료 (커버리지 92%)'), canStart).message,
        '녹음 종료 (커버리지 92%)',
      );
      strictEqual(verdictView(status('broken', '못 씀'), canStart).word, '못 씀');
      strictEqual(verdictView(status('at_risk', '끊김'), canStart).word, '끊김');
      strictEqual(verdictView(status('healthy', '녹음 중'), canStart).word, '녹음 중');
    }
  });
});

describe('막아 놓고 말은 하는가 — 동의 단추 (결함 239)', () => {
  it('안 막혔으면 `null`', () => {
    strictEqual(whyConsentBlocked({ sending: false, alreadyAgreed: false }), null);
  });

  it('보내는 중이면 **그것이** 지금의 사실이다', () => {
    // 동의 한 번은 요청 셋입니다 — 느린 연결에서는 그 사이가 깁니다.
    const said = whyConsentBlocked({ sending: true, alreadyAgreed: false });
    strictEqual(said?.includes('남기는 중'), true, String(said));
    // 이미 동의한 사람이 다시 눌러도 「보내는 중」이 먼저입니다.
    strictEqual(whyConsentBlocked({ sending: true, alreadyAgreed: true }), said);
  });

  it('⭐ 이미 동의했으면 **되돌리는 법**까지 말한다', () => {
    // 되돌리는 단추 이름이 「거부합니다」입니다 — 그 말을 「취소」로
    // 알아볼 이유가 없습니다 (실패 ③: 할 일을 알려 주고 자리를 안 줌).
    const said = whyConsentBlocked({ sending: false, alreadyAgreed: true });
    strictEqual(said?.includes('거부합니다'), true, String(said));
  });

  it('막는 국면마다 **말이 있다** — 빈 문자열도 아니다', () => {
    for (const gate of [
      { sending: true, alreadyAgreed: false },
      { sending: false, alreadyAgreed: true },
      { sending: true, alreadyAgreed: true },
    ]) {
      const said = whyConsentBlocked(gate);
      strictEqual(typeof said, 'string', JSON.stringify(gate));
      strictEqual((said ?? '').length > 0, true, JSON.stringify(gate));
    }
  });
});


describe('결함 255 — 트랙을 못 받은 것을 「미참가」로 단언하던 자리', () => {
  const roster = [
    { user_id: 1, name: '김민수', recording: true },
    { user_id: 2, name: '이하늘', recording: true },
  ] as unknown as Parameters<typeof memberStatuses>[0];

  it('⭐ **못 받았으면** 참가 여부를 말하지 않는다', () => {
    // `/tracks` 를 500 으로 막고 이미 녹음이 끝난 회의의 로비를 열었더니
    // 커버리지 100·98·42% 인 세 사람이 나란히 「미참가」였습니다.
    const said = memberStatuses(roster, null);
    for (const s of said) {
      strictEqual(s.verdict, 'unknown', s.name);
      strictEqual(s.message.includes('참가하지 않았습니다'), false, s.message);
      strictEqual(s.message.includes('못 받았습니다'), true, s.message);
    }
  });

  it('⚠️ **빈 배열은 그대로 「미참가」다** — 둘을 가르는 것이 전부다', () => {
    // 반대 방향입니다. 이걸 안 보면 전부 「모름」으로 덮어도 통과합니다.
    const said = memberStatuses(roster, []);
    strictEqual(said[0]?.verdict, 'not_joined');
    strictEqual(said[0]?.message, '아직 참가하지 않았습니다');
  });

  it('⭐ 모르는 채로 **강제 종료를 권하지 않는다**', () => {
    const room = roomStatus(memberStatuses(roster, null));
    strictEqual(room.needsForceFinish, false);
    strictEqual(room.notJoined, 0);
    strictEqual(room.message.includes('못 받았습니다'), true, room.message);
  });

  it('⭐ **명단도 같다** — 안 왔으면 「아무도 참가 안 함」이라고 안 한다', () => {
    // 명단이 오기 전 화면은 「참가자 상태 0명」과 「아직 아무도 참가하지
    // 않았습니다」를 단언했습니다. 아무것도 모르는 채로요.
    const unknownRoster = roomStatus([], false);
    strictEqual(unknownRoster.message.includes('아무도 참가하지'), false, unknownRoster.message);
    strictEqual(unknownRoster.message.includes('못 받았습니다'), true, unknownRoster.message);
    strictEqual(unknownRoster.needsForceFinish, false);
    // ⚠️ 반대 방향 — **진짜 빈 팀**은 그대로 말해야 합니다.
    strictEqual(roomStatus([], true).message, '아직 아무도 참가하지 않았습니다');
  });

  it('낱말도 「모름」이다 — 국면과 상관없이', () => {
    const [first] = memberStatuses(roster, null);
    strictEqual(verdictView(first as MemberStatus, true).word, '모름');
    strictEqual(verdictView(first as MemberStatus, false).word, '모름');
  });
});


describe('meetingTitleProblem (결함 268)', () => {
  it('⭐ 빈 이름은 거절한다 — **서버와 같은 규칙**', () => {
    strictEqual(meetingTitleProblem('') !== null, true);
    strictEqual(meetingTitleProblem('   ') !== null, true);
  });

  it('200자까지', () => {
    strictEqual(meetingTitleProblem('가'.repeat(200)), null);
    strictEqual(meetingTitleProblem('가'.repeat(201)) !== null, true);
  });

  it('평범한 이름은 통과', () => {
    strictEqual(meetingTitleProblem('3차 스프린트 회고'), null);
  });
});

describe('끝난 회의의 녹음 단추 (결함 309)', () => {
  it('⭐ **국면을 먼저 본다** — 끝난 회의에 「동의 후 시작」이라고 하지 않는다', () => {
    /* 이미 끝나 처리에 실패한 회의에서 「전원 동의 후 시작할 수 있습니다」가
       떴습니다. 동의만 모이면 다시 녹음할 수 있다는 말인데 그 회의는
       지나갔습니다 — 사람은 동의를 모으러 갑니다. */
    const a = recordAffordance(false, false);
    strictEqual(a.enabled, false);
    strictEqual(a.label, '이미 끝난 회의입니다');
    strictEqual(/동의/.test(a.label), false);
    strictEqual(/동의/.test(a.callLabel), false);
  });

  it('⭐ 전원이 동의했어도 **끝난 회의는 못 누른다** (결함 214 의 첫째 항목)', () => {
    // 막혀 있던 것이 우연이 아니게 만듭니다 — 그 회의는 마침 동의가
    // 안 모였을 뿐이었습니다.
    strictEqual(recordAffordance(false, true).enabled, false);
  });

  it('시작 전이고 동의가 모자라면 그 이유를 그대로 말한다', () => {
    const a = recordAffordance(true, false);
    strictEqual(a.enabled, false);
    strictEqual(a.label, '전원 동의 후 시작할 수 있습니다');
  });

  it('시작 전이고 전원 동의했으면 눌린다', () => {
    const a = recordAffordance(true, true);
    strictEqual(a.enabled, true);
    strictEqual(a.label, '녹음 화면으로');
    strictEqual(a.callLabel, '통화로 회의하기');
  });
});

describe('끝난 회의의 동의 단추 (결함 310)', () => {
  it('⭐ 시작 전 회의에서는 청록 「동의합니다」 그대로다', () => {
    const a = consentAffordance(true, false);
    strictEqual(a.primary, true);
    strictEqual(a.label, '동의합니다');
    strictEqual(a.refuseLabel, '거부합니다');
    strictEqual(a.note, null);
  });

  it('⭐ 이미 동의했으면 청록을 놓는다 — 한 화면에 주 버튼은 하나', () => {
    const a = consentAffordance(true, true);
    strictEqual(a.primary, false);
    strictEqual(a.label, '동의했습니다');
  });

  it('⭐ 끝난 회의에서는 청록이 아니고, **무엇을 누르는지** 적는다', () => {
    /* 재서 확인한 것 — 씨앗을 새로 심고 두 회의를 나란히 놓으니 회의 2
       (pending) 와 회의 5 (failed·트랙 0개) 의 동의 단추가 클래스도 색도
       글자도 같았습니다: `btn btn--primary` · rgb(61,58,174) · 「동의합니다」. */
    const a = consentAffordance(false, false);
    strictEqual(a.primary, false);
    strictEqual(a.label, '뒤늦게 동의로 남기기');
    strictEqual(a.refuseLabel, '거부로 남기기');
    ok(a.note !== null, '끝난 회의인데 아무 말도 안 합니다');
    ok(/기록으로 남습니다/.test(a.note as string), a.note as string);
    /* ⚠️ **251 의 줄을 되풀이하지 않습니다.** 그 줄이 바로 옆에서 「이
       회의의 녹음은 끝났습니다 — N명은…」이라고 말합니다. 렌더해서 보니
       거의 같은 문장이 두 줄 쌓여 있었습니다 — 글자를 늘리는 것은 이
       화면에서 고치려던 것과 반대 방향입니다. */
    ok(
      !/회의의 녹음은 (이미 )?끝났습니다/.test(a.note as string),
      `251 의 문장을 되풀이합니다: ${a.note}`,
    );
  });

  it('⭐ 끝난 회의에 이미 동의해 뒀으면 **되돌릴 말**을 준다', () => {
    const a = consentAffordance(false, true);
    strictEqual(a.label, '동의로 남겨져 있습니다');
    strictEqual(a.refuseLabel, '거부로 바꾸기');
  });

  it('⚠️ 두 국면의 글자가 **갈라진다** — 같으면 결함 310 이 그대로다', () => {
    // 이 검사가 없으면 「양쪽 다 동의합니다」로 되돌려도 위 넷이 통과합니다.
    const before = consentAffordance(true, false);
    const after = consentAffordance(false, false);
    ok(before.label !== after.label, '두 국면의 동의 단추 글자가 같습니다');
    ok(before.primary !== after.primary, '두 국면의 청록 여부가 같습니다');
  });
});

describe('빈 회의를 무르기 (결함 320)', () => {
  it('⭐ 녹음이 하나도 없는 갓 연 회의는 무를 수 있다', () => {
    /* 재서 확인한 것: 「회의 열기」를 세 번 누르니 회의가 5→8개가 됐고
       `DELETE /api/meetings/8` 은 405, 화면 셋의 지우는 단추는 0개였습니다. */
    strictEqual(discardAffordance('pending', 0).can, true);
    strictEqual(discardAffordance('pending', 0).why, null);
  });

  it('⛔ **녹음이 하나라도 있으면 못 무른다** — 소리는 다시 못 만든다', () => {
    const a = discardAffordance('pending', 1);
    strictEqual(a.can, false);
    ok(/녹음이 1건/.test(a.why ?? ''), a.why ?? '');
    // 막았으면 갈 곳을 줍니다 — 개인정보 파기는 **다른 문**입니다.
    ok(/내 녹음과 성문 지우기/.test(a.why ?? ''), a.why ?? '');
  });

  it('⚠️ 상태가 아니라 **트랙 수**를 먼저 본다 — pending 인데 트랙이 붙은 회의', () => {
    // 상태만 보면 이 회의가 새어 나갑니다.
    strictEqual(discardAffordance('pending', 2).can, false);
  });

  it('⛔ 처리에 들어간 회의는 못 무른다', () => {
    for (const st of ['queued', 'processing', 'needs_review', 'confirmed', 'failed']) {
      strictEqual(discardAffordance(st, 0).can, false, st);
    }
  });

  it('⭐ 무르기 전에 **되돌릴 수 없다**고 말한다', () => {
    ok(/되돌릴 수 없습니다/.test(DISCARD_CONFIRM), DISCARD_CONFIRM);
  });
});

describe('따로 받는 동의 ②③ 의 글 (결함 335)', () => {
  // `docs/07` §2.3 은 ②③ 에 대해 **「거부해도 서비스 이용 가능」** 을
  // 요구합니다. SPA 로비는 동의했을 때 얻는 것만 말하고 거부하면 어떻게
  // 되는지를 한 글자도 안 했습니다.
  //
  // ⚠️ **낱말을 세는 자가 아닙니다.** 「거부」라는 글자가 있는지가 아니라
  // **거부해도 된다고 말하는가**를 봅니다 — 「거부하면 회의를 못 합니다」도
  // 「거부」를 담고 있지만 요구를 어깁니다.
  it('⭐ 둘 다 「거부해도 됩니다」를 말한다', () => {
    for (const item of EXTRA_CONSENTS) {
      ok(item.hint.startsWith('거부해도 됩니다'), `${item.label} → ${item.hint}`);
    }
  });

  it('⭐ 거부하면 어떻게 되는지를 말한다 — ② 는 지우고 ③ 는 잃을 것이 없다', () => {
    const byKey = new Map(EXTRA_CONSENTS.map((c) => [c.key, c.hint]));
    const rawAudio = byKey.get('rawAudio') ?? '';
    const voiceprint = byKey.get('voiceprint') ?? '';
    ok(/지웁니다/.test(rawAudio), rawAudio);
    // ③ 은 `docs/07` §2.3 의 "멀티트랙 모드면 애초에 불필요" 입니다.
    ok(/트랙별 녹음/.test(voiceprint), voiceprint);
  });

  it('⛔ 성문이 화자 식별을 **더 잘 하게 한다**고 말하지 않는다', () => {
    // 파이프라인이 `speaker_source` 에 쓰는 값은 `"track"` 한 곳뿐이고
    // `Voiceprint(` 를 만드는 프로덕션 코드는 0곳입니다. 성문에 동의해도
    // 화자 식별은 한 자도 좋아지지 않습니다 — 없는 이득을 내걸고 받는
    // 동의는 동의가 아닙니다.
    for (const item of EXTRA_CONSENTS) {
      ok(
        !/(더 잘|정확(도|하게)|잘 알아).*(화자|목소리)|화자.*(더 잘|정확)/.test(item.hint),
        `${item.label} 가 이 제품이 하지 않는 일을 약속합니다 → ${item.hint}`,
      );
    }
  });
});
