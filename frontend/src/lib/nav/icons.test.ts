/**
 * 아이콘이 **그려지는 자리 안에** 있는가, 그리고 **주입 통로가 아닌가.**
 *
 * 이 마크업은 이스케이프 없이 화면에 들어갑니다. 상수만 있으면 안전하고,
 * 변수를 끼워 넣는 순간 그렇지 않습니다. 여기서 그걸 고정합니다.
 */

import { strictEqual, ok } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { ICON_NAMES, iconSvg } from './icons.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('아이콘 좌표', () => {
  it('⭐ 전부 24×24 안전 영역(3~21) 안에 있다', () => {
    // 선 굵기 2 + round cap 이 사방 1씩 나갑니다. 좌표가 3 밖이면
    // 20px 로 줄였을 때 가장자리가 잘립니다.
    const problems: string[] = [];
    for (const name of ICON_NAMES) {
      for (const [, num] of iconSvg(name).matchAll(/[MmLlHhVv]\s*(-?[\d.]+)/g)) {
        const v = Number(num);
        if (v < 3 || v > 21) problems.push(`${name}: ${v}`);
      }
      // rect·circle 도 본다
      const rect = /x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(
        iconSvg(name),
      );
      if (rect) {
        const [x, y, w, h] = rect.slice(1).map(Number) as [number, number, number, number];
        if (x < 3 || y < 3 || x + w > 21 || y + h > 21) problems.push(`${name}: rect`);
      }
      for (const c of iconSvg(name).matchAll(/cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)) {
        const [cx, cy, r] = c.slice(1).map(Number) as [number, number, number];
        if (cx - r < 3 || cy - r < 3 || cx + r > 21 || cy + r > 21) problems.push(`${name}: circle`);
      }
    }
    strictEqual(problems.join(', '), '');
  });

  it('⭐ 좌표가 정수이거나 .5 다', () => {
    // 부분 픽셀 좌표는 20px 에서 선이 두 픽셀에 걸쳐 흐려집니다.
    const problems: string[] = [];
    for (const name of ICON_NAMES) {
      for (const [, num] of iconSvg(name).matchAll(/[MmLlHhVv]\s*(-?[\d.]+)/g)) {
        const v = Math.abs(Number(num));
        if (Math.round(v * 2) !== v * 2) problems.push(`${name}: ${num}`);
      }
    }
    strictEqual(problems.join(', '), '');
  });
});

describe('안전하게 넣을 수 있는가', () => {
  it('⭐ 마크업이 **상수만**이다 — 변수를 끼워 넣지 않는다', () => {
    // 이 문자열은 이스케이프 없이 화면에 들어갑니다. 템플릿 구멍이
    // 하나라도 생기면 그때부터 주입 통로입니다.
    const source = readFileSync(join(HERE, 'icons.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const paths = /const PATHS[\s\S]*?\n};/.exec(source);
    ok(paths !== null, 'PATHS 를 못 찾았습니다');
    ok(!(paths?.[0] ?? '').includes('${'), 'PATHS 안에 템플릿 구멍이 있습니다');
  });

  it('⭐ 색을 박아 넣지 않는다 — 탭 글자색을 따라간다', () => {
    for (const name of ICON_NAMES) {
      const svg = iconSvg(name);
      ok(!/#[0-9a-fA-F]{3,8}|rgb\(|fill="(?!none)/.test(svg), `${name} 에 색이 박혀 있습니다`);
    }
  });

  it('⭐ 낭독기가 그림을 읽지 않는다 — 옆에 글자 라벨이 있다', () => {
    for (const name of ICON_NAMES) {
      ok(iconSvg(name).includes('aria-hidden="true"'), name);
    }
  });

  it('이름마다 실제로 뭔가 그린다', () => {
    for (const name of ICON_NAMES) {
      ok(/<(path|rect|circle)\b/.test(iconSvg(name)), `${name} 이 비어 있습니다`);
    }
  });
});

describe('기여도 아이콘은 시그니처다', () => {
  it('⭐ 가운데 줄이 **끊겨 있다** — 구멍이 이 제품의 값어치다', () => {
    // 트랙 셋 중 하나에 구멍이 있는 것이 운행도표의 요점입니다
    // (docs/16). 이어 붙이면 그냥 막대 그래프가 됩니다.
    const svg = iconSvg('track');
    const middle = /<path d="M4 12h(\d+)M(\d+) 12h(\d+)"\/>/.exec(svg);
    ok(middle !== null, '가운데 줄이 두 도막이 아닙니다');
    const [, first, resume] = middle!.map(Number) as [number, number, number, number];
    ok(4 + first < resume, `구멍이 없습니다: 4+${first} ≥ ${resume}`);
  });
});
