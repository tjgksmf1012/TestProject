/**
 * 프로젝트 만들기·참가·설정의 판단 로직.
 *
 * 이 화면들이 없던 동안 **가입한 첫 사용자는 아무것도 할 수 없었습니다.**
 * "팀원이 넣어 주기를 기다리세요" 로 끝나는데 그 팀원도 같은 처지였습니다.
 *
 * 서버가 최종 판정을 하고 화면은 그걸 반복하지 않습니다 — 규칙이 두 곳에
 * 있으면 반드시 갈라집니다. 여기서 막는 것은 **왕복이 명백히 낭비인 경우**와,
 * 서버 응답만으로는 사람이 무엇을 고쳐야 할지 알 수 없는 경우뿐입니다.
 */

import { withJosa } from '../text/josa.ts';

/** 서버 `projects/invites.py` 와 같아야 한다. */
export const CODE_LENGTH = 8;
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * 사람이 입력한 초대 코드를 서버가 받는 형태로.
 *
 * 화면이 `ABCD-EFGH` 로 보여주므로 사람은 하이픈을 칩니다. 카톡에서
 * 복사하면 앞뒤 공백도 붙습니다. 그걸 "틀린 코드" 로 처리하면 **맞는
 * 코드를 들고도 못 들어옵니다.**
 */
export function normalizeCode(raw: string): string {
  return raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

export function formatCode(raw: string): string {
  const clean = normalizeCode(raw);
  return clean.length === CODE_LENGTH ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

/**
 * 서버에 물어보기 전에 걸러낼 수 있는가.
 *
 * ⭐ 형식이 틀린 것을 그대로 보내면 **"없는 코드" 와 "잘못 친 코드" 가 같은
 * 답을 받습니다.** 사람은 그 둘을 다르게 고쳐야 합니다 — 앞은 상대에게
 * 다시 묻는 것이고 뒤는 자기가 다시 치는 것입니다.
 */
export function codeProblem(raw: string): string | null {
  const clean = normalizeCode(raw);
  if (clean.length === 0) return '초대 코드를 입력하세요';
  if (clean.length !== CODE_LENGTH) {
    return `초대 코드는 ${CODE_LENGTH}자입니다 (지금 ${clean.length}자)`;
  }
  const bad = [...clean].filter((ch) => !CODE_ALPHABET.includes(ch));
  if (bad.length > 0) {
    // 어떤 글자가 문제인지 말합니다. "형식이 틀렸습니다" 만으로는
    // 여덟 글자 중 어디를 고쳐야 하는지 알 수 없습니다.
    return `코드에 쓰지 않는 글자가 있습니다: ${[...new Set(bad)].join(', ')} — 0·O·1·I·L은 쓰지 않습니다`;
  }
  return null;
}

export function titleProblem(raw: string): string | null {
  const title = raw.trim();
  if (title.length === 0) return '프로젝트 이름을 입력하세요';
  if (title.length > 200) return '이름이 너무 깁니다 (200자까지)';
  return null;
}

/**
 * GitHub 저장소는 `owner/repo` 여야 한다.
 *
 * ⭐ 웹훅은 `repository.full_name` 으로 프로젝트를 찾습니다. 주소 전체를
 * 넣으면 **웹훅이 영원히 이 프로젝트를 못 찾습니다** — 오류도 안 나고
 * 기여도만 이유 없이 빕니다.
 *
 * 주소를 붙여넣는 건 흔한 일이라, 거절만 하지 않고 **고쳐 줄 수 있으면
 * 고쳐서 보여줍니다.**
 */
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function normalizeRepo(raw: string): string {
  let value = raw.trim();
  if (value === '') return '';

  // https://github.com/owner/repo(.git)(/) → owner/repo
  value = value.replace(/^https?:\/\/(www\.)?github\.com\//i, '');
  value = value.replace(/^git@github\.com:/i, '');
  value = value.replace(/\.git$/i, '');
  value = value.replace(/\/+$/, '');
  return value;
}

export function repoProblem(raw: string): string | null {
  const value = normalizeRepo(raw);
  if (value === '') return null; // 비우는 건 "연결 끊기" 라 정상이다
  if (!REPO.test(value)) {
    return '저장소는 `owner/repo` 형식이어야 합니다';
  }
  return null;
}

/** 복사할 코드가 없을 때 할 말 (결함 264). 막는 것은 `aria-disabled` 라 **사유가 있어야** 합니다. */
export function whyCannotCopyCode(inviteCode: string | null | undefined): string | null {
  return codeToCopy(inviteCode) === null ? '복사할 초대 코드가 없습니다' : null;
}

/**
 * 주소에 적힌 설정 구역이 **있는 것인가** (결함 266).
 *
 * `/settings/zzz` 를 열면 탭 줄만 나오고 **본문이 통째로 비었습니다.**
 * 오류도 안 나고 안내도 없어서, 사람은 화면이 고장 났는지 자기가 잘못
 * 왔는지 알 방법이 없었습니다. 오타 한 글자, 낡은 즐겨찾기, 바뀐 링크로
 * 흔히 닿는 자리입니다.
 *
 * ⚠️ 아는 구역 목록은 **화면이 줍니다.** 여기에 목록을 또 두면 탭이 하나
 * 늘 때 두 곳을 고쳐야 하고, 그러면 반드시 한쪽만 고쳐집니다.
 */
export function unknownSectionNote(section: string, known: readonly string[]): string | null {
  if (known.includes(section)) return null;
  return '설정에 없는 구역입니다 — 위 탭에서 골라 주세요.';
}

/**
 * 이 저장이 **연결을 끊는 것인가** (결함 256).
 *
 * 저장소 칸을 비우고 「연결」을 누르면 `PATCH {github_repo: ""}` 가 나갑니다.
 * 재현했습니다 — 확인도, 알림도, 되돌리기도 없이 연결이 끊겼고, 원래 이름은
 * 화면에서 사라져 **무엇이었는지 볼 방법조차** 없었습니다.
 *
 * 가벼운 일이 아닙니다. 서버는 `github_repo` 만 지우는 것이 아니라
 * `github_connected_at`·`github_verified_at`·`github_installation_id` 를 **전부**
 * 비웁니다. 즉 다시 연결해도 (a) 설치 확인을 처음부터 다시 받아야 하고,
 * (b) 「연결한 순간부터」의 기준 시각이 새로 잡혀 **그 사이의 활동은 연결 전**이
 * 됩니다. GitHub 은 기여도의 세 다리 중 하나입니다.
 */
export function isDisconnect(current: string | null | undefined, next: string): boolean {
  const now = (current ?? '').trim();
  return now !== '' && normalizeRepo(next) === '';
}

/** 끊기 전에 물을 말. **무엇이 사라지는지** 적습니다. */
export function disconnectConfirm(repo: string): string {
  return (
    `${repo} 연결을 끊습니다.\n` +
    '지금까지 들어온 기여 기록은 남지만, 앞으로의 PR·리뷰는 들어오지 않습니다.\n' +
    '다시 연결하면 설치 확인부터 새로 하고, 끊겨 있던 동안의 활동은 「연결 전」으로 남습니다.\n' +
    '계속할까요?'
  );
}

/**
 * 만들고 나서 무엇을 하라고 할 것인가.
 *
 * ⭐ 프로젝트를 만들면 **혼자입니다.** 그 상태에서 "회의 열기" 만 보여주면
 * 혼자 회의를 열고, 동의는 혼자 하고, 녹음도 혼자 하게 됩니다 — 그건
 * 이 시스템이 하려는 일이 아닙니다. 팀원을 먼저 부르라고 말해야 합니다.
 */
export function nextStepAfterCreate(memberCount: number): string {
  if (memberCount <= 1) {
    return '아직 혼자입니다. 아래 초대 코드를 팀원에게 알려 주세요 — 다 모인 뒤에 회의를 여는 게 좋습니다.';
  }
  return '팀원이 모였습니다. 회의를 열면 로비에서 동의를 받고 녹음을 시작할 수 있습니다.';
}

/** 코드가 없을 때 코드 자리에 쓸 말. */
export const NO_CODE = '(없음)';

/**
 * 클립보드에 넣을 것.
 *
 * ⚠️ **화면에 보이는 글자를 그대로 복사하면 안 됩니다.** 코드가 없을 때
 * 코드 자리에는 `(없음)` 이 적혀 있고, 그걸 복사하면 클립보드에 문자열
 * `(없음)` 이 들어갑니다. 그리고 버튼은 **"복사됨"** 이라고 말합니다.
 *
 * 그 사람은 그걸 카톡으로 보냅니다. 받은 사람은 `(없음)` 을 참가 칸에
 * 넣고 "코드가 없습니다" 를 봅니다 — 그리고 **자기가 잘못 받아 적었다고
 * 생각합니다.** 이 저장소가 초대 코드에서 `0/O`·`1/I/L` 을 뺀 이유와
 * 같은 종류의 실패입니다.
 *
 * 그래서 표시용 문자열이 아니라 **데이터**에서 만듭니다. 없으면 `null` 을
 * 돌려주고, 부르는 쪽이 복사를 아예 하지 않습니다.
 */
export function codeToCopy(inviteCode: string | null | undefined): string | null {
  const raw = (inviteCode ?? '').trim();
  // ⭐ **코드 모양일 때만** 복사합니다. 이미 있는 검사를 씁니다 — 여기서
  // 새 규칙을 만들면 참가 칸이 받아 주는 것과 복사되는 것이 어긋납니다.
  if (codeProblem(raw) !== null) return null;
  // 서버가 하이픈·공백을 걷어내므로 보기 좋은 형태로 보내도 통합니다.
  return formatCode(raw);
}


/**
 * GitHub 계정이 이어졌는지 화면에 쓸 한 줄 (결함 112).
 *
 * ⚠️ **비어 있을 때 아무 말도 안 하면 안 됩니다.** 그 상태가 바로 그
 * 사람의 PR 이 주인을 못 찾는 상태이고, 화면에는 그냥 빈 칸으로
 * 보입니다 — 사람은 안 적어도 되는 칸으로 읽습니다.
 *
 * 연결 진단도 같은 말을 하지만 그건 **프로젝트를 만든 사람**이 보는
 * 자리입니다. 자기 칸 옆에서 자기 상태를 말해 줘야 자기가 고칩니다.
 */
export function githubLoginStatus(login: string | null): string {
  const value = (login ?? '').trim();
  if (value === '') {
    return '아직 연결하지 않았습니다 — 이 상태로는 내 PR이 기여도에 들어가지 않습니다.';
  }
  // ⚠️ 조사는 **계산**합니다 (결함 76·88). GitHub 아이디는 영문·숫자로
  // 끝나는데, 읽는 소리가 다 다릅니다 — `minsu-dev` 는 "브이"(받침 없음),
  // `hong3` 은 "삼"(ㅁ 받침), `hong7` 은 "칠"(**ㄹ** 받침)입니다.
  // ㄹ 받침은 받침이 있어도 `로` 라, 셋이 각각 갈립니다.
  return `지금 ${withJosa(value, '으로로')} 이어져 있습니다.`;
}
