/**
 * 목록 안에서 사람을 **가리키는 이름**.
 *
 * ## 왜 이게 로직인가 (결함 345)
 *
 * 이 제품은 사람을 **이름으로** 부릅니다. 활동 기록의 식별자를 이름으로
 * 바꾼 것이 결함 293·297 이고, 그 결정은 옳습니다 — `사용자 #3` 은
 * 사람에게 아무 뜻이 없습니다.
 *
 * 그런데 이름은 **유일하지 않습니다.** 팀에 같은 이름이 둘이면:
 *
 *     이하늘                          [팀원 ▾]  [내보내기]
 *     이하늘                          [팀원 ▾]  [내보내기]
 *
 * 되돌릴 수 없는 단추 둘이 글자까지 같습니다. 기여도 확정 칸도
 * `aria-label` 까지 「이하늘 확정값」으로 같았습니다 — **팀이 합의해
 * 확정한다**(불변식 ④)는 그 입력이 사람을 못 가린 것입니다.
 *
 * ## 손잡이는 이미 있습니다
 *
 * 이 저장소는 **같은 부류의 충돌을 이미 위험하다고 적어 두고 막고**
 * 있습니다 — 설정 화면의 GitHub 계정 칸이 그렇습니다:
 *
 *     한 프로젝트에서 같은 아이디를 둘이 쓸 수 없습니다 —
 *     남의 아이디를 적으면 그 사람의 PR이 내 기여가 되기 때문입니다.
 *
 * 즉 `github_login` 은 **프로젝트 안에서 유일**하고, 사람이 알아보는
 * 글자이며, 팀원 목록에 **이미 실려 옵니다**(`/api/projects/{id}/members`).
 * 화면이 이미 쥐고 있는 것으로 정할 수 있습니다 (결함 294).
 *
 * ## 겹칠 때만 붙입니다
 *
 * 언제나 붙이면 화면이 소음이 됩니다 — 이 저장소가 줄이려고 애쓴
 * 「글자가 너무 많다」입니다. 이름이 그 목록에서 유일하면 이름만 씁니다.
 */

export interface PersonRef {
  user_id: number;
  name?: string | null;
  /** 프로젝트 안에서 **유일**합니다 (서버가 막습니다). 안 이었으면 `null`. */
  github_login?: string | null;
}

/** 이름이 없을 때. 여기서만 번호로 떨어집니다 — 결함 297 의 마지막 수단입니다. */
function fallback(person: PersonRef): string {
  return `사용자 #${person.user_id}`;
}

function nameOf(person: PersonRef): string {
  const name = (person.name ?? '').trim();
  return name === '' ? fallback(person) : name;
}

/**
 * 이 목록 안에서 이 사람의 이름이 **겹치는가**.
 *
 * ⚠️ 자기 자신은 빼고 셉니다 — 같은 `user_id` 가 두 번 들어온 목록에서도
 * 「겹친다」고 하면 안 됩니다.
 */
export function nameRepeatsInList(person: PersonRef, all: readonly PersonRef[]): boolean {
  const mine = nameOf(person);
  return all.some((other) => other.user_id !== person.user_id && nameOf(other) === mine);
}

/**
 * 목록에서 이 사람을 부를 글자.
 *
 * 겹치지 않으면 이름만. 겹치면 **유일한 손잡이**를 붙입니다 — GitHub
 * 아이디가 있으면 그것을, 없으면 「GitHub 미연결」을 붙여 **둘 다 이름이
 * 붙게** 합니다. 한쪽에만 붙이면 나머지 한 줄이 「이름표가 없는 쪽」이
 * 되어, 사람이 소거법으로 읽어야 합니다.
 */
export function labelInList(person: PersonRef, all: readonly PersonRef[]): string {
  const name = nameOf(person);
  if (!nameRepeatsInList(person, all)) return name;

  const login = (person.github_login ?? '').trim();
  return login === '' ? `${name} · GitHub 미연결` : `${name} · @${login}`;
}

/**
 * 이름이 겹치는데 **붙일 손잡이가 없는가** — 즉 화면이 둘을 못 가르는가.
 *
 * 이때는 이름표를 붙여도 두 줄이 똑같습니다. 화면은 **그 사실을 말해야**
 * 합니다 — 「구분됩니다」인 척하면 사람이 되돌릴 수 없는 단추를 찍습니다.
 *
 * ⚠️ 단추를 **막지는 않습니다.** 막으면 이름이 같다는 이유로 팀 운영이
 * 멈춥니다. 시스템은 판정하지 않습니다 — 사실을 알리고 사람이 정합니다.
 */
export function tellsApartInList(person: PersonRef, all: readonly PersonRef[]): boolean {
  if (!nameRepeatsInList(person, all)) return true;

  const label = labelInList(person, all);
  return !all.some(
    (other) => other.user_id !== person.user_id && labelInList(other, all) === label,
  );
}

/** 못 가르는 줄에 붙이는 한 줄. */
export function cannotTellApartNote(): string {
  return '이름이 같은 팀원이 있습니다 — GitHub 아이디를 연결하면 구분됩니다';
}
