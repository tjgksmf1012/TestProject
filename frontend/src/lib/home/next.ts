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

import { teamDateTime } from '../time/calendar.ts';

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
  /**
   * 회의를 **연** 시각. ISO8601, 서버가 UTC 로 준다.
   *
   * ⚠️ **아직 안 연 회의는 `null`** 입니다 (결함 287). 달력에서 일정을
   * 잡으면 그런 회의가 생깁니다. 예전에는 서버 스키마가 이 칸을 비어 있을
   * 수 없게 잡아 두어, 일정을 하나 잡는 순간 회의 목록이 통째로 **500**
   * 이 되고 홈이 「회의를 열면 여기에 나옵니다」로 바뀌었습니다.
   */
  started_at: string | null;
  /** 잡아 둔 시각. 이미 연 회의는 `null`. */
  scheduled_at: string | null;
  /**
   * 이 회의에서 **기록된 발화 수**.
   *
   * ⚠️ 서버가 언제나 보냅니다. 옛 응답을 읽는 자리가 있을 수 있어
   * 물음표를 달아 두지만, **판단은 `hasTranscript` 한 곳**에서 합니다 —
   * 화면이 `?? 0` 을 적으면 「모른다」와 「잰 0」이 같아집니다.
   */
  utterance_count?: number;
  pending_candidates: number;
  /**
   * 이 회의에서 **끝난 트랙들의 평균 커버리지**. 서버가 언제나 보냅니다.
   *
   * ⚠️ `coverage` 는 `complete_track` 에서만 채워집니다 — 그래서 값이
   * 있다는 것은 **누군가 녹음을 마쳤다**는 뜻입니다(결함 405). 아직
   * 아무도 안 마쳤으면 `null` 입니다.
   *
   * ⚠️ 못 받았으면(`undefined`) **아무 말도 하지 않는 쪽**으로 둡니다 —
   * `?? 0` 을 적으면 「모른다」와 「잰 0」이 같아집니다.
   */
  coverage?: number | null;
}

/**
 * **이 회의는 언제인가** — 한 벌.
 *
 * 연 회의는 연 시각, 안 연 회의는 잡아 둔 시각입니다. 둘 다 없으면
 * `null` 이고, 그때는 **시각을 지어내지 않습니다.**
 *
 * ⚠️ 화면마다 `started_at ?? scheduled_at` 을 적으면 한쪽만 고쳐집니다.
 * 정렬도 같은 값을 봐야 목록 순서와 표시가 안 어긋납니다.
 */
export interface MeetingWhen {
  /** ISO8601 또는 `null`. */
  at: string | null;
  /** 아직 안 연 회의인가. 참이면 「예정」입니다. */
  planned: boolean;
}

export function meetingWhen(meeting: {
  started_at: string | null;
  scheduled_at: string | null;
}): MeetingWhen {
  if (meeting.started_at !== null && meeting.started_at !== '') {
    return { at: meeting.started_at, planned: false };
  }
  const at = meeting.scheduled_at;
  return { at: at !== null && at !== '' ? at : null, planned: true };
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
/**
 * 이 회의가 **지금 사람을 기다리는가**.
 *
 * ## ⚠️ 왜 따로 떼었나 (결함 355)
 *
 * `sectionMeetings` 가 이 물음에 답하려고 `nextStepFor(m).actionable` 을
 * 불렀습니다. 그런데 `nextStepFor` 는 **칸반 링크**를 만들어야 해서
 * 프로젝트 id 가 필요해졌고, 목록을 가르는 일에는 프로젝트가 아무 상관이
 * 없습니다. 필요 없는 값을 끌고 다니면 다음 사람이 아무 숫자나 넣습니다.
 *
 * ⚠️ **판단을 두 벌로 만들지 않습니다** — `nextStepFor` 의 `needs_review`
 * 갈래도 이 함수를 부릅니다. 조건이 갈라지면 「검토 필요 2건」이라고
 * 세어 놓고 그중 하나에는 검토할 것이 없는 상태로 돌아갑니다(결함 252).
 */
export function waitsForPeople(meeting: Meeting): boolean {
  return meeting.status === 'needs_review' && meeting.pending_candidates > 0;
}

/**
 * 이 회의에 **기록된 말이 있는가.**
 *
 * ⚠️ 못 받은 것(`undefined`)은 「없다」가 아닙니다 — 이 제품의 불변식
 * (**측정 불가 ≠ 0점**)이 여기에도 걸립니다. 못 받았으면 **아무 말도
 * 하지 않는 쪽**으로 둡니다: 참을 돌려주면 화면은 옛 문장을 그대로
 * 쓰고, 그건 고치기 전과 같은 글자입니다.
 */
export function hasTranscript(meeting: Meeting): boolean {
  return meeting.utterance_count === undefined || meeting.utterance_count > 0;
}

/**
 * 이 회의에서 **다음에 할 일**.
 *
 * ## ⚠️ `projectId` 를 받는 이유 (결함 355)
 *
 * 칸반은 **프로젝트의 화면**입니다. 그런데 여기서 만드는 링크는
 * `/kanban.html?meeting=6` 처럼 회의만 달고 있었고, 레거시 칸반은
 * `params.get('project') ?? '1'` 이라 **없으면 1번**을 엽니다.
 *
 * `nav/links.ts` 는 머리말에서 바로 이것을 금지합니다 — "id 가 없는데
 * 링크를 만들면 눌렀을 때 엉뚱한 프로젝트(기본값 1)로 갑니다. **없는
 * 링크를 안 만드는 것이 여기서 하는 판단입니다.**" 같은 판단이 두 곳에
 * 있었고 한쪽만 지키고 있었습니다 (대표 실패 ②).
 *
 * 프로젝트가 하나뿐인 시연 데이터에서는 기본값 1 이 **언제나 맞아서**
 * 아무 일도 안 일어납니다. 프로젝트를 둘 만들고 두 번째 프로젝트의
 * 회의에서 눌러야 드러납니다 — 재서 확인했습니다(프로젝트 1의 칸반이
 * 열렸습니다).
 *
 * ⚠️ **기본값을 두지 않습니다.** 두면 두 화면이 조용히 옛 동작을
 * 이어받고, 타입이 아무것도 안 막습니다.
 */
export function nextStepFor(meeting: Meeting, projectId: number): NextStep {
  const id = meeting.meeting_id;
  /* 칸반은 프로젝트 화면이므로 **둘 다** 답니다. `meeting` 은 "어느
     회의에서 왔는지" 이고, `project` 가 없으면 갈 곳이 정해지지 않습니다. */
  const kanban = `/kanban.html?project=${projectId}&meeting=${id}`;

  switch (meeting.status) {
    case 'pending':
      /* ⚠️ `pending` 은 이제 **세 국면**입니다 (결함 287) — 잡아만 둔 것 ·
         녹음 전 · 녹음 중. 앞의 둘은 `started_at` 이 있는지로 갈립니다.
         잡아만 둔 회의에 「녹음을 시작합니다」라고 하면 아직 오지 않은
         날의 일을 지금 하라는 말이 됩니다. */
      if (meetingWhen(meeting).planned) {
        return {
          href: `/lobby.html?meeting=${id}`,
          label: '회의 열기',
          reason: '잡아 둔 회의입니다 — 로비에서 동의를 받고 시작합니다',
          actionable: false,
        };
      }
      /* ⚠️ **녹음이 이미 끝난 사람이 있는데 「시작합니다」라고 했습니다**
         (결함 405). 위 주석이 세 국면이라고 적어 놓고 코드는 두 갈래만
         갈랐습니다 — 둘이 녹음을 마치고 커버리지 100% 가 찍힌 회의에서
         홈은 「동의를 받고 녹음을 시작합니다」였고, 같은 순간 로비는
         「1명이 참가하지 않아 회의가 끝나지 않습니다 — 강제 종료할 수
         있습니다」였습니다. 브라우저로 나란히 놓고 쟀습니다(결함 290).

         `coverage` 는 `complete_track` 에서만 채워지므로 값이 있으면
         **누군가 마쳤다**는 뜻이고, 그런데도 `pending` 이라는 것은
         서버가 아직 큐에 안 넣었다는 뜻입니다 — 그 조건은 「아직 녹음
         중인 사람」이나 「참가 안 한 사람」이 남은 것뿐입니다
         (`finalize_meeting`). 누가 남았는지는 로비가 말합니다. */
      if (meeting.coverage !== null && meeting.coverage !== undefined) {
        return {
          href: `/lobby.html?meeting=${id}`,
          label: '회의 로비로',
          reason: '녹음을 마친 사람이 있습니다 — 로비에서 남은 사람을 확인하세요',
          actionable: true,
        };
      }
      return {
        href: `/lobby.html?meeting=${id}`,
        label: '회의 로비로',
        reason: '동의를 받고 녹음을 시작합니다',
        actionable: true,
      };

    /* ⛔ **차례를 기다리는 것과 하고 있는 것은 다릅니다** (결함 325).
       예전에는 둘을 한 갈래로 묶어 `queued` 회의에도 「처리 중입니다」라고
       했습니다. 그런데 상태 이름표는 「처리 대기」라서 한 줄 안에서
       **「처리 대기 — 처리 중입니다」**로 스스로 모순됐습니다.
       바로 위 `pending` 이 세 국면을 가른 것과 같은 이유입니다(결함 287). */
    case 'queued':
      return {
        href: null,
        label: '',
        reason: '처리 차례를 기다리는 중입니다 — 아직 시작하지 않았습니다',
        actionable: false,
      };

    case 'processing':
      return {
        href: null,
        label: '',
        reason: '처리 중입니다 — 끝나면 검토할 업무 후보가 나옵니다',
        actionable: false,
      };

    case 'needs_review':
      if (!waitsForPeople(meeting)) {
        /* ⛔ **「후보 0건」의 이유는 둘입니다** (결함 368).
           사람들이 이야기했는데 업무가 안 나온 것과, **소리가 하나도 안
           잡힌 것.** 다음에 할 일이 정반대인데 한 문장으로 뭉개고
           있었습니다 — 뒤엣것에게 「회의에서 업무가 나오지 않았습니다」는
           헛다리를 짚게 합니다. 진짜 소식은 다시 녹음해야 한다는 것입니다. */
        if (!hasTranscript(meeting)) {
          return {
            href: `/lobby.html?meeting=${id}`,
            label: '트랙 상태 보기',
            /* ⚠️ **이유는 지어내지 않습니다** (결함 311·318). 마이크가
               꺼져 있었는지 소리가 작았는지는 여기서 알 수 없습니다 —
               아는 것만 적고, 가릴 수 있는 자리로 보냅니다. */
            reason: '오간 말이 하나도 기록되지 않았습니다 — 로비에서 트랙을 확인하세요',
            actionable: false,
          };
        }
        // 승인 화면으로 보내면 빈 목록이 뜬다. 고장이 아니라 결과다.
        return {
          href: kanban,
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
        href: kanban,
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
  //
  /* ⛔ **문을 잘못 가리키고 있었습니다** (결함 270). SPA 는 이 문구를 안
     쓰고 자기 문장을 따로 적었는데(실패 ② — 두 벌), 그 문장이
     「오른쪽 위 "+ 새 프로젝트" 로 만들거나 **초대 코드로 참가하세요**」
     였습니다. 참가 칸은 그 단추 **안에** 있습니다 — 단추 이름은 「새
     프로젝트」 하나뿐입니다.

     초대 코드로 막 들어온 사람이 되어 봤습니다. 가입을 마치면 이 화면에
     떨어지는데, **누를 수 있는 것이 넷**(건너뛰기·홈·로그아웃·새
     프로젝트)이고 **입력칸은 0개**입니다. 참가하러 온 사람에게 화면은
     「참가하세요」라고 말하면서 참가할 자리를 안 보여 줍니다 —
     실패 ③ 그대로입니다.

     그래서 문구는 **한 문**만 가리키고, 화면은 그 문에 **참가라는 이름의
     손잡이**를 하나 더 답니다. */
  return '아직 속한 프로젝트가 없습니다. 새로 만들거나, 팀원에게 받은 초대 코드로 참가하세요.';
}

/**
 * 회의 시각. **팀 달력(`Asia/Seoul`)으로** 보여줍니다.
 *
 * ⚠️ 예전에는 `toLocaleString` 을 시간대 없이 불렀습니다 — 그건
 * **브라우저 달력**이라 같은 회의를 팀원마다 다른 날로 봅니다(결함 246).
 * 씨앗 회의가 전부 `10:00Z` 라 어느 시간대에서도 날짜가 안 넘어갔고,
 * 그래서 이 자리는 오래도록 안 들켰습니다 — 자정을 넘는 회의를 심고서야
 * 나왔습니다(결함 287).
 *
 * ⚠️ 못 읽는 값이면 **지어내지 않고** 받은 글자를 그대로 돌려줍니다.
 */
export function formatMeetingTime(iso: string): string {
  return teamDateTime(iso) ?? iso;
}

/**
 * 이 회의가 **언제인지** 한 줄로. 아직 안 연 회의는 「예정」이 붙습니다.
 *
 * ⚠️ 두 셸이 각자 지으면 갈라집니다 — SPA 는 팀 달력(`shortTeamDate`)을
 * 쓰고 레거시는 브라우저 달력을 쓰고 있었습니다. 한 벌에서 옵니다.
 */
export function describeMeetingWhen(meeting: {
  started_at: string | null;
  scheduled_at: string | null;
}): string {
  const when = meetingWhen(meeting);
  // ⛔ 모르면 시각을 지어내지 않습니다 (측정 불가 ≠ 0).
  if (when.at === null) return '—';
  const shown = formatMeetingTime(when.at);
  return when.planned ? `예정 ${shown}` : shown;
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
    // ⚠️ 안 연 회의는 `started_at` 이 없습니다 (결함 287) — 「언제인가」를
    //    한 벌(`meetingWhen`)에서 받아야 표시와 순서가 안 어긋납니다.
    const ta = Date.parse(meetingWhen(a).at ?? '');
    const tb = Date.parse(meetingWhen(b).at ?? '');
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
    return b.meeting_id - a.meeting_id;
  };
  /* ⛔ **상태만 보면 안 됩니다** (결함 252). 이 함수의 머리말이 스스로
     「가르는 기준은 상태가 아니라 **사람이 할 일이 있는가**」라고 적어
     두고, 정작 코드는 `status === 'needs_review'` 하나만 봤습니다.

     후보가 0건인 `needs_review` 회의(사람이 셋 다 검토했는데 서버가
     `confirmed` 를 못 넣은 경우 · 회의에서 업무가 안 나온 경우)가 그
     덩어리에 들어가, 머리말이 「검토 필요 **2**」라고 세고 있었습니다.
     한 건은 검토할 것이 없는데요. `nextStepFor` 는 그 회의에 대해 이미
     `actionable: false` 라고 답하고 있었습니다 — **판단이 있는데 안 물어본
     것**입니다.

     ⚠️ 그 판단은 이제 `waitsForPeople` 한 곳입니다 (결함 355). 예전에는
     여기서 `nextStepFor(m).actionable` 을 불렀는데, 그 함수가 칸반 링크
     때문에 **프로젝트 id** 를 받게 되면서 목록을 가르는 일과 아무 상관
     없는 값을 끌고 다녀야 했습니다. */
  const needsReview = meetings.filter(waitsForPeople).slice().sort(byRecent);
  const rest = meetings.filter((m) => !waitsForPeople(m)).slice().sort(byRecent);
  return { needsReview, rest };
}

/**
 * 이 줄의 버튼을 **얼마나 세게** 그릴 것인가.
 *
 * ## ⛔ 화면이 `actionable` 을 뒤집고 있었습니다 (결함 252)
 *
 * 홈은 「검토 필요」 덩어리의 줄을 전부 `btn--primary` 로 그렸습니다.
 * 렌더해서 재 보니 이랬습니다.
 *
 *     칸반 보기          btn--primary   검토할 업무 후보가 없습니다 …
 *     업무 후보 3건 검토  btn--primary   승인해야 칸반에 등록됩니다 …
 *
 * 화면에서 **제일 센 버튼**이 「여기엔 할 일이 없습니다」를 가리키고 있었고,
 * 그 줄이 진짜 할 일보다 **위**에 있었습니다. `lib` 은 그 회의에 대해
 * `actionable: false` 라고 답했는데 화면이 뒤집은 것입니다.
 *
 * ⚠️ 「primary 는 검토 필요 줄에만」(v2 F9)은 그대로입니다 — 다만 그 앞에
 * **할 일이 있을 때만**이 붙습니다.
 */
export type StepEmphasis = 'primary' | 'secondary' | 'ghost';

export function emphasisFor(step: NextStep, waiting: boolean): StepEmphasis {
  if (!step.actionable) return 'ghost';
  return waiting ? 'primary' : 'secondary';
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

/**
 * 홈의 리본 옆에 **글자로** 서는 값 — 「값은 글자로, 그림은 폭이나 개수만」.
 *
 * ## 왜 이름이 붙는가 (결함 336)
 *
 * 홈은 이 값을 **`80%` 라고만** 그렸습니다. 축 이름은 `aria-label` 에만
 * 있어서 **낭독기는 「녹음 커버리지 80%」를 듣고 눈으로 보는 사람은
 * 「80%」만 봤습니다.** 같은 요소에서 귀가 눈보다 많이 아는 상태입니다.
 *
 * 그리고 그 목록의 옆 줄들은 「처리 중」·「검토 필요」라고 적혀 있습니다 —
 * 그 사이에서 80% 까지 찬 막대는 **처리 진행률**로 읽힙니다. 실제로는
 * 녹음이 얼마나 온전히 잡혔는가이고, 둘은 전혀 다른 것입니다.
 *
 * 형제 자리인 기여도는 이미 이렇게 하고 있었습니다 —
 * `ribbonReading()` 이 「확신 45% · 모름 55%」를 **눈에도** 적습니다.
 * 홈만 빠져 있었습니다 (결함 331 의 「값에 이름을 붙이면 두 뜻이 보인다」).
 */
export function coverageReading(coverage: number): string {
  return `커버리지 ${Math.round(coverage * 100)}%`;
}

/** 낭독기에 읽힐 한 줄. 그림이 말하는 것과 **같은 것**을 말합니다. */
export function describeCoverageRibbon(title: string, coverage: number): string {
  return `${title} — 녹음 ${coverageReading(coverage)}`;
}

