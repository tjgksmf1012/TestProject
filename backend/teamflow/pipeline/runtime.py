"""실행 환경에 맞는 파이프라인 단계 구현을 고른다.

⚠️ **ASR·화자분리 실제 구현은 아직 없습니다.**
이 개발 환경에 GPU도 모델도 없어 검증할 수 없기 때문입니다.
인터페이스(`pipeline/steps.py`)만 확정해 두고, 실제 머신에서 붙입니다.

붙이는 순서:
    1. `python3 scripts/check_env.py` 로 환경 확인
    2. `pip install -e ".[ai]"`
    3. 아래 `NotImplementedError` 자리에 실제 구현
    4. `docs/09` 실험 1(한국어 ASR 비교)로 모델 확정
"""

from __future__ import annotations

import logging
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from sqlalchemy import select

from teamflow.config import Settings
from teamflow.db import models as m
from teamflow.db.session import session_scope
from teamflow.pipeline.steps import LoadedTrack

logger = logging.getLogger(__name__)

TARGET_SAMPLE_RATE = 16_000


@dataclass
class FileSystemAudioLoader:
    """로컬 파일시스템에서 트랙을 읽는다.

    제안서 9장은 MinIO를 썼으나 2026-04 아카이브되어 파일시스템을 쓴다
    (docs/11 §2). 오디오는 별도 볼륨·별도 암호화 키로 분리 보관한다 (docs/07 P4).
    """

    storage_root: Path

    def load(self, meeting_id: int) -> list[LoadedTrack]:
        with session_scope() as session:
            rows = session.execute(
                select(m.MeetingTrack, m.AudioAsset)
                .join(m.AudioAsset, m.AudioAsset.track_id == m.MeetingTrack.id)
                .where(
                    m.MeetingTrack.meeting_id == meeting_id,
                    m.AudioAsset.kind == "raw",
                    m.AudioAsset.deleted_at.is_(None),
                )
                .order_by(m.MeetingTrack.id)
            ).all()

            if not rows:
                return []

            earliest = min(track.started_at for track, _ in rows)
            loaded: list[LoadedTrack] = []
            for track, asset in rows:
                path = self._safe_path(asset.storage_key)
                if path is None or not path.exists():
                    logger.warning("트랙 %s 파일 없음: %s", track.id, asset.storage_key)
                    continue
                samples, sample_rate = read_wav(path)
                loaded.append(
                    LoadedTrack(
                        track_id=track.id,
                        user_id=track.user_id,
                        samples=samples,
                        sample_rate=sample_rate,
                        started_at_offset_sec=(track.started_at - earliest).total_seconds(),
                    )
                )
            return loaded

    def _safe_path(self, storage_key: str) -> Path | None:
        """저장 루트 밖의 경로는 거부한다.

        `storage_key` 는 DB에서 오므로 `../` 가 들어올 수 있다.
        읽기라도 경로 탈출은 임의 파일 노출이다.
        """
        try:
            target = (self.storage_root / storage_key).resolve()
        except OSError:
            return None
        if not target.is_relative_to(self.storage_root.resolve()):
            logger.error("저장 루트 밖의 경로 거부: %s", storage_key)
            return None
        return target


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    """WAV를 float32 모노로 읽는다.

    표준 라이브러리만 쓴다. opus/webm 은 ffmpeg 로 wav 변환 후 넣는다 —
    브라우저 MediaRecorder 는 보통 webm/opus 를 낸다.
    """
    with wave.open(str(path), "rb") as wav:
        n_channels = wav.getnchannels()
        sample_width = wav.getsampwidth()
        sample_rate = wav.getframerate()
        frames = wav.readframes(wav.getnframes())

    dtype = {1: np.int8, 2: np.int16, 4: np.int32}.get(sample_width)
    if dtype is None:
        raise ValueError(f"지원하지 않는 샘플 폭: {sample_width}")

    data = np.frombuffer(frames, dtype=dtype).astype(np.float32)
    data /= float(np.iinfo(dtype).max)

    if n_channels > 1:
        data = data.reshape(-1, n_channels).mean(axis=1)

    return data.astype(np.float32), sample_rate


def build_loader(settings: Settings) -> FileSystemAudioLoader:
    return FileSystemAudioLoader(storage_root=settings.audio_storage_root)


def build_transcriber(settings: Settings):
    """ASR 구현을 고른다.

    ⚠️ 아직 구현되지 않았습니다. `docs/09` 실험 1로 모델을 확정한 뒤
    실제 머신에서 붙이세요.

    확정된 1순위: `Qwen/Qwen3-ASR-1.7B` (Apache 2.0, 타임스탬프 내장,
    Transformers v5.13+ 네이티브, 공식 vLLM 툴킷).
    """
    raise NotImplementedError(
        f"ASR 구현이 아직 없습니다 (설정: {settings.asr_model}).\n"
        "1. python3 scripts/check_env.py 로 GPU 환경 확인\n"
        '2. pip install -e ".[ai]"\n'
        "3. backend/teamflow/pipeline/runtime.py 의 build_transcriber 구현\n"
        "4. docs/09 실험 1(한국어 ASR 비교)로 모델 확정"
    )


def build_diarizer(settings: Settings):
    """화자 분리 구현을 고른다. 단일 마이크(모드 B) 폴백에서만 쓴다.

    멀티트랙(모드 A)이면 트랙이 곧 화자라 필요 없다 — 그게 이 프로젝트의
    핵심 설계 결정이다 (docs/04 §2).

    ⚠️ 아직 구현되지 않았습니다.
    pyannote community-1 은 HuggingFace gated 이므로 HF_TOKEN 이 필요하고,
    **CC-BY-4.0 이라 서비스 크레딧에 귀속 표시 의무**가 있습니다.
    """
    raise NotImplementedError(
        f"화자 분리 구현이 아직 없습니다 (설정: {settings.diarization_model}).\n"
        "멀티트랙 모드에서는 필요하지 않습니다 — docs/04 §2 참조."
    )
