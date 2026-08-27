import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  badgeText,
  describeKind,
  emptyNote,
  hrefFor,
  isUrgent,
  readableIds,
  timeLabel,
  type Notice,
} from './view.ts';

function notice(over: Partial<Notice> = {}): Notice {
  return {
    kind: 'mention',
    at: '2026-09-01T05:00:00Z',
    text: '김민수 님이 대화에서 나를 불렀습니다',
    task_id: null,
    meeting_id: null,
    message_id: 7,
    channel_id: 4,
    notification_id: 3,
    read: false,
    ...over,
  };
}

describe('보이는 모양', () => {
  it('종류를 한 단어로', () => {
    strictEqual(describeKind('overdue'), '지연');
    strictEqual(describeKind('meeting_soon'), '회의');
  });

  it('⚠️ 모르는 종류를 지어내지 않는다', () => {
    strictEqual(describeKind('deploy_failed'), 'deploy_failed');
  });

  it('⭐ 곧 마감은 눈에 띄게 그리지 않는다 — 지난 것과 같아 보이면 안 된다', () => {
    strictEqual(isUrgent(notice({ kind: 'overdue' })), true);
    strictEqual(isUrgent(notice({ kind: 'due_soon' })), false);
    strictEqual(isUrgent(notice({ kind: 'mention' })), false);
  });

  it('종류마다 갈 곳이 다르다', () => {
    strictEqual(hrefFor(notice(), 3), '/chat.html?project=3&channel=4');
    strictEqual(
      hrefFor(notice({ message_id: null, task_id: 5 }), 3),
      '/kanban.html?project=3',
    );
    strictEqual(
      hrefFor(notice({ message_id: null, meeting_id: 9 }), 3),
      '/lobby.html?meeting=9&project=3',
    );
  });

  it('갈 데가 없으면 `null` — 못 누를 것을 버튼으로 그리지 않는다', () => {
    strictEqual(hrefFor(notice({ message_id: null }), 3), null);
  });

  it('⭐ 부름은 **그 채널로** 데려간다 — 문장이 말한 자리와 같은 곳 (결함 417)', () => {
    // 「디자인 채널에서 나를 불렀습니다」를 눌렀는데 `#공지` 가 열렸습니다.
    // ⚠️ 채널이 하나뿐이면 기본값이 언제나 맞아서 안 보입니다(결함 355).
    strictEqual(hrefFor(notice({ channel_id: 9 }), 3), '/chat.html?project=3&channel=9');
    strictEqual(hrefFor(notice({ channel_id: 2 }), 3), '/chat.html?project=3&channel=2');
  });

  it('⚠️ 채널을 모르면 **지어내지 않는다** — 채팅 화면까지만', () => {
    strictEqual(hrefFor(notice({ channel_id: null }), 3), '/chat.html?project=3');
  });
});

describe('읽음', () => {
  it('안 읽은 **저장된** 알림만 읽음 대상이다', () => {
    deepStrictEqual(
      readableIds([
        notice({ notification_id: 3, read: false }),
        notice({ notification_id: 4, read: true }),
      ]),
      [3],
    );
  });

  it('⭐ 마감은 읽음 대상이 아니다 — 읽어도 안 사라진다', () => {
    deepStrictEqual(
      readableIds([notice({ kind: 'overdue', notification_id: null, read: false })]),
      [],
    );
  });

  it('빈 목록은 빈 목록', () => {
    deepStrictEqual(readableIds([]), []);
  });
});

describe('배지', () => {
  it('⭐ 0 은 배지를 안 만든다 — "0건 남음" 은 뜻이 없다', () => {
    strictEqual(badgeText(0), null);
    strictEqual(badgeText(-1), null);
    strictEqual(badgeText(Number.NaN), null);
  });

  it('세 자리가 되면 줄인다 — 배지가 옆 글자를 민다', () => {
    strictEqual(badgeText(1), '1');
    strictEqual(badgeText(99), '99');
    strictEqual(badgeText(100), '99+');
  });
});

describe('빈 상태', () => {
  it('무엇이·왜·다음에 뭘 을 다 말한다', () => {
    const note = emptyNote();
    for (const part of [note.what, note.why, note.how]) {
      strictEqual(part.length > 0, true);
    }
  });
});

describe('시각 (결함 331)', () => {
  it('일어난 때는 팀 달력의 날짜와 시각으로 그린다', () => {
    const shown = timeLabel(notice({ kind: 'mention', at: '2026-09-01T05:00:00Z' }));
    strictEqual(shown !== null, true);
    strictEqual(shown?.startsWith('마감 '), false);
    // 팀 달력은 Asia/Seoul — UTC 05:00 은 그날 14시입니다.
    strictEqual(shown?.includes('14'), true, shown ?? '(없음)');
  });

  it('⭐ 마감 알림의 시각은 **마감일**이라고 이름을 붙인다', () => {
    // `deadline_notices` 는 `at=due` 로 만듭니다 — 「일어난 때」가 아닙니다.
    // 이름을 안 붙이면 사람은 같은 축의 다른 뜻을 못 봅니다.
    for (const kind of ['due_soon', 'overdue']) {
      const shown = timeLabel(notice({ kind, at: '2026-08-25T00:00:00Z' }));
      strictEqual(shown?.startsWith('마감 '), true, `${kind}: ${shown ?? '(없음)'}`);
    }
  });

  it('읽을 수 없는 값에 아무 말도 지어내지 않는다', () => {
    strictEqual(timeLabel(notice({ at: '' })), null);
    strictEqual(timeLabel(notice({ at: '어제쯤' })), null);
  });

  it('⭐ 브라우저 달력이 아니라 **팀 달력**으로 그린다', () => {
    // 결함 246 — 같은 순간을 팀원마다 다른 날로 보면 안 됩니다.
    // 자정을 넘는 순간을 심습니다: UTC 2026-09-01T16:00 = 서울 09-02 01:00.
    const shown = timeLabel(notice({ kind: 'overdue', at: '2026-09-01T16:00:00Z' }));
    strictEqual(shown?.includes('09-02'), true, shown ?? '(없음)');
  });
});
