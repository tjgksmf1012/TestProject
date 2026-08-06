"""전 구간 통합 테스트 — 폰이 올린 청크가 칸반 업무가 될 때까지.

이 파일이 왜 따로 있는가:

    test_recording_api.py   업로드까지  ✅
    test_chunk_loader.py    청크 → 트랙  ✅
    test_meeting_pipeline.py 파이프라인   ✅
    test_api.py             승인 → 칸반  ✅
    ─────────────────────────────────────
    (없음)                  이 넷이 서로 연결돼 있는가  ❌

각 구간이 전부 통과하는데도 **아무도 `process_meeting_task` 를 큐에 넣지
않았고, 잡은 항상 WAV 로더를 썼습니다.** 청크 업로드·재조립·정렬을 다
만들어 놓고도 멀티트랙 경로가 한 번도 실행된 적이 없었습니다. 구간별
테스트로는 원리적으로 못 잡습니다 — 각 구간은 정상이었으니까요.

그래서 여기서는 **가짜로 바꾸는 것을 셋으로 제한**합니다.

    FFmpeg 디코더   이 환경에 ffmpeg 바이너리가 없다
    ASR             GPU 도 모델도 없다
    LLM             〃

나머지는 전부 진짜입니다 — HTTP, DB, 동의 게이트, 청크 저장, 배치 계산,
무음 패딩, GCC-PHAT 정렬, 주화자 판정, 누출 제거, 환각 검증, 승인 규칙.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select

from teamflow.audio import decode
from teamflow.config import Settings, get_settings
from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.meeting.resolve import TeamMemberName
from teamflow.meeting.schema import Decision, MeetingAnalysis, TaskCandidate
from teamflow.pipeline import runtime
from teamflow.pipeline.meeting_pipeline import Stage, process_meeting
from teamflow.tasks.meeting_tasks import _serialize, persist_results_task

# 2026-09-01 은 화요일. "금요일까지" → 09-04 로 풀려야 한다.
NOW = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)
NOW_MS = int(NOW.timestamp() * 1000)
TIMESLICE = 5_000
CHUNKS_PER_TRACK = 4
SR = 16_000

LOUD = 220
QUIET = 8

#: 트랙별로 "언제 큰 소리가 나는가". 인덱스 = 트랙 순서, 값 = 그 사람이 말하는 seq.
SPEAKING_SEQS = ({0, 1}, {2}, {3})


# ══════════════════════════════════════════════════════════════
# 가짜로 바꾸는 것 셋 — 그리고 그게 전부다
# ══════════════════════════════════════════════════════════════


def room_noise(seq: int, n: int) -> np.ndarray:
    """그 순간 회의실에 있던 소리. **모든 폰이 같은 소리를 듣는다.**

    트랙마다 다른 잡음을 넣으면 GCC-PHAT 이 상관을 찾지 못해 정렬이
    실패한다. 실제 회의실에서 트랙들이 정렬되는 이유가 바로 이것 —
    같은 소리가 서로 다른 크기로 새어 들어오기 때문이다.
    """
    return np.random.default_rng(1_000 + seq).standard_normal(n).astype(np.float32)


def chunk_bytes(amplitude: int, seq: int) -> bytes:
    """가짜 인코딩. 첫 두 바이트에 크기와 순번을 적어 둔다."""
    return bytes([amplitude, seq]) + b"\x00" * 300


class FakeDecoder:
    """ffmpeg 자리. 바이트 → PCM 변환만 대신한다."""

    def __init__(self) -> None:
        self.calls = 0

    def decode(self, data: bytes, *, target_sample_rate: int) -> np.ndarray:
        self.calls += 1
        amplitude, seq = data[0], data[1]
        n = int(TIMESLICE * target_sample_rate / 1000)
        return (room_noise(seq, n) * (amplitude / 255.0)).astype(np.float32)


SCRIPT: tuple[tuple[int, int, str, float], ...] = (
    (1_000, 9_000, "로그인 API는 제가 금요일까지 만들게요", 0.95),
    (10_000, 14_000, "저는 회원가입 화면을 맡을게요", 0.93),
    (15_000, 19_000, "그럼 저는 DB 스키마를 정리하겠습니다", 0.91),
)


class FakeTranscriber:
    """ASR 자리. 호출 순서대로 대본을 돌려준다."""

    def __init__(self) -> None:
        self.calls = 0

    def transcribe(
        self, samples: np.ndarray, sample_rate: int, *, language: str = "ko"
    ) -> list[tuple[int, int, str, float]]:
        line = SCRIPT[self.calls % len(SCRIPT)]
        self.calls += 1
        return [line]


class FakeAnalyzer:
    """LLM 자리. 근거 발화 ID는 **실제로 넘어온 것**만 쓴다."""

    def __init__(self) -> None:
        self.seen: list[tuple[int, str, str]] = []

    def analyze(self, utterances, *, prior_decisions=None, open_tasks=None):
        self.seen = list(utterances)
        first = utterances[0][0]
        return MeetingAnalysis(
            summary="로그인 기능 분담을 정했습니다.",
            decisions=[
                Decision(content="인증은 JWT 로 간다", evidence_utterance_ids=[first])
            ],
            tasks=[
                TaskCandidate(
                    title="로그인 API 구현",
                    assignee_hint="민수",
                    deadline_hint="금요일까지",
                    confidence=0.9,
                    evidence_utterance_ids=[first],
                )
            ],
        )


# ══════════════════════════════════════════════════════════════
# 픽스처
# ══════════════════════════════════════════════════════════════


@pytest.fixture
def engine(tmp_path: Path):
    """**파일 기반**이다. 인메모리가 아니다.

    커넥션이 진짜로 분리돼야 "큐잉 시점에 다른 커넥션이 무엇을 보는가" 를
    잴 수 있다 (§6). 인메모리 + StaticPool 은 커넥션이 하나뿐이라 커밋 전
    데이터도 보여서, 순서 결함이 있어도 테스트가 통과해 버린다.
    """
    eng = create_engine(f"sqlite:///{tmp_path / 'e2e.db'}")
    m.Base.metadata.create_all(eng)
    db_session.configure(eng)
    yield eng
    eng.dispose()


@pytest.fixture
def audio_root(tmp_path: Path) -> Path:
    return tmp_path / "audio"


@pytest.fixture
def settings(audio_root: Path) -> Settings:
    return Settings(
        environment="test",
        github_webhook_secret="test-secret",
        database_url="sqlite://",
        audio_storage_root=audio_root,
    )


@pytest.fixture
def client(engine, settings: Settings) -> Iterator[TestClient]:
    from teamflow.api.main import app

    app.dependency_overrides[get_settings] = lambda: settings
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def enqueued(monkeypatch) -> list[int]:
    """큐잉을 가로챈다. 브로커 없이 "들어갔는가"만 본다."""
    calls: list[int] = []
    from teamflow.tasks import dispatch

    monkeypatch.setattr(
        dispatch, "enqueue_meeting_processing", lambda meeting_id: calls.append(meeting_id)
    )
    return calls


@pytest.fixture
def fake_ffmpeg(monkeypatch) -> FakeDecoder:
    """ffmpeg 자리에 가짜를 꽂는다. **로더 선택 경로는 진짜로 탄다.**"""
    decoder = FakeDecoder()
    monkeypatch.setattr(decode, "build_decoder", lambda **_: decoder)
    return decoder


@pytest.fixture
def project(engine) -> dict:
    """프로젝트 하나 + 팀원 셋. 회의는 멀티트랙(모드 A)."""
    with db_session.session_scope() as s:
        users = [
            m.User(name="김민수", email="minsu@example.com"),
            m.User(name="이하늘", email="haneul@example.com"),
            m.User(name="박지원", email="jiwon@example.com"),
        ]
        s.add_all(users)
        s.flush()

        proj = m.Project(title="TeamFlow", started_at=NOW)
        s.add(proj)
        s.flush()

        for user in users:
            s.add(
                m.Member(
                    project_id=proj.id, user_id=user.id, role_shares={"developer": 1.0}
                )
            )

        meeting = m.Meeting(
            project_id=proj.id,
            started_at=NOW,
            started_by=users[0].id,
            capture_mode="multitrack",
        )
        s.add(meeting)
        s.flush()

        for user in users:
            s.add(
                m.RecordingConsent(
                    meeting_id=meeting.id,
                    user_id=user.id,
                    consented=True,
                    consent_type="recording",
                )
            )

        return {
            "project_id": proj.id,
            "meeting_id": meeting.id,
            "user_ids": [u.id for u in users],
            "names": [u.name for u in users],
        }


def members_of(project: dict) -> list[TeamMemberName]:
    return [
        TeamMemberName(user_id=uid, name=name)
        for uid, name in zip(project["user_ids"], project["names"], strict=True)
    ]


# ── 폰이 하는 일 ──────────────────────────────────────────────


def record_track(
    client: TestClient,
    meeting_id: int,
    user_id: int,
    *,
    speaking: set[int],
    seqs: range | None = None,
) -> int:
    """폰 하나가 회의 내내 하는 일 전부: 참가 → 청크 업로드 → 종료 보고."""
    joined = client.post(
        f"/api/meetings/{meeting_id}/tracks",
        json={
            "user_id": user_id,
            "started_at": NOW.isoformat(),
            "device_label": "iPhone 14",
            "sample_rate": SR,
        },
    )
    assert joined.status_code == 201, joined.text
    track_id = joined.json()["track_id"]

    for seq in seqs if seqs is not None else range(CHUNKS_PER_TRACK):
        ack = client.put(
            f"/api/meetings/{meeting_id}/tracks/{track_id}/chunks/{seq}",
            content=chunk_bytes(LOUD if seq in speaking else QUIET, seq),
            headers={"X-Client-At-Ms": str(NOW_MS + TIMESLICE * (seq + 1))},
        )
        assert ack.status_code == 200, ack.text

    return track_id


def finish_track(client: TestClient, meeting_id: int, track_id: int) -> dict:
    ended = NOW + timedelta(milliseconds=TIMESLICE * CHUNKS_PER_TRACK)
    response = client.post(
        f"/api/meetings/{meeting_id}/tracks/{track_id}/complete",
        json={
            "ended_at": ended.isoformat(),
            "coverage": 1.0,
            "total_gap_ms": 0,
            "timeslice_ms": TIMESLICE,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def recorded(client: TestClient, project: dict, enqueued: list[int]) -> dict:
    """회의 하나를 처음부터 끝까지 녹음한다. 여기까지가 HTTP 구간."""
    meeting_id = project["meeting_id"]
    track_ids = [
        record_track(client, meeting_id, user_id, speaking=speaking)
        for user_id, speaking in zip(project["user_ids"], SPEAKING_SEQS, strict=True)
    ]
    finals = [finish_track(client, meeting_id, tid) for tid in track_ids]
    return {**project, "track_ids": track_ids, "finals": finals}


def run_processing(
    project: dict, settings: Settings, *, transcriber=None, analyzer=None
) -> dict:
    """워커가 하는 일. **로더는 진짜 선택 경로로 만든다.**"""
    with db_session.session_scope() as s:
        meeting = s.get(m.Meeting, project["meeting_id"])
        capture_mode = meeting.capture_mode

    analyzer = analyzer or FakeAnalyzer()
    loader = runtime.build_audio_loader(settings, capture_mode)
    result = process_meeting(
        project["meeting_id"],
        loader=loader,
        transcriber=transcriber or FakeTranscriber(),
        analyzer=analyzer,
        members=members_of(project),
        meeting_date=NOW.date(),
    )
    payload = _serialize(result)
    persist_results_task(project["meeting_id"], payload)
    return {"result": result, "payload": payload, "loader": loader, "analyzer": analyzer}


@pytest.fixture
def processed(recorded: dict, settings: Settings, fake_ffmpeg: FakeDecoder) -> dict:
    return {**recorded, **run_processing(recorded, settings)}


# ══════════════════════════════════════════════════════════════
# 1. 녹음이 끝나면 실제로 처리가 시작되는가
# ══════════════════════════════════════════════════════════════


def test_last_phone_to_stop_starts_the_processing(recorded: dict, enqueued: list[int]):
    """⭐ 이게 없으면 녹음은 저장만 되고 아무 일도 일어나지 않는다.

    실제로 그런 상태였다 — 태스크 정의도 큐 라우팅도 있는데 부르는 코드가
    없었다. 구간별 테스트는 전부 통과하고 있었다.
    """
    assert [f["meeting_queued"] for f in recorded["finals"]] == [False, False, True]
    assert enqueued == [recorded["meeting_id"]]


def test_meeting_moves_to_queued(recorded: dict, engine):
    """queued 전이 자체가 중복 큐잉을 막는 자물쇠다."""
    with db_session.session_scope() as s:
        assert s.get(m.Meeting, recorded["meeting_id"]).status == "queued"


def test_multitrack_meeting_gets_the_chunk_loader(settings: Settings, fake_ffmpeg):
    """⭐ 잡이 항상 WAV 로더를 쓰던 결함의 회귀 테스트.

    로더가 하나 잘못 골라지면 청크가 멀쩡히 저장돼 있어도 회의가 통째로
    비어 보인다 — 그리고 아무 데서도 오류가 나지 않는다.
    """
    multitrack = runtime.build_audio_loader(settings, "multitrack")
    single = runtime.build_audio_loader(settings, "single")

    assert isinstance(multitrack, runtime.ChunkAudioLoader)
    assert isinstance(single, runtime.FileSystemAudioLoader)


def test_worker_builds_the_chunk_loader_for_multitrack(monkeypatch, fake_ffmpeg):
    """`_build_steps` 까지 확인한다 — 실제로 잡이 부르는 함수다."""
    from teamflow.tasks import meeting_tasks

    monkeypatch.setattr(runtime, "build_transcriber", lambda _s: FakeTranscriber())

    loader, _, _ = meeting_tasks._build_steps("multitrack")
    assert isinstance(loader, runtime.ChunkAudioLoader)


# ══════════════════════════════════════════════════════════════
# 2. 청크가 발화가 되는가
# ══════════════════════════════════════════════════════════════


def test_uploaded_chunks_reach_the_decoder(processed: dict, fake_ffmpeg: FakeDecoder):
    """업로드한 청크가 하나도 빠짐없이 디코더까지 간다."""
    assert fake_ffmpeg.calls == len(processed["track_ids"]) * CHUNKS_PER_TRACK


def test_pipeline_completes(processed: dict):
    assert processed["result"].stage == Stage.DONE
    assert processed["result"].error is None


def test_every_track_lands_on_one_time_axis(processed: dict, settings: Settings):
    """길이가 다르면 GCC-PHAT 정렬이 의미를 잃는다."""
    tracks = processed["loader"].load(processed["meeting_id"])

    assert len(tracks) == 3
    assert len({len(t.samples) for t in tracks}) == 1


def test_utterances_are_stored_with_a_real_speaker(processed: dict, engine):
    """멀티트랙에서는 트랙이 곧 사람이다. 화자가 추정으로 남으면 안 된다."""
    with db_session.session_scope() as s:
        rows = s.scalars(
            select(m.Utterance).where(m.Utterance.meeting_id == processed["meeting_id"])
        ).all()

        assert rows, "발화가 하나도 저장되지 않았습니다"
        assert {r.speaker_source for r in rows} == {"track"}
        assert set(r.speaker_id for r in rows) <= set(processed["user_ids"])
        assert len({r.speaker_id for r in rows}) >= 2, "한 사람만 잡혔습니다"


def test_tracks_align_to_the_same_instant(processed: dict):
    """모든 폰이 같은 시각에 시작했으므로 보정값은 0에 가까워야 한다."""
    assert all(abs(o.offset_sec) < 0.05 for o in processed["result"].alignment)


def test_llm_sees_named_speakers_not_track_numbers(processed: dict):
    """LLM 입력에 '화자2' 가 아니라 '이하늘' 이 들어가야 담당자 해석이 된다."""
    seen = processed["analyzer"].seen

    assert [index for index, _, _ in seen] == list(range(1, len(seen) + 1))
    assert {name for _, name, _ in seen} <= set(processed["names"])
    assert len(seen) == len(processed["result"].segments)


def test_evidence_ids_point_at_rows_that_exist(processed: dict):
    """파이프라인은 1부터의 순번으로 근거를 매기고, 저장 시 실제 행 ID로 바뀐다.

    이 변환이 틀리면 근거 링크가 엉뚱한 발화를 가리킨다 — 분쟁 상황에서
    가장 나쁜 종류의 오류다.
    """
    with db_session.session_scope() as s:
        rows = s.scalars(
            select(m.MeetingTaskCandidate).where(
                m.MeetingTaskCandidate.meeting_id == processed["meeting_id"]
            )
        ).all()
        utterance_ids = set(
            s.scalars(
                select(m.Utterance.id).where(
                    m.Utterance.meeting_id == processed["meeting_id"]
                )
            ).all()
        )

        assert rows
        for row in rows:
            assert row.evidence_utterance_ids
            assert set(row.evidence_utterance_ids) <= utterance_ids


# ══════════════════════════════════════════════════════════════
# 3. 발화가 칸반 업무가 되는가 — 사람을 거쳐서만
# ══════════════════════════════════════════════════════════════


def test_candidate_is_created_not_a_task(processed: dict, client: TestClient):
    """⭐ 승인 전에는 절대 칸반에 올라가지 않는다."""
    candidates = client.get(
        f"/api/meetings/{processed['meeting_id']}/candidates"
    ).json()

    assert len(candidates) == 1
    assert candidates[0]["title"] == "로그인 API 구현"

    with db_session.session_scope() as s:
        tasks = s.scalars(
            select(m.Task).where(m.Task.project_id == processed["project_id"])
        ).all()
        assert tasks == [], "승인 없이 업무가 만들어졌습니다"


def test_hint_resolves_to_a_real_member_and_date(processed: dict, client: TestClient):
    """'민수' → 김민수, '금요일까지' → 회의일(화) 기준 09-04."""
    candidate = client.get(
        f"/api/meetings/{processed['meeting_id']}/candidates"
    ).json()[0]

    assert candidate["assignee_id"] == processed["user_ids"][0]
    assert candidate["deadline"] == "2026-09-04"


def test_approval_puts_it_on_the_kanban(processed: dict, client: TestClient):
    candidate = client.get(
        f"/api/meetings/{processed['meeting_id']}/candidates"
    ).json()[0]

    response = client.post(
        f"/api/meetings/{processed['meeting_id']}/candidates/review",
        json={
            "reviewer_id": processed["user_ids"][1],
            "items": [{"candidate_id": candidate["id"], "approve": True}],
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["approved_count"] == 1

    with db_session.session_scope() as s:
        tasks = s.scalars(
            select(m.Task).where(m.Task.project_id == processed["project_id"])
        ).all()
        assert [t.title for t in tasks] == ["로그인 API 구현"]
        assert tasks[0].assignee_id == processed["user_ids"][0]
        assert tasks[0].origin_candidate_id == candidate["id"]


def test_decisions_are_recorded_with_evidence(processed: dict):
    with db_session.session_scope() as s:
        decisions = s.scalars(
            select(m.Decision).where(m.Decision.meeting_id == processed["meeting_id"])
        ).all()
        utterance_ids = set(
            s.scalars(
                select(m.Utterance.id).where(
                    m.Utterance.meeting_id == processed["meeting_id"]
                )
            ).all()
        )

        assert len(decisions) == 1
        assert set(decisions[0].evidence_utterance_ids) <= utterance_ids


def test_meeting_ends_in_needs_review(processed: dict):
    """confirmed 가 아니다. 사람이 보기 전에는 끝난 게 아니다."""
    with db_session.session_scope() as s:
        assert s.get(m.Meeting, processed["meeting_id"]).status == "needs_review"


# ══════════════════════════════════════════════════════════════
# 4. 폰이 죽은 사람 — 여기가 이 프로젝트의 진짜 시험대다
# ══════════════════════════════════════════════════════════════


@pytest.fixture
def one_phone_died(client: TestClient, project: dict, enqueued: list[int]) -> dict:
    """박지원의 폰이 화면 잠금으로 첫 청크만 올리고 멈췄다."""
    meeting_id = project["meeting_id"]
    track_ids = [
        record_track(client, meeting_id, project["user_ids"][0], speaking={0, 1}),
        record_track(client, meeting_id, project["user_ids"][1], speaking={2}),
        record_track(
            client, meeting_id, project["user_ids"][2], speaking={0}, seqs=range(1)
        ),
    ]
    finals = [finish_track(client, meeting_id, tid) for tid in track_ids]
    return {**project, "track_ids": track_ids, "finals": finals}


def test_server_catches_the_gap_the_client_did_not_report(one_phone_died: dict):
    """클라이언트는 커버리지 1.0 이라고 보고했다. 서버가 안 믿는다."""
    broken = one_phone_died["finals"][2]

    assert broken["coverage"] < 0.5
    assert broken["usable"] is False
    assert "확인이 필요합니다" in broken["message"]


def test_a_dead_phone_still_starts_the_meeting_processing(
    one_phone_died: dict, enqueued: list[int]
):
    """끊긴 트랙이 회의 처리를 막으면 안 된다. 나머지 두 사람이 있다."""
    assert enqueued == [one_phone_died["meeting_id"]]


def test_the_owner_of_a_broken_track_does_not_disappear(
    one_phone_died: dict, settings: Settings, fake_ffmpeg: FakeDecoder
):
    """⭐ 목록에서 빼면 그 사람은 결국 "말을 안 한 사람"이 된다.

    0과 "측정 불가"는 다르고, 그 구분을 여기서 잃으면 복구할 수 없다.
    """
    loader = runtime.build_audio_loader(settings, "multitrack")
    tracks = loader.load(one_phone_died["meeting_id"])

    assert len(tracks) == 3
    by_user = {t.user_id: t for t in tracks}
    broken = by_user[one_phone_died["user_ids"][2]]

    assert broken.usable is False
    assert broken.coverage < 0.5
    assert len(broken.samples) == len(tracks[0].samples), "시간축은 그대로여야 한다"


def test_a_broken_track_does_not_break_the_meeting(
    one_phone_died: dict, settings: Settings, fake_ffmpeg: FakeDecoder
):
    """한 명이 끊겨도 나머지 회의는 처리된다."""
    processed = run_processing(one_phone_died, settings)
    assert processed["result"].stage == Stage.DONE

    with db_session.session_scope() as s:
        rows = s.scalars(
            select(m.Utterance).where(
                m.Utterance.meeting_id == one_phone_died["meeting_id"]
            )
        ).all()
        assert rows


# ══════════════════════════════════════════════════════════════
# 5. 동의 — 법적 방어선이 사슬 전체에서 유지되는가
# ══════════════════════════════════════════════════════════════


def test_revoking_consent_mid_meeting_stops_new_chunks(
    client: TestClient, project: dict
):
    """철회는 소급하지 않는다. 이후만 막고 이미 받은 것은 남는다."""
    meeting_id = project["meeting_id"]
    track_id = record_track(client, meeting_id, project["user_ids"][0], speaking={0})

    with db_session.session_scope() as s:
        consent = s.scalars(
            select(m.RecordingConsent).where(
                m.RecordingConsent.meeting_id == meeting_id,
                m.RecordingConsent.user_id == project["user_ids"][1],
            )
        ).one()
        consent.consented = False

    blocked = client.put(
        f"/api/meetings/{meeting_id}/tracks/{track_id}/chunks/{CHUNKS_PER_TRACK}",
        content=chunk_bytes(QUIET, 0),
        headers={"X-Client-At-Ms": str(NOW_MS + TIMESLICE * 9)},
    )

    assert blocked.status_code == 403
    with db_session.session_scope() as s:
        kept = s.scalars(
            select(m.TrackChunk).where(m.TrackChunk.track_id == track_id)
        ).all()
        assert len(kept) == CHUNKS_PER_TRACK, "이미 받은 청크까지 지우면 안 된다"


# ══════════════════════════════════════════════════════════════
# 6. 큐잉과 커밋의 순서 — 스텁으로는 절대 안 잡히는 것
#
# `enqueue_meeting_processing` 을 가짜로 바꾸면 "불렸는가" 만 알 수 있고
# "언제 불렸는가" 는 모른다. 그런데 이 프로젝트에서는 그 순서가 전부다.
#
# 커밋은 엔드포인트 본문이 아니라 FastAPI 의존성 teardown 에서 일어난다
# (`db/session.py` 의 session_scope 가 yield 뒤에 commit).  그래서 본문에서
# 바로 큐에 넣으면 항상 커밋보다 먼저이고, 워커가 그 사이에 도착하면
# 방금 종료를 보고한 그 트랙이 아직 ended_at IS NULL 로 보인다.
# `ChunkAudioLoader.load` 는 그런 트랙을 조용히 버린다 — 예외도 로그도 없다.
#
# 그래서 **다른 커넥션이 무엇을 보는가** 를 재야 한다. 파일 DB 를 쓰는 이유다
# (인메모리 + StaticPool 은 커넥션이 하나라 이 성질을 측정할 수 없다).
# ══════════════════════════════════════════════════════════════


@pytest.fixture
def observed_at_enqueue(monkeypatch, engine) -> list[dict]:
    """큐잉이 일어나는 **그 순간** 다른 커넥션이 보는 DB 상태를 기록한다."""
    seen: list[dict] = []
    from teamflow.tasks import dispatch

    def spy(meeting_id: int) -> None:
        with engine.connect() as conn:  # 별도 커넥션 — 커밋된 것만 보인다
            status = conn.exec_driver_sql(
                "SELECT status FROM meetings WHERE id = ?", (meeting_id,)
            ).scalar()
            unfinished = conn.exec_driver_sql(
                "SELECT COUNT(*) FROM meeting_tracks "
                "WHERE meeting_id = ? AND ended_at IS NULL",
                (meeting_id,),
            ).scalar()
        seen.append({"status": status, "unfinished_tracks": unfinished})

    monkeypatch.setattr(dispatch, "enqueue_meeting_processing", spy)
    return seen


def test_enqueue_happens_after_the_commit(
    client: TestClient, project: dict, observed_at_enqueue: list[dict]
):
    """⭐ 큐잉 시점에 마지막 트랙의 종료가 이미 커밋돼 있어야 한다.

    아니면 워커가 그 트랙을 못 보고 버린다. 회의는 N-1 명으로 멀쩡히
    처리되고, 빠진 사람은 발화 0건 — "말을 안 한 사람" 이 된다.
    """
    meeting_id = project['meeting_id']
    track_ids = [
        record_track(client, meeting_id, user_id, speaking=speaking)
        for user_id, speaking in zip(project['user_ids'], SPEAKING_SEQS, strict=True)
    ]
    for tid in track_ids:
        finish_track(client, meeting_id, tid)

    assert len(observed_at_enqueue) == 1, '큐잉이 정확히 한 번 일어나야 합니다'
    observed = observed_at_enqueue[0]

    assert observed['unfinished_tracks'] == 0, (
        '큐잉 시점에 아직 종료가 커밋되지 않은 트랙이 있습니다 — '
        '워커가 먼저 도착하면 그 사람이 통째로 사라집니다'
    )
    assert observed['status'] == 'queued', (
        f"큐잉 시점의 회의 상태가 커밋돼 있지 않습니다: {observed['status']}"
    )


def test_finish_endpoint_also_enqueues_after_commit(
    client: TestClient, project: dict, observed_at_enqueue: list[dict]
):
    """강제 종료 경로도 같은 순서를 지켜야 한다."""
    meeting_id = project['meeting_id']
    record_track(client, meeting_id, project['user_ids'][0], speaking={0})

    response = client.post(f'/api/meetings/{meeting_id}/finish')
    assert response.status_code == 200, response.text

    assert len(observed_at_enqueue) == 1
    assert observed_at_enqueue[0]['unfinished_tracks'] == 0, (
        '강제 종료한 트랙의 ended_at 이 커밋 전에 큐잉됐습니다'
    )
