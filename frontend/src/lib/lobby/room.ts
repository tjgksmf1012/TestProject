/**
 * 회의 로비 — 녹음을 시작해도 되는가, 지금 누가 위험한가.
 *
 * 화면이 아니라 **판단**이 여기 있습니다. `src/demo/lobby.ts` 는 이걸
 * DOM 에 붙이기만 합니다 (`frontend/README.md` 의 경계 규칙).
 *
 * 이 파일이 답하는 질문 셋:
 *
 *   1. 지금 녹음을 시작해도 되는가? 안 되면 **누구 때문인가?**
 *   2. 회의 중에 누구의 트랙이 망가지고 있는가?
 *   3. "전원 종료" 를 기다려도 되는가, 강제 종료해야 하는가?
 *
 * 2번이 이 화면의 진짜 값어치입니다. 폰이 잠긴 걸 회의가 **끝난 뒤에**
 * 알면 그 사람의 발언은 이미 사라진 뒤입니다. 회의 중에 보이면 폰을
 * 흔들어 깨울 수 있습니다 — 그게 커버리지 40% 와 100% 의 차이입니다.
 */

/** 서버의 `GET /api/meetings/{id}/consent` 응답 한 줄. */
export interface RosterEntry {
  user_id: number;
  name: string;
  /** `null` = 아직 응답 없음. `false`(거부)와 다르다. */
  recording: boolean | null;
  raw_audio_retention?: boolean | null;
  voiceprint_storage?: boolean | null;
}

/** 서버의 `GET /api/meetings/{id}/tracks` 의 `tracks[]` 한 줄. */
export interface TrackHealth {
  track_id: number;
  user_id: number;
  status: string;
  coverage: number | null;
  total_gap_ms: number | null;
  capture_confidence: number | null;
  warnings: unknown[];
  stop_reason: string | null;
}

export type ConsentState = 'granted' | 'refused' | 'pending';

/** 커버리지가 이 아래면 그 트랙으로는 발언량을 판단할 수 없다. */
export const MIN_USABLE_COVERAGE = 0.8;

/** 회의 중 이만큼 공백이 쌓이면 화면에 경고를 띄운다. */
export const WARN_GAP_MS = 30_000;

export function consentStateOf(entry: RosterEntry): ConsentState {
  if (entry.recording === null || entry.recording === undefined) return 'pending';
  return entry.recording ? 'granted' : 'refused';
}

export function describeConsent(state: ConsentState): string {
  switch (state) {
    case 'granted':
      return '동의함';
    case 'refused':
      return '거부함';
    case 'pending':
      return '응답 대기 중';
  }
}

export interface ConsentSummary {
  total: number;
  granted: number;
  refused: number;
  pending: number;
  /** 아직 응답하지 않은 사람들. 화면이 **이름으로** 불러야 한다. */
  pendingNames: string[];
  refusedNames: string[];
}

export function summarizeConsent(roster: readonly RosterEntry[]): ConsentSummary {
  const pendingNames: string[] = [];
  const refusedNames: string[] = [];
  let granted = 0;

  for (const entry of roster) {
    switch (consentStateOf(entry)) {
      case 'granted':
        granted += 1;
        break;
      case 'refused':
        refusedNames.push(entry.name);
        break;
      case 'pending':
        pendingNames.push(entry.name);
        break;
    }
  }

  return {
    total: roster.length,
    granted,
    refused: refusedNames.length,
    pending: pendingNames.length,
    pendingNames,
    refusedNames,
  };
}

/**
 * 녹음을 시작할 수 없는 이유들. 빈 배열이면 시작 가능.
 *
 * **이름을 말한다.** "1명이 아직 동의하지 않았습니다" 보다
 * "박지원 님이 아직 응답하지 않았습니다" 가 낫습니다 — 회의실에서 그 사람을
 * 부를 수 있어야 하고, 그게 이 화면의 유일한 용도입니다.
 *
 * 서버도 같은 판정을 합니다(`recording_service.require_consent`). 여기 것은
 * UX 이고 서버 것이 법적 방어선입니다. 둘 다 있어야 합니다 — 요청은 curl
 * 로도 보낼 수 있으니까요.
 */
export function startBlockers(roster: readonly RosterEntry[]): string[] {
  if (roster.length === 0) {
    return ['이 프로젝트에 팀원이 없습니다'];
  }

  const summary = summarizeConsent(roster);
  const blockers: string[] = [];

  if (summary.refused > 0) {
    blockers.push(`${summary.refusedNames.join(', ')} 님이 녹음을 거부했습니다`);
  }
  if (summary.pending > 0) {
    blockers.push(`${summary.pendingNames.join(', ')} 님이 아직 응답하지 않았습니다`);
  }
  return blockers;
}

export function canStart(roster: readonly RosterEntry[]): boolean {
  return startBlockers(roster).length === 0;
}

// ══════════════════════════════════════════════════════════════
// 회의 중 — 누구의 트랙이 망가지고 있는가
// ══════════════════════════════════════════════════════════════

export type TrackVerdict = 'healthy' | 'at_risk' | 'broken' | 'not_joined' | 'finished';

export interface MemberStatus {
  userId: number;
  name: string;
  consent: ConsentState;
  verdict: TrackVerdict;
  coverage: number | null;
  /** 화면에 그대로 띄울 한 줄. */
  message: string;
}

function verdictOf(track: TrackHealth | undefined): TrackVerdict {
  if (track === undefined) return 'not_joined';

  const coverage = track.coverage;
  if (track.status === 'recording') {
    if (coverage !== null && coverage < MIN_USABLE_COVERAGE) return 'broken';
    if ((track.total_gap_ms ?? 0) >= WARN_GAP_MS) return 'at_risk';
    return 'healthy';
  }

  // 종료됨. 서버가 실제 청크로 커버리지를 다시 계산한 뒤다.
  if (track.status === 'completed') return 'finished';
  return 'broken'; // unusable | aborted
}

function messageFor(verdict: TrackVerdict, track: TrackHealth | undefined): string {
  const coverage = track?.coverage;
  const percent = coverage === null || coverage === undefined ? null : Math.round(coverage * 100);

  switch (verdict) {
    case 'not_joined':
      return '아직 참가하지 않았습니다';
    case 'healthy':
      return '녹음 중';
    case 'at_risk':
      return `녹음이 끊기고 있습니다 (공백 ${Math.round((track?.total_gap_ms ?? 0) / 1000)}초) — 폰 화면을 켜 주세요`;
    case 'broken':
      // ⚠️ "0" 이 아니라 "측정 불가" 다. 이 구분이 이 프로젝트의 전부다.
      return percent === null
        ? '녹음을 쓸 수 없습니다 — 이 사람의 발언량은 측정할 수 없습니다'
        : `커버리지 ${percent}% — 이 사람의 발언량은 측정할 수 없습니다`;
    case 'finished':
      return percent === null ? '녹음 종료' : `녹음 종료 (커버리지 ${percent}%)`;
  }
}

/**
 * 팀원별 현재 상태. **명단은 로스터가 기준이다.**
 *
 * 트랙 목록을 기준으로 만들면 참가하지 않은 사람이 화면에서 사라집니다.
 * 그 사람이야말로 지금 확인해야 하는 대상입니다 — 폰을 안 켰거나,
 * 켰는데 실패했거나.
 */
export function memberStatuses(
  roster: readonly RosterEntry[],
  tracks: readonly TrackHealth[]
): MemberStatus[] {
  const byUser = new Map<number, TrackHealth>();
  for (const track of tracks) byUser.set(track.user_id, track);

  return roster.map((entry) => {
    const track = byUser.get(entry.user_id);
    const verdict = verdictOf(track);
    return {
      userId: entry.user_id,
      name: entry.name,
      consent: consentStateOf(entry),
      verdict,
      coverage: track?.coverage ?? null,
      message: messageFor(verdict, track),
    };
  });
}

export interface RoomStatus {
  /** 아직 녹음 중인 사람 수. 0 이면 전원 종료. */
  recording: number;
  /** 참가하지 않은 사람 수. 이 사람들 때문에 회의가 안 끝난다. */
  notJoined: number;
  /** 트랙이 망가진 사람 수. */
  broken: number;
  /** 강제 종료 버튼을 보여줘야 하는가. */
  needsForceFinish: boolean;
  message: string;
}

/**
 * 회의를 끝낼 수 있는가.
 *
 * 서버는 "동의한 사람 전원이 트랙을 만들고 끝냈는가" 로 판정합니다
 * (`try_finalize_meeting`). 즉 **브라우저를 그냥 닫은 사람이 하나라도 있으면
 * 회의가 영영 처리되지 않습니다.** 그래서 강제 종료 버튼이 있고, 이 함수는
 * 그 버튼을 언제 보여줄지 정합니다.
 */
export function roomStatus(statuses: readonly MemberStatus[]): RoomStatus {
  const recording = statuses.filter(
    (s) => s.verdict === 'healthy' || s.verdict === 'at_risk'
  ).length;
  const notJoined = statuses.filter(
    (s) => s.verdict === 'not_joined' && s.consent === 'granted'
  ).length;
  const broken = statuses.filter((s) => s.verdict === 'broken').length;

  // 참가한 사람이 아무도 없으면 아직 시작 전이다. 강제 종료할 게 없다.
  const anyJoined = statuses.some((s) => s.verdict !== 'not_joined');

  let message: string;
  if (!anyJoined) {
    message = '아직 아무도 참가하지 않았습니다';
  } else if (recording > 0) {
    message = `${recording}명이 녹음 중입니다`;
  } else if (notJoined > 0) {
    message = `${notJoined}명이 참가하지 않아 회의가 끝나지 않습니다 — 강제 종료할 수 있습니다`;
  } else {
    message = '전원 종료했습니다. 회의 처리가 시작됩니다';
  }

  return {
    recording,
    notJoined,
    broken,
    // 녹음 중인 사람이 없는데 참가 안 한 사람이 남아 있으면 사람이 풀어야 한다.
    needsForceFinish: anyJoined && recording === 0 && notJoined > 0,
    message,
  };
}
