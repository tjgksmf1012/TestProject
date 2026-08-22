import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canEdit,
  canSend,
  carriesMessages,
  channelTitle,
  describeEmptyChannel,
  continuesRun,
  dayGroups,
  describeDay,
  describeTime,
  mentionSegments,
  reactionAriaLabel,
  reactionIcon,
  sendBlockedReason,
  type ChatChannel,
  type ChatMessage,
} from './view.ts';

const TEXT: ChatChannel = { id: 1, kind: 'text', name: '일반', position: 1 };
const VOICE: ChatChannel = { id: 2, kind: 'voice', name: '주간회의', position: 2 };

function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 1,
    channel_id: 1,
    author_id: 10,
    author_name: '김민수',
    body: '안녕하세요',
    reply_to_id: null,
    created_at: '2026-08-12T05:00:00+00:00',
    edited_at: null,
    deleted: false,
    mentions: [],
    reactions: [],
    my_reaction: null,
    ...over,
  };
}

describe('채널', () => {
  it('`#` 은 화면이 붙인다 — 이름에 저장하지 않는다', () => {
    strictEqual(channelTitle(TEXT), '#일반');
  });

  it('음성 채널에는 `#` 을 안 붙인다 — 방 이름이지 말이 쌓이는 곳이 아니다', () => {
    strictEqual(channelTitle(VOICE), '주간회의');
  });

  it('⭐ 음성 채널에는 못 쓴다 — 화면이 그걸 알아야 입력창을 안 그린다', () => {
    strictEqual(carriesMessages(TEXT), true);
    strictEqual(carriesMessages(VOICE), false);
  });
});

describe('날짜 가르기', () => {
  it('오늘과 어제는 이름으로 부른다', () => {
    strictEqual(describeDay('2026-08-12', '2026-08-12'), '오늘');
    strictEqual(describeDay('2026-08-11', '2026-08-12'), '어제');
  });

  it('올해면 연도를 안 쓰고, 지난해면 쓴다', () => {
    strictEqual(describeDay('2026-03-04', '2026-08-12'), '3월 4일');
    strictEqual(describeDay('2025-12-31', '2026-08-12'), '2025년 12월 31일');
  });

  it('⚠️ 달을 넘어가는 어제도 어제다', () => {
    strictEqual(describeDay('2026-07-31', '2026-08-01'), '어제');
  });

  it('못 읽는 날짜를 그럴듯한 날로 만들지 않는다', () => {
    strictEqual(describeDay(''), '날짜를 알 수 없는 메시지');
  });

  it('⭐ 같은 날은 한 덩어리, 날이 바뀌면 새 덩어리', () => {
    const groups = dayGroups(
      [
        message({ id: 1, created_at: '2026-08-11T05:00:00+00:00' }),
        message({ id: 2, created_at: '2026-08-11T06:00:00+00:00' }),
        message({ id: 3, created_at: '2026-08-12T01:00:00+00:00' }),
      ],
      '2026-08-12',
    );
    deepStrictEqual(
      groups.map((g) => [g.label, g.messages.length]),
      [
        ['어제', 2],
        ['오늘', 1],
      ],
    );
  });

  it('⚠️ 팀 달력으로 가른다 — UTC 로 자르면 밤 메시지가 다음 날로 간다', () => {
    // 2026-08-11T16:00Z 는 서울에서 8월 12일 새벽 1시입니다.
    const groups = dayGroups([message({ created_at: '2026-08-11T16:00:00Z' })], '2026-08-12');
    strictEqual(groups[0]?.date, '2026-08-12');
  });

  it('빈 목록은 빈 덩어리', () => {
    deepStrictEqual(dayGroups([]), []);
  });
});

describe('한 줄', () => {
  it('시각은 24시간제로', () => {
    strictEqual(describeTime('2026-08-12T05:00:00Z'), '14:00');
  });

  it('⚠️ 못 읽는 시각에 `--:--` 같은 가짜를 만들지 않는다', () => {
    strictEqual(describeTime('언제인지 모름'), '');
  });

  it('같은 사람이 5분 안에 이어 쓰면 이름을 다시 안 쓴다', () => {
    const first = message({ id: 1, created_at: '2026-08-12T05:00:00Z' });
    const second = message({ id: 2, created_at: '2026-08-12T05:02:00Z' });
    strictEqual(continuesRun(first, second), true);
  });

  it('⚠️ 5분을 넘으면 다시 쓴다', () => {
    const first = message({ id: 1, created_at: '2026-08-12T05:00:00Z' });
    const later = message({ id: 2, created_at: '2026-08-12T05:30:00Z' });
    strictEqual(continuesRun(first, later), false);
  });

  it('다른 사람이면 안 잇는다', () => {
    const first = message({ id: 1, author_id: 10 });
    const other = message({ id: 2, author_id: 11, created_at: '2026-08-12T05:01:00Z' });
    strictEqual(continuesRun(first, other), false);
  });

  it('⭐ 지워진 자리 뒤에는 안 잇는다 — 이름 없는 줄이 누구 말인지 모르게 된다', () => {
    const gone = message({ id: 1, deleted: true, body: '' });
    const after = message({ id: 2, created_at: '2026-08-12T05:01:00Z' });
    strictEqual(continuesRun(gone, after), false);
  });

  it('답글은 앞줄과 안 잇는다 — 누구에게 한 말인지 보여야 한다', () => {
    const first = message({ id: 1 });
    const reply = message({ id: 2, reply_to_id: 1, created_at: '2026-08-12T05:01:00Z' });
    strictEqual(continuesRun(first, reply), false);
  });

  it('첫 줄은 언제나 이름을 쓴다', () => {
    strictEqual(continuesRun(undefined, message()), false);
  });

  it('고치기·지우기는 자기 것만', () => {
    strictEqual(canEdit(message({ author_id: 10 }), 10), true);
    strictEqual(canEdit(message({ author_id: 10 }), 11), false);
    strictEqual(canEdit(message({ deleted: true }), 10), false);
    strictEqual(canEdit(message(), null), false);
  });
});

describe('멘션 강조 — 꾸미기다', () => {
  it('서버가 준 이름만 강조한다', () => {
    deepStrictEqual(mentionSegments('@이하늘 봐주세요', ['이하늘']), [
      { text: '@이하늘', mention: true },
      { text: ' 봐주세요', mention: false },
    ]);
  });

  it('⭐ 서버가 안 준 이름은 강조하지 않는다 — 알림이 안 가는데 간 것처럼 보인다', () => {
    deepStrictEqual(mentionSegments('@아무개 안녕', []), [
      { text: '@아무개 안녕', mention: false },
    ]);
    deepStrictEqual(mentionSegments('@아무개 안녕', ['이하늘']), [
      { text: '@아무개 안녕', mention: false },
    ]);
  });

  it('조사가 붙어도 이름까지만 강조한다', () => {
    deepStrictEqual(mentionSegments('@이하늘은 어때요', ['이하늘']), [
      { text: '@이하늘', mention: true },
      { text: '은 어때요', mention: false },
    ]);
  });

  it('⚠️ 긴 이름이 이긴다 — 서버 판정과 같은 규칙', () => {
    deepStrictEqual(mentionSegments('@이하늘은 어때요', ['이하늘', '이하늘은']), [
      { text: '@이하늘은', mention: true },
      { text: ' 어때요', mention: false },
    ]);
  });

  it('여럿을 각각 강조한다', () => {
    deepStrictEqual(mentionSegments('@가 그리고 @나', ['가', '나']), [
      { text: '@가', mention: true },
      { text: ' 그리고 ', mention: false },
      { text: '@나', mention: true },
    ]);
  });

  it('본문의 이메일을 멘션으로 만들지 않는다', () => {
    deepStrictEqual(mentionSegments('a@b.com 으로', ['이하늘']), [
      { text: 'a@b.com 으로', mention: false },
    ]);
  });

  it('빈 본문(지워진 메시지)은 조각이 없다', () => {
    deepStrictEqual(mentionSegments('', ['이하늘']), []);
  });
});

describe('반응', () => {
  it('네 가지를 아이콘으로 옮긴다', () => {
    deepStrictEqual(
      ['ok', 'agree', 'question', 'thanks'].map(reactionIcon),
      ['check', 'thumb', 'ask', 'heart'],
    );
  });

  it('⭐ 모르는 반응에 아무 아이콘이나 붙이지 않는다', () => {
    strictEqual(reactionIcon('rage'), null);
  });

  it('낭독기가 개수와 "내가 눌렀는지" 를 듣는다', () => {
    const reaction = { mark: 'ok', label: '확인했어요', count: 2 };
    strictEqual(reactionAriaLabel(reaction, false), '확인했어요 2명');
    strictEqual(
      reactionAriaLabel(reaction, true),
      '확인했어요 2명, 내가 누름 — 다시 누르면 뗍니다',
    );
  });
});

describe('보낼 수 있는가', () => {
  it('빈 글자는 못 보내고, **이유를 안 적는다**', () => {
    strictEqual(canSend('   ', TEXT), false);
    strictEqual(sendBlockedReason('   ', TEXT), null);
  });

  it('채널을 안 골랐으면 그렇게 말한다', () => {
    strictEqual(canSend('안녕', null), false);
    strictEqual(sendBlockedReason('안녕', null), '왼쪽에서 채널을 고르세요.');
  });

  it('⭐ 음성 채널이면 왜 못 쓰는지 말한다', () => {
    strictEqual(canSend('안녕', VOICE), false);
    strictEqual(
      sendBlockedReason('안녕', VOICE),
      '주간회의 — 회의를 여는 방입니다. 대화는 텍스트 채널에서 합니다.',
    );
  });

  it('⚠️ 채널 이름 **바로 뒤에 조사를 붙이지 않는다** (결함 88)', () => {
    // 이름은 사용자가 짓습니다. `주간회의`(받침 없음)와 `개발팀`(받침 있음)이
    // 같은 조사를 쓸 수 없고, `은(는)` 짝 표기도 화면에 못 나갑니다.
    for (const name of ['주간회의', '개발팀']) {
      const note = sendBlockedReason('안녕', { ...VOICE, name }) ?? '';
      strictEqual(note.startsWith(`${name} —`), true, note);
    }
  });

  it('너무 길면 지금 몇 자인지 말한다', () => {
    const long = 'ㄱ'.repeat(4001);
    strictEqual(canSend(long, TEXT), false);
    strictEqual(
      sendBlockedReason(long, TEXT),
      '메시지는 4000자까지입니다 — 지금 4001자입니다.',
    );
  });

  it('보통은 보낼 수 있다', () => {
    strictEqual(canSend('안녕하세요', TEXT), true);
    strictEqual(sendBlockedReason('안녕하세요', TEXT), null);
  });
});

describe('채널이 비었을 때 (결함 304)', () => {
  it('⭐ **「방금 만들어졌습니다」라고 단언하지 않는다** — 화면은 만든 시각을 받지 않습니다', () => {
    /* `GET /api/projects/{id}/channels` 는 {id, kind, name, position} 만
       돌려줍니다. 지난달에 만들어 둔 채널도 「방금」이라고 말했습니다. */
    const { why } = describeEmptyChannel();
    strictEqual(/방금/.test(why), false);
    strictEqual(/만들어졌습니다/.test(why), false);
  });

  it('⭐ **바쁜 팀인데 왜 여기가 비었나**에 답한다', () => {
    const { why } = describeEmptyChannel();
    strictEqual(why.includes('채널마다'), true);
  });

  it('무엇을 하면 되는지 말한다', () => {
    strictEqual(describeEmptyChannel().how.includes('첫 마디'), true);
  });
});
