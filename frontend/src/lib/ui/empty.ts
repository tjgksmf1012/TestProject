/**
 * 빈 화면 — **&#34;데이터가 없습니다&#34; 만 띄우는 것은 미완성입니다** (지시서 §7).
 *
 * ## 이 프로젝트에서 특히 중요한 이유
 *
 * 이 저장소가 반복해 당한 결함은 전부 같은 모양이었습니다 —
 * **없는 것을 빈 것으로 답한다.** 저장소 이름을 잘못 적어도, 웹훅이
 * 안 붙어도, 시드가 다른 키를 써도, 화면은 그냥 비었습니다. 사람은
 * 빈 화면을 &#34;아무도 아무것도 안 했구나&#34; 로 읽습니다.
 *
 * 그래서 빈 상태는 셋을 **반드시** 말합니다.
 *
 *     what    이 자리에 원래 무엇이 오는가
 *     why     지금 왜 비어 있는가          ← 여기가 빠지면 고장으로 읽힌다
 *     how     채우려면 무엇을 하는가
 *
 * `why` 를 선택 항목으로 두지 않은 것이 요점입니다. 타입이 강제하므로
 * 빠뜨릴 수 없습니다.
 *
 * ## ⚠️ &#34;아직 안 왔다&#34; 와 &#34;와 봤는데 없다&#34; 는 다릅니다
 *
 * 처리 중이라 후보가 없는 것과, 처리를 마쳤는데 뽑을 게 없었던 것은
 * 사람이 할 일이 다릅니다 — 앞은 기다리는 것이고 뒤는 기다려도 안
 * 바뀝니다. 둘을 같은 문구로 덮으면 사람은 영원히 새로고침합니다.
 * 부르는 쪽에서 갈라 주십시오.
 */

import { escapeHtml } from '../html.ts';

export interface EmptyState {
  /** 이 자리에 원래 무엇이 오는가. */
  what: string;
  /** 지금 왜 비어 있는가. **고장이 아니라는 것**을 여기서 말합니다. */
  why: string;
  /** 채우려면 무엇을 하는가. */
  how: string;
  /** 주 버튼 **하나**. 없으면 넣지 않습니다 — 갈 곳이 없는데 버튼을
   *  만들면 눌러 보고 제자리로 돌아옵니다. */
  action?: { label: string; href: string };
}

/**
 * 빈 상태 한 덩어리.
 *
 * ⚠️ 문구는 전부 이스케이프합니다 — `why` 에 회의 제목이나 서버 문구가
 * 섞여 들어오는 경로가 있습니다.
 */
export function emptyHtml(state: EmptyState): string {
  const action = state.action
    ? `<a class="btn btn-primary" href="${escapeHtml(state.action.href)}">` +
      `${escapeHtml(state.action.label)}</a>`
    : '';
  return (
    '<div class="empty-state">' +
    `<p class="what">${escapeHtml(state.what)}</p>` +
    `<p class="why">${escapeHtml(state.why)}</p>` +
    `<p class="how">${escapeHtml(state.how)}</p>` +
    action +
    '</div>'
  );
}
