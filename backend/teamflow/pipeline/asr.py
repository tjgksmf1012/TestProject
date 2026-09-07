"""Qwen3-ASR 음성 인식 구현체.

docs/04-회의-처리-파이프라인.md §2, docs/09-리스크와-검증-실험.md 실험 1.

`Transcriber` Protocol 구현체:
- 모델: `Qwen/Qwen3-ASR-1.7B-hf` (Transformers 5.13+ 네이티브 지원)
- 30초 초과 오디오는 20~25초 단위 청크로 분할하여 전사 및 타임스탬프 산출
- 16kHz 모노 float32 입력 전제 (필요시 torchaudio resample 자동 수행)
- GPU(Ada Lovelace / RTX 4090 FP16) 가속 지원, 미지원 시 CPU 폴백
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)

TARGET_SAMPLE_RATE = 16_000
MAX_CHUNK_DURATION_SEC = 25.0  # Qwen3-ASR 권장 청크 길이 (최대 30초)
MIN_SPEECH_DURATION_SEC = 0.2  # 200ms 미만은 잡음으로 간주

LANGUAGE_MAP: dict[str, str] = {
    "ko": "Korean",
    "en": "English",
    "zh": "Chinese",
    "ja": "Japanese",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "ru": "Russian",
    "korean": "Korean",
    "english": "English",
}


@dataclass
class Qwen3Transcriber:
    """Qwen3-ASR-1.7B-hf 기반 실기기 전사기.

    메모리 절약을 위해 실제 전사 호출(`transcribe`) 전까지는
    모델을 메모리에 올리지 않고 지연 적재(lazy loading)합니다.
    """

    model_id: str = "Qwen/Qwen3-ASR-1.7B-hf"
    device: str | None = None
    torch_dtype: Any = None
    _processor: Any = field(default=None, repr=False, init=False)
    _model: Any = field(default=None, repr=False, init=False)

    def _ensure_loaded(self) -> None:
        """모델과 프로세서를 메모리에 적재합니다."""
        if self._model is not None and self._processor is not None:
            return

        import os
        os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

        import torch
        from transformers import Qwen3ASRForConditionalGeneration, Qwen3ASRProcessor

        model_name = self.model_id
        if model_name in ("Qwen/Qwen3-ASR-1.7B", "Qwen/Qwen3-ASR-0.6B"):
            model_name = f"{model_name}-hf"

        if self.device is None:
            self.device = "cuda" if torch.cuda.is_available() else "cpu"

        if self.torch_dtype is None:
            self.torch_dtype = torch.float16 if self.device == "cuda" else torch.float32

        logger.info(
            "Qwen3-ASR 로드 시작: model=%s, device=%s, dtype=%s",
            model_name,
            self.device,
            self.torch_dtype,
        )

        self._processor = Qwen3ASRProcessor.from_pretrained(model_name)
        self._model = Qwen3ASRForConditionalGeneration.from_pretrained(
            model_name,
            torch_dtype=self.torch_dtype,
            device_map=self.device,
        )
        self._model.eval()
        logger.info("Qwen3-ASR 로드 완료")

    def transcribe(
        self, samples: np.ndarray, sample_rate: int, *, language: str = "ko"
    ) -> list[tuple[int, int, str, float]]:
        """오디오 샘플을 전사하여 (start_ms, end_ms, text, confidence) 목록을 반환합니다."""
        if samples is None or samples.size == 0:
            return []

        if samples.ndim > 1:
            samples = samples.mean(axis=1)

        max_amp = float(np.max(np.abs(samples))) if samples.size > 0 else 0.0
        if max_amp < 1e-4:
            return []

        total_duration_sec = len(samples) / sample_rate
        if total_duration_sec < MIN_SPEECH_DURATION_SEC:
            return []

        if sample_rate != TARGET_SAMPLE_RATE:
            self._ensure_loaded()
            import torch
            import torchaudio.functional as F

            tensor_samples = torch.from_numpy(samples).float()
            tensor_samples = F.resample(tensor_samples, sample_rate, TARGET_SAMPLE_RATE)
            audio_16k = tensor_samples.numpy()
        else:
            audio_16k = samples.astype(np.float32)

        self._ensure_loaded()

        lang_name = LANGUAGE_MAP.get(language.lower(), "Korean")

        chunk_samples_len = int(MAX_CHUNK_DURATION_SEC * TARGET_SAMPLE_RATE)
        results: list[tuple[int, int, str, float]] = []

        total_samples = len(audio_16k)
        num_chunks = max(1, math.ceil(total_samples / chunk_samples_len))

        for chunk_idx in range(num_chunks):
            start_idx = chunk_idx * chunk_samples_len
            end_idx = min((chunk_idx + 1) * chunk_samples_len, total_samples)
            chunk = audio_16k[start_idx:end_idx]

            if len(chunk) < int(MIN_SPEECH_DURATION_SEC * TARGET_SAMPLE_RATE):
                continue

            chunk_start_ms = int((start_idx / TARGET_SAMPLE_RATE) * 1000)
            chunk_end_ms = int((end_idx / TARGET_SAMPLE_RATE) * 1000)

            if float(np.max(np.abs(chunk))) < 1e-4:
                continue

            text, confidence = self._transcribe_chunk(chunk, lang_name)
            if text.strip():
                results.append((chunk_start_ms, chunk_end_ms, text.strip(), confidence))

        return results

    def _transcribe_chunk(self, chunk: np.ndarray, lang_name: str) -> tuple[str, float]:
        """단일 오디오 청크(<=30초)를 Qwen3-ASR로 전사합니다."""
        try:
            import torch
            inference_ctx = torch.inference_mode()
        except ImportError:
            from contextlib import nullcontext
            inference_ctx = nullcontext()

        messages = [{"role": "user", "content": [{"type": "audio", "audio": chunk}]}]
        prompt = (
            self._processor.apply_chat_template(
                messages, add_generation_prompt=True, tokenize=False
            )
            + f"language {lang_name}<asr_text>"
        )

        raw_inputs = self._processor(
            text=prompt,
            audio=chunk,
            return_tensors="pt",
            pad_to_multiple_of=100,
        )

        def _to_device_tensor(v):
            if not hasattr(v, "to"):
                return v
            is_fp = hasattr(v, "is_floating_point") and v.is_floating_point()
            return v.to(device=self.device, dtype=self.torch_dtype if is_fp else None)

        inputs = {k: _to_device_tensor(v) for k, v in raw_inputs.items()}

        with inference_ctx:
            outputs = self._model.generate(
                **inputs,
                max_new_tokens=256,
                return_dict_in_generate=True,
                output_scores=True,
            )

        sequences = outputs.sequences
        decoded = self._processor.batch_decode(sequences, skip_special_tokens=True)
        raw_text = decoded[0] if decoded else ""

        transcription = str(self._processor.extract_transcription(raw_text))

        confidence = 0.95
        if outputs.scores:
            try:
                probs = [
                    torch.softmax(s, dim=-1).max().item()
                    for s in outputs.scores[:10]
                ]
                if probs:
                    confidence = round(float(sum(probs) / len(probs)), 2)
            except Exception:
                confidence = 0.95

        return transcription, confidence
