"""회의 처리 파이프라인의 단계 인터페이스.

docs/03-시스템-아키텍처.md §3

각 단계를 Protocol 로 분리한 이유:
    1. **GPU 없이 오케스트레이션을 검증**할 수 있다. 진행률 보고, GPU 락,
       실패 격리, 멱등성은 실제 모델 없이도 테스트해야 한다.
    2. 배치 전략(순차 적재 / CPU 이관)을 바꿔도 호출부가 안 바뀐다.
    3. 실제 구현이 무거워서 import 만으로 수 초가 걸린다. 테스트에서는 그걸 피한다.

⚠️ 실제 GPU 구현(`asr.py`, `diarize.py`)은 이 개발 환경에 모델도 GPU도 없어
**아직 없습니다.** 인터페이스만 확정해 두고 실제 머신에서 붙입니다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

import numpy as np


@dataclass(frozen=True, slots=True)
class LoadedTrack:
    """디코딩된 트랙 하나."""

    track_id: int
    user_id: int
    samples: np.ndarray
    sample_rate: int
    started_at_offset_sec: float = 0.0  # 서버 타임스탬프 기준 상대 시작 시각


@dataclass(frozen=True, slots=True)
class TranscribedSegment:
    """ASR 결과 한 조각."""

    user_id: int
    track_id: int | None
    start_ms: int
    end_ms: int
    text: str
    confidence: float = 1.0
    is_overlap: bool = False
    # track   : 멀티트랙 → 화자 확정
    # manual  : 사람이 지정
    # diarization : SPEAKER_XX 미매핑
    speaker_source: str = "track"


class AudioLoader(Protocol):
    """저장된 오디오를 디코딩해 numpy 배열로."""

    def load(self, meeting_id: int) -> list[LoadedTrack]: ...


class Transcriber(Protocol):
    """ASR. 실제 구현은 Qwen3-ASR-1.7B (GPU)."""

    def transcribe(
        self, samples: np.ndarray, sample_rate: int, *, language: str = "ko"
    ) -> list[tuple[int, int, str, float]]:
        """Returns: (start_ms, end_ms, text, confidence) 목록"""
        ...


class Diarizer(Protocol):
    """화자 분리. 단일 마이크(모드 B) 폴백에서만 쓴다.

    멀티트랙(모드 A)이면 트랙이 곧 화자라 필요 없다.
    """

    def diarize(
        self, samples: np.ndarray, sample_rate: int, *, num_speakers: int | None = None
    ) -> list[tuple[int, int, int]]:
        """Returns: (start_ms, end_ms, speaker_index) 목록"""
        ...


class MeetingAnalyzer(Protocol):
    """LLM 분석. `meeting.llm.LLMClient` 를 감싼다."""

    def analyze(
        self,
        utterances: list[tuple[int, str, str]],
        *,
        prior_decisions: list[str] | None = None,
        open_tasks: list[str] | None = None,
    ): ...


class ProgressReporter(Protocol):
    """진행률 보고. 1시간 회의 처리에 10분이 걸릴 수 있어 필수다."""

    def report(self, meeting_id: int, stage: str, percent: int, detail: str = "") -> None: ...


@dataclass
class NullProgress:
    """테스트·CLI용. 보고 내역을 그대로 들고 있는다."""

    events: list[tuple[int, str, int, str]] = field(default_factory=list)

    def report(self, meeting_id: int, stage: str, percent: int, detail: str = "") -> None:
        self.events.append((meeting_id, stage, percent, detail))

    @property
    def stages(self) -> list[str]:
        return [e[1] for e in self.events]

    @property
    def percents(self) -> list[int]:
        return [e[2] for e in self.events]


@dataclass
class RedisProgress:
    """Redis 해시에 진행률을 쓴다. API가 SSE로 프런트에 흘린다."""

    client: object
    ttl: int = 86_400

    def report(self, meeting_id: int, stage: str, percent: int, detail: str = "") -> None:
        key = f"teamflow:meeting:{meeting_id}:progress"
        self.client.hset(  # type: ignore[attr-defined]
            key, mapping={"stage": stage, "percent": percent, "detail": detail}
        )
        self.client.expire(key, self.ttl)  # type: ignore[attr-defined]
