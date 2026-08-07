"""Celery 태스크 테스트.

브로커 없이 태스크 함수를 직접 호출해 검증한다.
저장 로직·직렬화·멱등성은 Redis 없이도 확인해야 하는 것들이다.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.pool import StaticPool

from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.pipeline.meeting_pipeline import PipelineResult, Stage
from teamflow.pipeline.runtime import FileSystemAudioLoader, read_wav
from teamflow.pipeline.steps import TranscribedSegment
from teamflow.tasks.meeting_tasks import _serialize, persist_results_task

NOW = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)


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
def seeded(engine) -> Iterator[dict]:
    with db_session.session_scope() as s:
        users = [
            m.User(name="김민수", email="a@x.com"),
            m.User(name="이하늘", email="b@x.com"),
        ]
        s.add_all(users)
        s.flush()
        project = m.Project(title="P", started_at=NOW)
        s.add(project)
        s.flush()
        for user in users:
            s.add(m.Member(project_id=project.id, user_id=user.id, role_shares={}))
        meeting = m.Meeting(
            project_id=project.id, started_at=NOW, status="processing", started_by=users[0].id
        )
        s.add(meeting)
        s.flush()
        yield {
            "project_id": project.id,
            "meeting_id": meeting.id,
            "user_ids": [u.id for u in users],
        }


def payload(
    *,
    stage: str = Stage.DONE,
    n_segments: int = 3,
    user_ids: list[int] | None = None,
    candidate_evidence: list[int] | None = None,
) -> dict:
    users = user_ids or [1, 2]
    return {
        "stage": stage,
        "error": None,
        "speaker_certainty": 1.0,
        "segments": [
            {
                "user_id": users[i % len(users)],
                "track_id": None,
                "start_ms": i * 1000,
                "end_ms": i * 1000 + 900,
                "text": f"발화 {i + 1}",
                "confidence": 0.9,
                "is_overlap": False,
                "speaker_source": "track",
            }
            for i in range(n_segments)
        ],
        "summary": "요약",
        "candidates": [
            {
                "title": "로그인 API 구현",
                "assignee_id": users[0],
                "deadline": "2026-09-04",
                "confidence": 0.9,
                "evidence": candidate_evidence or [1],
                "warnings": [],
            }
        ],
        "decisions": [{"content": "JWT 사용", "evidence": [2], "supersedes": None}],
        "rejected": 0,
    }


# ══════════════════════════════════════════════════════════════
# 직렬화
# ══════════════════════════════════════════════════════════════


def test_serialize_is_json_safe():
    """numpy 배열이 Celery 로 넘어가면 안 된다."""
    import json

    result = PipelineResult(
        meeting_id=1,
        stage=Stage.DONE,
        segments=[
            TranscribedSegment(
                user_id=1, track_id=2, start_ms=0, end_ms=900, text="안녕하세요"
            )
        ],
    )
    data = _serialize(result)
    json.dumps(data)  # 예외가 나지 않아야 한다
    assert not any(isinstance(v, np.ndarray) for v in data.values())


def test_serialize_preserves_speaker_source():
    result = PipelineResult(
        meeting_id=1,
        stage=Stage.DONE,
        segments=[
            TranscribedSegment(
                user_id=1, track_id=2, start_ms=0, end_ms=900, text="네",
                speaker_source="track",
            )
        ],
    )
    data = _serialize(result)
    assert data["segments"][0]["speaker_source"] == "track"
    assert data["speaker_certainty"] == 1.0


# ══════════════════════════════════════════════════════════════
# 저장
# ══════════════════════════════════════════════════════════════


def test_persist_writes_utterances(seeded):
    result = persist_results_task(
        seeded["meeting_id"], payload(user_ids=seeded["user_ids"])
    )
    assert result["utterances"] == 3

    with db_session.session_scope() as s:
        rows = s.scalars(select(m.Utterance)).all()
        assert len(rows) == 3
        assert rows[0].text == "발화 1"
        assert rows[0].speaker_source == "track"


def test_persist_remaps_evidence_to_real_row_ids(seeded):
    """파이프라인은 1부터 시작하는 순번을 쓴다. 실제 행 ID로 바꿔야 한다.

    안 바꾸면 근거 링크가 엉뚱한 발화를 가리키고, 화면에서 클릭하면
    다른 사람 발언이 재생된다.
    """
    persist_results_task(
        seeded["meeting_id"],
        payload(user_ids=seeded["user_ids"], candidate_evidence=[1, 3]),
    )

    with db_session.session_scope() as s:
        utterance_ids = [u.id for u in s.scalars(select(m.Utterance)).all()]
        candidate = s.scalar(select(m.MeetingTaskCandidate))
        assert candidate.evidence_utterance_ids == [utterance_ids[0], utterance_ids[2]]
        # 순번(1, 3)이 그대로 저장되면 안 된다
        assert candidate.evidence_utterance_ids != [1, 3] or utterance_ids[:1] == [1]


def test_persist_drops_out_of_range_evidence(seeded):
    """존재하지 않는 순번을 참조하면 조용히 버린다."""
    persist_results_task(
        seeded["meeting_id"],
        payload(user_ids=seeded["user_ids"], candidate_evidence=[1, 999]),
    )
    with db_session.session_scope() as s:
        candidate = s.scalar(select(m.MeetingTaskCandidate))
        assert len(candidate.evidence_utterance_ids) == 1


def test_persist_creates_candidates_not_tasks(seeded):
    """⭐ 불변식: AI 결과는 후보일 뿐 업무가 아니다.

    사람이 승인해야 tasks 로 넘어간다.
    """
    persist_results_task(seeded["meeting_id"], payload(user_ids=seeded["user_ids"]))

    with db_session.session_scope() as s:
        assert s.scalars(select(m.MeetingTaskCandidate)).all()
        assert s.scalars(select(m.Task)).all() == []


def test_persist_sets_needs_review_not_confirmed(seeded):
    """확정은 사람이 한다. 파이프라인은 needs_review 까지만."""
    persist_results_task(seeded["meeting_id"], payload(user_ids=seeded["user_ids"]))
    with db_session.session_scope() as s:
        meeting = s.get(m.Meeting, seeded["meeting_id"])
        assert meeting.status == "needs_review"


def test_persist_records_decisions(seeded):
    persist_results_task(seeded["meeting_id"], payload(user_ids=seeded["user_ids"]))
    with db_session.session_scope() as s:
        decision = s.scalar(select(m.Decision))
        assert decision.content == "JWT 사용"
        assert decision.project_id == seeded["project_id"]
        assert len(decision.evidence_utterance_ids) == 1


def test_reprocessing_does_not_duplicate_utterances(seeded):
    """재처리해도 발화가 두 배가 되면 안 된다."""
    persist_results_task(seeded["meeting_id"], payload(user_ids=seeded["user_ids"]))
    persist_results_task(seeded["meeting_id"], payload(user_ids=seeded["user_ids"]))

    with db_session.session_scope() as s:
        assert len(s.scalars(select(m.Utterance)).all()) == 3


def test_failed_pipeline_marks_meeting_failed(seeded):
    data = payload(stage=Stage.FAILED)
    data["error"] = "CUDA out of memory"
    result = persist_results_task(seeded["meeting_id"], data)

    assert result["status"] == "failed"
    with db_session.session_scope() as s:
        meeting = s.get(m.Meeting, seeded["meeting_id"])
        assert meeting.status == "failed"
        # 실패했으면 아무것도 저장하지 않는다
        assert s.scalars(select(m.Utterance)).all() == []


def test_unknown_meeting_is_handled(seeded):
    result = persist_results_task(99999, payload())
    assert result["status"] == "not_found"


# ══════════════════════════════════════════════════════════════
# 오디오 로더
# ══════════════════════════════════════════════════════════════


def write_wav(path: Path, samples: np.ndarray, sample_rate: int = 16_000) -> None:
    import wave

    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = (np.clip(samples, -1, 1) * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm.tobytes())


def test_read_wav_roundtrip(tmp_path: Path):
    original = (np.sin(np.linspace(0, 20, 16_000)) * 0.5).astype(np.float32)
    path = tmp_path / "a.wav"
    write_wav(path, original)

    loaded, rate = read_wav(path)
    assert rate == 16_000
    assert len(loaded) == len(original)
    assert np.abs(loaded - original).max() < 1e-3


def test_read_wav_downmixes_stereo(tmp_path: Path):
    import wave

    path = tmp_path / "stereo.wav"
    left = np.full(1000, 0.5, dtype=np.float32)
    right = np.full(1000, -0.5, dtype=np.float32)
    interleaved = np.empty(2000, dtype=np.float32)
    interleaved[0::2] = left
    interleaved[1::2] = right
    pcm = (interleaved * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(16_000)
        wav.writeframes(pcm.tobytes())

    loaded, _ = read_wav(path)
    assert len(loaded) == 1000
    assert np.abs(loaded).max() < 0.01  # 좌우가 상쇄된다


def test_loader_reads_tracks(seeded, tmp_path: Path):
    storage = tmp_path / "audio"
    samples = (np.random.default_rng(1).standard_normal(16_000) * 0.1).astype(np.float32)
    write_wav(storage / "t1.wav", samples)

    with db_session.session_scope() as s:
        track = m.MeetingTrack(
            meeting_id=seeded["meeting_id"],
            user_id=seeded["user_ids"][0],
            started_at=NOW,
        )
        s.add(track)
        s.flush()
        s.add(
            m.AudioAsset(
                meeting_id=seeded["meeting_id"],
                track_id=track.id,
                storage_key="t1.wav",
                encryption_key_id="k",
                kind="raw",
                retention_until=NOW + timedelta(days=30),
            )
        )

    tracks = FileSystemAudioLoader(storage_root=storage).load(seeded["meeting_id"])
    assert len(tracks) == 1
    assert tracks[0].user_id == seeded["user_ids"][0]
    assert tracks[0].sample_rate == 16_000


def test_loader_refuses_path_traversal(seeded, tmp_path: Path):
    """⚠️ storage_key 는 DB에서 온다. 읽기라도 경로 탈출은 임의 파일 노출이다."""
    storage = tmp_path / "audio"
    storage.mkdir()
    (tmp_path / "secret.wav").write_bytes(b"RIFF....")

    with db_session.session_scope() as s:
        track = m.MeetingTrack(
            meeting_id=seeded["meeting_id"], user_id=seeded["user_ids"][0], started_at=NOW
        )
        s.add(track)
        s.flush()
        s.add(
            m.AudioAsset(
                meeting_id=seeded["meeting_id"],
                track_id=track.id,
                storage_key="../secret.wav",
                encryption_key_id="k",
                kind="raw",
                retention_until=NOW + timedelta(days=30),
            )
        )

    tracks = FileSystemAudioLoader(storage_root=storage).load(seeded["meeting_id"])
    assert tracks == [], "저장 루트 밖의 파일을 읽었다"


def test_loader_computes_relative_start_offsets(seeded, tmp_path: Path):
    """기기마다 녹음 시작 시각이 다르다. 상대 오프셋이 정렬 폴백에 쓰인다."""
    storage = tmp_path / "audio"
    samples = (np.random.default_rng(2).standard_normal(8000) * 0.1).astype(np.float32)
    write_wav(storage / "a.wav", samples)
    write_wav(storage / "b.wav", samples)

    with db_session.session_scope() as s:
        for index, (user_id, delay) in enumerate(
            zip(seeded["user_ids"], [0, 3], strict=True)
        ):
            track = m.MeetingTrack(
                meeting_id=seeded["meeting_id"],
                user_id=user_id,
                started_at=NOW + timedelta(seconds=delay),
            )
            s.add(track)
            s.flush()
            s.add(
                m.AudioAsset(
                    meeting_id=seeded["meeting_id"],
                    track_id=track.id,
                    storage_key=f"{'ab'[index]}.wav",
                    encryption_key_id="k",
                    kind="raw",
                    retention_until=NOW + timedelta(days=30),
                )
            )

    tracks = FileSystemAudioLoader(storage_root=storage).load(seeded["meeting_id"])
    assert len(tracks) == 2
    offsets = sorted(t.started_at_offset_sec for t in tracks)
    assert offsets == [0.0, 3.0]


def test_loader_skips_deleted_assets(seeded, tmp_path: Path):
    """보존기간이 지나 삭제된 오디오는 로드하지 않는다."""
    storage = tmp_path / "audio"
    storage.mkdir()

    with db_session.session_scope() as s:
        track = m.MeetingTrack(
            meeting_id=seeded["meeting_id"], user_id=seeded["user_ids"][0], started_at=NOW
        )
        s.add(track)
        s.flush()
        s.add(
            m.AudioAsset(
                meeting_id=seeded["meeting_id"],
                track_id=track.id,
                storage_key="gone.wav",
                encryption_key_id="k",
                kind="raw",
                retention_until=NOW,
                deleted_at=NOW,
            )
        )

    assert FileSystemAudioLoader(storage_root=storage).load(seeded["meeting_id"]) == []


# ══════════════════════════════════════════════════════════════
# 재처리 — 발화만 지우면 나머지가 중복되고 근거가 고아가 된다
# ══════════════════════════════════════════════════════════════


def test_reprocessing_does_not_duplicate_candidates(seeded):
    """⭐ 예전에는 발화만 지워서 후보와 결정이 그대로 두 배가 됐다."""
    data = payload(user_ids=seeded["user_ids"])
    persist_results_task(seeded["meeting_id"], data)
    persist_results_task(seeded["meeting_id"], data)

    with db_session.session_scope() as s:
        candidates = s.scalars(
            select(m.MeetingTaskCandidate).where(
                m.MeetingTaskCandidate.meeting_id == seeded["meeting_id"]
            )
        ).all()
        decisions = s.scalars(
            select(m.Decision).where(m.Decision.meeting_id == seeded["meeting_id"])
        ).all()

        assert len(candidates) == len(data["candidates"])
        assert len(decisions) == len(data["decisions"])


def test_reprocessing_keeps_evidence_pointing_at_live_rows(seeded):
    """⭐ 근거 ID 가 삭제된 발화를 가리키면 안 된다.

    SQLite 는 rowid 를 재사용해 우연히 맞을 수 있으므로, "우연히 맞는가" 가
    아니라 **살아 있는 행을 가리키는가** 를 본다.
    """
    data = payload(user_ids=seeded["user_ids"])
    persist_results_task(seeded["meeting_id"], data)
    persist_results_task(seeded["meeting_id"], data)

    with db_session.session_scope() as s:
        live = set(
            s.scalars(
                select(m.Utterance.id).where(
                    m.Utterance.meeting_id == seeded["meeting_id"]
                )
            ).all()
        )
        for row in s.scalars(
            select(m.MeetingTaskCandidate).where(
                m.MeetingTaskCandidate.meeting_id == seeded["meeting_id"]
            )
        ).all():
            assert row.evidence_utterance_ids
            assert set(row.evidence_utterance_ids) <= live, "근거가 고아입니다"


def test_reprocessing_refuses_when_a_human_already_decided(seeded):
    """⭐ 승인된 후보가 있으면 재처리하지 않는다.

    발화를 새로 만들면 이미 칸반에 올라간 업무의 근거가 끊어진다.
    데이터 정정이 아니라 분쟁 근거의 훼손이다.
    """
    data = payload(user_ids=seeded["user_ids"])
    persist_results_task(seeded["meeting_id"], data)

    with db_session.session_scope() as s:
        candidate = s.scalars(
            select(m.MeetingTaskCandidate).where(
                m.MeetingTaskCandidate.meeting_id == seeded["meeting_id"]
            )
        ).first()
        candidate.review_status = "approved"
        approved_id = candidate.id
        kept_evidence = list(candidate.evidence_utterance_ids)

    result = persist_results_task(seeded["meeting_id"], data)

    assert result["status"] == "already_reviewed"
    with db_session.session_scope() as s:
        still = s.get(m.MeetingTaskCandidate, approved_id)
        assert still is not None, "승인된 후보가 지워졌습니다"
        assert list(still.evidence_utterance_ids) == kept_evidence
        live = set(
            s.scalars(
                select(m.Utterance.id).where(
                    m.Utterance.meeting_id == seeded["meeting_id"]
                )
            ).all()
        )
        assert set(kept_evidence) <= live, "승인된 후보의 근거가 끊어졌습니다"
