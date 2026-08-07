/**
 * 로딩 스켈레톤 — **그 화면의 모양**으로 기다린다.
 *
 * ## 왜 스피너가 아닌가
 *
 * 스피너는 "뭔가 돌고 있다" 말고는 아무 말도 안 합니다. 스켈레톤은
 * 곧 무엇이 올지 말합니다 — 카드 셋이 올지, 열 셋짜리 보드가 올지.
 * 그래서 내용이 도착했을 때 **화면이 튀지 않습니다.** 자리가 이미
 * 잡혀 있기 때문입니다 (지시서 §7: 스피너 단독 금지).
 *
 * ## ⚠️ 여기가 거짓말이 생길 수 있는 지점이다
 *
 * 스켈레톤은 **아직 없는 것을 그리는 그림**입니다. 화면 낭독기가
 * 이걸 읽으면 사람은 있지도 않은 카드 셋을 들게 됩니다. 그래서
 *
 *   · 스켈레톤 안에 **글자를 한 자도 넣지 않습니다**
 *   · 통째로 `aria-hidden="true"` 입니다
 *   · 담는 그릇에 `aria-busy="true"` 를 걸어 **기다리는 중**임을 말합니다
 *
 * 이 셋을 테스트가 고정합니다.
 *
 * ## 모양은 실제 화면에서 따왔습니다
 *
 *     projectCards   home.html      `.card` — 제목·설명·버튼 줄
 *     scoreCards     contributions  `.card` — 이름·구간막대
 *     board          kanban.html    `.col` — 열 셋
 *     rows           review         목록 한 줄씩
 *     rowItems       lobby          같은 목록이되 `<li>` — 그릇이 `<ul>`
 *
 * 실제 클래스(`card`·`col`)를 그대로 씁니다. 따로 잡으면 공용 CSS 가
 * 바뀔 때 스켈레톤만 옛 모양으로 남습니다.
 *
 * ## ⚠️ 격자를 다시 선언하지 않습니다
 *
 * `#board` 는 이미 `class="board"` 이고 `#members` 는 이미
 * `class="score-grid"` 입니다. 스켈레톤이 그 클래스를 **또** 달면
 * 격자 안에 격자가 생겨, 카드 셋이 한 칸에 우겨넣어집니다.
 *
 * 그래서 겉껍질 `.sk-wrap` 은 `display: contents` 입니다 — 레이아웃에서
 * 사라지고, 안의 카드들이 **그릇의 격자에 직접** 놓입니다.
 */

/** 회색 막대 한 칸. `width` 는 백분율. */
const bar = (width: number, kind = ''): string =>
  `<span class="sk${kind ? ` sk-${kind}` : ''}" style="width:${width}%"></span>`;

/** 스켈레톤 한 덩어리를 감싼다. **글자 없음 · 낭독 제외.** */
const wrap = (inner: string): string => `<div class="sk-wrap" aria-hidden="true">${inner}</div>`;

/**
 * 홈의 프로젝트 카드.
 *
 * 실제 카드는 제목(h2) · 설명 한 줄(.sub) · 버튼 셋(.links) 입니다.
 */
export function projectCards(count = 2): string {
  const one =
    '<section class="card">' +
    bar(52, 'title') +
    bar(78, 'line') +
    `<div class="sk-row">${bar(22, 'btn')}${bar(22, 'btn')}${bar(22, 'btn')}</div>` +
    '</section>';
  return wrap(one.repeat(Math.max(1, count)));
}

/**
 * 기여도의 사람별 카드.
 *
 * 실제 카드는 이름 · 구간 문구 · **구간 막대** · 신뢰도 입니다.
 * 막대 자리를 비워 두는 것이 중요합니다 — 이 화면의 주인공이라,
 * 나중에 나타나면서 아래를 밀어내면 읽던 자리를 잃습니다.
 */
export function scoreCards(count = 3): string {
  const one =
    '<article class="card">' +
    bar(40, 'title') +
    bar(64, 'line') +
    bar(100, 'track') +
    bar(34, 'line') +
    '</article>';
  return wrap(one.repeat(Math.max(1, count)));
}

/**
 * 칸반 보드.
 *
 * 열 개수를 넘겨받습니다 — 상태 목록은 서버가 정하므로 여기서 셋으로
 * 못 박으면 상태가 넷인 팀에서 화면이 한 번 튑니다.
 */
export function board(columns = 3, cardsPerColumn = 2): string {
  const card = `<div class="card">${bar(72, 'line')}${bar(44, 'line')}</div>`;
  const column =
    `<section class="col">${bar(30, 'title')}${card.repeat(Math.max(1, cardsPerColumn))}</section>`;
  return wrap(column.repeat(Math.max(1, columns)));
}

/** 줄마다 폭이 다릅니다 — 전부 같으면 표처럼 보이고, 표는 여기 없습니다. */
const ROW_WIDTHS = [86, 64, 74, 58, 80];

/** 목록 한 줄씩 — 승인 대기 후보(`<div>` 그릇). */
export function rows(count = 3): string {
  const list = Array.from({ length: Math.max(1, count) }, (_, i) =>
    `<div class="sk-line">${bar(ROW_WIDTHS[i % ROW_WIDTHS.length] ?? 70, 'line')}</div>`,
  ).join('');
  return wrap(list);
}

/**
 * 같은 목록이되 `<li>` — 그릇이 `<ul>` 인 화면용 (로비 참가자).
 *
 * ⚠️ `<ul>` 안에 `<div>` 를 넣으면 마크업이 깨집니다. 눈에는 안 보이지만
 * 화면 낭독기는 목록의 항목 수를 그걸로 셉니다.
 *
 * 겉껍질이 없으므로 `aria-hidden` 을 **항목마다** 답니다.
 */
export function rowItems(count = 3): string {
  return Array.from({ length: Math.max(1, count) }, (_, i) =>
    `<li class="sk-line" aria-hidden="true">` +
    `${bar(ROW_WIDTHS[i % ROW_WIDTHS.length] ?? 70, 'line')}</li>`,
  ).join('');
}

/**
 * 그릇에 스켈레톤을 넣고 **기다리는 중**이라고 표시한다.
 *
 * ⚠️ `aria-busy` 를 짝지어 지우는 것이 `clearBusy` 입니다. 켜기만 하고
 * 안 끄면 낭독기는 내용이 도착한 뒤에도 계속 "바쁨" 이라고 말합니다.
 */
export function showSkeleton(element: HTMLElement, html: string): void {
  element.setAttribute('aria-busy', 'true');
  element.innerHTML = html;
}

/**
 * 스켈레톤을 걷어 낸다. 내용은 그리는 쪽이 채웁니다.
 *
 * ⚠️ **이미 진짜 내용이 들어와 있으면 손대지 않습니다.**
 *
 * 부르는 순서는 이렇습니다 — 받아 오기 → 스켈레톤 걷기 → 그리기.
 * 그런데 화면 하나가 순서를 어겨 스켈레톤이 떠 있는 동안 오류 문구를
 * 써 넣으면, 여기서 그걸 지웁니다. 그러면 실패한 화면이 **아무 말도
 * 없이 빈 채로** 남습니다 — 이 저장소가 반복해 당한 바로 그 모양입니다.
 * 그래서 우리가 넣은 것일 때만 지웁니다.
 */
export function clearSkeleton(element: HTMLElement): void {
  element.removeAttribute('aria-busy');
  // 스켈레톤 조각은 전부 `sk` 로 시작하는 클래스를 답니다 —
  // `sk-wrap`(겉껍질)·`sk-line`(줄)·`sk`(막대).
  if (element.innerHTML.includes('class="sk')) element.innerHTML = '';
}
