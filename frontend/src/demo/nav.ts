/**
 * 화면 위쪽 이동 줄을 그린다.
 *
 * 판단은 전부 `src/lib/nav/links.ts` 에 있고 17개 테스트가 붙습니다.
 * 여기는 DOM 에 붙이는 배선입니다 — 화면마다 복사하지 않으려고 뺐습니다.
 */

import {
  contextFromSearch,
  missingLinks,
  navLinks,
  type ScreenId,
} from '../lib/nav/links.ts';
import { escapeHtml } from '../lib/html.ts';

/** `<nav id="nav">` 이 있으면 채운다. 없으면 아무 일도 하지 않는다. */
export function renderNav(current: ScreenId): void {
  const host = document.getElementById('nav');
  if (!host) return;

  const context = contextFromSearch(current, location.search);
  const links = navLinks(context)
    .map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`)
    .join('');
  const notes = missingLinks(context)
    .map((note) => `<span class="miss">${escapeHtml(note)}</span>`)
    .join('');

  host.innerHTML = links + notes;
}
