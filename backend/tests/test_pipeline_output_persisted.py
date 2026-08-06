"""파이프라인이 만든 것이 실제로 DB 에 남는가.

이 파일이 생긴 이유가 결함 자체다. 파이프라인은 요약·경고·담당자 원문·정렬
보정값을 **이미 만들고 있었고**, `_serialize` 가 그 대부분을 Celery 페이로드에
실어 저장 태스크까지 넘기고 있었다. 저장 태스크가 그걸 읽지 않았다.

    회의 요약        만들어서 → 넘겨서 → 버림   (컬럼조차 없었다)
    후보 경고        만들어서 → 넘겨서 → 버림   (컬럼조차 없었다)
    담당자 원문      만들어서 → 넘기지도 않음   (컬럼은 있었다)
    정렬 보정값      만들어서 → 넘기지도 않음   (컬럼은 있었다)

기존 테스트가 못 잡은 이유는 단순하다. **저장된 것만 확인하고, 저장되지 않은
것은 아무도 묻지 않았다.** 그래서 여기서는 페이로드에 있는 값이 DB 행에
도착하는지를 항목마다 따로 잰다.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

import numpy as np
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.pool import StaticPool

from teamflow.audio import multitrack as mt
from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.meeting.resolve import TeamMemberName
from teamflow.meeting.schema import MeetingAnalysis, TaskCandidate
from teamflow.meeting.validation import validate_analysis
from teamflow.pipeline.meeting_pipeline import PipelineResult, Stage
from teamflow.pipeline.steps import LoadedTrack, TranscribedSegment
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
    """회의 하나 + 트랙 둘. 트랙이 있어야 정렬 결과를 되돌려 쓸 수 있다."""
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
        tracks = [
            m.MeetingTrack(meeting_id=meeting.id, user_id=u.id, started_at=NOW) for u in users
        ]
        s.add_all(tracks)
        s.flush()
        yield {
            "meeting_id": meeting.id,
            "user_ids": [u.id for u in users],
            "track_ids": [t.id for t in tracks],
        }


def payload(seeded: dict, **over) -> dict:
    users = seeded["user_ids"]
    base = {
        "stage": Stage.DONE,
        "error": None,
        "speaker_certainty": 1.0,
        "segments": [
            {
                "user_id": users[0],
                "track_id": seeded["track_ids"][0],
                "start_ms": 0,
                "end_ms": 900,
                "text": "로그인 기능은 제가 맡을게요",
                "confidence": 0.9,
                "is_overlap": False,
                "speaker_source": "track",
            }
        ],
        "summary": "로그인 방식을 JWT 로 정했습니다.",
        "candidates": [
            {
                "title": "로그인 API 구현",
                "assignee_hint": "민수님",
                "assignee_id": users[0],
                "deadline": "2026-09-04",
                "confidence": 0.9,
                "evidence": [1],
                "warnings": ["마감일 해석 확신도가 낮습니다 (상대 표현)"],
            }
        ],
        "decisions": [],
        "alignment": [
            {
                "track_id": seeded["track_ids"][0],
                "offset_ms": 0,
                "confidence": 1.0,
                "method": "gcc_phat",
            },
            {
                "track_id": seeded["track_ids"][1],
                "offset_ms": 187,
                "confidence": 0.82,
                "method": "gcc_phat",
            },
        ],
        "rejected": 0,
    }
    base.update(over)
    return base


# ══════════════════════════════════════════════════════════════
# 회의 요약
# ══════════════════════════════════════════════════════════════


def test_summary_reaches_the_meeting_row(seeded):
    """⭐ 회의록은 이 시스템의 대표 산출물인데 저장되지 않고 있었다."""
    persist_results_task(seeded["meeting_id"], payload(seeded))

    with db_session.session_scope() as s:
        meeting = s.get(m.Meeting, seeded["meeting_id"])
        assert meeting.summary == "로그인 방식을 JWT 로 정했습니다."


def test_empty_summary_is_stored_as_null_not_empty_string(seeded):
    """⭐ 빈 문자열은 "요약이 없는 회의" 로 그려진다. 없는 것과 빈 것은 다르다.

    LLM 백엔드가 fake 면 요약이 빈 문자열로 온다. 그걸 그대로 저장하면
    화면은 요약란을 띄우고 그 안이 비어 있다 — 사람은 "회의에서 아무 얘기도
    안 나왔나" 로 읽는다.
    """
    persist_results_task(seeded["meeting_id"], payload(seeded, summary=""))

    with db_session.session_scope() as s:
        assert s.get(m.Meeting, seeded["meeting_id"]).summary is None


def test_reprocessing_replaces_the_summary(seeded):
    persist_results_task(seeded["meeting_id"], payload(seeded))
    persist_results_task(seeded["meeting_id"], payload(seeded, summary="다시 만든 요약"))

    with db_session.session_scope() as s:
        assert s.get(m.Meeting, seeded["meeting_id"]).summary == "다시 만든 요약"


# ══════════════════════════════════════════════════════════════
# 후보의 경고와 담당자 원문
# ══════════════════════════════════════════════════════════════


def test_warnings_reach_the_candidate_row(seeded):
    """⭐ 확신도 숫자만 남으면 사람은 무엇을 확인해야 할지 모른다."""
    persist_results_task(seeded["meeting_id"], payload(seeded))

    with db_session.session_scope() as s:
        candidate = s.scalars(select(m.MeetingTaskCandidate)).one()
        assert candidate.warnings == ["마감일 해석 확신도가 낮습니다 (상대 표현)"]


def test_assignee_hint_reaches_the_candidate_row(seeded):
    """⭐ 매칭이 실패했을 때야말로 회의에서 부른 이름이 필요하다."""
    persist_results_task(seeded["meeting_id"], payload(seeded))

    with db_session.session_scope() as s:
        assert s.scalars(select(m.MeetingTaskCandidate)).one().assignee_hint == "민수님"


def test_missing_optional_keys_do_not_break_persistence(seeded):
    """이 컬럼들이 생기기 전에 큐에 들어간 페이로드가 남아 있을 수 있다.

    Celery 큐는 배포를 건너뛴다 — 옛 워커가 만든 잡을 새 워커가 집는다.
    키가 없다고 터지면 그 회의는 영원히 실패한다.
    """
    old = payload(seeded)
    del old["candidates"][0]["warnings"]
    del old["candidates"][0]["assignee_hint"]
    del old["alignment"]

    persist_results_task(seeded["meeting_id"], old)

    with db_session.session_scope() as s:
        candidate = s.scalars(select(m.MeetingTaskCandidate)).one()
        assert candidate.warnings == []
        assert candidate.assignee_hint is None


def test_validation_carries_the_raw_hint_through(seeded):
    """⭐ 원문을 흘리는 자리가 validation 이다. 거기서 잃으면 뒤는 손쓸 수 없다.

    `assignee.matched_name` 은 명단에서 찾아낸 이름이라 매칭 실패 시 None 이다.
    회의에서 실제로 뭐라고 불렀는지는 별도로 들고 있어야 한다.
    """
    analysis = MeetingAnalysis(
        summary="요약",
        decisions=[],
        tasks=[
            TaskCandidate(
                title="로그인 API 구현",
                assignee_hint="영희님",  # 명단에 없는 사람
                deadline_hint=None,
                confidence=0.8,
                evidence_utterance_ids=[1],
            )
        ],
    )
    result = validate_analysis(
        analysis,
        known_utterance_ids={1},
        members=[TeamMemberName(user_id=1, name="김민수")],
        meeting_date=NOW.date(),
    )
    candidate = result.candidates[0]

    assert candidate.assignee.user_id is None
    assert candidate.assignee.matched_name is None
    assert candidate.assignee_hint == "영희님"
    # 페이로드까지 살아서 간다
    serialized = _serialize(
        PipelineResult(meeting_id=1, stage=Stage.DONE, validation=result)
    )
    assert serialized["candidates"][0]["assignee_hint"] == "영희님"


# ══════════════════════════════════════════════════════════════
# 정렬 보정값
# ══════════════════════════════════════════════════════════════


def test_offsets_reach_the_track_rows(seeded):
    """⭐ 이걸 안 쓰면 offset_ms 는 영원히 0 이다.

    원본 오디오는 보존기간이 지나면 지운다(P8). 그때는 정렬을 다시 추정할
    방법이 없으므로, 추정해 놓고 안 쓰는 건 영구 손실이다.
    """
    persist_results_task(seeded["meeting_id"], payload(seeded))

    with db_session.session_scope() as s:
        offsets = {
            t.id: t.offset_ms
            for t in s.scalars(select(m.MeetingTrack).order_by(m.MeetingTrack.id)).all()
        }
    assert offsets == {seeded["track_ids"][0]: 0, seeded["track_ids"][1]: 187}


def test_offset_for_an_unknown_track_is_skipped_not_fatal(seeded):
    """다른 회의의 track_id 가 섞여도 회의 전체가 실패하면 안 된다."""
    bad = payload(seeded)
    bad["alignment"].append(
        {"track_id": 9999, "offset_ms": 50, "confidence": 0.9, "method": "gcc_phat"}
    )

    result = persist_results_task(seeded["meeting_id"], bad)
    assert result["status"] == "needs_review"


def test_serialize_maps_track_index_to_track_id():
    """⭐ TrackOffset 은 **번째**를 가리킨다. 그대로 넘기면 엉뚱한 트랙에 쓴다.

    파이프라인은 로더가 준 순서로 트랙을 다루고, 저장 태스크는 그 순서를
    알 수 없다. 번역을 어디서 하느냐가 아니라 **하기는 하느냐**가 문제였다 —
    지금까지는 정렬 결과가 페이로드에 실리지도 않았다.
    """
    result = PipelineResult(
        meeting_id=1,
        stage=Stage.DONE,
        track_ids=[71, 72],
        alignment=[
            mt.TrackOffset(0, 0.0, 1.0, "gcc_phat"),
            mt.TrackOffset(1, -0.125, 0.9, "gcc_phat"),
        ],
    )
    data = _serialize(result)

    assert [a["track_id"] for a in data["alignment"]] == [71, 72]
    assert [a["offset_ms"] for a in data["alignment"]] == [0, -125]


def test_serialize_drops_offsets_that_point_nowhere():
    """트랙 목록보다 정렬 결과가 길면 조용히 잘못된 id 를 쓰게 된다."""
    result = PipelineResult(
        meeting_id=1,
        stage=Stage.DONE,
        track_ids=[71],
        alignment=[
            mt.TrackOffset(0, 0.0, 1.0, "gcc_phat"),
            mt.TrackOffset(5, 0.2, 0.9, "gcc_phat"),
        ],
    )
    assert [a["track_id"] for a in _serialize(result)["alignment"]] == [71]


def test_serialize_is_json_safe_with_alignment():
    """numpy 스칼라가 confidence 로 들어와도 Celery 로 넘어가야 한다."""
    import json

    result = PipelineResult(
        meeting_id=1,
        stage=Stage.DONE,
        track_ids=[7],
        alignment=[mt.TrackOffset(0, np.float64(0.187), np.float64(0.82), "gcc_phat")],
        segments=[TranscribedSegment(user_id=1, track_id=7, start_ms=0, end_ms=1, text="네")],
    )
    data = _serialize(result)
    json.dumps(data)  # 예외가 나지 않아야 한다
    assert data["alignment"][0]["offset_ms"] == 187
    assert isinstance(data["alignment"][0]["confidence"], float)


def test_pipeline_records_the_track_ids_it_loaded():
    """⭐ 이 목록이 없으면 정렬 결과를 DB 행에 되돌려 붙일 수 없다."""
    from teamflow.pipeline.meeting_pipeline import process_meeting

    rng = np.random.default_rng(0)
    noise = rng.normal(0, 0.1, 16_000).astype(np.float32)

    class Loader:
        def load(self, meeting_id: int) -> list[LoadedTrack]:
            return [
                LoadedTrack(track_id=41, user_id=1, samples=noise, sample_rate=16_000),
                LoadedTrack(track_id=42, user_id=2, samples=noise, sample_rate=16_000),
            ]

    class Transcriber:
        def transcribe(self, samples, sample_rate, **_kw):
            return []

    class Analyzer:
        def analyze(self, utterances, **_kw):
            return MeetingAnalysis(summary="", decisions=[], tasks=[])

    result = process_meeting(
        1,
        loader=Loader(),
        transcriber=Transcriber(),
        analyzer=Analyzer(),
        members=[],
        meeting_date=NOW.date(),
    )
    assert result.track_ids == [41, 42]
