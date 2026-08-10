/**
 * 스켈레톤이 **없는 것을 있는 것처럼 말하지 않는가.**
 *
 * 눈으로는 회색 막대지만, 화면 낭독기에게는 그냥 요소입니다. 그대로
 * 두면 아직 오지도 않은 카드 셋을 사람이 듣게 됩니다. 이 파일의 절반이
 * 그 한 가지를 봅니다.
 */

import { strictEqual, ok } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  board,
  clearSkeleton,
  projectCards,
  rowItems,
  rows,
  scoreCards,
  showSkeleton,
} from './skeleton.ts';

/** 태그를 걷어 내고 남는 글자. 스켈레톤은 여기가 비어 있어야 합니다. */
const textOf = (html: string): string => html.replace(/<[^>]*>/g, '').trim();

/** `document` 없이 `showSkeleton` 을 시험하기 위한 최소 그릇. */
const fakeElement = (): HTMLElement => {
  const attrs = new Map<string, string>();
  return {
    innerHTML: '',
    setAttribute(name: string, value: string) {
      attrs.set(name, value);
    },
    removeAttribute(name: string) {
      attrs.delete(name);
    },
    getAttribute(name: string) {
      return attrs.get(name) ?? null;
    },
  } as unknown as HTMLElement;
};

const WRAPPED: [string, string][] = [
  ['projectCards', projectCards()],
  ['scoreCards', scoreCards()],
  ['board', board()],
  ['rows', rows()],
];
const ALL: [string, string][] = [...WRAPPED, ['rowItems', rowItems()]];

describe('낭독기에게 거짓말하지 않는다', () => {
  it('⭐ 스켈레톤 안에 글자가 한 자도 없다', () => {
    for (const [name, html] of ALL) {
      strictEqual(textOf(html), '', `${name} 에 글자가 있습니다`);
    }
  });

  it('⭐ 통째로 aria-hidden 이다', () => {
    for (const [name, html] of WRAPPED) {
      ok(html.startsWith('<div class="sk-wrap'), `${name} 의 겉이 sk-wrap 이 아닙니다`);
      ok(html.includes('aria-hidden="true"'), `${name} 에 aria-hidden 이 없습니다`);
    }
  });

  it('⭐ 겉껍질 없는 판(`rowItems`)은 **항목마다** aria-hidden 을 단다', () => {
    // `<ul>` 안에는 `<div>` 겉껍질을 넣을 수 없어 껍질이 없습니다.
    // 그러면 aria-hidden 을 걸 자리도 없어지므로 항목마다 답니다.
    const items = rowItems(3);
    strictEqual([...items.matchAll(/aria-hidden="true"/g)].length, 3);
    ok(!items.includes('<div'), '`<ul>` 안에 `<div>` 를 넣으면 항목 수가 틀어집니다');
  });

  it('⭐ 그릇에 aria-busy 를 걸고, 지울 때 **같이 뗀다**', () => {
    // 켜기만 하고 안 끄면 낭독기는 내용이 도착한 뒤에도 계속 "바쁨"
    // 이라고 말합니다.
    const el = fakeElement();
    showSkeleton(el, rows());
    strictEqual(el.getAttribute('aria-busy'), 'true');
    ok(el.innerHTML.length > 0);

    clearSkeleton(el);
    strictEqual(el.getAttribute('aria-busy'), null);
    strictEqual(el.innerHTML, '');
  });

  it('⭐ 이미 진짜 내용이 들어와 있으면 지우지 않는다', () => {
    // 화면이 순서를 어겨 스켈레톤이 떠 있는 동안 오류 문구를 써 넣는
    // 일이 있습니다. 그걸 지우면 실패한 화면이 **아무 말도 없이 빈
    // 채로** 남습니다 — 이 저장소가 반복해 당한 모양 그대로입니다.
    const el = fakeElement();
    showSkeleton(el, rows());
    el.innerHTML = '<p>불러오지 못했습니다 (HTTP 500)</p>';

    clearSkeleton(el);

    strictEqual(el.innerHTML, '<p>불러오지 못했습니다 (HTTP 500)</p>');
    strictEqual(el.getAttribute('aria-busy'), null, 'aria-busy 는 그래도 떼야 합니다');
  });
});

describe('모양이 실제 화면에서 왔다', () => {
  it('⭐ 진짜 레이아웃 클래스를 그대로 쓴다', () => {
    // 스켈레톤용 클래스를 따로 만들면, 공용 CSS 가 바뀔 때 스켈레톤만
    // 옛 모양으로 남습니다. 그러면 내용이 도착하는 순간 화면이 튑니다.
    ok(projectCards().includes('class="card"'), '홈은 카드 모양이어야 합니다');
    // ⚠️ 기여도는 **카드가 아니라 판독 줄**입니다 (docs/19 §16). 여기가
    // `card` 로 남아 있으면 카드가 잠깐 떴다가 줄로 튑니다 — 이 검사가
    // 막으려던 그 모양입니다.
    ok(scoreCards().includes('class="read"'), '기여도는 판독 줄 모양이어야 합니다');
    ok(!scoreCards().includes('class="card"'), '기여도 스켈레톤에 옛 카드가 남아 있습니다');
    ok(board().includes('class="col"'), '칸반은 열 모양이어야 합니다');
  });

  it('⭐ 격자 클래스를 **다시 선언하지 않는다**', () => {
    // `#board` 는 이미 `class="board"` 입니다. 스켈레톤이 그 클래스를 또
    // 달면 격자 안에 격자가 생겨 카드 셋이 한 칸에 우겨넣어집니다.
    // (`#members` 는 이제 격자가 아닙니다 — 판독 줄이 세로로 쌓입니다.
    //  그래도 `score-grid` 를 되살리지 못하게 계속 봅니다.)
    // 겉껍질은 `display: contents` 로 레이아웃에서 사라집니다.
    for (const [name, html] of WRAPPED) {
      ok(!html.includes('score-grid'), `${name} 이 격자를 다시 선언합니다`);
      ok(!/class="[^"]*\bboard\b/.test(html), `${name} 이 격자를 다시 선언합니다`);
    }
  });

  it('기여도 스켈레톤은 **구간 막대 자리**를 비워 둔다', () => {
    // 이 화면의 주인공입니다. 나중에 나타나면서 아래를 밀어내면
    // 읽던 자리를 잃습니다.
    ok(scoreCards().includes('sk-track'));
  });

  it('⭐ 칸반 열 개수를 못 박지 않는다', () => {
    // 상태 목록은 서버가 정합니다. 셋으로 고정하면 상태가 넷인 팀에서
    // 내용이 도착할 때 화면이 한 번 튑니다.
    const four = board(4);
    strictEqual([...four.matchAll(/class="col"/g)].length, 4);
    strictEqual([...board(3).matchAll(/class="col"/g)].length, 3);
  });

  it('개수를 넘기면 그만큼 나온다', () => {
    strictEqual([...projectCards(5).matchAll(/class="card"/g)].length, 5);
    strictEqual([...scoreCards(2).matchAll(/class="read"/g)].length, 2);
    strictEqual([...rows(7).matchAll(/class="sk-line"/g)].length, 7);
    strictEqual([...rowItems(4).matchAll(/<li /g)].length, 4);
  });

  it('0 이나 음수를 넘겨도 최소 하나는 그린다', () => {
    // 빈 스켈레톤은 "다 불러왔는데 아무것도 없다" 로 읽힙니다.
    strictEqual([...projectCards(0).matchAll(/class="card"/g)].length, 1);
    strictEqual([...board(-1).matchAll(/class="col"/g)].length, 1);
    strictEqual([...scoreCards(0).matchAll(/class="read"/g)].length, 1);
    strictEqual([...rows(0).matchAll(/class="sk-line"/g)].length, 1);
    strictEqual([...rowItems(0).matchAll(/<li /g)].length, 1);
  });
});

describe('막대', () => {
  it('폭이 백분율로만 들어간다', () => {
    for (const [name, html] of ALL) {
      for (const [, value] of html.matchAll(/style="width:([^"]+)"/g)) {
        ok(/^\d+%$/.test(value as string), `${name} 의 폭 ${value} 이 백분율이 아닙니다`);
      }
    }
  });

  it('줄마다 폭이 달라 진짜 글줄처럼 보인다', () => {
    // 전부 같은 폭이면 표처럼 보이고, 표는 이 화면들에 없습니다.
    const widths = [...rows(5).matchAll(/width:(\d+)%/g)].map((m) => m[1]);
    ok(new Set(widths).size > 1, '줄 폭이 전부 같습니다');
  });
});
