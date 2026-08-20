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

/**
 * 녹음하던 기기가 남긴 경고 한 줄. 서버가 `complete_track` 에 저장한
 * 그대로입니다 — 문구는 **녹음 클라이언트가 만든 한국어**입니다.
 */
export interface CaptureWarning {
  setting?: string;
  severity?: string;
  message?: string;
}

/** 서버의 `GET /api/meetings/{id}/tracks` 의 `tracks[]` 한 줄. */
export interface TrackHealth {
  track_id: number;
  user_id: number;
  status: string;
  coverage: number | null;
  total_gap_ms: number | null;
  capture_confidence: number | null;
  /**
   * 녹음하던 기기가 남긴 경고. **서버가 이미 보내고 있었습니다.**
   *
   * ⚠️ 오래도록 `unknown[]` 으로 받아만 두고 **읽는 곳이 0곳**이었습니다
   * (결함 93). 녹음 화면은 자기가 방금 잡은 경고를 보여주지만, 그건
   * 그 폰에서 그 순간에만 보입니다. 업로드돼 저장된 뒤로는 **아무 화면도
   * 이 값을 안 봤습니다** — 로비가 &#34;누구 폰이 잘못됐나&#34; 를 보는
   * 곳인데도요.
   *
   * ⚠️ **완료된 트랙에만 들어 있습니다.** `capture_warnings` 는 참가할
   * 때 `[]` 로 만들어지고 `complete_track` 에서만 채워집니다 — 녹음
   * 중에는 언제나 비어 있습니다(결함 83 과 같은 시점 문제). 그래서 이
   * 값은 &#34;회의 중 경보&#34; 가 아니라 **&#34;끝난 뒤 이 사람 녹음을
   * 얼마나 믿을지&#34;** 입니다.
   */
  warnings?: CaptureWarning[];
  stop_reason: string | null;
  /* ── 아래 셋은 **구멍이 언제 생겼는지** 그리기 위한 값입니다.
     "42% 가 비었다" 와 "12분에 끊겼다" 는 다른 말이고, 뒤쪽이라야
     사람이 무엇을 확인할지 압니다 (docs/16 Stage E). */
  gaps?: { reason?: string; startMs: number; endMs: number }[];
  started_at?: string | null;
  ended_at?: string | null;
  /* ── 아래 둘은 **회의 중에** 폰이 살아 있는지 보는 값입니다 (결함 83).
     `coverage` 와 `total_gap_ms` 는 `complete_track` 에서만 채워지므로
     녹음 중에는 언제나 null 입니다. 그래서 아래 `verdictOf` 의 `broken`·
     `at_risk` 가지가 **회의가 끝나기 전에는 한 번도 못 탔습니다.** */
  /** 지금까지 서버가 받은 조각 수. */
  chunk_count?: number;
  /** 마지막 소식 이후 흐른 밀리초. 녹음 중이 아니면 null. **서버가 잰다.** */
  silent_ms?: number | null;
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
    // ⭐ **여기까지는 녹음 중에 한 번도 못 탑니다** (결함 83). 위 두 값은
    // 트랙이 끝나야 채워지니까요. 회의 중에 실제로 알 수 있는 것은
    // "마지막으로 소식이 온 지 얼마나 됐나" 하나뿐입니다.
    //
    // ⚠️ 문턱은 새로 만들지 않고 `WARN_GAP_MS` 를 그대로 씁니다. "이만큼
    // 끊기면 사람에게 알린다" 는 판단은 이미 이 파일이 하고 있었고, 다른
    // 숫자를 지어내면 같은 뜻에 값이 둘이 됩니다.
    if (isSilentTooLong(track)) return 'at_risk';
    return 'healthy';
  }

  // 종료됨. 서버가 실제 청크로 커버리지를 다시 계산한 뒤다.
  if (track.status === 'completed') return 'finished';
  return 'broken'; // unusable | aborted
}

/**
 * 회의 중에 이 트랙이 조용한 지 오래됐는가 (결함 83).
 *
 * ⚠️ 시간은 **서버가 잽니다.** 조각의 시각은 녹음하는 폰의 동기화된 시계
 * 기준이고, 로비를 보는 사람의 브라우저 시계는 그것과 다를 수 있습니다.
 * 여기서 빼면 시계가 어긋난 만큼 전부 죽은 것으로 보이거나 전부 멀쩡한
 * 것으로 보입니다 — 운행도표의 축 문제와 같습니다.
 *
 * ⚠️ **모르면 경고하지 않습니다.** `silent_ms` 가 없는 서버(옛 버전)에서는
 * 판단하지 않습니다. 없는 근거로 "폰을 확인하세요" 를 띄우면, 다음부터
 * 사람은 이 경고를 안 믿습니다.
 */
export function isSilentTooLong(track: TrackHealth): boolean {
  const silent = track.silent_ms;
  if (silent === null || silent === undefined) return false;
  return silent >= WARN_GAP_MS;
}

/**
 * 무엇을 확인해야 하는지까지 말한다.
 *
 * 조각이 **한 개도** 안 온 것과, 오다가 끊긴 것은 **할 일이 다릅니다.**
 * 앞은 녹음을 아예 시작 안 했을 수 있고, 뒤는 화면이 꺼졌을 가능성이 큽니다.
 */
function describeAtRisk(track: TrackHealth | undefined): string {
  const silentMs = track?.silent_ms;
  if (silentMs !== null && silentMs !== undefined) {
    const seconds = Math.round(silentMs / 1000);
    const howLong = seconds >= 60 ? `${Math.round(seconds / 60)}분째` : `${seconds}초째`;
    return (track?.chunk_count ?? 0) === 0
      ? `${howLong} 녹음이 한 조각도 안 왔습니다 — 그 폰에서 녹음을 시작했는지 확인해 주세요`
      : `${howLong} 녹음이 안 올라옵니다 — 폰 화면을 켜 주세요`;
  }
  const gapSeconds = Math.round((track?.total_gap_ms ?? 0) / 1000);
  return `녹음이 끊기고 있습니다 (공백 ${gapSeconds}초) — 폰 화면을 켜 주세요`;
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
      return describeAtRisk(track);
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

/**
 * 이 트랙에서 **사람에게 보여줄** 경고 문구들.
 *
 * ⚠️ `critical` 만 올립니다. 녹음 클라이언트는 `warning` 도 남기는데
 * (예: 표본율이 권장값과 다름), 그건 트랙을 못 쓰게 만들지 않습니다.
 * 로비에 다 쏟으면 진짜 문제가 묻힙니다 — 이 화면은 &#34;누가 문제인가&#34;
 * 를 한눈에 보는 곳입니다.
 *
 * ⚠️ **문구를 여기서 만들지 않습니다.** 기기가 남긴 말을 그대로 씁니다.
 * 여기서 다시 쓰면 같은 사실에 두 문장이 생기고, 한쪽만 고쳐집니다.
 *
 * ⚠️ 모양이 이상하면 **버립니다.** 저장된 JSON 이라 무엇이든 들어올 수
 * 있고, `[object Object]` 를 화면에 띄우는 것보다 안 띄우는 게 낫습니다.
 */
export function captureAlerts(track: TrackHealth | undefined): string[] {
  if (track === undefined) return [];
  return (track.warnings ?? [])
    .filter((w) => w !== null && typeof w === 'object' && w.severity === 'critical')
    .map((w) => (typeof w.message === 'string' ? w.message.trim() : ''))
    .filter((message) => message !== '');
}

/**
 * 이 사람이 **이미 답해 둔** ②③ 선택.
 *
 * ## 왜 필요한가 (결함 94)
 *
 * 로비의 ②③ 체크박스는 HTML 에 `checked` 로 박혀 있고, 화면은 그 값을
 * **제출할 때만 읽었습니다.** 서버는 사람마다 저장된 답을 로스터에 실어
 * 보내고 있었는데(`raw_audio_retention`·`voiceprint_storage`) 읽는 곳이
 * 0곳이었습니다. 그래서 브라우저에서 이렇게 됩니다.
 *
 *     둘 다 끄고 제출 → 서버에 false 로 저장됨
 *     새로고침        → **둘 다 다시 켜져 있음**
 *
 * 화면이 기록과 어긋나는 것만도 문제지만, 더 나쁜 것은 그 상태에서
 * 사람이 &#34;동의합니다&#34; 를 한 번 더 누르면 화면이 `true` 를 보내
 * **거부가 조용히 뒤집힌다**는 것입니다. 그러면
 * `retention.purge_unconsented_audio()` 가 그 사람의 원본을 더 이상
 * 지우지 않습니다 — 결함 67 이 고친 바로 그 구멍이 반대 방향으로
 * 다시 뚫립니다.
 *
 * ⚠️ **아직 답을 안 했으면 기본값을 그대로 둡니다.** `null` 은 &#34;아직
 * 응답 없음&#34; 이고 `false`(거부)와 다릅니다 — 이 저장소가 로스터에서
 * 지키는 구분입니다.
 */
export function savedExtraConsents(
  roster: readonly RosterEntry[],
  userId: number,
): { rawAudio: boolean | null; voiceprint: boolean | null } {
  const mine = roster.find((entry) => entry.user_id === userId);
  return {
    rawAudio: mine?.raw_audio_retention ?? null,
    voiceprint: mine?.voiceprint_storage ?? null,
  };
}

/* ══════════════════════════════════════════════════════════════
   회의 국면 — 이 로비가 「시작 전」인가 「끝난 뒤」인가
   ══════════════════════════════════════════════════════════════ */

/**
 * 로비가 지금 무엇을 그려야 하는가.
 *
 * ⚠️ **로비는 오래도록 회의 상태를 아예 안 봤습니다** (결함 214). 재서
 * 확인한 것 — 다섯 상태 전부에서 화면이 **글자까지 같았습니다**:
 *
 *     회의 1 (needs_review) 「시작 전 확인」 있음 · 「녹음 화면으로」 안 막힘
 *     회의 4 (confirmed)    「시작 전 확인」 있음
 *     회의 5 (failed)       「시작 전 확인」 있음 · 화면에 「실패」 0회
 *
 * 세 가지가 한꺼번에 잘못돼 있었습니다:
 *
 *   1. **끝난 회의를 다시 녹음하러 갈 수 있었습니다.** 검토까지 끝난
 *      회의에서 「녹음 화면으로」가 멀쩡히 눌렸습니다.
 *   2. **홈이 한 말이 도착지에서 사라졌습니다.** 홈은 "처리에
 *      실패했습니다 — 트랙이 온전한지 확인하세요" 라고 보내는데, 그
 *      화면에는 실패라는 낱말이 한 번도 안 나옵니다. AGENTS.md 의
 *      "할 일을 알려 주고 그 일을 할 자리를 안 줌" 그 자리입니다.
 *   3. **끝난 회의에 「시작 전 확인」이 떴습니다.** 이미 지나간 일을
 *      준비하라고 말하는 화면입니다.
 *
 * ⚠️ **모르는 상태는 「시작 전」으로 둡니다.** 반대로 하면 새 상태가
 * 하나 생길 때마다 그 회의는 녹음을 **못 하게** 됩니다. 이 제품에서
 * 녹음이 한 번 끊기면 그 구간은 영영 못 잽니다 — 막는 쪽이 더 비쌉니다.
 */
export interface LobbyPhase {
  /** 지금 녹음을 시작할 수 있는 국면인가. */
  canStart: boolean;
  /**
   * 끝난 회의라면 **무슨 일이 있었고 여기서 무엇을 볼 수 있는가**.
   * 시작 전이면 `null` — 그때는 「시작 전 확인」이 할 말을 합니다.
   */
  note: string | null;
  /**
   * 로비 말고 갈 곳. 여기서 할 일이면 `null`.
   *
   * ⚠️ 「녹음 화면으로」를 막으면서 갈 곳을 안 주면 막다른 길입니다.
   * 실패한 회의만 `null` 인데, 그건 **확인할 것이 이 화면에** 있기
   * 때문입니다.
   */
  go: { label: string; screen: 'review' | 'kanban' } | null;
}

export function lobbyPhase(status: string | null | undefined): LobbyPhase {
  switch (status) {
    case 'queued':
    case 'processing':
      return {
        canStart: false,
        note: '녹음이 끝나 처리 중입니다. 끝나면 업무 후보가 나옵니다.',
        go: null,
      };
    case 'needs_review':
      return {
        canStart: false,
        note: '녹음이 끝났습니다. 업무 후보를 검토할 차례입니다.',
        go: { label: '업무 후보 검토', screen: 'review' },
      };
    case 'confirmed':
      return {
        canStart: false,
        note: '검토까지 끝난 회의입니다. 아래는 그때 남은 트랙 기록입니다.',
        go: { label: '칸반 보기', screen: 'kanban' },
      };
    case 'failed':
      return {
        canStart: false,
        // 홈이 "트랙이 온전한지 확인하세요" 라고 보낸 그 말을 **여기서**
        // 이어받습니다. 확인할 것은 바로 아래 참가자 상태입니다.
        note: '처리에 실패했습니다. 아래 트랙이 온전한지 확인하세요 — 트랙이 짧거나 끊겼으면 그게 원인일 수 있습니다.',
        go: null,
      };
    default:
      // 모르는 상태도 여기로 옵니다 — 위 주석의 이유로 **막지 않습니다.**
      return { canStart: true, note: null, go: null };
  }
}

/**
 * 참가자 한 줄이 쓸 낱말과 문장.
 *
 * ⚠️ **국면이 바뀌면 같은 판정이 다른 뜻이 됩니다.** `not_joined` 는 녹음
 * 전이면 「대기」(곧 들어올 사람)이지만, 이미 끝난 회의에서는 「미참가」
 * (영영 안 들어온 사람)입니다. 실패한 회의의 로비에서 세 사람이 나란히
 * 「대기 · 아직 참가하지 않았습니다」 라고 서 있었습니다 — 아무도 기다리고
 * 있지 않은데요. 그리고 그 화면은 "트랙이 온전한지 확인하세요" 라고 보낸
 * 곳이었습니다. **아무도 참가 안 한 것이 바로 그 답**인데, 화면은 그것을
 * 「아직」 이라는 말로 덮고 있었습니다 (결함 214).
 *
 * ⚠️ 낱말 표를 화면에 두지 않습니다. `Lobby.tsx` 안에 `VERDICT_WORD` 상수로
 * 있었고, 화면 코드에는 자동 테스트가 없으니 이 판단은 검증 밖이었습니다.
 */
export interface VerdictView {
  /** 한 낱말. 문장은 `?` 안에서 원문 그대로 나옵니다. */
  word: string;
  /** 그 낱말의 근거 한 줄. */
  message: string;
}

export function verdictView(status: MemberStatus, canStart: boolean): VerdictView {
  if (status.verdict === 'not_joined' && !canStart) {
    return { word: '미참가', message: '이 회의에 참가하지 않았습니다 — 이 사람의 녹음은 없습니다' };
  }
  const WORD: Record<TrackVerdict, string> = {
    not_joined: '대기',
    healthy: '녹음 중',
    at_risk: '끊김',
    broken: '못 씀',
    finished: '종료',
  };
  return { word: WORD[status.verdict], message: status.message };
}
