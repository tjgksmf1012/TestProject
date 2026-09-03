import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  scrollIntentFor,
  canEdit,
  canSend,
  carriesMessages,
  channelTitle,
  describeEmptyChannel,
  continuesRun,
  dayGroups,
  describeDay,
  describeTime,
  DELETED_TEXT,
  mentionSegments,
  reactionAriaLabel,
  reactionIcon,
  offerableReactions,
  quoteFor,
  sendBlockedReason,
  type ChatChannel,
  type ChatMessage,
  MESSAGE_PAGE,
  hasOlderMessages,
  olderCursor,
  prependOlder,
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

  it('⭐ 고를 것은 **서버가 준 순서 그대로** — 다시 세우지 않는다 (결함 414)', () => {
    // 서버는 어휘 순서(`ok · agree · question · thanks`)로 내려보냅니다.
    // 화면이 자기 배열을 들고 있던 동안 `agree` 가 맨 앞이었습니다.
    const fromServer = [
      { mark: 'ok', label: '확인했어요' },
      { mark: 'agree', label: '동의해요' },
      { mark: 'question', label: '궁금해요' },
      { mark: 'thanks', label: '고마워요' },
    ];
    deepStrictEqual(
      offerableReactions(fromServer, []).map((c) => c.mark),
      ['ok', 'agree', 'question', 'thanks'],
    );
  });

  it('⛔ 이미 달린 것은 고를 목록에서 빠진다 — 순서는 그대로', () => {
    const fromServer = [
      { mark: 'ok', label: '확인했어요' },
      { mark: 'agree', label: '동의해요' },
      { mark: 'question', label: '궁금해요' },
    ];
    deepStrictEqual(
      offerableReactions(fromServer, [{ mark: 'agree' }]).map((c) => c.mark),
      ['ok', 'question'],
    );
  });

  it('⚠️ 서버가 못 오면 고를 것이 **없다** — 화면이 지어내지 않는다', () => {
    deepStrictEqual(offerableReactions([], []), []);
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

describe('대화의 앞부분에 닿는 길 (결함 315)', () => {
  it('⭐ 한 쪽이 꽉 찼으면 **더 있을 수 있다**고 본다', () => {
    /* 재서 확인한 것: 채널 하나에 메시지 60개를 넣었더니 서버가 50개를
       주고 화면이 50개를 그렸고, 「더 보기」 단추는 **0개**였습니다.
       첫 메시지가 「메시지 11」이라 처음 열 줄이 영영 안 보였습니다. */
    strictEqual(hasOlderMessages(50), true);
    strictEqual(hasOlderMessages(49), false);
    strictEqual(hasOlderMessages(0), false);
  });

  it('⚠️ 「있다」가 아니라 「있을 수 있다」 — 딱 한 쪽인 채널도 참이다', () => {
    // 눌러 보면 0개가 오고 그때 단추가 사라집니다. 미리 세면 요청이
    // 한 번 더 늘고 그 값은 곧 낡습니다.
    strictEqual(hasOlderMessages(MESSAGE_PAGE), true);
  });

  it('⭐ 다음 자리는 **가장 오래된 번호**다 — 순서가 뒤섞여 있어도', () => {
    strictEqual(olderCursor([{ id: 30 }, { id: 11 }, { id: 42 }]), 11);
    strictEqual(olderCursor([]), null);
  });

  it('⛔ 이어 붙일 때 **번호로 겹치는 것을 걸러낸다**', () => {
    // 누른 사이에 새 메시지가 오면 같은 것이 두 번 그려질 수 있습니다.
    const merged = prependOlder([{ id: 8 }, { id: 9 }, { id: 11 }], [{ id: 11 }, { id: 12 }]);
    deepStrictEqual(
      merged.map((m) => m.id),
      [8, 9, 11, 12],
    );
  });

  it('⚠️ 서버 한 쪽 크기와 **짝**이다 — 어긋나면 단추가 영영 안 뜨거나 영영 뜬다', () => {
    // backend/teamflow/services/message_service.py 의 MAX_PAGE.
    strictEqual(MESSAGE_PAGE, 50);
  });
});

// ══════════════════════════════════════════════════════════════
// 서버와 같은 규칙인가 — 공용 사례 (결함 411)
// ══════════════════════════════════════════════════════════════

const HERE = dirname(fileURLToPath(import.meta.url));

describe('⛔ `@이름` 을 고르는 규칙이 **서버와 같다** (결함 411)', () => {
  interface MentionCase {
    왜: string;
    names: string[];
    body: string;
    picked: string[];
  }

  function cases(): MentionCase[] {
    const data = JSON.parse(readFileSync(join(HERE, 'mention_cases.json'), 'utf8')) as {
      cases: MentionCase[];
    };
    return data.cases;
  }

  /** 강조 조각에서 이름만 — 본문 순서 · 중복 없음. */
  function picked(body: string, names: string[]): string[] {
    const out: string[] = [];
    for (const segment of mentionSegments(body, names)) {
      if (!segment.mention) continue;
      const name = segment.text.slice(1);
      if (!out.includes(name)) out.push(name);
    }
    return out;
  }

  it('⭐ 화면이 **사례대로** 고른다 — 서버와 같은 파일을 읽는다', () => {
    const rows = cases();
    ok(rows.length >= 5, '사례가 너무 적습니다 — 검사가 낡았습니다');
    const wrong = rows
      .map((c) => {
        const got = picked(c.body, c.names);
        return JSON.stringify(got) === JSON.stringify(c.picked)
          ? null
          : `${c.왜}: 화면 ${JSON.stringify(got)} · 사례 ${JSON.stringify(c.picked)}`;
      })
      .filter((x): x is string => x !== null);
    deepStrictEqual(wrong, [], `공용 사례와 다릅니다:\n  ${wrong.join('\n  ')}`);
  });

  it('⚠️ 사례가 **양쪽 답을 다 만든다** — 전부 빈 목록이면 아무것도 안 잰다', () => {
    const empties = new Set(cases().map((c) => c.picked.length === 0));
    deepStrictEqual([...empties].sort(), [false, true]);
  });
});

describe('답글이 **무엇에 달렸는지** (결함 419)', () => {
  const msg = (over: Partial<ChatMessage> = {}): ChatMessage =>
    ({
      id: 1,
      channel_id: 2,
      author_id: 3,
      author_name: '이하늘',
      body: '원글입니다',
      reply_to_id: null,
      created_at: '2026-08-26T05:00:00Z',
      edited_at: null,
      deleted: false,
      mentions: [],
      reactions: [],
      my_reaction: null,
      ...over,
    }) as ChatMessage;

  it('답글이 아니면 아무것도 안 그린다', () => {
    strictEqual(quoteFor(null, [msg()]), null);
  });

  it('⭐ 원글이 창 안에 있으면 **인용**한다', () => {
    deepStrictEqual(quoteFor(1, [msg()]), {
      kind: 'quote',
      who: '이하늘',
      body: '원글입니다',
    });
  });

  it('⛔ 원글이 **아직 안 불러온 앞쪽**이면 그렇게 말한다 — 조용히 비우지 않는다', () => {
    // 서버는 최신 50개만 줍니다(`MESSAGE_PAGE`). 55개짜리 채널에서
    // 앞쪽 글에 단 답글이 **평범한 글처럼** 보였습니다.
    const view = quoteFor(99, [msg()]);
    strictEqual(view?.kind, 'older');
    ok(
      view.kind === 'older' && view.note.includes('이전 대화 더 보기'),
      '갈 자리를 안 가리킵니다 — 말만 하고 문을 안 주면 실패 ③ 입니다',
    );
  });

  it('⚠️ 지워진 원글은 **본문을 되살리지 않는다**', () => {
    deepStrictEqual(quoteFor(1, [msg({ deleted: true })]), {
      kind: 'quote',
      who: '이하늘',
      body: DELETED_TEXT,
    });
  });
});

describe('목록이 바뀌었을 때 어디를 보여 주는가 (결함 433)', () => {
  const ids = (...n: number[]) => n.map((id) => ({ id }));

  it('⭐ **옛 대화를 앞에 붙이면 읽던 자리를 지킨다** — 맨 아래로 돌아가지 않는다', () => {
    // 결함 433 이 난 자리. 옛 코드는 여기서도 맨 아래로 굴러서, 방금 불러온
    // 쉰 줄을 지나쳐 「누르기 전과 똑같은 화면」이 됐습니다.
    strictEqual(scrollIntentFor(ids(71, 72, 73), ids(21, 22, 71, 72, 73)), 'keep-position');
  });

  it('새 메시지가 끝에 붙으면 맨 아래로', () => {
    strictEqual(scrollIntentFor(ids(71, 72), ids(71, 72, 73)), 'to-bottom');
  });

  it('처음 그리는 것(채널을 연 순간)은 맨 아래로', () => {
    strictEqual(scrollIntentFor([], ids(71, 72)), 'to-bottom');
  });

  it('안 바뀌었으면 건드리지 않는다', () => {
    strictEqual(scrollIntentFor(ids(71, 72), ids(71, 72)), 'none');
  });

  it('빈 목록은 건드리지 않는다', () => {
    strictEqual(scrollIntentFor(ids(71), []), 'none');
  });

  it('⭐ 옛 대화를 불러오는 사이에 새 메시지가 오면 **새것**을 보여 준다', () => {
    // 양쪽이 다 바뀐 경우. 사람은 새 메시지를 보고 싶어 합니다.
    strictEqual(scrollIntentFor(ids(71, 72), ids(21, 71, 72, 73)), 'to-bottom');
  });

  it('⭐ 개수로는 갈리지 않는다 — 그래서 **양 끝의 번호**로 잽니다', () => {
    // 셋 다 「3개 → 3개」 인데 뜻이 다릅니다.
    strictEqual(scrollIntentFor(ids(71, 72, 73), ids(71, 72, 73)), 'none');
    strictEqual(scrollIntentFor(ids(71, 72, 73), ids(72, 73, 74)), 'to-bottom');
    strictEqual(scrollIntentFor(ids(71, 72, 73), ids(69, 70, 73)), 'keep-position');
  });
});
