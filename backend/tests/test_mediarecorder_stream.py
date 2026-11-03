"""실제 브라우저 조각을 디코딩합니다. 가짜 독립 파일로 대체하지 않습니다."""

import base64
import json
import shutil
from pathlib import Path

import numpy as np
import pytest

from teamflow.audio.assembly import PlacedChunk
from teamflow.audio.decode import build_decoder


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="실제 FFmpeg가 필요합니다")
def test_browser_continuations_and_recorder_restart_keep_all_audio():
    fixture = json.loads((Path(__file__).parent / "fixtures/mediarecorder-webm.json").read_text())
    chunks = [base64.b64decode(raw) for raw in fixture["chunks_base64"]]
    decoder = build_decoder()
    placements = [PlacedChunk(i, i * 500, 500 if i < 4 else 250) for i in range(5)]
    decoded = decoder.decode_chunks(list(zip(placements, chunks, strict=True)),
                                   target_sample_rate=16000)
    assert set(decoded) == set(range(5))
    assert all(np.mean(np.abs(samples)) > 0.01 for samples in decoded.values())
    assert sum(map(len, decoded.values())) > 2.1 * 16000

    # 새 헤더는 별도 녹음 구간입니다. 타임스탬프가 0으로 돌아가도 겹치면 안 됩니다.
    restarted = [PlacedChunk(i + 5, p.start_ms + 3000, p.duration_ms)
                 for i, p in enumerate(placements)]
    decoded = decoder.decode_chunks(
        [*zip(placements, chunks, strict=True), *zip(restarted, chunks, strict=True)],
        target_sample_rate=16000,
    )
    assert set(decoded) == set(range(10))
    for i in range(5):
        np.testing.assert_array_equal(decoded[i], decoded[i + 5])


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="실제 FFmpeg가 필요합니다")
def test_missing_header_does_not_become_successful_silence():
    fixture = json.loads((Path(__file__).parent / "fixtures/mediarecorder-webm.json").read_text())
    chunks = [base64.b64decode(raw) for raw in fixture["chunks_base64"]][1:]
    placements = [PlacedChunk(i + 1, (i + 1) * 500, 500) for i in range(4)]
    assert build_decoder().decode_chunks(list(zip(placements, chunks, strict=True)),
                                        target_sample_rate=16000) == {}
