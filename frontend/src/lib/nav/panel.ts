/**
 * 맥락 패널 — 셸의 **오른쪽 열**.
 *
 * ## 무엇을 담는가, 그리고 **왜 계획보다 좁은가**
 *
 * `docs/19 §7` 은 팀원 · 답이 안 난 것 · 다음 안건 · 동의 넷을 적어
 * 뒀습니다. 실제 화면을 세어 보고 **팀원 하나로 줄였습니다.**
 *
 *     동의          로비 본문에 이미 있습니다 (`동의` 카드)
 *     답이 안 난 것  검토 본문에 이미 있습니다 (`회의에서 답이 안 난 것`)
 *     다음 안건      검토 본문에 이미 있습니다 (`다음 회의에서 다룰 안건`)
 *
 * 셋 다 **회의 단위**라, 있어야 뜻이 있는 화면에는 이미 본문에 있습니다.
 * 옆에 한 벌 더 그리면 이 저장소가 반복해서 당한 그것이 됩니다 — 두 벌이
 * 있으면 한쪽만 고쳐집니다. 프로젝트 전체로 모으면 뜻이 달라지지만
 * (`이 팀이 아직 답 못 낸 것들`) 그걸 주는 엔드포인트가 **0개**입니다.
 * 없는 것을 위해 자리를 비워 두지 않습니다.
 *
 * ## 팀원은 왜 남았는가 — **여기만 있는 정보입니다**
 *
 * 팀원 명단을 그리는 화면은 셋인데 셋 다 다른 것을 말합니다.
 *
 *     로비    지금 이 회의의 녹음 커버리지
 *     기여도  구간 · 신뢰도 · 근거
 *     설정    **내 것만** — 남의 역할도 남의 GitHub 연결도 안 보입니다
 *
 * 그래서 **"우리 팀이 각자 뭘 맡았고, 누구 활동을 아직 못 재는가"** 는
 * 지금 어느 화면에도 없습니다. 그게 이 패널의 몫입니다.
 *
 * ## ⚠️ 불변식
 *
 * · **가입 순 그대로.** 서버가 주는 순서를 바꾸지 않습니다. 정렬하는
 *   순간 그건 줄 세우기입니다
 * · **숫자 배지 없음.** 역할 비중은 "무엇을 맡기로 했는가" 이지 성적이
 *   아닙니다
 * · **GitHub 미연결은 0점이 아니라 `측정 불가`** 입니다. 그 사람이 일을
 *   안 한 게 아니라 우리가 못 재는 것입니다
 */

import { roleSummary } from '../contribution/roles.ts';

export interface Member {
  user_id: number;
  name: string;
  role_shares: Record<string, number>;
  github_login?: string | null;
}

/**
 * 이 사람의 코드 활동을 **잴 수 있는가.**
 *
 * ⚠️ `measured` / `unmeasurable` 둘뿐입니다. **`bad` 가 없습니다** —
 * 못 재는 것은 나쁜 것이 아닙니다 (docs/05 §5).
 */
export type MeasureState = 'measured' | 'unmeasurable';

export interface PanelMember {
  userId: number;
  name: string;
  /** 역할 한 줄. 정해진 게 없으면 `null` — 그 줄을 안 그립니다 */
  roles: string | null;
  state: MeasureState;
  /** 못 재는 이유. 잴 수 있으면 `null` */
  note: string | null;
  /** 낭독기용 한 줄 — 점은 눈으로만 읽힙니다 */
  ariaLabel: string;
}

const UNMEASURABLE = 'GitHub 아이디를 아직 연결하지 않아 코드 활동을 못 잽니다';

export function measureState(githubLogin?: string | null): MeasureState {
  return (githubLogin ?? '').trim() === '' ? 'unmeasurable' : 'measured';
}

/**
 * 팀원 → 패널 줄.
 *
 * ⚠️ **정렬하지 않습니다.** 서버가 가입 순으로 줍니다. 여기서 이름순이든
 * 역할순이든 다시 세우면 그건 목록이 아니라 **순위**로 읽힙니다.
 */
export function panelMembers(members: readonly Member[]): PanelMember[] {
  return members.map((member) => {
    const roles = roleSummary(member.role_shares);
    const state = measureState(member.github_login);
    const note = state === 'unmeasurable' ? UNMEASURABLE : null;

    const spoken = [member.name];
    if (roles !== null) spoken.push(roles);
    if (note !== null) spoken.push(note);

    return {
      userId: member.user_id,
      name: member.name,
      roles,
      state,
      note,
      ariaLabel: spoken.join(', '),
    };
  });
}

/**
 * 패널 머리말 — 몇 명인가.
 *
 * ⚠️ 숫자를 배지로 그리지 않고 **글자로** 씁니다. 배지는 "많을수록 좋다"
 * 로 읽히는데 팀원 수는 그런 값이 아닙니다.
 */
export function panelHeading(count: number): string {
  return `팀원 ${count}명`;
}

/**
 * 못 재는 사람이 있으면 패널 아래에 붙일 한 줄.
 *
 * ⚠️ **이름을 나열하지 않습니다.** "박지원·이하늘은 못 잽니다" 는 사실상
 * 명단이고, 그 명단은 곧 누가 부족한지의 목록으로 읽힙니다. 몇 명인지와
 * 무엇을 하면 되는지만 말합니다.
 *
 * 전원 연결됐으면 `null` — 할 말이 없으면 아무 말도 하지 않습니다.
 */
export function unmeasurableNote(members: readonly PanelMember[]): string | null {
  const count = members.filter((m) => m.state === 'unmeasurable').length;
  if (count === 0) return null;
  return `${count}명은 GitHub 아이디가 없어 코드 활동이 기여도에 안 들어갑니다 — 설정에서 각자 연결합니다`;
}

/**
 * 팀원을 한 명도 못 받았을 때.
 *
 * ⚠️ 빈 목록을 그냥 비우면 "혼자인가?" 로 읽힙니다. 프로젝트에는 최소한
 * 만든 사람이 있으므로, 0명은 **거의 언제나 못 받아 온 것**입니다.
 */
export function emptyMembersNote(): string {
  return '팀원을 불러오지 못했습니다';
}
