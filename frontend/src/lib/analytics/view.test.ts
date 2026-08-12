import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LOAD_NOTE,
  NOTHING_FOUND,
  overdueText,
  progressText,
  reasonText,
  SIGNAL_ORDER,
  signalView,
  signalViews,
  srcView,
  taskHref,
  type Progress,
  type RiskSignal,
} from './view.ts';

function progress(over: Partial<Progress> = {}): Progress {
  return { total: 10, finished: 4, overdue: 0, ratio: 0.4, ...over };
}

function signal(over: Partial<RiskSignal> = {}): RiskSignal {
  return {
    kind: 'behind_schedule',
    detail: { elapsed: 0.8, finished_ratio: 0.4, days_left: 7, unfinished: 6 },
    task_ids: [1, 2, 3],
    ...over,
  };
}

describe('진행률', () => {
  it('완료와 전체를 함께 말한다', () => {
    strictEqual(progressText(progress()), '4 / 10 완료 (40%)');
  });

  it('⭐ 업무가 없으면 **0% 라고 쓰지 않는다**', () => {
    // `0%` 는 "시작도 안 했다" 로 읽히는데, 실제로는 아직 잴 수 없는
    // 것입니다 (측정 불가 ≠ 0점).
    const text = progressText(progress({ total: 0, finished: 0, ratio: null }));
    strictEqual(text.includes('0%'), false);
    strictEqual(text.includes('잴 수 없'), true);
  });

  it('마감이 지난 것은 건수까지 말한다', () => {
    strictEqual(overdueText(progress({ overdue: 3 })), '마감이 지난 업무 3건');
  });

  it('없으면 조용하다 — 0을 적으면 눈에 걸린다', () => {
    strictEqual(overdueText(progress({ overdue: 0 })), null);
  });
});

describe('왜 그렇게 봤는가', () => {
  it('기간 대비 완료는 두 비율을 다 보여 준다', () => {
    strictEqual(reasonText(signal()), '기간 80% 지남 · 완료 40% · 남은 기간 7일');
  });

  it('병목은 막는 것과 막힌 것을 센다', () => {
    strictEqual(
      reasonText(
        signal({ kind: 'blocked_by_late', detail: { late_predecessors: 2, blocked_tasks: 5 } }),
      ),
      '마감이 지난 선행 2건이 5건을 막고 있습니다',
    );
  });

  it('오래된 업무는 가장 오래된 것을 말한다', () => {
    strictEqual(
      reasonText(signal({ kind: 'stale_tasks', detail: { count: 4, oldest_days: 40 } })),
      '4건 · 가장 오래된 것은 40일째',
    );
  });

  it('편중은 숫자만 놓는다', () => {
    strictEqual(
      reasonText(
        signal({
          kind: 'workload_skew',
          detail: { name: '김민수', open_tasks: 6, team_open_tasks: 9 },
        }),
      ),
      '김민수 님이 팀의 미완료 9건 중 6건을 맡고 있습니다',
    );
  });

  it('활동 감소는 앞뒤를 나란히 놓는다', () => {
    strictEqual(
      reasonText(
        signal({ kind: 'activity_drop', detail: { recent: 1, before: 10, window_days: 7 } }),
      ),
      '최근 7일 1건 · 그 앞 7일 10건',
    );
  });

  it('⭐ 못 만들면 **지어내지 않는다**', () => {
    // "알 수 없는 이유로 걸렸습니다" 는 아무 말도 안 하는 것보다 나쁩니다.
    strictEqual(reasonText(signal({ detail: {} })), null);
    strictEqual(reasonText(signal({ kind: 'workload_skew', detail: {} })), null);
    strictEqual(reasonText(signal({ kind: 'brand_new', detail: { a: 1 } })), null);
  });
});

describe('⭐ 판정하지 않는다', () => {
  it('제목이 사람을 나무라지 않는다', () => {
    for (const kind of SIGNAL_ORDER) {
      const view = signalView(signal({ kind }));
      for (const verdict of ['과부하', '게으', '문제입니다', '잘못', '실패', '위험합니다']) {
        strictEqual(view.title.includes(verdict), false, `${kind}: ${verdict}`);
      }
    }
  });

  it('⭐ 재배정을 제안하지 않는다', () => {
    // "김민수의 업무를 이지연에게 넘기세요" 는 사람에 대한 판정이고,
    // 그중에서도 제일 무거운 것입니다 (제안서 §4.5 다섯째를 안 만든 이유).
    const view = signalView(
      signal({
        kind: 'workload_skew',
        detail: { name: '김민수', open_tasks: 6, team_open_tasks: 9 },
      }),
    );
    const line = `${view.title} ${view.reason ?? ''}`;
    for (const verdict of ['넘기', '재배정', '권장', '해야 합니다', '줄이세요']) {
      strictEqual(line.includes(verdict), false, verdict);
    }
  });

  it('⭐ 부하가 기여도가 아니라고 **화면이 말한다**', () => {
    // 안 적으면 사람은 이 숫자를 성적으로 읽습니다.
    strictEqual(LOAD_NOTE.includes('기여도가 아닙니다'), true);
  });

  it('⭐ 신호가 없어도 "문제 없습니다" 라고 하지 않는다', () => {
    // 규칙이 못 본 것일 수도 있고, 단정하면 사람이 확인을 멈춥니다.
    strictEqual(NOTHING_FOUND.includes('문제 없'), false);
    strictEqual(NOTHING_FOUND.includes('못 보는'), true);
  });
});

describe('⭐ 근거를 볼 자리', () => {
  it('업무 번호가 갈 곳을 만든다', () => {
    strictEqual(taskHref(3, 42), '/kanban.html?project=3&task=42');
  });

  it('⭐ 프로젝트를 빠뜨리지 않는다', () => {
    // 없으면 칸반이 기본값 1번을 열고, 남의 판에서 없는 업무를 찾습니다.
    strictEqual(taskHref(7, 1).includes('project=7'), true);
  });

  it('여덟까지 늘어놓는다', () => {
    const view = srcView([1, 2, 3]);
    deepStrictEqual(view.shown, [1, 2, 3]);
    strictEqual(view.more, 0);
  });

  it('⭐ 자른 것을 **말한다**', () => {
    // 조용히 자르면 화면이 "이게 전부" 로 읽히고, 사람은 틀린 줄도
    // 모릅니다. 세는 것을 다루는 화면에서 제일 나쁜 부류입니다.
    const view = srcView([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    strictEqual(view.shown.length, 8);
    strictEqual(view.more, 4);
  });

  it('없으면 둘 다 비어 있다', () => {
    deepStrictEqual(srcView([]), { shown: [], more: 0 });
  });
});

describe('여러 신호', () => {
  it('⭐ 순서는 고정 — 심각도 순이 아니다', () => {
    const views = signalViews([
      signal({ kind: 'activity_drop' }),
      signal({ kind: 'behind_schedule' }),
      signal({ kind: 'stale_tasks' }),
    ]);
    deepStrictEqual(
      views.map((v) => v.kind),
      ['behind_schedule', 'stale_tasks', 'activity_drop'],
    );
  });

  it('⭐ 모르는 종류를 **버리지 않는다**', () => {
    const views = signalViews([signal({ kind: 'brand_new' })]);
    strictEqual(views.length, 1);
    strictEqual(views[0]?.title, 'brand_new');
  });

  it('근거 업무를 들고 간다 — 열 자리가 있어야 한다', () => {
    deepStrictEqual(signalView(signal()).taskIds, [1, 2, 3]);
  });

  it('없으면 빈 목록', () => {
    deepStrictEqual(signalViews([]), []);
  });
});
