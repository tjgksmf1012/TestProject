import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  badgeText,
  describeKind,
  emptyNote,
  hrefFor,
  isUrgent,
  readableIds,
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
    strictEqual(hrefFor(notice(), 3), '/chat.html?project=3');
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
