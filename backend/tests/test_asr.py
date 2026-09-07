"""Qwen3Transcriber 단위 및 통합 테스트."""

from __future__ import annotations

from unittest.mock import MagicMock

import numpy as np

from teamflow.pipeline.asr import LANGUAGE_MAP, Qwen3Transcriber


def test_qwen3_transcriber_defaults():
    transcriber = Qwen3Transcriber()
    assert "Qwen3-ASR" in transcriber.model_id
    assert transcriber._model is None
    assert transcriber._processor is None


def test_qwen3_transcriber_handles_empty_input():
    transcriber = Qwen3Transcriber()
    assert transcriber.transcribe(None, 16000) == []
    assert transcriber.transcribe(np.array([]), 16000) == []


def test_qwen3_transcriber_handles_silence():
    transcriber = Qwen3Transcriber()
    # 1초의 완전 무음은 모델 적재 없이 바로 빈 결과를 반환해야 한다
    silence = np.zeros(16000, dtype=np.float32)
    assert transcriber.transcribe(silence, 16000) == []
    assert transcriber._model is None


def test_qwen3_transcriber_handles_sub_200ms_noise():
    transcriber = Qwen3Transcriber()
    # 100ms 의 짧은 신호는 잡음으로 간주
    short_signal = np.ones(1600, dtype=np.float32) * 0.5
    assert transcriber.transcribe(short_signal, 16000) == []


def test_language_map_coverage():
    assert LANGUAGE_MAP["ko"] == "Korean"
    assert LANGUAGE_MAP["en"] == "English"
    assert LANGUAGE_MAP["zh"] == "Chinese"
    assert LANGUAGE_MAP["ja"] == "Japanese"


def test_qwen3_transcriber_mocked_transcription(monkeypatch):
    """mocked 모델을 통한 반환 튜플 구조 검증."""
    transcriber = Qwen3Transcriber()

    fake_processor = MagicMock()
    fake_processor.apply_chat_template.return_value = "<mock_prompt>"
    fake_processor.return_value = {
        "input_ids": MagicMock(is_floating_point=lambda: False),
        "input_features": MagicMock(is_floating_point=lambda: True),
    }
    fake_processor.batch_decode.return_value = [
        "assistant\nlanguage Korean<asr_text>테스트 발화입니다"
    ]
    fake_processor.extract_transcription.return_value = "테스트 발화입니다"

    fake_model = MagicMock()
    fake_output = MagicMock()
    fake_output.sequences = [MagicMock()]
    fake_output.scores = []
    fake_model.generate.return_value = fake_output

    monkeypatch.setattr(transcriber, "_ensure_loaded", lambda: None)
    transcriber._processor = fake_processor
    transcriber._model = fake_model
    transcriber.device = "cpu"
    transcriber.torch_dtype = None

    # 1초 길이의 의미 있는 진폭 신호
    audio = np.sin(np.linspace(0, 100, 16000)).astype(np.float32)
    results = transcriber.transcribe(audio, 16000, language="ko")

    assert len(results) == 1
    start_ms, end_ms, text, confidence = results[0]
    assert start_ms == 0
    assert end_ms == 1000
    assert text == "테스트 발화입니다"
    assert confidence == 0.95
