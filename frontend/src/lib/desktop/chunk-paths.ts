/**
 * 데스크톱 셸이 **청크를 디스크 어디에 두는가** — 판단만.
 *
 * `docs/21` Phase 1. main 프로세스는 여기서 정한 이름을 받아 쓰기만 합니다.
 *
 * ## ⚠️ 여기 오는 값은 **원격 코드가 준 것**입니다
 *
 * 이 창은 서버가 준 화면을 띄웁니다. 즉 renderer 에서 넘어오는 문자열은
 * **서버가 뚫리면 공격자가 정하는 값**입니다. 경로를 만드는 자리에서 그
 * 문자열을 그대로 이으면 그 순간 임의 파일 쓰기가 됩니다.
 *
 * 그래서 두 가지를 지킵니다.
 *
 *   1. **renderer 는 경로를 못 줍니다.** 회의 id 하나만 주고, 폴더도
 *      파일명도 여기서 만듭니다.
 *   2. **막을 것을 세지 않고, 허용할 것만 셉니다.** `..` 를 걸러내는
 *      식으로 짜면 `%2e%2e`·`....//`·유니코드 정규화로 계속 뚫립니다.
 *      `[A-Za-z0-9_-]` 만 통과시키면 그 목록이 필요 없습니다.
 */

/**
 * 회의 id 로 인정하는 모양.
 *
 * ⚠️ **`\w` 를 쓰지 않았습니다.** 자바스크립트의 `\w` 는 `[A-Za-z0-9_]`
 * 라 한글이 안 걸리는데, 이 저장소는 그 반대 방향으로 한 번 당했습니다
 * (한글 이름이 `\w` 에 안 걸려 위반을 심고도 0건이 나온 것). 여기서는
 * **글자 집합을 직접 적어** 무엇이 통과하는지 읽는 사람이 바로 보게 합니다.
 *
 * 길이 상한 64 는 파일시스템 한계(255)가 아니라 **회의 id 가 그보다 길
 * 이유가 없기 때문**입니다. 상한이 없으면 이름 하나로 경로 길이 제한을
 * 넘겨 쓰기를 실패시킬 수 있습니다.
 */
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** 이 회의 id 를 폴더 이름으로 써도 되는가. */
export function isSafeSessionId(id: string): boolean {
  return SESSION_ID.test(id);
}

/**
 * 회의 하나가 쓰는 폴더 이름.
 *
 * @throws 통과 못 하는 id 면. **조용히 고쳐서 쓰지 않습니다** — 이상한
 * 값이 왔다는 것 자체가 알아야 할 사실이고, 슬러그로 바꿔 주면 서로 다른
 * 두 회의가 같은 폴더를 쓰게 될 수 있습니다.
 */
export function sessionDirName(sessionId: string): string {
  if (!isSafeSessionId(sessionId)) {
    throw new Error(`회의 id로 쓸 수 없는 값입니다: ${JSON.stringify(sessionId)}`);
  }
  return sessionId;
}

/**
 * 청크 파일 확장자.
 *
 * ⚠️ **`.webm` 이 아닙니다.** 청크 하나는 스트림 중간 조각이라 그것만으로는
 * 재생되지 않습니다. `.webm` 으로 두면 사람이 더블클릭해 보고 "녹음이
 * 깨졌다" 는 **틀린 결론**을 냅니다. 붙였다 떼는 임시 조각이라는 것이
 * 이름에서 보이게 둡니다.
 */
export const CHUNK_EXT = '.chunk';

/**
 * 청크 하나의 파일 이름.
 *
 * ## ⚠️ 이름이 `seq` 와 `atMs` 를 **둘 다** 들고 있습니다
 *
 * 따로 목록 파일을 두면 그 파일과 실제 파일이 갈라집니다 — 이 저장소의
 * 대표 실패 ② 이고, 하필 **크래시 직후**에 갈라집니다(청크는 써졌는데
 * 목록에 못 적고 죽는 경우). 이름 하나에 담으면 갈라질 두 벌이 없습니다.
 *
 * `atMs` 는 정수로 반올림합니다. 공백 판정 임계가 100ms 이고
 * (`timeline.ts` `MIN_REPORTED_GAP_MS`) 1ms 는 그보다 100배 작아,
 * 반올림이 공백 계산을 바꾸지 못합니다.
 */
export function chunkFileName(seq: number, atMs: number): string {
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error(`seq는 0 이상 정수여야 합니다: ${seq}`);
  }
  if (!Number.isFinite(atMs)) {
    throw new Error(`atMs가 수가 아닙니다: ${atMs}`);
  }
  return `c${seq}@${Math.round(atMs)}${CHUNK_EXT}`;
}

export interface ParsedChunkName {
  seq: number;
  atMs: number;
}

/**
 * 파일 이름에서 `seq` 와 `atMs` 를 되읽는다. 우리 것이 아니면 `null`.
 *
 * ⚠️ **자리수를 맞춰 놓고 글자순으로 정렬하지 않습니다.** 0 을 채워 두면
 * 자리수를 넘기는 순간(`c999999` → `c1000000`) 글자순과 숫자순이
 * 갈라지고, 그때부터 청크 순서가 조용히 뒤집힙니다. 숫자로 되읽어
 * 숫자로 정렬하면 그 함정이 아예 없습니다.
 */
export function parseChunkName(name: string): ParsedChunkName | null {
  const m = /^c(\d+)@(-?\d+)\.chunk$/.exec(name);
  if (!m) return null;
  const seq = Number(m[1]);
  const atMs = Number(m[2]);
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(atMs)) return null;
  return { seq, atMs };
}

/**
 * 폴더에 있는 이름들을 **seq 순서**로 정리한다.
 *
 * 우리 것이 아닌 이름은 조용히 뺍니다 — 사용자 폴더에는 `.DS_Store`
 * 같은 것이 늘 섞입니다. 다만 **세어서 돌려줍니다**: 뺀 것이 있는데 0개
 * 라고 말하면 그것도 거짓말입니다.
 */
export function listChunks(names: readonly string[]): {
  chunks: ParsedChunkName[];
  skipped: number;
} {
  const chunks: ParsedChunkName[] = [];
  let skipped = 0;
  for (const name of names) {
    const parsed = parseChunkName(name);
    if (parsed === null) skipped += 1;
    else chunks.push(parsed);
  }
  chunks.sort((a, b) => a.seq - b.seq);
  return { chunks, skipped };
}
