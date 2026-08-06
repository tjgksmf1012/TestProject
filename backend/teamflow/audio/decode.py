"""청크 디코딩 — 브라우저가 만든 바이트를 PCM 으로.

docs/04-회의-처리-파이프라인.md §2

`MediaRecorder` 는 webm/opus(크롬·파이어폭스) 또는 mp4/aac(사파리) 를 낸다.
백엔드의 신호처리는 전부 16kHz 모노 float32 를 전제하므로 변환이 필요하다.

## FFmpeg 을 쓰는 이유

순수 파이썬 opus/aac 디코더는 사실상 없다. PyAV 같은 바인딩도 결국 FFmpeg 다.
바인딩 대신 서브프로세스를 쓰는 이유:

  - **깨진 청크가 프로세스를 죽이지 않는다.** 업로드 도중 끊긴 청크는 컨테이너가
    잘려 있다. 라이브러리 안에서 터지면 워커 전체가 죽지만, 서브프로세스면
    그 청크만 실패하고 나머지는 살아남는다 (`pipeline/runtime` 이 잡는다).
  - 배포가 단순하다 — 컨테이너에 `ffmpeg` 하나만 있으면 된다.

## ⚠️ 검증 범위

이 개발 환경에는 ffmpeg 이 없습니다. 그래서 **명령 구성·오류 처리·PCM 변환은
전부 테스트했지만, 실제 디코딩은 확인하지 못했습니다.** 러너를 주입받게
만들어 둔 이유가 그것입니다. ffmpeg 이 있는 머신에서
`scripts/check_env.py` 로 존재를 확인한 뒤 실제 파일로 한 번 돌려보세요.
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from typing import Protocol

import numpy as np

DEFAULT_SAMPLE_RATE = 16_000

# 청크 하나(5초)를 디코딩하는 데 이보다 오래 걸리면 뭔가 잘못된 것이다.
# 타임아웃이 없으면 깨진 입력에 ffmpeg 이 멈춰 워커가 영원히 붙잡힌다.
DEFAULT_TIMEOUT_SEC = 30.0


class CommandRunner(Protocol):
    """서브프로세스 실행. 테스트에서 갈아끼운다."""

    def run(self, args: list[str], *, stdin: bytes, timeout: float) -> tuple[int, bytes, bytes]:
        """Returns: ``(returncode, stdout, stderr)``"""
        ...


class SubprocessRunner:
    """실제 실행. `subprocess.run` 얇은 감싸기."""

    def run(self, args: list[str], *, stdin: bytes, timeout: float) -> tuple[int, bytes, bytes]:
        # args 는 ffmpeg_command() 가 만든다 — 사용자 입력이 섞이지 않는다.
        completed = subprocess.run(
            args,
            input=stdin,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        return completed.returncode, completed.stdout, completed.stderr


class DecodeError(ValueError):
    """**이 청크의 바이트**가 잘못됐다. 다른 청크는 계속 처리해야 한다.

    ValueError 를 상속하는 이유: 호출자(`ChunkAudioLoader._decode_chunks`)가
    "복구 가능한 데이터 오류" 를 잡아 그 자리만 무음으로 남기기 때문이다.
    """


class DecoderUnavailable(RuntimeError):
    """ffmpeg 이 없거나 실행할 수 없다. **설정 문제지 데이터 문제가 아니다.**

    이걸 DecodeError 와 같은 종류로 두면 모든 청크가 조용히 무음이 되고,
    회의 하나를 통째로 날린 뒤에야 알게 된다. 그래서 따로 두고, 로더가
    잡지 않고 위로 올려 보낸다.
    """


def ffmpeg_command(
    *, sample_rate: int = DEFAULT_SAMPLE_RATE, ffmpeg: str = "ffmpeg"
) -> list[str]:
    """stdin → stdout 으로 도는 디코딩 명령.

    각 인자에 이유가 있다.

    ``-hide_banner -loglevel error``
        정상 동작 시 아무것도 안 찍는다. stderr 에 배너가 섞이면 진짜 오류를
        찾기 어렵다.
    ``-i pipe:0`` / ``pipe:1``
        임시 파일을 안 만든다. 청크는 20KB 라 파일 왕복이 낭비고, 회의 하나에
        수백 번 반복된다.
    ``-f s16le``
        컨테이너 없는 16비트 리틀엔디안 raw PCM. 헤더가 없으므로 길이를 바이트
        수로 바로 계산할 수 있다.
    ``-ac 1``
        모노. 스테레오로 들어와도 여기서 합친다 — 이후 신호처리가 전부 모노 전제다.
    ``-ar {sample_rate}``
        16kHz. ASR 이 요구하는 값이고, 더 높아도 이득이 없다.
    ``-nostdin``
        ffmpeg 이 표준입력을 대화형으로 읽으려 드는 걸 막는다. 없으면 배치
        실행에서 멈추는 일이 생긴다.
    """
    return [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        "pipe:0",
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "-ac",
        "1",
        "-ar",
        str(int(sample_rate)),
        "pipe:1",
    ]


def pcm_to_float32(raw: bytes) -> np.ndarray:
    """s16le 바이트 → [-1, 1] float32.

    홀수 바이트가 오면 마지막 반쪽 샘플을 버린다. 파이프가 중간에 끊기면
    실제로 생기는 일이고, `frombuffer` 는 그때 예외를 던진다.
    """
    if len(raw) % 2:
        raw = raw[:-1]
    if not raw:
        return np.zeros(0, dtype=np.float32)
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32)
    # 32768 로 나눈다 — 32767 로 나누면 최소값 -32768 이 -1.000030 이 된다.
    return samples / 32768.0


@dataclass
class FfmpegChunkDecoder:
    """`pipeline.runtime.ChunkDecoder` 구현.

    실패는 `DecodeError` 로 올린다. 호출자(`ChunkAudioLoader`)가 잡아서
    그 청크만 무음으로 남기고 나머지는 계속 처리한다.
    """

    runner: CommandRunner
    ffmpeg: str = "ffmpeg"
    timeout_sec: float = DEFAULT_TIMEOUT_SEC

    def decode(self, data: bytes, *, target_sample_rate: int = DEFAULT_SAMPLE_RATE) -> np.ndarray:
        if not data:
            raise DecodeError("빈 청크입니다")

        args = ffmpeg_command(sample_rate=target_sample_rate, ffmpeg=self.ffmpeg)
        try:
            code, stdout, stderr = self.runner.run(
                args, stdin=data, timeout=self.timeout_sec
            )
        except subprocess.TimeoutExpired as exc:
            raise DecodeError(f"디코딩 시간 초과 ({self.timeout_sec}초)") from exc
        except FileNotFoundError as exc:
            # 설정 문제다. 청크를 건너뛰면 안 되고 전체가 멈춰야 한다.
            raise DecoderUnavailable(
                f"ffmpeg 을 찾을 수 없습니다 ({self.ffmpeg}). "
                "컨테이너에 설치되어 있는지 확인하세요"
            ) from exc

        if code != 0:
            raise DecodeError(f"ffmpeg 실패 (code={code}): {_tail(stderr)}")
        if not stdout:
            # 종료코드는 0인데 결과가 없는 경우가 있다 — 컨테이너 헤더만 있고
            # 오디오 프레임이 없는 청크. 무음으로 취급하면 조용히 틀리므로 올린다.
            raise DecodeError(f"디코딩 결과가 비어 있습니다: {_tail(stderr)}")

        return pcm_to_float32(stdout)


def _tail(stderr: bytes, limit: int = 300) -> str:
    text = stderr.decode("utf-8", errors="replace").strip()
    return text[-limit:] if text else "(stderr 없음)"


def build_decoder(*, ffmpeg: str = "ffmpeg") -> FfmpegChunkDecoder:
    """실제 실행용 디코더.

    Raises:
        DecoderUnavailable: ffmpeg 이 PATH 에 없으면. 첫 청크에서 터지는 것보다
            시작할 때 알려주는 게 낫다.
    """
    if shutil.which(ffmpeg) is None:
        raise DecoderUnavailable(
            f"ffmpeg 을 찾을 수 없습니다 ({ffmpeg}). "
            "apt install ffmpeg 또는 컨테이너 이미지에 추가하세요"
        )
    return FfmpegChunkDecoder(runner=SubprocessRunner(), ffmpeg=ffmpeg)
