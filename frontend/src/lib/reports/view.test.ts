/**
 * 보고서를 글자로 옮길 때 **잃으면 안 되는 것**.
 *
 * 이 파일에서 제일 중요한 것 하나: 복사된 글자에 **팀 경고가 남는가**.
 * 숫자만 복사돼 나가면 이 제품이 지키려던 것이 문서 밖으로 사라집니다.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeConfidence,
  describeFinal,
  describeRange,
  describeReportType,
  describeWhen,
  gapsOf,
  subjectOf,
  toPlainText,
  tooNewToRender,
  type Person,
  type ReportContent,
  type ReportSummary,
} from './view.ts';

function person(over: Partial<Person> = {}): Person {
  return {
    name: '홍길동',
    role: 'backend',
    measured: true,
    range_low: 40,
    range_high: 52,
    confidence: 0.9,
    confidence_label: '높음',
    reasons: [],
    evidence_count: 31,
    gaps: [],
    final_value: null,
    final_reason: null,
    ...over,
  };
}

const CONTENT: ReportContent = {
  schema: 1,
  report_type: 'final',
  title: '최종 보고서 — TeamFlow',
  notices: ['이 수치로 서로를 비교하지 마세요.', '계산값은 참고값입니다.'],
  blocks: [
    { kind: 'heading', text: '사람별 기여' },
    {
      kind: 'people',
      people: [
        person({ name: '김하늘', role: 'frontend', range_low: 20, range_high: 28 }),
        person({
          name: '박바다',
          role: 'design',
          measured: false,
          range_low: null,
          range_high: null,
          confidence: null,
          confidence_label: null,
          gaps: ['녹음이 끊겨 회의 기여를 못 쟀습니다'],
        }),
      ],
    },
    {
      kind: 'facts',
      items: [
        { label: '회의', value: '4건', gap: false },
        { label: '커버리지', value: '', gap: true, note: '트랙이 없습니다' },
      ],
    },
    { kind: 'list', items: [], empty_note: '측정하지 못한 항목이 없습니다.' },
    { kind: 'gap', text: '팀이 아직 확정하지 않았습니다.' },
  ],
};

describe('구간과 결측', () => {
  it('⭐ 못 잰 사람에게 0 을 쓰지 않는다', () => {
    const unmeasured = person({
      measured: false,
      range_low: null,
      range_high: null,
    });
    strictEqual(describeRange(unmeasured), '측정하지 못했습니다');
    ok(!describeRange(unmeasured).includes('0'));
  });

  it('잰 사람은 구간으로 나온다 — 단일 점수가 아니라', () => {
    strictEqual(describeRange(person()), '40% ~ 52%');
  });

  it('못 쟀으면 신뢰도라는 말 자체가 안 나온다', () => {
    strictEqual(describeConfidence(person({ measured: false, confidence: null })), null);
    strictEqual(describeConfidence(person()), '신뢰도 90% (높음)');
  });

  it('빈 사유는 걸러진다 — 빈 줄이 화면에 남지 않게', () => {
    deepStrictEqual(gapsOf(person({ gaps: ['   ', '녹음 끊김'] })), ['녹음 끊김']);
  });
});

describe('팀이 확정한 값', () => {
  it('이유가 있으면 값과 함께 나온다', () => {
    strictEqual(
      describeFinal(person({ final_value: 70, final_reason: '설계 문서를 혼자 맡았습니다' })),
      '팀 확정 70% — 설계 문서를 혼자 맡았습니다',
    );
  });

  it('확정 전이면 아무 줄도 안 만든다', () => {
    strictEqual(describeFinal(person()), null);
  });
});

describe('⭐ 복사한 글자', () => {
  it('팀 경고가 맨 위에 남는다', () => {
    const text = toPlainText(CONTENT);
    ok(text.includes('이 수치로 서로를 비교하지 마세요.'), text);
    ok(text.includes('계산값은 참고값입니다.'));
    // 제목 바로 다음이어야 합니다 — 끝에 붙으면 잘라 붙일 때 떨어집니다.
    const lines = text.split('\n');
    strictEqual(lines[0], '# 최종 보고서 — TeamFlow');
    ok(lines[1]?.startsWith('> 이 수치로'), lines[1] ?? '(둘째 줄이 없습니다)');
  });

  it('사람 순서를 화면이 다시 정하지 않는다', () => {
    const text = toPlainText(CONTENT);
    ok(text.indexOf('김하늘') < text.indexOf('박바다'), '받은 순서가 바뀌었습니다');
  });

  it('못 잰 사람이 글자에서도 0 이 아니다', () => {
    const text = toPlainText(CONTENT);
    ok(text.includes('박바다'));
    ok(text.includes('측정하지 못했습니다'));
    ok(text.includes('못 잼: 녹음이 끊겨 회의 기여를 못 쟀습니다'));
  });

  it('못 잰 항목은 빈 칸이 아니라 "못 쟀습니다" 로 나간다', () => {
    ok(toPlainText(CONTENT).includes('커버리지: 못 쟀습니다 (트랙이 없습니다)'));
  });

  it('빈 목록은 "왜 비었는지" 를 대신 적는다', () => {
    ok(toPlainText(CONTENT).includes('측정하지 못한 항목이 없습니다.'));
  });

  it('빈 줄이 세 줄 넘게 이어지지 않는다', () => {
    ok(!/\n{3,}/.test(toPlainText(CONTENT)));
  });
});

describe('목록', () => {
  it('모르는 종류를 빈 글자로 만들지 않는다', () => {
    strictEqual(describeReportType('weekly'), '주간 보고서');
    strictEqual(describeReportType('quarterly'), 'quarterly');
  });

  it('기간이 있으면 기간을, 없으면 만든 날을 적는다', () => {
    strictEqual(
      describeWhen({
        id: 1,
        report_type: 'weekly',
        title: '',
        meeting_id: null,
        period_start: '2026-08-03T00:00:00Z',
        period_end: '2026-08-09T00:00:00Z',
        generated_at: '2026-08-11T00:00:00Z',
      }),
      '2026-08-03 ~ 2026-08-09',
    );
    strictEqual(
      describeWhen({
        id: 1,
        report_type: 'final',
        title: '',
        meeting_id: null,
        period_start: null,
        period_end: null,
        generated_at: '2026-08-11T00:00:00Z',
      }),
      '2026-08-11 만듦',
    );
  });
});

describe('모르는 판', () => {
  it('⭐ 못 그리는 것과 빈 것은 다르다', () => {
    strictEqual(tooNewToRender({ schema: 1 }), false);
    strictEqual(tooNewToRender({ schema: 2 }), true);
    strictEqual(tooNewToRender({}), false);
  });
});

describe('⭐ 목록에서 같은 말이 두 번 나오지 않는다', () => {
  const row = (over: Partial<ReportSummary> = {}): ReportSummary => ({
    id: 1,
    report_type: 'meeting_minutes',
    title: '회의록 — DB 스키마 확정 논의',
    meeting_id: 3,
    period_start: null,
    period_end: null,
    generated_at: '2026-08-11T00:00:00Z',
    ...over,
  });

  it('종류 머리말을 뗀다 — 칩이 이미 말하고 있다', () => {
    strictEqual(subjectOf(row()), 'DB 스키마 확정 논의');
    strictEqual(
      subjectOf(row({ report_type: 'final', title: '최종 보고서 — TeamFlow' })),
      'TeamFlow',
    );
  });

  it('⭐ 남은 것이 옆 칸과 같으면 비운다 — 주간은 날짜가 세 번 나왔다', () => {
    strictEqual(
      subjectOf(
        row({
          report_type: 'weekly',
          title: '주간 보고서 — 2026-08-05 ~ 2026-08-11',
          period_start: '2026-08-05T00:00:00Z',
          period_end: '2026-08-11T00:00:00Z',
        }),
      ),
      '',
    );
  });

  it('머리말이 없으면 제목을 그대로 둔다 — 지우지 않는다', () => {
    strictEqual(subjectOf(row({ title: '옛 형식 제목' })), '옛 형식 제목');
  });

  // ⚠️ 위의 검사들은 전부 `T00:00:00Z` 입니다 — 서울에서는 **같은 날 09시**라
  //    UTC 로 잘라도 팀 달력으로 잘라도 답이 같습니다. 그래서 결함 295 를
  //    한 번도 못 봤습니다. 여기서는 **자정을 넘는** 시각을 씁니다.
  const CROSSES = {
    // 2026-08-15T17:25Z = 팀 달력 2026-08-16 02:25
    period_start: '2026-08-15T17:25:00Z',
    // 2026-08-21T17:25Z = 팀 달력 2026-08-22 02:25
    period_end: '2026-08-21T17:25:00Z',
  };

  it('⭐ 서버가 지은 제목과 옆 칸이 **같은 글자**를 낸다 (결함 295)', () => {
    // 서버(`reports/period.py`)가 팀 달력으로 짓는 바로 그 제목입니다.
    const weekly = row({
      report_type: 'weekly',
      title: '주간 보고서 — 2026-08-16 ~ 2026-08-22',
      ...CROSSES,
    });
    strictEqual(describeWhen(weekly), '2026-08-16 ~ 2026-08-22');
    // 같은 말이 두 번 나오지 않습니다 — 갈라지면 이것부터 조용히 깨집니다.
    strictEqual(subjectOf(weekly), '');
  });
});

describe('목록의 때도 팀 달력이다 (결함 295)', () => {
  it('⭐ 기간을 UTC 로 자르지 않는다', () => {
    strictEqual(
      describeWhen({
        id: 1,
        report_type: 'weekly',
        title: '',
        meeting_id: null,
        period_start: '2026-08-15T17:25:00Z',
        period_end: '2026-08-21T17:25:00Z',
        generated_at: '2026-08-21T17:25:00Z',
      }),
      '2026-08-16 ~ 2026-08-22',
    );
  });

  it('⭐ 만든 날도 팀 달력이다', () => {
    strictEqual(
      describeWhen({
        id: 1,
        report_type: 'final',
        title: '',
        meeting_id: null,
        period_start: null,
        period_end: null,
        generated_at: '2026-08-21T17:25:00Z',
      }),
      '2026-08-22 만듦',
    );
  });

  it('⚠️ 못 읽은 시각을 그럴듯한 날짜로 지어내지 않는다', () => {
    strictEqual(
      describeWhen({
        id: 1,
        report_type: 'final',
        title: '',
        meeting_id: null,
        period_start: null,
        period_end: null,
        generated_at: '언제였더라',
      }),
      '언제 만든 것인지 모릅니다',
    );
  });
});

describe('⭐ 글자로 옮길 때 문장을 잃지 않는다', () => {
  it('값이 있는 칸은 값을 그대로 적는다', () => {
    const content: ReportContent = {
      schema: 1,
      report_type: 'meeting_minutes',
      title: '회의록 — 기획',
      notices: [],
      blocks: [
        {
          kind: 'facts',
          items: [
            { label: '처리', value: '처리하다 실패했습니다', gap: false },
            { label: '커버리지', value: '', gap: true },
          ],
        },
      ],
    };
    const text = toPlainText(content);
    // 예전에는 `gap` 이 붙은 칸의 **문장이 통째로** 바뀌어 나갔습니다.
    ok(text.includes('처리: 처리하다 실패했습니다'), text);
    ok(text.includes('커버리지: 못 쟀습니다'), text);
  });
});
