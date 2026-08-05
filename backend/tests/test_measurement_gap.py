"""측정 불가 처리 테스트.

**0점과 "모른다"는 다르다.**

폰이 잠겨 녹음이 끊긴 사람을 "말을 안 한 사람"으로 처리하면 그건 측정이
아니라 오답이다. 그리고 그 오답은 기여도 점수가 되어 팀 갈등이 된다
(docs/04 §2.6, docs/05 §5).

이 파일은 그 구분이 실제로 점수에 반영되는지 검증한다.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from teamflow.contribution.confidence import CoverageStats, compute_confidence
from teamflow.contribution.events import Category, ContributionEvent, EventType, SourceKind
from teamflow.contribution.profiles import DEFAULT_PROFILES, Role
from teamflow.contribution.scoring import MeasurementGap, score_team

OCCURRED = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)


def event(
    source_id: int, user_id: int, event_type: EventType, magnitude: float = 1.0
) -> ContributionEvent:
    is_utterance = event_type.value.startswith("utt_")
    return ContributionEvent(
        user_id=user_id,
        event_type=event_type,
        occurred_at=OCCURRED,
        source_kind=SourceKind.UTTERANCE if is_utterance else SourceKind.GITHUB_EVENT,
        source_id=source_id,
        magnitude=magnitude,
    )


def code_and_meeting(user_id: int, *, base: int, utterances: int) -> list[ContributionEvent]:
    """코드 활동은 동일, 회의 발언만 다르게."""
    events = [
        event(base + i, user_id, EventType.PR_MERGED, magnitude=200.0) for i in range(3)
    ]
    events += [
        event(base + 100 + i, user_id, EventType.UTT_PROPOSAL) for i in range(utterances)
    ]
    return events


PROFILES = {
    1: DEFAULT_PROFILES[Role.DEVELOPER],
    2: DEFAULT_PROFILES[Role.DEVELOPER],
}
FULL_COVERAGE = CoverageStats(
    meetings_total=4,
    meetings_recorded=4,
    utterances_total=20,
    utterances_speaker_certain=20,
    tracks_total=8,
    tracks_usable=8,
    project_days=90,
    github_connected_days=90,
)


# ══════════════════════════════════════════════════════════════
# 신뢰도 신호
# ══════════════════════════════════════════════════════════════


def test_broken_tracks_lower_project_confidence():
    """⭐ 이 신호가 없으면 망가진 녹음이 오히려 높은 신뢰도로 보인다.

    멀티트랙에서는 트랙이 곧 사람이라 화자 확정도가 항상 1.0 이다.
    40%만 녹음된 회의도 "화자가 전부 확정됨"으로 잡힌다.
    """
    healthy = compute_confidence(FULL_COVERAGE)
    broken = compute_confidence(
        CoverageStats(
            **{**vars_of(FULL_COVERAGE), "tracks_usable": 4}  # 절반이 못 쓰게 됨
        )
    )

    assert broken.value < healthy.value
    assert any("녹음이 끊긴" in r for r in broken.reasons)


def vars_of(stats: CoverageStats) -> dict:
    return {f: getattr(stats, f) for f in CoverageStats.__slots__}


def test_track_quality_is_ignored_when_there_are_no_tracks():
    """단일 마이크(모드 B) 팀은 이 항목으로 감점되면 안 된다."""
    single_mic = CoverageStats(
        **{**vars_of(FULL_COVERAGE), "tracks_total": 0, "tracks_usable": 0}
    )
    result = compute_confidence(single_mic)

    assert "track_quality" not in result.components
    assert result.value == pytest.approx(compute_confidence(FULL_COVERAGE).value)


def test_track_quality_is_weighted_like_speaker_certainty():
    """둘 다 기여도로 직접 전파되는 오류라 무게가 같아야 한다."""
    lost_speakers = compute_confidence(
        CoverageStats(**{**vars_of(FULL_COVERAGE), "utterances_speaker_certain": 10})
    )
    lost_tracks = compute_confidence(
        CoverageStats(**{**vars_of(FULL_COVERAGE), "tracks_usable": 4})
    )
    assert lost_speakers.value == pytest.approx(lost_tracks.value)


# ══════════════════════════════════════════════════════════════
# 점수 계산에서의 제외
# ══════════════════════════════════════════════════════════════


def test_silent_member_scores_lower_than_talkative_one():
    """전제 확인 — 정상 상태에서는 발언량이 점수에 영향을 준다."""
    events = {
        1: code_and_meeting(1, base=0, utterances=10),
        2: code_and_meeting(2, base=1000, utterances=0),
    }
    result = score_team(events, PROFILES, FULL_COVERAGE)

    assert result.members[1].share > result.members[2].share


def test_unmeasurable_member_is_not_treated_as_silent():
    """⭐ 핵심.

    두 사람의 코드 활동은 동일하다. 한 명은 회의에서 활발했고, 다른 한 명은
    폰이 잠겨 녹음이 끊겼다. 후자를 "발언 0" 으로 처리하면 점수가 깎인다.
    측정 불가로 처리하면 남은 활동으로만 비교된다.
    """
    events = {
        1: code_and_meeting(1, base=0, utterances=10),
        2: code_and_meeting(2, base=1000, utterances=0),  # 녹음이 끊겨 발언 기록 없음
    }
    gaps = {
        2: [
            MeasurementGap(
                category=Category.MEETING,
                reason="녹음 2건 중 2건이 끊겼습니다",
                detail={"tracks_total": 2, "tracks_usable": 0},
            )
        ]
    }

    penalised = score_team(events, PROFILES, FULL_COVERAGE)
    fair = score_team(events, PROFILES, FULL_COVERAGE, unmeasurable=gaps)

    assert fair.members[2].share > penalised.members[2].share, (
        "측정 불가를 0점으로 처리하면 안 된다"
    )
    # 코드 활동이 같으므로 회의를 빼면 거의 대등해져야 한다
    assert fair.members[2].share == pytest.approx(fair.members[1].share, abs=12.0)


def test_measurement_gap_is_reported_on_the_member():
    """조용히 보정하지 않는다. 왜 그렇게 계산했는지 화면에 남긴다."""
    events = {
        1: code_and_meeting(1, base=0, utterances=5),
        2: code_and_meeting(2, base=1000, utterances=0),
    }
    gaps = {
        2: [
            MeasurementGap(
                category=Category.MEETING,
                reason="녹음 2건 중 2건이 끊겼습니다",
                detail={"tracks_total": 2, "tracks_usable": 0},
            )
        ]
    }
    result = score_team(events, PROFILES, FULL_COVERAGE, unmeasurable=gaps)

    assert result.members[1].measurement_gaps == []
    assert len(result.members[2].measurement_gaps) == 1
    assert result.members[2].measurement_gaps[0].category is Category.MEETING
    assert "끊겼습니다" in result.members[2].measurement_gaps[0].reason


def test_excluded_category_does_not_appear_in_the_breakdown():
    """측정 못 한 영역을 0으로 표시하면 그것도 거짓말이다."""
    events = {
        1: code_and_meeting(1, base=0, utterances=5),
        2: code_and_meeting(2, base=1000, utterances=0),
    }
    gaps = {2: [MeasurementGap(category=Category.MEETING, reason="끊김")]}
    result = score_team(events, PROFILES, FULL_COVERAGE, unmeasurable=gaps)

    assert Category.MEETING in result.members[1].categories
    assert Category.MEETING not in result.members[2].categories


def test_weights_are_renormalised_over_measurable_categories():
    """제외한 영역의 가중치는 나머지로 재분배된다 — 합은 여전히 1이다."""
    events = {
        1: code_and_meeting(1, base=0, utterances=5),
        2: code_and_meeting(2, base=1000, utterances=0),
    }
    gaps = {2: [MeasurementGap(category=Category.MEETING, reason="끊김")]}
    result = score_team(events, PROFILES, FULL_COVERAGE, unmeasurable=gaps)

    total_weight = sum(cs.weight for cs in result.members[2].categories.values())
    assert total_weight == pytest.approx(1.0)


def test_team_shares_still_sum_to_100():
    events = {
        1: code_and_meeting(1, base=0, utterances=5),
        2: code_and_meeting(2, base=1000, utterances=0),
    }
    gaps = {2: [MeasurementGap(category=Category.MEETING, reason="끊김")]}
    result = score_team(events, PROFILES, FULL_COVERAGE, unmeasurable=gaps)

    assert sum(ms.share for ms in result.members.values()) == pytest.approx(100.0)


def test_member_with_everything_unmeasurable_still_gets_a_score():
    """전부 측정 불가면 뺄 수가 없다. 원래대로 계산하고 표시만 한다.

    아무 카테고리도 안 남으면 점수 자체를 만들 수 없기 때문이다.
    """
    events = {
        1: code_and_meeting(1, base=0, utterances=5),
        2: code_and_meeting(2, base=1000, utterances=2),
    }
    gaps = {2: [MeasurementGap(category=c, reason="전부 유실") for c in Category]}
    result = score_team(events, PROFILES, FULL_COVERAGE, unmeasurable=gaps)

    assert result.members[2].share > 0
    assert len(result.members[2].measurement_gaps) == len(Category)


def test_no_gaps_behaves_exactly_as_before():
    """기존 동작이 바뀌면 안 된다."""
    events = {
        1: code_and_meeting(1, base=0, utterances=5),
        2: code_and_meeting(2, base=1000, utterances=3),
    }

    assert score_team(events, PROFILES, FULL_COVERAGE).members[1].share == pytest.approx(
        score_team(events, PROFILES, FULL_COVERAGE, unmeasurable={}).members[1].share
    )


# ══════════════════════════════════════════════════════════════
# DB → 측정 불가 판정
# ══════════════════════════════════════════════════════════════


@pytest.fixture
def engine():
    from sqlalchemy import create_engine
    from sqlalchemy.pool import StaticPool

    from teamflow.db import models as m
    from teamflow.db import session as db_session

    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    m.Base.metadata.create_all(eng)
    db_session.configure(eng)
    yield eng
    m.Base.metadata.drop_all(eng)
    eng.dispose()


def seed_tracks(statuses_by_user: dict[str, list[str]]) -> int:
    """사용자별 트랙 상태 목록으로 회의들을 만든다. 프로젝트 id 를 돌려준다."""
    from teamflow.db import models as m
    from teamflow.db import session as db_session

    with db_session.session_scope() as s:
        owner = m.User(name="개설자", email="owner@x.com")
        s.add(owner)
        s.flush()
        project = m.Project(title="TeamFlow", started_at=OCCURRED)
        s.add(project)
        s.flush()

        depth = max(len(v) for v in statuses_by_user.values())
        meetings = []
        for i in range(depth):
            meeting = m.Meeting(
                project_id=project.id,
                started_at=OCCURRED + timedelta(days=i),
                started_by=owner.id,
            )
            s.add(meeting)
            meetings.append(meeting)
        s.flush()

        for email, statuses in statuses_by_user.items():
            user = m.User(name=email, email=email)
            s.add(user)
            s.flush()
            for meeting, status in zip(meetings, statuses, strict=False):
                s.add(
                    m.MeetingTrack(
                        meeting_id=meeting.id,
                        user_id=user.id,
                        started_at=meeting.started_at,
                        ended_at=meeting.started_at + timedelta(minutes=30),
                        status=status,
                        gaps=[],
                        capture_warnings=[],
                    )
                )
        return project.id


def gaps_for(project_id: int) -> dict:
    from teamflow.db import session as db_session
    from teamflow.services.scoring_service import load_measurement_gaps

    with db_session.session_scope() as s:
        return load_measurement_gaps(s, project_id)


def test_all_tracks_broken_makes_meeting_unmeasurable(engine):
    project_id = seed_tracks({"broken@x.com": ["unusable", "unusable"]})
    gaps = gaps_for(project_id)

    assert len(gaps) == 1
    gap = next(iter(gaps.values()))[0]
    assert gap.category is Category.MEETING
    assert gap.detail == {"tracks_total": 2, "tracks_usable": 0}


def test_healthy_member_has_no_gap(engine):
    project_id = seed_tracks({"fine@x.com": ["completed", "completed"]})
    assert gaps_for(project_id) == {}


def test_losing_one_of_four_is_not_enough_to_exclude(engine):
    """회의 한 번 끊긴 걸로 회의 영역을 통째로 빼면 과잉 반응이다.

    그 손실은 프로젝트 전체 신뢰도(track_quality)에 반영된다.
    """
    project_id = seed_tracks(
        {"mostly@x.com": ["completed", "completed", "completed", "unusable"]}
    )
    assert gaps_for(project_id) == {}


def test_losing_more_than_half_excludes(engine):
    project_id = seed_tracks({"half@x.com": ["completed", "unusable", "unusable"]})
    gaps = gaps_for(project_id)

    assert len(gaps) == 1
    assert next(iter(gaps.values()))[0].detail["tracks_usable"] == 1


def test_only_the_affected_member_is_flagged(engine):
    project_id = seed_tracks(
        {
            "fine@x.com": ["completed", "completed"],
            "broken@x.com": ["unusable", "unusable"],
        }
    )
    gaps = gaps_for(project_id)

    assert len(gaps) == 1, "멀쩡한 사람까지 제외하면 안 된다"
