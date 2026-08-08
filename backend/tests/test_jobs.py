"""GPU 배타 락 · 보존기간 삭제 잡 테스트."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from teamflow.db import models as m
from teamflow.jobs.gpu_lock import (
    FakeRedis,
    GpuBusy,
    acquire,
    gpu_lease,
    wait_for_gpu,
)
from teamflow.jobs.retention import (
    REASON_CONSENT_REFUSED,
    purge_expired_audio,
    purge_unconsented_audio,
    revoke_project_voiceprints,
    revoke_user_data,
)

NOW = datetime(2026, 9, 1, 12, 0, tzinfo=UTC)


# ══════════════════════════════════════════════════════════════
# GPU 배타 락
# ══════════════════════════════════════════════════════════════


@pytest.fixture
def redis() -> FakeRedis:
    return FakeRedis()


def test_first_acquire_succeeds(redis: FakeRedis):
    lease = acquire(redis, job_id="meeting:1")
    assert lease.token.startswith("meeting:1:")


def test_second_acquire_is_blocked(redis: FakeRedis):
    """VRAM에 모델 셋을 동시에 못 올린다. 병렬 실행은 OOM 이다."""
    acquire(redis, job_id="meeting:1")
    with pytest.raises(GpuBusy) as exc:
        acquire(redis, job_id="meeting:2")
    assert "meeting:1" in exc.value.holder


def test_release_allows_next_job(redis: FakeRedis):
    lease = acquire(redis, job_id="meeting:1")
    assert lease.release()
    acquire(redis, job_id="meeting:2")  # 예외 없이 획득


def test_ttl_expiry_frees_the_lock(redis: FakeRedis):
    """워커가 죽어도 GPU가 영구 점유되면 안 된다."""
    acquire(redis, job_id="dead-worker", ttl=60)
    redis.advance(61)
    acquire(redis, job_id="meeting:2")  # TTL 만료로 획득 가능


def test_lease_extend_keeps_lock(redis: FakeRedis):
    """1시간짜리 회의를 처리하다 TTL이 만료되면 둘 다 죽는다."""
    lease = acquire(redis, job_id="long-job", ttl=60)
    redis.advance(50)
    assert lease.extend(60)
    redis.advance(50)  # 원래 TTL이면 만료됐을 시점
    with pytest.raises(GpuBusy):
        acquire(redis, job_id="other")


def test_cannot_release_someone_elses_lock(redis: FakeRedis):
    """TTL 만료 후 다른 잡이 잡았는데, 옛 소유자가 해제하면 안 된다."""
    stale = acquire(redis, job_id="job-a", ttl=60)
    redis.advance(61)
    acquire(redis, job_id="job-b", ttl=60)

    assert stale.release() is False  # 남의 락은 못 지운다
    with pytest.raises(GpuBusy) as exc:
        acquire(redis, job_id="job-c")
    assert "job-b" in exc.value.holder


def test_cannot_extend_someone_elses_lock(redis: FakeRedis):
    stale = acquire(redis, job_id="job-a", ttl=60)
    redis.advance(61)
    acquire(redis, job_id="job-b", ttl=60)
    assert stale.extend() is False


def test_retry_of_same_job_does_not_steal_its_own_stale_lock(redis: FakeRedis):
    """같은 job_id 재시도가 이전 시도의 락을 자기 것으로 착각하면 안 된다.

    토큰에 uuid 를 섞는 이유다.
    """
    first = acquire(redis, job_id="meeting:1", ttl=60)
    redis.advance(61)
    second = acquire(redis, job_id="meeting:1", ttl=60)
    assert first.token != second.token
    assert first.release() is False  # 옛 시도는 새 락을 못 지운다


def test_context_manager_releases_on_exception(redis: FakeRedis):
    with pytest.raises(RuntimeError), gpu_lease(redis, job_id="meeting:1"):
        raise RuntimeError("ASR 실패")
    acquire(redis, job_id="meeting:2")  # 락이 풀려 있어야 한다


def test_context_manager_releases_on_success(redis: FakeRedis):
    with gpu_lease(redis, job_id="meeting:1") as lease:
        assert lease.extend()
    acquire(redis, job_id="meeting:2")


def test_wait_for_gpu_times_out(redis: FakeRedis):
    acquire(redis, job_id="holder", ttl=3600)
    slept: list[float] = []
    with pytest.raises(GpuBusy):
        wait_for_gpu(
            redis, job_id="waiter", timeout=3, poll_interval=1, sleep=slept.append
        )
    assert slept == [1, 1, 1]


def test_wait_for_gpu_succeeds_after_expiry(redis: FakeRedis):
    acquire(redis, job_id="holder", ttl=2)

    def fake_sleep(seconds: float) -> None:
        redis.advance(seconds)

    lease = wait_for_gpu(
        redis, job_id="waiter", timeout=5, poll_interval=1, sleep=fake_sleep
    )
    assert lease.token.startswith("waiter:")


# ══════════════════════════════════════════════════════════════
# 보존기간 삭제
# ══════════════════════════════════════════════════════════════


@pytest.fixture
def session() -> Session:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    m.Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, expire_on_commit=False)()


@pytest.fixture
def storage(tmp_path: Path) -> Path:
    root = tmp_path / "audio"
    root.mkdir()
    return root


def seed_meeting(session: Session) -> tuple[int, int, int]:
    user = m.User(name="김민수", email="minsu@example.com")
    session.add(user)
    session.flush()
    project = m.Project(title="P", started_at=NOW)
    session.add(project)
    session.flush()
    session.add(m.Member(project_id=project.id, user_id=user.id, role_shares={}))
    meeting = m.Meeting(
        project_id=project.id, started_at=NOW, status="confirmed", started_by=user.id
    )
    session.add(meeting)
    session.flush()
    return project.id, meeting.id, user.id


def make_asset(
    session: Session,
    storage: Path,
    meeting_id: int,
    *,
    name: str,
    retention_until: datetime,
    track_id: int | None = None,
    content: bytes = b"fake-audio-data",
) -> m.AudioAsset:
    path = storage / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    asset = m.AudioAsset(
        meeting_id=meeting_id,
        track_id=track_id,
        storage_key=name,
        encryption_key_id="k1",
        kind="raw",
        bytes=len(content),
        retention_until=retention_until,
    )
    session.add(asset)
    session.flush()
    return asset


def test_expired_audio_is_deleted(session: Session, storage: Path):
    _, meeting_id, _ = seed_meeting(session)
    expired = make_asset(
        session, storage, meeting_id, name="old.opus", retention_until=NOW - timedelta(days=1)
    )
    report = purge_expired_audio(session, storage_root=storage, now=NOW)

    assert report.ok
    assert expired.id in report.deleted_assets
    assert not (storage / "old.opus").exists()
    assert session.get(m.AudioAsset, expired.id).deleted_at == NOW


def test_unexpired_audio_is_kept(session: Session, storage: Path):
    _, meeting_id, _ = seed_meeting(session)
    make_asset(
        session, storage, meeting_id, name="new.opus", retention_until=NOW + timedelta(days=10)
    )
    report = purge_expired_audio(session, storage_root=storage, now=NOW)
    assert report.deleted_assets == []
    assert (storage / "new.opus").exists()


def test_transcripts_survive_audio_deletion(session: Session, storage: Path):
    """핵심 정책: 원본 오디오만 지우고 전사 텍스트는 남긴다."""
    _, meeting_id, user_id = seed_meeting(session)
    session.add(
        m.Utterance(
            meeting_id=meeting_id,
            speaker_id=user_id,
            start_ms=0,
            end_ms=3000,
            text="로그인 API는 제가 하겠습니다",
            speaker_source="track",
        )
    )
    make_asset(
        session, storage, meeting_id, name="old.opus", retention_until=NOW - timedelta(days=1)
    )
    session.flush()

    purge_expired_audio(session, storage_root=storage, now=NOW)

    utterances = session.scalars(select(m.Utterance)).all()
    assert len(utterances) == 1
    assert utterances[0].text == "로그인 API는 제가 하겠습니다"


def test_deletion_is_audited(session: Session, storage: Path):
    _, meeting_id, _ = seed_meeting(session)
    make_asset(
        session, storage, meeting_id, name="old.opus", retention_until=NOW - timedelta(days=1)
    )
    purge_expired_audio(session, storage_root=storage, now=NOW)

    logs = session.scalars(select(m.AuditLog).where(m.AuditLog.action == "audio_deleted")).all()
    assert len(logs) == 1
    assert logs[0].after["reason"] == "retention_expired"


def test_already_deleted_is_not_reprocessed(session: Session, storage: Path):
    _, meeting_id, _ = seed_meeting(session)
    make_asset(
        session, storage, meeting_id, name="old.opus", retention_until=NOW - timedelta(days=1)
    )
    first = purge_expired_audio(session, storage_root=storage, now=NOW)
    second = purge_expired_audio(session, storage_root=storage, now=NOW)
    assert len(first.deleted_assets) == 1
    assert second.deleted_assets == []


def test_missing_file_still_marks_record_deleted(session: Session, storage: Path):
    """파일이 이미 없어도 레코드는 처리한다. 안 그러면 매번 재시도한다."""
    _, meeting_id, _ = seed_meeting(session)
    asset = make_asset(
        session, storage, meeting_id, name="gone.opus", retention_until=NOW - timedelta(days=1)
    )
    (storage / "gone.opus").unlink()

    report = purge_expired_audio(session, storage_root=storage, now=NOW)
    assert asset.id in report.missing_files
    assert asset.id in report.deleted_assets
    assert session.get(m.AudioAsset, asset.id).deleted_at == NOW


def test_path_traversal_is_refused(session: Session, storage: Path):
    """⚠️ storage_key 는 DB에서 온다. 경로 탈출은 곧 임의 파일 삭제다."""
    _, meeting_id, _ = seed_meeting(session)
    outside = storage.parent / "important.txt"
    outside.write_text("건드리면 안 되는 파일")

    session.add(
        m.AudioAsset(
            meeting_id=meeting_id,
            storage_key="../important.txt",
            encryption_key_id="k1",
            kind="raw",
            bytes=10,
            retention_until=NOW - timedelta(days=1),
        )
    )
    session.flush()

    report = purge_expired_audio(session, storage_root=storage, now=NOW)
    assert not report.ok
    assert outside.exists(), "저장 루트 밖의 파일이 삭제되었습니다"
    assert "저장 루트 밖" in next(iter(report.failed.values()))


def test_dry_run_deletes_nothing(session: Session, storage: Path):
    _, meeting_id, _ = seed_meeting(session)
    make_asset(
        session, storage, meeting_id, name="old.opus", retention_until=NOW - timedelta(days=1)
    )
    report = purge_expired_audio(session, storage_root=storage, now=NOW, dry_run=True)
    assert len(report.deleted_assets) == 1
    assert (storage / "old.opus").exists()


def test_report_summary_is_readable(session: Session, storage: Path):
    _, meeting_id, _ = seed_meeting(session)
    make_asset(
        session, storage, meeting_id, name="a.opus", retention_until=NOW - timedelta(days=1)
    )
    report = purge_expired_audio(session, storage_root=storage, now=NOW)
    assert "오디오 1건 삭제" in report.summary()


# ── 성문 폐기 ─────────────────────────────────────────────────


def add_voiceprint(session: Session, user_id: int, project_id: int) -> m.Voiceprint:
    vp = m.Voiceprint(
        user_id=user_id, project_id=project_id, embedding=[0.1] * 192
    )
    session.add(vp)
    session.flush()
    return vp


def test_project_end_revokes_voiceprints(session: Session):
    """성문은 프로젝트 범위 한정 데이터다. 끝나면 폐기한다."""
    project_id, _, user_id = seed_meeting(session)
    vp = add_voiceprint(session, user_id, project_id)

    report = revoke_project_voiceprints(session, project_id, now=NOW)

    assert vp.id in report.revoked_voiceprints
    stored = session.get(m.Voiceprint, vp.id)
    assert stored.revoked_at == NOW
    # 플래그만 세우면 데이터가 남는다. 임베딩 자체를 비워야 한다.
    assert stored.embedding == []


def test_revoke_is_idempotent(session: Session):
    project_id, _, user_id = seed_meeting(session)
    add_voiceprint(session, user_id, project_id)
    first = revoke_project_voiceprints(session, project_id, now=NOW)
    second = revoke_project_voiceprints(session, project_id, now=NOW)
    assert len(first.revoked_voiceprints) == 1
    assert second.revoked_voiceprints == []


def test_revoke_is_audited(session: Session):
    project_id, _, user_id = seed_meeting(session)
    add_voiceprint(session, user_id, project_id)
    revoke_project_voiceprints(session, project_id, now=NOW)
    logs = session.scalars(
        select(m.AuditLog).where(m.AuditLog.action == "voiceprint_revoked")
    ).all()
    assert len(logs) == 1


# ── 개인 삭제 요청 ────────────────────────────────────────────


def test_user_deletion_request_removes_their_audio(session: Session, storage: Path):
    """docs/07 P6 — 개인 삭제 요청 처리."""
    project_id, meeting_id, user_id = seed_meeting(session)
    track = m.MeetingTrack(meeting_id=meeting_id, user_id=user_id, started_at=NOW)
    session.add(track)
    session.flush()

    mine = make_asset(
        session,
        storage,
        meeting_id,
        name="mine.opus",
        retention_until=NOW + timedelta(days=30),
        track_id=track.id,
    )
    make_asset(
        session,
        storage,
        meeting_id,
        name="others.opus",
        retention_until=NOW + timedelta(days=30),
    )
    add_voiceprint(session, user_id, project_id)

    report = revoke_user_data(
        session, user_id=user_id, project_id=project_id, storage_root=storage, now=NOW
    )

    assert mine.id in report.deleted_assets
    assert not (storage / "mine.opus").exists()
    # 다른 사람 트랙은 건드리지 않는다
    assert (storage / "others.opus").exists()
    assert len(report.revoked_voiceprints) == 1


def test_user_deletion_keeps_shared_transcript(session: Session, storage: Path):
    """전사는 다른 참석자의 회의록이기도 하므로 남긴다."""
    project_id, meeting_id, user_id = seed_meeting(session)
    session.add(
        m.Utterance(
            meeting_id=meeting_id,
            speaker_id=user_id,
            start_ms=0,
            end_ms=1000,
            text="공유된 회의 내용",
            speaker_source="track",
        )
    )
    session.flush()

    revoke_user_data(
        session, user_id=user_id, project_id=project_id, storage_root=storage, now=NOW
    )
    assert len(session.scalars(select(m.Utterance)).all()) == 1


def test_user_deletion_is_audited(session: Session, storage: Path):
    project_id, _, user_id = seed_meeting(session)
    revoke_user_data(
        session, user_id=user_id, project_id=project_id, storage_root=storage, now=NOW
    )
    logs = session.scalars(
        select(m.AuditLog).where(m.AuditLog.action == "user_data_revoked")
    ).all()
    assert len(logs) == 1
    assert logs[0].actor_id == user_id


# ══════════════════════════════════════════════════════════════
# ② 원본 보관 동의를 거부한 사람 (docs/07 §2.3)
# ══════════════════════════════════════════════════════════════


def _track_with_consent(
    session: Session, meeting_id: int, user_id: int, *, raw_audio: bool | None
) -> m.MeetingTrack:
    track = m.MeetingTrack(
        meeting_id=meeting_id, user_id=user_id, started_at=NOW, offset_ms=0
    )
    session.add(track)
    if raw_audio is not None:
        session.add(
            m.RecordingConsent(
                meeting_id=meeting_id,
                user_id=user_id,
                consented=raw_audio,
                consent_type="raw_audio_retention",
                consented_at=NOW,
            )
        )
    session.flush()
    return track


def test_refusing_raw_audio_retention_actually_deletes_the_original(
    session: Session, storage: Path
):
    """⭐ `docs/07` §2.3 이 이렇게 적어 뒀습니다.

        ② 거부 → 전사 완료 후 원본 즉시 삭제. 텍스트만 남김.

    저장만 되고 **아무 효과가 없었습니다.** 거부한 사람의 원본이 동의한
    사람과 똑같이 30일 남았습니다. DB 에는 '거부' 로, 화면에는 '거부' 로
    표시되면서 실제 처리는 동의한 것과 같았습니다 — 동의 기록 자체가
    사실과 다른 상태이고, 분쟁에서 가장 나쁜 형태입니다.
    """
    _, meeting_id, user_id = seed_meeting(session)
    refused = _track_with_consent(session, meeting_id, user_id, raw_audio=False)
    asset = make_asset(
        session,
        storage,
        meeting_id,
        name="refused.opus",
        retention_until=NOW + timedelta(days=30),
        track_id=refused.id,
    )

    report = purge_unconsented_audio(
        session, meeting_id=meeting_id, storage_root=storage, now=NOW
    )

    assert report.ok
    assert asset.id in report.deleted_assets
    assert not (storage / "refused.opus").exists()
    assert session.get(m.AudioAsset, asset.id).deleted_reason == REASON_CONSENT_REFUSED


def test_the_others_originals_are_left_alone(session: Session, storage: Path):
    """⚠️ 거부하지 **않은** 사람 것까지 지우면 그건 데이터 손실이다.

    동의한 사람과 아직 아무 답도 안 한 사람은 보존기간을 그대로 따른다 —
    ② 는 명시적 거부일 때만 효력이 있다.
    """
    _, meeting_id, user_id = seed_meeting(session)
    agreed_user = m.User(name="이하늘", email="haneul@example.com")
    session.add(agreed_user)
    session.flush()

    agreed = _track_with_consent(session, meeting_id, agreed_user.id, raw_audio=True)
    silent = _track_with_consent(session, meeting_id, user_id, raw_audio=None)
    keep_a = make_asset(
        session, storage, meeting_id, name="agreed.opus",
        retention_until=NOW + timedelta(days=30), track_id=agreed.id,
    )
    keep_b = make_asset(
        session, storage, meeting_id, name="silent.opus",
        retention_until=NOW + timedelta(days=30), track_id=silent.id,
    )

    report = purge_unconsented_audio(
        session, meeting_id=meeting_id, storage_root=storage, now=NOW
    )

    assert report.deleted_assets == []
    assert (storage / "agreed.opus").exists()
    assert (storage / "silent.opus").exists()
    assert session.get(m.AudioAsset, keep_a.id).deleted_at is None
    assert session.get(m.AudioAsset, keep_b.id).deleted_at is None
