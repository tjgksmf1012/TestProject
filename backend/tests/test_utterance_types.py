"""발언 유형 분류 — 규칙 기반 기준선.

이 파일이 고정하는 것: **애매한 발언에 점수를 주지 않는가.**

`decision` 은 5.0 점, `commitment` 는 최대 6.0 점입니다. 규칙이 넓게
잡으면 "그렇게 하면 좋겠네요"(의견, 1.0)가 결정(5.0)이 되고, 그 숫자가
성적에 쓰입니다. **틀린 라벨은 조용히 점수가 됩니다.**
"""

from __future__ import annotations

import pytest

from teamflow.meeting.utterance_types import (
    ANSWER,
    COMMITMENT,
    DECISION,
    LABELS,
    MIN_CONFIDENCE,
    OPINION,
    OTHER,
    PROPOSAL,
    QUESTION,
    SOCIAL,
    ZERO_SCORE,
    Classification,
    apply_floor,
    classify,
    classify_by_rules,
    is_scored,
)


def label_of(text: str) -> str:
    return classify(text).label


# ══════════════════════════════════════════════════════════════
# 라벨 체계 자체
# ══════════════════════════════════════════════════════════════


def test_the_labels_are_the_eight_that_docs_10_settled_on():
    """제안서의 15개를 8개로 병합한 것입니다 (docs/10 Q9).

    여기가 늘어나면 `scoring.py` 의 `EventType` 과 어긋나고, 어긋난 라벨은
    **점수 계산에서 조용히 빠집니다.**
    """
    assert set(LABELS) == {
        "question",
        "answer",
        "proposal",
        "opinion",
        "decision",
        "commitment",
        "social",
        "other",
    }


def test_every_label_maps_to_a_contribution_event_type():
    """⭐ 라벨과 이벤트 타입이 어긋나면 그 발언은 점수에서 사라집니다."""
    from teamflow.contribution.events import EventType

    for label in LABELS:
        EventType(f"utt_{label}")


def test_social_and_other_are_the_zero_score_labels():
    assert {SOCIAL, OTHER} == ZERO_SCORE
    assert not is_scored(SOCIAL)
    assert not is_scored(OTHER)
    assert not is_scored(None)
    assert is_scored(DECISION)


# ══════════════════════════════════════════════════════════════
# ⭐ 맞장구를 걸러 내는가 — 이걸 놓치면 "네" 백 번이 기여가 된다
# ══════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    "text",
    ["네", "넵", "예", "응", "음", "ㅋㅋ", "ㅎㅎ", "네.", "네~", "맞아요", "맞습니다",
     "그러네요", "그렇죠", "그쵸", "알겠습니다", "감사합니다", "수고하셨습니다", "안녕하세요"],
)
def test_backchannel_scores_nothing(text):
    """⭐ **이걸 안 걸러 내면 "네" 를 백 번 말한 사람이 기여자가 됩니다.**"""
    assert label_of(text) == SOCIAL
    assert not is_scored(label_of(text))


def test_a_real_sentence_that_starts_with_a_backchannel_is_not_social():
    """"네, 그럼 그렇게 하죠" 는 맞장구가 아니라 결정입니다."""
    assert label_of("네, 그럼 로그인부터 하기로 하죠") == DECISION


# ══════════════════════════════════════════════════════════════
# 비싼 라벨 — 좁게 잡는가
# ══════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    "text",
    [
        "그럼 로그인 API 부터 하기로 하죠",
        "그러면 이번 주는 스키마 정리로 갑시다",
        "PostgreSQL 로 확정하겠습니다",
        "일정은 다음 주 금요일로 결정했습니다",
    ],
)
def test_decisions_are_recognized(text):
    assert label_of(text) == DECISION


@pytest.mark.parametrize(
    "text",
    [
        "그렇게 하면 좋을 것 같아요",
        "그게 나을 것 같습니다",
        "제 생각에는 괜찮을 것 같아요",
    ],
)
def test_a_soft_evaluation_is_an_opinion_not_a_decision(text):
    """⭐ **1.0 점과 5.0 점의 차이입니다.**

    "~하면 좋을 것 같아요" 는 결정이 아니라 의견입니다. 이걸 결정으로
    잡으면 말끝을 흐리는 사람이 회의를 주도한 것으로 나옵니다.
    """
    assert label_of(text) == OPINION


@pytest.mark.parametrize(
    "text",
    [
        "제가 로그인 API 를 맡겠습니다",
        "내가 금요일까지 끝내겠습니다",
        "다음 주 화요일까지 초안 드릴게요",
        "그 부분은 제가 처리하겠습니다",
    ],
)
def test_commitments_are_recognized(text):
    assert label_of(text) == COMMITMENT


def test_someone_elses_task_is_not_my_commitment():
    """⭐ "민수가 하면 좋겠어요" 는 **내** 약속이 아닙니다.

    이걸 약속으로 잡으면 남에게 일을 미룬 사람이 점수를 받습니다.
    """
    assert label_of("민수 씨가 로그인을 맡으면 좋겠어요") == OPINION


@pytest.mark.parametrize(
    "text",
    ["로그인부터 하는 게 어때요?", "스키마를 먼저 정리하면 어떨까요?", "이번 주에 배포해볼까요?"],
)
def test_proposals_are_recognized(text):
    assert label_of(text) == PROPOSAL


@pytest.mark.parametrize(
    "text",
    [
        "마감이 언제인가요?",
        "이거 누가 맡기로 했죠?",
        "어디까지 진행됐나요?",
        "왜 이렇게 느린 거죠?",
    ],
)
def test_questions_are_recognized(text):
    assert label_of(text) == QUESTION


def test_answers_are_recognized():
    assert label_of("확인해 보니 마감은 다음 주 금요일입니다") == ANSWER
    assert label_of("현재 테스트는 전부 통과합니다") == ANSWER


# ══════════════════════════════════════════════════════════════
# ⭐ 모르면 점수를 주지 않는다
# ══════════════════════════════════════════════════════════════


def test_when_no_rule_matches_it_says_other_instead_of_guessing():
    """⚠️ 아무 라벨이나 찍으면 근거 없는 점수가 생깁니다."""
    result = classify("어... 그 뭐냐 그거 있잖아요 왜 저번에")
    assert result.label == OTHER
    assert not is_scored(result.label)


def test_a_low_confidence_guess_falls_to_other():
    """⭐ 확신 하한. 애매한 것에 5점을 주면 안 됩니다."""
    weak = Classification(DECISION, 0.4, "약한 신호")
    floored = apply_floor(weak)
    assert floored.label == OTHER
    # 원래 무엇으로 보였는지는 남깁니다 — 사람이 고칠 수 있어야 합니다.
    assert DECISION in floored.reason


def test_the_floor_does_not_touch_confident_labels():
    strong = Classification(DECISION, 0.9, "결정 어미")
    assert apply_floor(strong).label == DECISION


def test_the_floor_leaves_zero_score_labels_alone():
    """`social` 은 확신이 낮아도 `other` 로 바꿀 이유가 없습니다.

    둘 다 0점이고, "맞장구였다" 가 "모르겠다" 보다 사람에게 더 쓸모 있습니다.
    """
    weak_social = Classification(SOCIAL, 0.3, "약한 신호")
    assert apply_floor(weak_social).label == SOCIAL


def test_empty_and_whitespace_are_other():
    assert classify("").label == OTHER
    assert classify("   ").label == OTHER


def test_very_short_fragments_are_other_not_a_guess():
    """한두 글자로 화행을 판단할 수 없습니다."""
    assert classify("그거").label == OTHER


def test_every_result_carries_a_reason():
    """근거 없이 라벨만 주면 틀린 것을 고칠 수 없습니다."""
    for text in ["네", "그럼 그렇게 하죠", "제가 하겠습니다", "언제까지인가요?", "음냐리"]:
        assert classify(text).reason


def test_every_result_records_which_classifier_made_it():
    """⭐ 규칙으로 매긴 것과 학습 모델로 매긴 것은 **신뢰도가 달라야** 합니다."""
    assert classify("그럼 그렇게 하죠").classifier == "rules"


def test_confidence_is_always_a_real_probability():
    for text in ["", "네", "그럼 그렇게 하죠", "제가 하겠습니다", "어쩌구저쩌구"]:
        assert 0.0 <= classify(text).confidence <= 1.0


def test_the_floor_constant_is_actually_used():
    """⚠️ 상수만 있고 안 쓰면 하한이 없는 것과 같습니다."""
    just_below = Classification(DECISION, MIN_CONFIDENCE - 0.01, "x")
    just_above = Classification(DECISION, MIN_CONFIDENCE, "x")
    assert apply_floor(just_below).label == OTHER
    assert apply_floor(just_above).label == DECISION


def test_classify_by_rules_is_reachable_without_the_floor():
    """실험에서 기준선 성능을 재려면 하한 없는 원본이 필요합니다."""
    raw = classify_by_rules("음... 아마도요")
    assert raw.label in LABELS
