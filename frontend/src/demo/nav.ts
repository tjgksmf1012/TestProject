/**
 * 아래 탭바와 (있으면) 위쪽 링크 줄을 그린다.
 *
 * 판단은 전부 `src/lib/nav/links.ts` 에 있고 27개 테스트가 붙습니다.
 * 여기는 DOM 에 붙이는 배선입니다 — 화면마다 복사하지 않으려고 뺐습니다.
 *
 * ## 왜 아래인가
 *
 * 폰을 한 손으로 쥐면 화면 위쪽 3분의 1은 엄지가 안 닿습니다. 그리고
 * 전체화면 PWA·WebView 로 띄우면 **주소창도 뒤로가기도 없습니다** —
 * 위쪽 링크 줄에 의존하던 이동이 그때는 정말 갇히는 길이 됩니다.
 */

import {
  contextFromSearch,
  missingLinks,
  navLinks,
  navTabs,
  type ScreenId,
} from '../lib/nav/links.ts';
import { iconSvg } from '../lib/nav/icons.ts';
import { escapeHtml } from '../lib/html.ts';

/**
 * `<nav id="tabs">` 와 `<nav id="nav">` 이 있으면 채운다.
 *
 * 로그인 화면처럼 둘 다 없는 화면에서는 아무 일도 하지 않습니다.
 */
export function renderNav(current: ScreenId): void {
  const context = contextFromSearch(current, location.search);

  const tabHost = document.getElementById('tabs');
  if (tabHost) {
    tabHost.innerHTML = navTabs(context)
      .map((tab) => {
        // 못 가는 탭은 `<a href>` 를 주지 않는다. 주면 눌렸을 때
        // `?project=null` 로 가고, 서버는 404 를 주고, 사람은 화면이
        // 고장 났다고 읽는다.
        const href = tab.enabled ? ` href="${escapeHtml(tab.href)}"` : '';
        const disabled = tab.enabled ? '' : ' aria-disabled="true"';
        const marked = tab.current ? ' aria-current="page"' : '';
        const title = tab.blockedReason
          ? ` title="${escapeHtml(tab.blockedReason)}"`
          : '';
        return (
          `<a${href}${disabled}${marked}${title}>` +
          // ⚠️ `iconSvg` 는 **이스케이프하지 않습니다.** `icons.ts` 의
          // 상수 마크업이라 안전하고, 이스케이프하면 태그가 글자로
          // 나옵니다. 그 파일이 상수만 담는지는 테스트가 고정합니다.
          `<span class="ico">${iconSvg(tab.icon)}</span>` +
          `<span>${escapeHtml(tab.label)}</span>` +
          `</a>`
        );
      })
      .join('');
  }

  const host = document.getElementById('nav');
  if (!host) return;

  const links = navLinks(context)
    .map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`)
    .join('');
  const notes = missingLinks(context)
    .map((note) => `<span class="miss">${escapeHtml(note)}</span>`)
    .join('');

  host.innerHTML = links + notes;
}
