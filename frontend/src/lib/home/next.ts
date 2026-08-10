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
  /** 이동할 주소. 비어 있으면 버튼을 만들지 않는다. */
  href: string;
  label: string;
  /** 왜 지금 이걸 하는가. 버튼만 있으면 사람은 왜 눌러야 하는지 모른다. */
  reason: string;
  /** 사람이 지금 해야 할 일인가. 처리 중인 것과 구분한다. */
  actionable: boolean;
}

export const MEETING_STATUS_LABEL: Record<string, string> = {
  pending: '녹음 전 · 녹음 중',
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
        href: '',
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
