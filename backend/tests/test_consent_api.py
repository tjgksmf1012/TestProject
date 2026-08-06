"""동의 API 와 게이트 — 법적 방어선.

이 파일이 존재하는 이유는 실제 구멍 하나입니다.

`join_track` 과 `store_chunk` 는 `require_consent(meeting_id)` 만 불렀습니다.
그 함수는 **동의 행이 있는 사람만** 세므로, 동의 행이 아예 없는 사람은
분모에도 안 들어갑니다. 참석자 셋이 동의를 마쳐 놓으면 넷째 사람은 아무
기록 없이 트랙을 만들고 자기 목소리를 올릴 수 있었습니다.

그 오디오는 발화가 되고 기여도 계산에 들어갑니다. 개인정보보호법이 요구하는
건 "회의가 동의를 받았다" 가 아니라 **"이 사람이 동의했다"** 이므로
(docs/07 L1·P1), 방어선이 통째로 없는 상태였습니다.

기존 테스트가 못 잡은 이유: 픽스처가 동의만 만들고 **프로젝트 구성원을
만들지 않았습니다.** 현실에서는 있을 수 없는 조합이라, 그 조합에서만
드러나는 구멍이 보이지 않았습니다.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select

from teamflow.config import Settings, get_settings
from teamflow.db import models as m
from teamflow.db import session as db_session

from .conftest import login_as

NOW = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)


@pytest.fixture
def engine(tmp_path: Path):
    eng = create_engine(f"sqlite:///{tmp_path / 'consent.db'}")
    m.Base.metadata.create_all(eng)
    db_session.configure(eng)
    yield eng
    eng.dispose()


@pytest.fixture
def client(engine, tmp_path: Path) -> Iterator[TestClient]:
    from teamflow.api.main import app

    app.dependency_overrides[get_settings] = lambda: Settings(
        environment="test",
        github_webhook_secret="test-secret",
        database_url="sqlite://",
        audio_storage_root=tmp_path / "audio",
    )
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def users(engine) -> list[int]:
    """팀원 셋 + 이 프로젝트와 무관한 외부인 하나."""
    with db_session.session_scope() as s:
        rows = [
            m.User(name="김민수", email="minsu@example.com"),
            m.User(name="이하늘", email="haneul@example.com"),
            m.User(name="박지원", email="jiwon@example.com"),
            m.User(name="외부인", email="outsider@example.com"),
        ]
        s.add_all(rows)
        s.flush()
        return [u.id for u in rows]


@pytest.fixture
def meeting(client: TestClient, users: list[int]) -> dict:
    """API 로만 만든다 — 이 경로가 실제로 도는지가 이 파일의 절반이다."""
    # 만드는 사람도 로그인해야 한다. 프로젝트 소유자를 요청 본문으로
    # 받으면 아무나 남을 팀에 넣고 그 팀의 회의를 열 수 있다.
    login_as(client, users[0])
    project = client.post("/api/projects", json={"title": "TeamFlow"})
    assert project.status_code == 201, project.text
    project_id = project.json()["project_id"]

    # 나머지는 **스스로** 들어온다. 요청 본문으로 남을 넣을 수 있으면
    # 아무나 남을 팀에 집어넣고 그 팀의 회의를 열 수 있다.
    invite_code = project.json()["invite_code"]
    for user_id in users[1:3]:
        login_as(client, user_id)
        joined = client.post("/api/projects/join", json={"invite_code": invite_code})
        assert joined.status_code == 200, joined.text
    login_as(client, users[0])

    created = client.post(
        f"/api/projects/{project_id}/meetings", json={"title": "1주차"}
    )
    assert created.status_code == 201, created.text
    return {
        "project_id": project_id,
        "meeting_id": created.json()["meeting_id"],
        "members": users[:3],
        "outsider": users[3],
    }


def consent(client: TestClient, meeting_id: int, user_id: int, *, ok: bool = True):
    # **동의는 본인만 한다.** 그래서 대신 제출할 방법이 없고, 헬퍼도
    # 그 사람으로 로그인한 뒤에야 부를 수 있다.
    login_as(client, user_id)
    return client.post(
        f"/api/meetings/{meeting_id}/consent",
        json={"consent_type": "recording", "consented": ok},
    )


def join(client: TestClient, meeting_id: int, user_id: int):
    login_as(client, user_id)
    return client.post(
        f"/api/meetings/{meeting_id}/tracks", json={"started_at": NOW.isoformat()}
    )


# ══════════════════════════════════════════════════════════════
# 생성 경로 — DB 를 손대지 않고 회의를 열 수 있는가
# ══════════════════════════════════════════════════════════════


def test_project_and_meeting_can_be_created_over_http(meeting: dict):
    assert meeting["project_id"] > 0
    assert meeting["meeting_id"] > 0


def test_project_starts_with_only_its_creator(client: TestClient, users: list[int]):
    """⭐ 만든 직후에는 혼자다 — 그게 정상적인 시작이다.

    예전에는 `member_ids` 를 요청 본문으로 받았고, 없는 id 를 넣으면
    **어떤 id 가 존재하는지 알려 주는 답**이 돌아왔다.
    """
    login_as(client, users[0])
    response = client.post("/api/projects", json={"title": "X"})
    assert response.status_code == 201, response.text
    assert response.json()["member_ids"] == [users[0]]


def test_only_members_can_start_a_meeting(client: TestClient, meeting: dict):
    """통신비밀보호법 L1 — 녹음을 시작하는 사람은 회의 당사자여야 한다."""
    login_as(client, meeting["outsider"])
    response = client.post(
        f"/api/projects/{meeting['project_id']}/meetings", json={}
    )
    assert response.status_code == 403
    assert "구성원이 아닙니다" in response.json()["detail"]


def test_single_mic_mode_is_refused(client: TestClient, meeting: dict):
    """⭐ 만들 수 있게 두면 녹음은 되는데 처리에서 조용히 빈 결과가 나온다.

    화자 분리(`build_diarizer`)가 미구현이기 때문이다. 못 만들게 막는 게
    "만들어 놓고 나중에 빈 회의록을 보는 것" 보다 낫다.
    """
    login_as(client, meeting["members"][0])
    response = client.post(
        f"/api/projects/{meeting['project_id']}/meetings",
        json={"capture_mode": "single"},
    )
    assert response.status_code == 400
    assert "멀티트랙" in response.json()["detail"]


# ══════════════════════════════════════════════════════════════
# 동의 제출
# ══════════════════════════════════════════════════════════════


def test_roster_shows_members_who_have_not_answered(client: TestClient, meeting: dict):
    """⭐ 응답하지 않은 사람이 목록에서 사라지면 안 된다.

    그 사람이야말로 기다려야 하는 대상이다. 동의 행이 있는 사람만 보여주면
    화면이 "아무도 안 기다리는 중" 처럼 보인다.
    """
    body = client.get(f"/api/meetings/{meeting['meeting_id']}/consent").json()

    assert len(body["roster"]) == 3
    assert all(entry["recording"] is None for entry in body["roster"])
    assert body["all_confirmed"] is False


def test_pending_is_distinguishable_from_refused(client: TestClient, meeting: dict):
    """None(미응답)과 False(거부)는 다른 상태다. 화면이 다른 말을 해야 한다."""
    consent(client, meeting["meeting_id"], meeting["members"][0], ok=True)
    consent(client, meeting["meeting_id"], meeting["members"][1], ok=False)

    roster = {
        e["user_id"]: e["recording"]
        for e in client.get(f"/api/meetings/{meeting['meeting_id']}/consent").json()["roster"]
    }

    assert roster[meeting["members"][0]] is True
    assert roster[meeting["members"][1]] is False
    assert roster[meeting["members"][2]] is None


def test_consent_is_idempotent(client: TestClient, meeting: dict, engine):
    """화면을 새로고침해도 동의가 두 번 세어지면 안 된다."""
    for _ in range(3):
        consent(client, meeting["meeting_id"], meeting["members"][0])

    with db_session.session_scope() as s:
        rows = s.scalars(
            select(m.RecordingConsent).where(
                m.RecordingConsent.meeting_id == meeting["meeting_id"]
            )
        ).all()
        assert len(rows) == 1


def test_all_confirmed_only_when_everyone_answered(client: TestClient, meeting: dict):
    for user_id in meeting["members"][:2]:
        body = consent(client, meeting["meeting_id"], user_id).json()
        assert body["all_confirmed"] is False

    body = consent(client, meeting["meeting_id"], meeting["members"][2]).json()
    assert body["all_confirmed"] is True
    assert "녹음을 시작할 수 있습니다" in body["message"]


def test_outsider_cannot_submit_consent(client: TestClient, meeting: dict):
    response = consent(client, meeting["meeting_id"], meeting["outsider"])
    assert response.status_code == 403
    assert "구성원이 아닙니다" in response.json()["detail"]


def test_unknown_consent_type_is_rejected(client: TestClient, meeting: dict):
    response = client.post(
        f"/api/meetings/{meeting['meeting_id']}/consent",
        json={
            "user_id": meeting["members"][0],
            "consent_type": "everything",
            "consented": True,
        },
    )
    assert response.status_code == 400


def test_optional_consents_do_not_gate_recording(client: TestClient, meeting: dict):
    """②③ 을 거부해도 서비스는 동작해야 한다 (필요 최소 수집 원칙)."""
    for user_id in meeting["members"]:
        consent(client, meeting["meeting_id"], user_id)
    client.post(
        f"/api/meetings/{meeting['meeting_id']}/consent",
        json={
            "user_id": meeting["members"][0],
            "consent_type": "voiceprint_storage",
            "consented": False,
        },
    )

    assert join(client, meeting["meeting_id"], meeting["members"][0]).status_code == 201


# ══════════════════════════════════════════════════════════════
# 게이트 — 여기가 실제 구멍이었다
# ══════════════════════════════════════════════════════════════


def test_person_without_a_consent_row_cannot_join(client: TestClient, meeting: dict, engine):
    """⭐⭐ 이게 뚫려 있었다.

    셋 중 둘만 동의해도 `consent_status` 는 total=2, granted=2 로 "전원 동의"
    가 된다 — 동의 행이 없는 사람은 분모에 없기 때문이다. 그 사람이 트랙을
    만들고 목소리를 올릴 수 있었다.
    """
    for user_id in meeting["members"][:2]:
        consent(client, meeting["meeting_id"], user_id)

    response = join(client, meeting["meeting_id"], meeting["members"][2])

    assert response.status_code == 403
    assert "본인의 녹음 동의 기록이 없습니다" in response.json()["detail"]


def test_outsider_cannot_join_even_with_full_consent(client: TestClient, meeting: dict):
    """동의와 자격은 다른 질문이다 (docs/07 P7)."""
    for user_id in meeting["members"]:
        consent(client, meeting["meeting_id"], user_id)

    response = join(client, meeting["meeting_id"], meeting["outsider"])

    assert response.status_code == 403
    assert "구성원이 아닙니다" in response.json()["detail"]


def test_refusing_blocks_that_person(client: TestClient, meeting: dict):
    for user_id in meeting["members"][:2]:
        consent(client, meeting["meeting_id"], user_id)
    consent(client, meeting["meeting_id"], meeting["members"][2], ok=False)

    response = join(client, meeting["meeting_id"], meeting["members"][2])
    assert response.status_code == 403
    assert "동의하지 않았습니다" in response.json()["detail"]


def test_revocation_blocks_new_chunks_but_keeps_old_ones(
    client: TestClient, meeting: dict, engine
):
    """⭐ 철회는 소급하지 않는다 — 이후만 막고 받은 것은 남긴다."""
    meeting_id = meeting["meeting_id"]
    for user_id in meeting["members"]:
        consent(client, meeting_id, user_id)

    track_id = join(client, meeting_id, meeting["members"][0]).json()["track_id"]
    for seq in range(2):
        ack = client.put(
            f"/api/meetings/{meeting_id}/tracks/{track_id}/chunks/{seq}",
            content=b"\x1a\x45\xdf\xa3" + b"audio" * 50,
            headers={"X-Client-At-Ms": str(int(NOW.timestamp() * 1000) + 5000 * (seq + 1))},
        )
        assert ack.status_code == 200

    consent(client, meeting_id, meeting["members"][0], ok=False)

    blocked = client.put(
        f"/api/meetings/{meeting_id}/tracks/{track_id}/chunks/2",
        content=b"\x1a\x45\xdf\xa3" + b"audio" * 50,
        headers={"X-Client-At-Ms": str(int(NOW.timestamp() * 1000) + 20_000)},
    )
    assert blocked.status_code == 403

    with db_session.session_scope() as s:
        kept = s.scalars(
            select(m.TrackChunk).where(m.TrackChunk.track_id == track_id)
        ).all()
        assert len(kept) == 2, "이미 받은 청크까지 지우면 안 된다"


def test_full_flow_over_http_only(client: TestClient, meeting: dict):
    """DB 를 손대지 않고 프로젝트 → 회의 → 동의 → 녹음까지 간다."""
    meeting_id = meeting["meeting_id"]
    for user_id in meeting["members"]:
        consent(client, meeting_id, user_id)

    for user_id in meeting["members"]:
        assert join(client, meeting_id, user_id).status_code == 201

    tracks = client.get(f"/api/meetings/{meeting_id}/tracks").json()["tracks"]
    assert len(tracks) == 3


# ══════════════════════════════════════════════════════════════
# 없는 ID 를 보냈을 때 — 조용한 성공이 없어야 한다
#
# 재계산·후보 조회가 전부 "없으면 빈 결과" 로 멀쩡히 동작하다 보니,
# 없는 것을 물어봐도 200 이 나갔습니다. 화면은 그걸 정상 상태로 그립니다.
# ══════════════════════════════════════════════════════════════


def test_unknown_candidate_is_reported_not_silently_ignored(
    client: TestClient, meeting: dict
):
    """⭐ 사람이 "승인" 을 눌렀는데 아무 일도 안 일어나면 그건 성공이 아니다.

    이 시스템에서 사람이 개입하는 유일한 지점이라(docs/03 §3), 여기서
    조용히 넘어가면 승인했다고 믿고 넘어가게 된다.
    """
    response = client.post(
        f"/api/meetings/{meeting['meeting_id']}/candidates/review",
        json={
            "reviewer_id": meeting["members"][0],
            "items": [{"candidate_id": 99_999, "approve": True}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["approved_count"] == 0
    assert body["failures"] == {"99999": ["unknown_candidate"]}


def test_candidate_from_another_meeting_is_refused(client: TestClient, meeting: dict, engine):
    """다른 회의의 후보 ID 를 보내도 조용히 넘어가면 안 된다."""
    with db_session.session_scope() as s:
        other = m.Meeting(
            project_id=meeting["project_id"],
            started_at=NOW,
            started_by=meeting["members"][0],
        )
        s.add(other)
        s.flush()
        utterance = m.Utterance(
            meeting_id=other.id,
            speaker_id=meeting["members"][0],
            start_ms=0,
            end_ms=1000,
            text="다른 회의",
            speaker_source="track",
        )
        s.add(utterance)
        s.flush()
        candidate = m.MeetingTaskCandidate(
            meeting_id=other.id,
            title="남의 후보",
            confidence=0.9,
            evidence_utterance_ids=[utterance.id],
        )
        s.add(candidate)
        s.flush()
        foreign_id = candidate.id
        other_id = other.id

    response = client.post(
        f"/api/meetings/{meeting['meeting_id']}/candidates/review",
        json={
            "reviewer_id": meeting["members"][0],
            "items": [{"candidate_id": foreign_id, "approve": True}],
        },
    )

    assert response.json()["failures"] == {str(foreign_id): ["unknown_candidate"]}
    with db_session.session_scope() as s:
        assert s.get(m.MeetingTaskCandidate, foreign_id).review_status == "pending"
        assert s.get(m.Meeting, other_id) is not None


def test_unknown_project_contributions_is_404(client: TestClient, users: list[int]):
    """⭐ 재계산 방식이라 없는 프로젝트도 "이벤트 0건 → 빈 결과" 로 계산된다.

    화면은 그걸 "기여도가 없는 프로젝트" 로 그린다 — 오타 하나로 팀 전체가
    0점인 것처럼 보이고 아무 오류도 나지 않는다.
    """
    login_as(client, users[0])
    assert client.get("/api/projects/99999/contributions").status_code == 404


def test_real_project_contributions_still_works(client: TestClient, meeting: dict):
    response = client.get(f"/api/projects/{meeting['project_id']}/contributions")
    assert response.status_code == 200
    assert len(response.json()["members"]) == 3
