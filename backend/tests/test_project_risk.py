"""프로젝트 위험 신호 (정의서 §18 · 제안서 §4.5).

⚠️ 여기서 제일 중요한 것은 **이게 사람에 대한 판정이 되지 않는 것**입니다.
업무 편중은 사람별 숫자를 내므로 리더보드로 오해되기 제일 쉬운 자리이고,
그래서 "누가 적게 하는지" 는 절대 안 봅니다.
"""

from __future__ import annotations

from datetime import date, datetime

from teamflow.db import vocab
from teamflow.projects import risk

TODAY = date(2026, 9, 1)


def task(
    tid: int,
    *,
    status: str = "todo",
    assignee: int | None = 1,
    deadline: date | None = None,
    created: date = date(2026, 8, 25),
) -> risk.TaskFacts:
    return risk.TaskFacts(
        id=tid,
        title=f"업무 {tid}",
        status=status,
        assignee_id=assignee,
        deadline=deadline,
        created_at=created,
    )


MEMBERS = [
    risk.Member(user_id=1, name="김민수"),
    risk.Member(user_id=2, name="이지연"),
    risk.Member(user_id=3, name="박철수"),
]


# ══════════════════════════════════════════════════════════════
# ANALYTICS-001 진행률
# ══════════════════════════════════════════════════════════════


def test_progress_counts_what_is_finished():
    done = risk.progress(
        [task(1, status="done"), task(2), task(3)],
        today=TODAY,
    )
    assert done.total == 3
    assert done.finished == 1
    assert done.ratio == 1 / 3


def test_review_is_not_finished():
    """⭐ 검토 중인 일을 완료로 세면 진행률이 실제보다 높게 나옵니다."""
    done = risk.progress([task(1, status="review")], today=TODAY)
    assert done.finished == 0


def test_the_finished_set_matches_the_database_vocabulary():
    """⚠️ 이 모듈은 DB 를 모르게 두려고 상태를 **문자열로** 받습니다.

    그러면 두 벌이 되고, 두 벌은 갈라집니다 (대표 실패 ②). 갈라지는
    순간 여기서 터지게 둡니다.
    """
    assert {str(s) for s in vocab.TASK_FINISHED} == risk.FINISHED


def test_a_project_with_no_tasks_has_no_progress_not_zero():
    """⭐ **0% 가 아니라 잴 수 없는 것**입니다 (측정 불가 ≠ 0점).

    0을 돌려주면 화면이 "시작도 안 했다" 로 그립니다.
    """
    assert risk.progress([], today=TODAY).ratio is None


def test_overdue_counts_only_what_is_still_open():
    done = risk.progress(
        [
            task(1, status="done", deadline=date(2026, 8, 1)),
            task(2, deadline=date(2026, 8, 1)),
            task(3, deadline=date(2026, 12, 1)),
        ],
        today=TODAY,
    )
    assert done.overdue == 1


# ══════════════════════════════════════════════════════════════
# 마감 임박 대비 낮은 완료율
# ══════════════════════════════════════════════════════════════


def test_being_late_in_the_schedule_with_little_done_is_a_signal():
    found = risk.find_behind_schedule(
        [task(i) for i in range(1, 11)],
        today=TODAY,
        started_at=date(2026, 8, 1),
        deadline=date(2026, 9, 8),
    )
    assert found is not None
    assert found.kind == "behind_schedule"
    assert found.detail["unfinished"] == 10


def test_early_in_the_schedule_is_quiet():
    """⚠️ 일은 대개 뒤에 몰립니다. 초반에 낮은 것은 정상입니다."""
    assert (
        risk.find_behind_schedule(
            [task(i) for i in range(1, 11)],
            today=date(2026, 8, 5),
            started_at=date(2026, 8, 1),
            deadline=date(2026, 12, 1),
        )
        is None
    )


def test_without_a_schedule_we_do_not_guess():
    """⭐ 기준이 없으면 **재지 않습니다.** 없는 기준으로 재면 추측입니다."""
    tasks = [task(i) for i in range(1, 11)]
    assert risk.find_behind_schedule(tasks, today=TODAY, started_at=None, deadline=None) is None
    assert (
        risk.find_behind_schedule(
            tasks, today=TODAY, started_at=date(2026, 8, 1), deadline=None
        )
        is None
    )


def test_keeping_up_is_quiet():
    tasks = [task(i, status="done") for i in range(1, 9)] + [task(9), task(10)]
    assert (
        risk.find_behind_schedule(
            tasks, today=TODAY, started_at=date(2026, 8, 1), deadline=date(2026, 9, 8)
        )
        is None
    )


# ══════════════════════════════════════════════════════════════
# 업무 편중 — ⚠️ 제일 조심하는 자리
# ══════════════════════════════════════════════════════════════


def skewed() -> list[risk.TaskFacts]:
    return [task(i, assignee=1) for i in range(1, 6)] + [
        task(6, assignee=2),
        task(7, assignee=3),
    ]


def test_work_piling_on_one_person_is_a_signal():
    found = risk.find_workload_skew(skewed(), MEMBERS)
    assert found is not None
    assert found.detail["name"] == "김민수"
    assert found.detail["open_tasks"] == 5


def test_a_small_pile_is_not_a_skew():
    """⚠️ 셋 중 둘이 한 사람이라고 편중이라 부르면 작은 팀은 늘 걸립니다."""
    assert risk.find_workload_skew([task(1), task(2), task(3)], MEMBERS) is None


def test_an_even_team_is_quiet():
    even = [task(1, assignee=1), task(2, assignee=2), task(3, assignee=3)] * 2
    assert risk.find_workload_skew(even, MEMBERS) is None


def test_finished_work_does_not_count_as_load():
    """⭐ 부하는 **아직 안 한 것**입니다. 끝낸 것을 세면 그건 기여도 흉내입니다."""
    piled = [task(i, assignee=1, status="done") for i in range(1, 6)] + [
        task(6, assignee=2),
        task(7, assignee=3),
    ]
    assert risk.find_workload_skew(piled, MEMBERS) is None


def test_the_skew_signal_never_names_who_does_least():
    """⭐ **누가 적게 하는지는 안 봅니다.**

    적게 맡은 사람을 지목하면 그건 곧 저성과자 표시가 되고, 이 제품이
    절대 되면 안 되는 물건이 됩니다.
    """
    found = risk.find_workload_skew(skewed(), MEMBERS)
    assert found is not None
    flat = repr(found.detail)
    for quiet in ("이지연", "박철수"):
        assert quiet not in flat, f"적게 맡은 사람이 실렸습니다: {quiet}"


# ══════════════════════════════════════════════════════════════
# 사람별 부하 — ⚠️ 목록의 순서
# ══════════════════════════════════════════════════════════════


def test_the_load_list_is_by_name_not_by_count():
    """⭐ **정렬은 곧 순위입니다.**

    리더보드를 안 그려도 목록이 건수 순이면 사람은 맨 위를 "제일 많이
    하는 사람" 으로 읽고, 매주 자리가 바뀌면 "지난주보다 내가 내려갔다"
    를 읽습니다.
    """
    rows = risk.load_by_person(skewed(), MEMBERS)
    assert [r.name for r in rows] == ["김민수", "박철수", "이지연"]


def test_someone_with_nothing_open_still_appears():
    """⚠️ 빼면 "저 사람은 왜 없지" 가 되고, 없는 것이 0보다 나쁘게 읽힙니다."""
    rows = risk.load_by_person([task(1, assignee=1)], MEMBERS)
    assert {r.name: r.open_tasks for r in rows}["박철수"] == 0


def test_work_nobody_owns_is_counted_separately():
    """⭐ 담당자 없는 일을 빼고 세면 **"다들 한가하다"** 로 보입니다.

    실제로는 아무도 안 하고 있는 것이 제일 위험합니다.
    """
    rows = risk.load_by_person(
        [task(1, assignee=1), task(2, assignee=None), task(3, assignee=None)], MEMBERS
    )
    assert rows[-1].name == "담당자 없음"
    assert rows[-1].open_tasks == 2
    assert rows[-1].user_id is None


def test_someone_who_left_is_not_dropped():
    """명단에 없는 담당자의 업무가 조용히 사라지면 합이 안 맞습니다."""
    rows = risk.load_by_person([task(1, assignee=99)], MEMBERS)
    assert sum(r.open_tasks for r in rows) == 1


# ══════════════════════════════════════════════════════════════
# 장기 미완료
# ══════════════════════════════════════════════════════════════


def test_a_task_open_for_weeks_is_a_signal():
    found = risk.find_stale_tasks(
        [task(1, created=date(2026, 7, 1)), task(2)], today=TODAY
    )
    assert found is not None
    assert found.detail["count"] == 1
    assert found.task_ids == [1]


def test_a_finished_old_task_is_not_stale():
    assert (
        risk.find_stale_tasks(
            [task(1, status="done", created=date(2026, 7, 1))], today=TODAY
        )
        is None
    )


def test_a_fresh_backlog_is_quiet():
    assert risk.find_stale_tasks([task(1), task(2)], today=TODAY) is None


# ══════════════════════════════════════════════════════════════
# 활동 감소
# ══════════════════════════════════════════════════════════════


def test_a_quiet_week_after_a_busy_one_is_a_signal():
    days = [date(2026, 8, 20)] * 10 + [date(2026, 8, 30)]
    found = risk.find_activity_drop(days, today=TODAY)
    assert found is not None
    assert found.detail["before"] == 10
    assert found.detail["recent"] == 1


def test_a_project_with_no_history_says_nothing():
    """⭐ 이제 막 시작한 프로젝트는 "줄었다" 가 아니라 **비교할 것이 없는** 것입니다.

    0으로 나눠 100% 감소라고 말하면 그건 지어낸 숫자입니다.
    """
    assert risk.find_activity_drop([date(2026, 8, 30)], today=TODAY) is None
    assert risk.find_activity_drop([], today=TODAY) is None


def test_a_steady_project_is_quiet():
    days = [date(2026, 8, 20)] * 5 + [date(2026, 8, 30)] * 5
    assert risk.find_activity_drop(days, today=TODAY) is None


# ══════════════════════════════════════════════════════════════
# 의존성 병목
# ══════════════════════════════════════════════════════════════


def test_a_late_predecessor_blocking_others_is_a_signal():
    tasks = [
        task(1, deadline=date(2026, 8, 1)),
        task(2),
        task(3),
    ]
    found = risk.find_blocked_by_late(tasks, [(1, 2), (1, 3)], today=TODAY)
    assert found is not None
    assert found.detail["blocked_tasks"] == 2
    # ⚠️ 막고 있는 것이 앞에 옵니다.
    assert found.task_ids[0] == 1


def test_a_predecessor_that_is_merely_unfinished_is_not_a_bottleneck():
    """⚠️ 계획대로 진행 중인 일도 아직 안 끝나 있습니다."""
    tasks = [task(1, deadline=date(2026, 12, 1)), task(2)]
    assert risk.find_blocked_by_late(tasks, [(1, 2)], today=TODAY) is None


def test_a_late_task_blocking_nothing_is_not_a_bottleneck():
    tasks = [task(1, deadline=date(2026, 8, 1))]
    assert risk.find_blocked_by_late(tasks, [], today=TODAY) is None


def test_a_finished_successor_is_not_blocked():
    tasks = [task(1, deadline=date(2026, 8, 1)), task(2, status="done")]
    assert risk.find_blocked_by_late(tasks, [(1, 2)], today=TODAY) is None


# ══════════════════════════════════════════════════════════════
# 다섯이 다 지켜야 하는 것
# ══════════════════════════════════════════════════════════════


def every_signal() -> list[risk.Signal]:
    tasks = [task(i, assignee=1, created=date(2026, 7, 1)) for i in range(1, 6)] + [
        task(6, assignee=2, deadline=date(2026, 8, 1)),
        task(7, assignee=3),
    ]
    return risk.all_signals(
        tasks,
        MEMBERS,
        [(6, 7)],
        [date(2026, 8, 20)] * 10,
        today=TODAY,
        started_at=date(2026, 8, 1),
        deadline=date(2026, 9, 8),
    )


def test_all_five_can_fire_at_once():
    kinds = {s.kind for s in every_signal()}
    assert kinds == set(risk.SIGNAL_ORDER), f"안 나온 신호: {set(risk.SIGNAL_ORDER) - kinds}"


def test_the_order_is_fixed_not_by_severity():
    """⭐ 등급을 안 매기니 **심각도가 없습니다.** 있는 척하면 그게 곧 판정입니다."""
    kinds = [s.kind for s in every_signal()]
    assert kinds == sorted(kinds, key=risk.SIGNAL_ORDER.index)


def test_no_signal_carries_a_severity():
    """⭐ 규칙으로 센 값에 빨강·노랑을 붙이면 팀에 대한 판정이 됩니다."""
    for signal in every_signal():
        assert not hasattr(signal, "severity")
        for word in ("severity", "level", "심각", "위험도"):
            assert word not in repr(signal.detail), f"{signal.kind}: {word}"


def test_no_signal_makes_a_suggestion_about_a_person():
    """⭐ **재배정 제안을 안 만듭니다** (제안서 §4.5 다섯째).

    "김민수의 업무를 이지연에게 넘기세요" 는 사람에 대한 판정이고,
    그중에서도 제일 무거운 것입니다 — 누가 못 하고 있다는 말이 되니까요.
    사실만 내고 어떻게 할지는 팀이 정합니다.
    """
    for signal in every_signal():
        flat = repr(signal.detail)
        for verdict in ("재배정", "제안", "권장", "해야", "넘기"):
            assert verdict not in flat, f"{signal.kind}: {verdict}"


def test_signals_that_point_at_tasks_carry_the_ids():
    """⭐ 가리킬 것이 없으면 확인할 수가 없습니다 (대표 실패 ③).

    ⚠️ 활동 감소만 예외입니다 — 그건 **없는 것**에 대한 신호라
    가리킬 업무가 없습니다. 그 사실을 여기 적어 둡니다.
    """
    for signal in every_signal():
        if signal.kind == "activity_drop":
            assert signal.task_ids == []
            continue
        assert signal.task_ids, f"{signal.kind}: 가리키는 업무가 없습니다"


def test_the_module_never_builds_a_korean_sentence():
    """⭐ **말은 화면이 합니다.**

    서버가 문장을 만들면 같은 판단이 두 벌이 되고, 한글 문구 하나를
    고치려고 서버를 배포해야 합니다. 여기서는 숫자만 냅니다.

    ⚠️ 사람 이름은 예외입니다 — 그건 문장이 아니라 값입니다.
    """
    for signal in every_signal():
        for key, value in signal.detail.items():
            if key == "name":
                continue
            assert not isinstance(value, str), f"{signal.kind}.{key} 가 문장입니다: {value}"


def test_dates_and_datetimes_both_work():
    assert risk.as_date(datetime(2026, 9, 1, 10, 0)) == date(2026, 9, 1)
    assert risk.as_date(date(2026, 9, 1)) == date(2026, 9, 1)
    assert risk.as_date(None) is None
