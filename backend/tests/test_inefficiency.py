"""비효율 회의 탐지 (요구사항 정의서 §12).

⚠️ 여기서 제일 중요한 것은 **없는 것을 만들어 내지 않는다**는 것입니다.
이 값들은 "이 회의가 비효율적이었다" 로 읽히고, 그건 사람에 대한 판정처럼
느껴집니다. 놓치는 쪽이 지어내는 쪽보다 낫습니다.
"""

from __future__ import annotations

from teamflow.meeting.inefficiency import (
    Decided,
    Finding,
    Said,
    content_words,
    find_decision_conflicts,
    find_incomplete_tasks,
    find_repeated_discussion,
    find_topic_drift,
    passages,
)

M = 60_000


def said(uid: int, minute: float, text: str, label: str | None = None) -> Said:
    at = int(minute * M)
    return Said(id=uid, start_ms=at, end_ms=at + 5_000, text=text, label=label)


# ══════════════════════════════════════════════════════════════
# 낱말 자르기
# ══════════════════════════════════════════════════════════════


def test_particles_come_off():
    assert "로그인" in content_words("로그인은 어떻게 하죠")
    assert "인증" in content_words("인증으로 갑시다")
    assert "배포" in content_words("배포까지 생각하면")


def test_the_particle_comes_off_only_once():
    """⚠️ 반복해서 떼면 `인증` 이 `인` 이 됩니다."""
    assert "인증" in content_words("인증은")


def test_predicates_are_not_topics():
    """⭐ `좋겠습니다`·`할까요` 는 화제가 아니라 말투입니다.

    안 걸러 내면 아무 회의에나 나오는 말이 겹침으로 세어지고, 근거에
    "이 구간이 반복인 이유: 합시다" 같은 것이 적힙니다.
    """
    words = content_words("그렇게 하는 게 좋겠습니다 그럼 합시다")
    for noise in ("좋겠습니다", "합시다", "그럼"):
        assert noise not in words, noise


def test_nouns_that_look_like_predicates_survive():
    """⚠️ **명사를 지우면 안 됩니다.**"""
    words = content_words("설계자와 기획자가 회의에 왔습니다")
    assert "설계자" in words
    assert "기획자" in words


def test_english_is_folded_to_lowercase():
    """`JWT` 와 `jwt` 가 다른 낱말이면 같은 논의가 안 겹쳐 보입니다."""
    assert content_words("JWT") == content_words("jwt")


def test_hangul_is_not_matched_with_a_word_class():
    """⚠️ `\\w` 로 자르면 한글이 통째로 빠지는 구현이 있습니다 (`AGENTS.md`)."""
    assert content_words("로그인") == {"로그인"}


def test_filler_words_are_dropped():
    assert content_words("그거 이거 저거 지금 일단") == set()


# ══════════════════════════════════════════════════════════════
# 구간 나누기
# ══════════════════════════════════════════════════════════════


def test_passages_group_by_time():
    blocks = passages([said(1, 0, "가"), said(2, 1, "나"), said(3, 10, "다")])
    assert [len(b.said) for b in blocks] == [2, 1]


def test_passages_sort_what_comes_in_unordered():
    blocks = passages([said(2, 10, "나"), said(1, 0, "가")])
    assert blocks[0].ids == [1]


def test_nothing_said_is_no_passages():
    assert passages([]) == []


# ══════════════════════════════════════════════════════════════
# AI-REVIEW-001 반복 논의
# ══════════════════════════════════════════════════════════════


def repeated_meeting() -> list[Said]:
    return [
        said(1, 0, "로그인 인증 방식을 JWT로 정할까요"),
        said(2, 1, "JWT 인증이 로그인에 맞습니다"),
        said(3, 12, "배포 파이프라인 깃허브 액션 얘기"),
        said(4, 13, "배포는 깃허브 액션 파이프라인으로"),
        said(5, 25, "다시 로그인 인증 JWT 인데요"),
        said(6, 26, "JWT 인증 로그인 만료 시간"),
    ]


def test_the_same_topic_coming_back_is_found():
    found = find_repeated_discussion(repeated_meeting())
    assert len(found) == 1
    assert found[0].event_type == "repeated_discussion"
    assert set(found[0].detail["shared_words"]) >= {"로그인", "인증", "jwt"}


def test_the_finding_points_at_both_passages():
    """⭐ 근거가 **양쪽**을 가리켜야 합니다.

    한쪽만 주면 "무엇의 반복인가" 를 알 수 없고, 반박할 수 없는 지적은
    그냥 잔소리입니다.
    """
    found = find_repeated_discussion(repeated_meeting())
    assert set(found[0].evidence) >= {1, 2, 5, 6}


def test_talking_about_one_thing_for_a_while_is_not_repetition():
    """⭐ **붙어 있는 덩어리는 안 셉니다.**

    회의는 원래 한 화제를 몇 분씩 이어서 합니다. 그걸 반복이라고 하면
    모든 회의가 걸리고, 그러면 아무도 이 화면을 안 봅니다.
    """
    straight = [said(i, i * 0.5, "로그인 인증 JWT 방식") for i in range(1, 9)]
    assert find_repeated_discussion(straight) == []


def test_one_word_in_common_is_not_a_topic():
    """⭐ 낱말 하나로 걸리면 안 됩니다."""
    thin = [
        said(1, 0, "로그인 화면 색깔"),
        said(2, 12, "배포 서버 용량"),
        said(3, 25, "로그인 버튼 크기"),
    ]
    assert find_repeated_discussion(thin) == []


def test_a_quiet_meeting_produces_nothing():
    assert find_repeated_discussion([]) == []
    assert find_repeated_discussion([said(1, 0, "안녕하세요")]) == []


def test_findings_are_capped():
    """⚠️ 스무 개가 나오면 그건 목록이지 지적이 아닙니다."""
    many: list[Said] = []
    for block in range(14):
        many.append(said(block * 2 + 1, block * 12, "로그인 인증 JWT 만료 토큰"))
        many.append(said(block * 2 + 2, block * 12 + 1, "JWT 로그인 인증 토큰 만료"))
    assert len(find_repeated_discussion(many)) <= 5


# ══════════════════════════════════════════════════════════════
# AI-REVIEW-003 주제 이탈
# ══════════════════════════════════════════════════════════════


def test_a_detour_between_two_on_topic_stretches_is_found():
    drifting = [
        said(1, 0, "로그인 인증 JWT 방식 정리"),
        said(2, 1, "로그인 인증 토큰 만료"),
        said(3, 12, "점심 메뉴 뭐 먹을까 김치찌개 파스타"),
        said(4, 13, "파스타 말고 김치찌개 어때 메뉴"),
        said(5, 25, "로그인 인증 JWT 다시 정리"),
        said(6, 26, "인증 토큰 로그인 만료"),
    ]
    found = find_topic_drift(drifting)
    assert len(found) == 1
    assert found[0].event_type == "topic_drift"
    assert set(found[0].evidence) == {3, 4}


def test_a_new_topic_at_the_end_is_not_drift():
    """⭐ 회의 끝에 다음 안건을 얘기하는 것을 "주제 이탈" 이라 하면 안 됩니다.

    양옆이 본줄기여야 **샜다가 돌아온** 것입니다.
    """
    ending = [
        said(1, 0, "로그인 인증 JWT 방식"),
        said(2, 1, "로그인 인증 토큰"),
        said(3, 12, "로그인 인증 만료"),
        said(4, 25, "점심 메뉴 김치찌개 파스타 얘기"),
    ]
    assert find_topic_drift(ending) == []


def test_a_short_aside_is_not_drift():
    """⚠️ 잠깐 곁말한 것까지 잡으면 시끄럽습니다."""
    aside = [
        said(1, 0, "로그인 인증 JWT"),
        said(2, 1, "로그인 인증 토큰"),
        Said(3, 12 * M, 12 * M + 5_000, "커피 한잔"),
        said(4, 25, "로그인 인증 JWT"),
        said(5, 26, "로그인 인증 토큰"),
    ]
    assert find_topic_drift(aside) == []


def test_a_meeting_too_short_to_have_sides_produces_nothing():
    assert find_topic_drift([said(1, 0, "가"), said(2, 12, "나")]) == []


# ══════════════════════════════════════════════════════════════
# AI-REVIEW-004 미완성 업무
# ══════════════════════════════════════════════════════════════


def test_a_promise_that_became_no_candidate_is_found():
    """⭐ 약속은 있는데 **후보조차 안 만들어진** 것.

    담당자·마감일이 비었는지는 승인 화면이 봅니다. 여기서 보는 것은 그
    앞 단계입니다 — 후보가 없으면 **막을 것도 없어서** 조용히 사라집니다.
    """
    talk = [
        said(1, 0, "제가 로그인 API 하겠습니다", label="commitment"),
        said(2, 1, "저는 회원가입 화면 맡을게요", label="commitment"),
    ]
    found = find_incomplete_tasks(talk, candidate_evidence={1})
    assert len(found) == 1
    assert found[0].evidence == [2]
    assert found[0].detail["count"] == 1


def test_promises_that_all_became_candidates_are_quiet():
    talk = [said(1, 0, "제가 하겠습니다", label="commitment")]
    assert find_incomplete_tasks(talk, candidate_evidence={1}) == []


def test_only_promises_count_here():
    """⚠️ 질문이나 의견이 후보가 안 됐다고 미완성 업무는 아닙니다."""
    talk = [said(1, 0, "이거 어떻게 하죠", label="question")]
    assert find_incomplete_tasks(talk, candidate_evidence=set()) == []


def test_the_detail_does_not_copy_the_words():
    """⭐ 원문을 베끼면 발화를 고쳤을 때 **옛말이 남습니다.**"""
    talk = [said(1, 0, "제가 로그인 API 하겠습니다", label="commitment")]
    found = find_incomplete_tasks(talk, candidate_evidence=set())
    assert "로그인" not in repr(found[0].detail)


# ══════════════════════════════════════════════════════════════
# AI-REVIEW-006 결정 번복
# ══════════════════════════════════════════════════════════════


def test_an_explicitly_superseded_decision_is_found():
    """⭐ `supersedes_id` 는 채워져도 **읽는 곳이 0곳**이었습니다."""
    decisions = [
        Decided(id=1, content="배포는 매주 금요일", evidence=[10], start_ms=0, end_ms=1),
        Decided(
            id=2,
            content="배포 주기를 격주로 바꿉니다",
            supersedes_id=1,
            evidence=[20],
            start_ms=5,
            end_ms=6,
        ),
    ]
    found = find_decision_conflicts(decisions)
    assert len(found) == 1
    assert found[0].detail["how"] == "supersedes"
    assert found[0].detail["superseded_decision_id"] == 1
    assert set(found[0].evidence) == {10, 20}


def test_decisions_about_the_same_thing_are_found_without_a_hint():
    """LLM 이 못 잡았거나 안 돌았을 때의 기준선."""
    decisions = [
        Decided(id=1, content="인증 토큰 만료는 30분", start_ms=0, end_ms=1),
        Decided(id=2, content="인증 토큰 만료를 60분으로", start_ms=5, end_ms=6),
    ]
    found = find_decision_conflicts(decisions)
    assert len(found) == 1
    assert found[0].detail["how"] == "wording"


def test_the_same_pair_is_reported_once():
    """⚠️ 두 갈래가 같은 것을 잡아도 한 번만 냅니다."""
    decisions = [
        Decided(id=1, content="인증 토큰 만료는 30분", start_ms=0, end_ms=1),
        Decided(
            id=2,
            content="인증 토큰 만료를 60분으로",
            supersedes_id=1,
            start_ms=5,
            end_ms=6,
        ),
    ]
    assert len(find_decision_conflicts(decisions)) == 1


def test_decisions_about_different_things_are_not_a_conflict():
    """⭐ 여기가 제일 시끄러운 오탐이 나는 자리라 **좁게** 잡습니다."""
    decisions = [
        Decided(id=1, content="인증 토큰 만료는 30분", start_ms=0, end_ms=1),
        Decided(id=2, content="배포는 깃허브 액션으로", start_ms=5, end_ms=6),
    ]
    assert find_decision_conflicts(decisions) == []


def test_one_decision_conflicts_with_nothing():
    assert find_decision_conflicts([Decided(id=1, content="배포는 금요일")]) == []


# ══════════════════════════════════════════════════════════════
# 넷 다 지켜야 하는 것
# ══════════════════════════════════════════════════════════════


def every_finding() -> list[Finding]:
    return [
        *find_repeated_discussion(repeated_meeting()),
        *find_topic_drift(
            [
                said(1, 0, "로그인 인증 JWT 방식 정리"),
                said(2, 1, "로그인 인증 토큰 만료"),
                said(3, 12, "점심 메뉴 뭐 먹을까 김치찌개 파스타"),
                said(4, 13, "파스타 말고 김치찌개 어때 메뉴"),
                said(5, 25, "로그인 인증 JWT 다시 정리"),
                said(6, 26, "인증 토큰 로그인 만료"),
            ]
        ),
        *find_incomplete_tasks(
            [said(1, 0, "제가 하겠습니다", label="commitment")],
            candidate_evidence=set(),
        ),
        *find_decision_conflicts(
            [
                Decided(id=1, content="인증 토큰 만료는 30분", start_ms=0, end_ms=1),
                Decided(id=2, content="인증 토큰 만료를 60분으로", start_ms=5, end_ms=6),
            ]
        ),
    ]


def test_nothing_is_ever_louder_than_info():
    """⭐ **회의를 빨갛게 칠하지 않습니다.**

    이 값들은 규칙 기반 추정이고, 등급을 매기는 순간 팀에 대한 판정으로
    읽힙니다. 등급은 사람이 매깁니다 (`AGENTS.md` 불변식 4).
    """
    for finding in every_finding():
        assert finding.severity == "info", finding.event_type


def test_every_finding_points_at_something_you_can_open():
    """⭐ 근거 없는 지적은 반박할 수 없고, 반박할 수 없으면 잔소리입니다.

    ⚠️ **이 검사가 진짜 결함을 잡았습니다.** 결정 번복은 결정에 근거 발화가
    안 붙어 있으면 `evidence` 가 빈 채로 나갔습니다 — 화면에는 "결정이
    번복됐습니다" 만 뜨고 어느 결정인지 볼 방법이 없었습니다. 이 저장소의
    대표 실패 ③("할 일을 알려 주고 그 일을 할 자리를 안 줌") 입니다.
    """
    for finding in every_finding():
        pointers = list(finding.evidence) + list(finding.detail.get("decision_ids", []))
        assert pointers, f"{finding.event_type}: 가리키는 것이 하나도 없습니다"


def test_no_span_runs_backwards():
    for finding in every_finding():
        assert finding.end_ms >= finding.start_ms, finding.event_type


def test_the_detectors_never_name_a_person():
    """⭐ 이건 **회의**에 대한 관찰이지 사람에 대한 것이 아닙니다.

    사람 id 가 결과에 실리면 화면이 그걸로 "누가 회의를 늘어지게
    했는가" 를 만들 수 있습니다.
    """
    for finding in every_finding():
        flat = repr(finding.detail)
        for word in ("speaker", "user", "화자", "담당"):
            assert word not in flat, f"{finding.event_type}: {word}"
