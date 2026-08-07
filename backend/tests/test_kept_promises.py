"""약속을 지켰는가 — **산정 시점에** 판정한다.

`scoring.py` 는 처음부터 약속에 두 값을 갖고 있었습니다.

    UTT_COMMITMENT → 6.0 if meta["fulfilled"] else 1.5

그런데 `fulfilled` 를 **아무도 채우지 않았습니다.** 회의 발화를 기여
이벤트로 만드는 코드가 그 칸을 비워 뒀고, `dict.get` 은 없는 키에
조용히 `None` 을 줍니다. 그래서 약속은 언제나 1.5 였습니다 —
지킨 사람과 안 지킨 사람이 **같은 점수**를 받았습니다.

## 왜 저장이 아니라 계산인가

약속을 지켰는지는 **회의가 끝난 뒤에** 정해집니다. 회의 처리 시점에
판정해서 메타데이터에 얼려 두면 다음 주에 그 일을 끝내도 1.5 에
머뭅니다. 이 파일의 절반은 그 시간 순서를 고정합니다.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from teamflow.contribution.events import EventType
from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.meeting import utterance_types as ut
from teamflow.services import meeting_contribution_service as svc
from teamflow.services import scoring_service

NOW = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)


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
def world(engine) -> dict:
    """프로젝트 + 사람 둘 + 회의 하나."""
    with db_session.session_scope() as s:
        project = m.Project(title="T", started_at=NOW, deadline=NOW + timedelta(days=30))
        s.add(project)
        s.flush()

        minsu = m.User(name="민수", email="minsu@e.com")
        haneul = m.User(name="하늘", email="haneul@e.com")
        s.add_all([minsu, haneul])
        s.flush()
        for user in (minsu, haneul):
            s.add(
                m.Member(
                    project_id=project.id,
                    user_id=user.id,
                    role_shares={"developer": 1.0},
                )
            )

        meeting = m.Meeting(
            project_id=project.id,
            title="정기회의",
            started_at=NOW,
            duration_sec=1800,
            status="needs_review",
            started_by=minsu.id,
        )
        s.add(meeting)
        s.flush()
        for user in (minsu, haneul):
            s.add(
                m.MeetingTrack(
                    meeting_id=meeting.id,
                    user_id=user.id,
                    started_at=NOW,
                    ended_at=NOW + timedelta(minutes=30),
                    status="completed",
                )
            )
        s.flush()
        return {
            "project_id": project.id,
            "meeting_id": meeting.id,
            "minsu": minsu.id,
            "haneul": haneul.id,
        }


def promise(world: dict, speaker_id: int, text: str, at_ms: int = 0) -> int:
    """약속 발화 하나. 분류까지 끝난 상태로 넣는다."""
    with db_session.session_scope() as s:
        row = m.Utterance(
            meeting_id=world["meeting_id"],
            speaker_id=speaker_id,
            start_ms=at_ms,
            end_ms=at_ms + 3000,
            text=text,
            speaker_source="track",
            utterance_type=ut.COMMITMENT,
            type_confidence=0.75,
        )
        s.add(row)
        s.flush()
        return row.id


def task_from(
    world: dict,
    *,
    evidence: list[int],
    assignee_id: int | None,
    status: str = "todo",
) -> int:
    """근거 발화를 인용한 업무 후보 → 승인되어 만들어진 업무."""
    with db_session.session_scope() as s:
        task = m.Task(
            project_id=world["project_id"],
            title="로그인 API",
            assignee_id=assignee_id,
            status=status,
        )
        s.add(task)
        s.flush()
        s.add(
            m.MeetingTaskCandidate(
                meeting_id=world["meeting_id"],
                title="로그인 API",
                confidence=0.9,
                evidence_utterance_ids=evidence,
                review_status="approved",
                created_task_id=task.id,
            )
        )
        s.flush()
        return task.id


def finish(task_id: int) -> None:
    with db_session.session_scope() as s:
        s.get(m.Task, task_id).status = "done"


def record(world: dict) -> None:
    with db_session.session_scope() as s:
        meeting = s.get(m.Meeting, world["meeting_id"])
        svc.record_meeting(s, meeting)


def commitment_points(world: dict, user_id: int) -> list[bool]:
    """그 사람의 약속 이벤트들이 지금 '지킴' 으로 보이는가."""
    with db_session.session_scope() as s:
        by_user = scoring_service.load_events(s, world["project_id"])
    return [
        bool(event.metadata.get("fulfilled"))
        for event in by_user.get(user_id, [])
        if event.event_type is EventType.UTT_COMMITMENT
    ]


# ══════════════════════════════════════════════════════════════
# 기본
# ══════════════════════════════════════════════════════════════


def test_a_promise_alone_is_not_kept(world):
    promise(world, world["minsu"], "제가 로그인 API 맡겠습니다")
    record(world)
    assert commitment_points(world, world["minsu"]) == [False]


def test_a_promise_that_became_a_finished_task_is_kept(world):
    """⭐ 이 프로젝트가 주장하는 사슬 그대로입니다.

    말 → 근거로 인용한 업무 후보 → 승인된 업무 → 완료.
    """
    said = promise(world, world["minsu"], "제가 로그인 API 맡겠습니다")
    task = task_from(world, evidence=[said], assignee_id=world["minsu"])
    record(world)
    assert commitment_points(world, world["minsu"]) == [False]

    finish(task)
    assert commitment_points(world, world["minsu"]) == [True]


def test_the_verdict_is_not_frozen_at_meeting_time(world):
    """⭐ **이게 이 파일의 핵심입니다.**

    회의는 오늘 처리되고 일은 다음 주에 끝납니다. 처리 시점에 판정해서
    메타데이터에 얼려 두면 그 사람은 영원히 1.5 입니다 — 지킨 사람이
    안 지킨 사람과 같아집니다.

    그래서 회의 처리를 **먼저** 끝낸 뒤에 업무를 만들고 완료시킵니다.
    """
    said = promise(world, world["minsu"], "제가 로그인 API 맡겠습니다")
    record(world)  # ← 회의 처리가 먼저 끝난다
    assert commitment_points(world, world["minsu"]) == [False]

    task = task_from(world, evidence=[said], assignee_id=world["minsu"])
    finish(task)  # ← 일은 나중에 끝난다

    assert commitment_points(world, world["minsu"]) == [True]


def test_a_frozen_verdict_in_the_database_does_not_win(world):
    """저장된 `fulfilled` 가 남아 있어도 지금 사실이 이깁니다.

    시연 데이터나 옛 코드가 넣어 둔 값이 그대로 통하면, 위 테스트가
    고정한 것이 조용히 무너집니다.
    """
    promise(world, world["minsu"], "제가 로그인 API 맡겠습니다")
    record(world)

    with db_session.session_scope() as s:
        for row in s.query(m.ContributionEventRow).all():
            if row.event_type == EventType.UTT_COMMITMENT.value:
                row.event_metadata = {**(row.event_metadata or {}), "fulfilled": True}

    # 업무가 없으므로 지킨 것이 아닙니다.
    assert commitment_points(world, world["minsu"]) == [False]


# ══════════════════════════════════════════════════════════════
# 남의 것을 가져오지 못한다
# ══════════════════════════════════════════════════════════════


def test_someone_else_finishing_it_does_not_count(world):
    """⚠️ 민수가 하겠다고 한 일을 하늘이 끝냈으면 민수는 안 지킨 겁니다.

    이걸 안 보면 **말만 하고 남이 하게 두는** 쪽이 가장 이득을 봅니다.
    """
    said = promise(world, world["minsu"], "제가 로그인 API 맡겠습니다")
    task = task_from(world, evidence=[said], assignee_id=world["haneul"])
    finish(task)
    record(world)

    assert commitment_points(world, world["minsu"]) == [False]


def test_when_both_promised_the_one_who_did_it_gets_it(world):
    """⭐ 위 테스트만으로는 **담당자 확인이 정말 필요한지** 안 잡힙니다.

    위 경우는 `(발화, 사람)` 짝으로 찾기 때문에 담당자 확인을 빼도
    민수에게 안 갑니다 — 즉 그 테스트는 **다른 이유로** 통과합니다.
    담당자 확인이 실제로 막는 것은 이 경우입니다.

    둘 다 하겠다고 했고 업무는 하늘이 맡아 끝냈습니다. 담당자 확인이
    없으면 "가장 이른 약속" 고르기가 **민수의 말**을 집어 갑니다.
    민수 것은 하늘의 완료와 짝이 안 맞아 아무에게도 안 가고, 그 사이
    **정작 일을 끝낸 하늘이 1.5** 로 남습니다.

    한 사람의 약속 중에서 이른 것을 고르는 것이지, 아무 약속이나
    이른 것을 고르는 게 아닙니다.
    """
    promise(world, world["minsu"], "제가 할까요, 하겠습니다", at_ms=0)
    hers = promise(world, world["haneul"], "아니요 제가 하겠습니다", at_ms=60_000)

    with db_session.session_scope() as s:
        first = s.query(m.Utterance).order_by(m.Utterance.start_ms).first().id

    task = task_from(
        world, evidence=[first, hers], assignee_id=world["haneul"]
    )
    finish(task)
    record(world)

    assert commitment_points(world, world["haneul"]) == [True]
    assert commitment_points(world, world["minsu"]) == [False]


def test_an_unassigned_finished_task_keeps_nobodys_promise(world):
    """담당자가 없으면 누구의 약속인지 알 수 없습니다."""
    said = promise(world, world["minsu"], "제가 맡겠습니다")
    task = task_from(world, evidence=[said], assignee_id=None)
    finish(task)
    record(world)

    assert commitment_points(world, world["minsu"]) == [False]


def test_another_projects_task_does_not_reach_in(world):
    """⚠️ 업무는 **이 프로젝트의 것**이어야 합니다."""
    said = promise(world, world["minsu"], "제가 맡겠습니다")
    with db_session.session_scope() as s:
        other = m.Project(
            title="남의 팀", started_at=NOW, deadline=NOW + timedelta(days=30)
        )
        s.add(other)
        s.flush()
        task = m.Task(
            project_id=other.id,
            title="로그인 API",
            assignee_id=world["minsu"],
            status="done",
        )
        s.add(task)
        s.flush()
        s.add(
            m.MeetingTaskCandidate(
                meeting_id=world["meeting_id"],
                title="로그인 API",
                confidence=0.9,
                evidence_utterance_ids=[said],
                review_status="approved",
                created_task_id=task.id,
            )
        )
    record(world)

    assert commitment_points(world, world["minsu"]) == [False]


# ══════════════════════════════════════════════════════════════
# 반복이 점수가 되면 안 된다
# ══════════════════════════════════════════════════════════════


def test_saying_it_three_times_only_keeps_one_promise(world):
    """⚠️ **반복이 점수가 되면 안 됩니다.**

    "제가 하겠습니다" 를 세 번 말하면 근거 발화가 셋이 될 수 있습니다.
    그걸 다 인정하면 4.5(=1.5×3) 가 18(=6.0×3) 이 됩니다 — 일은 하나
    끝냈는데 점수는 네 배입니다.

    업무 하나는 약속 하나만 지웁니다. 나머지는 1.5 그대로입니다.
    """
    first = promise(world, world["minsu"], "제가 하겠습니다", at_ms=0)
    second = promise(world, world["minsu"], "제가 하겠습니다", at_ms=60_000)
    third = promise(world, world["minsu"], "제가 하겠습니다", at_ms=120_000)

    task = task_from(
        world, evidence=[first, second, third], assignee_id=world["minsu"]
    )
    finish(task)
    record(world)

    kept = commitment_points(world, world["minsu"])
    assert sorted(kept) == [False, False, True], kept

    # 인정된 것은 **가장 이른** 약속입니다 — 늦게 반복한 쪽이 아니라.
    with db_session.session_scope() as s:
        assert scoring_service.kept_promises(s, world["project_id"]) == {
            (first, world["minsu"])
        }
    assert second != first and third != first


def test_two_finished_tasks_keep_two_promises(world):
    """실제로 둘을 약속하고 둘 다 끝냈으면 둘 다 인정됩니다."""
    login = promise(world, world["minsu"], "로그인은 제가 하겠습니다", at_ms=0)
    schema = promise(world, world["minsu"], "스키마도 제가 하겠습니다", at_ms=60_000)

    finish(task_from(world, evidence=[login], assignee_id=world["minsu"]))
    finish(task_from(world, evidence=[schema], assignee_id=world["minsu"]))
    record(world)

    assert commitment_points(world, world["minsu"]) == [True, True]


# ══════════════════════════════════════════════════════════════
# 근거로 붙었다고 다 약속은 아니다
# ══════════════════════════════════════════════════════════════


def test_a_non_commitment_cited_as_evidence_keeps_nothing(world):
    """결정·질문이 근거로 붙어 있어도 그건 약속을 지킨 근거가 아닙니다."""
    with db_session.session_scope() as s:
        decided = m.Utterance(
            meeting_id=world["meeting_id"],
            speaker_id=world["minsu"],
            start_ms=0,
            end_ms=3000,
            text="로그인부터 하기로 합니다",
            speaker_source="track",
            utterance_type=ut.DECISION,
            type_confidence=0.75,
        )
        s.add(decided)
        s.flush()
        said = decided.id

    finish(task_from(world, evidence=[said], assignee_id=world["minsu"]))
    record(world)

    with db_session.session_scope() as s:
        assert scoring_service.kept_promises(s, world["project_id"]) == set()


def test_a_task_with_no_evidence_keeps_nothing(world):
    """손으로 만든 업무는 회의와 이어져 있지 않습니다."""
    promise(world, world["minsu"], "제가 하겠습니다")
    finish(task_from(world, evidence=[], assignee_id=world["minsu"]))
    record(world)

    assert commitment_points(world, world["minsu"]) == [False]


# ══════════════════════════════════════════════════════════════
# 점수가 실제로 달라지는가
# ══════════════════════════════════════════════════════════════


def test_keeping_the_promise_actually_raises_the_score(world):
    """⭐ 위 전부가 맞아도 **점수가 안 변하면** 아무 의미가 없습니다.

    1.5 → 6.0 이라고 `scoring.py` 에 적혀 있는 것을 여기서 확인합니다.
    """
    from teamflow.contribution.scoring import event_points

    said = promise(world, world["minsu"], "제가 로그인 API 맡겠습니다")
    record(world)

    def only_promise():
        with db_session.session_scope() as s:
            events = scoring_service.load_events(s, world["project_id"])
        return next(
            e
            for e in events[world["minsu"]]
            if e.event_type is EventType.UTT_COMMITMENT
        )

    assert event_points(only_promise()) == pytest.approx(1.5)

    task = task_from(world, evidence=[said], assignee_id=world["minsu"])
    finish(task)

    assert event_points(only_promise()) == pytest.approx(6.0)
