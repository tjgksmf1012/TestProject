"""회의 타임라인(`REVIEW-002`)과 구간 재생(`REVIEW-004`) 의 서버 계약.

가장 중요한 것 셋:
  - 전체 대본은 **구성원에게만** 나간다 (발화 원문과 같은 문)
  - 위치는 이어 붙인 소리 기준이다 — **공백만큼 당겨져** 있어야 한다
  - 못 듣는 발화는 `audio: null` 이고, 소리가 하나도 없으면 `has_audio`
    가 거짓이다 — 화면이 이유를 말할 재료다
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from teamflow.audio.chunk_store import ChunkStore
from teamflow.config import Settings, get_settings
from teamflow.db import models as m
from teamflow.db import session as db_session

from .conftest import login_as

NOW = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)
NOW_MS = int(NOW.timestamp() * 1000)
TIMESLICE = 5_000
CHUNK = b"\x1a\x45\xdf\xa3" + b"opus-payload" * 100


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
    """회의 하나 + 구성원 둘 + **바깥 사람 하나**."""
    with db_session.session_scope() as s:
        users = [
            m.User(name="김민수", email="minsu@example.com"),
            m.User(name="박지원", email="jiwon@example.com"),
            m.User(name="바깥사람", email="outsider@example.com"),
        ]
        s.add_all(users)
        s.flush()

        project = m.Project(title="TeamFlow", started_at=NOW)
        s.add(project)
        s.flush()
        for user in users[:2]:
            s.add(
                m.Member(
                    project_id=project.id, user_id=user.id, role_shares={"developer": 1.0}
                )
            )

        meeting = m.Meeting(project_id=project.id, started_at=NOW, started_by=users[0].id)
        s.add(meeting)
        s.flush()
        return {
            "meeting_id": meeting.id,
            "member": users[0].id,
            "member2": users[1].id,
            "outsider": users[2].id,
        }


def add_utterance(
    meeting_id: int,
    *,
    start_ms: int,
    end_ms: int,
    text: str,
    speaker_id: int | None = None,
    track_id: int | None = None,
) -> int:
    with db_session.session_scope() as s:
        row = m.Utterance(
            meeting_id=meeting_id,
            speaker_id=speaker_id,
            track_id=track_id,
            start_ms=start_ms,
            end_ms=end_ms,
            text=text,
            speaker_source="track" if track_id is not None else "diarization",
        )
        s.add(row)
        s.flush()
        return row.id


def add_track(
    meeting_id: int,
    user_id: int,
    store: ChunkStore,
    *,
    seqs: list[int],
    offset_ms: int = 0,
    duration_ms: int = 30_000,
) -> int:
    """트랙 + DB 청크 행 + **디스크 파일**을 같이 만든다.

    파일 없이 행만 만들면 "들을 수 있다" 가 거짓이 된다 — 서빙은 파일이다.
    """
    with db_session.session_scope() as s:
        track = m.MeetingTrack(
            meeting_id=meeting_id,
            user_id=user_id,
            started_at=NOW,
            ended_at=NOW + timedelta(milliseconds=duration_ms),
            offset_ms=offset_ms,
            status="completed",
        )
        s.add(track)
        s.flush()
        track_id = track.id
        for seq in seqs:
            s.add(
                m.TrackChunk(
                    track_id=track_id,
                    seq=seq,
                    bytes=len(CHUNK),
                    client_at_ms=NOW_MS + TIMESLICE * (seq + 1),
                )
            )
    for seq in seqs:
        store.write(meeting_id, track_id, seq, CHUNK)
    return track_id


# ── 타임라인 (`REVIEW-002`) ───────────────────────────────────


def test_timeline_is_for_members_only(client: TestClient, meeting: dict):
    """전체 대본은 발화 원문과 같은 무게다 — 바깥 사람에게는 없다."""
    add_utterance(meeting["meeting_id"], start_ms=0, end_ms=1_000, text="비밀 회의 내용")
    login_as(client, meeting["outsider"])
    response = client.get(f"/api/meetings/{meeting['meeting_id']}/timeline")
    assert response.status_code in (403, 404)
    assert "비밀 회의 내용" not in response.text


def test_timeline_returns_every_utterance_in_time_order(
    client: TestClient, meeting: dict
):
    # 넣는 순서를 시간과 어긋나게 — 정렬을 안 하면 넣은 순서가 나온다.
    add_utterance(meeting["meeting_id"], start_ms=9_000, end_ms=12_000, text="둘째")
    add_utterance(meeting["meeting_id"], start_ms=1_000, end_ms=8_000, text="첫째")
    add_utterance(meeting["meeting_id"], start_ms=15_000, end_ms=20_000, text="셋째")

    login_as(client, meeting["member"])
    response = client.get(f"/api/meetings/{meeting['meeting_id']}/timeline")
    assert response.status_code == 200
    body = response.json()
    assert [u["text"] for u in body["utterances"]] == ["첫째", "둘째", "셋째"]


def test_timeline_without_audio_says_so(client: TestClient, meeting: dict):
    """시연 데이터의 모양 그대로 — 트랙 없는 발화, 소리 없는 회의.

    `has_audio=False` 가 화면이 「이 회의는 소리가 보관돼 있지 않습니다」
    라고 말할 근거다. 재생 버튼이 조용히 안 뜨기만 하면 고장으로 읽힌다.
    """
    add_utterance(meeting["meeting_id"], start_ms=1_000, end_ms=8_000, text="아무 말")
    login_as(client, meeting["member"])
    body = client.get(f"/api/meetings/{meeting['meeting_id']}/timeline").json()
    assert body["has_audio"] is False
    assert body["utterances"][0]["audio"] is None


# ── 구간 재생 (`REVIEW-004`) ──────────────────────────────────


def test_positions_are_pulled_forward_by_gaps(
    client: TestClient, meeting: dict, audio_root: Path
):
    """⭐ 소리에는 공백이 없다 — 위치가 공백만큼 당겨져 있어야 한다.

    seq 2 를 잃은 트랙: [0~10초 소리][10~15초 공백][15~20초 소리].
    17초의 발화는 이어 붙인 소리에서 **12초** 지점이다. 그대로 17초로
    보내면 **엉뚱한 말**이 재생된다 — 근거를 들려주겠다는 화면이 다른
    발언을 들려주는 것이라, 이 한 줄이 이 기능의 존재 이유다.
    """
    store = ChunkStore(root=audio_root)
    track_id = add_track(
        meeting["meeting_id"], meeting["member"], store, seqs=[0, 1, 3]
    )
    heard = add_utterance(
        meeting["meeting_id"],
        start_ms=17_000,
        end_ms=19_000,
        text="공백 뒤의 발화",
        speaker_id=meeting["member"],
        track_id=track_id,
    )
    silent = add_utterance(
        meeting["meeting_id"],
        start_ms=12_000,
        end_ms=13_000,
        text="유실 구간의 발화",
        speaker_id=meeting["member"],
        track_id=track_id,
    )

    login_as(client, meeting["member"])
    body = client.get(f"/api/meetings/{meeting['meeting_id']}/timeline").json()
    assert body["has_audio"] is True

    by_id = {u["id"]: u for u in body["utterances"]}
    assert by_id[heard]["audio"] == {"track_id": track_id, "position_ms": 12_000}
    # 유실 구간의 발화는 **없다고 답한다** — 가장 가까운 소리로 당겨
    # 붙이면 엉뚱한 말이 나온다.
    assert by_id[silent]["audio"] is None


def test_position_respects_track_alignment_offset(
    client: TestClient, meeting: dict, audio_root: Path
):
    """정렬에서 300ms 밀린 트랙: 공통 축 6초 = 그 트랙 소리의 5.7초."""
    store = ChunkStore(root=audio_root)
    early = add_track(meeting["meeting_id"], meeting["member"], store, seqs=[0, 1])
    late = add_track(
        meeting["meeting_id"], meeting["member2"], store, seqs=[0, 1], offset_ms=300
    )
    uid = add_utterance(
        meeting["meeting_id"],
        start_ms=6_000,
        end_ms=7_000,
        text="밀린 트랙의 발화",
        speaker_id=meeting["member2"],
        track_id=late,
    )

    login_as(client, meeting["member"])
    body = client.get(f"/api/meetings/{meeting['meeting_id']}/timeline").json()
    by_id = {u["id"]: u for u in body["utterances"]}
    assert by_id[uid]["audio"] == {"track_id": late, "position_ms": 5_700}
    assert early != late


def test_track_audio_streams_chunks_in_seq_order(
    client: TestClient, meeting: dict, audio_root: Path
):
    """이어 붙인 바이트가 그대로 나온다 — seq 순서, 재인코딩 없음."""
    store = ChunkStore(root=audio_root)
    track_id = add_track(meeting["meeting_id"], meeting["member"], store, seqs=[0, 1, 2])
    # 파일 내용을 seq 별로 다르게 다시 써서 순서를 실측한다.
    for seq in (2, 0, 1):
        store.write(meeting["meeting_id"], track_id, seq, f"조각{seq}".encode())

    login_as(client, meeting["member"])
    response = client.get(
        f"/api/meetings/{meeting['meeting_id']}/tracks/{track_id}/audio"
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/webm")
    assert response.content == "조각0조각1조각2".encode()


def test_track_audio_is_honest_when_nothing_is_stored(
    client: TestClient, meeting: dict, audio_root: Path
):
    """행은 있는데 파일이 없으면(보존기간 삭제·업로드 전) 404 로 말한다."""
    store = ChunkStore(root=audio_root)
    track_id = add_track(meeting["meeting_id"], meeting["member"], store, seqs=[0])
    # 보존기간 삭제를 흉내 — 파일만 지운다.
    for path in store.track_dir(meeting["meeting_id"], track_id).glob("*.chunk"):
        path.unlink()

    login_as(client, meeting["member"])
    response = client.get(
        f"/api/meetings/{meeting['meeting_id']}/tracks/{track_id}/audio"
    )
    assert response.status_code == 404
    assert "보관" in response.json()["detail"]


def test_track_audio_is_for_members_only(
    client: TestClient, meeting: dict, audio_root: Path
):
    """소리는 동의의 산물이고 그 동의는 팀을 향했다 — 바깥에는 없다."""
    store = ChunkStore(root=audio_root)
    track_id = add_track(meeting["meeting_id"], meeting["member"], store, seqs=[0])
    login_as(client, meeting["outsider"])
    response = client.get(
        f"/api/meetings/{meeting['meeting_id']}/tracks/{track_id}/audio"
    )
    assert response.status_code in (403, 404)
    assert CHUNK not in response.content
