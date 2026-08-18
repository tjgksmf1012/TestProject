"""회의 개선 추세 (`REVIEW-006`) — meeting/trends.py 와 그 API 계약.

가장 중요한 것 셋:
  - **회의별 값이 밖으로 안 나간다** — 나가면 회의 순위표의 재료가 된다
  - **분석 안 된 회의는 0 이 아니라 제외다** — 측정 불가 ≠ 0
  - 셋 미만이면 방향을 말하지 않는다 — 두 점은 우연이지 추세가 아니다
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from teamflow.config import Settings, get_settings
from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.meeting import trends

from .conftest import login_as

NOW = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)


# ── 순수 계산 ─────────────────────────────────────────────────


class TestDirection:
    def test_줄면_falling_이다(self):
        assert trends.direction_of(2.0, 0.5) == "falling"

    def test_늘면_rising_이다(self):
        assert trends.direction_of(0.0, 1.0) == "rising"

    def test_반_건_미만의_흔들림은_방향이_아니다(self):
        # 탐지기는 규칙 기반이라 이 수준은 잡음이다.
        assert trends.direction_of(1.0, 1.4) == "flat"
        assert trends.direction_of(1.4, 1.0) == "flat"


class TestHalves:
    def test_홀수면_가운데를_버린다(self):
        # 앞 2개·뒤 3개로 자르면 표본 크기가 달라 그 차이가 방향처럼 보인다.
        assert trends.halves([1, 2, 3, 4, 5]) == ([1, 2], [4, 5])

    def test_짝수면_반반이다(self):
        assert trends.halves([1, 2, 3, 4]) == ([1, 2], [3, 4])


class TestKindTrends:
    def test_어휘_선언_순으로_나온다(self):
        # 건수 순으로 늘어놓으면 "제일 많이 걸린 종류" 표가 된다 —
        # 갈라지는 데이터로 잰다: topic_drift 가 건수는 제일 많다.
        series = {
            "repeated_discussion": [1, 0, 0, 0],
            "topic_drift": [5, 5, 5, 5],
        }
        kinds = [t.kind for t in trends.kind_trends(series)]
        assert kinds.index("repeated_discussion") < kinds.index("topic_drift")

    def test_없는_종류는_평균_0_으로_나온다(self):
        # 어휘에 있는데 한 번도 안 걸린 종류 — 분석은 됐고 안 걸린 것이라
        # 0 이 맞다. 빼 버리면 "이 종류는 잰 적 없음" 과 구별이 안 된다.
        out = {t.kind: t for t in trends.kind_trends({"topic_drift": [0, 0]})}
        assert out["topic_drift"].direction == "flat"
        assert out["topic_drift"].early_avg == 0.0


def test_셋_미만이면_말하지_않는다():
    assert trends.measurable(2) is False
    assert trends.measurable(3) is True


# ── API ──────────────────────────────────────────────────────


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
def client(engine, tmp_path: Path) -> Iterator[TestClient]:
    from teamflow.api.main import app

    def _settings() -> Settings:
        return Settings(
            environment="test",
            github_webhook_secret="test-secret",
            database_url="sqlite://",
            audio_storage_root=tmp_path / "audio",
        )

    app.dependency_overrides[get_settings] = _settings
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def project(engine) -> dict[str, int]:
    with db_session.session_scope() as s:
        user = m.User(name="김민수", email="minsu@example.com")
        s.add(user)
        s.flush()
        project = m.Project(title="TeamFlow", started_at=NOW)
        s.add(project)
        s.flush()
        s.add(
            m.Member(
                project_id=project.id, user_id=user.id, role_shares={"developer": 1.0}
            )
        )
        return {"project_id": project.id, "user_id": user.id}


def add_meeting(
    project_id: int,
    user_id: int,
    *,
    day: int,
    status: str,
    title: str = "정기회의",
    events: dict[str, int] | None = None,
) -> int:
    with db_session.session_scope() as s:
        meeting = m.Meeting(
            project_id=project_id,
            title=title,
            started_at=NOW + timedelta(days=day),
            started_by=user_id,
            status=status,
        )
        s.add(meeting)
        s.flush()
        for kind, count in (events or {}).items():
            for _ in range(count):
                s.add(
                    m.MeetingEvent(
                        meeting_id=meeting.id,
                        event_type=kind,
                        severity="info",
                        start_ms=0,
                        end_ms=1_000,
                        evidence_utterance_ids=[],
                        detail={},
                    )
                )
        return meeting.id


def read_trends(client: TestClient, project: dict) -> dict:
    login_as(client, project["user_id"])
    response = client.get(f"/api/projects/{project['project_id']}/analytics")
    assert response.status_code == 200
    return response.json()["meeting_trends"]


def test_분석된_회의가_적으면_못_잰다고_말할_재료를_준다(client, project):
    add_meeting(project["project_id"], project["user_id"], day=0, status="needs_review")
    add_meeting(project["project_id"], project["user_id"], day=1, status="confirmed")
    body = read_trends(client, project)
    assert body["measurable"] is False
    assert body["meetings_counted"] == 2
    assert body["needed"] == trends.MIN_MEETINGS
    assert body["kinds"] == []


def test_분석_안_된_회의는_0_이_아니라_제외다(client, project):
    """⭐ `processing`·`failed`·`pending` 을 세면 못 잰 회의가 "구간
    0건" 이 된다 — 측정 불가를 0으로 바꾸는 바로 그 실수다. 넷을 넣어도
    분석된 것은 둘뿐이므로 여전히 못 잰다고 답해야 한다.
    """
    add_meeting(project["project_id"], project["user_id"], day=0, status="needs_review")
    add_meeting(project["project_id"], project["user_id"], day=1, status="confirmed")
    add_meeting(project["project_id"], project["user_id"], day=2, status="processing")
    add_meeting(project["project_id"], project["user_id"], day=3, status="failed")
    body = read_trends(client, project)
    assert body["measurable"] is False
    assert body["meetings_counted"] == 2


def test_방향은_앞뒤_절반_평균으로_나온다(client, project):
    # 반복 논의가 회의당 2건 → 0건으로 줄어든 팀.
    add_meeting(
        project["project_id"], project["user_id"], day=0, status="confirmed",
        events={"repeated_discussion": 2},
    )
    add_meeting(
        project["project_id"], project["user_id"], day=1, status="confirmed",
        events={"repeated_discussion": 2},
    )
    add_meeting(
        project["project_id"], project["user_id"], day=2, status="needs_review",
        events={},
    )
    add_meeting(
        project["project_id"], project["user_id"], day=3, status="needs_review",
        events={},
    )
    body = read_trends(client, project)
    assert body["measurable"] is True
    by_kind = {k["kind"]: k for k in body["kinds"]}
    repeated = by_kind["repeated_discussion"]
    assert repeated == {
        "kind": "repeated_discussion",
        "early_avg": 2.0,
        "late_avg": 0.0,
        "direction": "falling",
    }


def test_회의별_값과_회의_제목은_밖으로_안_나간다(client, project):
    """⭐ 회의를 짚을 재료를 주지 않는다 — 회의 순위표 방지의 핵심."""
    for day in range(4):
        add_meeting(
            project["project_id"], project["user_id"], day=day, status="confirmed",
            title=f"고유한제목{day}차회의",
            events={"topic_drift": day},
        )
    login_as(client, project["user_id"])
    response = client.get(f"/api/projects/{project['project_id']}/analytics")
    body = response.json()["meeting_trends"]
    # 제목도, 회의 id 목록도, 회의별 수열도 없다.
    assert "고유한제목" not in response.text
    for kind in body["kinds"]:
        assert set(kind.keys()) == {"kind", "early_avg", "late_avg", "direction"}


def test_바깥_사람은_추세도_못_본다(client, project):
    with db_session.session_scope() as s:
        outsider = m.User(name="바깥사람", email="outsider@example.com")
        s.add(outsider)
        s.flush()
        outsider_id = outsider.id
    for day in range(3):
        add_meeting(project["project_id"], project["user_id"], day=day, status="confirmed")
    login_as(client, outsider_id)
    response = client.get(f"/api/projects/{project['project_id']}/analytics")
    assert response.status_code in (403, 404)
