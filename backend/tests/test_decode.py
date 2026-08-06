"""청크 디코딩 테스트.

⚠️ 이 환경에 ffmpeg 이 없어 **실제 디코딩은 확인하지 못했습니다.**
러너를 갈아끼워 명령 구성·오류 처리·PCM 변환만 검증합니다.

그래도 값어치가 있는 이유: 여기서 잡히는 건 대부분 "실패했는데 성공한 척"
하는 경우다. 깨진 청크에 무음을 돌려주면 그 자리가 조용히 사라지고,
`assembly` 가 공백으로 인식하지도 못한다.
"""

from __future__ import annotations

import struct
import subprocess

import numpy as np
import pytest

from teamflow.audio.decode import (
    DecodeError,
    DecoderUnavailable,
    FfmpegChunkDecoder,
    ffmpeg_command,
    pcm_to_float32,
)

CHUNK = b"\x1a\x45\xdf\xa3webm-ish-bytes"


class FakeRunner:
    """지정한 결과를 돌려주는 가짜 서브프로세스."""

    def __init__(self, code: int = 0, stdout: bytes = b"", stderr: bytes = b"", raises=None):
        self.code = code
        self.stdout = stdout
        self.stderr = stderr
        self.raises = raises
        self.calls: list[tuple[list[str], bytes, float]] = []

    def run(self, args: list[str], *, stdin: bytes, timeout: float):
        self.calls.append((args, stdin, timeout))
        if self.raises is not None:
            raise self.raises
        return self.code, self.stdout, self.stderr


def pcm(*samples: int) -> bytes:
    """int16 샘플들을 s16le 바이트로."""
    return struct.pack(f"<{len(samples)}h", *samples)


# ══════════════════════════════════════════════════════════════
# 명령 구성
# ══════════════════════════════════════════════════════════════


def test_command_uses_pipes_not_temp_files():
    """청크는 20KB 다. 회의 하나에 수백 번이라 파일 왕복이 낭비다."""
    args = ffmpeg_command()
    assert "pipe:0" in args
    assert "pipe:1" in args


def test_command_asks_for_mono_16k_s16le():
    args = ffmpeg_command(sample_rate=16_000)
    assert args[args.index("-ac") + 1] == "1"
    assert args[args.index("-ar") + 1] == "16000"
    assert args[args.index("-f") + 1] == "s16le"


def test_command_respects_sample_rate():
    assert ffmpeg_command(sample_rate=48_000)[
        ffmpeg_command(sample_rate=48_000).index("-ar") + 1
    ] == "48000"


def test_command_silences_the_banner():
    """정상 동작 시 stderr 가 비어야 진짜 오류를 찾을 수 있다."""
    args = ffmpeg_command()
    assert "-hide_banner" in args
    assert args[args.index("-loglevel") + 1] == "error"


def test_command_disables_interactive_stdin():
    """-nostdin 이 없으면 배치 실행에서 ffmpeg 이 멈추는 일이 생긴다."""
    assert "-nostdin" in ffmpeg_command()


def test_command_honours_custom_binary_path():
    assert ffmpeg_command(ffmpeg="/opt/bin/ffmpeg")[0] == "/opt/bin/ffmpeg"


# ══════════════════════════════════════════════════════════════
# PCM 변환
# ══════════════════════════════════════════════════════════════


def test_pcm_converts_to_unit_range():
    audio = pcm_to_float32(pcm(0, 16384, -16384))
    assert audio.dtype == np.float32
    np.testing.assert_allclose(audio, [0.0, 0.5, -0.5])


def test_pcm_minimum_sample_does_not_exceed_minus_one():
    """⭐ 32767 로 나누면 -32768 이 -1.00003 이 된다.

    클리핑 검사나 정규화에서 그 미세한 초과가 문제를 만든다.
    """
    audio = pcm_to_float32(pcm(-32768, 32767))
    assert audio[0] == -1.0
    assert audio[1] < 1.0


def test_pcm_drops_a_trailing_half_sample():
    """파이프가 중간에 끊기면 홀수 바이트가 온다. frombuffer 는 거기서 던진다."""
    audio = pcm_to_float32(pcm(100, 200) + b"\x01")
    assert len(audio) == 2


def test_pcm_of_nothing_is_empty():
    assert len(pcm_to_float32(b"")) == 0
    assert len(pcm_to_float32(b"\x01")) == 0


# ══════════════════════════════════════════════════════════════
# 디코딩 흐름
# ══════════════════════════════════════════════════════════════


def test_decode_pipes_the_chunk_into_stdin():
    runner = FakeRunner(stdout=pcm(0, 1000))
    FfmpegChunkDecoder(runner=runner).decode(CHUNK)

    args, stdin, timeout = runner.calls[0]
    assert stdin == CHUNK
    assert timeout == 30.0
    assert args[0] == "ffmpeg"


def test_decode_returns_float32_samples():
    runner = FakeRunner(stdout=pcm(0, 16384, -16384, 0))
    audio = FfmpegChunkDecoder(runner=runner).decode(CHUNK)

    assert audio.dtype == np.float32
    assert len(audio) == 4


def test_decode_passes_the_requested_sample_rate():
    runner = FakeRunner(stdout=pcm(0))
    FfmpegChunkDecoder(runner=runner).decode(CHUNK, target_sample_rate=48_000)

    args = runner.calls[0][0]
    assert args[args.index("-ar") + 1] == "48000"


def test_empty_chunk_is_rejected_without_running_ffmpeg():
    runner = FakeRunner()
    with pytest.raises(DecodeError, match="빈 청크"):
        FfmpegChunkDecoder(runner=runner).decode(b"")
    assert runner.calls == []


def test_nonzero_exit_raises_with_the_reason():
    runner = FakeRunner(code=1, stderr=b"Invalid data found when processing input")
    with pytest.raises(DecodeError, match="Invalid data found"):
        FfmpegChunkDecoder(runner=runner).decode(CHUNK)


def test_empty_output_with_success_code_still_raises():
    """⭐ 종료코드 0 인데 결과가 없는 경우가 있다.

    컨테이너 헤더만 있고 오디오 프레임이 없는 청크다. 무음으로 취급하면
    그 자리가 조용히 사라지고 assembly 가 공백으로 인식하지도 못한다.
    """
    runner = FakeRunner(code=0, stdout=b"", stderr=b"")
    with pytest.raises(DecodeError, match="비어 있습니다"):
        FfmpegChunkDecoder(runner=runner).decode(CHUNK)


def test_timeout_raises_decode_error():
    """타임아웃이 없으면 깨진 입력에 워커가 영원히 붙잡힌다."""
    runner = FakeRunner(raises=subprocess.TimeoutExpired(cmd="ffmpeg", timeout=30))
    with pytest.raises(DecodeError, match="시간 초과"):
        FfmpegChunkDecoder(runner=runner).decode(CHUNK)


def test_missing_ffmpeg_is_a_different_kind_of_error():
    """⭐ 설정 문제를 데이터 문제와 같은 종류로 두면 안 된다.

    로더는 "이 청크가 깨졌다" 를 잡아 무음으로 넘긴다. ffmpeg 이 없는 걸
    같은 종류로 올리면 **모든 청크가 조용히 무음이 되고**, 회의 하나를
    통째로 날린 뒤에야 알게 된다.
    """
    runner = FakeRunner(raises=FileNotFoundError("ffmpeg"))
    with pytest.raises(DecoderUnavailable, match="찾을 수 없습니다"):
        FfmpegChunkDecoder(runner=runner).decode(CHUNK)

    # 로더가 잡는 종류(ValueError)와 겹치면 안 된다
    assert not issubclass(DecoderUnavailable, ValueError)


def test_bad_chunk_error_is_recoverable_by_the_loader():
    """반대로 청크 오류는 로더가 잡을 수 있어야 한다.

    `ChunkAudioLoader._decode_chunks` 가 (OSError, ValueError) 를 잡는다.
    """
    assert issubclass(DecodeError, ValueError)


def test_stderr_is_truncated_in_the_message():
    """ffmpeg 이 수천 줄을 뱉을 수 있다. 로그를 덮으면 안 된다."""
    runner = FakeRunner(code=1, stderr=b"x" * 5000)
    with pytest.raises(DecodeError) as info:
        FfmpegChunkDecoder(runner=runner).decode(CHUNK)
    assert len(str(info.value)) < 400


def test_decoder_satisfies_the_pipeline_protocol():
    """`pipeline.runtime.ChunkDecoder` 로 그대로 쓸 수 있어야 한다."""
    from teamflow.pipeline.runtime import ChunkDecoder

    decoder: ChunkDecoder = FfmpegChunkDecoder(runner=FakeRunner(stdout=pcm(0)))
    assert isinstance(decoder.decode(CHUNK, target_sample_rate=16_000), np.ndarray)
