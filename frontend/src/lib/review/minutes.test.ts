import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  agendaItems,
  atText,
  describeIssue,
  hasExtraMinutes,
  issueViews,
  type UnresolvedIssue,
} from './minutes.ts';

function issue(over: Partial<UnresolvedIssue> = {}): UnresolvedIssue {
  return {
    content: '배포 방식을 못 정했습니다',
    start_ms: 125_000,
    end_ms: 131_000,
    evidence_utterance_ids: [4, 5],
    ...over,
  };
}

describe('atText', () => {
  it('mm:ss 로 적는다', () => {
    strictEqual(atText(125_000), '2:05');
    strictEqual(atText(59_000), '0:59');
    strictEqual(atText(3_600_000), '60:00');
  });

  it('⭐ 근거가 없어 0 인 것은 **시각을 지어내지 않는다**', () => {
    // 0 을 `0:00` 으로 적으면 "회의 맨 처음에 나온 얘기" 로 읽힙니다.
    // 실제로는 근거 발화가 없어서 구간을 모르는 것입니다.
    strictEqual(atText(0), null);
    strictEqual(atText(-1), null);
    strictEqual(atText(Number.NaN), null);
  });
});

describe('describeIssue', () => {
  it('내용·시각·근거 건수를 같이 준다', () => {
    deepStrictEqual(describeIssue(issue()), {
      content: '배포 방식을 못 정했습니다',
      at: '2:05',
      evidenceCount: 2,
    });
  });

  it('⭐ 근거 0건도 **감추지 않는다**', () => {
    // 감추면 근거 없는 사안이 근거 있는 것과 똑같아 보입니다.
    const view = describeIssue(issue({ evidence_utterance_ids: [], start_ms: 0 }));
    strictEqual(view.evidenceCount, 0);
    strictEqual(view.at, null);
  });
});

describe('issueViews', () => {
  it('내용이 빈 것은 뺀다 — 숫자만 부풀린다', () => {
    const views = issueViews([issue(), issue({ content: '   ' }), issue({ content: '' })]);
    strictEqual(views.length, 1);
  });
});

describe('agendaItems', () => {
  it('빈 줄과 중복을 뺀다', () => {
    deepStrictEqual(agendaItems(['배포 논의', '  ', '배포 논의', ' 일정 확정 ']), [
      '배포 논의',
      '일정 확정',
    ]);
  });

  it('없으면 빈 배열', () => {
    deepStrictEqual(agendaItems([]), []);
  });
});

describe('hasExtraMinutes', () => {
  const empty = { next_agenda: [], unresolved_issues: [] };

  it('둘 다 없으면 false', () => {
    strictEqual(hasExtraMinutes(empty), false);
  });

  it('⭐ 요약은 **세지 않는다** — 자기 자리가 따로 있다', () => {
    // 요약까지 세면 다음 안건도 미해결 사안도 없는 회의에서 빈 상자
    // 두 개가 열립니다.
    strictEqual(
      hasExtraMinutes({ ...empty, ...({ summary: '요약이 있습니다' } as object) }),
      false,
    );
  });

  it('둘 중 하나만 있어도 연다', () => {
    strictEqual(hasExtraMinutes({ ...empty, next_agenda: ['배포 논의'] }), true);
    strictEqual(hasExtraMinutes({ ...empty, unresolved_issues: [issue()] }), true);
  });

  it('빈 항목만 있으면 안 연다', () => {
    strictEqual(hasExtraMinutes({ ...empty, next_agenda: ['  ', ''] }), false);
    strictEqual(
      hasExtraMinutes({ ...empty, unresolved_issues: [issue({ content: '' })] }),
      false,
    );
  });
});
