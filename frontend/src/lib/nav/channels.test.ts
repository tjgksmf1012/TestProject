import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  channelAriaLabel,
  channelHref,
  channelLabel,
  channelState,
  emptyChannelsNote,
  meetingChannels,
} from './channels.ts';
import { MEETING_STATUS_LABEL, type Meeting } from '../home/next.ts';

function meeting(over: Partial<Meeting> = {}): Meeting {
  return {
    meeting_id: 7,
    title: '1주차 정기회의',
    status: 'needs_review',
    started_at: '2026-09-01T01:00:00Z',
    pending_candidates: 3,
    ...over,
  };
}

// ══════════════════════════════════════════════════════════════
// 점이 무엇을 말하는가
// ══════════════════════════════════════════════════════════════

describe('channelState', () => {
  it('서버 상태 여섯 개를 전부 가른다', () => {
    deepStrictEqual(
      Object.keys(MEETING_STATUS_LABEL).map(channelState),
      ['open', 'working', 'working', 'todo', 'done', 'failed'],
    );
  });

  it('⭐ 서버가 아는 상태를 여기서 하나도 빠뜨리지 않는다', () => {
    // ⚠️ 위 테스트는 **순서에 기대는** 검사라, 표에 상태가 하나 더
    // 붙으면 그냥 길이가 안 맞아 깨집니다. 그건 좋습니다 — 조용히
    // 통과하는 것보다 깨지는 편이 낫습니다. 다만 왜 깨졌는지 말해
    // 주는 검사를 따로 둡니다.
    //
    // `MEETING_STATUS_LABEL` 은 `test_repo_integrity.py` 가 서버의
    // `MeetingStatus` 와 맞춰 놓은 표입니다. 여기서 그 표를 다시 쓰므로
    // 서버에 상태가 생기면 이 줄이 먼저 알려 줍니다.
    const unknown = Object.keys(MEETING_STATUS_LABEL).filter(
      (status) => channelState(status) === 'working' && !['queued', 'processing'].includes(status),
    );
    deepStrictEqual(unknown, [], `점을 안 정한 상태가 있습니다: ${unknown.join(', ')}`);
  });

  it('⚠️ 모르는 상태는 done 이 아니라 working 이다', () => {
    // done 으로 보면 사람이 "끝났구나" 로 읽고 다시 안 봅니다.
    strictEqual(channelState('archived'), 'working');
    strictEqual(channelState(''), 'working');
  });
});

// ══════════════════════════════════════════════════════════════
// 이름
// ══════════════════════════════════════════════════════════════

describe('channelLabel', () => {
  it('제목이 있으면 그대로 쓴다', () => {
    strictEqual(channelLabel(meeting({ title: '스프린트 회고' })), '스프린트 회고');
  });

  it('⭐ 제목이 없으면 번호로 부른다 — 이름 없는 줄을 만들지 않는다', () => {
    strictEqual(channelLabel(meeting({ meeting_id: 12, title: null })), '회의 12');
    strictEqual(channelLabel(meeting({ meeting_id: 12, title: '   ' })), '회의 12');
  });
});

// ══════════════════════════════════════════════════════════════
// 어디로 가는가
// ══════════════════════════════════════════════════════════════

describe('channelHref', () => {
  it('⭐ 프로젝트를 알면 주소에 실어 보낸다', () => {
    // 안 실으면 로비에 도착한 순간 칸반·기여도·설정 탭 셋이 흐려집니다.
    strictEqual(channelHref(7, 3), '/lobby.html?meeting=7&project=3');
  });

  it('프로젝트를 모르면 회의만 싣는다 — ?project=null 을 만들지 않는다', () => {
    strictEqual(channelHref(7), '/lobby.html?meeting=7');
    strictEqual(channelHref(7, null), '/lobby.html?meeting=7');
    strictEqual(channelHref(7, 0), '/lobby.html?meeting=7');
  });
});

// ══════════════════════════════════════════════════════════════
// 목록
// ══════════════════════════════════════════════════════════════

describe('meetingChannels', () => {
  it('⚠️ 서버가 준 순서를 바꾸지 않는다', () => {
    // 서버가 최근 것부터 줍니다. 여기서 다시 정렬하면 그 판단이 두 벌이
    // 되고, 한쪽만 고쳐지는 날이 옵니다.
    const channels = meetingChannels([
      meeting({ meeting_id: 9 }),
      meeting({ meeting_id: 4 }),
      meeting({ meeting_id: 7 }),
    ]);
    deepStrictEqual(channels.map((c) => c.meetingId), [9, 4, 7]);
  });

  it('지금 보고 있는 회의 하나만 current 다', () => {
    const channels = meetingChannels(
      [meeting({ meeting_id: 9 }), meeting({ meeting_id: 4 })],
      { currentMeetingId: 4 },
    );
    deepStrictEqual(channels.filter((c) => c.current).map((c) => c.meetingId), [4]);
  });

  it('맥락이 없으면 아무것도 current 가 아니다', () => {
    const channels = meetingChannels([meeting()]);
    deepStrictEqual(channels.filter((c) => c.current), []);
  });

  it('⭐ 남은 후보가 0건이면 배지를 만들지 않는다 (null)', () => {
    // 0 을 그리면 "0건 남음" 이라는 뜻 없는 표가 붙습니다.
    const [zero] = meetingChannels([meeting({ pending_candidates: 0 })]);
    strictEqual(zero?.pending, null);

    const [some] = meetingChannels([meeting({ pending_candidates: 3 })]);
    strictEqual(some?.pending, 3);
  });

  it('상태 라벨을 여기서 새로 짓지 않고 next.ts 에서 가져온다', () => {
    const [channel] = meetingChannels([meeting({ status: 'processing' })]);
    strictEqual(channel?.stateLabel, MEETING_STATUS_LABEL.processing);
  });

  it('빈 목록은 빈 목록이다 — 가짜 줄을 만들지 않는다', () => {
    deepStrictEqual(meetingChannels([]), []);
  });
});

// ══════════════════════════════════════════════════════════════
// 눈으로만 읽히는 것을 말로도 남기는가
// ══════════════════════════════════════════════════════════════

describe('channelAriaLabel', () => {
  it('⭐ 점과 개수 알약이 뜻하는 것을 말로 옮긴다', () => {
    const [channel] = meetingChannels([
      meeting({ title: '스프린트 회고', status: 'needs_review', pending_candidates: 3 }),
    ]);
    ok(channel);
    const label = channelAriaLabel(channel);
    ok(label.includes('스프린트 회고'), label);
    ok(label.includes(MEETING_STATUS_LABEL.needs_review ?? ''), label);
    ok(label.includes('3'), label);
  });

  it('남은 후보가 없으면 그 말을 붙이지 않는다', () => {
    const [channel] = meetingChannels([meeting({ pending_candidates: 0 })]);
    ok(channel);
    ok(!channelAriaLabel(channel).includes('검토 대기'), channelAriaLabel(channel));
  });
});

describe('emptyChannelsNote', () => {
  it('⭐ 왜 비었는지에서 그치지 않고 무엇을 하면 되는지까지 말한다', () => {
    const note = emptyChannelsNote();
    ok(note.includes('회의'), note);
    // 빈 화면에 "없습니다" 만 있으면 사람은 거기서 멈춥니다.
    ok(/설정|엽니다|만드/.test(note), note);
  });
});
