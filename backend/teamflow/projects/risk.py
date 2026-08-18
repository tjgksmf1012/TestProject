"""프로젝트 위험 신호 (요구사항 정의서 §18 · 제안서 §4.5).

제안서가 요구하는 것은 이것입니다.

> **제출 직전이 아니라 진행 중에 문제를 발견한다.**
>
> · 마감 임박 대비 낮은 완료율
> · 특정 팀원에게 과도하게 집중된 업무
> · 최근 활동 감소와 장기 미완료 업무
> · 선행 작업 지연으로 인한 연쇄 병목
> · 근거 기반 재배정 및 일정 조정 제안

## ⚠️ 다섯째("재배정 제안")는 **안 만들었습니다**

"김민수의 업무를 이지연에게 넘기세요" 는 **사람에 대한 판정**입니다. 이
저장소의 불변식 4 가 "시스템은 판정하지 않는다" 이고, 재배정은 그중에서도
제일 무거운 판정입니다 — 누가 못 하고 있다는 말이 되니까요.

여기서는 **사실만** 냅니다. "이 사람에게 미완료가 여섯, 나머지는 하나씩"
까지가 시스템의 몫이고, 그래서 어떻게 할지는 팀이 정합니다.

## ⚠️ 업무 편중은 **기여도가 아닙니다**

편중 신호는 사람별 숫자를 냅니다. 그래서 리더보드로 오해되기 제일 쉬운
자리인데, 재는 것이 완전히 다릅니다.

    기여도 — 이 사람이 무엇을 **했는가**   (근거·신뢰도가 붙습니다)
    부하   — 이 사람에게 무엇이 **쌓였는가** (아직 안 한 것을 셉니다)

업무를 많이 맡은 것이 기여가 많은 것이 아니고, 적게 맡은 것이 게으른
것도 아닙니다. 그래서 여기 값은 **점수에 안 들어가고**, 목록은
**이름 순**이며, 정렬은 하지 않습니다.

⚠️ 그리고 **아무도 안 맡은 업무**를 따로 셉니다. 담당자 없는 일을 빼고
세면 "다들 한가하다" 로 보이는데, 실제로는 **아무도 안 하고 있는** 것이
제일 위험합니다.

## ⚠️ 여기 있는 것은 전부 **관찰**입니다

`meeting/inefficiency.py` 와 같은 규칙입니다 — 등급을 안 매기고, 왜
그렇게 봤는지 숫자를 같이 내고, 화면은 빨강을 안 씁니다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

# ══════════════════════════════════════════════════════════════
# 입력 — **DB 를 모릅니다**
# ══════════════════════════════════════════════════════════════


@dataclass(frozen=True, slots=True)
class TaskFacts:
    """업무 한 줄에서 위험을 보는 데 필요한 것만."""

    id: int
    title: str
    status: str
    #: 맡은 사람들. 비어 있으면 담당자가 없는 업무입니다 (`TASK-006`).
    #:
    #: ⚠️ **맨 앞이 주담당이 아닙니다.** 이름 순으로 옵니다. 여기서
    #: `[0]` 을 집어 "대표 담당자" 로 쓰는 코드가 생기면 그건 없는 개념을
    #: 만드는 것입니다.
    assignee_ids: tuple[int, ...]
    deadline: date | None
    created_at: date
    completed_at: date | None = None


@dataclass(frozen=True, slots=True)
class Member:
    user_id: int
    name: str


@dataclass(frozen=True, slots=True)
class Signal:
    """찾아낸 신호 하나.

    ⚠️ **등급이 없습니다.** `meeting_events` 와 같은 이유입니다 — 규칙으로
    센 값에 빨강·노랑을 붙이면 그건 팀에 대한 판정이 됩니다.
    """

    kind: str
    #: 화면이 그릴 숫자들. ⚠️ **문장을 여기서 안 만듭니다** — 말은 화면이
    #: 합니다(`lib/analytics/view.ts`). 서버가 문장을 만들면 같은 판단이
    #: 두 벌이 되고, 한글 문구를 고치려고 서버를 배포해야 합니다.
    detail: dict
    #: 눌러서 볼 업무들. ⚠️ 없으면 `[]` — **가리킬 것이 없으면 신호를
    #: 내지 않습니다** (대표 실패 ③).
    task_ids: list[int] = field(default_factory=list)


# ══════════════════════════════════════════════════════════════
# ANALYTICS-001 진행률
# ══════════════════════════════════════════════════════════════

#: 끝난 것으로 세는 상태. ⚠️ `review` 는 여기 **없습니다**.
#: `db/vocab.py` 의 `TASK_FINISHED` 와 같은 판단인데, 이 모듈은 DB 를
#: 모르게 두려고 문자열로 받습니다 — 갈라지지 않게 아래 검사가 잽니다.
FINISHED = frozenset({"done"})


@dataclass(frozen=True, slots=True)
class Progress:
    total: int
    finished: int
    #: 끝나지 않은 것 중 **마감이 지난** 것.
    overdue: int

    @property
    def ratio(self) -> float | None:
        """0.0~1.0. ⚠️ 업무가 없으면 `None` — **0% 가 아닙니다.**

        업무가 하나도 없는 프로젝트는 "0% 진행" 이 아니라 **아직 잴 수
        없는** 것입니다. 0을 돌려주면 화면이 "시작도 안 했다" 로 그리고,
        그건 이 저장소가 제일 하면 안 된다고 정한 것입니다
        (측정 불가 ≠ 0점).
        """
        if self.total == 0:
            return None
        return self.finished / self.total


def progress(tasks: list[TaskFacts], *, today: date) -> Progress:
    """ANALYTICS-001 — 얼마나 왔는가.

    ⚠️ `review` 를 완료로 세지 않습니다. 검토 중인 일을 완료로 세면
    진행률이 실제보다 높게 나오고, 그 숫자로 "우리 팀은 80% 했다" 를
    말하게 됩니다.
    """
    finished = [t for t in tasks if t.status in FINISHED]
    late = [
        t
        for t in tasks
        if t.status not in FINISHED and t.deadline is not None and t.deadline < today
    ]
    return Progress(total=len(tasks), finished=len(finished), overdue=len(late))


# ══════════════════════════════════════════════════════════════
# 마감 임박 대비 낮은 완료율
# ══════════════════════════════════════════════════════════════

#: 기간의 이만큼이 지났으면 "임박" 으로 봅니다.
LATE_STAGE = 0.7

#: 지난 기간보다 완료율이 이만큼 뒤처지면 신호를 냅니다.
BEHIND_BY = 0.2


def find_behind_schedule(
    tasks: list[TaskFacts],
    *,
    today: date,
    started_at: date | None,
    deadline: date | None,
) -> Signal | None:
    """기간은 많이 갔는데 완료율이 그만큼 안 따라온 것.

    ⚠️ **기간을 모르면 신호를 안 냅니다.** 시작일이나 마감일이 없으면
    "얼마나 왔는지" 를 잴 기준이 없고, 없는 기준으로 재면 그건 추측입니다.

    ⚠️ 완료율이 기간보다 조금 뒤처지는 것은 **정상**입니다. 일은 대개
    뒤에 몰립니다. 그래서 `BEHIND_BY` 만큼 벌어졌을 때만 봅니다.
    """
    if started_at is None or deadline is None or deadline <= started_at:
        return None

    whole = (deadline - started_at).days
    gone = (today - started_at).days
    if whole <= 0 or gone <= 0:
        return None

    elapsed = min(1.0, gone / whole)
    if elapsed < LATE_STAGE:
        return None

    done = progress(tasks, today=today)
    ratio = done.ratio
    if ratio is None or elapsed - ratio < BEHIND_BY:
        return None

    return Signal(
        kind="behind_schedule",
        detail={
            "elapsed": round(elapsed, 3),
            "finished_ratio": round(ratio, 3),
            "days_left": max(0, (deadline - today).days),
            "unfinished": done.total - done.finished,
        },
        task_ids=[t.id for t in tasks if t.status not in FINISHED],
    )


# ══════════════════════════════════════════════════════════════
# 업무 편중
# ══════════════════════════════════════════════════════════════

#: 이보다 적으면 편중을 말하지 않습니다. 셋 중 둘이 한 사람이라고
#: "편중" 이라 부르면 작은 팀은 언제나 걸립니다.
SKEW_MIN_TASKS = 5

#: 한 사람이 미완료의 이만큼을 들고 있으면 신호.
SKEW_SHARE = 0.5


@dataclass(frozen=True, slots=True)
class Load:
    """사람별 **미완료** 업무 수. ⚠️ 기여도가 아닙니다."""

    user_id: int | None
    name: str
    open_tasks: int


def load_by_person(tasks: list[TaskFacts], members: list[Member]) -> list[Load]:
    """누구에게 무엇이 쌓여 있는가.

    ⚠️ **이름 순입니다. 건수 순으로 정렬하지 않습니다.**

    정렬은 곧 순위입니다. 리더보드를 안 그려도 목록이 건수 순이면 사람은
    맨 위를 "제일 많이 하는 사람" 으로 읽고, 매주 자리가 바뀌면
    "지난주보다 내가 내려갔다" 를 읽습니다 (`lib/contribution/view.ts`
    가 같은 이유로 이름 순을 지킵니다).

    ⚠️ **담당자 없는 업무를 빼지 않습니다.** 빼고 세면 "다들 한가하다" 로
    보이는데, 아무도 안 맡은 일이 제일 위험합니다. `user_id=None` 으로
    맨 뒤에 둡니다.
    """
    open_tasks = [t for t in tasks if t.status not in FINISHED]
    counted: dict[int | None, int] = {}
    for task in open_tasks:
        # ⚠️ 여럿이 맡은 업무는 **각자에게 한 건씩** 셉니다 (`TASK-006`).
        #    나눠서 0.5 건으로 세면 안 됩니다 — 이건 점수가 아니라 "지금
        #    무엇이 내 앞에 있는가" 이고, 같이 맡은 일도 내 앞에 있습니다.
        for user_id in task.assignee_ids or (None,):
            counted[user_id] = counted.get(user_id, 0) + 1

    known = {m.user_id: m.name for m in members}
    rows = [
        Load(user_id=m.user_id, name=m.name, open_tasks=counted.get(m.user_id, 0))
        for m in sorted(members, key=lambda m: m.name)
    ]

    # 명단에 없는 담당자(나간 사람)도 빠뜨리지 않습니다.
    for user_id, count in sorted(counted.items(), key=lambda kv: (kv[0] is None, kv[0])):
        if user_id is not None and user_id not in known:
            rows.append(Load(user_id=user_id, name="(명단에 없는 사람)", open_tasks=count))

    if counted.get(None):
        rows.append(Load(user_id=None, name="담당자 없음", open_tasks=counted[None]))
    return rows


def find_workload_skew(tasks: list[TaskFacts], members: list[Member]) -> Signal | None:
    """한 사람에게 몰려 있는가.

    ⚠️ **누가 적게 하는지는 안 봅니다.** 이 신호는 **과부하를 막으려는
    것**이지 게으름을 찾는 것이 아닙니다. 적게 맡은 사람을 지목하면 그건
    곧 저성과자 표시가 되고, 이 제품이 절대 되면 안 되는 물건이 됩니다.
    """
    open_tasks = [t for t in tasks if t.status not in FINISHED]
    if len(open_tasks) < SKEW_MIN_TASKS:
        return None

    counted: dict[int, int] = {}
    for task in open_tasks:
        for user_id in task.assignee_ids:
            counted[user_id] = counted.get(user_id, 0) + 1
    if not counted:
        return None

    user_id, most = max(counted.items(), key=lambda kv: (kv[1], -kv[0]))
    if most / len(open_tasks) < SKEW_SHARE:
        return None

    names = {m.user_id: m.name for m in members}
    return Signal(
        kind="workload_skew",
        detail={
            "user_id": user_id,
            "name": names.get(user_id, "(명단에 없는 사람)"),
            "open_tasks": most,
            "team_open_tasks": len(open_tasks),
        },
        task_ids=[t.id for t in open_tasks if user_id in t.assignee_ids],
    )


# ══════════════════════════════════════════════════════════════
# 장기 미완료
# ══════════════════════════════════════════════════════════════

#: 이만큼 열려 있으면 오래된 것으로 봅니다.
STALE_DAYS = 21


def find_stale_tasks(tasks: list[TaskFacts], *, today: date) -> Signal | None:
    """오래 열려 있는 업무.

    ⚠️ **마감이 지난 것과 다릅니다.** 마감이 없는 업무도 오래 열려 있을
    수 있고, 그건 대개 **아무도 안 보고 있다**는 뜻입니다.
    """
    old = [
        t
        for t in tasks
        if t.status not in FINISHED and (today - t.created_at).days >= STALE_DAYS
    ]
    if not old:
        return None
    oldest = max((today - t.created_at).days for t in old)
    return Signal(
        kind="stale_tasks",
        detail={"count": len(old), "oldest_days": oldest, "threshold_days": STALE_DAYS},
        task_ids=[t.id for t in old],
    )


# ══════════════════════════════════════════════════════════════
# 활동 감소
# ══════════════════════════════════════════════════════════════

#: 앞뒤로 비교할 창 길이.
WINDOW_DAYS = 7

#: 최근이 그 앞의 이만큼 아래로 떨어지면 신호.
QUIET_RATIO = 0.5

#: 그 앞 창에 이만큼은 있어야 "줄었다" 고 말할 수 있습니다.
QUIET_MIN_BEFORE = 3


def find_activity_drop(
    activity_days: list[date], *, today: date, window: int = WINDOW_DAYS
) -> Signal | None:
    """최근 활동이 그 앞보다 눈에 띄게 줄었는가.

    `activity_days` 는 **활동이 있었던 날짜들**입니다(중복 포함) — 업무
    완료·GitHub·회의 무엇이든.

    ⚠️ **앞 창이 비어 있으면 신호를 안 냅니다.** 이제 막 시작한
    프로젝트는 "활동이 줄었다" 가 아니라 **비교할 것이 없는** 것입니다.
    0으로 나눠서 100% 감소라고 말하면 그건 지어낸 숫자입니다.
    """
    recent_from = today - timedelta(days=window)
    before_from = today - timedelta(days=window * 2)

    recent = sum(1 for d in activity_days if recent_from < d <= today)
    before = sum(1 for d in activity_days if before_from < d <= recent_from)

    if before < QUIET_MIN_BEFORE:
        return None
    if recent / before > QUIET_RATIO:
        return None

    return Signal(
        kind="activity_drop",
        detail={"recent": recent, "before": before, "window_days": window},
    )


# ══════════════════════════════════════════════════════════════
# 의존성 병목
# ══════════════════════════════════════════════════════════════


def find_blocked_by_late(
    tasks: list[TaskFacts],
    edges: list[tuple[int, int]],
    *,
    today: date,
) -> Signal | None:
    """선행 작업이 늦어 뒤가 막혀 있는가.

    `edges` 는 `(선행, 후행)` 입니다.

    ⚠️ **선행이 그냥 안 끝난 것으로는 부족합니다.** 계획대로 진행 중인
    일도 아직 안 끝나 있습니다. **마감이 지났는데도 안 끝난** 선행만
    봅니다 — 그때부터가 뒤를 실제로 붙잡고 있는 것입니다.
    """
    by_id = {t.id: t for t in tasks}
    late_predecessors = {
        t.id
        for t in tasks
        if t.status not in FINISHED and t.deadline is not None and t.deadline < today
    }
    if not late_predecessors:
        return None

    blocked: dict[int, list[int]] = {}
    for predecessor, successor in edges:
        if predecessor not in late_predecessors:
            continue
        follower = by_id.get(successor)
        if follower is None or follower.status in FINISHED:
            continue
        blocked.setdefault(predecessor, []).append(successor)

    if not blocked:
        return None

    return Signal(
        kind="blocked_by_late",
        detail={
            "late_predecessors": len(blocked),
            "blocked_tasks": sum(len(v) for v in blocked.values()),
        },
        # ⚠️ 늦은 선행을 **앞에** 둡니다. 화면이 앞에서부터 보여 주므로,
        #    막힌 것보다 막고 있는 것을 먼저 보게 됩니다.
        task_ids=sorted(blocked) + sorted({s for v in blocked.values() for s in v}),
    )


# ══════════════════════════════════════════════════════════════
# 모아서
# ══════════════════════════════════════════════════════════════

#: 화면에 늘어놓을 순서. ⚠️ **심각도 순이 아닙니다** — 등급을 안 매기니
#: 심각도가 없고, 있는 척하면 그게 곧 판정입니다.
SIGNAL_ORDER: tuple[str, ...] = (
    "behind_schedule",
    "blocked_by_late",
    "stale_tasks",
    "workload_skew",
    "activity_drop",
)


def all_signals(
    tasks: list[TaskFacts],
    members: list[Member],
    edges: list[tuple[int, int]],
    activity_days: list[date],
    *,
    today: date,
    started_at: date | None,
    deadline: date | None,
) -> list[Signal]:
    """신호를 다 모아 **고정 순서**로."""
    found = [
        find_behind_schedule(
            tasks, today=today, started_at=started_at, deadline=deadline
        ),
        find_blocked_by_late(tasks, edges, today=today),
        find_stale_tasks(tasks, today=today),
        find_workload_skew(tasks, members),
        find_activity_drop(activity_days, today=today),
    ]
    rank = {kind: i for i, kind in enumerate(SIGNAL_ORDER)}
    return sorted(
        (s for s in found if s is not None), key=lambda s: rank.get(s.kind, len(rank))
    )


def as_date(value: datetime | date | None) -> date | None:
    """`datetime` 도 `date` 도 받는다. ⚠️ `None` 은 `None` 그대로."""
    if value is None:
        return None
    return value.date() if isinstance(value, datetime) else value
