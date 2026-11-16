import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEMO_SCRIPT_PRESETS,
  parseDemoScript,
  similarityPercent,
} from './demo.ts';

describe('audio/demo', () => {
  it('유효한 대본을 발언자·타임스탬프 목록으로 파싱한다', () => {
    const parsed = parseDemoScript('김민수: 로그인 구현\n이하늘: 테스트 검토');
    deepStrictEqual(parsed, {
      ok: true,
      lines: [
        { speaker: '김민수', text: '로그인 구현', start_sec: 0, end_sec: 5 },
        { speaker: '이하늘', text: '테스트 검토', start_sec: 5, end_sec: 10 },
      ],
    });
  });

  it('빈 입력·콜론 누락·100줄 초과를 거부한다', () => {
    strictEqual(parseDemoScript('').ok, false);
    strictEqual(parseDemoScript('발언자 구분 없음').ok, false);
    const over = Array.from({ length: 101 }, (_, i) => `a: line ${i}`).join('\n');
    strictEqual(parseDemoScript(over).ok, false);
  });

  it('내장 프리셋 모두가 파싱 규칙을 통과한다', () => {
    for (const preset of DEMO_SCRIPT_PRESETS) {
      strictEqual(parseDemoScript(preset.script).ok, true, preset.key);
    }
  });

  it('코사인 유사도([-1, 1])를 0~100% 막대 폭으로 변환한다', () => {
    strictEqual(similarityPercent(undefined), 0);
    strictEqual(similarityPercent(-1), 0);
    strictEqual(similarityPercent(0), 50);
    strictEqual(similarityPercent(1), 100);
  });
});
