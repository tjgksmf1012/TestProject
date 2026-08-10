/**
 * 서버가 준 오류 본문을 **사람이 읽을 한 줄**로.
 *
 * ## 왜 이게 따로 필요한가
 *
 * 화면 여섯 곳이 이렇게 적혀 있었습니다.
 *
 *     const body = (await response.json()) as { detail?: string };
 *     say(body.detail ?? `실패했습니다 (HTTP ${response.status})`);
 *
 * `as { detail?: string }` 는 **거짓말입니다.** FastAPI 는 두 가지 모양으로
 * `detail` 을 줍니다.
 *
 *     HTTPException  → "저장소가 연결되지 않았습니다"        ← 문자열
 *     검증 실패(422) → [{loc, msg, type, input}, ...]        ← **객체 배열**
 *
 * 두 번째가 오면 `textContent` 에 그대로 들어가서 화면에 이렇게 뜹니다.
 *
 *     [object Object]
 *
 * 타입 단언은 컴파일할 때만 있고 런타임에는 아무것도 확인하지 않으므로
 * `tsc` 도 조용합니다. 실제 브라우저에서 422 를 받아 보기 전에는 아무 데도
 * 티가 안 납니다 — 이 저장소가 반복해서 당한 부류 그대로입니다.
 *
 * ## 422 는 사용자 잘못이 아니다
 *
 * 422 는 **우리 화면이 잘못된 값을 보냈다**는 뜻입니다. 사용자가 고칠 수
 * 있는 것이 아니므로 pydantic 의 영어 메시지를 그대로 보여 주는 것은
 * 도움이 안 됩니다. 대신 그렇게 말하고, 원문은 콘솔에 남깁니다.
 */

/** FastAPI 검증 오류 한 줄. 필요한 것만 씁니다. */
interface ValidationItem {
  loc?: unknown;
  msg?: unknown;
}

function isValidationList(value: unknown): value is ValidationItem[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'object' && item !== null)
  );
}

/**
 * 검증 오류가 가리키는 칸 이름. 없으면 빈 문자열.
 *
 * `["body", "limit"]` 에서 `limit` 을 뽑습니다 — `body` 는 사람에게
 * 아무 뜻이 없습니다.
 */
function fieldOf(items: ValidationItem[]): string {
  for (const item of items) {
    if (!Array.isArray(item.loc)) continue;
    const named = item.loc.filter(
      (part): part is string => typeof part === 'string' && part !== 'body',
    );
    if (named.length > 0) return named[named.length - 1] as string;
  }
  return '';
}

/**
 * 오류 본문 → 화면에 그대로 넣을 한 줄.
 *
 * `fallback` 은 서버가 아무 말도 안 했을 때 쓸 문장입니다. 상태 코드를
 * 넣어 두면 나중에 무엇이었는지 알 수 있습니다.
 */
export function detailText(body: unknown, fallback: string): string {
  if (typeof body !== 'object' || body === null) return fallback;

  const detail = (body as { detail?: unknown }).detail;

  // 서버가 사람을 위해 쓴 문장. 그대로 씁니다.
  if (typeof detail === 'string' && detail.trim() !== '') return detail;

  if (isValidationList(detail)) {
    const field = fieldOf(detail);
    const where = field ? ` (${field})` : '';
    // ⚠️ pydantic 의 영어 원문을 넣지 않습니다. 사용자가 고칠 수 있는
    // 것이 아니고, 붙여 봐야 "무엇을 하라" 가 안 나옵니다.
    return `보낸 값이 올바르지 않습니다${where} — 화면 문제입니다. 새로고침해도 같으면 알려 주세요.`;
  }

  return fallback;
}
