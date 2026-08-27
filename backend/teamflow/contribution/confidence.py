"""신뢰도 계산.

docs/05-기여도-산정-설계.md §4.1

"신뢰도 보통"은 느낌이 아니라 **데이터 커버리지에서 나오는 계산값**이어야 한다.
그리고 왜 낮은지를 화면에 그대로 노출한다 — 그러면 사용자가 데이터를 채운다.
"""

from __future__ import annotations

from dataclasses import dataclass, field


def _ratio(numerator: int, denominator: int) -> float | None:
    if denominator <= 0:
        return None
    return max(0.0, min(1.0, numerator / denominator))


@dataclass(frozen=True, slots=True)
class CoverageStats:
    """신뢰도의 입력. 프로젝트 전체 기준으로 집계한다."""

    meetings_total: int = 0
    meetings_recorded: int = 0

    utterances_total: int = 0
    # speaker_source 가 'track'(멀티트랙) 또는 'manual'(사람이 지정)인 발화 수.
    # 'diarization'(SPEAKER_XX 미매핑)은 불확실한 것으로 본다.
    utterances_speaker_certain: int = 0

    # 녹음 트랙 품질. 폰이 잠기면 그 사람 트랙에 구멍이 뚫린다 (docs/04 §2.6).
    #
    # ⚠️ 이 신호가 없으면 **망가진 녹음이 오히려 높은 신뢰도로 보인다.**
    # 멀티트랙에서는 트랙이 곧 사람이라 화자 확정도(speaker_certainty)가 항상
    # 1.0 이기 때문이다. 40%만 녹음된 회의도 "화자가 전부 확정됨"으로 잡힌다.
    tracks_total: int = 0
    tracks_usable: int = 0

    # 발언 유형을 무엇이 매겼는가.
    #
    # ⚠️ 이 신호가 없으면 **규칙 기반 기준선으로 매긴 회의가 학습 모델로
    # 매긴 회의와 똑같은 신뢰도로 보입니다.** 규칙은 문말 어미만 보므로
    # 반어·인용·농담을 구분하지 못하고, 그 오차가 그대로 회의 기여도에
    # 들어갑니다. 얼마나 믿을 만한 근거로 계산했는지가 곧 신뢰도입니다.
    #
    # 분모는 **점수가 매겨진 발화**입니다. `social`·`other` 는 어차피
    # 0점이라 분류가 틀려도 점수가 안 움직입니다.
    utterances_scored: int = 0
    utterances_model_classified: int = 0

    project_days: int = 0
    github_connected_days: int = 0

    peer_reviews_expected: int = 0
    peer_reviews_submitted: int = 0


@dataclass(frozen=True, slots=True)
class ConfidenceBreakdown:
    """신뢰도와 그 근거. 화면에 그대로 노출한다."""

    value: float
    components: dict[str, float] = field(default_factory=dict)
    reasons: list[str] = field(default_factory=list)

    @property
    def label(self) -> str:
        if self.value >= 0.85:
            return "높음"
        if self.value >= 0.60:
            return "보통"
        if self.value >= 0.35:
            return "낮음"
        return "매우 낮음"


# 각 커버리지 신호의 상대 중요도.
_WEIGHTS: dict[str, float] = {
    "meeting_recording": 1.0,
    "speaker_certainty": 1.5,  # 화자 오류는 기여도로 직접 전파되므로 가중치가 높다
    "track_quality": 1.5,  # 끊긴 트랙도 마찬가지다 — 안 들린 말은 세지지 않는다
    # 화자 오류와 같은 이유로 높다. 발언 유형이 틀리면 1.0점짜리 의견이
    # 5.0점짜리 결정이 되고, 그 오차가 그대로 회의 기여도가 된다.
    "utterance_classification": 1.5,
    "github_coverage": 1.0,
    "peer_completion": 0.5,
}

#: ⚠️ **이 문장들은 「팀 전체」에 대한 것입니다** (결함 344).
#:
#: `compute_confidence` 는 팀 하나의 `CoverageStats` 를 받아 **한 벌**을
#: 돌려주고, `scoring.py` 는 그것을 사람 수만큼 복사해 붙입니다. 그래서
#: 세 사람의 `confidence_reasons` 는 글자 하나까지 같습니다.
#:
#: 그런데 화면과 보고서는 그 목록을 **사람 이름 밑에** 그립니다. 문장이
#: 「해당 팀원」처럼 사람을 가리키면 받는 이가 없어서, 읽는 사람은 카드의
#: 주인을 가리킨다고 읽습니다 — 커버리지 1.0 인 김민수의 최종 보고서가
#: 「해당 팀원의 발언량은 측정할 수 없습니다」라고 적었습니다. 바로 세 줄
#: 위에서 「근거 11건」이라고 해 놓고서입니다.
#:
#: **여기서는 사람을 가리키지 않습니다.** 누가 못 잰 것인지는 그 사람의
#: `measurement_gaps` 가 따로 말합니다.
_REASON_TEXT: dict[str, str] = {
    "meeting_recording": "녹음되지 않은 회의가 있습니다",
    "speaker_certainty": "화자가 확정되지 않은 발화가 있습니다",
    "track_quality": "녹음이 끊긴 트랙이 있습니다 — 그 트랙에 담긴 발언은 세지 못했습니다",
    "utterance_classification": (
        "발언 유형을 규칙 기반 기준선으로 매겼습니다 — 반어·인용·농담을 구분하지 못합니다"
    ),
    "github_coverage": "GitHub 연결 이전 기간의 활동이 누락되었습니다",
    "peer_completion": "동료평가 미제출자가 있습니다",
}

#: 녹음했다는 회의에서 발언이 한 건도 안 나온 경우 (결함 428).
#:
#: 이때는 `_REASON_TEXT` 의 두 문장이 **거짓**입니다 — "화자가 확정되지
#: 않은 발화가 있습니다" 라고 하려면 발화가 있어야 합니다. 낱말은 이
#: 제품이 같은 상태를 부르는 말과 맞춥니다 (홈 `next.ts` · 회의록
#: `minutes.py`).
_SILENT_RECORDING_REASON = (
    "오간 말이 하나도 기록되지 않은 회의가 있습니다 — 그 회의의 발언은 세지 못했습니다"
)


def silent_recordings(stats: CoverageStats) -> bool:
    """녹음했다는 회의가 있는데 발언이 **한 건도** 안 나왔는가 (결함 428).

    ⚠️ **분모 0 에는 두 뜻이 있습니다.**

    `compute_confidence` 는 분모가 0 인 신호를 계산에서 뺍니다. 그 규칙은
    **모듈을 안 쓰는 팀**을 위한 것입니다 — 동료평가를 안 하는 팀이 그
    항목 때문에 깎이면 안 됩니다 (결함 105 가 같은 자리에서 정한 것).

    그런데 `utterances_total == 0` 은 그 뜻이 아닐 수 있습니다. 녹음을
    했다는 회의가 있는데 발언이 0 건이면 그건 **모듈 미사용이 아니라
    측정 실패**입니다. 가르지 않으면 전사 품질을 재는 두 신호
    (`speaker_certainty` · `utterance_classification`, 합쳐서 가중치 6.0 중
    3.0) 가 **바로 그 실패에서만** 통째로 사라집니다:

        녹음됐고 말도 잡힌 회의   신뢰도 0.7273 「보통」  · 조정 폭 10.9%p
        녹음됐는데 말이 0 건      신뢰도 1.0000 「높음」  · 조정 폭  0.0%p · 사유 0건
        회의가 아예 없음          신뢰도 0.0000 「매우 낮음」· 조정 폭 40.0%p

    아무것도 못 들은 회의가 **완벽한 회의보다 높게** 나오고, 신뢰도 1.0 은
    `adjustment_range` 를 **한 점으로 접습니다** — 불변식 ②(단일 점수 금지:
    구간 + 신뢰도 + 사유 + 근거 건수)가 거기서 깨집니다. 사유도 빈 목록이라
    팀은 왜인지도 못 봅니다.

    ⚠️ 이 제품은 같은 상태를 **다른 두 곳에서 이미 알고 있습니다** — 홈은
    「오간 말이 하나도 기록되지 않았습니다」(결함 368), 회의록은 「오간 말이
    하나도 기록되지 않아 요약이 없습니다」(결함 369). 신뢰도만 그것을
    「완벽히 쟀다」로 읽고 있었습니다.

    ⚠️ **`utterances_scored == 0` 만으로는 판정하지 않습니다.** 발화는
    있는데 전부 `social`·`other` 인 회의(잡담만 한 회의)는 분류가 맞게 된
    것이라 깎으면 안 됩니다 — 그건 `utterance_classification` 의 주석이
    이미 정해 둔 것입니다.
    """
    return stats.meetings_recorded > 0 and stats.utterances_total == 0


def compute_confidence(stats: CoverageStats, *, threshold: float = 0.9) -> ConfidenceBreakdown:
    """커버리지 신호들의 가중 평균.

    데이터가 아예 없는 신호(분모 0)는 계산에서 제외한다.
    예를 들어 동료평가 모듈을 안 쓰는 팀은 그 항목 때문에 신뢰도가 깎이지 않는다.

    ⚠️ **다만 「안 쓰는 것」과 「못 잰 것」은 다릅니다** — `silent_recordings`
    를 보십시오 (결함 428).
    """
    silent = silent_recordings(stats)

    raw: dict[str, float | None] = {
        "meeting_recording": _ratio(stats.meetings_recorded, stats.meetings_total),
        # ⚠️ 녹음했다는데 발언이 0 건이면 **빼지 않고 0.0 으로 셉니다.**
        # 근거가 없으면 신뢰도가 내려가는 것이 정직한 방향이고, 내려가면
        # 조정 폭이 **넓어져** 팀이 정할 여지가 커집니다. 아무것도 없는
        # 팀(위 세 번째 줄)에 대해 이 함수가 이미 하고 있는 일입니다.
        "speaker_certainty": (
            0.0 if silent else _ratio(stats.utterances_speaker_certain, stats.utterances_total)
        ),
        "track_quality": _ratio(stats.tracks_usable, stats.tracks_total),
        "utterance_classification": (
            0.0 if silent else _ratio(stats.utterances_model_classified, stats.utterances_scored)
        ),
        "github_coverage": _ratio(stats.github_connected_days, stats.project_days),
        "peer_completion": _ratio(stats.peer_reviews_submitted, stats.peer_reviews_expected),
    }

    components = {k: v for k, v in raw.items() if v is not None}
    if not components:
        # 아무 데이터도 없음 — 점수를 낼 근거가 없다
        return ConfidenceBreakdown(
            value=0.0,
            components={},
            reasons=["수집된 활동 데이터가 없습니다"],
        )

    weighted_sum = sum(components[k] * _WEIGHTS[k] for k in components)
    weight_total = sum(_WEIGHTS[k] for k in components)
    value = weighted_sum / weight_total

    # ⚠️ 두 신호가 0.0 인 이유가 「발화가 아예 없다」면 `_REASON_TEXT` 의
    # 문장이 거짓입니다 — 없는 발화를 두고 「확정되지 않은 발화가 있습니다」
    # 라고 할 수는 없습니다. 한 문장으로 갈음합니다.
    quiet = {"speaker_certainty", "utterance_classification"}
    reasons = [
        _REASON_TEXT[k]
        for k, v in sorted(components.items())
        if v < threshold and not (silent and k in quiet)
    ]
    if silent:
        reasons.insert(0, _SILENT_RECORDING_REASON)

    return ConfidenceBreakdown(value=value, components=components, reasons=reasons)


# 신뢰도가 낮을수록 조정 범위가 넓어진다.
# 신뢰도 1.0 → 범위 없음, 0.0 → ±50% (상대)
RANGE_FACTOR = 0.5


def adjustment_range(share: float, confidence: float) -> tuple[float, float]:
    """팀장이 조정할 수 있는 범위.

    docs/05 §4의 "예상 기여도 27% / 조정 범위 22~32%" 를 만드는 계산.
    벗어나려면 사유를 적게 한다.
    """
    spread = share * (1.0 - confidence) * RANGE_FACTOR
    low = max(0.0, share - spread)
    high = min(100.0, share + spread)
    return (low, high)
