
import { withJosa } from '../text/josa.ts';
import { teamDateOf } from '../time/calendar.ts';
/**
 * 칸반 보드의 판단 로직.
 *
 * 이 화면이 이 프로젝트의 주장을 눈으로 확인하는 자리입니다 —
 * **회의에서 나온 결정이 실제 업무가 됐는가.** 그래서 여기서 가장 중요한
 * 것은 열을 예쁘게 나누는 게 아니라, 업무마다 **어느 회의에서 왔는지**를
 * 잃지 않는 것입니다.
 */

export interface TaskOrigin {
  candidate_id: number;
  meeting_id: number;
  meeting_title: string | null;
  evidence_utterance_ids: number[];
}

/** 서버 `TaskGithubOut` 과 같은 모양. */
export interface TaskGithubLink {
  event_id: number;
  repo: string;
  /** PR 번호. 본문에서 못 읽으면 null. */
  number: number | null;
  title: string | null;
  actor_login: string;
  merged_at: string;
  relevance: number;
  /** `TASK-12` 가 적혀 있었으면 true. 추정이면 false. */
  confirmed: boolean;
  /** 왜 이 PR 이 이 업무에 붙었는가. */
  why: string;
}

/** 서버 `TaskOut` 과 같은 모양. */
export interface Task {
  id: number;
  title: string;
  /**
   * 맡은 사람들. 비어 있으면 담당자가 없는 업무입니다 (`TASK-006`).
   *
   * ⚠️ **서버가 이름 순으로 줍니다. 화면에서 다시 정렬하지 마십시오** —
   * 정렬하는 순간 순서에 뜻이 생기고, 사람은 맨 앞을 "주담당" 으로
   * 읽습니다. 적는 규칙은 `lib/kanban/assignees.ts` 에 있습니다.
   */
  assignee_ids: number[];
  status: string;
  /**
   * 무엇부터 볼 것인가 (`TASK-007`). **작을수록 급합니다.**
   *
   * ⚠️ **이 값으로 카드를 정렬하지 않습니다.** 열 안 순서는 사람이 끌어
   * 정하는 것이고, 우선순위로 자동 정렬하면 사람이 옮겨 놓은 것이 다음
   * 새로고침에 되돌아갑니다. 뜻과 규칙은 `lib/kanban/priority.ts`.
   */
  priority: number;
  /** ISO 날짜 `YYYY-MM-DD`. */
  deadline: string | null;
  completed_at: string | null;
  /** null 이면 사람이 손으로 만든 업무다. */
  origin: TaskOrigin | null;
  /** PR 에 적어야 하는 표식 (`TASK-12`). */
  marker: string;
  github: TaskGithubLink[];
}

export interface Column {
  status: string;
  label: string;
  tasks: Task[];
}

/**
 * 상태 → 사람 말.
 *
 * ⚠️ **서버의 `vocab.TASK_STATUS_LABEL` 과 짝입니다.** 값이 갈라지면
 * `test_repo_integrity.py` 의 교차 검사가 터집니다 — 실제로 서버가
 * `하는 중`, 화면이 `진행 중` 으로 갈려 있었고 화면 쪽 말을 남겼습니다.
 *
 * ⚠️ `review` 는 **완료가 아닙니다.** 검토 중인 일을 완료로 세면 진행률이
 * 실제보다 높게 나옵니다 (`vocab.TASK_FINISHED` 에 `done` 만 있습니다).
 */
/**
 * 업무가 하나도 없을 때 **뭐라고 적을 것인가**.
 *
 * ## ⛔ 「직접 만들 수도 있습니다」 — 이 제품에는 그 길이 없습니다 (결함 313)
 *
 * 갓 만든 프로젝트의 레거시 칸반이 이렇게 말했습니다 —
 *
 *     아직 등록된 업무가 하나도 없습니다 — 고장이 아닙니다.
 *     회의를 열어 녹음하면 AI가 업무 후보를 뽑고, 승인한 것이 여기로
 *     옵니다. **직접 만들 수도 있습니다.**
 *
 * 그 화면에 보이는 컨트롤 열셋을 전부 세어 봤습니다 — **업무를 만드는
 * 것은 하나도 없습니다.** 서버에도 없습니다: 업무를 만드는 코드는
 * `approval_service.py` 한 곳뿐이고, 그 옆에 이렇게 적혀 있습니다 —
 *
 *     # 2) 승인된 것만 업무로 만든다.
 *     #    승인 없이 tasks 에 쓰는 경로는 이 함수 어디에도 없다 — 그게 불변식이다.
 *
 * ⚠️ **결함 312 보다 나쁜 쪽입니다.** 312 는 「아직 없는 곳」을 가리켰지만
 * 이것은 **제품이 일부러 막아 둔 것**을 하라고 시킵니다. 사람은 없는
 * 단추를 찾아 화면을 헤맵니다.
 *
 * ⚠️ **SPA 는 처음부터 맞게 적고 있었습니다** — 「아직 업무가 없습니다 —
 * 회의 검토에서 후보를 승인하면 여기 올라옵니다.」 301·308·309 에 이어
 * 레거시만 갈라진 네 번째입니다. 그래서 문장을 **여기 한 벌로** 올립니다
 * (실패 ②: 두 벌이 있으면 한쪽만 고쳐집니다).
 */
export interface EmptyBoard {
  what: string;
  why: string;
  how: string;
}

/** 업무가 어디서 오는지 한 문장. 두 자리가 이 한 벌을 씁니다. */
const FROM_APPROVAL =
  '회의를 열어 녹음하면 AI가 업무 후보를 뽑고, 검토에서 승인한 것이 여기로 옵니다.';

export function emptyBoard(): EmptyBoard {
  return {
    what: '아직 등록된 업무가 하나도 없습니다 — 고장이 아닙니다.',
    /* ⚠️ 별표를 쓰지 마십시오 — 이 문장은 마크다운이 아니라 글자 그대로
       그려집니다 (결함 292 에서 보고서가 그렇게 새어 나갔습니다). */
    why: '업무는 회의 후보를 사람이 승인할 때만 만들어집니다 — 직접 적어 넣는 길은 어디서 온 일인지 남기려고 일부러 두지 않았습니다.',
    how: FROM_APPROVAL,
  };
}

/**
 * 출처 기록이 없는 카드에 뭐라고 적을 것인가.
 *
 * ## ⛔ 「손으로 만든 업무입니다」 — 결함 313 의 **셋째 자리** (결함 317)
 *
 * 313 에서 빈 상자와 머리줄을 고쳤는데, **같은 파일 안에 하나가 더**
 * 있었습니다. 카드의 「자세히」 서랍이 `task.origin` 이 비었을 때
 * 「손으로 만든 업무입니다 — 회의에서 나온 것이 아닙니다」라고 적습니다.
 *
 * 이 제품에 손으로 만드는 길은 없습니다(`approval_service.py` 의 불변식).
 * 그러니 그 갈래는 「손으로 만들었다」가 아니라 **「출처를 모른다」**입니다 —
 * 모르는 것을 단언하지 않는 것이 이 저장소의 규칙입니다(불변식 ③ 과
 * 같은 자리: 못 잰 것은 0이 아닙니다).
 *
 * ⚠️ **제 313 가드가 이것을 못 봤습니다.** 자가 `직접 만[든들]` 이었고
 * 이 문장은 「**손으로** 만든」입니다. 결함 299·316 과 같은 부류 —
 * 낱말을 막았지 요구를 재지 않았습니다.
 */
export function unknownOriginNote(): string {
  /* ⚠️ **이유를 붙이지 않습니다** (결함 318). 처음에는 「기록이 지워졌거나
     옛 자료입니다」라고 적었는데, 그건 **없는 이유를 지어낸 것**입니다
     (결함 311 과 같은 부류) — 시연 데이터가 이 상태를 **일부러** 만들고
     있고, 그것을 못 박은 검사까지 있습니다:

       approval_service.py  「승인 없이 tasks 에 쓰는 경로는 이 함수
                             어디에도 없다 — 그게 불변식이다」
       test_demo_path.py    「손으로 만든 업무도 있어야 합니다」

     둘이 서로 어긋나 있고, 어느 쪽이 맞는지는 **제품 결정**입니다
     (docs/17 318번 「결정이 필요한 자리」). 그때까지 화면은 **아는 것만**
     말합니다 — 출처 기록이 없다는 사실. */
  return '이 업무가 어느 회의에서 나왔는지 기록이 없습니다.';
}

/** 한 줄짜리 자리(SPA)용. 같은 사실을 같은 낱말로 말합니다. */
export function emptyBoardLine(): string {
  return `아직 업무가 없습니다 — ${FROM_APPROVAL}`;
}

export const STATUS_LABEL: Record<string, string> = {
  todo: '할 일',
  in_progress: '진행 중',
  review: '검토 중',
  done: '완료',
};

export function describeStatus(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

/**
 * 열을 만든다.
 *
 * ⭐ **서버가 모르는 상태를 가진 업무를 버리지 않는다.** 상태 값이 늘거나
 * 데이터가 손상되면 그 업무가 화면에서 조용히 사라지는데, 칸반에서 사라진
 * 업무는 "없는 업무" 로 읽힙니다. 마지막 열 뒤에 따로 모읍니다.
 */
export function toColumns(tasks: readonly Task[], statuses: readonly string[]): Column[] {
  const known = new Set(statuses);
  const columns: Column[] = statuses.map((status) => ({
    status,
    label: describeStatus(status),
    tasks: [],
  }));

  const strays: Task[] = [];
  for (const task of tasks) {
    if (known.has(task.status)) {
      columns.find((c) => c.status === task.status)?.tasks.push(task);
    } else {
      strays.push(task);
    }
  }

  for (const column of columns) column.tasks = sortForBoard(column.tasks);
  if (strays.length > 0) {
    columns.push({ status: '__unknown__', label: '알 수 없는 상태', tasks: strays });
  }
  return columns;
}

/**
 * 열 안의 순서: 마감일이 이른 것부터, 없는 것은 뒤로.
 *
 * 마감일 없는 업무를 위에 두면 **급한 것이 아래로 밀립니다.** 마감일이
 * 같으면 id 순으로 고정합니다 — 순서가 흔들리면 새로고침할 때마다 카드가
 * 움직여서 어디까지 봤는지 잃습니다.
 */
export function sortForBoard(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.deadline !== b.deadline) {
      if (a.deadline === null) return 1;
      if (b.deadline === null) return -1;
      return a.deadline < b.deadline ? -1 : 1;
    }
    return a.id - b.id;
  });
}

/**
 * 이 업무가 지금 늦었는가.
 *
 * 완료된 업무는 **완료 시점** 기준으로 판단합니다. 오늘 날짜로 보면
 * 지난달에 제때 끝낸 업무가 시간이 갈수록 "지연" 으로 바뀝니다.
 *
 * 완료 시각은 UTC 순간이라 **팀 달력으로 옮긴 뒤** 비교합니다 (결함 107·109).
 * 마감일은 달력 날짜라 옮길 것이 없습니다.
 *
 * 보는 사람의 달력이 아니라 팀의 달력인 이유는 `time/calendar.ts` 에
 * 적어 두었습니다 — 같은 업무가 누가 보느냐에 따라 지연이 되기도 하고
 * 아니기도 하면, 마감이라는 말이 뜻을 잃습니다.
 */
export function isOverdue(task: Task, today: string): boolean {
  if (task.deadline === null) return false;
  if (task.status === 'done') {
    if (!task.completed_at) return false;
    const completedOn = teamDateOf(task.completed_at);
    if (completedOn === null) return false;
    return completedOn > task.deadline;
  }
  return task.deadline < today;
}

/** 마감이 임박했는가. 지난 것은 여기 포함하지 않는다 — 문구가 다르다. */
export function isDueSoon(task: Task, today: string, withinDays = 2): boolean {
  if (task.deadline === null || task.status === 'done') return false;
  if (task.deadline < today) return false;
  return daysBetween(today, task.deadline) <= withinDays;
}

/**
 * ISO 날짜 두 개 사이의 일수.
 *
 * `Date` 를 UTC 자정으로 해석하는 것에 기대지만, **둘 다 같은 방식으로**
 * 해석하므로 차이는 시간대와 무관합니다. 한쪽만 로컬로 만들면 한국에서
 * 하루가 어긋납니다.
 */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * 다음으로 옮길 수 있는 상태들.
 *
 * 아무 열로나 옮길 수 있게 둡니다 — 칸반은 그런 도구입니다. 다만 **지금
 * 상태는 뺍니다.** 같은 값으로 PATCH 를 보내면 서버는 아무 일도 안 하는데
 * 사용자는 뭔가 했다고 생각합니다.
 */
export function nextStatuses(task: Task, statuses: readonly string[]): string[] {
  return statuses.filter((s) => s !== task.status);
}

/**
 * 이 이동이 **앞으로 가는 것인가 되돌리는 것인가** (디자인 브리프 §14).
 *
 * 화면에서 버튼 위계를 만드는 데 씁니다. 예전에는 옮기기 버튼 둘이
 * 카드 폭을 반씩 채우는 **같은 무게의 상자**였습니다. 카드 셋이면 큰
 * 상자가 여섯이라 화면에서 제일 먼저 읽히는 것이 버튼이었습니다.
 *
 * 위계의 근거는 **방향**입니다 — 앞으로 보내는 것이 이 화면의 주된
 * 행동이고, 되돌리는 것은 실수를 무를 때만 씁니다.
 *
 * ⚠️ 순서는 `statuses` **배열이 정합니다.** 이름으로 판단하지 않습니다 —
 * 상태 이름은 서버가 주고 프로젝트마다 다를 수 있는데, 여기서 `done` 을
 * 글자로 찾으면 그 순간 두 벌이 됩니다.
 *
 * 모르는 상태(둘 중 하나가 목록에 없음)는 `'back'` 입니다. 앞으로 가는
 * 것처럼 강조해 놓고 실제로는 어디로 가는지 모르는 것보다, 조용한 쪽이
 * 안전합니다.
 */
export function moveDirection(
  from: string,
  to: string,
  statuses: readonly string[],
): 'forward' | 'back' {
  const a = statuses.indexOf(from);
  const b = statuses.indexOf(to);
  if (a === -1 || b === -1) return 'back';
  return b > a ? 'forward' : 'back';
}

/**
 * 이 카드에 붙일 경고들.
 *
 * `origin` 이 없는 것은 경고가 아닙니다 — 사람이 손으로 만든 업무는 정상
 * 입니다. 반대로 **담당자가 없는 업무는 완료해도 기여도에 잡히지 않으므로**
 * 그건 말해 줘야 합니다.
 */
/**
 * 카드 **표면**에 붙일 표. 서랍을 안 열어도 보이는 것입니다.
 *
 * ## ⛔ 늦은 업무에 「기여도에 반영 안 됨」 (결함 319)
 *
 * 레거시 카드는 경고가 하나라도 있으면 **종류를 안 보고** 이 한 문장을
 * 붙였습니다 —
 *
 *     {warnings.length > 0 && <p className="gapmark">기여도에 반영 안 됨</p>}
 *
 * 마감을 과거로 옮겨 재 봤습니다. 「접근성 점검」은 담당자가 **둘**이고
 * 경고는 「마감일(2026-08-10)이 지났습니다」 하나뿐인데, 표면은
 * **「기여도에 반영 안 됨」**이었습니다.
 *
 * **그 말은 거짓입니다.** 서버를 확인했습니다 — 늦게 끝낸 업무도
 * `TASK_COMPLETED`(10점)를 그대로 받고, 늦음이 바꾸는 것은 **일정 준수**
 * 범주뿐입니다 (`task_service._record_deadline_verdict`). 기여도에서
 * 빠지는 것은 **담당자가 없을 때**입니다.
 *
 * 기여를 다루는 제품에서 「네 늦은 일은 안 쳐준다」는 말이 사실이 아닌 채로
 * 나가면 안 됩니다.
 *
 * ⚠️ **SPA 는 처음부터 갈라 그리고 있었습니다** — `{overdue && <span
 * className="kcard__late">지남</span>}`. 301·308·309·313·316 에 이어
 * 레거시만 갈라진 여섯 번째입니다.
 */
export interface CardMark {
  text: string;
  /** `gap` = 기여도에서 빠짐 · `late` = 마감이 지남 (빠지는 것과 다릅니다). */
  tone: 'gap' | 'late';
}

export function cardMarks(task: Task, today: string): CardMark[] {
  const marks: CardMark[] = [];
  // 이것만이 「기여도에 반영 안 됨」입니다 — 서버도 담당자 없는 업무에는
  // 완료 이벤트를 사람에게 못 답니다.
  if (task.assignee_ids.length === 0) {
    marks.push({ text: '기여도에 반영 안 됨', tone: 'gap' });
  }
  if (isOverdue(task, today)) {
    marks.push({ text: task.status === 'done' ? '늦게 완료' : '마감 지남', tone: 'late' });
  }
  return marks;
}

export function taskWarnings(task: Task, today: string): string[] {
  const warnings: string[] = [];

  if (task.assignee_ids.length === 0) {
    warnings.push('담당자가 없습니다 — 완료해도 기여도에 반영되지 않습니다');
  }
  if (isOverdue(task, today)) {
    warnings.push(
      task.status === 'done'
        ? `마감일(${task.deadline})보다 늦게 완료했습니다`
        : `마감일(${task.deadline})이 지났습니다`,
    );
  } else if (isDueSoon(task, today)) {
    const days = daysBetween(today, task.deadline ?? today);
    warnings.push(days === 0 ? '오늘이 마감입니다' : `마감이 ${days}일 남았습니다`);
  }
  return warnings;
}

// ══════════════════════════════════════════════════════════════
// GitHub 연결
//
// docs/08 §5.1 필수 경로의 마지막 눈에 보이는 칸입니다 —
// **관련 PR 병합 → 업무 카드에 수행 근거 표시.**
// ══════════════════════════════════════════════════════════════

/** `team/teamflow#42` 처럼. 번호를 모르면 저장소만. */
export function describePull(link: TaskGithubLink): string {
  const where = link.number === null ? link.repo : `${link.repo}#${link.number}`;
  return link.title ? `${where} ${link.title}` : where;
}

/**
 * 확정된 것을 앞에.
 *
 * ⚠️ 사람은 위에서부터 읽습니다. 추정이 위에 있으면 그게 사실로 보이고,
 * "이 업무는 이 PR 로 끝났다" 를 틀리게 믿습니다.
 */
export function sortLinks(links: readonly TaskGithubLink[]): TaskGithubLink[] {
  return [...links].sort((a, b) => {
    if (a.relevance !== b.relevance) return b.relevance - a.relevance;
    return b.merged_at.localeCompare(a.merged_at);
  });
}

/**
 * 이 업무에 대해 GitHub 쪽에서 할 말 한 줄.
 *
 * ⚠️ **아무것도 안 붙었을 때 침묵하지 않습니다.** 빈 자리는 "PR 이
 * 없구나" 가 아니라 "연결이 안 됐나?" 로도 읽힙니다. 무엇을 적어야
 * 붙는지 알려주는 것이 이 화면이 할 일입니다 — 표식을 안 보여주면
 * 아무도 안 적고, 자동 연결은 영영 안 일어납니다.
 */
export function describeLinkState(task: Task): string {
  const links = task.github ?? [];
  if (links.length === 0) {
    return `연결된 PR이 없습니다 — PR 제목이나 본문에 ${withJosa(task.marker, '을를')} 적으면 붙습니다`;
  }
  const sure = links.filter((link) => link.confirmed).length;
  if (sure === links.length) return `PR ${links.length}건`;
  if (sure === 0) return `PR ${links.length}건 (전부 추정 — 확인 필요)`;
  return `PR ${links.length}건 (확정 ${sure} · 추정 ${links.length - sure})`;
}

export interface BoardSummary {
  total: number;
  done: number;
  overdue: number;
  /** 회의에서 나온 업무 — 이 프로젝트의 주장이 실제로 도는지를 보는 숫자 */
  fromMeetings: number;
  unassigned: number;
  /** PR 이 붙은 업무 — 회의→업무→GitHub 이 끝까지 도는지를 보는 숫자 */
  withPulls: number;
}

/**
 * ⭐ **아직 못 받은 것을 `0` 이라고 말하지 않습니다.**
 *
 * 칸반 머리말은 `회의에서 N · PR 연결 N · 지연 N` 입니다. 그런데 화면은
 * 목록을 `board.data?.tasks ?? []` 로 받고 있었고, 그래서 **불러오는 중에도
 * 못 받았을 때도** 빈 배열이 되어 머리말이 `회의에서 0 · PR 연결 0 ·
 * 지연 0` 이라고 **단언**했습니다.
 *
 * 이 제품의 불변식 셋째가 그것입니다 — **측정 불가 ≠ 0점.** 같은 화면의
 * 사슬(`Chain`)은 "빈 칸을 0 으로 그리지 않습니다" 라고 적어 두고 `—` 를
 * 그리는데, 바로 위 머리말이 반대로 말하고 있었습니다.
 *
 * 그래서 "몇 건인가" 와 "그걸 어떻게 말할 것인가" 를 가릅니다. 아직
 * 모르면 `null` 을 넘기고, 여기서 `—` 를 돌려줍니다.
 */
export function countText(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : String(value);
}

export function summarize(tasks: readonly Task[], today: string): BoardSummary {
  return {
    total: tasks.length,
    done: tasks.filter((t) => t.status === 'done').length,
    overdue: tasks.filter((t) => isOverdue(t, today)).length,
    fromMeetings: tasks.filter((t) => t.origin !== null).length,
    unassigned: tasks.filter((t) => t.assignee_ids.length === 0).length,
    withPulls: tasks.filter((t) => (t.github ?? []).length > 0).length,
  };
}

/**
 * 상태 변경 요청 본문.
 *
 * ⚠️ **`deadline` 키를 넣지 않는다.** 서버는 키가 있으면 "마감일을 바꾼다"
 * 로 읽고, `null` 이면 지웁니다. 상태만 바꾸려는 요청에 `deadline: null` 이
 * 실려 가면 **마감일이 조용히 지워집니다.**
 */
export function statusPatch(status: string): Record<string, string> {
  return { status };
}
