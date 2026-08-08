
import { withJosa } from '../text/josa.ts';
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

export const STATUS_LABEL: Record<string, string> = {
  todo: '할 일',
  in_progress: '진행 중',
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
 * UTC **순간**을 보고 있는 사람의 달력 날짜로.
 *
 * ⚠️ 서버는 `completed_at` 을 UTC 순간으로 주고 `deadline` 은 시각 성분이
 * 없는 **달력 날짜**로 줍니다. 앞 10자를 잘라 쓰면 UTC 달력일이 나오는데,
 * 한국(UTC+9)에서는 그게 사람이 보는 날짜와 다릅니다.
 *
 *     완료 2026-09-04T14:00:00Z → UTC 09-04 · KST 09-04 23:00  (같다)
 *     완료 2026-09-04T16:00:00Z → UTC 09-04 · KST **09-05** 01:00  (다르다)
 *
 * 두 번째 줄이 문제입니다. 마감이 9월 4일인 업무를 한국 시각 9월 5일
 * 새벽에 끝냈는데 "제때" 로 읽힙니다. 오차가 한쪽으로만 납니다 — UTC
 * 날짜는 KST 날짜보다 같거나 하루 이르므로 **지연을 과소보고만 합니다.**
 * 늦은 것이 제때로 보이지, 그 반대는 없습니다.
 *
 * 미완료 업무는 이미 로컬 자정 기준(`todayIso()`)과 비교하고 있었으므로,
 * 한 모듈 안에서 기준이 둘로 갈라져 있기도 했습니다. 바로 아래
 * `daysBetween` 에 "한쪽만 로컬로 만들면 한국에서 하루가 어긋난다" 는
 * 주석이 붙어 있는데, 정작 `isOverdue` 가 그 실수를 하고 있었습니다.
 */
export function localDateOf(instant: string): string | null {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return null;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * 이 업무가 지금 늦었는가.
 *
 * 완료된 업무는 **완료 시점** 기준으로 판단합니다. 오늘 날짜로 보면
 * 지난달에 제때 끝낸 업무가 시간이 갈수록 "지연" 으로 바뀝니다.
 *
 * 완료 시각은 UTC 순간이라 **보는 사람의 달력으로 옮긴 뒤** 비교합니다.
 * 마감일은 달력 날짜라 옮길 것이 없습니다.
 */
export function isOverdue(task: Task, today: string): boolean {
  if (task.deadline === null) return false;
  if (task.status === 'done') {
    if (!task.completed_at) return false;
    const completedOn = localDateOf(task.completed_at);
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
