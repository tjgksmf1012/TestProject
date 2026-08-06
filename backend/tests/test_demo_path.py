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
    assert len(candidates) == 3


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
