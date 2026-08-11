/**
 * 제품 머리말의 **사람 꼬리표** (디자인 브리프 §5).
 *
 * 화면 넷이 전부 이 모양이었습니다:
 *
 *     칸반
 *     김민수 님이 보고 있습니다      ← 설명문과 같은 크기·같은 색
 *
 * 문장이라 설명을 두 번 읽게 만들었고, 화면 위 넉 줄이 전부 같은
 * 무게라 무엇을 먼저 볼지가 없었습니다. 지금은 아바타 딸린 12px
 * 꼬리표입니다.
 *
 * ## ⚠️ 왜 lib 에 있는가
 *
 * 검토·칸반·기여도·로비가 전부 같은 것을 그립니다. 화면마다 적으면
 * **네 벌**이 되고, 이 저장소의 대표 실패 둘 중 하나가 정확히 그것입니다 —
 * 두 벌이 있으면 한쪽만 고쳐집니다.
 */

import { escapeHtml } from '../html.ts';

/**
 * 이름에서 아바타에 넣을 **한 글자**.
 *
 * ⚠️ `name[0]` 을 쓰면 안 됩니다. JavaScript 의 문자열 인덱스는
 * UTF-16 코드 단위라, 이모지나 일부 한자처럼 두 칸을 쓰는 글자에서
 * **반쪽만** 떼어 옵니다 — 화면에는 깨진 네모가 뜹니다. 프로젝트
 * 레일에서 한 번 당한 자리라 같은 방식(`Array.from`)으로 뗍니다.
 *
 * 빈 이름은 `?` 입니다. 빈 동그라미를 그리면 사람은 앱이 무언가
 * 잃어버렸다고 읽습니다.
 */
export function avatarInitial(name: string): string {
  return Array.from(name.trim())[0] ?? '?';
}

/**
 * 꼬리표 한 줄의 HTML.
 *
 * `role` 은 이 사람이 지금 이 화면에서 **무엇을 하는 중인가** 입니다 —
 * 검토 중 · 보고 있음. 비워 두면 이름만 나옵니다.
 *
 * ⚠️ 이름은 서버가 준 값이라 **반드시 이스케이프**합니다. 아바타 글자도
 * 마찬가지입니다 — 이름의 첫 글자가 `<` 일 수 있습니다.
 */
export function bylineHtml(name: string, role = ''): string {
  const initial = escapeHtml(avatarInitial(name));
  const who = escapeHtml(name.trim());
  const tail = role === '' ? '' : ` · ${escapeHtml(role)}`;
  return `<span class="avatar" aria-hidden="true">${initial}</span>${who}${tail}`;
}
