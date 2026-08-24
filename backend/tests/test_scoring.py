"""기여도 산정 엔진 단위 테스트."""

from __future__ import annotations

import pytest

from teamflow.contribution.confidence import (
    CoverageStats,
    adjustment_range,
    compute_confidence,
)
from teamflow.contribution.events import Category, EventType
from teamflow.contribution.profiles import (
    DEFAULT_PROFILES,
    Role,
    blended_profile,
    clean_role_shares,
)
from teamflow.contribution.scoring import event_points, score_team

from .conftest import Ids, deadline, task_done, utterance

# ─────────────────────────────────────────────────────────────
# 프로파일
# ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize("role", list(Role))
def test_default_profile_weights_sum_to_one(role: Role):
    assert sum(DEFAULT_PROFILES[role].weights.values()) == pytest.approx(1.0)


def test_planner_has_no_code_weight():
    """기획자는 코드 기여로 평가받지 않는다."""
    assert DEFAULT_PROFILES[Role.PLANNER].weight(Category.CODE) == 0.0


def test_blended_profile_sums_to_one():
    blended = blended_profile({Role.DEVELOPER: 0.7, Role.PLANNER: 0.3})
    assert sum(blended.weights.values()) == pytest.approx(1.0)
    # 개발 70%면 코드 가중치는 개발자 전용의 70%
    assert blended.weight(Category.CODE) == pytest.approx(0.35 * 0.7)


def test_blended_profile_rejects_zero_shares():
    with pytest.raises(ValueError, match="비중 합"):
        blended_profile({Role.DEVELOPER: 0.0})


def test_invalid_profile_rejected():
    from teamflow.contribution.profiles import ScoringProfile

    with pytest.raises(ValueError, match="가중치 합"):
        ScoringProfile(role=Role.DEVELOPER, weights={Category.CODE: 0.5})


# ─────────────────────────────────────────────────────────────
# 신뢰도
# ─────────────────────────────────────────────────────────────


def test_full_coverage_gives_high_confidence(full_coverage: CoverageStats):
    result = compute_confidence(full_coverage)
    assert result.value == pytest.approx(1.0)
    assert result.label == "높음"
    assert result.reasons == []


def test_missing_recordings_lower_confidence():
    stats = CoverageStats(
        meetings_total=10,
        meetings_recorded=3,
        utterances_total=100,
        utterances_speaker_certain=100,
        project_days=90,
        github_connected_days=90,
    )
    result = compute_confidence(stats)
    assert result.value < 1.0
    assert "녹음되지 않은 회의가 있습니다" in result.reasons


def test_uncertain_speakers_weigh_heaviest():
    """화자 불확실성은 기여도로 직접 전파되므로 가중치가 가장 크다."""
    base = dict(
        meetings_total=10,
        meetings_recorded=10,
        utterances_total=100,
        project_days=90,
        github_connected_days=90,
    )
    speaker_bad = compute_confidence(
        CoverageStats(**base, utterances_speaker_certain=20)
    )
    meeting_bad = compute_confidence(
        CoverageStats(
            meetings_total=10,
            meetings_recorded=2,
            utterances_total=100,
            utterances_speaker_certain=100,
            project_days=90,
            github_connected_days=90,
        )
    )
    assert speaker_bad.value < meeting_bad.value


def test_unused_modules_do_not_penalize_confidence():
    """동료평가를 안 쓰는 팀이 그 때문에 신뢰도를 잃지 않는다."""
    stats = CoverageStats(
        meetings_total=5,
        meetings_recorded=5,
        utterances_total=50,
        utterances_speaker_certain=50,
        project_days=30,
        github_connected_days=30,
        peer_reviews_expected=0,  # 미사용
        peer_reviews_submitted=0,
    )
    assert compute_confidence(stats).value == pytest.approx(1.0)


def test_no_data_gives_zero_confidence():
    result = compute_confidence(CoverageStats())
    assert result.value == 0.0
    assert result.label == "매우 낮음"


def test_adjustment_range_widens_as_confidence_drops():
    tight_low, tight_high = adjustment_range(27.0, confidence=0.95)
    wide_low, wide_high = adjustment_range(27.0, confidence=0.4)
    assert (tight_high - tight_low) < (wide_high - wide_low)


def test_full_confidence_gives_no_range():
    low, high = adjustment_range(27.0, confidence=1.0)
    assert low == pytest.approx(high) == pytest.approx(27.0)


def test_range_never_goes_negative():
    low, _ = adjustment_range(1.0, confidence=0.0)
    assert low >= 0.0


# ─────────────────────────────────────────────────────────────
# 팀 산정
# ─────────────────────────────────────────────────────────────


def test_shares_sum_to_100(ids: Ids, full_coverage: CoverageStats):
    profiles = {
        1: DEFAULT_PROFILES[Role.DEVELOPER],
        2: DEFAULT_PROFILES[Role.PLANNER],
        3: DEFAULT_PROFILES[Role.DESIGNER],
    }
    events = {
        1: [task_done(1, ids.next(), difficulty=2) for _ in range(5)],
        2: [task_done(2, ids.next()) for _ in range(3)],
        3: [task_done(3, ids.next()) for _ in range(2)],
    }
    result = score_team(events, profiles, full_coverage)
    assert sum(m.share for m in result.members.values()) == pytest.approx(100.0)


def test_the_event_count_always_matches_the_evidence_it_names(
    ids: Ids, full_coverage: CoverageStats
):
    """⭐ 건수와 근거 목록은 **따로 계산되는 두 벌**이다.

    `CategoryScore` 는 둘을 각각 받습니다.

        evidence_ids=evidences[uid][category],
        event_count=counts[uid][category],

    화면은 "근거 3건" 이라고 말하고, 근거를 펼쳐 보는 화면이 생기면 그때
    `evidence_ids` 를 읽습니다. **둘이 갈라지면** 사람은 3건이라고 들었는데
    2건을 보게 됩니다 — 기여도에서 그건 "숨겼다" 로 읽힙니다.

    이 저장소가 가장 자주 겪은 부류입니다: **두 벌이 있으면 한쪽만
    고쳐진다.** 지금은 맞고, 앞으로도 맞는지는 이 검사가 봅니다.
    """
    profiles = {
        1: DEFAULT_PROFILES[Role.DEVELOPER],
        2: DEFAULT_PROFILES[Role.PLANNER],
    }
    events = {
        1: [task_done(1, ids.next()) for _ in range(3)]
        + [deadline(1, ids.next(), EventType.DEADLINE_MET) for _ in range(2)],
        2: [task_done(2, ids.next())],
    }
    result = score_team(events, profiles, full_coverage)

    checked = 0
    for member in result.members.values():
        for score in member.categories.values():
            assert score.event_count == len(score.evidence_ids), (
                f"{score.category}: 건수 {score.event_count} 인데 "
                f"근거는 {len(score.evidence_ids)}개입니다"
            )
            checked += 1
    assert checked > 0, "카테고리를 하나도 못 봤습니다 — 이 검사가 헛돌고 있습니다"


def test_evidence_ids_are_the_real_event_ids(ids: Ids, full_coverage: CoverageStats):
    """⚠️ 개수만 맞으면 안 됩니다. **그 이벤트의 id 여야** 합니다.

    개수만 보면 근거를 통째로 엉뚱한 목록으로 바꿔도 통과합니다.
    """
    profiles = {1: DEFAULT_PROFILES[Role.DEVELOPER]}
    mine = [task_done(1, ids.next()) for _ in range(3)]
    events = {1: mine}

    result = score_team(events, profiles, full_coverage)
    task_score = result.members[1].categories[Category.TASK]

    assert sorted(task_score.evidence_ids) == sorted(e.source_id for e in mine)


def test_empty_categories_are_skipped(ids: Ids, full_coverage: CoverageStats):
    """팀 전체가 0인 카테고리는 제외되고 가중치가 재정규화된다."""
    profiles = {1: DEFAULT_PROFILES[Role.DEVELOPER], 2: DEFAULT_PROFILES[Role.DEVELOPER]}
    events = {
        1: [task_done(1, ids.next())],
        2: [task_done(2, ids.next())],
    }
    result = score_team(events, profiles, full_coverage)
    assert Category.CODE in result.skipped_categories
    assert Category.TASK not in result.skipped_categories
    # 남은 카테고리 가중치 합이 1이 되도록 재정규화
    total_weight = sum(cs.weight for cs in result.members[1].categories.values())
    assert total_weight == pytest.approx(1.0)


def test_every_score_has_evidence(ids: Ids, full_coverage: CoverageStats):
    """모든 점수는 근거 이벤트로 역추적되어야 한다 (docs/07 E5)."""
    profiles = {1: DEFAULT_PROFILES[Role.DEVELOPER], 2: DEFAULT_PROFILES[Role.DEVELOPER]}
    events = {
        1: [task_done(1, ids.next()), utterance(1, EventType.UTT_DECISION, ids.next())],
        2: [task_done(2, ids.next())],
    }
    result = score_team(events, profiles, full_coverage)
    for member in result.members.values():
        for cs in member.categories.values():
            if cs.raw > 0:
                assert cs.evidence_ids, f"{cs.category} 점수에 근거가 없습니다"


def test_scoring_is_deterministic(ids: Ids, full_coverage: CoverageStats):
    """같은 입력이면 항상 같은 출력. 재계산 가능해야 한다."""
    profiles = {1: DEFAULT_PROFILES[Role.DEVELOPER], 2: DEFAULT_PROFILES[Role.DEVELOPER]}
    events = {
        1: [task_done(1, 100 + i, difficulty=2) for i in range(4)],
        2: [task_done(2, 200 + i) for i in range(6)],
    }
    a = score_team(events, profiles, full_coverage)
    b = score_team(events, profiles, full_coverage)
    assert {k: v.share for k, v in a.members.items()} == {
        k: v.share for k, v in b.members.items()
    }


def test_weight_change_shifts_result_without_touching_events(
    ids: Ids, full_coverage: CoverageStats
):
    """가중치를 바꾸면 같은 이벤트로 다른 점수가 나온다 — 재계산 구조의 핵심."""
    from teamflow.contribution.profiles import ScoringProfile

    events = {
        1: [utterance(1, EventType.UTT_DECISION, 10 + i) for i in range(5)],
        2: [task_done(2, 20 + i) for i in range(5)],
    }

    meeting_heavy = ScoringProfile(
        role=Role.DEVELOPER,
        weights={
            Category.MEETING: 0.8,
            Category.TASK: 0.2,
            Category.CODE: 0.0,
            Category.DOCUMENT: 0.0,
            Category.SCHEDULE: 0.0,
            Category.PEER: 0.0,
        },
        version="meeting-heavy",
    )
    task_heavy = ScoringProfile(
        role=Role.DEVELOPER,
        weights={
            Category.MEETING: 0.2,
            Category.TASK: 0.8,
            Category.CODE: 0.0,
            Category.DOCUMENT: 0.0,
            Category.SCHEDULE: 0.0,
            Category.PEER: 0.0,
        },
        version="task-heavy",
    )

    r1 = score_team(events, {1: meeting_heavy, 2: meeting_heavy}, full_coverage)
    r2 = score_team(events, {1: task_heavy, 2: task_heavy}, full_coverage)

    # 회의 중심 가중치에서는 1번이, 업무 중심에서는 2번이 앞선다
    assert r1.members[1].share > r1.members[2].share
    assert r2.members[2].share > r2.members[1].share


def test_schedule_ratio_beats_volume(ids: Ids, full_coverage: CoverageStats):
    """일정 준수는 비율 기반. 마감을 많이 놓치면 건수가 많아도 점수가 낮다."""
    profiles = {1: DEFAULT_PROFILES[Role.DEVELOPER], 2: DEFAULT_PROFILES[Role.DEVELOPER]}
    sloppy = [deadline(1, ids.next(), EventType.DEADLINE_MET) for _ in range(10)]
    sloppy += [deadline(1, ids.next(), EventType.DEADLINE_MISSED) for _ in range(10)]
    reliable = [deadline(2, ids.next(), EventType.DEADLINE_MET) for _ in range(8)]

    result = score_team({1: sloppy, 2: reliable}, profiles, full_coverage)
    assert (
        result.members[2].categories[Category.SCHEDULE].raw
        > result.members[1].categories[Category.SCHEDULE].raw
    )


def test_peer_rating_uses_median_not_mean(ids: Ids, full_coverage: CoverageStats):
    """감정적인 극단값 하나가 결과를 흔들지 못한다."""
    from teamflow.contribution.events import ContributionEvent, SourceKind

    from .conftest import at

    def rating(uid: int, sid: int, value: float):
        return ContributionEvent(
            user_id=uid,
            event_type=EventType.PEER_RATING,
            occurred_at=at(),
            source_kind=SourceKind.PEER_REVIEW,
            source_id=sid,
            magnitude=value,
        )

    profiles = {1: DEFAULT_PROFILES[Role.DEVELOPER], 2: DEFAULT_PROFILES[Role.DEVELOPER]}
    # 1번: 4,4,4 인데 한 명이 1점 테러
    attacked = [rating(1, ids.next(), v) for v in (4, 4, 4, 1)]
    normal = [rating(2, ids.next(), v) for v in (4, 4, 4, 4)]

    result = score_team({1: attacked, 2: normal}, profiles, full_coverage)
    # 중앙값이므로 4점 그대로 유지된다
    assert result.members[1].categories[Category.PEER].raw == pytest.approx(
        result.members[2].categories[Category.PEER].raw
    )


def test_no_events_yields_zero_shares(full_coverage: CoverageStats):
    profiles = {1: DEFAULT_PROFILES[Role.DEVELOPER], 2: DEFAULT_PROFILES[Role.DEVELOPER]}
    result = score_team({1: [], 2: []}, profiles, full_coverage)
    assert all(m.share == 0.0 for m in result.members.values())
    assert len(result.skipped_categories) == len(Category)


def test_low_confidence_produces_wide_range(ids: Ids):
    """데이터가 부족하면 조정 범위가 넓어진다."""
    sparse = CoverageStats(
        meetings_total=10,
        meetings_recorded=1,
        utterances_total=100,
        utterances_speaker_certain=20,
        project_days=90,
        github_connected_days=10,
    )
    profiles = {1: DEFAULT_PROFILES[Role.DEVELOPER], 2: DEFAULT_PROFILES[Role.DEVELOPER]}
    events = {
        1: [task_done(1, ids.next()) for _ in range(6)],
        2: [task_done(2, ids.next()) for _ in range(4)],
    }
    result = score_team(events, profiles, sparse)
    member = result.members[1]
    assert member.confidence.value < 0.6
    assert member.range_high - member.range_low > 5.0
    assert member.confidence.reasons


# ══════════════════════════════════════════════════════════════
# 역할 비중 검사 — 이 값이 틀리면 기여도 전체가 조용히 틀어진다
# ══════════════════════════════════════════════════════════════


def test_a_plain_role_is_accepted():
    assert clean_role_shares({"planner": 1.0}) == {"planner": 1.0}


def test_a_blend_is_accepted():
    assert clean_role_shares({"developer": 0.7, "planner": 0.3}) == {
        "developer": 0.7,
        "planner": 0.3,
    }


def test_zero_shares_are_dropped_not_kept():
    """⚠️ `{developer: 1, planner: 0}` 은 겸직이 아니라 개발자다.

    남겨 두면 `blended_profile` 이 이름표를 `blend(...planner:0.00)` 로
    만들어 화면이 겸직처럼 보입니다.
    """
    assert clean_role_shares({"developer": 1.0, "planner": 0.0}) == {"developer": 1.0}


def test_shares_that_do_not_sum_to_one_are_refused():
    """⚠️ `blended_profile` 은 합으로 나눠 정규화하므로 5:5 도 "돌아갑니다".

    그런데 그러면 화면에 적힌 숫자와 실제 비중이 달라지고, 사람은 자기가
    적은 값이 그대로 쓰인다고 믿습니다. 받아들일 때 막습니다.
    """
    for bad in ({"developer": 0.9}, {"developer": 5, "planner": 5}, {"developer": 1.2}):
        with pytest.raises(ValueError, match="합이 1"):
            clean_role_shares(bad)


def test_floating_point_dust_still_passes():
    """0.1 을 세 번 더하면 0.30000000000000004 다. 화면에서 온 값이다."""
    assert clean_role_shares({"developer": 0.1 + 0.1 + 0.1, "planner": 0.7})


def test_an_unknown_role_is_refused_with_the_list():
    with pytest.raises(ValueError, match="모르는 역할"):
        clean_role_shares({"tester": 1.0})


def test_a_negative_share_is_refused():
    with pytest.raises(ValueError, match="음수"):
        clean_role_shares({"developer": 1.5, "planner": -0.5})


def test_an_empty_choice_is_refused():
    for bad in (None, {}, {"developer": 0.0}):
        with pytest.raises(ValueError):
            clean_role_shares(bad)


# ══════════════════════════════════════════════════════════════
# ⭐ 찬반은 값이 같다 (요구사항 정의서 §10)
# ══════════════════════════════════════════════════════════════


def test_taking_a_side_costs_nothing():
    """⭐ **동의·반대·보완·의견은 점수가 똑같습니다.**

    요구사항 §10 이 동의(`004`)·반대(`005`)·보완(`006`)을 따로 세라고 해서
    라벨을 갈랐습니다. 가른 것은 **세기 위해서**지 값을 매기기 위해서가
    아닙니다.

    ⚠️ 반대에 더 주면 어깃장이 이득이 되고, 동의에 더 주면 반대가 손해가
    됩니다. 둘 다 회의를 망가뜨리고, 어느 쪽이 더 값진가는 **시스템이
    정할 일이 아닙니다** (`AGENTS.md` 불변식 4 — 시스템은 판정하지 않음).

    ⚠️ 팀이 다르게 보면 가중치를 조정하고 **그 이유를 함께 남깁니다.**
    코드에 몰래 박아 두는 것과는 다릅니다.

    ⚠️ `share` 가 아니라 `event_points` 를 봅니다 — 한 사람만 있으면
    비중은 언제나 100%%라 **무슨 값을 넣어도 통과합니다.**
    """
    ids = Ids()
    scores = {
        kind.value: event_points(utterance(1, kind, ids.next()))
        for kind in (
            EventType.UTT_AGREEMENT,
            EventType.UTT_OBJECTION,
            EventType.UTT_REFINEMENT,
            EventType.UTT_OPINION,
        )
    }

    assert len(set(scores.values())) == 1, (
        f"찬반·보완의 점수가 갈렸습니다: {scores}. 어느 쪽 편을 들지는 "
        "시스템이 정할 일이 아닙니다 — `scoring.py` 의 그 문단을 읽으십시오"
    )
    assert set(scores.values()) != {0.0}, "넷 다 0점이면 의견이 통째로 안 세어집니다"


def test_asking_someone_else_to_work_is_not_worth_more_than_asking_a_question():
    """업무 요청(`008`)·확인 요청(`010`)은 질문과 같은 값입니다.

    ⚠️ 더 주면 **일을 시키는 것이 하는 것보다 남는 장사**가 됩니다.
    """
    ids = Ids()
    baseline = event_points(utterance(1, EventType.UTT_QUESTION, ids.next()))

    for kind in (EventType.UTT_REQUEST, EventType.UTT_CONFIRMATION):
        got = event_points(utterance(1, kind, ids.next()))
        assert got == baseline, f"{kind.value} 이 질문({baseline})과 다릅니다: {got}"


def test_every_utterance_label_has_a_weight():
    """⭐ 라벨을 늘려 놓고 `scoring.py` 에 자리를 안 만들면 **조용히 0점**이 된다.

    `event_points` 는 아는 `EventType` 이 없으면 마지막에 0.0 을 돌려줍니다.
    그래서 새 라벨은 오류 없이 **없는 것처럼** 굴고, 그게 이 저장소의 대표
    실패 ①(만들어 놓고 아무도 안 부름)입니다.

    ⚠️ 0점이어야 하는 둘(`social`·`other`)은 빼고 봅니다.
    """
    from teamflow.db import vocab

    for label in vocab.UtteranceType:
        if label in vocab.UTTERANCE_ZERO_SCORE:
            continue
        kind = EventType(f"utt_{label}")
        points = event_points(utterance(1, kind, Ids().next()))
        assert points > 0.0, (
            f"`{kind.value}` 의 점수가 0 입니다 — `scoring.py` 의 "
            "`event_points` 에 자리를 만드십시오"
        )


def test_team_wide_reasons_do_not_point_at_a_person():
    """⭐ 팀 전체를 잰 사유가 **사람을 가리키면** 안 된다 (결함 344).

    `compute_confidence` 는 팀 하나의 `CoverageStats` 를 받아 **한 벌**을
    돌려주고, `scoring.py` 는 그것을 팀원 수만큼 복사해 붙입니다 — 세 사람의
    `confidence_reasons` 는 글자 하나까지 같습니다. 그런데 화면과 보고서는
    그 목록을 **사람 이름 밑에** 그립니다.

    그래서 문장이 사람을 가리키면 받는 이가 없고, 읽는 사람은 카드의 주인을
    가리킨다고 읽습니다. 재현한 것:

        최종 보고서 · 김민수(트랙 커버리지 1.0 · 회의 근거 6건)
          근거 11건
          · 녹음이 끊긴 트랙이 있습니다 — **해당 팀원의** 발언량은 측정할 수 없습니다

    끊긴 트랙의 주인은 박지원 한 사람이었습니다.

    ⚠️ 누가 못 잰 것인지는 그 사람의 `measurement_gaps` 가 따로 말합니다 —
    거기 문장은 사람을 가리켜도 됩니다. 여기만 안 됩니다.
    """
    from teamflow.contribution.confidence import _REASON_TEXT

    # 「그 사람」을 가리키는 말. 팀 문장에는 받는 이가 없습니다.
    pointing = ("해당 팀원", "이 팀원", "그 팀원", "해당 팀원의", "본인", "이 사람")
    guilty = [
        (key, text)
        for key, text in _REASON_TEXT.items()
        if any(word in text for word in pointing)
    ]
    assert not guilty, (
        "팀 전체를 잰 사유가 사람을 가리킵니다 — 이 문장은 사람 이름 밑에 "
        f"그려지므로 카드 주인을 가리킨다고 읽힙니다: {guilty}"
    )
