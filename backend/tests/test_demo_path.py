"""시연 경로 — 오늘 이걸 열어볼 수 있는가.

지금까지 전 구간이 도는 곳은 pytest 안뿐이었습니다. `review.html` 을 실제로
열면 404 만 떴습니다 — 프로젝트·회의·후보를 만드는 POST API 가 하나도 없고,
후보를 쓰는 코드는 Celery + GPU 파이프라인 안뿐이기 때문입니다.

이 파일이 고정하는 것 셋:

    1. 화면과 API 가 **같은 오리진**에서 열린다 (CORS 없이)
    2. `seed_demo.py` 가 승인 화면이 쓸 수 있는 데이터를 만든다
    3. `ASR_BACKEND=fake` 로 GPU 없이 회의 처리가 돈다

특히 1번은 폰에서 녹음하려면 필수입니다. `getUserMedia()` 가 보안 컨텍스트를
요구하므로 페이지와 API 를 둘 다 HTTPS 로 잡아야 하는데, 화면을 별도 서버에
두면 터널이 둘이 되고 CORS 설정이 필요합니다.
"""

from __future__ import annotations

import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select

from teamflow.config import Settings, get_settings
from teamflow.db import models as m
from teamflow.db import session as db_session

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import seed_demo  # noqa: E402

from .conftest import login_as  # noqa: E402


@pytest.fixture
def engine(tmp_path: Path):
    eng = create_engine(f"sqlite:///{tmp_path / 'demo.db'}")
    m.Base.metadata.create_all(eng)
    db_session.configure(eng)
    yield eng
    eng.dispose()


@pytest.fixture
def seeded(engine, client: TestClient) -> dict:
    """시연 데이터 + 첫 팀원으로 로그인.

    회의 관련 조회는 전부 구성원 확인을 지난다. 로그인하지 않으면 401 이고,
    그게 맞다 — 남의 팀 회의록이 열려 있으면 안 된다.
    """
    result = seed_demo.seed(reset=True)
    login_as(client, result["user_ids"][0])
    return result


@pytest.fixture
def client(engine, tmp_path: Path) -> Iterator[TestClient]:
    from teamflow.api.main import app

    app.dependency_overrides[get_settings] = lambda: Settings(
        environment="test",
        github_webhook_secret="demo",
        database_url="sqlite://",
        audio_storage_root=tmp_path / "audio",
        asr_backend="fake",
    )
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


# ══════════════════════════════════════════════════════════════
# 1. 한 오리진 — 화면과 API 가 같은 서버에서 나온다
# ══════════════════════════════════════════════════════════════


def test_screens_are_served_by_the_api(client: TestClient):
    """⭐ 화면을 별도 서버에 두면 터널이 둘, CORS 설정이 필요해진다."""
    for path in ("/review.html", "/index.html"):
        response = client.get(path)
        assert response.status_code == 200, f"{path} 가 안 열립니다"
        assert "text/html" in response.headers["content-type"]


def test_root_serves_the_recording_screen(client: TestClient):
    assert client.get("/").status_code == 200


def test_static_mount_does_not_shadow_the_api(client: TestClient, seeded: dict):
    """⭐ `/` 마운트는 앞의 모든 경로를 삼킨다.

    라우트 정의보다 먼저 마운트하면 API 가 통째로 404 가 되는데, 그건
    화면을 열어보기 전까지 아무도 모른다.
    """
    assert client.get("/health").status_code == 200
    assert client.get("/api/time").status_code == 200
    assert (
        client.get(f"/api/meetings/{seeded['meeting_id']}/candidates").status_code == 200
    )


def test_no_cors_middleware_is_needed(client: TestClient):
    """한 오리진이면 CORS 가 필요 없다. 붙어 있으면 배치가 잘못됐다는 신호다."""
    from teamflow.api.main import app

    names = [type(mw.cls).__name__ if hasattr(mw, "cls") else str(mw) for mw in app.user_middleware]
    assert not any("CORS" in n for n in names), (
        f"CORS 미들웨어가 붙어 있습니다: {names}. 화면과 API 가 다른 오리진에 "
        "있다는 뜻이고, 폰에서 녹음하려면 터널이 둘 필요해집니다"
    )


def test_unknown_path_is_404_not_a_screen(client: TestClient, seeded: dict):
    assert client.get("/api/meetings/99999/candidates").status_code == 404


# ══════════════════════════════════════════════════════════════
# 2. 시드 — 승인 화면이 쓸 수 있는 데이터인가
# ══════════════════════════════════════════════════════════════


def test_seed_creates_a_reviewable_meeting(client: TestClient, seeded: dict):
    candidates = client.get(f"/api/meetings/{seeded['meeting_id']}/candidates").json()
    assert len(candidates) == seeded["pending"]
    assert seeded["pending"] >= 2


def test_candidates_are_not_all_the_same_shape(client: TestClient, seeded: dict):
    """⭐ 전부 완전한 후보만 넣으면 화면이 "전부 승인" 버튼 하나로 보인다.

    이 화면의 값어치는 **사람이 고쳐야 하는 것을 골라내는 데** 있고,
    그게 보이려면 고칠 거리가 있어야 한다.
    """
    candidates = client.get(f"/api/meetings/{seeded['meeting_id']}/candidates").json()

    complete = [c for c in candidates if c["assignee_id"] and c["deadline"]]
    needs_assignee = [c for c in candidates if not c["assignee_id"]]
    low_confidence = [c for c in candidates if c["confidence"] < 0.5]

    assert complete, "바로 승인 가능한 후보가 하나는 있어야 합니다"
    assert needs_assignee, "담당자를 골라야 하는 후보가 있어야 합니다"
    assert low_confidence, "확신도가 낮아 눈에 띄어야 하는 후보가 있어야 합니다"


def test_low_confidence_comes_first(client: TestClient, seeded: dict):
    """확신도 낮은 것부터 봐야 한다 — 사람의 주의를 거기 써야 하므로."""
    candidates = client.get(f"/api/meetings/{seeded['meeting_id']}/candidates").json()
    confidences = [c["confidence"] for c in candidates]
    assert confidences == sorted(confidences)


def test_every_candidate_has_live_evidence(client: TestClient, seeded: dict, engine):
    """근거가 없으면 승인 자체가 막힌다 (ApprovalError.NO_EVIDENCE)."""
    candidates = client.get(f"/api/meetings/{seeded['meeting_id']}/candidates").json()
    with db_session.session_scope() as s:
        live = set(
            s.scalars(
                select(m.Utterance.id).where(
                    m.Utterance.meeting_id == seeded["meeting_id"]
                )
            ).all()
        )
    for candidate in candidates:
        assert candidate["evidence_utterance_ids"]
        assert set(candidate["evidence_utterance_ids"]) <= live


def test_seed_includes_a_broken_track(client: TestClient, seeded: dict):
    """⭐ 폰이 죽은 사람이 화면에서 어떻게 보이는지 확인할 수 있어야 한다.

    이 프로젝트가 "측정 불가는 0점이 아니다" 라고 주장하는 지점이라,
    시연 데이터에 그 경우가 없으면 주장할 거리가 없다.
    """
    tracks = client.get(f"/api/meetings/{seeded['meeting_id']}/tracks").json()["tracks"]
    unusable = [t for t in tracks if t["coverage"] is not None and t["coverage"] < 0.8]
    assert unusable, "커버리지가 낮은 트랙이 하나는 있어야 합니다"


def test_seed_is_idempotent_with_reset(engine):
    first = seed_demo.seed(reset=True)
    second = seed_demo.seed(reset=True)
    assert second["candidates"] == first["candidates"]

    with db_session.session_scope() as s:
        projects = s.scalars(
            select(m.Project).where(m.Project.title == seed_demo.PROJECT_TITLE)
        ).all()
        assert len(projects) == 1, "--reset 이 이전 프로젝트를 안 지웠습니다"


def test_seed_refuses_to_duplicate_without_reset(engine):
    seed_demo.seed(reset=True)
    with pytest.raises(SystemExit, match="이미 있습니다"):
        seed_demo.seed(reset=False)


def test_reset_still_works_after_someone_actually_uses_the_demo(
    client: TestClient, seeded: dict
):
    """⭐ 시연을 **한 번 해 본 뒤에도** `--reset` 이 돌아야 한다.

    `_delete_project` 는 지울 표를 손으로 나열하고 있었다. 그래서 처음
    한 번은 잘 되고, 시연자가 실제로 해 보고 나면 안 됐다 — 승인 화면에서
    승인하면 `audit_logs` 가 생기고, 칸반에서 되돌려도 생기기 때문이다.
    프로덕션은 PostgreSQL 이라 외래키가 항상 강제되므로,
    **데이터를 손으로 지우기 전까지 다시 시연할 수 없는** 상태였다.
    """
    project_id = seeded["project_id"]

    # 시연자가 실제로 하는 일: 완료를 되돌린다 → 감사 로그가 생긴다.
    tasks = client.get(f"/api/projects/{project_id}/tasks").json()["tasks"]
    done = next(t for t in tasks if t["status"] == "done")
    assert (
        client.patch(
            f"/api/projects/{project_id}/tasks/{done['id']}", json={"status": "todo"}
        ).status_code
        == 200
    )

    with db_session.session_scope() as s:
        assert s.scalars(
            select(m.AuditLog).where(m.AuditLog.project_id == project_id)
        ).all(), "이 테스트의 전제(감사 로그가 생긴다)가 깨졌습니다"

    # 예전에는 여기서 `FOREIGN KEY constraint failed` 가 났다.
    seed_demo.seed(reset=True)

    with db_session.session_scope() as s:
        projects = s.scalars(
            select(m.Project).where(m.Project.title == seed_demo.PROJECT_TITLE)
        ).all()
        assert len(projects) == 1
        assert not s.scalars(
            select(m.AuditLog).where(m.AuditLog.project_id == project_id)
        ).all()


def test_the_demo_board_matches_what_the_review_screen_says(
    client: TestClient, seeded: dict
):
    """⭐ 승인 화면과 칸반이 같은 말을 해야 한다.

    후보가 전부 `pending` 인데 그 후보를 가리키는 업무가 이미 칸반에
    있었다. `approval.py` 의 불변식 1번("승인자 없이는 업무가 만들어지지
    않는다")을 시연 시작 상태가 어기고 있었고, README 가 시키는 대로
    승인하면 **같은 업무 카드가 하나 더** 생겼다.
    """
    meeting_id = seeded["meeting_id"]
    pending = {
        c["title"]
        for c in client.get(f"/api/meetings/{meeting_id}/candidates").json()
    }
    tasks = client.get(f"/api/projects/{seeded['project_id']}/tasks").json()["tasks"]

    from_meeting = {t["title"] for t in tasks if t["origin"] is not None}
    assert from_meeting, "회의에서 나온 업무가 하나는 있어야 화면의 주장이 보인다"

    overlap = pending & from_meeting
    assert not overlap, (
        f"승인 대기 중인데 칸반에 이미 있는 업무: {sorted(overlap)}. "
        "승인하면 카드가 하나 더 생깁니다."
    )


def test_every_task_from_a_meeting_shows_its_own_evidence(
    client: TestClient, seeded: dict
):
    """⭐ 업무 → 후보 → 근거 발화가 **같은 것을 가리켜야** 한다.

    후보를 목록 순서로 이었더니 'DB 스키마 정리' 가 '배포 방식 결정'
    후보를 가리켰고, 근거 발화로 "배포는 아직 정하지 말고 다음 회의에서
    다시 얘기해요" 를 보여주고 있었다. 사슬이 이어져 있는지만 보면
    내용이 어긋난 것을 통과시킨다.
    """
    tasks = client.get(f"/api/projects/{seeded['project_id']}/tasks").json()["tasks"]
    with db_session.session_scope() as s:
        for task in tasks:
            if task["origin"] is None:
                continue
            candidate = s.get(
                m.MeetingTaskCandidate, task["origin"]["candidate_id"]
            )
            assert candidate is not None
            assert candidate.title == task["title"], (
                f"업무 {task['title']!r} 가 후보 {candidate.title!r} 를 가리킵니다"
            )


def test_approving_the_complete_candidate_adds_exactly_one_card(
    client: TestClient, seeded: dict
):
    """⭐ 시연의 핵심 동작이 실제로 되는가.

    README 가 시연자에게 시키는 것이 이것이다 — 승인 화면에서 완전한
    후보를 승인하면 칸반에 카드가 생긴다. 예전 시드는 그 후보를 가리키는
    업무를 미리 넣어 두면서 후보는 `pending` 으로 뒀다. 그래서 승인하면
    **같은 제목의 카드가 둘** 생겼다.
    """
    meeting_id, project_id = seeded["meeting_id"], seeded["project_id"]

    candidates = client.get(f"/api/meetings/{meeting_id}/candidates").json()
    complete = next(c for c in candidates if c["assignee_id"] and c["deadline"])

    before = client.get(f"/api/projects/{project_id}/tasks").json()["tasks"]
    assert complete["title"] not in {t["title"] for t in before}

    response = client.post(
        f"/api/meetings/{meeting_id}/candidates/review",
        json={"items": [{"candidate_id": complete["id"], "approve": True}]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["approved_count"] == 1, response.text

    after = client.get(f"/api/projects/{project_id}/tasks").json()["tasks"]
    titles = [t["title"] for t in after]
    assert titles.count(complete["title"]) == 1, titles
    assert len(after) == len(before) + 1

    # 새 카드가 그 후보에서 왔다고 화면이 말할 수 있어야 한다.
    created = next(t for t in after if t["title"] == complete["title"])
    assert created["origin"] is not None
    assert created["origin"]["candidate_id"] == complete["id"]


def test_seeded_events_do_not_squat_on_real_task_ids(client: TestClient, seeded: dict):
    """⭐ 합성 기여 이벤트가 실제 업무 id 를 선점하면 안 된다.

    `_emit` 은 `(source_kind, source_id, event_type)` 로 선점 여부를 보고
    이미 있으면 **아무것도 안 하고 False 를 돌려준다** — 로그도 예외도
    없다. 시드가 `index * 1000 + seq` 로 만든 첫 값이 `4` 라
    `tasks.id = 4` 와 충돌했고, 그래서 시연에서 그 카드를 완료해도 기여
    이벤트가 조용히 안 생겼다. 게다가 선점한 이벤트의 주인은 그 업무의
    담당자가 아니었다.
    """
    with db_session.session_scope() as s:
        task_ids = set(s.scalars(select(m.Task.id)).all())
        squatted = sorted(
            row.source_id
            for row in s.scalars(
                select(m.ContributionEventRow).where(
                    m.ContributionEventRow.source_kind == "task"
                )
            ).all()
            if row.source_id in task_ids
        )
    assert squatted == [], f"합성 이벤트가 선점한 업무: {squatted}"


# ══════════════════════════════════════════════════════════════
# 3. 가짜 ASR — GPU 없이 회의 처리가 도는가
# ══════════════════════════════════════════════════════════════


def test_fake_asr_is_opt_in():
    """기본값은 여전히 막혀 있어야 한다. 실수로 켜지면 안 된다."""
    from teamflow.pipeline.runtime import build_transcriber

    with pytest.raises(NotImplementedError, match="ASR 구현이 아직 없습니다"):
        build_transcriber(Settings(github_webhook_secret="x"))


def test_fake_asr_returns_a_script():
    import numpy as np

    from teamflow.pipeline.runtime import ScriptedTranscriber, build_transcriber

    transcriber = build_transcriber(
        Settings(github_webhook_secret="x", asr_backend="fake")
    )
    assert isinstance(transcriber, ScriptedTranscriber)

    lines = transcriber.transcribe(np.zeros(16_000, dtype=np.float32), 16_000)
    assert lines
    for start_ms, end_ms, text, confidence in lines:
        assert start_ms < end_ms
        assert text.strip()
        assert 0.0 <= confidence <= 1.0


def test_fake_asr_splits_lines_across_tracks():
    """⭐ 트랙 하나가 대본 전체를 말하면 화자별 회의록이라는 게 안 보인다."""
    import numpy as np

    from teamflow.pipeline.runtime import ScriptedTranscriber

    transcriber = ScriptedTranscriber()
    silence = np.zeros(16_000, dtype=np.float32)
    per_track = [
        {line[2] for line in transcriber.transcribe(silence, 16_000)} for _ in range(3)
    ]

    assert all(per_track), "빈 트랙이 있습니다"
    assert per_track[0] != per_track[1], "트랙마다 다른 발화가 나와야 합니다"
    assert set().union(*per_track) == {line[2] for line in ScriptedTranscriber.script}


def test_health_exposes_the_fake_backend(client: TestClient):
    """⭐ 가짜 ASR 이 켜져 있으면 밖에서 보여야 한다.

    시연용 스위치가 운영에 남아 있는데 아무도 모르는 게 최악이다.
    """
    body = client.get("/health").json()
    assert body["asr_backend"] == "fake"


# ══════════════════════════════════════════════════════════════
# 4. 로비 화면 — 동의 API 를 만들어 놓고 누를 곳이 없으면 절반만 끝난 것
# ══════════════════════════════════════════════════════════════


def test_lobby_page_is_served(client: TestClient):
    for path in ("/lobby.html", "/lobby.js"):
        assert client.get(path).status_code == 200, f"{path} 가 안 열립니다"


def test_lobby_endpoints_exist(client: TestClient, seeded: dict):
    """⭐ 화면이 부르는 두 엔드포인트가 실제로 있는가.

    화면과 API 는 따로 자라기 쉽다. 화면은 타입 검사만 통과하면 되고
    자동 테스트가 없으므로, 이 대조가 유일한 그물이다.
    """
    meeting_id = seeded["meeting_id"]

    consent = client.get(f"/api/meetings/{meeting_id}/consent")
    assert consent.status_code == 200
    body = consent.json()
    assert "roster" in body and "message" in body

    tracks = client.get(f"/api/meetings/{meeting_id}/tracks")
    assert tracks.status_code == 200
    assert "tracks" in tracks.json()


def test_roster_entries_have_the_fields_the_lobby_reads(client: TestClient, seeded: dict):
    """`room.ts` 의 `RosterEntry` 와 서버 응답이 어긋나면 화면이 빈다."""
    roster = client.get(f"/api/meetings/{seeded['meeting_id']}/consent").json()["roster"]
    assert roster
    for entry in roster:
        assert {"user_id", "name", "recording"} <= set(entry)


def test_track_entries_have_the_fields_the_lobby_reads(client: TestClient, seeded: dict):
    """`room.ts` 의 `TrackHealth` 와 대조."""
    tracks = client.get(f"/api/meetings/{seeded['meeting_id']}/tracks").json()["tracks"]
    assert tracks
    for track in tracks:
        assert {"track_id", "user_id", "status", "coverage", "total_gap_ms"} <= set(track)


def test_seeded_meeting_shows_a_broken_track_in_the_lobby(client: TestClient, seeded: dict):
    """⭐ 로비의 존재 이유는 폰이 죽은 걸 **회의 중에** 보여주는 것이다.

    시연 데이터에 그 경우가 없으면 화면을 열어도 보여줄 게 없다.
    """
    tracks = client.get(f"/api/meetings/{seeded['meeting_id']}/tracks").json()["tracks"]
    broken = [t for t in tracks if t["coverage"] is not None and t["coverage"] < 0.8]
    assert broken, "커버리지가 낮은 트랙이 있어야 로비가 경고를 띄웁니다"


# ══════════════════════════════════════════════════════════════
# 4. 파이프라인이 만든 것이 화면까지 도착하는가
# ══════════════════════════════════════════════════════════════
#
# 저장까지는 test_pipeline_output_persisted.py 가 잰다. 여기서는 그 값이
# **HTTP 응답으로 나오는지**를 잰다. 저장은 되는데 어떤 엔드포인트도
# 돌려주지 않으면 사람 입장에서는 여전히 없는 것과 같다.


def test_meeting_endpoint_returns_the_summary(client: TestClient, seeded: dict):
    """⭐ 요약은 이 시스템의 대표 산출물인데 볼 방법이 없었다."""
    response = client.get(f"/api/meetings/{seeded['meeting_id']}")
    assert response.status_code == 200

    body = response.json()
    assert body["summary"]
    assert "JWT" in body["summary"]
    assert body["status"] == "needs_review"


def test_unknown_meeting_is_404_not_an_empty_summary(client: TestClient, seeded: dict):
    """없는 것을 빈 것으로 답하지 않는다."""
    assert client.get("/api/meetings/999999").status_code == 404


def test_candidates_carry_their_warnings_and_hint(client: TestClient, seeded: dict):
    """⭐ 확신도 숫자만으로는 사람이 무엇을 확인해야 할지 모른다.

    `candidates.ts` 의 `Candidate` 와 서버 응답이 어긋나면 경고가
    조용히 사라진다 — 화면은 아무 설명 없이 빨간 표시만 띄운다.
    """
    rows = client.get(f"/api/meetings/{seeded['meeting_id']}/candidates").json()
    assert rows

    with_warnings = [r for r in rows if r["warnings"]]
    assert with_warnings, "경고가 붙은 후보가 하나는 있어야 화면을 확인할 수 있습니다"

    unresolved = [r for r in rows if r["assignee_id"] is None and r["assignee_hint"]]
    assert unresolved, "담당자가 안 풀린 후보의 원문 이름이 내려와야 합니다"
    for row in rows:
        assert {"assignee_hint", "warnings"} <= set(row)


def test_seeded_tracks_carry_their_alignment_offsets(seeded: dict):
    """정렬 보정값이 0 만 있으면 시연에서 이 컬럼이 산 것인지 알 수 없다."""
    from teamflow.db import session as db_session

    with db_session.session_scope() as s:
        offsets = [
            t.offset_ms
            for t in s.scalars(
                select(m.MeetingTrack).where(
                    m.MeetingTrack.meeting_id == seeded["meeting_id"]
                )
            ).all()
        ]
    assert any(o != 0 for o in offsets)


# ══════════════════════════════════════════════════════════════
# 5. 시연 계정으로 실제로 로그인이 되는가
# ══════════════════════════════════════════════════════════════


def test_seeded_accounts_can_actually_log_in(client: TestClient, seeded: dict):
    """⭐ `seed_demo.py` 가 화면에 찍는 비밀번호가 진짜여야 한다.

    안내문과 실제 값이 어긋나면 시연 자리에서 로그인이 안 된다. 그때는
    코드를 읽을 시간이 없다 — 이 저장소에서 반복해서 나온 "문서가 안내하는
    명령이 실제로는 동작하지 않는" 부류다.
    """
    for email in seeded["emails"]:
        response = client.post(
            "/api/auth/login", json={"email": email, "password": seed_demo.DEMO_PASSWORD}
        )
        assert response.status_code == 200, f"{email}: {response.text}"


def test_login_screen_is_served_from_the_same_origin(client: TestClient):
    """로그인 화면도 API 와 같은 서버에서 나와야 쿠키가 붙는다."""
    response = client.get("/login.html")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]


def test_the_demo_walkthrough_works_end_to_end(client: TestClient, seeded: dict):
    """⭐ 로그인 → 로비 → 승인 화면 데이터까지 한 번에.

    구간별로 200 을 확인하는 테스트는 있었지만, **로그인부터 이어서** 도는지는
    아무도 묻지 않았다. 인증을 추가하면서 어느 한 화면만 막혀도 시연 경로가
    끊긴다.
    """
    client.cookies.clear()
    meeting_id = seeded["meeting_id"]

    # 로그인 전에는 아무것도 안 보인다
    assert client.get(f"/api/meetings/{meeting_id}/consent").status_code == 401

    login = client.post(
        "/api/auth/login",
        json={"email": seeded["emails"][0], "password": seed_demo.DEMO_PASSWORD},
    )
    assert login.status_code == 200

    assert client.get("/api/auth/me").json()["email"] == seeded["emails"][0]
    assert client.get(f"/api/meetings/{meeting_id}/consent").status_code == 200
    assert client.get(f"/api/meetings/{meeting_id}/tracks").status_code == 200
    assert client.get(f"/api/meetings/{meeting_id}").json()["summary"]
    assert client.get(f"/api/meetings/{meeting_id}/candidates").json()
    assert client.get(f"/api/meetings/{meeting_id}/members").json()


# ══════════════════════════════════════════════════════════════
# 6. 기여도 화면
# ══════════════════════════════════════════════════════════════


def test_contributions_page_is_served(client: TestClient):
    for path in ("/contributions.html", "/contributions.js"):
        assert client.get(path).status_code == 200, f"{path} 가 안 열립니다"


def test_contributions_response_has_the_fields_the_screen_reads(
    client: TestClient, seeded: dict
):
    """⭐ `view.ts` 의 타입과 서버 응답이 어긋나면 화면이 조용히 빕니다.

    화면 코드에는 자동 테스트가 없으므로 이 대조가 유일한 그물입니다.
    """
    body = client.get(f"/api/projects/{seeded['project_id']}/contributions").json()

    assert {"algo_version", "computed_at", "members", "skipped_categories", "notice"} <= set(
        body
    )
    for member in body["members"]:
        assert {
            "user_id",
            "role",
            "share",
            "range_low",
            "range_high",
            "confidence",
            "confidence_label",
            "confidence_reasons",
            "categories",
            "integrity_flags",
            "measurement_gaps",
        } <= set(member)


def test_contributions_never_ships_a_ranking(client: TestClient, seeded: dict):
    """⭐ 순위는 서버에서도 만들지 않는다 (docs/07 E2).

    화면이 정렬을 안 해도 응답에 rank 가 있으면 누군가는 그걸 씁니다.
    """
    import json as _json

    body = client.get(f"/api/projects/{seeded['project_id']}/contributions").json()
    flat = _json.dumps(body, ensure_ascii=False)

    assert "rank" not in flat
    assert "순위" not in flat


def test_contributions_carry_a_range_not_just_a_number(client: TestClient, seeded: dict):
    """단일 점수만 내려보내면 화면이 구간을 그릴 수 없습니다."""
    body = client.get(f"/api/projects/{seeded['project_id']}/contributions").json()
    for member in body["members"]:
        assert member["range_low"] <= member["share"] <= member["range_high"]


def test_seeded_contributions_show_the_case_this_screen_exists_for(
    client: TestClient, seeded: dict
):
    """⭐ 시연 데이터에 **측정 불가**가 하나 있어야 한다.

    "측정 불가는 0점이 아니다" 가 이 프로젝트의 주장인데, 시연 데이터에 그
    경우가 없으면 화면을 열어도 주장할 거리가 없다 — 승인 화면에 확신도
    0.34 짜리를 넣어 둔 것과 같은 이유다.
    """
    body = client.get(f"/api/projects/{seeded['project_id']}/contributions").json()

    with_gap = [mem for mem in body["members"] if mem["measurement_gaps"]]
    assert with_gap, "측정 불가인 팀원이 하나는 있어야 화면이 그 경우를 보여줍니다"

    # 그리고 그 사람이 0% 가 아니어야 한다. 0 으로 처리하는 게 바로 그 결함이다.
    for mem in with_gap:
        assert mem["share"] > 0, "측정 불가를 0점으로 계산하고 있습니다"


def test_seeded_members_have_different_shapes(client: TestClient, seeded: dict):
    """전원이 똑같으면 이 화면이 무엇을 보여주는지 알 수 없다."""
    body = client.get(f"/api/projects/{seeded['project_id']}/contributions").json()
    shares = [mem["share"] for mem in body["members"]]

    assert len(body["members"]) == 3
    assert len(set(round(s, 1) for s in shares)) == 3, f"전부 같은 값입니다: {shares}"
    assert all(mem["categories"] for mem in body["members"])


# ══════════════════════════════════════════════════════════════
# 7. 칸반 화면
# ══════════════════════════════════════════════════════════════


def test_kanban_page_is_served(client: TestClient):
    for path in ("/kanban.html", "/kanban.js"):
        assert client.get(path).status_code == 200, f"{path} 가 안 열립니다"


def test_kanban_response_has_the_fields_the_screen_reads(client: TestClient, seeded: dict):
    """`board.ts` 의 `Task` 와 서버 응답이 어긋나면 카드가 조용히 빕니다."""
    body = client.get(f"/api/projects/{seeded['project_id']}/tasks").json()

    assert body["statuses"] == ["todo", "in_progress", "done"]
    assert body["tasks"]
    for task in body["tasks"]:
        assert {
            "id",
            "title",
            "assignee_id",
            "status",
            "deadline",
            "completed_at",
            "origin",
        } <= set(task)


def test_seeded_board_shows_the_chain_and_the_exceptions(client: TestClient, seeded: dict):
    """⭐ 시연 보드에 네 가지가 다 있어야 화면이 무엇을 말하는지 보입니다.

    회의에서 나온 업무 · 손으로 만든 업무 · 담당자 없는 업무 · 완료된 업무.
    전부 같은 모양이면 이 화면은 그냥 할 일 목록으로 보입니다.
    """
    tasks = client.get(f"/api/projects/{seeded['project_id']}/tasks").json()["tasks"]

    assert [t for t in tasks if t["origin"]], "회의에서 나온 업무가 있어야 합니다"
    assert [t for t in tasks if not t["origin"]], "손으로 만든 업무도 있어야 합니다"
    assert [t for t in tasks if t["assignee_id"] is None], "담당자 없는 업무가 있어야 합니다"
    assert len({t["status"] for t in tasks}) >= 2, "상태가 하나뿐이면 열이 비어 보입니다"


def test_seeded_origin_reaches_back_to_an_utterance(client: TestClient, seeded: dict):
    """업무 → 후보 → 회의 → 근거 발화. 이 사슬이 이 프로젝트의 주장입니다."""
    tasks = client.get(f"/api/projects/{seeded['project_id']}/tasks").json()["tasks"]
    from_meeting = [t for t in tasks if t["origin"]]

    assert from_meeting
    for task in from_meeting:
        assert task["origin"]["meeting_id"] == seeded["meeting_id"]
        assert task["origin"]["evidence_utterance_ids"]


# ══════════════════════════════════════════════════════════════
# 8. 첫 화면 — 로그인하면 갈 곳이 있는가
# ══════════════════════════════════════════════════════════════


def test_home_page_is_served(client: TestClient):
    for path in ("/home.html", "/home.js"):
        assert client.get(path).status_code == 200, f"{path} 가 안 열립니다"


def test_my_projects_are_listed(client: TestClient, seeded: dict):
    """⭐ `POST /api/projects` 는 있었는데 목록이 없었습니다.

    그래서 화면을 열려면 `?project=1&meeting=1` 을 주소에 직접 적어야 했고,
    그 숫자를 알 방법은 `seed_demo.py` 의 출력뿐이었습니다. 만들 수는 있는데
    다시 찾을 수 없는 상태였습니다.
    """
    body = client.get("/api/projects").json()

    assert len(body) == 1
    assert body[0]["project_id"] == seeded["project_id"]
    assert {"project_id", "title", "member_count", "meeting_count", "needs_review"} <= set(
        body[0]
    )
    assert body[0]["member_count"] == 3
    assert body[0]["meeting_count"] == 1


def test_the_project_list_is_the_permission_boundary(client: TestClient, seeded: dict):
    """⭐ 남의 프로젝트는 목록에 아예 나오지 않는다.

    목록이 권한 경계입니다 — 나온 뒤에 열려다 403 을 받는 게 아니라,
    존재 자체가 보이지 않아야 합니다.
    """
    from teamflow.db import session as db_session

    with db_session.session_scope() as s:
        outsider = m.User(name="외부인", email="outsider-home@example.com")
        s.add(outsider)
        s.flush()
        outsider_id = outsider.id

    login_as(client, outsider_id)
    assert client.get("/api/projects").json() == []


def test_meetings_are_listed_newest_first(client: TestClient, seeded: dict):
    """오래된 것부터 두면 회의가 쌓일수록 지금 볼 것이 아래로 밀립니다."""
    body = client.get(f"/api/projects/{seeded['project_id']}/meetings").json()

    assert body
    for row in body:
        assert {"meeting_id", "title", "status", "started_at", "pending_candidates"} <= set(
            row
        )
    times = [row["started_at"] for row in body]
    assert times == sorted(times, reverse=True)


def test_pending_candidate_count_is_what_the_home_screen_reads(
    client: TestClient, seeded: dict
):
    """⭐ 0 이면 승인 화면으로 보내지 않는다 (`next.ts` 의 판단).

    보내면 빈 목록이 뜨고 사용자는 화면이 고장 났다고 생각합니다.
    """
    body = client.get(f"/api/projects/{seeded['project_id']}/meetings").json()
    meeting = next(r for r in body if r["meeting_id"] == seeded["meeting_id"])

    assert meeting["status"] == "needs_review"
    assert meeting["pending_candidates"] == seeded["pending"]


def test_outsider_cannot_list_meetings(client: TestClient, seeded: dict):
    from teamflow.db import session as db_session

    with db_session.session_scope() as s:
        outsider = m.User(name="외부인2", email="outsider2-home@example.com")
        s.add(outsider)
        s.flush()
        outsider_id = outsider.id

    login_as(client, outsider_id)
    assert (
        client.get(f"/api/projects/{seeded['project_id']}/meetings").status_code == 403
    )


def test_anonymous_sees_no_projects(client: TestClient, seeded: dict):
    client.cookies.clear()
    assert client.get("/api/projects").status_code == 401


def test_project_members_are_reachable_without_a_meeting(client: TestClient, seeded: dict):
    """⭐ 이름은 프로젝트 속성이지 회의 속성이 아니다.

    명단 API 가 회의 단위뿐이던 동안, 칸반·기여도를 `?project=N` 만으로 열면
    명단을 받을 길이 없어 **모든 이름이 `사용자 #3`** 으로 떴다. 기여도
    화면에서는 이름 순 정렬까지 그 문자열 순으로 바뀌었다.
    """
    body = client.get(f"/api/projects/{seeded['project_id']}/members").json()

    assert len(body) == 3
    for row in body:
        assert {"user_id", "name", "role_shares"} <= set(row)
        assert row["name"] and not row["name"].startswith("사용자 #")


def test_project_and_meeting_member_lists_agree(client: TestClient, seeded: dict):
    """⭐ 같은 명단을 두 곳에서 따로 만들면 반드시 갈라진다.

    갈라지면 화면마다 다른 명단을 보게 되고, 승인 화면에서 고른 담당자가
    칸반에서는 "알 수 없는 사용자" 로 보이는 상태가 된다.
    """
    by_project = client.get(f"/api/projects/{seeded['project_id']}/members").json()
    by_meeting = client.get(f"/api/meetings/{seeded['meeting_id']}/members").json()
    assert by_project == by_meeting


def test_outsider_cannot_read_the_member_list(client: TestClient, seeded: dict):
    from teamflow.db import session as db_session

    with db_session.session_scope() as s:
        outsider = m.User(name="외부인3", email="outsider3-home@example.com")
        s.add(outsider)
        s.flush()
        outsider_id = outsider.id

    login_as(client, outsider_id)
    assert client.get(f"/api/projects/{seeded['project_id']}/members").status_code == 403

def test_no_screen_is_a_dead_end(client: TestClient):
    """⭐ 화면 일곱 개 중 넷이 막다른 길이었다.

    녹음·승인·칸반·기여도에 들어가면 브라우저 뒤로가기 말고는 나올 방법이
    없었습니다. **폰에서 앱으로 설치해 열면 주소창도 뒤로가기도 없어서**
    그때는 정말 갇힙니다.

    이동 줄을 화면 위에서 **아래 탭바**로 옮겼습니다. 폰을 한 손으로 쥐면
    위쪽 3분의 1은 엄지가 안 닿기 때문입니다. 채우는 것은
    `src/demo/nav.ts` 이고, 무엇을 채울지는 `src/lib/nav/links.ts` 가
    정합니다(27개 테스트).
    """
    from pathlib import Path as _Path

    public = _Path(__file__).resolve().parents[2] / "frontend" / "public"

    # 로그인은 아직 신원이 없어 갈 곳이 정해지지 않았고, 오프라인 화면은
    # 연결이 없어 어디로도 못 갑니다 — 둘 다 탭이 죽은 링크가 됩니다.
    exempt = {"login.html", "offline.html"}
    missing = [
        page.name
        for page in sorted(public.glob("*.html"))
        if page.name not in exempt and 'id="tabs"' not in page.read_text()
    ]
    assert not missing, f"빠져나올 길이 없는 화면: {missing}"


def test_the_app_shell_is_actually_reachable(client: TestClient):
    """⭐ 설치에 필요한 파일을 서버가 실제로 준다.

    manifest·서비스 워커·아이콘이 저장소에 있는 것과 **서버가 주는 것**은
    다릅니다. 하나라도 404 면 홈 화면에 추가했을 때 주소창이 그대로
    남거나(manifest), 오프라인 화면이 안 뜨거나(sw.js), 아이콘 대신
    화면 캡처가 박힙니다.

    `sw.js` 는 특히 경로가 중요합니다. `/` 에서 서빙되지 않으면 스코프가
    좁아져 **다른 화면을 캐시하지 못합니다.**
    """
    for path, kind in [
        ("/manifest.webmanifest", None),
        ("/sw.js", "javascript"),
        ("/app.css", "css"),
        ("/icon.svg", "svg"),
        ("/icon-180.png", "png"),
        ("/icon-192.png", "png"),
        ("/icon-512.png", "png"),
        ("/icon-maskable-512.png", "png"),
        ("/offline.html", "html"),
    ]:
        response = client.get(path)
        assert response.status_code == 200, f"{path} → {response.status_code}"
        if kind:
            assert kind in response.headers["content-type"], (
                f"{path} → {response.headers['content-type']}"
            )


# ══════════════════════════════════════════════════════════════
# 대표 주장의 마지막 칸 — 관련 PR 이 업무 카드에 붙는가
# ══════════════════════════════════════════════════════════════


def test_the_demo_shows_a_pull_request_on_a_task_card(client: TestClient, seeded):
    """⭐ docs/08 §5.1 의 필수 경로가 **화면에서 끝까지 보이는가.**

        회의 녹음 → 자막 → 업무 후보 → 승인 → 칸반
            → **관련 PR 병합 → 업무 카드에 수행 근거**   ← 이 테스트
            → 기여도

    이게 안 보이면 이 프로젝트는 "회의록 만드는 툴" 과 구별되지 않습니다.
    """
    board = client.get(f"/api/projects/{seeded['project_id']}/tasks").json()

    with_pulls = [task for task in board["tasks"] if task["github"]]
    assert with_pulls, "시연 데이터에 PR 이 붙은 업무가 하나도 없습니다"

    link = with_pulls[0]["github"][0]
    assert link["confirmed"] is True
    assert link["number"] == 17
    assert link["actor_login"]
    assert "TASK" in link["why"]


def test_the_demo_task_that_came_from_a_meeting_is_the_one_with_the_pr(
    client: TestClient, seeded
):
    """회의에서 나온 업무에 PR 이 붙어야 경로가 **한 줄로** 이어집니다.

    손으로 만든 업무에만 PR 이 붙으면 회의와 GitHub 이 각각 따로 있는
    것이지 이어진 게 아닙니다.
    """
    board = client.get(f"/api/projects/{seeded['project_id']}/tasks").json()

    linked = [task for task in board["tasks"] if task["github"]]
    assert any(task["origin"] is not None for task in linked)


def test_every_demo_task_tells_people_what_to_write(client: TestClient, seeded):
    """표식을 안 보여주면 아무도 안 적고 자동 연결은 영영 안 일어납니다."""
    board = client.get(f"/api/projects/{seeded['project_id']}/tasks").json()

    for task in board["tasks"]:
        assert task["marker"] == f"TASK-{task['id']}"


def test_seeding_twice_does_not_double_the_links(client: TestClient, seeded):
    """`--reset` 을 두 번 해도 카드에 같은 PR 이 두 번 뜨면 안 됩니다."""
    seed_demo.seed(reset=True)
    login_as(client, seeded["user_ids"][0])

    board = client.get(f"/api/projects/{seeded['project_id']}/tasks").json()
    for task in board["tasks"]:
        numbers = [link["event_id"] for link in task["github"]]
        assert len(numbers) == len(set(numbers))
