"""pyannote.audio 기반 실기기 화자 분리(Diarization) 구현체.

docs/04-회의-처리-파이프라인.md §2, docs/09-리스크와-검증-실험.md 실험 2.

`Diarizer` Protocol 구현체:
- 모델: `pyannote/speaker-diarization-3.1` (또는 `pyannote/speaker-diarization-community-1`)
- 16kHz 모노 float32 numpy 오디오 입력
- 반환값: (start_ms, end_ms, speaker_index) 목록 (시간순 정렬)
- GPU(CUDA) 가속 지원, 미지원 시 CPU 폴백
- Gated model: Hugging Face Access Token (`HF_TOKEN`) 필수
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)


@dataclass
class PyannoteDiarizer:
    """pyannote.audio 기반 실기기 화자 분리기.

    메모리와 GPU 리소스 절약을 위해 첫 호출(`diarize`) 전까지는
    파이프라인을 메모리에 올리지 않고 지연 적재(lazy loading)합니다.
    """

    model_id: str = "pyannote/speaker-diarization-3.1"
    token: str | None = None
    device: str | None = None
    _pipeline: Any = field(default=None, repr=False, init=False)

    def _ensure_loaded(self) -> None:
        """pyannote 파이프라인 모델을 메모리에 적재합니다."""
        if self._pipeline is not None:
            return

        os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

        try:
            import torch
            from pyannote.audio import Pipeline
        except ImportError as exc:
            raise ImportError(
                "pyannote.audio 패키지가 설치되지 않았습니다.\n"
                ".venv\\Scripts\\python.exe -m pip install pyannote.audio\n"
            ) from exc

        auth_token = self.token or os.environ.get("HF_TOKEN")
        if not auth_token:
            try:
                from teamflow.config import get_settings

                auth_token = get_settings().hf_token
            except Exception:
                pass
        if not auth_token:
            raise ValueError(
                f"pyannote 모델({self.model_id})을 로드하려면 "
                "Hugging Face 토큰(HF_TOKEN)이 필요합니다.\n"
                "1. https://huggingface.co/pyannote/speaker-diarization-3.1 및\n"
                "   https://huggingface.co/pyannote/segmentation-3.0 "
                "에서 라이선스 동의(Accept conditions)\n"
                "2. https://huggingface.co/settings/tokens 에서 Read 권한 토큰 발급\n"
                "3. .env 파일에 HF_TOKEN=hf_xxxx 설정\n"
            )

        if self.device is None:
            self.device = "cuda" if torch.cuda.is_available() else "cpu"

        logger.info(
            "pyannote 화자 분리 모델 로드 시작: model=%s, device=%s",
            self.model_id,
            self.device,
        )

        try:
            pipeline = Pipeline.from_pretrained(self.model_id, token=auth_token)
        except TypeError:
            # 구버전 pyannote.audio 호환
            pipeline = Pipeline.from_pretrained(self.model_id, use_auth_token=auth_token)

        if pipeline is None:
            raise RuntimeError(
                f"pyannote 파이프라인 로드 실패: {self.model_id}. "
                "토큰 권한 또는 모델 라이선스 동의 여부를 확인하세요."
            )

        pipeline.to(torch.device(self.device))
        self._pipeline = pipeline
        logger.info("pyannote 화자 분리 모델 로드 완료")

    def diarize(
        self, samples: np.ndarray, sample_rate: int, *, num_speakers: int | None = None
    ) -> list[tuple[int, int, int]]:
        """오디오 샘플을 분석하여 (start_ms, end_ms, speaker_index) 목록을 반환합니다."""
        if samples is None or samples.size == 0:
            return []

        self._ensure_loaded()

        import torch

        # 모노 1채널 텐서로 변환: (1, time)
        if samples.ndim > 1:
            samples = samples.mean(axis=1)

        waveform = torch.from_numpy(samples.astype(np.float32)).unsqueeze(0)
        audio_input = {"waveform": waveform, "sample_rate": sample_rate}

        kwargs = {}
        if num_speakers is not None and num_speakers > 0:
            kwargs["num_speakers"] = num_speakers

        diarization_result = self._pipeline(audio_input, **kwargs)

        # pyannote 4.x(DiarizeOutput) 및 3.x(Annotation) 호환 처리
        annotation = getattr(diarization_result, "speaker_diarization", diarization_result)

        # pyannote Annotation 객체에서 세그먼트와 화자 라벨 추출
        speaker_label_to_index: dict[str, int] = {}
        segments: list[tuple[int, int, int]] = []

        # itertracks(yield_label=True) yields (segment, track_id, label)
        for turn, _, speaker_label in annotation.itertracks(yield_label=True):
            if speaker_label not in speaker_label_to_index:
                speaker_label_to_index[speaker_label] = len(speaker_label_to_index)
            speaker_idx = speaker_label_to_index[speaker_label]

            start_ms = max(0, int(turn.start * 1000))
            end_ms = max(start_ms, int(turn.end * 1000))
            if end_ms > start_ms:
                segments.append((start_ms, end_ms, speaker_idx))

        # 시작 시각 기준 정렬
        segments.sort(key=lambda s: (s[0], s[1]))
        return segments
