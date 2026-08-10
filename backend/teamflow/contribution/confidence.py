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

_REASON_TEXT: dict[str, str] = {
    "meeting_recording": "녹음되지 않은 회의가 있습니다",
    "speaker_certainty": "화자가 확정되지 않은 발화가 있습니다",
    "track_quality": "녹음이 끊긴 트랙이 있습니다 — 해당 팀원의 발언량은 측정할 수 없습니다",
    "utterance_classification": (
        "발언 유형을 규칙 기반 기준선으로 매겼습니다 — 반어·인용·농담을 구분하지 못합니다"
    ),
    "github_coverage": "GitHub 연결 이전 기간의 활동이 누락되었습니다",
    "peer_completion": "동료평가 미제출자가 있습니다",
}


def compute_confidence(stats: CoverageStats, *, threshold: float = 0.9) -> ConfidenceBreakdown:
    """커버리지 신호들의 가중 평균.

    데이터가 아예 없는 신호(분모 0)는 계산에서 제외한다.
    예를 들어 동료평가 모듈을 안 쓰는 팀은 그 항목 때문에 신뢰도가 깎이지 않는다.
    """
    raw: dict[str, float | None] = {
        "meeting_recording": _ratio(stats.meetings_recorded, stats.meetings_total),
        "speaker_certainty": _ratio(stats.utterances_speaker_certain, stats.utterances_total),
        "track_quality": _ratio(stats.tracks_usable, stats.tracks_total),
        "utterance_classification": _ratio(
            stats.utterances_model_classified, stats.utterances_scored
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

    reasons = [_REASON_TEXT[k] for k, v in sorted(components.items()) if v < threshold]

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
