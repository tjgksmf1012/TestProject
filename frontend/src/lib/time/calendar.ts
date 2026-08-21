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

const CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: TEAM_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * 목록에 쓰는 **짧은 날짜** — 팀 달력 기준 `MM-DD` (결함 246).
 *
 * ⛔ 화면들이 `new Date(iso).getMonth()` 로 직접 그리고 있었습니다. 그건
 * **브라우저 달력**입니다 — 같은 회의를 서울 사람은 09-02 로, 뉴욕 사람은
 * 09-01 로 봅니다. 그런데 이 제품의 마감일·달력은 팀 달력(`Asia/Seoul`)
 * 이라, 한 화면 안에서 **달력 두 벌**이 섞여 있었습니다.
 *
 * ⚠️ 판단이 화면에 있던 것이기도 합니다 — `Home.tsx` 의 `fmtDate`,
 * `Contributions.tsx` 의 `fmtWhen`. 둘 다 여기로 올렸습니다.
 */
export function shortTeamDate(instant: string): string | null {
  const iso = teamDateOf(instant);
  return iso === null ? null : iso.slice(5);
}

/** 팀 달력 기준 `MM-DD HH:MM`. 산정 시각처럼 **분까지** 말해야 할 때. */
export function teamDateTime(instant: string): string | null {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return null;
  const day = shortTeamDate(instant);
  return day === null ? null : `${day} ${CLOCK.format(at)}`;
}

/**
 * 달력 한 장 — **날짜 고르기의 판단** (수정 지시서 v2 F7).
 *
 * ## 왜 직접 만드나
 *
 * 마감 칸이 네이티브 `<input type="date">` 였고, 한국어 서비스인데
 * `mm/dd/yyyy` 로 떴습니다. ⚠️ **그 표기는 `lang` 이나 `locale` 로 못
 * 바꿉니다** — 브라우저 UI 언어를 따릅니다. 이 저장소는 예전에
 * Playwright 의 `locale` 로 이걸 재려다 헛다리를 짚은 적이 있습니다.
 *
 * 흔한 처방은 `react-day-picker` + `date-fns` 인데, 그러면 프런트
 * 런타임 의존성이 둘 늘어납니다. 이 저장소의 규칙은 React·React DOM·
 * Radix 뿐이고, 졸업작품이 끝난 뒤에도 열려야 합니다. 달력 격자는 순수
 * 계산이라 여기서 만들고 **검사로 붙잡습니다.**
 *
 * ⚠️ **`Date` 산술로 날짜를 더하지 않습니다.** 로컬 시간대에서
 * `setDate(+1)` 은 서머타임 경계에서 같은 날을 두 번 주거나 하루를
 * 건너뜁니다. 여기서는 전부 **UTC 기준**으로 계산하고 `YYYY-MM-DD`
 * 문자열로만 주고받습니다 — 시각이 아니라 달력 날짜이기 때문입니다.
 */
export interface CalendarCell {
  /** `YYYY-MM-DD`. */
  date: string;
  /** 이 칸이 보고 있는 달의 날인가. 거짓이면 앞뒤 달에서 넘어온 것. */
  inMonth: boolean;
}

/** `YYYY-MM` 을 받아 일요일 시작 6주(42칸) 격자를 만든다. */
export function monthGrid(month: string): CalendarCell[] {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (m === null) throw new RangeError(`YYYY-MM 형식이 아닙니다: ${month}`);
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) throw new RangeError(`달이 1~12 밖입니다: ${month}`);

  const first = Date.UTC(year, mon - 1, 1);
  // 일요일까지 되감는다. `getUTCDay()` 는 일요일이 0.
  const start = first - new Date(first).getUTCDay() * 86_400_000;
  const cells: CalendarCell[] = [];
  for (let i = 0; i < 42; i++) {
    const at = new Date(start + i * 86_400_000);
    cells.push({
      date: isoDate(at),
      inMonth: at.getUTCFullYear() === year && at.getUTCMonth() === mon - 1,
    });
  }
  return cells;
}

/** `Date`(UTC 기준) → `YYYY-MM-DD`. */
function isoDate(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getUTCFullYear()}-${p(at.getUTCMonth() + 1)}-${p(at.getUTCDate())}`;
}

/**
 * 달력 격자에서 **키를 눌렀을 때 갈 날짜.**
 *
 * ## ⚠️ `role="grid"` 라고 말해 놓고 격자 조작이 없었습니다
 *
 * 달력은 `<button>` 42개입니다. 화살표 이동이 없으면 키보드로 날짜를
 * 고르려면 **Tab 을 마흔 번 넘게** 눌러야 합니다. 그리고 마감은 후보
 * 등록의 필수 조건이라, 마우스를 못 쓰는 사람은 이 제품의 핵심 흐름을
 * 아예 못 끝냅니다 (결함 196).
 *
 * ARIA 는 `role="grid"` 를 붙였으면 격자 키보드 모델을 **구현해야
 * 한다**고 못 박습니다. 안 하면 역할을 안 붙인 것보다 나쁩니다 —
 * 낭독기가 "격자입니다, 화살표로 이동하세요" 라고 안내하는데 안 움직입니다.
 *
 * ⚠️ 날짜 셈은 여기(순수 계산)에 둡니다. 화면에서 `new Date()` 로 더하면
 * 서머타임·월말·윤년에서 갈라집니다.
 *
 * @param from  지금 있는 날 `YYYY-MM-DD`
 * @param key   `ArrowLeft` `ArrowRight` `ArrowUp` `ArrowDown` `Home` `End`
 *              `PageUp` `PageDown`
 * @returns 갈 날짜. 다루지 않는 키면 `null`.
 */
export function moveInCalendar(from: string, key: string): string | null {
  const at = Date.parse(`${from}T00:00:00Z`);
  if (Number.isNaN(at)) return null;
  const day = 86_400_000;
  switch (key) {
    case 'ArrowLeft':
      return isoDate(new Date(at - day));
    case 'ArrowRight':
      return isoDate(new Date(at + day));
    case 'ArrowUp':
      return isoDate(new Date(at - 7 * day));
    case 'ArrowDown':
      return isoDate(new Date(at + 7 * day));
    // 그 주의 일요일 / 토요일 — 격자에서 눈에 보이는 줄의 양 끝입니다.
    case 'Home':
      return isoDate(new Date(at - new Date(at).getUTCDay() * day));
    case 'End':
      return isoDate(new Date(at + (6 - new Date(at).getUTCDay()) * day));
    // 달을 넘길 때 **날짜를 유지**합니다. 1월 31일에서 PageDown 을 누르면
    // 2월 31일은 없으므로 그 달의 마지막 날로 붙입니다 — 넘겨 버리면
    // 3월 3일 같은 엉뚱한 날로 튑니다.
    case 'PageUp':
    case 'PageDown': {
      const d = new Date(at);
      const delta = key === 'PageUp' ? -1 : 1;
      const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + delta;
      const year = Math.floor(total / 12);
      const mon = total - year * 12;
      const last = new Date(Date.UTC(year, mon + 1, 0)).getUTCDate();
      const dayOfMonth = Math.min(d.getUTCDate(), last);
      return isoDate(new Date(Date.UTC(year, mon, dayOfMonth)));
    }
    default:
      return null;
  }
}

/** `YYYY-MM` 을 `delta` 달만큼 옮긴다. 연도를 알아서 넘어간다. */
export function shiftMonth(month: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (m === null) throw new RangeError(`YYYY-MM 형식이 아닙니다: ${month}`);
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  const year = Math.floor(total / 12);
  const mon = total - year * 12 + 1;
  return `${String(year).padStart(4, '0')}-${String(mon).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` → 그 날이 속한 `YYYY-MM`. 값이 없으면 `fallback` 의 달. */
export function monthOf(date: string | null, fallback: string): string {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(date ?? '');
  return m === null ? fallback.slice(0, 7) : `${m[1]}-${m[2]}`;
}

/**
 * 사람에게 보이는 날짜. **`YYYY-MM-DD` 그대로**입니다.
 *
 * 지시서는 `2026-09-04` 또는 `9월 4일` 중 하나를 고르라고 했습니다.
 * 앞을 골랐습니다 — 이 화면의 다른 값(회의 날짜·표식·시각)이 전부
 * 고정폭 숫자라 표기를 섞으면 세로로 훑을 때 자릿수가 흔들립니다.
 */
export function formatTeamDate(date: string | null): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ? date : null;
}

/** 달력 머리말. `2026-09` → `2026년 9월`. */
export function describeMonth(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (m === null) throw new RangeError(`YYYY-MM 형식이 아닙니다: ${month}`);
  return `${m[1]}년 ${Number(m[2])}월`;
}

/** 요일 머리 — 일요일 시작. 격자와 순서가 어긋나면 날짜가 통째로 밀립니다. */
export const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'] as const;
