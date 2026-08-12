
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
  assignee_id: number | null;
  status: string;
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
export function taskWarnings(task: Task, today: string): string[] {
  const warnings: string[] = [];

  if (task.assignee_id === null) {
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

export function summarize(tasks: readonly Task[], today: string): BoardSummary {
  return {
    total: tasks.length,
    done: tasks.filter((t) => t.status === 'done').length,
    overdue: tasks.filter((t) => isOverdue(t, today)).length,
    fromMeetings: tasks.filter((t) => t.origin !== null).length,
    unassigned: tasks.filter((t) => t.assignee_id === null).length,
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
