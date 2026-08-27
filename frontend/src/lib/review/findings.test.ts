import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  atText,
  findingView,
  findingViews,
  KIND_ORDER,
  whyText,
  type Finding,
} from './findings.ts';

function finding(over: Partial<Finding> = {}): Finding {
  return {
    kind: 'repeated_discussion',
    start_ms: 0,
    end_ms: 90_000,
    evidence_utterance_ids: [1, 2, 5, 6],
    detail: { shared_words: ['로그인', '인증'], apart_ms: 1_490_000 },
    ...over,
  };
}

describe('시각', () => {
  it('밀리초를 분:초로', () => {
    strictEqual(atText(750_000), '12:30');
    strictEqual(atText(65_000), '1:05');
  });

  it('⭐ 0이면 **시각을 지어내지 않는다**', () => {
    // 근거가 없으면 서버가 0을 보냅니다. `0:00` 이라고 적으면 회의
    // 시작에 있었던 일처럼 보입니다.
    strictEqual(atText(0), null);
    strictEqual(atText(-1), null);
    strictEqual(atText(Number.NaN), null);
  });

  it('구간이 한 점이면 한 번만 적는다', () => {
    strictEqual(findingView(finding({ start_ms: 5_000, end_ms: 5_000 })).at, '0:05');
  });

  it('시각이 없으면 조용하다', () => {
    strictEqual(findingView(finding({ start_ms: 0, end_ms: 0 })).at, null);
  });
});

describe('왜 걸렸는가', () => {
  it('반복 논의는 겹친 낱말과 벌어진 시간을 말한다', () => {
    strictEqual(whyText(finding()), '로그인 · 인증 얘기가 다시 나왔습니다 — 25분 만에');
  });

  it('주제 이탈은 무슨 얘기였는지 말한다', () => {
    const why = whyText(
      finding({ kind: 'topic_drift', detail: { off_topic_words: ['점심', '메뉴'] } }),
    );
    strictEqual(why, '점심 · 메뉴 얘기를 하는 동안입니다');
  });

  it('미완성 업무는 건수를 말한다', () => {
    strictEqual(
      whyText(finding({ kind: 'incomplete_task', detail: { count: 2 } })),
      '약속 2건이 업무 후보로 안 이어졌습니다',
    );
  });

  it('결정 번복은 무엇에 대한 결정인지 말한다', () => {
    strictEqual(
      whyText(finding({ kind: 'decision_conflict', detail: { shared_words: ['배포'] } })),
      '배포에 대한 결정이 둘입니다',
    );
  });

  it('⭐ 내부 사정을 사람에게 보여 주지 않는다', () => {
    // `supersedes` 는 컬럼 이름입니다. 결함 78·86 과 같은 부류 —
    // 오류 문구가 내부 상태 이름을 흘리던 것. **그 결정은 그대로입니다.**
    //
    // ⚠️ 예전에는 이 자가 문구를 **글자 그대로** 못 박고 있었습니다
    // (`'회의에서 앞의 결정을 뒤집었습니다'`). 결함 339 가 그 문구를
    // 고치자 요구는 하나도 안 바뀌었는데 이 자만 터졌습니다 — 결함
    // 335(`id="keep-audio"`)·338(`1023.5px`)과 같은 모양입니다.
    // 재는 것은 「컬럼 이름이 새는가」이지 「무슨 문장인가」가 아닙니다.
    for (const detail of [
      { how: 'supersedes' },
      { how: 'supersedes', superseded_content: '인증 방식은 JWT 로 간다' },
      { how: 'wording', shared_words: ['인증'] },
    ]) {
      const why = whyText(finding({ kind: 'decision_conflict', detail })) ?? '';
      ok(!/supersedes|wording|decision_ids|superseded_decision_id/.test(why), why);
    }
  });

  it('⭐ 이유를 못 만들면 **지어내지 않는다**', () => {
    // "알 수 없는 이유로 걸렸습니다" 는 아무 말도 안 하는 것보다 나쁩니다.
    strictEqual(whyText(finding({ detail: {} })), null);
    strictEqual(whyText(finding({ kind: 'topic_drift', detail: {} })), null);
    strictEqual(whyText(finding({ kind: 'incomplete_task', detail: { count: 0 } })), null);
  });

  it('벌어진 시간이 없어도 겹친 낱말은 말한다', () => {
    strictEqual(
      whyText(finding({ detail: { shared_words: ['배포'] } })),
      '배포 얘기가 다시 나왔습니다',
    );
  });
});

describe('한 줄로 보이는 모양', () => {
  it('이름과 뜻이 붙는다', () => {
    const view = findingView(finding());
    strictEqual(view.title, '반복 논의');
    strictEqual(view.what, '같은 화제가 한참 뒤에 다시 나왔습니다');
  });

  it('⭐ "비효율적입니다" 라고 판정하지 않는다', () => {
    // 무슨 일이 있었는지만 적고, 그게 문제인지는 팀이 정합니다.
    for (const kind of KIND_ORDER) {
      const view = findingView(finding({ kind }));
      const line = `${view.title} ${view.what ?? ''}`;
      for (const verdict of ['비효율', '낭비', '잘못', '문제입니다', '나쁜']) {
        strictEqual(line.includes(verdict), false, `${kind}: ${verdict}`);
      }
    }
  });

  it('⭐ 근거 발화를 들고 간다 — 열 자리가 있어야 한다', () => {
    deepStrictEqual(findingView(finding()).evidence, [1, 2, 5, 6]);
  });

  it('⚠️ 모르는 종류를 지어내지 않는다', () => {
    const view = findingView(finding({ kind: 'sarcasm_detected' }));
    strictEqual(view.title, 'sarcasm_detected');
    strictEqual(view.what, null);
  });
});

describe('여러 건', () => {
  it('⭐ 순서는 고정 — 건수 순이 아니다', () => {
    const views = findingViews([
      finding({ kind: 'decision_conflict', start_ms: 1 }),
      finding({ kind: 'repeated_discussion', start_ms: 2 }),
      finding({ kind: 'topic_drift', start_ms: 3 }),
    ]);
    deepStrictEqual(
      views.map((v) => v.kind),
      ['repeated_discussion', 'topic_drift', 'decision_conflict'],
    );
  });

  it('같은 종류끼리는 시간 순', () => {
    const views = findingViews([
      finding({ start_ms: 90_000, end_ms: 120_000 }),
      finding({ start_ms: 10_000, end_ms: 20_000 }),
    ]);
    deepStrictEqual(
      views.map((v) => v.at),
      ['0:10 ~ 0:20', '1:30 ~ 2:00'],
    );
  });

  it('⭐ 모르는 종류를 **버리지 않는다**', () => {
    // 버리면 탐지기를 하나 더 붙였을 때 화면이 조용히 아무것도 안
    // 보여 줍니다 — 오류가 안 나서 안 보이는 부류입니다.
    const views = findingViews([finding({ kind: 'brand_new' })]);
    strictEqual(views.length, 1);
    strictEqual(views[0]?.title, 'brand_new');
  });

  it('없으면 빈 목록', () => {
    deepStrictEqual(findingViews([]), []);
  });
});

describe('「왜」 는 「무엇」 을 되풀이하지 않는다 (결함 339)', () => {
  // 「왜」 칸의 규칙은 `whyText` 머리말에 적혀 있습니다 — 만들 수 없으면
  // `null` 이고, **아무 말도 안 하는 문장을 적지 않습니다.** 「무엇」과
  // 같은 말을 다시 적는 것은 그 규칙을 어기는 또 다른 길입니다.
  //
  // 실제로 `decision_conflict` 의 `supersedes` 갈래가 그랬습니다 —
  // 화면에 「앞의 결정을 뒤집었습니다」와 「회의에서 앞의 결정을
  // 뒤집었습니다」가 **두 줄로** 나갔습니다. 그 갈래는 씨앗이 한 번도
  // 안 만들어서 아무도 못 봤습니다.
  const KINDS = [
    'repeated_discussion',
    'topic_drift',
    'incomplete_task',
    'decision_conflict',
    'overlap_surge',
  ];

  const view = (kind: string, detail: Record<string, unknown>) =>
    findingView({
      kind,
      severity: 'info',
      start_ms: 1000,
      end_ms: 2000,
      evidence_utterance_ids: [1],
      detail,
    } as never);

  it('⛔ 어느 종류도 「왜」 가 「무엇」 을 그대로 담지 않는다', () => {
    const DETAIL: Record<string, Record<string, unknown>> = {
      repeated_discussion: { shared_words: ['로그인'], apart_ms: 600000 },
      topic_drift: { off_topic_words: ['점심'] },
      incomplete_task: { count: 1 },
      decision_conflict: { how: 'supersedes', superseded_content: '인증 방식은 JWT 로 간다' },
      overlap_surge: { ratio: 0.77, baseline: 0.02 },
    };
    for (const kind of KINDS) {
      const v = view(kind, DETAIL[kind] ?? {});
      ok(v.why !== null, `${kind}: 「왜」 가 없습니다`);
      ok(v.what !== null, `${kind}: 「무엇」 이 없습니다`);
      ok(
        !(v.why as string).includes(v.what as string),
        `${kind}: 「왜」 가 「무엇」 을 되풀이합니다 — 화면에 같은 말이 두 줄입니다\n` +
          `   무엇: ${v.what}\n   왜  : ${v.why}`,
      );
    }
  });

  it('⭐ 뒤집힌 결정을 **번호가 아니라 글**로 말한다', () => {
    const v = view('decision_conflict', {
      how: 'supersedes',
      superseded_decision_id: 1,
      decision_ids: [1, 2],
      superseded_content: '인증 방식은 JWT 로 간다',
    });
    ok(v.why?.includes('인증 방식은 JWT 로 간다'), v.why ?? '(없음)');
    ok(!/#?\d/.test(v.why ?? ''), `번호가 그대로 나갑니다: ${v.why}`);
  });

  it('⛔ 뒤집힌 결정 글이 없으면 **지어내지 않고** 비운다', () => {
    const v = view('decision_conflict', { how: 'supersedes', superseded_decision_id: 1 });
    strictEqual(v.why, null);
  });
});
