/**
 * 첫 화면의 판단 로직 — **지금 무엇을 할 차례인가.**
 *
 * 이 화면이 없던 동안 로그인해도 갈 곳이 없었습니다. 화면을 열려면
 * `?project=1&meeting=1` 을 주소에 직접 적어야 했고, 그 숫자를 알 방법은
 * `seed_demo.py` 의 출력뿐이었습니다.
 *
 * 그래서 여기서 정하는 건 "목록을 예쁘게 그리는 법" 이 아니라 **회의 상태
 * 하나를 보고 어디로 보낼 것인가** 입니다. 잘못 보내면 사용자는 빈 화면을
 * 보고 "안 되는구나" 라고 결론 내립니다 — 실제로는 아직 그 단계가 아닌
 * 것뿐인데도.
 */

export interface Project {
  project_id: number;
  title: string;
  member_count: number;
  meeting_count: number;
  needs_review: number;
}

export interface Meeting {
  meeting_id: number;
  title: string | null;
  status: string;
  /** ISO8601. 서버가 UTC 로 준다. */
  started_at: string;
  pending_candidates: number;
}

export interface NextStep {
  /**
   * 이동할 주소. **갈 곳이 없으면 `null`** 이고, 그때는 버튼을 안 만듭니다.
   *
   * ⚠️ 예전에는 빈 문자열이 그 뜻이었습니다. 화면이 `step.href ? … : ''`
   * 로 참·거짓만 보면 맞게 돌지만, React 로 옮기며 `!== null` 로 적었더니
   * **빈 `<a>` 가 그려졌습니다** — 글자 없는 작은 상자가 처리 중인 회의
   * 줄에 떴고, 눌러도 아무 데도 안 갑니다. 렌더해서 보고 알았습니다.
   *
   * 빈 문자열은 "없음" 처럼 **생기지 않았습니다.** `null` 은 타입이
   * 강제하므로 같은 실수를 다시 할 수 없습니다.
   */
  href: string | null;
  label: string;
  /** 왜 지금 이걸 하는가. 버튼만 있으면 사람은 왜 눌러야 하는지 모른다. */
  reason: string;
  /** 사람이 지금 해야 할 일인가. 처리 중인 것과 구분한다. */
  actionable: boolean;
}

export const MEETING_STATUS_LABEL: Record<string, string> = {
  /* ⛔ 예전에는 `'녹음 전 · 녹음 중'` 이었습니다 (UI 패스 v3). 서버의
     `pending` 이 두 국면을 함께 뜻해서 **둘 다 적은** 것인데, 상태 칸에
     낱말 둘이 서면 읽는 사람은 **어느 쪽인지 모릅니다.** 옆 칸의 형제들
     (「처리 중」·「검토 필요」)은 전부 **국면 이름 하나**라 이 줄만 혼자
     문장처럼 길었습니다.
     회의가 흐름의 어디에 있는지만 말합니다 — 무엇을 할 수 있는지는 오른쪽
     행동 버튼이 이미 말합니다. */
  pending: '녹음 단계',
  queued: '처리 대기',
  processing: '처리 중',
  needs_review: '검토 필요',
  confirmed: '검토 완료',
  failed: '처리 실패',
};

export function describeMeetingStatus(status: string): string {
  return MEETING_STATUS_LABEL[status] ?? status;
}

/**
 * 이 회의에서 다음에 할 일.
 *
 * ⭐ **`needs_review` 인데 후보가 0건인 경우를 갈라 놓습니다.**
 * 그대로 승인 화면으로 보내면 빈 목록이 뜨고, 사용자는 화면이 고장 났다고
 * 생각합니다. 실제로는 "AI 가 업무로 뽑을 만한 게 없었다" 이고, 그건
 * 정상적인 결과입니다 — 그렇게 말해 줘야 합니다.
 *
 * ⭐ **처리 중인 회의에는 버튼을 만들지 않습니다.** 눌러도 아직 아무것도
 * 없는 곳으로 갈 뿐입니다. 기다리라고 말하는 게 맞습니다.
 */
export function nextStepFor(meeting: Meeting): NextStep {
  const id = meeting.meeting_id;

  switch (meeting.status) {
    case 'pending':
      return {
        href: `/lobby.html?meeting=${id}`,
        label: '회의 로비로',
        reason: '동의를 받고 녹음을 시작합니다',
        actionable: true,
      };

    case 'queued':
    case 'processing':
      return {
        href: null,
        label: '',
        reason: '처리 중입니다 — 끝나면 검토할 업무 후보가 나옵니다',
        actionable: false,
      };

    case 'needs_review':
      if (meeting.pending_candidates === 0) {
        // 승인 화면으로 보내면 빈 목록이 뜬다. 고장이 아니라 결과다.
        return {
          href: `/kanban.html?meeting=${id}`,
          label: '칸반 보기',
          reason: '검토할 업무 후보가 없습니다 — 회의에서 업무가 나오지 않았습니다',
          actionable: false,
        };
      }
      return {
        href: `/review.html?meeting=${id}`,
        label: `업무 후보 ${meeting.pending_candidates}건 검토`,
        reason: '승인해야 칸반에 등록됩니다 — AI가 만든 업무는 사람을 거칩니다',
        actionable: true,
      };

    case 'confirmed':
      return {
        href: `/kanban.html?meeting=${id}`,
        label: '칸반 보기',
        reason: '검토를 마쳤습니다',
        actionable: false,
      };

    case 'failed':
      return {
        href: `/lobby.html?meeting=${id}`,
        label: '트랙 상태 보기',
        reason: '처리에 실패했습니다 — 트랙이 온전한지 확인하세요',
        actionable: true,
      };

    default:
      // 모르는 상태를 숨기지 않습니다. 숨기면 그 회의가 화면에서 사라집니다.
      return {
        href: `/lobby.html?meeting=${id}`,
        label: '회의 열기',
        reason: `알 수 없는 상태입니다: ${meeting.status}`,
        actionable: false,
      };
  }
}

/**
 * 프로젝트 하나를 한 줄로.
 *
 * 숫자만 늘어놓으면 어느 것을 먼저 볼지 알 수 없습니다. **지금 사람이 할
 * 일이 있는 것**을 먼저 말합니다.
 */
export function describeProject(project: Project): string {
  if (project.meeting_count === 0) {
    return `팀원 ${project.member_count}명 · 아직 회의가 없습니다`;
  }
  if (project.needs_review > 0) {
    return `팀원 ${project.member_count}명 · 회의 ${project.meeting_count}개 · 검토할 회의 ${project.needs_review}개`;
  }
  return `팀원 ${project.member_count}명 · 회의 ${project.meeting_count}개`;
}

/**
 * ⭐ 할 일이 있는 프로젝트를 위로.
 *
 * 여기서 점수 순 정렬을 금지한 기여도 화면과 다릅니다 — 이건 사람 사이의
 * 비교가 아니라 **내 할 일 목록**이라, 급한 것을 위로 올리는 게 맞습니다.
 * 같은 조건이면 id 순으로 고정해 순서가 흔들리지 않게 합니다.
 */
export function orderProjects(projects: readonly Project[]): Project[] {
  return [...projects].sort((a, b) => {
    if ((b.needs_review > 0 ? 1 : 0) !== (a.needs_review > 0 ? 1 : 0)) {
      return b.needs_review > 0 ? 1 : -1;
    }
    return a.project_id - b.project_id;
  });
}

/**
 * ⭐ **홈이 지금 보여 줄 프로젝트.**
 *
 * ## 이게 없어서 생겼던 일
 *
 * SPA 의 홈은 `orderProjects(projects)[0]` 하나만 그렸고, 어느 것을 볼지
 * 고를 방법이 없었습니다. 베타에서 재현한 것:
 *
 *  1. 새로 가입해 `내가 만든 프로젝트` 를 만든다 → 홈이 그것을 보여 준다.
 *  2. 팀에게 받은 초대 코드로 참가한다.
 *  3. **홈이 팀 프로젝트로 바뀌고 내 프로젝트는 화면에서 사라진다.**
 *     서버는 둘 다 알고 있는데 화면의 링크는 전부 팀 프로젝트를 가리켰고,
 *     내 것으로 돌아갈 길이 **하나도 없었습니다.**
 *
 * 검토할 회의가 있는 프로젝트를 앞으로 보내는 `orderProjects` 는 "무엇을
 * 먼저 볼까" 에 옳은 답입니다. 문제는 그 답이 **유일한 답**이었다는 것.
 *
 * ## 왜 주소(`?project=`)인가
 *
 * 기억해 두는 방법(localStorage)도 있지만, 그러면 "지금 무엇을 보고 있나"
 * 가 화면 어디에도 안 적힙니다. 새로고침·뒤로가기·링크 공유가 전부
 * 달라지고, 그건 이 저장소가 여러 번 당한 **숨은 상태**입니다.
 *
 * ⚠️ 내 목록에 없는 id 를 주소에 적어도 **조용히 첫 번째로** 돌아갑니다.
 *    남의 프로젝트 id 를 넣어 보는 것으로 이름을 알아낼 수는 없어야 하고,
 *    오타 하나에 "없습니다" 를 띄우면 사람은 자기가 뭘 망가뜨린 줄 압니다.
 */
export function homeProject(
  projects: readonly Project[],
  requestedId: number | null,
): Project | undefined {
  if (requestedId !== null) {
    const asked = projects.find((p) => p.project_id === requestedId);
    if (asked !== undefined) return asked;
  }
  return orderProjects(projects)[0];
}

/**
 * 주소의 `?project=` 를 숫자로. 없거나 말이 안 되면 `null`.
 *
 * ⚠️ `Number('')` 은 **0** 입니다. 빈 값을 그대로 넘기면 "0번 프로젝트를
 *    보여 달라" 가 되고, 그건 없는 id 라 조용히 첫 번째로 떨어집니다 —
 *    지금은 결과가 같지만, 나중에 "없으면 오류" 로 바꾸는 순간 빈 주소가
 *    오류 화면이 됩니다.
 */
export function requestedProjectId(search: string): number | null {
  const raw = new URLSearchParams(search).get('project');
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 프로젝트가 하나도 없을 때. "없습니다" 로 끝내면 사람은 막힙니다. */
export function emptyProjectsMessage(): string {
  // ⭐ 예전 문구는 "팀원 중 한 명이 만들고 당신을 넣어야 합니다" 였다.
  // 그런데 **그 팀원도 똑같이 이 화면을 보고 있다.** 모두가 서로를
  // 기다리다 아무도 아무것도 못 하는 상태가 첫 화면의 기본값이었다.
  // 지금 여기서 할 수 있는 것만 말한다.
  return (
    '속한 프로젝트가 없습니다. 아래에서 새로 만들거나, ' +
    '팀원에게 받은 초대 코드로 참가하세요.'
  );
}

/**
 * 회의 시각. **로컬 시간대로** 보여줍니다.
 *
 * 서버는 UTC 로 주고, 화면이 그대로 쓰면 한국에서 9시간 어긋납니다 —
 * 오전 회의가 전날로 보입니다.
 */
export function formatMeetingTime(iso: string, locale = 'ko-KR'): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(locale, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * 홈 목록의 배치 — **사람이 할 일이 남은 것만 위로.**
 *
 * 예전에는 상태마다 그룹을 만들었습니다. 데모 데이터에서는 회의 다섯에
 * 그룹이 **다섯**이었고, 그룹당 한 줄이면 그건 묶음이 아니라 머리말
 * 다섯 개입니다 — 목록 높이의 절반을 머리말이 먹었습니다. 게다가 그룹
 * 순서가 상태 순서라 날짜가 `09-01 → 09-05 → 09-02 → 09-08 → 09-03` 으로
 * 뒤죽박죽이 되어 시간 감각이 사라졌습니다.
 *
 * 그래서 가르는 기준을 **상태**가 아니라 **사람이 할 일이 있는가**로
 * 바꿉니다. `검토 필요` 는 지금 사람을 기다리는 유일한 상태이므로 따로
 * 올리고, 나머지는 묶지 않고 **최근 것부터** 한 덩어리로 늘어놓습니다.
 * 각 줄의 상태는 줄 안의 상태 칸이 말합니다.
 */
export interface HomeSections {
  /** 사람을 기다리는 회의. 비어 있으면 길이 0. */
  needsReview: Meeting[];
  /** 나머지 — 최근 것부터. */
  rest: Meeting[];
}

export function sectionMeetings(meetings: readonly Meeting[]): HomeSections {
  // ⚠️ 내림차순입니다. 날짜가 같으면 id 큰 쪽(나중에 만든 것)이 위로 —
  // 정렬이 흔들리면 목록이 새로고침마다 춤춥니다.
  const byRecent = (a: Meeting, b: Meeting): number => {
    const ta = Date.parse(a.started_at);
    const tb = Date.parse(b.started_at);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
    return b.meeting_id - a.meeting_id;
  };
  const needsReview = meetings.filter((m) => m.status === 'needs_review').slice().sort(byRecent);
  const rest = meetings.filter((m) => m.status !== 'needs_review').slice().sort(byRecent);
  return { needsReview, rest };
}

/**
 * 이 회의에 그릴 레인이 있는가.
 *
 * ⚠️ 레인은 "아는 것 / 모르는 것" 을 말하는 문법입니다. 잴 게 없을 때
 * 빈 회색 막대를 그리면 그 문법이 무너집니다 — 홈에서 회의 다섯 중 넷이
 * 빈 막대였고, **값 없는 요소가 목록의 시각적 무게중심을 차지**했습니다.
 * 값이 없으면 레인 자리를 그냥 비우고, 상태 칸이 대신 말합니다.
 */
export function hasLane(coverage: number | null): boolean {
  return coverage !== null && Number.isFinite(coverage);
}
