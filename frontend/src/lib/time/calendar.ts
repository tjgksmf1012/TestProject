/**
 * 팀이 사는 달력 (결함 109).
 *
 * ## 왜 브라우저의 달력을 쓰면 안 되는가
 *
 * 서버는 `completed_at` 같은 값을 **UTC 순간**으로 줍니다. 그걸 "며칠"로
 * 읽으려면 어느 시간대의 달력인지를 정해야 합니다. 그동안 이 저장소의
 * 화면들은 `Date#getFullYear()` 를 썼습니다 — 그건 **보는 사람의
 * 시간대**입니다.
 *
 *     완료 2026-09-04T16:00:00Z, 마감 2026-09-04
 *     보는 사람이 한국    → 09-05 → 지연
 *     보는 사람이 뉴욕    → 09-04 → 제때
 *
 * 같은 업무가 **누가 보느냐에 따라** 달라졌습니다. 서버는 결함 107 을
 * 고치면서 `settings.project_timezone` 이라는 하나의 달력을 정했는데,
 * 화면은 그 결정을 몰랐습니다 — 이 저장소에서 가장 자주 나온 결함
 * 부류가 **"두 벌이 있으면 한쪽만 고쳐진다"** 입니다.
 *
 * 마감·지연은 팀이 합의한 하나의 달력에서만 뜻이 있습니다. 시연을 어느
 * 노트북에서 하든 같은 답이 나와야 합니다.
 *
 * ## 왜 상수를 여기 적어 두는가
 *
 * 서버에서 받아 오면 더 정확하지만, 그 값이 필요한 첫 화면은 응답을
 * 기다리는 동안에도 날짜를 그려야 합니다. 그래서 **양쪽에 적고 검사로
 * 묶습니다** — `backend/tests/test_repo_integrity.py` 의
 * `test_the_team_calendar_is_the_same_on_both_sides` 가
 * `config.py` 의 `project_timezone` 과 이 값이 같은지 봅니다.
 */

/** ⚠️ 서버 `config.py` 의 `project_timezone` 과 같은 값. */
export const TEAM_TIMEZONE = 'Asia/Seoul';

const FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: TEAM_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * `Date` 하나를 팀 달력의 `YYYY-MM-DD` 로.
 *
 * `formatToParts` 로 조각을 직접 꺼내 씁니다. 형식 문자열을 그대로
 * 믿으면 로케일이 바뀔 때 `2026-09-05` 가 `05/09/2026` 이 됩니다.
 */
function isoFrom(at: Date): string {
  const parts = new Map(FORMATTER.formatToParts(at).map((p) => [p.type, p.value]));
  return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`;
}

/**
 * 서버가 준 순간이 **팀 달력**에서 며칠인가. 못 읽으면 null.
 *
 * ⚠️ `instant.slice(0, 10)` 을 쓰지 마세요. 그건 UTC 달력일입니다.
 */
export function teamDateOf(instant: string): string | null {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return null;
  return isoFrom(at);
}

/** 팀 달력의 오늘. 마감일과 비교하는 값이라 같은 달력이어야 한다. */
export function todayInTeamCalendar(now: Date = new Date()): string {
  return isoFrom(now);
}
