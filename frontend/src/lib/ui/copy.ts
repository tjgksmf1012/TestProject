/**
 * 클립보드에 넣기 — 그리고 **안 됐을 때 그렇다고 말하기**.
 *
 * ## 왜 이게 로직인가
 *
 * 초대 코드 복사 버튼은 팀원을 프로젝트에 들이는 **유일한 통로**입니다.
 * 그런데 두 화면 모두 이렇게 쓰고 있었습니다.
 *
 *     void navigator.clipboard.writeText(text).then(() => {
 *       $('copy').textContent = '복사됨';
 *     });
 *
 * `navigator.clipboard` 는 **보안 컨텍스트에서만 있습니다.** 폰에서
 * `http://192.168.0.5:8000` 으로 열면 `undefined` 이고, 위 줄은 클릭
 * 핸들러 안에서 `TypeError` 로 죽습니다. 화면은 **아무 말도 안 합니다.**
 * 권한을 거절당하거나 문서가 포커스를 잃었을 때도 마찬가지입니다 —
 * 프로미스만 조용히 거절되고 `.catch` 가 없습니다.
 *
 * 사람이 겪는 일은 이렇습니다. 버튼을 누른다 → 아무 변화가 없다 →
 * 한 번 더 누른다 → 그래도 없다 → **카톡에 붙여 넣는다.** 클립보드에는
 * 아까 복사해 둔 다른 것이 그대로 있으므로, 팀원은 엉뚱한 글을 받습니다.
 * 결함 71 이 &#34;성공했다고 말하면서 틀린 것을 준다&#34; 였다면 이건
 * **아무 말도 안 하면서 틀린 것을 남겨 두는** 쪽입니다. 끝은 같습니다.
 *
 * ⚠️ **이 저장소는 이미 보안 컨텍스트를 압니다.** 녹음 클라이언트는
 * `isSecureContext()` 를 보고 왜 녹음을 못 하는지 화면에 말합니다
 * (`recording/session.ts`). 복사 쪽만 그 판단이 없었습니다.
 *
 * ## 왜 그냥 "복사 실패" 가 아닌가
 *
 * 실패를 말하는 것만으로는 사람이 할 일이 없습니다. 여기서는 할 일이
 * 분명합니다 — **코드를 길게 눌러 직접 복사하면 됩니다.** 그래서 이유와
 * 함께 그 방법을 말합니다. 주소가 `http` 라서 막힌 경우에는 그 사실도
 * 알려 줍니다. 고칠 수 있는 사람에게는 그게 진짜 원인이기 때문입니다.
 */

import { withJosa } from '../text/josa.ts';

/** 복사를 시도한 결과. */
export type CopyOutcome =
  /** 클립보드에 들어갔다. */
  | 'copied'
  /** 클립보드 자체가 없다 — 보안 컨텍스트가 아니다(`http://…`). */
  | 'unavailable'
  /** 있는데 거절당했다 — 권한 · 포커스 없음 등. */
  | 'refused';

/** `navigator.clipboard` 에서 우리가 쓰는 부분만. 테스트에서 갈아 낍니다. */
export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

/**
 * 넣어 보고 **무슨 일이 있었는지** 돌려준다.
 *
 * ⚠️ 절대 던지지 않습니다. 던지면 부르는 쪽이 `try` 를 잊는 순간 다시
 * 조용해집니다 — 그게 이 모듈이 생긴 이유입니다.
 */
export async function copyText(
  text: string,
  clipboard: ClipboardLike | undefined | null,
): Promise<CopyOutcome> {
  if (clipboard === undefined || clipboard === null) return 'unavailable';
  if (typeof clipboard.writeText !== 'function') return 'unavailable';
  try {
    await clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'refused';
  }
}

/**
 * 사람에게 할 말.
 *
 * `what` 은 무엇을 복사하려던 것인지입니다 — &#34;코드&#34;·&#34;한 줄&#34;.
 * 안내에 그대로 들어가므로 **화면에서 눌러야 할 것의 이름**을 줍니다.
 *
 * ⚠️ 조사는 `withJosa` 가 고릅니다. `코드` 는 받침이 없어 `를`, `한 줄` 은
 * `ㄹ` 받침이라 `을` 입니다 — 하나로 박아 두면 둘 중 하나가 틀립니다
 * (결함 76).
 */
export function describeCopy(outcome: CopyOutcome, what: string): string {
  if (outcome === 'copied') return '복사됨';
  const how = `${withJosa(what, '을를')} 길게 눌러 직접 복사하세요`;
  if (outcome === 'unavailable') {
    return `이 주소에서는 브라우저가 복사를 막습니다 — ${how}`;
  }
  return `복사하지 못했습니다 — ${how}`;
}

/** 복사가 됐는가. 화면이 문구를 얼마나 오래 둘지 정하는 데 씁니다. */
export function copySucceeded(outcome: CopyOutcome): boolean {
  return outcome === 'copied';
}
