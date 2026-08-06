"""청크 → 정렬된 트랙 복원 통합 테스트.

디코더(FFmpeg)만 가짜로 바꾸면 **업로드부터 정렬된 오디오까지** 전 구간이
검증된다. 실제 디코딩은 이 환경에 ffmpeg 이 없어 붙이지 못했지만, 그건
바이트 → 샘플 변환일 뿐이고 판단이 들어가는 부분은 여기 전부 있다.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.pool import StaticPool

from teamflow.audio.chunk_store import ChunkStore
from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.pipeline.runtime import ChunkAudioLoader

NOW = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)
NOW_MS = int(NOW.timestamp() * 1000)
TIMESLICE = 5_000
SR = 16_000


class FakeDecoder:
    """청크 바이트를 그대로 진폭으로 쓴다.

    `b"\\x05"` 짜리 청크는 값 5/255 인 5초짜리 톤이 된다. 이러면 렌더 결과만
    보고 "어느 청크가 어디 놓였는지" 알 수 있다.
    """

    def __init__(self, duration_ms: int = TIMESLICE):
        self.duration_ms = duration_ms
        self.calls: list[int] = []

    def decode(self, data: bytes, *, target_sample_rate: int) -> np.ndarray:
        self.calls.append(len(data))
        value = data[0] / 255.0
        return np.full(
            int(self.duration_ms * target_sample_rate / 1000), value, dtype=np.float32
        )


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    m.Base.metadata.create_all(eng)
    db_session.configure(eng)
    yield eng
    m.Base.metadata.drop_all(eng)
    eng.dispose()


@pytest.fixture
def store(tmp_path: Path) -> ChunkStore:
    return ChunkStore(root=tmp_path / "audio")


@pytest.fixture
def loader(store: ChunkStore) -> ChunkAudioLoader:
    return ChunkAudioLoader(
        store=store, decoder=FakeDecoder(), timeslice_ms=TIMESLICE, sample_rate=SR
    )


@pytest.fixture
def meeting(engine) -> int:
    with db_session.session_scope() as s:
        user = m.User(name="김민수", email="minsu@example.com")
        s.add(user)
        s.flush()
        project = m.Project(title="TeamFlow", started_at=NOW)
        s.add(project)
        s.flush()
        meeting = m.Meeting(project_id=project.id, started_at=NOW, started_by=user.id)
        s.add(meeting)
        s.flush()
        return meeting.id


def make_track(
    meeting_id: int,
    *,
    email: str,
    seqs: list[int],
    slices: int,
    store: ChunkStore,
    marker: int = 128,
    start_offset_sec: float = 0.0,
) -> int:
    """트랙 하나를 만들고 지정한 seq 의 청크만 업로드된 상태로 둔다."""
    started = NOW + timedelta(seconds=start_offset_sec)
    started_ms = int(started.timestamp() * 1000)

    with db_session.session_scope() as s:
        user = m.User(name=email, email=email)
        s.add(user)
        s.flush()
        track = m.MeetingTrack(
            meeting_id=meeting_id,
            user_id=user.id,
            started_at=started,
            ended_at=started + timedelta(seconds=5 * slices),
            status="completed",
            gaps=[],
            capture_warnings=[],
        )
        s.add(track)
        s.flush()
        track_id = track.id

        for seq in seqs:
            s.add(
                m.TrackChunk(
                    track_id=track_id,
                    seq=seq,
                    bytes=1,
                    client_at_ms=started_ms + TIMESLICE * (seq + 1),
                )
            )

    for seq in seqs:
        store.write(meeting_id, track_id, seq, bytes([marker]))
    return track_id


def test_continuous_track_is_loaded_whole(
    engine, meeting: int, store: ChunkStore, loader: ChunkAudioLoader
):
    make_track(meeting, email="a@x.com", seqs=list(range(4)), slices=4, store=store)

    tracks = loader.load(meeting)

    assert len(tracks) == 1
    assert len(tracks[0].samples) == 20 * SR
    assert tracks[0].usable is True
    assert tracks[0].coverage == 1.0
    assert np.all(tracks[0].samples > 0)


def test_gap_becomes_silence_in_the_right_place(
    engine, meeting: int, store: ChunkStore, loader: ChunkAudioLoader
):
    """⭐ 잃어버린 청크 자리가 무음이 되고, 그 뒤는 제자리에 남는다."""
    # seq 2 (10~15초) 가 업로드되지 않았다
    make_track(meeting, email="a@x.com", seqs=[0, 1, 3, 4], slices=5, store=store)

    samples = loader.load(meeting)[0].samples

    assert len(samples) == 25 * SR
    assert np.all(samples[: 10 * SR] > 0)
    assert np.all(samples[10 * SR : 15 * SR] == 0.0), "유실 구간은 무음"
    assert np.all(samples[15 * SR :] > 0), "그 뒤 오디오는 앞당겨지지 않는다"


def test_all_tracks_share_one_time_axis(
    engine, meeting: int, store: ChunkStore, loader: ChunkAudioLoader
):
    """⭐ 서로 다르게 망가진 트랙들이 같은 길이로 나온다.

    이게 보장돼야 GCC-PHAT 미세 정렬이 의미를 가진다.
    """
    make_track(meeting, email="a@x.com", seqs=list(range(10)), slices=10, store=store)
    make_track(meeting, email="b@x.com", seqs=[0, 1, 8, 9], slices=10, store=store)
    make_track(meeting, email="c@x.com", seqs=[], slices=10, store=store)

    tracks = loader.load(meeting)

    assert len(tracks) == 3
    assert {len(t.samples) for t in tracks} == {50 * SR}


def test_low_coverage_track_is_flagged_not_dropped(
    engine, meeting: int, store: ChunkStore, loader: ChunkAudioLoader
):
    """⭐ 0과 "측정 불가"는 다르다.

    빼버리면 그 사람이 목록에서 사라져 결국 "말을 안 한 사람"이 된다.
    """
    make_track(meeting, email="a@x.com", seqs=list(range(10)), slices=10, store=store)
    make_track(meeting, email="b@x.com", seqs=[0, 1], slices=10, store=store)

    tracks = loader.load(meeting)
    broken = next(t for t in tracks if not t.usable)

    assert len(tracks) == 2, "낮은 커버리지 트랙도 목록에 남는다"
    assert broken.coverage == pytest.approx(0.2)
    assert len(broken.samples) == 50 * SR


def test_track_start_offsets_are_relative_to_the_earliest(
    engine, meeting: int, store: ChunkStore, loader: ChunkAudioLoader
):
    """늦게 시작한 사람의 오프셋이 기록된다. GCC-PHAT 이 여기서 미세 보정한다."""
    make_track(meeting, email="a@x.com", seqs=[0, 1], slices=2, store=store)
    make_track(
        meeting, email="b@x.com", seqs=[0, 1], slices=2, store=store, start_offset_sec=12
    )

    offsets = sorted(t.started_at_offset_sec for t in loader.load(meeting))
    assert offsets == [0.0, 12.0]


def test_broken_chunk_does_not_kill_the_track(
    engine, meeting: int, store: ChunkStore
):
    """청크 하나가 깨져도 나머지는 살린다."""

    class FlakyDecoder(FakeDecoder):
        def decode(self, data: bytes, *, target_sample_rate: int) -> np.ndarray:
            if data == b"\x01":
                raise ValueError("컨테이너가 깨졌습니다")
            return super().decode(data, target_sample_rate=target_sample_rate)

    store_ = store
    track_id = make_track(meeting, email="a@x.com", seqs=[0, 1, 2], slices=3, store=store_)
    store_.write(meeting, track_id, 1, b"\x01")  # 가운데 청크만 깨뜨린다

    loader = ChunkAudioLoader(
        store=store_, decoder=FlakyDecoder(), timeslice_ms=TIMESLICE, sample_rate=SR
    )
    samples = loader.load(meeting)[0].samples

    assert len(samples) == 15 * SR
    assert np.all(samples[: 5 * SR] > 0)
    assert np.all(samples[5 * SR : 10 * SR] == 0.0)
    assert np.all(samples[10 * SR :] > 0)


def test_unfinished_tracks_are_skipped(engine, meeting: int, store: ChunkStore, loader):
    """아직 녹음 중인 트랙은 끝 시각이 없어 배치할 수 없다."""
    with db_session.session_scope() as s:
        user = m.User(name="진행중", email="live@x.com")
        s.add(user)
        s.flush()
        s.add(
            m.MeetingTrack(
                meeting_id=meeting,
                user_id=user.id,
                started_at=NOW,
                status="recording",
                gaps=[],
                capture_warnings=[],
            )
        )

    assert loader.load(meeting) == []


def test_meeting_without_tracks_returns_empty(engine, meeting: int, loader):
    assert loader.load(meeting) == []


def test_decoder_is_only_asked_for_chunks_that_exist(
    engine, meeting: int, store: ChunkStore
):
    decoder = FakeDecoder()
    make_track(meeting, email="a@x.com", seqs=[0, 3], slices=4, store=store)

    ChunkAudioLoader(
        store=store, decoder=decoder, timeslice_ms=TIMESLICE, sample_rate=SR
    ).load(meeting)

    assert len(decoder.calls) == 2, "없는 청크를 디코딩하려 들지 않는다"


# ══════════════════════════════════════════════════════════════
# 실제 디코더의 오류 구분이 로더까지 이어지는가
# ══════════════════════════════════════════════════════════════


def test_bad_chunk_is_skipped_but_a_missing_decoder_is_not(
    engine, meeting: int, store: ChunkStore
):
    """⭐ 두 오류는 결과가 완전히 달라야 한다.

    청크 하나가 깨진 것 → 그 자리만 무음, 나머지는 살린다.
    ffmpeg 이 없는 것    → 전부 무음이 되면 회의 하나를 통째로 날린 뒤에야
                          알게 된다. 그러니 위로 올려 보내야 한다.
    """
    from teamflow.audio.decode import DecodeError, DecoderUnavailable

    make_track(meeting, email="a@x.com", seqs=[0, 1, 2], slices=3, store=store)

    class OneBadChunk(FakeDecoder):
        def decode(self, data: bytes, *, target_sample_rate: int) -> np.ndarray:
            if data == b"\x01":
                raise DecodeError("컨테이너가 잘렸습니다")
            return super().decode(data, target_sample_rate=target_sample_rate)

    class NoFfmpeg(FakeDecoder):
        def decode(self, data: bytes, *, target_sample_rate: int) -> np.ndarray:
            raise DecoderUnavailable("ffmpeg 을 찾을 수 없습니다")

    # 가운데 청크만 깨뜨린다
    with db_session.session_scope() as s:
        row = s.scalars(select(m.MeetingTrack)).one()
        broken_track_id = row.id
    store.write(meeting, broken_track_id, 1, b"\x01")

    samples = ChunkAudioLoader(
        store=store, decoder=OneBadChunk(), timeslice_ms=TIMESLICE, sample_rate=SR
    ).load(meeting)[0].samples
    assert np.all(samples[: 5 * SR] > 0)
    assert np.all(samples[5 * SR : 10 * SR] == 0.0), "깨진 청크만 무음"
    assert np.all(samples[10 * SR :] > 0), "나머지는 살아남는다"

    with pytest.raises(DecoderUnavailable):
        ChunkAudioLoader(
            store=store, decoder=NoFfmpeg(), timeslice_ms=TIMESLICE, sample_rate=SR
        ).load(meeting)


# ══════════════════════════════════════════════════════════════
# 녹음 방식에 따른 로더 선택
# ══════════════════════════════════════════════════════════════


def test_multitrack_meetings_use_the_chunk_loader(monkeypatch, tmp_path: Path):
    """⭐ 이 분기가 없으면 모드 A 경로가 영영 실행되지 않는다.

    청크 업로드·재조립을 다 만들어 놓고도 잡은 항상 WAV 로더를 썼다.
    """
    from teamflow.config import Settings
    from teamflow.pipeline import runtime

    monkeypatch.setattr(
        runtime.decode, "build_decoder", lambda **kw: FakeDecoder(), raising=True
    )
    settings = Settings(
        environment="test",
        github_webhook_secret="x",
        database_url="sqlite://",
        audio_storage_root=tmp_path,
    )

    assert isinstance(runtime.build_audio_loader(settings, "multitrack"), ChunkAudioLoader)


def test_single_mic_meetings_use_the_wav_loader(tmp_path: Path):
    """모드 B 폴백은 그대로 유지된다 (docs/04 §2.5)."""
    from teamflow.config import Settings
    from teamflow.pipeline import runtime

    settings = Settings(
        environment="test",
        github_webhook_secret="x",
        database_url="sqlite://",
        audio_storage_root=tmp_path,
    )

    loader = runtime.build_audio_loader(settings, "single")
    assert isinstance(loader, runtime.FileSystemAudioLoader)


def test_multitrack_without_ffmpeg_fails_loudly(tmp_path: Path):
    """⭐ 조용히 모드 B 로 떨어뜨리면 안 된다.

    청크가 있는데 WAV 를 찾다가 빈 결과를 내고, 회의가 통째로 비어 보인다.
    """
    from teamflow.audio.decode import DecoderUnavailable
    from teamflow.config import Settings
    from teamflow.pipeline import runtime

    settings = Settings(
        environment="test",
        github_webhook_secret="x",
        database_url="sqlite://",
        audio_storage_root=tmp_path,
    )

    # 이 환경에는 ffmpeg 이 없으므로 실제로 터진다
    with pytest.raises(DecoderUnavailable):
        runtime.build_audio_loader(settings, "multitrack")
