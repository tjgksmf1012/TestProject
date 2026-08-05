"""녹음 트랙 수집 테스트.

frontend/src/lib/recording/ 이 기대하는 서버 계약을 고정한다.

가장 중요한 두 가지:
  - **동의 없이는 1바이트도 받지 않는다** (통신비밀보호법)
  - **클라이언트가 보고한 커버리지를 그대로 믿지 않는다**
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from teamflow.audio.chunk_store import ChunkStore, missing_seqs
from teamflow.config import Settings, get_settings
from teamflow.db import models as m
from teamflow.db import session as db_session

NOW = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)
NOW_MS = int(NOW.timestamp() * 1000)
TIMESLICE = 5_000
CHUNK = b"\x1a\x45\xdf\xa3" + b"opus-payload" * 100  # 대충 1.2KB


# ══════════════════════════════════════════════════════════════
# chunk_store 단위 테스트 (DB 없이)
# ══════════════════════════════════════════════════════════════


@pytest.fixture
def store(tmp_path: Path) -> ChunkStore:
    return ChunkStore(root=tmp_path / "audio")


def test_write_and_read_roundtrip(store: ChunkStore):
    store.write(1, 2, 0, CHUNK)
    assert store.read(1, 2, 0) == CHUNK


def test_write_leaves_no_partial_file(store: ChunkStore):
    """반쪽 파일이 남으면 나중에 이어 붙일 때 그 자리에서 오디오가 깨진다."""
    store.write(1, 2, 0, CHUNK)
    leftovers = list(store.track_dir(1, 2).glob("*.part*"))
    assert leftovers == []


def test_same_seq_overwrites(store: ChunkStore):
    """업로드 큐가 재시도하면 같은 청크가 두 번 온다. PUT 은 멱등이어야 한다."""
    store.write(1, 2, 0, b"first-attempt")
    store.write(1, 2, 0, b"retry-attempt")
    assert store.read(1, 2, 0) == b"retry-attempt"
    assert store.stored_seqs(1, 2) == [0]


def test_empty_chunk_is_rejected(store: ChunkStore):
    with pytest.raises(ValueError, match="빈 청크"):
        store.write(1, 2, 0, b"")


def test_oversized_chunk_is_rejected(store: ChunkStore):
    """상한이 없으면 디스크가 찰 때까지 아무나 밀어넣을 수 있다."""
    with pytest.raises(ValueError, match="너무 큽니다"):
        store.write(1, 2, 0, b"x" * (3 * 1024 * 1024))


def test_negative_seq_is_rejected(store: ChunkStore):
    with pytest.raises(ValueError, match="0 이상"):
        store.write(1, 2, -1, CHUNK)


def test_stored_seqs_is_sorted_numerically(store: ChunkStore):
    for seq in (10, 2, 0, 101):
        store.write(1, 2, seq, CHUNK)
    # 문자열 정렬이면 [0, 10, 101, 2] 가 된다 — 0채움을 쓰는 이유다
    assert store.stored_seqs(1, 2) == [0, 2, 10, 101]


def test_stored_seqs_ignores_junk(store: ChunkStore):
    store.write(1, 2, 0, CHUNK)
    (store.track_dir(1, 2) / "notes.chunk").write_text("사람이 넣어둔 파일")
    assert store.stored_seqs(1, 2) == [0]


def test_stored_seqs_of_unknown_track_is_empty(store: ChunkStore):
    assert store.stored_seqs(999, 999) == []


def test_tracks_do_not_collide(store: ChunkStore):
    store.write(1, 10, 0, b"track-ten")
    store.write(1, 11, 0, b"track-eleven")
    assert store.read(1, 10, 0) == b"track-ten"
    assert store.read(1, 11, 0) == b"track-eleven"


def test_concatenate_follows_seq_order(store: ChunkStore, tmp_path: Path):
    for seq, payload in enumerate([b"AAA", b"BBB", b"CCC"]):
        store.write(1, 2, seq, payload)
    target = tmp_path / "out" / "track.webm"
    assert store.concatenate(1, 2, target) == 3
    assert target.read_bytes() == b"AAABBBCCC"


def test_concatenate_silently_shrinks_when_a_chunk_is_missing(
    store: ChunkStore, tmp_path: Path
):
    """⭐ 이어 붙이기만 하면 빠진 자리가 그냥 사라진다.

    무음 패딩은 타임라인 정보가 있어야 가능하다 (docs/04 §2.6).
    이 테스트는 그 사실을 코드에 못 박아 둔 것이다.
    """
    store.write(1, 2, 0, b"AAA")
    store.write(1, 2, 2, b"CCC")  # seq 1 이 없다
    target = tmp_path / "track.webm"
    store.concatenate(1, 2, target)

    assert target.read_bytes() == b"AAACCC", "빈 자리가 메워지지 않는다"
    assert missing_seqs(store.stored_seqs(1, 2), 3) == [1]


def test_missing_seqs():
    assert missing_seqs([0, 1, 2], 3) == []
    assert missing_seqs([0, 2], 3) == [1]
    assert missing_seqs([], 2) == [0, 1]
    assert missing_seqs([0, 1, 2], 2) == []


def test_total_bytes(store: ChunkStore):
    store.write(1, 2, 0, b"x" * 100)
    store.write(1, 2, 1, b"x" * 250)
    assert store.total_bytes(1, 2) == 350


# ══════════════════════════════════════════════════════════════
# API 통합 테스트
# ══════════════════════════════════════════════════════════════


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
def audio_root(tmp_path: Path) -> Path:
    return tmp_path / "audio"


@pytest.fixture
def client(engine, audio_root: Path) -> Iterator[TestClient]:
    from teamflow.api.main import app

    def _settings() -> Settings:
        return Settings(
            environment="test",
            github_webhook_secret="test-secret",
            database_url="sqlite://",
            audio_storage_root=audio_root,
        )

    app.dependency_overrides[get_settings] = _settings
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def meeting(engine) -> dict[str, int]:
    """회의 하나 + 팀원 셋. 동의는 아직 없다."""
    with db_session.session_scope() as s:
        users = [
            m.User(name="김민수", email="minsu@example.com"),
            m.User(name="이하늘", email="haneul@example.com"),
            m.User(name="박지원", email="jiwon@example.com"),
        ]
        s.add_all(users)
        s.flush()

        project = m.Project(title="TeamFlow", started_at=NOW)
        s.add(project)
        s.flush()

        meeting = m.Meeting(
            project_id=project.id, started_at=NOW, started_by=users[0].id
        )
        s.add(meeting)
        s.flush()
        return {"meeting_id": meeting.id, "user_ids": [u.id for u in users]}


def grant_consent(user_ids: list[int], meeting_id: int, *, consented: bool = True):
    with db_session.session_scope() as s:
        for user_id in user_ids:
            s.add(
                m.RecordingConsent(
                    meeting_id=meeting_id,
                    user_id=user_id,
                    consented=consented,
                    consent_type="recording",
                )
            )


def join(client: TestClient, meeting_id: int, user_id: int):
    return client.post(
        f"/api/meetings/{meeting_id}/tracks",
        json={"user_id": user_id, "started_at": NOW.isoformat(), "device_label": "iPhone"},
    )


def chunk_time(seq: int) -> int:
    """seq 번째 청크가 도착하는 시각. 5초마다 하나씩 온다."""
    return NOW_MS + TIMESLICE * (seq + 1)


def put_chunk(
    client: TestClient,
    meeting_id: int,
    track_id: int,
    seq: int,
    *,
    at_ms: int | None = None,
    data: bytes = CHUNK,
):
    return client.put(
        f"/api/meetings/{meeting_id}/tracks/{track_id}/chunks/{seq}",
        content=data,
        headers={"X-Client-At-Ms": str(at_ms if at_ms is not None else chunk_time(seq))},
    )


@pytest.fixture
def track(client: TestClient, meeting: dict) -> dict[str, int]:
    grant_consent(meeting["user_ids"], meeting["meeting_id"])
    response = join(client, meeting["meeting_id"], meeting["user_ids"][0])
    assert response.status_code == 201
    return {"meeting_id": meeting["meeting_id"], "track_id": response.json()["track_id"]}


# ── 동의 게이트 ────────────────────────────────────────────────


def test_join_without_consent_is_forbidden(client: TestClient, meeting: dict):
    """⭐ 동의 기록이 아예 없으면 거부한다.

    "전원 동의"를 공집합에 적용하면 참이 되지만, 여기서는 그게 곧 사고다.
    """
    response = join(client, meeting["meeting_id"], meeting["user_ids"][0])
    assert response.status_code == 403
    assert "동의" in response.json()["detail"]


def test_join_with_partial_consent_is_forbidden(client: TestClient, meeting: dict):
    """한 명이라도 응답하지 않았으면 시작할 수 없다."""
    grant_consent(meeting["user_ids"][:2], meeting["meeting_id"])
    grant_consent(meeting["user_ids"][2:], meeting["meeting_id"], consented=False)

    response = join(client, meeting["meeting_id"], meeting["user_ids"][0])
    assert response.status_code == 403
    assert "1명이 녹음에 동의하지 않았습니다" in response.json()["detail"]


def test_join_with_full_consent_succeeds(client: TestClient, meeting: dict):
    grant_consent(meeting["user_ids"], meeting["meeting_id"])
    response = join(client, meeting["meeting_id"], meeting["user_ids"][0])

    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "recording"
    assert body["stored_seqs"] == []


def test_join_is_idempotent(client: TestClient, meeting: dict):
    """새로고침해도 트랙이 하나여야 한다. 둘이 되면 그 사람이 두 명으로 세어진다."""
    grant_consent(meeting["user_ids"], meeting["meeting_id"])
    first = join(client, meeting["meeting_id"], meeting["user_ids"][0]).json()
    second = join(client, meeting["meeting_id"], meeting["user_ids"][0]).json()
    assert first["track_id"] == second["track_id"]


def test_unknown_meeting_is_404(client: TestClient, meeting: dict):
    response = join(client, 99_999, meeting["user_ids"][0])
    assert response.status_code == 404


# ── 청크 업로드 ────────────────────────────────────────────────


def test_put_chunk_stores_file_and_row(
    client: TestClient, track: dict, audio_root: Path, engine
):
    response = put_chunk(client, track["meeting_id"], track["track_id"], 0)
    assert response.status_code == 200
    assert response.json() == {"seq": 0, "bytes": len(CHUNK)}

    store = ChunkStore(root=audio_root)
    assert store.read(track["meeting_id"], track["track_id"], 0) == CHUNK

    with Session(engine) as s:
        rows = s.scalars(
            select(m.TrackChunk).where(m.TrackChunk.track_id == track["track_id"])
        ).all()
        assert len(rows) == 1
        assert rows[0].client_at_ms == chunk_time(0)


def test_put_same_seq_twice_is_idempotent(client: TestClient, track: dict, engine):
    put_chunk(client, track["meeting_id"], track["track_id"], 0, data=b"first")
    put_chunk(
        client,
        track["meeting_id"],
        track["track_id"],
        0,
        at_ms=chunk_time(0) + 40,  # 재시도 시점의 시각이 조금 다르다
        data=b"retry",
    )

    with Session(engine) as s:
        rows = s.scalars(
            select(m.TrackChunk).where(m.TrackChunk.track_id == track["track_id"])
        ).all()
        assert len(rows) == 1, "재시도가 행을 두 개 만들면 안 된다"
        assert rows[0].bytes == len(b"retry")
        assert rows[0].client_at_ms == chunk_time(0) + 40


def test_put_chunk_requires_client_timestamp(client: TestClient, track: dict):
    """⭐ 시각이 없으면 공백을 절대 시각으로 복원할 수 없다."""
    response = client.put(
        f"/api/meetings/{track['meeting_id']}/tracks/{track['track_id']}/chunks/0",
        content=CHUNK,
    )
    assert response.status_code == 400
    assert "X-Client-At-Ms" in response.json()["detail"]


def test_put_empty_chunk_is_rejected(client: TestClient, track: dict):
    response = put_chunk(client, track["meeting_id"], track["track_id"], 0, data=b"")
    assert response.status_code == 400


def test_put_oversized_chunk_is_rejected(client: TestClient, track: dict):
    response = put_chunk(
        client, track["meeting_id"], track["track_id"], 0, data=b"x" * (3 * 1024 * 1024)
    )
    assert response.status_code == 400


def test_put_chunk_to_unknown_track_is_404(client: TestClient, track: dict):
    response = put_chunk(client, track["meeting_id"], 99_999, 0)
    assert response.status_code == 404


def test_put_chunk_to_another_meetings_track_is_404(client: TestClient, track: dict):
    """트랙 id 만 알면 남의 회의에 밀어넣을 수 있으면 안 된다."""
    response = put_chunk(client, track["meeting_id"] + 1, track["track_id"], 0)
    assert response.status_code == 404


def test_put_chunk_after_consent_revoked_is_forbidden(
    client: TestClient, track: dict, meeting: dict, audio_root: Path
):
    """⭐ 회의 도중 철회하면 그 즉시 수집이 멈춘다.

    클라이언트 상태 머신도 막지만, 요청은 curl 로도 보낼 수 있다.
    제3자 녹음은 형사처벌 대상이라 서버가 최종 방어선이어야 한다.
    """
    assert put_chunk(client, track["meeting_id"], track["track_id"], 0).status_code == 200

    with db_session.session_scope() as s:
        consent = s.scalars(
            select(m.RecordingConsent).where(
                m.RecordingConsent.user_id == meeting["user_ids"][1]
            )
        ).one()
        consent.consented = False

    response = put_chunk(client, track["meeting_id"], track["track_id"], 1)
    assert response.status_code == 403

    store = ChunkStore(root=audio_root)
    assert store.stored_seqs(track["meeting_id"], track["track_id"]) == [0], (
        "철회 전에 받은 것은 남는다 — 철회는 소급이 아니다 (docs/07)"
    )


# ── 재개 ──────────────────────────────────────────────────────


def test_list_chunks_reports_what_server_has(client: TestClient, track: dict):
    for seq in (0, 1, 2, 4):  # seq 3 은 업로드 실패
        put_chunk(client, track["meeting_id"], track["track_id"], seq)

    body = client.get(
        f"/api/meetings/{track['meeting_id']}/tracks/{track['track_id']}/chunks"
    ).json()

    assert body["seqs"] == [0, 1, 2, 4]
    assert body["total_bytes"] == len(CHUNK) * 4


def test_list_chunks_of_fresh_track_is_empty(client: TestClient, track: dict):
    body = client.get(
        f"/api/meetings/{track['meeting_id']}/tracks/{track['track_id']}/chunks"
    ).json()
    assert body["seqs"] == []


def test_rejoin_returns_stored_seqs_for_resume(
    client: TestClient, track: dict, meeting: dict
):
    """⭐ 재연결 시 이어서 올릴 수 있어야 한다.

    이게 없으면 매번 처음부터 다시 올려 영영 못 따라잡는다
    (frontend UploadQueue.resumeWith).
    """
    for seq in range(3):
        put_chunk(client, track["meeting_id"], track["track_id"], seq)

    rejoined = join(client, meeting["meeting_id"], meeting["user_ids"][0]).json()
    assert rejoined["track_id"] == track["track_id"]
    assert rejoined["stored_seqs"] == [0, 1, 2]


# ── 종료 ──────────────────────────────────────────────────────


def complete(client: TestClient, track: dict, *, slices: int = 1, **overrides):
    """녹음 종료. `slices` 는 클라이언트가 만든 청크 수 = 녹음 길이/5초.

    종료 시각이 청크 수와 맞아야 서버가 배치를 제대로 계산한다.
    """
    payload = {
        "ended_at": (NOW + timedelta(seconds=5 * slices)).isoformat(),
        "coverage": 1.0,
        "total_gap_ms": 0,
        "longest_gap_ms": 0,
        "gaps": [],
        "capture_confidence": 1.0,
        "capture_warnings": [],
        "stop_reason": "user",
        "timeslice_ms": TIMESLICE,
    }
    payload.update(overrides)
    return client.post(
        f"/api/meetings/{track['meeting_id']}/tracks/{track['track_id']}/complete",
        json=payload,
    )


def test_complete_marks_track_completed(client: TestClient, track: dict, engine):
    for seq in range(4):
        put_chunk(client, track["meeting_id"], track["track_id"], seq)

    body = complete(client, track, slices=4).json()
    assert body["status"] == "completed"
    assert body["usable"] is True
    assert body["coverage"] == 1.0

    with Session(engine) as s:
        row = s.get(m.MeetingTrack, track["track_id"])
        assert row.ended_at is not None
        assert row.stop_reason == "user"


def test_complete_stores_gaps_and_warnings(client: TestClient, track: dict, engine):
    put_chunk(client, track["meeting_id"], track["track_id"], 0)
    complete(
        client,
        track,
        slices=1,
        coverage=0.9,
        total_gap_ms=6_000,
        longest_gap_ms=6_000,
        gaps=[{"reason": "track_muted", "durationMs": 6000}],
        capture_confidence=0.7,
        capture_warnings=[{"setting": "autoGainControl", "severity": "critical"}],
    )

    with Session(engine) as s:
        row = s.get(m.MeetingTrack, track["track_id"])
        assert row.gaps[0]["reason"] == "track_muted"
        assert row.capture_warnings[0]["setting"] == "autoGainControl"
        assert float(row.capture_confidence) == 0.7


def test_low_coverage_track_is_marked_unusable(client: TestClient, track: dict):
    """⭐ 조용히 낮은 점수를 주는 대신 못 쓴다고 말한다.

    폰이 잠긴 사람을 "말을 안 한 사람"으로 처리하면 그건 그냥 오답이다.
    """
    for seq in range(4):
        put_chunk(client, track["meeting_id"], track["track_id"], seq)

    body = complete(client, track, slices=4, coverage=0.4, total_gap_ms=36_000).json()
    assert body["status"] == "unusable"
    assert body["usable"] is False
    assert "발화량을 판단할 수 없습니다" in body["message"]


def test_server_does_not_trust_inflated_client_coverage(client: TestClient, track: dict):
    """⭐ 클라이언트는 자기가 만든 청크 기준으로 계산한다.

    그중 일부는 업로드에 실패해 서버에 없을 수 있다. 서버가 실제로 받은
    것과 대조하지 않으면 구멍난 트랙이 100%로 기록된다.
    """
    for seq in (0, 1, 3, 4, 6, 8, 9):  # 2, 5, 7 은 끝내 실패
        put_chunk(client, track["meeting_id"], track["track_id"], seq)

    body = complete(client, track, slices=10, coverage=1.0).json()

    assert body["coverage"] == 0.7, "50초 중 15초가 비었다 (유실 3개 × 5초)"
    assert body["usable"] is False


def test_server_finds_a_gap_the_client_never_reported(
    client: TestClient, track: dict, engine
):
    """⭐ 클라이언트가 "문제 없었다"고 해도 서버가 타임스탬프로 직접 본다.

    청크는 전부 도착했지만 seq 1 과 2 사이에 30초가 비어 있다.
    폰이 잠겨 레코더가 멈춘 것이고, 클라이언트 보고가 틀렸거나 없어도
    서버 혼자 알아낸다.
    """
    put_chunk(client, track["meeting_id"], track["track_id"], 0, at_ms=NOW_MS + 5_000)
    put_chunk(client, track["meeting_id"], track["track_id"], 1, at_ms=NOW_MS + 10_000)
    put_chunk(client, track["meeting_id"], track["track_id"], 2, at_ms=NOW_MS + 45_000)
    put_chunk(client, track["meeting_id"], track["track_id"], 3, at_ms=NOW_MS + 50_000)

    body = complete(client, track, slices=10, coverage=1.0, total_gap_ms=0).json()

    assert body["coverage"] == 0.4, "50초 중 30초가 비었다"
    assert body["usable"] is False

    with Session(engine) as s:
        row = s.get(m.MeetingTrack, track["track_id"])
        assert [g["reason"] for g in row.gaps] == ["recorder_stalled"]
        assert row.gaps[0]["durationMs"] == 30_000
        assert row.total_gap_ms == 30_000


def test_server_labels_upload_loss_differently_from_a_stall(
    client: TestClient, track: dict, engine
):
    """원인이 다르면 사용자에게 할 말도 다르다.

    한쪽은 "녹음 중에는 화면을 켜두세요", 다른 쪽은 "네트워크가 불안정했습니다".
    seq 가 0부터 빽빽하게 올라간다는 성질 덕에 서버 혼자 구별한다.
    """
    for seq in (0, 1, 3, 4):  # seq 2 가 업로드에 실패했다
        put_chunk(client, track["meeting_id"], track["track_id"], seq)

    complete(client, track, slices=5, coverage=1.0)

    with Session(engine) as s:
        row = s.get(m.MeetingTrack, track["track_id"])
        assert [g["reason"] for g in row.gaps] == ["chunk_lost"]


def test_client_only_gap_reasons_survive(client: TestClient, track: dict, engine):
    """`track_muted` 는 서버가 알 방법이 없다 — 청크는 정상적으로 오니까.

    서버 계산으로 덮어쓰면 이 정보가 사라진다.
    """
    for seq in range(4):
        put_chunk(client, track["meeting_id"], track["track_id"], seq)

    complete(
        client,
        track,
        slices=4,
        coverage=0.75,
        total_gap_ms=5_000,
        gaps=[{"reason": "track_muted", "startMs": 5_000, "endMs": 10_000}],
    )

    with Session(engine) as s:
        row = s.get(m.MeetingTrack, track["track_id"])
        reasons = [g["reason"] for g in row.gaps]
        assert "track_muted" in reasons
        assert row.coverage is not None and float(row.coverage) == 0.75


def test_server_keeps_client_coverage_when_it_is_worse(client: TestClient, track: dict):
    """반대로 클라이언트가 더 비관적이면 그쪽을 존중한다.

    청크는 다 올라왔어도 그 안이 무음일 수 있다 (mute 구간).
    서버는 그걸 알 방법이 없다.
    """
    for seq in range(10):
        put_chunk(client, track["meeting_id"], track["track_id"], seq)

    body = complete(client, track, slices=10, coverage=0.5, total_gap_ms=30_000).json()
    assert body["coverage"] == 0.5


def test_complete_on_unknown_track_is_404(client: TestClient, track: dict):
    response = client.post(
        f"/api/meetings/{track['meeting_id']}/tracks/99999/complete",
        json={"ended_at": NOW.isoformat(), "coverage": 1.0, "total_gap_ms": 0},
    )
    assert response.status_code == 404


def test_chunks_are_refused_after_completion(client: TestClient, track: dict):
    put_chunk(client, track["meeting_id"], track["track_id"], 0)
    complete(client, track)

    response = put_chunk(client, track["meeting_id"], track["track_id"], 1)
    assert response.status_code == 404
    assert "녹음이 끝난" in response.json()["detail"]


def test_rejoining_a_completed_track_conflicts(
    client: TestClient, track: dict, meeting: dict
):
    put_chunk(client, track["meeting_id"], track["track_id"], 0)
    complete(client, track)

    response = join(client, meeting["meeting_id"], meeting["user_ids"][0])
    assert response.status_code == 409


# ── 트랙 현황 ──────────────────────────────────────────────────


def test_track_list_shows_consent_and_health(
    client: TestClient, track: dict, meeting: dict
):
    for seq in range(4):
        put_chunk(client, track["meeting_id"], track["track_id"], seq)
    complete(client, track, slices=4, coverage=0.55, capture_confidence=0.7)

    body = client.get(f"/api/meetings/{meeting['meeting_id']}/tracks").json()

    assert body["consent"] == {
        "total": 3,
        "granted": 3,
        "refused": 0,
        "all_confirmed": True,
    }
    assert len(body["tracks"]) == 1
    health = body["tracks"][0]
    assert health["status"] == "unusable"
    assert health["coverage"] == 0.55
    assert health["capture_confidence"] == 0.7


def test_track_list_exposes_refusals(client: TestClient, meeting: dict):
    grant_consent(meeting["user_ids"][:2], meeting["meeting_id"])
    grant_consent(meeting["user_ids"][2:], meeting["meeting_id"], consented=False)

    body = client.get(f"/api/meetings/{meeting['meeting_id']}/tracks").json()
    assert body["consent"]["refused"] == 1
    assert body["consent"]["all_confirmed"] is False
    assert body["tracks"] == []
