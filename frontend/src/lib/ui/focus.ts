/**
 * 일이 끝난 뒤 **초점을 되돌릴 것인가** (결함 349).
 *
 * ## ⛔ 누를 때마다 초점이 `body` 로 떨어졌습니다
 *
 * 레거시 칸반의 카드 컨트롤은 요청이 나가는 동안 `disabled` 가 됩니다.
 * 브라우저는 **초점을 쥔 요소가 `disabled` 가 되면 초점을 버립니다** —
 * `document.body` 로 떨어지고, 요청이 끝나 다시 `enabled` 가 돼도
 * 돌아오지 않습니다.
 *
 * 재현(1440×1000, 키보드만):
 *
 *     담당자 체크박스에서 Space   → 200 PATCH · 초점 BODY
 *     「검토 중으로」에서 Enter    → 200 PATCH · 초점 BODY
 *     우선순위 라디오에서 ↓       → 200 PATCH · 초점 BODY
 *
 * 즉 카드를 한 칸 옮길 때마다 **문서 맨 앞에서 다시 Tab** 해야 합니다.
 * 마우스 쓰는 사람에게는 아무 일도 안 일어나므로 눈으로는 안 보입니다.
 *
 * ⚠️ 결함 280·303 이 대화상자와 로비에서 적어 둔 그것입니다 —
 * 「자리를 바꿔 놓고 초점을 잃은 것」. 세 번째 자리입니다.
 *
 * ## ⚠️ **언제나** 되돌리면 안 됩니다
 *
 * 요청이 도는 동안 사람이 다른 곳을 눌렀을 수 있습니다. 그때 초점을
 * 도로 뺏으면 **사람이 하려던 일을 가로챕니다** — 고치려던 것보다 나쁩니다.
 * 그리고 그 사이에 그 자리가 **사라졌을** 수도 있습니다(카드를 지웠거나
 * 다른 열로 옮겨 다시 그려졌거나). 없는 자리에 초점을 주면 예외가 납니다.
 *
 * 그래서 되돌리는 것은 **셋이 다 참일 때만**입니다:
 *   ① 기억해 둔 자리가 있고
 *   ② 지금 초점이 아무도 안 쥐고 있고 (`body` 로 떨어졌고)
 *   ③ 그 자리가 아직 문서에 있다
 */

/** 되돌릴 자리. DOM 을 안 들여도 되게 필요한 것만 적습니다 — 검사가 쉽습니다. */
export interface FocusSpot {
  /** 아직 문서에 붙어 있는가 (`Node.isConnected`). */
  isConnected: boolean;
}

/** 일이 끝난 지금, 초점을 누가 쥐고 있는가. */
export type FocusLanding =
  /** 아무도 안 쥐었습니다 — `document.body` 이거나 `null`. 이때만 되돌립니다. */
  | 'nobody'
  /** 사람이 그 사이 다른 곳을 눌렀습니다. **건드리지 않습니다.** */
  | 'someone';

/**
 * 초점을 어디로 보낼 것인가.
 *
 * ⚠️ **`nearby` 가 왜 필요한가** — 카드를 다른 열로 옮기면 눌렀던 버튼은
 * 통째로 사라집니다(`nextStatuses` 가 달라져 다시 그려집니다). 그때
 * `remembered` 만 보면 되돌릴 데가 없어 초점이 `body` 에 남고, 키보드만
 * 쓰는 사람은 **문서 맨 앞**으로 튕깁니다 — 고치려던 바로 그 증상입니다.
 * 카드 자체는 살아 있으므로 그 카드 안으로 보냅니다.
 */
export type FocusPlan =
  /** 눌렀던 그 자리로. */
  | 'remembered'
  /** 그 자리는 사라졌지만 **카드는 살아 있습니다** — 카드 안으로. */
  | 'nearby'
  /** 아무 데도. 사람이 다른 곳을 눌렀거나, 카드마저 사라졌습니다. */
  | 'nowhere';

/**
 * 되돌릴지, 어디로 되돌릴지.
 *
 * ⚠️ 되돌릴지 **말지**가 판단이고, 실제로 `focus()` 를 부르는 것은 화면의
 * 일입니다. 그래야 이 규칙에 검사가 붙습니다.
 *
 * ⚠️ **셋을 다 고칩니다.** 담당자만 고치고 옮기기를 두면 「한 갈래만 고치고
 * 옆 갈래를 그대로 둔 것」(결함 298·301)이 됩니다 — 실제로 담당자·우선순위만
 * 고친 채로 한 번 재 봤고, 옮기기는 그대로 `body` 였습니다.
 */
export function focusPlan(
  remembered: FocusSpot | null | undefined,
  landing: FocusLanding,
  cardStillThere: boolean,
): FocusPlan {
  // 사람이 그 사이 다른 곳을 눌렀으면 **뺏지 않습니다.** 고치려던 것보다
  // 나쁩니다 — 사람이 하려던 일을 가로챕니다.
  if (landing !== 'nobody') return 'nowhere';
  if (remembered !== null && remembered !== undefined && remembered.isConnected) {
    return 'remembered';
  }
  return cardStillThere ? 'nearby' : 'nowhere';
}

/**
 * 지금 초점을 누가 쥐고 있는지 읽는다 — 화면이 `focusPlan` 에 넘길 값.
 *
 * ⚠️ `body` 와 `null` 을 **같이** 봅니다. 브라우저마다 초점을 버릴 때
 * 어느 쪽으로 떨어뜨리는지가 다릅니다.
 */
export function whoHasFocus(active: unknown, body: unknown): FocusLanding {
  return active === null || active === undefined || active === body ? 'nobody' : 'someone';
}
