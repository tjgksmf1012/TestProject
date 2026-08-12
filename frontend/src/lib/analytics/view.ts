/**
 * 프로젝트 상태를 사람 말로 (요구사항 정의서 §18 · 제안서 §4.5).
 *
 * ## ⚠️ 여기서 **줄을 세우지 않습니다**
 *
 * 사람별 부하 목록이 있고, 그건 리더보드로 오해되기 제일 쉬운 자리입니다.
 * 그래서 `lib/contribution/view.ts` 와 같은 규칙을 씁니다.
 *
 * 1. **정렬하지 않습니다.** 서버가 이름 순으로 내려보내고 화면은 그대로
 *    씁니다. 건수 순이면 맨 위가 "제일 많이 하는 사람" 으로 읽히고,
 *    매주 자리가 바뀌면 "지난주보다 내가 내려갔다" 를 읽습니다.
 * 2. **막대를 안 그립니다.** 값을 같은 축 위에 늘어놓으면 그게 곧
 *    순위표입니다 — 이 저장소가 두 번 어긴 규칙입니다.
 * 3. **부하는 기여가 아닙니다.** 화면이 그렇게 말해야 합니다. 안 그러면
 *    사람은 이 숫자를 성적으로 읽습니다.
 *
 * ## ⚠️ 말은 여기서 만듭니다
 *
 * 서버는 숫자만 보냅니다. 문장을 서버가 만들면 같은 판단이 두 벌이 되고,
 * 한글 문구 하나를 고치려고 서버를 배포해야 합니다.
 */

export interface Progress {
  total: number;
  finished: number;
  overdue: number;
  /** ⚠️ 업무가 없으면 `null` 입니다 — **0 이 아닙니다.** */
  ratio: number | null;
}

export interface Load {
  /** 담당자 없는 업무는 `null`. */
  user_id: number | null;
  name: string;
  open_tasks: number;
}

export interface RiskSignal {
  kind: string;
  detail: Record<string, unknown>;
  task_ids: number[];
}

export interface Analytics {
  progress: Progress;
  load: Load[];
  signals: RiskSignal[];
}

/**
 * 진행률을 글자로.
 *
 * ⚠️ **업무가 없으면 `0%` 라고 쓰지 않습니다.** 그건 "시작도 안 했다" 로
 * 읽히는데, 실제로는 **아직 잴 수 없는** 것입니다 (측정 불가 ≠ 0점).
 */
export function progressText(progress: Progress): string {
  if (progress.ratio === null) {
    return '아직 업무가 없어 진행률을 잴 수 없습니다';
  }
  return `${progress.finished} / ${progress.total} 완료 (${Math.round(progress.ratio * 100)}%)`;
}

/**
 * 마감이 지난 것에 대해 할 말. 없으면 `null`.
 *
 * ⚠️ **"지연" 이라고만 쓰지 않습니다.** 몇 건인지 없으면 사람은 얼마나
 * 급한지 모른 채 불안하기만 합니다.
 */
export function overdueText(progress: Progress): string | null {
  if (progress.overdue <= 0) return null;
  return `마감이 지난 업무 ${progress.overdue}건`;
}

/**
 * ⚠️ `review` 는 완료가 아닙니다 — 서버가 그렇게 세고, 화면은 그 사실을
 * **말해야** 합니다. 안 적으면 "검토 중인데 왜 진행률에 안 들어가지" 가
 * 됩니다.
 */
export const PROGRESS_NOTE = '검토 중인 업무는 완료로 세지 않습니다.';

/** 부하 목록 옆에 반드시 붙는 말. */
export const LOAD_NOTE =
  '지금 맡고 있는 미완료 업무 수입니다. **기여도가 아닙니다** — 많이 맡은 것이 많이 한 것은 아닙니다.';

const TITLE: Record<string, string> = {
  behind_schedule: '기간 대비 완료가 적습니다',
  blocked_by_late: '앞선 업무가 뒤를 막고 있습니다',
  stale_tasks: '오래 열려 있는 업무가 있습니다',
  workload_skew: '한 사람에게 몰려 있습니다',
  activity_drop: '최근 활동이 줄었습니다',
};

/** 화면 순서. ⚠️ **심각도 순이 아닙니다** — 등급을 안 매기니 심각도가 없습니다. */
export const SIGNAL_ORDER: readonly string[] = [
  'behind_schedule',
  'blocked_by_late',
  'stale_tasks',
  'workload_skew',
  'activity_drop',
];

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 왜 이렇게 봤는가 — **숫자를 그대로** 보여 줍니다.
 *
 * ⚠️ 못 만들면 `null` 입니다. "알 수 없는 이유" 라고 적는 것은 아무 말도
 * 안 하는 것보다 나쁩니다.
 */
export function reasonText(signal: RiskSignal): string | null {
  const d = signal.detail ?? {};

  if (signal.kind === 'behind_schedule') {
    const elapsed = num(d.elapsed);
    const done = num(d.finished_ratio);
    const left = num(d.days_left);
    if (elapsed === null || done === null) return null;
    const days = left === null ? '' : ` · 남은 기간 ${left}일`;
    return `기간 ${Math.round(elapsed * 100)}% 지남 · 완료 ${Math.round(done * 100)}%${days}`;
  }

  if (signal.kind === 'blocked_by_late') {
    const blocked = num(d.blocked_tasks);
    const late = num(d.late_predecessors);
    if (blocked === null || late === null) return null;
    return `마감이 지난 선행 ${late}건이 ${blocked}건을 막고 있습니다`;
  }

  if (signal.kind === 'stale_tasks') {
    const count = num(d.count);
    const oldest = num(d.oldest_days);
    if (count === null) return null;
    const how = oldest === null ? '' : ` · 가장 오래된 것은 ${oldest}일째`;
    return `${count}건${how}`;
  }

  if (signal.kind === 'workload_skew') {
    const name = typeof d.name === 'string' ? d.name : null;
    const mine = num(d.open_tasks);
    const team = num(d.team_open_tasks);
    if (name === null || mine === null || team === null) return null;
    // ⚠️ **"과부하" 라고 쓰지 않습니다.** 그건 판정입니다. 숫자만 놓습니다.
    return `${name} 님이 팀의 미완료 ${team}건 중 ${mine}건을 맡고 있습니다`;
  }

  if (signal.kind === 'activity_drop') {
    const recent = num(d.recent);
    const before = num(d.before);
    const days = num(d.window_days);
    if (recent === null || before === null || days === null) return null;
    return `최근 ${days}일 ${recent}건 · 그 앞 ${days}일 ${before}건`;
  }

  return null;
}

export interface SignalView {
  kind: string;
  /** 모르는 종류면 코드를 그대로 씁니다. */
  title: string;
  /** 왜 그렇게 봤는가. 못 만들면 `null`. */
  reason: string | null;
  taskIds: number[];
}

export function signalView(signal: RiskSignal): SignalView {
  return {
    kind: signal.kind,
    title: TITLE[signal.kind] ?? signal.kind,
    reason: reasonText(signal),
    taskIds: [...(signal.task_ids ?? [])],
  };
}

/**
 * 그릴 순서대로.
 *
 * ⚠️ **모르는 종류를 버리지 않습니다.** 버리면 신호를 하나 더 붙였을 때
 * 화면이 조용히 아무것도 안 보여 줍니다 — 오류가 안 나서 안 보이는
 * 부류이고, 이 저장소가 여러 번 당한 자리입니다.
 */
export function signalViews(signals: readonly RiskSignal[]): SignalView[] {
  const rank = (kind: string): number => {
    const at = SIGNAL_ORDER.indexOf(kind);
    return at === -1 ? SIGNAL_ORDER.length : at;
  };
  return [...signals].sort((a, b) => rank(a.kind) - rank(b.kind)).map(signalView);
}

/**
 * 신호가 하나도 없을 때 할 말.
 *
 * ⚠️ **"문제 없습니다" 라고 쓰지 않습니다.** 규칙이 못 본 것일 수도 있고,
 * 그렇게 단정하면 사람이 확인을 멈춥니다.
 */
export const NOTHING_FOUND = '규칙에 걸린 것이 없습니다 — 규칙이 못 보는 것도 있습니다.';

/** 화면 맨 위에 반드시 붙는 말. */
export const RULES_NOTE = '규칙으로 센 것이라 틀릴 수 있습니다. 근거를 눌러 직접 보세요.';

/**
 * 근거로 든 업무를 **볼 수 있는 자리**.
 *
 * ⚠️ 이게 없으면 `RULES_NOTE` 가 거짓말이 됩니다. 처음 렌더했을 때
 * "근거를 눌러 직접 보세요" 라고 적어 놓고 업무 번호는 그냥 글자였습니다
 * — 이 저장소가 세 번째로 당한 실패(할 일을 알려 주고 그 일을 할 자리를
 * 안 줌)와 **똑같은 모양**이고, 눈으로 렌더를 보기 전에는 안 보였습니다.
 *
 * ⚠️ `project` 를 같이 넘깁니다. 없으면 칸반이 기본값 1번 프로젝트를
 * 열어서, 남의 프로젝트에서 없는 업무를 찾게 됩니다 (`nav/links.ts` 가
 * 같은 이유로 id 없는 링크를 아예 안 만듭니다).
 */
export function taskHref(projectId: number, taskId: number): string {
  return `/kanban.html?project=${projectId}&task=${taskId}`;
}

/** 한 신호에 근거를 몇 개까지 늘어놓는가. */
export const SRC_LIMIT = 8;

export interface SrcView {
  shown: number[];
  /** 잘라 낸 개수. 0 이면 다 보여 준 것. */
  more: number;
}

/**
 * 근거 업무를 몇 개만 늘어놓되 **자른 것을 숨기지 않습니다.**
 *
 * ⚠️ 처음엔 그냥 `slice(0, 8)` 이었습니다. 근거가 열둘인 신호가 여덟만
 * 보여 주면서 아무 말도 안 했고, 화면은 "이게 전부" 로 읽혔습니다.
 * 조용히 자르는 것은 잘못 세는 것과 같습니다 — 사람이 틀린 줄도 모릅니다.
 */
export function srcView(taskIds: readonly number[]): SrcView {
  return {
    shown: taskIds.slice(0, SRC_LIMIT),
    more: Math.max(0, taskIds.length - SRC_LIMIT),
  };
}
