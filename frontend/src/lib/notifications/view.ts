/**
 * 알림 화면이 쓰는 판단 (정의서 §19).
 *
 * ## ⚠️ 여기서 **문장을 만들지 않습니다**
 *
 * 알림 문장은 서버가 줍니다 — 저장된 글자가 아니라 읽을 때 만든 것이라,
 * 업무 이름을 고치면 문장도 따라옵니다. 화면이 자기 문장을 만들면 그
 * 표가 두 벌이 되고 반드시 갈라집니다.
 *
 * 여기 있는 것은 **어떻게 보일 것인가**뿐입니다.
 */

import { shortTeamDate, teamDateTime } from '../time/calendar.ts';

export interface Notice {
  kind: string;
  at: string;
  /** ⚠️ 서버가 만든 문장. 화면이 다시 만들지 않습니다. */
  text: string;
  task_id: number | null;
  meeting_id: number | null;
  message_id: number | null;
  /** 그 부름이 있던 채널. 없으면 어느 대화를 열지 모릅니다 (결함 417). */
  channel_id: number | null;
  /** 저장된 알림만 번호가 있습니다. 마감은 `null`. */
  notification_id: number | null;
  read: boolean;
}

/**
 * 종류 → 한 단어.
 *
 * ⚠️ 모르는 종류는 **그대로** 돌려줍니다. 지어내면 틀린 말이 됩니다 —
 * 서버에 종류가 하나 더 생겼는데 화면이 아직 모르는 경우입니다.
 */
const KIND_LABEL: Record<string, string> = {
  mention: '불림',
  assigned: '배정',
  due_soon: '곧 마감',
  overdue: '지연',
  meeting_soon: '회의',
  github: 'GitHub',
};

export function describeKind(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

/**
 * 눈에 띄게 그릴 것인가 — **지난 것만**입니다.
 *
 * ⚠️ `due_soon` 은 아닙니다. 아직 안 늦었는데 빨갛게 그리면 "곧" 과
 * "지났다" 가 같은 모양이 되고, 그러면 진짜 지난 것을 못 알아봅니다.
 */
export function isUrgent(notice: Notice): boolean {
  return notice.kind === 'overdue';
}

/**
 * 이 줄의 시각을 **무엇이라고 부를 것인가** (결함 331).
 *
 * ## ⚠️ `at` 은 종류마다 다른 것을 가리킵니다
 *
 * 저장된 알림(`mention`·`assigned`·`meeting_soon`·`github`)의 `at` 은
 * **일어난 때**이고, 파생 알림(`due_soon`·`overdue`)의 `at` 은
 * **마감일**입니다 (`notification_service.deadline_notices` 가
 * `at=due` 로 만듭니다).
 *
 * 서버는 둘을 **한 축에 놓고 내림차순**으로 정렬합니다. 그래서 아직
 * 오지 않은 마감이 목록 맨 위에 오고, 이미 지난 마감이 채팅 호출보다
 * 아래로 내려갑니다 — 재현했습니다:
 *
 *     1. 곧 마감입니다 — 접근성 점검      at=2026-08-25  ← 미래
 *     2. 업무를 맡았습니다 — 배포 방식 조사  at=2026-08-23
 *     3. 김민수 님이 대화에서 나를 불렀습니다 at=2026-08-23
 *     4. 마감일이 지났습니다 — 개발 환경…   at=2026-08-20  ← 제일 급한 것
 *
 * 그리고 **화면은 시각을 한 글자도 안 그리고 있었습니다.** 축은 있는데
 * 보이지 않으니 사람은 그 순서를 「새것부터」로 읽습니다.
 *
 * 여기서는 **무엇을 가리키는 시각인지 이름을 붙여** 돌려줍니다. 순서를
 * 바꾸는 것은 제품 결정이라 건드리지 않았습니다 — `docs/17` 331번의
 * 「결정이 필요한 자리」를 보십시오.
 */
export function timeLabel(notice: Notice): string | null {
  const isDeadline = notice.kind === 'due_soon' || notice.kind === 'overdue';
  const shown = isDeadline ? shortTeamDate(notice.at) : teamDateTime(notice.at);
  if (shown === null) return null;
  return isDeadline ? `마감 ${shown}` : shown;
}

/**
 * 눌러서 갈 곳. 갈 데가 없으면 `null`.
 *
 * ⚠️ **누를 수 없는 것을 버튼으로 그리지 않으려고** `null` 을 돌려줍니다.
 */
export function hrefFor(notice: Notice, projectId: number): string | null {
  if (notice.meeting_id !== null) {
    return `/lobby.html?meeting=${notice.meeting_id}&project=${projectId}`;
  }
  if (notice.task_id !== null) return `/kanban.html?project=${projectId}`;
  if (notice.message_id !== null) {
    // ⚠️ **채널을 들고 갑니다** (결함 417). 예전에는 `?project=` 만
    //    붙여서, 「디자인 채널에서 나를 불렀습니다」를 눌렀는데 채팅이
    //    **첫 채널**(`#공지`)을 열고 부른 글은 화면에 없었습니다 —
    //    문장은 자리를 말하는데 링크는 딴 데로 데려갔습니다.
    //    ⚠️ 채널이 하나뿐이면 기본값이 언제나 맞아서 안 보입니다
    //    (결함 355 의 함정) — 둘로 만들고서야 드러났습니다.
    if (notice.channel_id === null) return `/chat.html?project=${projectId}`;
    return `/chat.html?project=${projectId}&channel=${notice.channel_id}`;
  }
  return null;
}

/**
 * 읽음 표시를 누를 수 있는 알림들의 번호.
 *
 * ⚠️ **마감은 빠집니다.** 읽었다고 마감이 사라지지 않으므로, 읽음 표시를
 * 보내 봐야 서버가 할 일이 없습니다. 그런데도 버튼을 그리면 눌러도 아무
 * 일이 안 일어나는 버튼이 됩니다.
 */
export function readableIds(notices: readonly Notice[]): number[] {
  return notices
    .filter((n) => n.notification_id !== null && !n.read)
    .map((n) => n.notification_id as number);
}

/**
 * 배지에 쓸 글자. **0 이면 `null`** 입니다.
 *
 * ⚠️ `0` 을 배지로 그리면 "0건 남음" 이라는 뜻 없는 표가 붙습니다
 * (`lib/nav/channels.ts` 가 같은 이유로 같은 결정을 했습니다).
 *
 * ⚠️ 100 을 넘으면 `99+` 입니다 — 세 자리가 되면 배지가 옆 글자를 밉니다.
 */
export function badgeText(unread: number): string | null {
  if (!Number.isFinite(unread) || unread <= 0) return null;
  return unread > 99 ? '99+' : String(unread);
}

/** 아무것도 없을 때 할 말. */
export function emptyNote(): { what: string; why: string; how: string } {
  return {
    what: '지금 볼 알림이 없습니다',
    why: '알림은 나를 부르거나, 업무를 맡거나, 마감이 다가올 때 생깁니다.',
    how: '채팅에서 `@이름`으로 부르면 그 사람에게 알림이 갑니다.',
  };
}
