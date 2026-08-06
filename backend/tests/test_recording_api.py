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

        # 프로젝트 구성원으로 등록한다. 예전 픽스처는 이걸 빠뜨렸고, 그래서
        # "동의만 있으면 남의 회의에도 들어갈 수 있다" 는 구멍이 보이지 않았다.
        for user in users:
            s.add(
                m.Member(
                    project_id=project.id, user_id=user.id, role_shares={"developer": 1.0}
                )
            )

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


# ══════════════════════════════════════════════════════════════
# 녹음 종료 → 처리 시작
# ══════════════════════════════════════════════════════════════
#
# 이 연결이 없으면 녹음은 저장만 되고 아무 일도 일어나지 않는다.
# 실제로 그 상태였다 — process_meeting_task 를 큐에 넣는 코드가 없었다.


@pytest.fixture
def enqueued(monkeypatch) -> list[int]:
    """큐에 들어간 meeting_id 를 모은다. 브로커 없이 검사한다."""
    calls: list[int] = []
    from teamflow.tasks import dispatch

    monkeypatch.setattr(
        dispatch, "enqueue_meeting_processing", lambda meeting_id: calls.append(meeting_id)
    )
    return calls


def join_and_finish(client: TestClient, meeting: dict, user_index: int, *, slices: int = 1):
    """참여자 한 명이 참가해 청크 하나 올리고 종료한다."""
    track_id = join(client, meeting["meeting_id"], meeting["user_ids"][user_index]).json()[
        "track_id"
    ]
    put_chunk(client, meeting["meeting_id"], track_id, 0)
    return complete(
        client, {"meeting_id": meeting["meeting_id"], "track_id": track_id}, slices=slices
    )


def test_meeting_is_not_queued_while_someone_is_still_recording(
    client: TestClient, meeting: dict, enqueued: list[int]
):
    """⭐ 한 명이라도 녹음 중이면 시작하면 안 된다.

    먼저 처리해 버리면 그 사람 발언이 통째로 빠진 회의록이 나온다.
    """
    grant_consent(meeting["user_ids"], meeting["meeting_id"])
    join(client, meeting["meeting_id"], meeting["user_ids"][1])  # 아직 녹음 중

    body = join_and_finish(client, meeting, 0).json()

    assert body["meeting_queued"] is False
    assert "아직 녹음 중" in body["meeting_status"]
    assert enqueued == []


def test_last_participant_to_finish_starts_processing(
    client: TestClient, meeting: dict, enqueued: list[int]
):
    grant_consent(meeting["user_ids"], meeting["meeting_id"])

    assert join_and_finish(client, meeting, 0).json()["meeting_queued"] is False
    assert join_and_finish(client, meeting, 1).json()["meeting_queued"] is False

    last = join_and_finish(client, meeting, 2).json()
    assert last["meeting_queued"] is True
    assert enqueued == [meeting["meeting_id"]]


def test_finishing_first_does_not_start_processing_alone(
    client: TestClient, meeting: dict, enqueued: list[int]
):
    """⭐ 트랙만 세면 첫 번째 사람이 끝내는 순간 시작해 버린다.

    "트랙이 하나 있고 그게 끝났다" 는 맞지만 나머지 두 명은 아직 참가도
    안 했다. 참여자 명단은 **동의 기록**이다.
    """
    grant_consent(meeting["user_ids"], meeting["meeting_id"])

    body = join_and_finish(client, meeting, 0).json()

    assert body["meeting_queued"] is False
    assert "아직 참가하지 않았습니다" in body["meeting_status"]
    assert enqueued == []


def test_processing_is_queued_exactly_once(
    client: TestClient, meeting: dict, enqueued: list[int]
):
    """⭐ 두 번 들어가면 GPU 잡이 두 번 돌고 발화가 중복 저장된다."""
    grant_consent(meeting["user_ids"], meeting["meeting_id"])
    for index in range(3):
        join_and_finish(client, meeting, index)
    assert enqueued == [meeting["meeting_id"]]

    # 뒤늦게 /finish 를 눌러도 다시 들어가면 안 된다.
    client.post(f"/api/meetings/{meeting['meeting_id']}/finish")
    assert enqueued == [meeting["meeting_id"]]


def test_meeting_status_moves_to_queued(client: TestClient, meeting: dict, enqueued, engine):
    grant_consent(meeting["user_ids"], meeting["meeting_id"])
    for index in range(3):
        join_and_finish(client, meeting, index)

    with Session(engine) as s:
        assert s.get(m.Meeting, meeting["meeting_id"]).status == "queued"


# ── 강제 종료 ──────────────────────────────────────────────────


def test_finish_endpoint_aborts_stale_tracks_and_starts_processing(
    client: TestClient, meeting: dict, enqueued: list[int], engine
):
    """⭐ 브라우저를 그냥 닫은 사람이 있으면 회의가 영영 처리되지 않는다.

    사람이 그 상태를 풀 수 있어야 한다.
    """
    grant_consent(meeting["user_ids"], meeting["meeting_id"])
    join_and_finish(client, meeting, 0)
    abandoned = join(client, meeting["meeting_id"], meeting["user_ids"][1]).json()["track_id"]

    body = client.post(f"/api/meetings/{meeting['meeting_id']}/finish").json()

    assert body["aborted_track_ids"] == [abandoned]
    assert body["meeting_queued"] is True
    assert enqueued == [meeting["meeting_id"]]


def test_aborted_track_is_not_marked_completed(
    client: TestClient, meeting: dict, enqueued, engine
):
    """⭐ completed 로 두면 커버리지를 잰 적도 없는데 정상 종료로 보인다.

    그러면 그 사람의 발언량을 측정한 것처럼 취급된다 (docs/05 §4.1.1).
    """
    grant_consent(meeting["user_ids"], meeting["meeting_id"])
    abandoned = join(client, meeting["meeting_id"], meeting["user_ids"][0]).json()["track_id"]

    client.post(f"/api/meetings/{meeting['meeting_id']}/finish")

    with Session(engine) as s:
        track = s.get(m.MeetingTrack, abandoned)
        assert track.status == "aborted"
        assert track.ended_at is not None
        assert track.coverage is None, "잰 적이 없으므로 비어 있어야 한다"


def test_finish_is_harmless_when_everyone_already_stopped(
    client: TestClient, meeting: dict, enqueued: list[int]
):
    grant_consent(meeting["user_ids"], meeting["meeting_id"])
    for index in range(3):
        join_and_finish(client, meeting, index)
    assert enqueued == [meeting["meeting_id"]]

    body = client.post(f"/api/meetings/{meeting['meeting_id']}/finish").json()

    assert body["aborted_track_ids"] == []
    assert body["meeting_queued"] is False, "이미 큐에 들어갔다"
    assert enqueued == [meeting["meeting_id"]]


def test_finish_on_unknown_meeting_is_404(client: TestClient, meeting: dict):
    assert client.post("/api/meetings/99999/finish").status_code == 404


def test_broker_failure_does_not_fail_the_request(client: TestClient, meeting: dict):
    """⭐ 브로커가 죽어도 요청이 실패하면 안 된다.

    녹음은 이미 저장됐다. 여기서 500 을 내면 사용자는 녹음이 날아간 줄 알고
    다시 녹음한다 — 그게 더 나쁘다. 처리는 나중에 다시 걸면 된다.

    (`enqueued` 픽스처를 쓰지 않으므로 실제 dispatch 가 돌고, 브로커가 없어
    실패한다. 그래도 200 이 나와야 한다.)
    """
    grant_consent(meeting["user_ids"], meeting["meeting_id"])
    for index in range(2):
        join_and_finish(client, meeting, index)
    response = join_and_finish(client, meeting, 2)  # 이 호출이 큐잉을 시도한다

    assert response.status_code == 200
    assert response.json()["status"] == "completed"
    assert response.json()["meeting_queued"] is True
