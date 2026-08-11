import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CALL_AUDIO_CONSTRAINTS,
  callWarnings,
  captureProblems,
  describeCall,
  describePeer,
  planPeers,
  shouldInitiate,
  type PeerState,
  type PeerView,
  type RosterPeer,
} from './mesh.ts';

function peer(user_id: number, over: Partial<RosterPeer> = {}): RosterPeer {
  return {
    user_id,
    name: `팀원${user_id}`,
    headphones: true,
    joined_at: '2026-09-01T10:00:00Z',
    ...over,
  };
}

function view(user_id: number, state: PeerState): PeerView {
  return describePeer(peer(user_id), state);
}

describe('shouldInitiate — glare 를 막는다', () => {
  it('⭐ 둘 중 정확히 한 쪽만 건다', () => {
    // 둘 다 offer 를 만들면 양쪽 다 "내가 제안 중" 이 되어 상대의 offer 를
    // 못 받고 협상이 멈춘다. 화면에는 "연결 중…" 만 계속 뜬다.
    strictEqual(shouldInitiate(1, 2) !== shouldInitiate(2, 1), true);
  });

  it('작은 user_id 가 건다 — 양쪽이 같은 답을 봐야 한다', () => {
    strictEqual(shouldInitiate(1, 9), true);
    strictEqual(shouldInitiate(9, 1), false);
  });
});

describe('planPeers', () => {
  it('⭐ 나 자신에게는 연결하지 않는다', () => {
    const actions = planPeers([peer(1), peer(2)], 1, new Set());
    deepStrictEqual(actions, [{ type: 'open', user_id: 2, name: '팀원2', initiate: true }]);
  });

  it('⭐ 이미 열린 연결은 다시 열지 않는다', () => {
    // 명단은 사람이 하나 들어올 때마다 전원에게 다시 간다.
    // 매번 새로 열면 통화가 계속 끊기고 다시 붙는다.
    deepStrictEqual(planPeers([peer(1), peer(2)], 1, new Set([2])), []);
  });

  it('나간 사람의 연결은 닫는다', () => {
    deepStrictEqual(planPeers([peer(1)], 1, new Set([2])), [
      { type: 'close', user_id: 2 },
    ]);
  });

  it('들어온 사람과 나간 사람을 한 번에 처리한다', () => {
    const actions = planPeers([peer(1), peer(3)], 1, new Set([2]));
    deepStrictEqual(actions, [
      { type: 'open', user_id: 3, name: '팀원3', initiate: true },
      { type: 'close', user_id: 2 },
    ]);
  });

  it('빈 명단이면 열린 것을 전부 닫는다', () => {
    deepStrictEqual(planPeers([], 1, new Set([2, 3])), [
      { type: 'close', user_id: 2 },
      { type: 'close', user_id: 3 },
    ]);
  });

  it('순서가 흔들리지 않는다', () => {
    const a = planPeers([peer(5), peer(2), peer(9)], 1, new Set());
    const b = planPeers([peer(9), peer(5), peer(2)], 1, new Set());
    deepStrictEqual(a, b);
  });

  it('4명이면 나를 뺀 3명과 연결한다 (메시)', () => {
    const actions = planPeers([peer(1), peer(2), peer(3), peer(4)], 2, new Set());
    strictEqual(actions.filter((a) => a.type === 'open').length, 3);
  });
});

describe('describePeer', () => {
  it('⭐ disconnected 를 "끊겼습니다" 라고 하지 않는다', () => {
    // 네트워크가 잠깐 흔들리면 여기 왔다가 스스로 돌아온다.
    // "끊겼다" 고 하면 사람이 통화를 다시 걸고, 그러면 진짜로 끊긴다.
    const v = view(2, 'disconnected');
    strictEqual(v.tone, 'warn');
    strictEqual(v.label.includes('불안정'), true);
  });

  it('connected 만 ok 다', () => {
    strictEqual(view(2, 'connected').tone, 'ok');
    for (const state of ['new', 'connecting', 'disconnected'] as PeerState[]) {
      strictEqual(view(2, state).tone, 'warn');
    }
    strictEqual(view(2, 'failed').tone, 'bad');
  });

  it('⭐ 정상 종료(`closed`)는 **빨강이 아니다**', () => {
    // 예전에는 이 테스트가 `['failed', 'closed']` 를 한 배열로 묶어
    // **둘 다 `bad`** 라고 못 박고 있었습니다. 사람이 스스로 나간 것과
    // 연결이 실패한 것은 같은 색일 수 없습니다 — 빨강은 "네가 뭘
    // 잘못했다" 로 읽히고, 회의가 끝나 나간 사람은 아무것도 잘못하지
    // 않았습니다 (불변식 ③).
    strictEqual(view(2, 'closed').tone, 'warn');
    // 그리고 실패와 **글자도** 달라야 합니다.
    strictEqual(view(2, 'closed').label === view(2, 'failed').label, false);
  });

  it('헤드폰 여부를 잃지 않는다', () => {
    strictEqual(describePeer(peer(2, { headphones: false }), 'connected').headphones, false);
  });
});

describe('describeCall', () => {
  it('⭐ 혼자일 때 "연결됨" 이라고 하지 않는다', () => {
    const text = describeCall([]);
    strictEqual(text.includes('혼자'), true);
  });

  it('전원 연결되면 인원수를 말한다', () => {
    strictEqual(describeCall([view(2, 'connected'), view(3, 'connected')]), '2명과 통화 중입니다.');
  });

  it('일부만 붙었으면 몇 명인지 말한다', () => {
    const text = describeCall([view(2, 'connected'), view(3, 'connecting')]);
    strictEqual(text.includes('2명 중 1명'), true);
  });
});

describe('callWarnings', () => {
  it('⭐ 마이크가 없으면 내 발언이 하나도 기록되지 않는다', () => {
    const problems = callWarnings([], [], false);
    strictEqual(problems.length, 1);
    strictEqual(problems[0]?.includes('기록되지 않습니다'), true);
  });

  it('마이크가 있으면 그 경고는 없다', () => {
    deepStrictEqual(callWarnings([], [], true), []);
  });

  it('서버 경고(헤드폰 등)를 잃지 않는다', () => {
    const problems = callWarnings(['헤드폰을 쓰지 않는 사람이 있습니다: 팀원2'], [], true);
    strictEqual(problems.length, 1);
  });

  it('⭐ 연결 실패는 "그 사람에게 내 목소리가 안 간다" 로 말한다', () => {
    const problems = callWarnings([], [view(3, 'failed')], true);
    strictEqual(problems[0]?.includes('팀원3'), true);
    strictEqual(problems[0]?.includes('목소리'), true);
  });
});

describe('통화 모드 캡처 설정 (docs/15 §2.2)', () => {
  it('⭐ 같은 방과 반대다 — 에코 제거와 잡음 억제를 켠다', () => {
    strictEqual(CALL_AUDIO_CONSTRAINTS.echoCancellation, true);
    strictEqual(CALL_AUDIO_CONSTRAINTS.noiseSuppression, true);
  });

  it('⭐ 자동 게인만은 계속 끈다', () => {
    // AGC 는 조용한 사람의 트랙을 증폭해 듣고만 있던 사람이 말한 것으로
    // 잡히게 만든다. 배치와 무관하게 기여도를 왜곡한다 (docs/05 §5).
    strictEqual(CALL_AUDIO_CONSTRAINTS.autoGainControl, false);
  });

  it('브라우저가 AGC 를 못 껐으면 알아챈다', () => {
    const problems = captureProblems({ autoGainControl: true, echoCancellation: true });
    strictEqual(problems.length, 1);
    strictEqual(problems[0]?.includes('부풀려질'), true);
  });

  it('에코 제거를 못 켰으면 알아챈다', () => {
    const problems = captureProblems({ autoGainControl: false, echoCancellation: false });
    strictEqual(problems[0]?.includes('섞입니다'), true);
  });

  it('요청대로 적용됐으면 조용하다', () => {
    deepStrictEqual(
      captureProblems({ autoGainControl: false, echoCancellation: true, noiseSuppression: true }),
      [],
    );
  });
});
