/**
 * 채팅 화면이 쓰는 판단 — 그리기 전에 정해야 하는 것들.
 *
 * 화면(`src/demo/chat.tsx`)에는 자동 테스트가 없습니다. 그래서 "무엇을
 * 어떻게 보일 것인가" 를 여기로 빼고 테스트를 붙입니다.
 *
 * ## ⚠️ 여기서 정하지 **않는** 것
 *
 * **누가 멘션됐는가**는 서버가 정합니다 (`backend/teamflow/chat/mentions.py`).
 * 아래 `mentionSegments` 는 **꾸미기**입니다 — `@무언가` 를 눈에 띄게
 * 그릴 뿐이고, 알림이 누구에게 가는지와 아무 상관이 없습니다. 두 벌처럼
 * 보이지만 하는 일이 다릅니다: 여기가 잘못 강조해도 알림은 안 갑니다.
 *
 * ## ⚠️ 반응을 **개수 순으로 세우지 않습니다**
 *
 * 서버가 어휘 순서대로 줍니다. 화면이 다시 정렬하면 그 순간 순위표가
 * 되고, 메시지마다 같은 표시가 다른 자리에 옵니다 (`AGENTS.md` 불변식 1).
 */

import { teamDateOf, todayInTeamCalendar } from '../time/calendar.ts';

/**
 * 대화의 **앞부분에 닿는 길**.
 *
 * ## ⛔ 60개를 넣었는데 50개만 보이고, 나머지 열에 닿을 길이 없었습니다 (결함 315)
 *
 * 채널 하나에 메시지 60개를 넣고 열어 봤습니다 —
 *
 *     서버가 준 개수   50   (`message_service.MAX_PAGE`)
 *     화면에 그린 수   50
 *     첫 메시지        「메시지 11 …」
 *     「더 보기」 단추   **0개**
 *
 * 대화의 처음 열 줄이 제품 안에서 **영영 안 보입니다.**
 *
 * ⚠️ **서버는 이미 할 수 있었습니다.** `message_service.history` 가
 * `before_id` 를 받고, 그 옆에 「`before_id` 는 **번호**이지 시각이
 * 아닙니다 — 시각으로 자르면 같은 초에 온 메시지가…」라고 근거까지
 * 적혀 있습니다. 화면이 그 인자를 **한 번도 안 보냈습니다** (실패 ①,
 * 결함 298·306 과 같은 부류).
 *
 * ⚠️ **결함 306 의 라우트 가드는 이걸 못 잡습니다** — 그 라우트는
 * 불립니다. 안 불리는 것은 **인자**입니다. 낱말이 아니라 요구를
 * 재려면 「받아 온 개수가 한 쪽 크기와 같으면 더 있을 수 있다」를
 * 재야 합니다.
 */

/** 서버 한 쪽의 크기. `backend/teamflow/services/message_service.py` 의 `MAX_PAGE` 와 짝입니다. */
export const MESSAGE_PAGE = 50;

/**
 * 더 옛 메시지가 **있을 수 있는가**.
 *
 * ⚠️ 「있다」가 아니라 「있을 수 있다」입니다 — 딱 50개인 채널도 참을
 * 돌려줍니다. 눌러 보면 0개가 오고 그때 단추가 사라집니다. 반대로
 * 하면(개수를 미리 세면) 요청이 한 번 더 늘고, 그 값은 곧 낡습니다.
 */
export function hasOlderMessages(loaded: number, page = MESSAGE_PAGE): boolean {
  return loaded >= page;
}

/** 다음으로 물어볼 자리 — **가장 오래된 것의 번호**. 없으면 `null`. */
export function olderCursor(messages: readonly { id: number }[]): number | null {
  if (messages.length === 0) return null;
  return messages.reduce((lowest, m) => (m.id < lowest ? m.id : lowest), messages[0]!.id);
}

/**
 * 앞쪽을 이어 붙입니다. **번호로 겹치는 것을 걸러냅니다** — 누른 사이에
 * 새 메시지가 오면 같은 것이 두 번 그려질 수 있습니다.
 */
export function prependOlder<T extends { id: number }>(
  older: readonly T[],
  current: readonly T[],
): T[] {
  const seen = new Set(current.map((m) => m.id));
  return [...older.filter((m) => !seen.has(m.id)), ...current];
}

export interface Reaction {
  mark: string;
  /** 사람 말. ⚠️ **서버가 줍니다** — 화면에 두 번째 표를 만들지 않습니다. */
  label: string;
  count: number;
}

export interface ChatMessage {
  id: number;
  channel_id: number;
  author_id: number;
  author_name: string;
  /** ⚠️ 지워진 메시지는 **빈 글자**로 옵니다. 서버가 뺍니다. */
  body: string;
  reply_to_id: number | null;
  created_at: string;
  edited_at: string | null;
  deleted: boolean;
  mentions: string[];
  reactions: Reaction[];
  my_reaction: string | null;
}

export interface ChatChannel {
  id: number;
  kind: string;
  name: string;
  position: number;
}

// ══════════════════════════════════════════════════════════════
// 채널
// ══════════════════════════════════════════════════════════════

/**
 * 채널 이름을 화면에 어떻게 쓸 것인가.
 *
 * ⚠️ `#` 은 **여기서** 붙입니다. 이름에 넣어 저장하면 이름을 바꿀 때
 * `#` 이 남거나 겹치고(`##일반`), 검색이 `#` 까지 찾게 됩니다. 서버가
 * 이름에 `#` 을 거절하는 것과 짝입니다.
 */
export function channelTitle(channel: ChatChannel): string {
  return channel.kind === 'text' ? `#${channel.name}` : channel.name;
}

/**
 * 음성 채널을 눌렀을 때 무엇을 할 수 있는가.
 *
 * ⚠️ 음성 채널에는 메시지를 못 씁니다 (서버가 거절합니다). 그걸 화면이
 * 모르면 **입력창을 그려 놓고 보내면 빨간 줄이 뜨는** 화면이 됩니다 —
 * 할 수 없는 일을 할 수 있는 것처럼 그리는 것입니다.
 */
export function carriesMessages(channel: ChatChannel): boolean {
  return channel.kind === 'text';
}

/**
 * 음성 채널을 골랐을 때 본문 자리에 쓸 말.
 *
 * ⚠️ **이름 바로 뒤에 조사를 붙이지 마십시오** (결함 88). 처음에 이 함수는
 * `${name}은 회의를 여는 방입니다` 였는데, `주간회의` 는 받침이 없어
 * `는` 이 맞습니다. 이름은 사용자가 짓는 것이라 받침을 미리 알 수 없고,
 * `은(는)` 같은 짝 표기도 화면에 내보내면 안 됩니다. 그래서 **문장을
 * 조사가 필요 없는 모양으로** 바꿉니다. 가드가 잡아 줬습니다.
 */
export function voiceChannelNote(channel: ChatChannel): string {
  return `${channel.name} — 회의를 여는 방입니다. 대화는 텍스트 채널에서 합니다.`;
}

// ══════════════════════════════════════════════════════════════
// 날짜 가르기
// ══════════════════════════════════════════════════════════════

export interface DayGroup {
  /** 팀 달력의 `YYYY-MM-DD`. 못 읽은 것은 `''`. */
  date: string;
  /** 사람이 읽을 말. `오늘`·`어제`·`8월 12일` */
  label: string;
  messages: ChatMessage[];
}

const MONTH_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `2026-08-12` → `8월 12일`.
 *
 * ⚠️ `Intl` 의 `dateStyle` 을 쓰지 않습니다 — 브라우저 UI 언어에 따라
 * `2026. 8. 12.` 이 되기도 하고 `Aug 12` 가 되기도 합니다. 이 저장소는
 * 날짜 표기를 로케일에 맡겼다가 재는 방법부터 틀린 적이 있습니다.
 */
export function describeDay(date: string, today: string = todayInTeamCalendar()): string {
  const parts = MONTH_DAY.exec(date);
  if (parts === null) return '날짜를 알 수 없는 메시지';
  if (date === today) return '오늘';

  const [, year, month, day] = parts as unknown as [string, string, string, string];
  const yesterday = new Date(`${today}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (date === yesterday.toISOString().slice(0, 10)) return '어제';

  const thisYear = today.slice(0, 4);
  const plain = `${Number(month)}월 ${Number(day)}일`;
  return year === thisYear ? plain : `${year}년 ${plain}`;
}

/**
 * 메시지를 날짜로 가른다.
 *
 * ⚠️ 가르는 자리가 없으면 **어제 온 말과 방금 온 말이 붙어 보입니다.**
 * 채팅에서 그건 "언제 한 말인지" 를 통째로 잃는 것입니다.
 *
 * ⚠️ 순서를 바꾸지 않습니다 — 서버가 오래된 것부터 줍니다.
 */
export function dayGroups(
  messages: readonly ChatMessage[],
  today: string = todayInTeamCalendar(),
): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const message of messages) {
    const date = teamDateOf(message.created_at) ?? '';
    const last = groups[groups.length - 1];
    if (last !== undefined && last.date === date) {
      last.messages.push(message);
      continue;
    }
    groups.push({ date, label: describeDay(date, today), messages: [message] });
  }
  return groups;
}

// ══════════════════════════════════════════════════════════════
// 한 줄
// ══════════════════════════════════════════════════════════════

const HH_MM = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** `14:05`. 못 읽으면 빈 글자 — **`--:--` 같은 가짜 값을 만들지 않습니다.** */
export function describeTime(instant: string): string {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return '';
  return HH_MM.format(at);
}

/**
 * 지워진 메시지 자리에 쓸 말.
 *
 * ⚠️ 자리를 빼면 안 됩니다 — 답글이 가리키는 곳이라 사라지면 "누구에게
 * 한 말인지" 를 못 읽습니다. 서버도 행을 안 지웁니다.
 */
export const DELETED_TEXT = '지워진 메시지입니다';

/** 고친 메시지에 붙일 표시. ⚠️ 감추면 말이 달라진 것을 아무도 모릅니다. */
export const EDITED_MARK = '수정됨';

/**
 * 앞 메시지와 **같은 사람이 이어서** 쓴 것인가.
 *
 * 그러면 이름과 시각을 다시 안 씁니다 — 한 사람이 다섯 줄을 쓰면 이름이
 * 다섯 번 나오고, 그게 목록에서 가장 눈에 띄는 것이 됩니다.
 *
 * ⚠️ **5분을 넘으면 다시 씁니다.** 아침에 한 말과 저녁에 한 말이 한 덩어리로
 * 보이면 안 됩니다.
 *
 * ⚠️ 지워진 메시지는 잇지 않습니다 — 지워진 자리 뒤에 이름 없는 줄이 오면
 * 누가 한 말인지 알 수 없습니다.
 */
export function continuesRun(
  previous: ChatMessage | undefined,
  message: ChatMessage,
): boolean {
  if (previous === undefined) return false;
  if (previous.author_id !== message.author_id) return false;
  if (previous.deleted || message.deleted) return false;
  if (message.reply_to_id !== null) return false;

  const before = new Date(previous.created_at).getTime();
  const now = new Date(message.created_at).getTime();
  if (Number.isNaN(before) || Number.isNaN(now)) return false;
  return now - before < 5 * 60 * 1000;
}

/** 내가 쓴 것인가 — 고치기·지우기 버튼을 그릴 근거. */
export function canEdit(message: ChatMessage, meId: number | null): boolean {
  return !message.deleted && meId !== null && message.author_id === meId;
}

// ══════════════════════════════════════════════════════════════
// 멘션 강조 — **꾸미기입니다**
// ══════════════════════════════════════════════════════════════

export interface Segment {
  text: string;
  /** 강조할 조각인가 */
  mention: boolean;
}

/**
 * 본문을 강조할 조각과 아닌 조각으로 가른다.
 *
 * ⚠️ **누가 알림을 받는지와 무관합니다.** 그건 서버가 본문에서 뽑아
 * `mentions` 로 보내 줍니다. 여기가 하는 일은 그 이름들이 본문 어디에
 * 있는지 찾아 표시하는 것뿐입니다.
 *
 * ⚠️ 서버가 준 이름만 강조합니다. 화면이 `@무언가` 를 전부 강조하면
 * 팀에 없는 `@아무개` 도 불린 것처럼 보이는데, 그 사람에게는 알림이
 * 안 갑니다 — 보낸 사람이 갔다고 믿게 됩니다.
 *
 * ⚠️ 긴 이름부터 맞춥니다. 서버의 판정과 **같은 규칙**입니다.
 */
export function mentionSegments(body: string, names: readonly string[]): Segment[] {
  if (body === '') return [];
  if (names.length === 0) return [{ text: body, mention: false }];

  const byLength = [...names].sort((a, b) => b.length - a.length);
  const segments: Segment[] = [];
  let plain = '';
  let i = 0;

  while (i < body.length) {
    if (body[i] === '@') {
      const tail = body.slice(i + 1);
      const hit = byLength.find((name) => tail.startsWith(name));
      if (hit !== undefined) {
        if (plain !== '') segments.push({ text: plain, mention: false });
        plain = '';
        segments.push({ text: `@${hit}`, mention: true });
        i += hit.length + 1;
        continue;
      }
    }
    plain += body[i];
    i += 1;
  }
  if (plain !== '') segments.push({ text: plain, mention: false });
  return segments;
}

// ══════════════════════════════════════════════════════════════
// 반응
// ══════════════════════════════════════════════════════════════

/**
 * 반응 이름 → 아이콘 이름.
 *
 * ⚠️ **색 이모지를 쓰지 않습니다.** `guards.test.ts` 가 막고, 막는 이유는
 * 기기마다 다른 그림이 나오고 어두운 모드를 안 따라가기 때문입니다.
 * 칸반 카드의 `🗣` 를 SVG 로 바꾼 것이 그 규칙이 생긴 자리입니다.
 *
 * ⚠️ 모르는 이름은 `null` 입니다 — 서버에 반응이 하나 더 생겼는데 화면이
 * 아직 모르는 경우입니다. 아무 아이콘이나 그리면 **틀린 뜻**이 됩니다.
 */
export function reactionIcon(mark: string): 'check' | 'thumb' | 'ask' | 'heart' | null {
  switch (mark) {
    case 'ok':
      return 'check';
    case 'agree':
      return 'thumb';
    case 'question':
      return 'ask';
    case 'thanks':
      return 'heart';
    default:
      return null;
  }
}

/** 이 화면이 고를 수 있는 반응. ⚠️ 서버의 `ReactionMark` 와 같은 순서입니다. */
export const REACTION_MARKS = ['agree', 'ok', 'question', 'thanks'] as const;

/**
 * 반응 버튼을 낭독기에 뭐라고 읽어 줄 것인가.
 *
 * ⚠️ 아이콘과 숫자는 **눈으로만 읽히는 표시**입니다. 그것뿐이면 낭독기
 * 사용자에게는 아무것도 안 남습니다.
 */
export function reactionAriaLabel(reaction: Reaction, mine: boolean): string {
  const base = `${reaction.label} ${reaction.count}명`;
  return mine ? `${base}, 내가 누름 — 다시 누르면 뗍니다` : base;
}

// ══════════════════════════════════════════════════════════════
// 보낼 수 있는가
// ══════════════════════════════════════════════════════════════

/** 서버와 같은 상한. ⚠️ 넘겨 보내면 400 이 오고 쓴 글이 날아갑니다. */
export const MAX_BODY = 4000;

/**
 * 지금 [보내기] 를 누를 수 있는가, 못 누르면 왜인가.
 *
 * ⚠️ 이유를 같이 돌려줍니다. 버튼만 흐려 두면 사람은 **왜 안 되는지**
 * 모른 채 계속 누릅니다 — 이 저장소가 반복해서 낸 모양입니다.
 */
export function sendBlockedReason(body: string, channel: ChatChannel | null): string | null {
  if (channel === null) return '왼쪽에서 채널을 고르세요.';
  if (!carriesMessages(channel)) return voiceChannelNote(channel);
  if (body.trim() === '') return null;
  if (body.length > MAX_BODY) {
    return `메시지는 ${MAX_BODY}자까지입니다 — 지금 ${body.length}자입니다.`;
  }
  return null;
}

/** 눌러도 되는가. ⚠️ 빈 글자는 **이유 없이** 막습니다 — 설명할 것이 없습니다. */
export function canSend(body: string, channel: ChatChannel | null): boolean {
  if (channel === null || !carriesMessages(channel)) return false;
  const trimmed = body.trim();
  return trimmed !== '' && body.length <= MAX_BODY;
}

/**
 * 채널이 비었을 때 할 말.
 *
 * ## ⛔ 「방금 만들어졌습니다」는 화면이 **모르는 것**이었습니다 (결함 304)
 *
 * 화면이 이렇게 적고 있었습니다.
 *
 *     아직 아무 말도 없습니다
 *     **#공지 채널이 방금 만들어졌습니다.**
 *
 * 그런데 `GET /api/projects/{id}/channels` 가 돌려주는 것은 이것뿐입니다 —
 *
 *     {"id":1,"kind":"text","name":"공지","position":1}
 *
 * **만든 시각이 없습니다.** 표에는 `created_at` 이 있는데 화면까지 오지
 * 않으므로, 화면은 「방금」인지 **알 수가 없습니다.** 지난달에 만들어 두고
 * 아무도 안 쓴 채널도 똑같이 「방금 만들어졌습니다」라고 말합니다.
 *
 * 결함 304(활동 기록)와 같은 성질입니다 — **빈 상자의 「왜」가 화면이
 * 확인하지 않은 것을 단언**했습니다. 같은 회차에 쓸다가 나왔습니다.
 *
 * ## 대신 무엇을 말하나
 *
 * 화면이 **아는 것**을 말합니다: 이야기는 채널마다 따로 쌓인다는 것. 그게
 * 「바쁜 팀인데 왜 여기가 비었나」의 진짜 답이기도 합니다 — 사람들은 다른
 * 채널에 있습니다.
 *
 * ⚠️ 만든 시각을 화면까지 내보내서 「어제 만들어졌습니다」라고 말하는 길도
 * 있습니다. 안 고른 이유는 **그 값이 여기서 쓸모가 없기** 때문입니다 —
 * 사람이 알고 싶은 것은 「언제 생겼나」가 아니라 「왜 비었나」입니다.
 */
export function describeEmptyChannel(): { why: string; how: string } {
  return {
    why: '이야기는 채널마다 따로 쌓입니다 — 다른 채널에서 오간 말은 여기 안 보입니다.',
    how: '아래에 첫 마디를 적어 보세요.',
  };
}
