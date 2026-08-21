"""청크 업로드는 **서로를 막지 않아야 한다** (결함 279).

사람 둘 이상이 같은 회의를 녹음하는 것이 이 제품의 기본 상황이다.
그런데 청크 엔드포인트는 `async def` 인데(본문을 `await` 로 읽어야 해서)
그 아래가 전부 **막는 일**이었다 — DB 읽기·쓰기와 파일 쓰기. 그대로 두면
청크 하나를 처리하는 동안 이벤트 루프가 멈춘다.

실서버(`uvicorn`)로 재현했다.

    순차 PUT 6번        전부 200, 한 번에 0.01초
    동시 GET 12번       전부 200, 다 합쳐 0.05초
    동시 PUT 12번       **200 이 둘**, 나머지 열은 20초 안에 응답 없음

읽기는 멀쩡하고 이 자리만 막힌다. 청크가 못 올라가면 그 구간의 소리는
영영 못 잰다.

## 왜 시간을 재는가

「스레드풀에서 도는가」를 글자로 보면 `run_in_threadpool` 이라는 낱말만
지키게 된다 — 다른 방법으로 고쳐도 통과해야 하고, 낱말만 남고 실제로는
안 도는 경우도 잡아야 한다. 그래서 **요구를 잰다**: 하나가 느려도 다른
하나가 기다리지 않는가.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from teamflow.config import Settings, get_settings
from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.services import recording_service

from .conftest import login_as

NOW = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)

#: 저장 한 번에 이만큼 걸린다고 치고 잽니다. 막는 일이 이벤트 루프에 있으면
#: 여덟 개가 **줄을 서서** 이 값의 여덟 배가 됩니다.
SLOW_SECONDS = 0.2
CONCURRENT = 8


@pytest.fixture
def engine(tmp_path: Path):
    eng = create_engine(f"sqlite:///{tmp_path / 'concurrency.db'}")
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
def track(client: TestClient, engine) -> dict[str, int]:
    """혼자 녹음하는 회의 하나. **동시성은 사람 수가 아니라 요청 수의 문제**라
    한 사람이면 충분합니다 — 로그인 쿠키를 스레드마다 바꾸지 않아도 됩니다."""
    with db_session.session_scope() as s:
        user = m.User(name="김민수", email="minsu@example.com")
        s.add(user)
        s.flush()
        user_id = user.id
    login_as(client, user_id)

    project = client.post("/api/projects", json={"title": "TeamFlow"})
    assert project.status_code == 201, project.text
    meeting = client.post(
        f"/api/projects/{project.json()['project_id']}/meetings", json={"title": "1주차"}
    )
    assert meeting.status_code == 201, meeting.text
    meeting_id = meeting.json()["meeting_id"]

    agreed = client.post(
        f"/api/meetings/{meeting_id}/consent",
        json={"consent_type": "recording", "consented": True},
    )
    assert agreed.status_code == 200, agreed.text

    joined = client.post(
        f"/api/meetings/{meeting_id}/tracks", json={"started_at": NOW.isoformat()}
    )
    assert joined.status_code == 201, joined.text
    return {"meeting_id": meeting_id, "track_id": joined.json()["track_id"]}


def test_one_slow_upload_does_not_block_the_others(
    client: TestClient, track: dict[str, int], monkeypatch: pytest.MonkeyPatch
) -> None:
    """⭐ 여덟을 **동시에** 올리면 여덟 배가 아니라 한 번 걸린다."""
    real = recording_service.store_chunk

    def slow(*args: object, **kwargs: object) -> m.TrackChunk:
        time.sleep(SLOW_SECONDS)
        return real(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(recording_service, "store_chunk", slow)

    def put(seq: int) -> int:
        return client.put(
            f"/api/meetings/{track['meeting_id']}/tracks/{track['track_id']}/chunks/{seq}",
            content=b"\x1a\x45\xdf\xa3" + b"audio" * 50,
            headers={"X-Client-At-Ms": str(int(NOW.timestamp() * 1000) + 5000 * seq)},
        ).status_code

    with ThreadPoolExecutor(max_workers=CONCURRENT) as pool:
        started = time.monotonic()
        codes = list(pool.map(put, range(CONCURRENT)))
        elapsed = time.monotonic() - started

    assert codes == [200] * CONCURRENT, codes
    serial = SLOW_SECONDS * CONCURRENT
    assert elapsed < serial * 0.6, (
        f"{CONCURRENT}개를 동시에 올렸는데 {elapsed:.2f}초 걸렸습니다 — "
        f"줄을 서면 {serial:.2f}초입니다. 막는 일이 이벤트 루프에 있습니다."
    )


def test_uploads_still_land(client: TestClient, track: dict[str, int]) -> None:
    """⚠️ 빨라지기만 하고 **안 적히면** 아무 의미가 없습니다."""

    def put(seq: int) -> int:
        return client.put(
            f"/api/meetings/{track['meeting_id']}/tracks/{track['track_id']}/chunks/{seq}",
            content=b"\x1a\x45\xdf\xa3" + b"audio" * 50,
            headers={"X-Client-At-Ms": str(int(NOW.timestamp() * 1000) + 5000 * seq)},
        ).status_code

    with ThreadPoolExecutor(max_workers=CONCURRENT) as pool:
        assert list(pool.map(put, range(CONCURRENT))) == [200] * CONCURRENT

    stored = client.get(
        f"/api/meetings/{track['meeting_id']}/tracks/{track['track_id']}/chunks"
    )
    assert stored.status_code == 200, stored.text
    assert sorted(stored.json()["seqs"]) == list(range(CONCURRENT))
