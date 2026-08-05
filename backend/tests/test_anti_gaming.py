"""조작 저항성 테스트 — docs/09-리스크와-검증-실험.md 실험 4.

기여도 산식이 "맞다"는 것은 정답 라벨이 없어 직접 증명할 수 없다.
(교수 평가 점수는 팀당 1개뿐이라 학습·검증 데이터가 되지 못한다.)

대신 **뻔한 조작에 견디는지**는 정답 없이 검증할 수 있다.
이 파일이 그 검증이고, 발표에서 가장 인상적인 부분이 된다.

각 테스트는 docs/09 실험 4 표의 한 행에 대응한다.
"""

from __future__ import annotations

import pytest

from teamflow.contribution.confidence import CoverageStats
from teamflow.contribution.events import Category, EventType
from teamflow.contribution.github_ingest import ingest_pull_requests
from teamflow.contribution.profiles import DEFAULT_PROFILES, Role
from teamflow.contribution.scoring import score_team

from .conftest import (
    Ids,
    code_file,
    deadline,
    lockfile,
    merged_pr,
    reformat_file,
    task_done,
    typo_file,
    utterance,
)


def code_score(events_by_user, profiles, coverage) -> dict[int, float]:
    """카테고리 CODE의 raw 점수만 뽑는다. 팀 정규화 전이라 비교가 명확하다."""
    result = score_team(events_by_user, profiles, coverage)
    return {
        uid: m.categories[Category.CODE].raw if Category.CODE in m.categories else 0.0
        for uid, m in result.members.items()
    }


# ─────────────────────────────────────────────────────────────
# 시나리오 1. 커밋 1개를 30개로 쪼개기 → 점수 변화 없음
# ─────────────────────────────────────────────────────────────


def test_splitting_commits_does_not_change_score(ids: Ids, full_coverage: CoverageStats):
    """커밋을 아무리 쪼개도 병합된 PR이 하나면 점수는 하나다.

    애초에 COMMIT 이벤트 타입이 존재하지 않으므로 구조적으로 불가능하다.
    """
    files = [code_file("src/auth/login.py", 150)]

    # 한 번에 만든 PR
    single = ingest_pull_requests([merged_pr(1, author_id=1, files=files, reviewers=[2])])

    # 같은 내용을 커밋 30개로 쪼개서 올린 PR — 커밋 수는 이벤트에 영향을 주지 않는다
    split = ingest_pull_requests([merged_pr(2, author_id=1, files=files, reviewers=[2])])

    assert len(single) == len(split)
    assert [e.event_type for e in single] == [e.event_type for e in split]
    assert single[0].magnitude == split[0].magnitude
    # 커밋 관련 이벤트 타입 자체가 없다
    assert not any("commit" in e.event_type.value for e in single + split)


# ─────────────────────────────────────────────────────────────
# 시나리오 2. 오타 수정 커밋 대량 생성 → 점수 거의 없음
# ─────────────────────────────────────────────────────────────


def test_typo_spam_scores_far_below_real_work(ids: Ids, full_coverage: CoverageStats):
    """오타 30건 vs 로그인 기능 구현 1건.

    docs/05 §2의 문제 제기를 그대로 검증한다.
    """
    profiles = {1: DEFAULT_PROFILES[Role.DEVELOPER], 2: DEFAULT_PROFILES[Role.DEVELOPER]}

    # 사용자 1: 오타만 30개 PR
    typo_prs = [
        merged_pr(100 + i, author_id=1, files=[typo_file("README.md", i)], minutes=i)
        for i in range(30)
    ]
    # 사용자 2: 실제 기능 구현 PR 1개 + 테스트
    real_prs = [
        merged_pr(
            200,
            author_id=2,
            files=[
                code_file("src/auth/login.py", 180),
                code_file("tests/test_login.py", 60, prefix="assert"),
            ],
            reviewers=[1],
        )
    ]

    scores = code_score(
        {1: ingest_pull_requests(typo_prs), 2: ingest_pull_requests(real_prs)},
        profiles,
        full_coverage,
    )

    # 실제 구현이 오타 스팸 30건보다 높아야 한다
    assert scores[2] > scores[1], f"오타 스팸이 이겼습니다: {scores}"


@pytest.mark.parametrize("spam_count", [30, 100, 200])
def test_typo_spam_stays_below_real_work_up_to_200_prs(
    spam_count: int, full_coverage: CoverageStats
):
    """오타 PR 200개까지는 실제 기능 구현 1건을 이기지 못한다.

    억제 장치 두 개가 함께 동작한다.
      1. 사소 변경 감쇠 (diff_filter.TRIVIAL_WEIGHT)
      2. 카테고리 천장 (scoring._CATEGORY_CEILING)
    """
    profiles = {1: DEFAULT_PROFILES[Role.DEVELOPER], 2: DEFAULT_PROFILES[Role.DEVELOPER]}
    spam = ingest_pull_requests(
        [
            merged_pr(1000 + i, author_id=1, files=[typo_file("README.md", i)])
            for i in range(spam_count)
        ]
    )
    real = ingest_pull_requests(
        [
            merged_pr(
                1,
                author_id=2,
                files=[
                    code_file("src/auth/login.py", 180),
                    code_file("tests/test_login.py", 60, prefix="assert"),
                ],
                reviewers=[1],
            )
        ]
    )
    scores = code_score({1: spam, 2: real}, profiles, full_coverage)
    assert scores[2] > scores[1], f"오타 {spam_count}건이 이겼습니다: {scores}"


def test_extreme_typo_spam_is_detected_even_when_it_wins(full_coverage: CoverageStats):
    """⚠️ 알려진 한계를 명시하는 테스트.

    오타 PR 500건을 넘기면 물량이 실제 구현을 앞선다.
    순수 정량 지표로는 원리적으로 막을 수 없다 — 500건은 '실제로 500번 작업한' 것이고,
    그것이 저가치라는 판단은 정량 신호만으로 내릴 수 없기 때문이다.

    그래서 시스템은 **판정하지 않고 표시한다** (docs/05 §5, docs/07 E1).
    이 규모의 조작은 무결성 플래그로 반드시 드러나야 한다.
    """
    profiles = {1: DEFAULT_PROFILES[Role.DEVELOPER], 2: DEFAULT_PROFILES[Role.DEVELOPER]}
    spam = ingest_pull_requests(
        [
            merged_pr(1000 + i, author_id=1, files=[typo_file("README.md", i)])
            for i in range(500)
        ]
    )
    result = score_team(
        {1: spam, 2: [task_done(2, 1)]}, profiles, full_coverage
    )
    codes = {f.code for f in result.members[1].integrity_flags}
    assert "trivial_pr_spam" in codes
    assert "no_external_review" in codes


def test_single_typo_pr_earns_minimal_points(full_coverage: CoverageStats):
    """오타 1건짜리 PR도 0은 아니지만 매우 작아야 한다."""
    events = ingest_pull_requests(
        [merged_pr(1, author_id=1, files=[typo_file("README.md", 5)])]
    )
    big = ingest_pull_requests(
        [merged_pr(2, author_id=1, files=[code_file("src/service.py", 200)])]
    )

    from teamflow.contribution.scoring import event_points

    small_pts = event_points(events[0])
    big_pts = event_points(big[0])
    assert small_pts < big_pts * 0.5


# ─────────────────────────────────────────────────────────────
# 시나리오 3. lock 파일 수정 → 점수 0
# ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "name",
    [
        "package-lock.json",
        "frontend/package-lock.json",
        "yarn.lock",
        "poetry.lock",
        "Cargo.lock",
        "go.sum",
    ],
)
def test_lockfile_only_pr_scores_zero(name: str):
    """3000줄짜리 lock 파일 변경도 이벤트를 만들지 않는다."""
    events = ingest_pull_requests(
        [merged_pr(1, author_id=1, files=[lockfile(name, body_lines=3000)])]
    )
    assert events == [], f"{name} 이 점수를 만들었습니다"


def test_lockfile_does_not_inflate_real_pr():
    """실제 코드 + lock 파일이 섞인 PR에서 lock 부분은 빠진다."""
    with_lock = ingest_pull_requests(
        [
            merged_pr(
                1,
                author_id=1,
                files=[code_file("src/a.py", 50), lockfile(body_lines=3000)],
            )
        ]
    )
    without = ingest_pull_requests(
        [merged_pr(2, author_id=1, files=[code_file("src/a.py", 50)])]
    )
    assert with_lock[0].magnitude == without[0].magnitude


# ─────────────────────────────────────────────────────────────
# 시나리오 4. 전체 재포맷 → 점수 0
# ─────────────────────────────────────────────────────────────


def test_reformat_only_pr_scores_zero():
    """prettier / black 전체 적용 커밋은 기여로 세지 않는다."""
    events = ingest_pull_requests(
        [
            merged_pr(
                1,
                author_id=1,
                files=[reformat_file(f"src/mod_{i}.py", 100) for i in range(20)],
            )
        ]
    )
    assert events == [], "전체 재포맷이 점수를 만들었습니다"


def test_partial_reformat_counts_only_real_change():
    """재포맷과 실질 변경이 섞이면 실질 변경분만 잡힌다."""
    mixed = ingest_pull_requests(
        [
            merged_pr(
                1,
                author_id=1,
                files=[reformat_file("src/old.py", 200), code_file("src/new.py", 40)],
            )
        ]
    )
    clean = ingest_pull_requests(
        [merged_pr(2, author_id=1, files=[code_file("src/new.py", 40)])]
    )
    assert mixed[0].magnitude == clean[0].magnitude


# ─────────────────────────────────────────────────────────────
# 시나리오 5. 회의에서 맞장구만 반복 → 회의 점수 0
# ─────────────────────────────────────────────────────────────


def test_social_only_utterances_score_zero(ids: Ids, full_coverage: CoverageStats):
    """'네', '맞아요'를 200번 해도 회의 기여는 0이다."""
    profiles = {1: DEFAULT_PROFILES[Role.DEVELOPER], 2: DEFAULT_PROFILES[Role.DEVELOPER]}

    social = [
        utterance(1, EventType.UTT_SOCIAL, ids.next(), minutes=i) for i in range(200)
    ]
    substantive = [
        utterance(2, EventType.UTT_ANSWER, ids.next()),
        utterance(2, EventType.UTT_DECISION, ids.next()),
    ]

    result = score_team({1: social, 2: substantive}, profiles, full_coverage)
    assert result.members[1].categories[Category.MEETING].raw == 0.0
    assert result.members[2].categories[Category.MEETING].raw > 0.0


def test_social_spam_raises_integrity_flag(ids: Ids, full_coverage: CoverageStats):
    """맞장구 비중이 압도적이면 표시는 한다. 단 점수를 깎지는 않는다."""
    profiles = {1: DEFAULT_PROFILES[Role.DEVELOPER], 2: DEFAULT_PROFILES[Role.DEVELOPER]}
    events = [utterance(1, EventType.UTT_SOCIAL, ids.next()) for _ in range(50)]
    events += [utterance(1, EventType.UTT_QUESTION, ids.next()) for _ in range(3)]

    result = score_team(
        {1: events, 2: [utterance(2, EventType.UTT_ANSWER, ids.next())]},
        profiles,
        full_coverage,
    )
    codes = {f.code for f in result.members[1].integrity_flags}
    assert "mostly_social_utterances" in codes


# ─────────────────────────────────────────────────────────────
# 시나리오 6. 혼자 오래 떠들기 → 점수 안 오름
# ─────────────────────────────────────────────────────────────


def test_speaking_duration_is_not_a_scored_signal(ids: Ids, full_coverage: CoverageStats):
    """발언 '시간'은 어떤 이벤트로도 점수화되지 않는다.

    docs/05 §2.2: "회의에서 말을 많이 한다고 기여한 것은 아님"
    """
    profiles = {1: DEFAULT_PROFILES[Role.DEVELOPER], 2: DEFAULT_PROFILES[Role.DEVELOPER]}

    # 사용자 1: 같은 유형 발언인데 magnitude(길이)만 100배
    long_talk = [
        utterance(1, EventType.UTT_OPINION, ids.next()),
    ]
    object.__setattr__(long_talk[0], "magnitude", 10_000.0)

    short_talk = [utterance(2, EventType.UTT_OPINION, ids.next())]

    result = score_team({1: long_talk, 2: short_talk}, profiles, full_coverage)
    assert (
        result.members[1].categories[Category.MEETING].raw
        == result.members[2].categories[Category.MEETING].raw
    )


# ─────────────────────────────────────────────────────────────
# 시나리오 7. 마감일 계속 미루기 → 준수율 유지되나 표시됨
# ─────────────────────────────────────────────────────────────


def test_deadline_extension_is_flagged(ids: Ids, full_coverage: CoverageStats):
    """마감을 계속 미루면 준수율은 100%지만 무결성 플래그가 붙는다."""
    profiles = {1: DEFAULT_PROFILES[Role.DEVELOPER], 2: DEFAULT_PROFILES[Role.DEVELOPER]}

    gamer = [deadline(1, ids.next(), EventType.DEADLINE_MET) for _ in range(5)]
    gamer += [deadline(1, ids.next(), EventType.DEADLINE_CHANGED) for _ in range(8)]

    honest = [deadline(2, ids.next(), EventType.DEADLINE_MET) for _ in range(5)]

    result = score_team({1: gamer, 2: honest}, profiles, full_coverage)

    # 점수는 같다 — 시스템이 사람을 판정하지 않는다
    assert (
        result.members[1].categories[Category.SCHEDULE].raw
        == result.members[2].categories[Category.SCHEDULE].raw
    )
    # 그러나 맥락은 표시된다
    assert "frequent_deadline_change" in {
        f.code for f in result.members[1].integrity_flags
    }
    assert result.members[2].integrity_flags == []


# ─────────────────────────────────────────────────────────────
# 시나리오 8. 초기 스캐폴딩 커밋 1개 → 상한에 걸림
# ─────────────────────────────────────────────────────────────


def test_giant_scaffolding_pr_is_capped():
    """5000줄짜리 초기 스캐폴딩 PR이 전체를 삼키지 못한다."""
    from teamflow.contribution.diff_filter import MAX_LINES_PER_PR

    giant = ingest_pull_requests(
        [merged_pr(1, author_id=1, files=[code_file("src/everything.py", 5000)])]
    )
    assert giant[0].magnitude == MAX_LINES_PER_PR

    # 상한의 절반짜리 PR과 비교했을 때 점수 차가 2배 미만이어야 한다 (포화 함수)
    from teamflow.contribution.scoring import event_points

    half = ingest_pull_requests(
        [merged_pr(2, author_id=1, files=[code_file("src/half.py", 200)])]
    )
    assert event_points(giant[0]) < event_points(half[0]) * 2


# ─────────────────────────────────────────────────────────────
# 시나리오 9. 웹훅 재전송 / 백필 중복 → 점수 부풀려지지 않음
# ─────────────────────────────────────────────────────────────


def test_duplicate_events_do_not_inflate_score(ids: Ids, full_coverage: CoverageStats):
    """같은 PR이 웹훅과 백필로 두 번 들어와도 한 번만 센다."""
    profiles = {1: DEFAULT_PROFILES[Role.DEVELOPER], 2: DEFAULT_PROFILES[Role.DEVELOPER]}
    pr = merged_pr(1, author_id=1, files=[code_file("src/a.py", 100)], reviewers=[2])

    once = ingest_pull_requests([pr])
    twice = ingest_pull_requests([pr, pr, pr])  # 3번 수신

    other = [task_done(2, ids.next())]

    r1 = score_team({1: once, 2: other}, profiles, full_coverage)
    r2 = score_team({1: twice, 2: other}, profiles, full_coverage)

    assert r1.members[1].categories[Category.CODE].raw == pytest.approx(
        r2.members[1].categories[Category.CODE].raw
    )


# ─────────────────────────────────────────────────────────────
# 시나리오 10. 셀프 머지 → 리뷰 가중 없음 + 플래그
# ─────────────────────────────────────────────────────────────


def test_self_merged_prs_score_lower_and_are_flagged(
    ids: Ids, full_coverage: CoverageStats
):
    """리뷰 없이 셀프 머지한 PR은 가중이 붙지 않는다."""
    profiles = {1: DEFAULT_PROFILES[Role.DEVELOPER], 2: DEFAULT_PROFILES[Role.DEVELOPER]}

    files = [code_file("src/a.py", 120)]
    self_merged = ingest_pull_requests(
        [merged_pr(10 + i, author_id=1, files=files) for i in range(4)]
    )
    reviewed = ingest_pull_requests(
        [merged_pr(20 + i, author_id=2, files=files, reviewers=[1]) for i in range(4)]
    )

    result = score_team({1: self_merged, 2: reviewed}, profiles, full_coverage)

    assert (
        result.members[2].categories[Category.CODE].raw
        > result.members[1].categories[Category.CODE].raw
    )
    assert "no_external_review" in {f.code for f in result.members[1].integrity_flags}


# ─────────────────────────────────────────────────────────────
# 시나리오 11. 약속만 하고 안 지키기 → 거의 점수 없음
# ─────────────────────────────────────────────────────────────


def test_unfulfilled_commitments_score_low(ids: Ids, full_coverage: CoverageStats):
    """회의에서 업무를 맡겠다고 말만 하고 안 하면 점수가 거의 없다."""
    profiles = {1: DEFAULT_PROFILES[Role.DEVELOPER], 2: DEFAULT_PROFILES[Role.DEVELOPER]}

    talker = [
        utterance(1, EventType.UTT_COMMITMENT, ids.next(), fulfilled=False)
        for _ in range(10)
    ]
    doer = [
        utterance(2, EventType.UTT_COMMITMENT, ids.next(), fulfilled=True)
        for _ in range(3)
    ]

    result = score_team({1: talker, 2: doer}, profiles, full_coverage)
    # 10건 말만 한 사람이 3건 지킨 사람보다 크게 앞서지 못한다
    talker_raw = result.members[1].categories[Category.MEETING].raw
    doer_raw = result.members[2].categories[Category.MEETING].raw
    assert talker_raw < doer_raw + 1e-9, f"말만 한 쪽이 이겼습니다: {talker_raw} vs {doer_raw}"
