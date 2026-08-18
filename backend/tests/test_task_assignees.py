"""담당자가 여럿일 때 (`TASK-006`).

이 파일이 고정하는 것은 화면이 아니라 **기여도 배분**입니다.

    업무 1건 · 담당자 1명  →  팀 합계 10점
    업무 1건 · 담당자 5명  →  팀 합계 10점   ← 이것을 지킵니다

안 지키면 드롭다운에서 이름을 고르는 것이 곧 점수 부풀리기가 됩니다.
`docs/05` §2 의 "이벤트 개수에 비례하는 보상은 무엇이든 개수 늘리기로
뚫린다" 와 같은 부류이고, 이번 것이 더 쌉니다 — 커밋을 쪼갤 필요도
없습니다.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.pool import StaticPool

from teamflow.contribution import sharing
from teamflow.contribution.events import Category, EventType
from teamflow.contribution.scoring import event_points, score_team
from teamflow.db import assignees
from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.services import scoring_service, task_service

# ⚠️ 픽스처(`full_coverage`·`dev_profiles`)는 **가져오지 않습니다.** pytest 가
#    `conftest.py` 에서 이름으로 찾습니다. 가져오면 같은 이름이 두 번
#    정의된 꼴이라 ruff 가 F811 로 잡고, 그 그물은 켜 두는 것이 맞습니다 —
#    검사 함수 이름이 겹치면 뒤엣것이 앞엣것을 조용히 덮어씁니다.
from .conftest import task_done

NOW = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)


# ══════════════════════════════════════════════════════════════
# 1. 몫을 나누는 규칙 — 순수 함수
# ══════════════════════════════════════════════════════════════


def test_one_person_gets_the_whole_thing():
    assert sharing.split_share(1) == 1.0


def test_two_people_split_it():
    assert sharing.split_share(2) == 0.5


@pytest.mark.parametrize("n", range(1, 21))
def test_the_shares_always_add_up_to_one(n: int):
    """⭐ **이 파일에서 제일 중요한 검사입니다.**

    사람이 몇이든 업무 하나가 만드는 총량은 1 입니다. 이게 깨지는 순간
    담당자를 얹는 것이 점수를 만드는 방법이 됩니다.
    """
    total = sum(sharing.split_share(n) for _ in range(n))
    assert math.isclose(total, sharing.TASK_TOTAL, rel_tol=1e-9)


def test_a_nonsense_count_does_not_punish_anyone():
    """0 이나 음수는 있을 수 없는 값입니다. **깎는 쪽으로 틀리지 않습니다.**"""
    assert sharing.split_share(0) == 1.0
    assert sharing.split_share(-3) == 1.0


# ══════════════════════════════════════════════════════════════
# 2. 점수로 이어지는가 — 조작 저항성
# ══════════════════════════════════════════════════════════════


@pytest.mark.parametrize("n", [1, 2, 3, 5, 8])
def test_the_points_one_task_makes_never_grow_with_headcount(n: int):
    """⭐ **이 파일의 핵심.** 업무 하나가 만드는 완료 점수의 합은 일정합니다.

    담당자를 몇 명 얹든 `10 × 난이도` 그대로입니다. 이게 깨지면 칸반
    드롭다운이 점수 발행기가 됩니다.
    """
    share = sharing.split_share(n)
    total = sum(
        event_points(_with_share(task_done(uid, tid=7), share))
        for uid in range(1, n + 1)
    )
    assert math.isclose(total, event_points(task_done(1, tid=7)), rel_tol=1e-9)


def test_piling_people_onto_your_own_task_costs_you(full_coverage, dev_profiles):
    """⚠️ 반대 방향도 봅니다 — **얹은 사람 본인이 손해**여야 합니다.

    총합만 지키고 개인 몫을 안 보면, 총합은 그대로인데 특정한 사람에게
    몰아주는 배분이 통과할 수 있습니다.
    """
    alone = event_points(task_done(1, tid=7))
    with_others = event_points(_with_share(task_done(1, tid=7), sharing.split_share(4)))
    assert with_others < alone


def test_the_per_person_ceiling_is_the_only_thing_that_moves(
    full_coverage, dev_profiles
):
    """⚠️ **남는 오차를 숨기지 않습니다.**

    카테고리 천장(`_apply_ceiling`)은 사람마다 따로 걸립니다. 그래서
    한 사람의 10점을 다섯이 2점씩 나눠 가지면, 천장을 지난 팀 합계는
    똑같지 않고 아주 조금 큽니다 — 곡선이 오목해서 작은 값이 덜 깎이기
    때문입니다.

    이걸 없애려면 천장을 팀 단위로 걸어야 하는데, 그러면 남이 많이 한
    것이 내 점수를 깎습니다. 그쪽이 훨씬 나쁩니다. **차이가 작다는 것을
    검사로 못 박아 두고** 넘어갑니다.
    """
    profiles = {uid: dev_profiles[1] for uid in range(1, 6)}
    share = sharing.split_share(5)
    shared = {uid: [_with_share(task_done(uid, tid=7), share)] for uid in range(1, 6)}

    spread = _task_points(shared, profiles, full_coverage)
    alone = _task_points({1: [task_done(1, tid=7)]}, {1: dev_profiles[1]}, full_coverage)
    assert 1.0 <= spread / alone < 1.05


def _task_points(events_by_user: dict, profiles, coverage) -> float:
    """팀 전체의 업무 카테고리 raw 합."""
    result = score_team(events_by_user, profiles, coverage)
    return sum(
        member.categories[Category.TASK].raw
        for member in result.members.values()
        if Category.TASK in member.categories
    )


def _with_share(event, share: float):
    """`scoring_service` 가 읽을 때 붙여 주는 값을 손으로 흉내 냅니다."""
    return type(event)(
        user_id=event.user_id,
        event_type=event.event_type,
        occurred_at=event.occurred_at,
        source_kind=event.source_kind,
        source_id=event.source_id,
        magnitude=event.magnitude,
        metadata={**event.metadata, "share": share},
    )


# ══════════════════════════════════════════════════════════════
# 3. DB — 몫은 **저장하지 않고** 읽을 때 셉니다
# ══════════════════════════════════════════════════════════════


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    m.Base.metadata.create_all(eng)
    db_session.configure(eng)
    yield eng
    m.Base.metadata.drop_all(eng)
    eng.dispose()


@pytest.fixture
def team(engine) -> dict:
    """프로젝트 하나 + 사람 셋."""
    with db_session.session_scope() as s:
        project = m.Project(title="T", started_at=NOW, deadline=NOW + timedelta(days=30))
        s.add(project)
        s.flush()

        people = [
            m.User(name=name, email=f"{i}@e.com")
            for i, name in enumerate(("김민수", "이하늘", "박지원"))
        ]
        s.add_all(people)
        s.flush()
        for person in people:
            s.add(
                m.Member(
                    project_id=project.id,
                    user_id=person.id,
                    role_shares={"developer": 1.0},
                    project_role="owner" if person is people[0] else "member",
                )
            )
        return {
            "project_id": project.id,
            "people": [p.id for p in people],
        }


def _task(team: dict, *, deadline_in: int | None = None) -> int:
    """`deadline_in` 은 **지금**으로부터의 날짜 수입니다.

    ⚠️ `NOW`(2026-09-01) 기준으로 잡으면 안 됩니다 — `change_task` 는
    완료 시각을 진짜 시계에서 읽으므로, 고정 상수로 잡은 "지난 마감" 이
    실제로는 미래가 되어 검사가 조용히 반대를 잽니다.
    """
    with db_session.session_scope() as s:
        task = m.Task(
            project_id=team["project_id"],
            title="접근성 점검",
            status="todo",
            deadline=(
                datetime.now(UTC) + timedelta(days=deadline_in)
                if deadline_in is not None
                else None
            ),
        )
        s.add(task)
        s.flush()
        return task.id


def _finish(team: dict, task_id: int, *, actor: int, at: datetime = NOW) -> None:
    with db_session.session_scope() as s:
        task_service.change_task(
            session=s,
            project_id=team["project_id"],
            task_id=task_id,
            actor_id=actor,
            status="done",
        )
        s.get(m.Task, task_id).completed_at = at


def _shares(team: dict, task_id: int) -> dict[int, float]:
    with db_session.session_scope() as s:
        by_user = scoring_service.load_events(s, team["project_id"])
    return {
        uid: event.metadata["share"]
        for uid, events in by_user.items()
        for event in events
        if event.event_type is EventType.TASK_COMPLETED and event.source_id == task_id
    }


def test_two_assignees_each_get_half(team: dict):
    task_id = _task(team)
    with db_session.session_scope() as s:
        assignees.replace(s, task_id, team["people"][:2])
    _finish(team, task_id, actor=team["people"][0])

    assert _shares(team, task_id) == {
        team["people"][0]: 0.5,
        team["people"][1]: 0.5,
    }


def test_taking_someone_off_afterwards_does_not_inflate_the_rest(team: dict):
    """⭐ **이것이 담당자 수로 나누면 안 되는 이유입니다.**

    셋이 맡고 완료한 뒤 둘을 빼면, 담당자 수로 나눌 경우 남은 한 명의
    몫이 1.0 이 되고 빠진 둘의 이벤트는 그대로 남아 총량이 3.0 이 됩니다.
    **빼는 것이 점수를 올리는 통로**가 됩니다.
    """
    task_id = _task(team)
    with db_session.session_scope() as s:
        assignees.replace(s, task_id, team["people"])
    _finish(team, task_id, actor=team["people"][0])

    with db_session.session_scope() as s:
        assignees.replace(s, task_id, team["people"][:1])

    shares = _shares(team, task_id)
    assert len(shares) == 3
    assert math.isclose(sum(shares.values()), 1.0, rel_tol=1e-9)


def test_the_share_is_not_stored_on_the_row(team: dict):
    """⚠️ 얼려 두면 담당자가 나중에 늘어도 먼저 있던 사람의 몫이 안 줄어듭니다."""
    task_id = _task(team)
    with db_session.session_scope() as s:
        assignees.replace(s, task_id, team["people"][:1])
    _finish(team, task_id, actor=team["people"][0])

    with db_session.session_scope() as s:
        rows = s.scalars(
            select(m.ContributionEventRow).where(
                m.ContributionEventRow.event_type == EventType.TASK_COMPLETED.value
            )
        ).all()
        assert rows
        assert all("share" not in (row.event_metadata or {}) for row in rows)


def test_an_unassigned_task_makes_no_event(team: dict):
    """담당자가 없으면 그 완료는 아무에게도 안 갑니다."""
    task_id = _task(team)
    _finish(team, task_id, actor=team["people"][0])
    assert _shares(team, task_id) == {}


# ══════════════════════════════════════════════════════════════
# 4. 마감 준수는 **안 나눕니다** — 그리고 다시 판정하지 않습니다
# ══════════════════════════════════════════════════════════════


def _verdicts(team: dict, task_id: int) -> dict[int, str]:
    with db_session.session_scope() as s:
        rows = s.execute(
            select(m.ContributionEventRow.user_id, m.ContributionEventRow.event_type)
            .where(
                m.ContributionEventRow.source_id == task_id,
                m.ContributionEventRow.event_type.in_(
                    ("deadline_met", "deadline_missed")
                ),
            )
        ).all()
    return {user_id: event_type for user_id, event_type in rows}


def test_both_assignees_get_the_same_verdict(team: dict):
    """⚠️ 여부는 나눌 것이 없습니다. 둘이 맡은 마감은 둘 다의 마감입니다."""
    task_id = _task(team, deadline_in=5)
    with db_session.session_scope() as s:
        assignees.replace(s, task_id, team["people"][:2])
    _finish(team, task_id, actor=team["people"][0])

    assert _verdicts(team, task_id) == {
        team["people"][0]: "deadline_met",
        team["people"][1]: "deadline_met",
    }


def test_adding_someone_later_reuses_the_first_verdict(team: dict):
    """⭐ **사람별로 판정하면 조작 통로가 다시 열립니다.**

    마감을 지나 늦게 끝낸 업무에 사람을 하나 더 얹고, 마감일을 미래로
    옮긴 뒤 다시 완료하면 — 사람별로 판정할 경우 새 담당자만 `met` 을
    받습니다. 판정은 업무의 사실이지 사람의 사실이 아닙니다.
    """
    task_id = _task(team, deadline_in=-3)  # 이미 지난 마감
    with db_session.session_scope() as s:
        assignees.replace(s, task_id, team["people"][:1])
    _finish(team, task_id, actor=team["people"][0])
    assert _verdicts(team, task_id) == {team["people"][0]: "deadline_missed"}

    # 되돌리고, 마감을 미래로 밀고, 사람을 하나 더 얹고, 다시 완료.
    with db_session.session_scope() as s:
        task_service.change_task(
            session=s,
            project_id=team["project_id"],
            task_id=task_id,
            actor_id=team["people"][0],
            status="todo",
        )
        s.get(m.Task, task_id).deadline = datetime.now(UTC) + timedelta(days=30)
        assignees.replace(s, task_id, team["people"][:2])
    _finish(team, task_id, actor=team["people"][0])

    assert _verdicts(team, task_id) == {
        team["people"][0]: "deadline_missed",
        team["people"][1]: "deadline_missed",
    }


def test_a_task_first_finished_without_a_deadline_is_never_judged(team: dict):
    """마감일 없이 완료한 뒤 마감일을 넣어도 **없던 met 이 생기지 않습니다.**"""
    task_id = _task(team)
    with db_session.session_scope() as s:
        assignees.replace(s, task_id, team["people"][:1])
    _finish(team, task_id, actor=team["people"][0])

    with db_session.session_scope() as s:
        task_service.change_task(
            session=s,
            project_id=team["project_id"],
            task_id=task_id,
            actor_id=team["people"][0],
            status="todo",
        )
        s.get(m.Task, task_id).deadline = datetime.now(UTC) + timedelta(days=30)
        assignees.replace(s, task_id, team["people"][:2])
    _finish(team, task_id, actor=team["people"][0])

    assert _verdicts(team, task_id) == {}


# ══════════════════════════════════════════════════════════════
# 5. 읽는 순서 — 이름 순이지 넣은 순서가 아닙니다
# ══════════════════════════════════════════════════════════════


def test_the_list_comes_back_by_name(team: dict):
    """⚠️ 넣은 순서로 주면 화면이 맨 앞을 **주담당**으로 그립니다."""
    task_id = _task(team)
    minsu, haneul, jiwon = team["people"]  # 김민수 · 이하늘 · 박지원
    with db_session.session_scope() as s:
        # 일부러 이름 순과 다르게 넣습니다.
        assignees.replace(s, task_id, [jiwon, minsu, haneul])
        assert assignees.of_task(s, task_id) == [minsu, jiwon, haneul]


def test_the_same_person_twice_is_one_person():
    assert assignees.normalize([3, 1, 3, 1]) == [3, 1]
