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
from typing import Protocol

import numpy as np
from sqlalchemy import select

from teamflow.audio import assembly, decode
from teamflow.audio.chunk_store import ChunkStore
from teamflow.config import Settings
from teamflow.db import models as m
from teamflow.db.session import session_scope
from teamflow.pipeline.steps import LoadedTrack
from teamflow.services import recording_service

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


class ChunkDecoder(Protocol):
    """청크 바이트 → PCM.

    실제 구현은 FFmpeg 호출이다 (webm/opus, mp4/aac → 16kHz 모노 float32).
    ⚠️ 이 개발 환경에는 ffmpeg 이 없어 구현을 넣지 않았습니다.
    인터페이스만 확정하고, 순수 계산(배치·패딩)은 전부 검증했습니다.
    """

    def decode(self, data: bytes, *, target_sample_rate: int) -> np.ndarray: ...


@dataclass
class ChunkAudioLoader:
    """업로드된 청크에서 트랙을 복원한다. **멀티트랙(모드 A)의 기본 경로다.**

    `FileSystemAudioLoader` 와의 차이가 중요하다.

        [FileSystemAudioLoader]  트랙당 WAV 하나. 정렬은 track.started_at 차이로.
                                 → 폰이 중간에 멈췄으면 그 사실을 알 수 없다.

        [ChunkAudioLoader]       청크를 절대 시각에 배치하고 공백은 무음으로.
                                 → 모든 트랙이 같은 시간축. 길이도 같다.
                                 → GCC-PHAT 미세 정렬이 비로소 의미를 가진다.

    커버리지가 낮은 트랙도 **버리지 않고 usable=False 로 실어 보낸다.**
    빼버리면 그 사람이 목록에서 사라져 결국 "말을 안 한 사람"이 된다.
    0과 "측정 불가"는 다르고, 그 구분을 여기서 잃으면 복구할 수 없다.
    """

    store: ChunkStore
    decoder: ChunkDecoder
    timeslice_ms: int = 5_000
    sample_rate: int = TARGET_SAMPLE_RATE
    min_usable_coverage: float = recording_service.MIN_USABLE_COVERAGE

    def load(self, meeting_id: int) -> list[LoadedTrack]:
        with session_scope() as session:
            tracks = session.scalars(
                select(m.MeetingTrack)
                .where(m.MeetingTrack.meeting_id == meeting_id)
                .order_by(m.MeetingTrack.id)
            ).all()
            tracks = [t for t in tracks if t.ended_at is not None]
            if not tracks:
                return []

            earliest = min(t.started_at for t in tracks)
            loaded: list[LoadedTrack] = []
            for track in tracks:
                plan = recording_service.build_plan(
                    session, track, timeslice_ms=self.timeslice_ms
                )
                samples = assembly.render(
                    plan,
                    self._decode_chunks(meeting_id, track.id, plan),
                    sample_rate=self.sample_rate,
                )
                loaded.append(
                    LoadedTrack(
                        track_id=track.id,
                        user_id=track.user_id,
                        samples=samples,
                        sample_rate=self.sample_rate,
                        started_at_offset_sec=(track.started_at - earliest).total_seconds(),
                        coverage=plan.coverage,
                        usable=plan.coverage >= self.min_usable_coverage,
                    )
                )
            return loaded

    def _decode_chunks(
        self, meeting_id: int, track_id: int, plan: assembly.TrackPlan
    ) -> dict[int, np.ndarray]:
        decoded: dict[int, np.ndarray] = {}
        for placement in plan.placements:
            try:
                raw = self.store.read(meeting_id, track_id, placement.seq)
                decoded[placement.seq] = self.decoder.decode(
                    raw, target_sample_rate=self.sample_rate
                )
            except (OSError, ValueError) as exc:
                # 청크 하나가 깨져도 나머지는 살린다. 그 자리는 무음이 되고,
                # 어디가 비었는지는 plan.gaps 가 아니라 여기 로그로 남는다.
                logger.warning("청크 디코딩 실패 track=%s seq=%s: %s", track_id, placement.seq, exc)
        return decoded


def build_loader(settings: Settings) -> FileSystemAudioLoader:
    return FileSystemAudioLoader(storage_root=settings.audio_storage_root)


def build_chunk_loader(settings: Settings) -> ChunkAudioLoader:
    """멀티트랙(모드 A) 기본 경로.

    ⚠️ ffmpeg 이 PATH 에 없으면 여기서 `DecodeError` 가 난다. 첫 청크에서
    터지는 것보다 시작할 때 알려주는 게 낫다 — 회의 하나를 다 처리하고 나서
    "디코딩 실패" 를 보는 것만큼 나쁜 게 없다.
    `python3 scripts/check_env.py` 가 존재 여부를 확인해 준다.
    """
    return ChunkAudioLoader(
        store=ChunkStore(root=settings.audio_storage_root),
        decoder=decode.build_decoder(),
    )


def build_audio_loader(settings: Settings, capture_mode: str):
    """회의의 녹음 방식에 맞는 로더를 고른다.

    이 분기가 없으면 **모드 A(멀티트랙) 경로가 영영 실행되지 않는다.**
    청크 업로드·재조립을 다 만들어 놓고도 잡은 항상 WAV 로더를 쓰는
    상태였다 (실제로 그랬다).

        multitrack → ChunkAudioLoader  청크를 절대 시각에 배치, 공백은 무음
        single     → FileSystemAudioLoader  트랙당 WAV 하나 (모드 B 폴백)

    Raises:
        DecoderUnavailable: 멀티트랙인데 ffmpeg 이 없으면. 조용히 모드 B 로
            떨어뜨리지 않는다 — 그러면 청크가 있는데 WAV 를 찾다가 빈 결과를
            내고, 회의가 통째로 비어 보인다.
    """
    if capture_mode == "multitrack":
        return build_chunk_loader(settings)
    return build_loader(settings)


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
