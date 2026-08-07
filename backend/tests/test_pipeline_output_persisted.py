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


# ══════════════════════════════════════════════════════════════
# 결정 번복 · 미해결 사안 · 다음 안건
# ══════════════════════════════════════════════════════════════
#
# 이 셋도 같은 방식으로 버려지고 있었다.
#
#     supersedes         페이로드까지 실려 오는데 안 씀 → supersedes_id 영원히 NULL
#     unresolved_issues  `_serialize` 에 아예 없음
#     next_agenda        같음
#
# 전부 `validation.py` 를 통과한 산출물이다 — 근거 발화 id 가 실재하는지
# 확인까지 마친 것들이 그대로 버려졌다.


def test_serialize_carries_what_the_llm_made(seeded):
    """⭐ `_serialize` 가 빠뜨리면 저장 태스크는 볼 수조차 없다.

    저장 쪽을 아무리 고쳐도 소용없다 — 값이 프로세스 경계를 넘지 못한다.
    """
    analysis = MeetingAnalysis(
        summary="요약",
        decisions=[],
        tasks=[],
        unresolved_issues=[
            {"content": "배포 방식은 결론이 안 났습니다", "evidence_utterance_ids": [1]}
        ],
        next_agenda=["배포 방식 다시 논의", "테스트 범위 정하기"],
    )
    validation = validate_analysis(
        analysis,
        known_utterance_ids={1},
        members=[],
        meeting_date=NOW.date(),
    )

    result = PipelineResult(
        meeting_id=seeded["meeting_id"],
        stage=Stage.DONE,
        track_ids=list(seeded["track_ids"]),
        segments=[],
        alignment=[],
        validation=validation,
    )
    payload_out = _serialize(result)

    assert payload_out["next_agenda"] == ["배포 방식 다시 논의", "테스트 범위 정하기"]
    assert len(payload_out["unresolved_issues"]) == 1
    assert "배포 방식" in payload_out["unresolved_issues"][0]["content"]


def test_next_agenda_reaches_the_meeting_row(seeded):
    """다음 안건은 근거 발화가 없어 회의에 붙인다."""
    persist_results_task(
        seeded["meeting_id"],
        payload(seeded, next_agenda=["배포 방식 다시 논의"]),
    )

    with db_session.session_scope() as s:
        meeting = s.get(m.Meeting, seeded["meeting_id"])
        assert meeting.next_agenda == ["배포 방식 다시 논의"]


def test_unresolved_issues_become_meeting_events(seeded):
    """⭐ 새 표가 필요 없다 — `unanswered_question` 이 원래 그 자리다."""
    persist_results_task(
        seeded["meeting_id"],
        payload(
            seeded,
            unresolved_issues=[
                {"content": "배포 방식은 결론이 안 났습니다", "evidence": [1]}
            ],
        ),
    )

    with db_session.session_scope() as s:
        events = s.scalars(
            select(m.MeetingEvent).where(
                m.MeetingEvent.meeting_id == seeded["meeting_id"]
            )
        ).all()
        assert len(events) == 1
        assert events[0].event_type == "unanswered_question"
        assert events[0].detail["content"] == "배포 방식은 결론이 안 났습니다"
        # 근거 발화가 실제 행 id 로 바뀌어 있어야 한다 (1부터 시작하는
        # 순번을 그대로 두면 남의 발화를 가리킨다).
        assert events[0].evidence_utterance_ids
        utterance = s.get(m.Utterance, events[0].evidence_utterance_ids[0])
        assert utterance is not None
        # 구간은 근거 발화에서 가져온다 — 지어내지 않는다.
        assert events[0].start_ms == utterance.start_ms
        assert events[0].end_ms == utterance.end_ms


def test_an_issue_without_evidence_does_not_invent_a_span(seeded):
    """⭐ 없는 시각을 0..회의끝 으로 채우면 "회의 내내 미해결" 로 읽힌다."""
    persist_results_task(
        seeded["meeting_id"],
        payload(seeded, unresolved_issues=[{"content": "근거 없음", "evidence": []}]),
    )

    with db_session.session_scope() as s:
        event = s.scalars(select(m.MeetingEvent)).one()
        assert (event.start_ms, event.end_ms) == (0, 0)


def _prior_decision(project_id: int, content: str) -> int:
    """지난 회의에서 나온 결정.

    ⭐ **다른 회의여야 한다.** 재처리는 같은 회의의 결정을 먼저 지우므로
    (`persist_results_task` 의 삭제 루프), 같은 회의에 넣으면 조회 시점에
    이미 없다. 실제로도 뒤집히는 결정은 지난 회의에서 온다.
    """
    with db_session.session_scope() as s:
        project = s.get(m.Project, project_id)
        earlier = m.Meeting(
            project_id=project_id,
            started_at=NOW,
            started_by=s.scalars(select(m.User.id)).first(),
        )
        s.add(earlier)
        s.flush()
        row = m.Decision(
            project_id=project.id,
            meeting_id=earlier.id,
            content=content,
            status="active",
            evidence_utterance_ids=[],
        )
        s.add(row)
        s.flush()
        return row.id


def test_supersedes_links_the_decision_it_overturned(seeded):
    """⭐ `supersedes_id` 가 **영원히 NULL** 이었다.

    결정 번복 추적은 표만 있고 데이터가 없는 기능이었다. 값은 Celery
    페이로드까지 실려 왔는데 `m.Decision(...)` 이 쓰지 않았다.
    """
    with db_session.session_scope() as s:
        project_id = s.get(m.Meeting, seeded["meeting_id"]).project_id
    old_id = _prior_decision(project_id, "인증은 세션으로 간다")

    persist_results_task(
        seeded["meeting_id"],
        payload(
            seeded,
            decisions=[
                {
                    "content": "인증은 JWT 로 간다",
                    "evidence": [1],
                    "supersedes": "인증은 세션으로 간다",
                }
            ],
        ),
    )

    with db_session.session_scope() as s:
        new = s.scalars(
            select(m.Decision).where(m.Decision.content == "인증은 JWT 로 간다")
        ).one()
        assert new.supersedes_id == old_id
        assert new.supersedes_hint is None, "id 를 찾았으면 원문을 남기지 않는다"

        # ⭐ 뒤집힌 결정은 더 이상 활성이 아니다. 안 바꾸면 다음 회의의
        # `prior_decisions` 에 계속 들어가 같은 번복을 매번 다시 보고한다.
        assert s.get(m.Decision, old_id).status == "superseded"


def test_an_unmatched_hint_is_kept_not_guessed(seeded):
    """⭐ 비슷한 것을 골라 주면 회의 기록이 틀려지고, 틀린 기록은 조용하다.

    LLM 이 원문을 바꿔 쓰면 못 찾는다. 그때는 **추측하지 않고** 원문을
    남겨 사람이 고치게 한다.
    """
    with db_session.session_scope() as s:
        project_id = s.get(m.Meeting, seeded["meeting_id"]).project_id
    old_id = _prior_decision(project_id, "인증은 세션으로 간다")

    persist_results_task(
        seeded["meeting_id"],
        payload(
            seeded,
            decisions=[
                {
                    "content": "인증은 JWT 로 간다",
                    "evidence": [1],
                    # 원문과 다르게 적힌 힌트
                    "supersedes": "세션 기반 인증을 쓰기로 했던 것",
                }
            ],
        ),
    )

    with db_session.session_scope() as s:
        new = s.scalars(
            select(m.Decision).where(m.Decision.content == "인증은 JWT 로 간다")
        ).one()
        assert new.supersedes_id is None, "못 찾았는데 아무거나 이었습니다"
        assert new.supersedes_hint == "세션 기반 인증을 쓰기로 했던 것"
        # 엉뚱한 결정을 뒤집힌 것으로 표시하지 않았는가
        assert s.get(m.Decision, old_id).status == "active"


def test_no_hint_leaves_both_fields_empty(seeded):
    """번복이 아닌 보통 결정은 아무 흔적도 남기지 않는다."""
    persist_results_task(
        seeded["meeting_id"],
        payload(
            seeded,
            decisions=[
                {"content": "인증은 JWT 로 간다", "evidence": [1], "supersedes": None}
            ],
        ),
    )

    with db_session.session_scope() as s:
        new = s.scalars(select(m.Decision)).one()
        assert new.supersedes_id is None
        assert new.supersedes_hint is None


# ══════════════════════════════════════════════════════════════
# 회의 → 기여 이벤트 (기여도 세 다리 중 마지막)
# ══════════════════════════════════════════════════════════════


def test_processing_a_meeting_creates_contribution_events(seeded):
    """⭐ **그 전까지 운영 코드에 0곳이었습니다.**

    `scoring.py` 는 발언 유형별 가중치를 정확히 알고 있었는데 그 이벤트를
    만드는 코드가 없었습니다. 즉 운영에서 회의 기여도는 언제나 0이었고,
    시연 화면의 숫자는 손으로 넣은 것이었습니다.
    """
    persist_results_task(seeded["meeting_id"], payload(seeded))

    with db_session.session_scope() as s:
        rows = s.scalars(
            select(m.ContributionEventRow).where(
                m.ContributionEventRow.source_kind == "utterance"
            )
        ).all()
    assert rows, "발화에서 기여 이벤트가 하나도 나오지 않았습니다"


def test_reprocessing_a_meeting_does_not_double_the_contribution(seeded):
    """⭐ **재처리할 때마다 점수가 누적되면 안 됩니다.**

    `persist_results_task` 는 발화를 지우고 새로 만듭니다. 옛 발화에 딸린
    기여 이벤트를 같이 지우지 않으면 같은 회의가 두 번 계산됩니다.
    화면에는 아무 오류도 안 뜨고 점수만 두 배가 됩니다.
    """
    persist_results_task(seeded["meeting_id"], payload(seeded))
    with db_session.session_scope() as s:
        first = s.query(m.ContributionEventRow).count()

    persist_results_task(seeded["meeting_id"], payload(seeded))
    with db_session.session_scope() as s:
        second = s.query(m.ContributionEventRow).count()

    assert second == first


def test_the_utterance_type_column_is_filled_by_the_pipeline(seeded):
    """스키마에 처음부터 있었지만 저장 단계에서 **한 번도 채워지지 않았습니다.**"""
    persist_results_task(seeded["meeting_id"], payload(seeded))

    with db_session.session_scope() as s:
        rows = s.scalars(select(m.Utterance)).all()
    assert rows
    assert all(row.utterance_type is not None for row in rows)
