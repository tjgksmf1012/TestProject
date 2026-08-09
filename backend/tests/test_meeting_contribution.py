"""회의 발화가 실제로 기여도가 되는가.

기여도의 **세 다리 중 마지막**입니다 (docs/08 §0).

    칸반 업무 완료 → 기여 이벤트   ✅
    GitHub 활동   → 기여 이벤트   ✅
    회의 발화     → 기여 이벤트   ← 이 파일. 그 전까지 **운영 코드에 0곳**

`scoring.py` 는 가중치를 정확히 알고 있었는데 그 이벤트를 만드는 코드가
없었습니다. 즉 운영에서 회의 기여도는 **언제나 0**이었고, 시연 화면의
숫자는 `seed_demo.py` 가 손으로 넣은 것이었습니다.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.pool import StaticPool

from teamflow.contribution.confidence import compute_confidence
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
    """프로젝트 + 팀원 셋 + 회의 하나 + 각자 트랙."""
    with db_session.session_scope() as s:
        project = m.Project(title="T", started_at=NOW, deadline=NOW + timedelta(days=30))
        s.add(project)
        s.flush()

        users = [m.User(name=f"팀원{i}", email=f"u{i}@e.com") for i in range(3)]
        s.add_all(users)
        s.flush()
        for user in users:
            s.add(
                m.Member(
                    project_id=project.id, user_id=user.id, role_shares={"developer": 1.0}
                )
            )

        meeting = m.Meeting(
            project_id=project.id,
            title="정기회의",
            started_at=NOW,
            duration_sec=1800,
            status="needs_review",
            started_by=users[0].id,
        )
        s.add(meeting)
        s.flush()

        for user in users:
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
            "user_ids": [u.id for u in users],
        }


def say(meeting_id: int, speaker_id: int | None, text: str, at_ms: int = 0) -> int:
    with db_session.session_scope() as s:
        row = m.Utterance(
            meeting_id=meeting_id,
            speaker_id=speaker_id,
            start_ms=at_ms,
            end_ms=at_ms + 3000,
            text=text,
            speaker_source="track" if speaker_id else "diarization",
        )
        s.add(row)
        s.flush()
        return row.id


def run(world: dict) -> dict:
    with db_session.session_scope() as s:
        meeting = s.get(m.Meeting, world["meeting_id"])
        return svc.record_meeting(s, meeting)


def events_of(project_id: int, user_id: int | None = None) -> list[m.ContributionEventRow]:
    with db_session.session_scope() as s:
        query = select(m.ContributionEventRow).where(
            m.ContributionEventRow.project_id == project_id
        )
        if user_id is not None:
            query = query.where(m.ContributionEventRow.user_id == user_id)
        return list(s.scalars(query))


# ══════════════════════════════════════════════════════════════
# 이어지는가
# ══════════════════════════════════════════════════════════════


def test_an_utterance_becomes_a_contribution_event(world):
    """⭐ **기여도 세 다리 중 마지막이 이어지는 지점입니다.**"""
    say(world["meeting_id"], world["user_ids"][0], "그럼 로그인부터 하기로 하죠")

    result = run(world)

    assert result["utterance_events"] == 1
    rows = [e for e in events_of(world["project_id"]) if e.source_kind == "utterance"]
    assert len(rows) == 1
    assert rows[0].event_type == "utt_decision"
    assert rows[0].user_id == world["user_ids"][0]


def test_the_utterance_type_column_is_actually_filled(world):
    """⚠️ 이 컬럼은 스키마에 처음부터 있었지만 **한 번도 채워지지 않았습니다.**"""
    say(world["meeting_id"], world["user_ids"][0], "제가 금요일까지 하겠습니다")

    run(world)

    with db_session.session_scope() as s:
        row = s.scalars(select(m.Utterance)).one()
        assert row.utterance_type == ut.COMMITMENT
        assert row.type_confidence is not None


def _aware(value: datetime) -> datetime:
    """SQLite 는 `DateTime(timezone=True)` 를 naive 로 돌려줍니다.

    PostgreSQL 은 aware 로 돌려주므로 이건 테스트 환경의 차이입니다.
    """
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def test_the_event_time_follows_the_utterance_not_the_meeting_start(world):
    """발언 시각이 전부 회의 시작 시각이면 시간축 분석이 무의미해집니다."""
    say(world["meeting_id"], world["user_ids"][0], "그럼 그렇게 하기로 하죠", at_ms=600_000)

    run(world)

    rows = [e for e in events_of(world["project_id"]) if e.source_kind == "utterance"]
    assert _aware(rows[0].occurred_at) == NOW + timedelta(minutes=10)


def test_the_classifier_is_recorded_on_every_event(world):
    """⭐ 규칙으로 매긴 것과 학습 모델로 매긴 것은 신뢰도가 달라야 합니다."""
    say(world["meeting_id"], world["user_ids"][0], "그럼 그렇게 하기로 하죠")

    run(world)

    rows = [e for e in events_of(world["project_id"]) if e.source_kind == "utterance"]
    assert rows[0].event_metadata["classifier"] == ut.CLASSIFIER_RULES


# ══════════════════════════════════════════════════════════════
# ⭐ 화자를 모르면 아무에게도 주지 않는다
# ══════════════════════════════════════════════════════════════


def test_an_utterance_with_no_speaker_gives_nobody_points(world):
    """⭐ 화자 미상 발언을 아무에게나 붙이면 **측정이 아니라 오답**입니다.

    모드 B 의 `SPEAKER_XX` 는 사람이 이름을 매기기 전까지 주인이 없습니다.
    """
    say(world["meeting_id"], None, "그럼 로그인부터 하기로 하죠")

    result = run(world)

    assert result["utterance_events"] == 0
    assert [e for e in events_of(world["project_id"]) if e.source_kind == "utterance"] == []


def test_the_unowned_utterance_still_keeps_its_label(world):
    """점수는 안 주지만 회의록에서 사라지지도 않습니다 — 나중에 사람이
    화자를 지정하면 그대로 쓸 수 있어야 합니다."""
    say(world["meeting_id"], None, "그럼 로그인부터 하기로 하죠")

    run(world)

    with db_session.session_scope() as s:
        assert s.scalars(select(m.Utterance)).one().utterance_type == ut.DECISION


# ══════════════════════════════════════════════════════════════
# ⭐ 맞장구는 기록하되 점수는 0
# ══════════════════════════════════════════════════════════════


def test_backchannel_is_recorded_so_the_gaming_detector_can_see_it(world):
    """⭐ 안 기록하면 **"네" 만 백 번 한 사람이 탐지를 피해 갑니다.**

    `detect_integrity_flags` 의 `mostly_social_utterances` 가 맞장구 **비율**
    을 봅니다. 분모가 사라지면 그 탐지가 작동하지 않습니다.
    """
    for i in range(3):
        say(world["meeting_id"], world["user_ids"][0], "네", at_ms=i * 1000)

    run(world)

    rows = [e for e in events_of(world["project_id"]) if e.event_type == "utt_social"]
    assert len(rows) == 3


def test_backchannel_never_beats_one_real_decision(world):
    """⭐ **"네" 를 스무 번 한 사람이 결정 하나 내린 사람을 못 이깁니다.**

    맞장구가 0점이 아니면 회의에서 가장 조용히 동조만 한 사람이 기여자로
    나옵니다. docs/05 §2.2 의 핵심 불변식입니다.
    """
    chatter, decider = world["user_ids"][0], world["user_ids"][1]
    for i in range(20):
        say(world["meeting_id"], chatter, "네", at_ms=i * 1000)
    say(world["meeting_id"], decider, "그럼 로그인부터 하기로 하죠", at_ms=90_000)

    run(world)

    with db_session.session_scope() as s:
        result = scoring_service.compute(s, world["project_id"])

    chatter_raw = result.members[chatter].categories["meeting"].raw
    decider_raw = result.members[decider].categories["meeting"].raw
    assert decider_raw > chatter_raw


# ══════════════════════════════════════════════════════════════
# ⭐ 결함 40 — 참석자가 여럿이면 여럿 다 기록돼야 한다
# ══════════════════════════════════════════════════════════════


def test_every_attendee_gets_an_attendance_event(world):
    """⭐ **결함 40.**

    유니크 제약이 `(source_kind, source_id, event_type)` 이라 회의 하나에
    참석 이벤트가 **한 개**만 들어갔습니다. 참석자 셋 중 한 명만 기록되고
    나머지 둘은 IntegrityError 로 조용히 사라졌습니다 — 그리고 그건
    "참석 안 함"(0점)으로 읽힙니다.
    """
    result = run(world)

    assert result["attendance"] == 3
    rows = [e for e in events_of(world["project_id"]) if e.event_type == "meeting_attended"]
    assert {r.user_id for r in rows} == set(world["user_ids"])


def test_attendance_survives_deleted_audio(world):
    """녹음이 보존기간으로 지워져도 참석 기록은 남아야 합니다.

    트랙 행은 남고 오디오 원본만 지워지므로, 참석의 근거를 트랙에 둡니다.
    """
    run(world)
    with db_session.session_scope() as s:
        # 오디오를 지운 상태를 흉내 — 트랙은 그대로
        assert s.query(m.MeetingTrack).count() == 3

    rows = [e for e in events_of(world["project_id"]) if e.event_type == "meeting_attended"]
    assert len(rows) == 3


# ══════════════════════════════════════════════════════════════
# ⭐ 재처리해도 점수가 두 배가 되지 않는다
# ══════════════════════════════════════════════════════════════


def test_reprocessing_does_not_double_the_score(world):
    """⭐ 안 지우면 재처리할 때마다 같은 회의가 한 번씩 더 계산됩니다."""
    say(world["meeting_id"], world["user_ids"][0], "그럼 그렇게 하기로 하죠")
    run(world)
    first = len(events_of(world["project_id"]))

    with db_session.session_scope() as s:
        svc.forget_meeting_events(s, world["meeting_id"])
    run(world)

    assert len(events_of(world["project_id"])) == first


def test_forgetting_removes_both_utterance_and_attendance_events(world):
    say(world["meeting_id"], world["user_ids"][0], "그럼 그렇게 하기로 하죠")
    run(world)
    assert events_of(world["project_id"])

    with db_session.session_scope() as s:
        removed = svc.forget_meeting_events(s, world["meeting_id"])

    assert removed > 0
    assert events_of(world["project_id"]) == []


def test_forgetting_leaves_other_meetings_alone(world):
    """⭐ 한 회의를 재처리하면서 **다른 회의의 기여를 지우면 안 됩니다.**"""
    say(world["meeting_id"], world["user_ids"][0], "그럼 그렇게 하기로 하죠")
    run(world)

    with db_session.session_scope() as s:
        other = m.Meeting(
            project_id=world["project_id"],
            title="다른 회의",
            started_at=NOW + timedelta(days=1),
            status="needs_review",
            started_by=world["user_ids"][0],
        )
        s.add(other)
        s.flush()
        other_id = other.id
        s.add(
            m.MeetingTrack(
                meeting_id=other_id, user_id=world["user_ids"][1], started_at=NOW
            )
        )
        s.flush()
        svc.record_meeting(s, s.get(m.Meeting, other_id))

    before = len(events_of(world["project_id"]))
    with db_session.session_scope() as s:
        svc.forget_meeting_events(s, world["meeting_id"])
    after = len(events_of(world["project_id"]))

    assert after > 0, "다른 회의 것까지 지웠습니다"
    assert after < before


# ══════════════════════════════════════════════════════════════
# 제안이 결정으로 이어졌는가
# ══════════════════════════════════════════════════════════════


def test_a_proposal_followed_by_a_decision_is_marked(world):
    """2.0 → 5.0. 다만 **추정**이라고 적어 둡니다."""
    say(world["meeting_id"], world["user_ids"][0], "로그인부터 할까요?", at_ms=0)
    say(world["meeting_id"], world["user_ids"][1], "그럼 그렇게 하기로 하죠", at_ms=5000)

    run(world)

    rows = [e for e in events_of(world["project_id"]) if e.event_type == "utt_proposal"]
    assert rows[0].event_metadata["led_to_decision"] is True
    assert rows[0].event_metadata["led_to_decision_is_a_guess"] is True


def test_a_proposal_with_no_decision_after_it_is_not_marked(world):
    say(world["meeting_id"], world["user_ids"][0], "로그인부터 할까요?", at_ms=10_000)
    say(world["meeting_id"], world["user_ids"][1], "그럼 그렇게 하기로 하죠", at_ms=1000)

    run(world)

    rows = [e for e in events_of(world["project_id"]) if e.event_type == "utt_proposal"]
    assert rows[0].event_metadata["led_to_decision"] is False


# ══════════════════════════════════════════════════════════════
# ⭐ 신뢰도가 분류 출처를 반영하는가
# ══════════════════════════════════════════════════════════════


def test_a_rule_classified_meeting_has_lower_confidence(world):
    """⭐ 규칙 기준선은 반어·인용·농담을 구분하지 못합니다.

    그 오차가 회의 기여도로 그대로 들어가므로, 학습 모델로 매긴 회의와
    같은 신뢰도로 보이면 안 됩니다.
    """
    say(world["meeting_id"], world["user_ids"][0], "그럼 그렇게 하기로 하죠")
    run(world)

    with db_session.session_scope() as s:
        stats = scoring_service.load_coverage(s, world["project_id"])

    assert stats.utterances_scored == 1
    assert stats.utterances_model_classified == 0
    assert compute_confidence(stats).components["utterance_classification"] == 0.0


def test_peer_review_does_not_penalise_a_team_that_cannot_submit_one(world):
    """⭐ **제출할 화면이 없는 것을 미제출로 세지 않는다** (결함 105).

    `compute_confidence` 의 docstring 은 이렇게 약속합니다 — "데이터가
    아예 없는 신호(분모 0)는 계산에서 제외한다. 예를 들어 동료평가
    모듈을 안 쓰는 팀은 그 항목 때문에 신뢰도가 깎이지 않는다."

    그런데 기대치를 `팀원 수 × (팀원 수 - 1)` 로 무조건 세우고 있었고,
    `PeerReview` 를 만드는 라우트도 화면도 **저장소에 0곳**이라 제출 수는
    영원히 0 이었습니다. 그래서 분모가 0 이 아니게 되고, 신호가 제외되지
    않고 0.0 으로 신뢰도를 깎았습니다.

        다른 신호가 전부 완벽해도   0.9286  (1.0 이 아님)
        사유에 영구히              "동료평가 미제출자가 있습니다"

    사람이 **할 수 없는 일**을 안 했다고 깎는 것이고, 이 저장소가 지키는
    **측정 불가 ≠ 0점** 을 정면으로 어깁니다.
    """
    run(world)

    with db_session.session_scope() as s:
        stats = scoring_service.load_coverage(s, world["project_id"])

    assert stats.peer_reviews_submitted == 0
    assert stats.peer_reviews_expected == 0, (
        "제출할 화면이 없는데 기대치를 세웠습니다 — 못 하는 일을 안 했다고 깎습니다"
    )

    breakdown = compute_confidence(stats)
    assert "peer_completion" not in breakdown.components, (
        "동료평가 신호가 계산에 들어갔습니다 — docstring 이 약속한 제외가 안 됩니다"
    )
    assert not any("동료평가" in r for r in breakdown.reasons), (
        f"할 수 없는 일을 사유로 답니다: {breakdown.reasons}"
    )


def test_zero_score_labels_do_not_drag_the_classification_signal_down(world):
    """⭐ 잡담을 잡담으로 **맞게** 분류한 것이 신뢰도를 깎으면 안 됩니다.

    `social` 은 0점이라 분류가 틀려도 점수가 안 움직입니다.
    """
    for i in range(10):
        say(world["meeting_id"], world["user_ids"][0], "네", at_ms=i * 1000)

    run(world)

    with db_session.session_scope() as s:
        stats = scoring_service.load_coverage(s, world["project_id"])

    assert stats.utterances_scored == 0


def test_a_model_classified_meeting_scores_full_on_that_signal(world):
    """학습 모델이 붙으면 이 신호가 1.0 이 되어야 합니다 — 안 그러면
    모델을 붙여도 신뢰도가 영원히 낮게 남습니다."""

    def fake_model(text: str) -> ut.Classification:
        return ut.Classification(ut.DECISION, 0.95, "모델", ut.CLASSIFIER_MODEL)

    say(world["meeting_id"], world["user_ids"][0], "무엇이든")
    with db_session.session_scope() as s:
        svc.record_meeting(
            s,
            s.get(m.Meeting, world["meeting_id"]),
            classifier=fake_model,
            classifier_name=ut.CLASSIFIER_MODEL,
        )

    with db_session.session_scope() as s:
        stats = scoring_service.load_coverage(s, world["project_id"])

    assert stats.utterances_model_classified == 1
    assert compute_confidence(stats).components["utterance_classification"] == 1.0
