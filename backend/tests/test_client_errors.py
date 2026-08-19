"""브라우저에서 난 일이 서버 로그에 남는가.

## 왜 이 파일이 생겼나

베타 체험 중에 화면 하나를 일부러 터뜨려 봤습니다. 사람이 본 것:

    Unexpected Application Error!
    e.filter is not a function
    at ls (…/assets/index-DskNXvnA.js:12:42055)

영문이고, 압축된 스택이고, 돌아갈 버튼이 없었습니다. 그리고 **서버 로그에는
한 줄도 안 남았습니다** — 요청은 200 이었으니까요. 베타 참가자가 "그냥 안
되던데요" 라고 말하면 그걸로 끝나는 상태였습니다.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from teamflow.config import Settings, get_settings
from teamflow.db import models as m
from teamflow.db import session as db_session


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    eng = create_engine(f"sqlite:///{tmp_path / 'ce.db'}")
    m.Base.metadata.create_all(eng)
    db_session.configure(eng)
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
    eng.dispose()


@pytest.fixture(autouse=True)
def _reset_window() -> Iterator[None]:
    from teamflow.api import main

    main._client_error_window.clear()
    yield
    main._client_error_window.clear()


def test_a_broken_screen_leaves_a_line_in_the_log(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger="teamflow.api.main"):
        res = client.post(
            "/api/client-errors",
            json={
                "kind": "render",
                "message": "e.filter is not a function",
                "stack": "TypeError: e.filter is not a function\n  at Home",
                "route": "/app/",
            },
        )
    assert res.status_code == 204
    line = caplog.text
    # 무엇이 · 어디서 · 무슨 일이 — 셋 다 있어야 다음 날 읽고 알 수 있다.
    assert "render" in line
    assert "/app/" in line
    assert "e.filter is not a function" in line
    assert "at Home" in line


def test_it_does_not_need_a_login(client: TestClient) -> None:
    """⭐ 로그인 화면에서 터진 것이 가장 알고 싶은 것이다.

    인증을 걸면 그건 영영 안 들어온다.
    """
    res = client.post(
        "/api/client-errors",
        json={"kind": "error", "message": "로그인 화면이 터졌다", "route": "/app/login"},
    )
    assert res.status_code == 204


def test_the_screen_is_never_told_it_failed(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    """⚠️ 넘쳐도 204 다.

    429 를 주면 화면의 오류 보고가 **또 오류**를 만들고, 그 오류가 다시
    보고를 부릅니다. 조용히 버리는 것이 맞습니다.
    """
    from teamflow.api import main

    body = {"kind": "render", "message": "같은 오류", "route": "/app/"}
    with caplog.at_level(logging.WARNING, logger="teamflow.api.main"):
        for _ in range(main._CLIENT_ERROR_PER_MINUTE + 20):
            assert client.post("/api/client-errors", json=body).status_code == 204
    # 남긴 줄은 상한까지만.
    assert caplog.text.count("같은 오류") == main._CLIENT_ERROR_PER_MINUTE


def test_over_long_payloads_are_refused(client: TestClient) -> None:
    """상한은 화면(`lib/diag/report.ts` 의 `MAX_*`)과 같은 숫자다.

    다르면 화면은 보냈다고 믿는데 서버가 422 로 버린다 — 조용히.
    """
    assert (
        client.post(
            "/api/client-errors",
            json={"kind": "render", "message": "가" * 501, "route": "/app/"},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/client-errors",
            json={
                "kind": "render",
                "message": "짧음",
                "stack": "a" * 4001,
                "route": "/app/",
            },
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/client-errors",
            json={"kind": "render", "message": "짧음", "route": "/" + "a" * 200},
        ).status_code
        == 422
    )


def test_the_limits_match_the_screen() -> None:
    """⭐ 상한이 화면과 서버에서 **같은 숫자**인가.

    ⚠️ 이건 두 벌입니다 — TypeScript 에 한 벌, Pydantic 에 한 벌. 두 벌은
    반드시 갈라지고, 갈라지면 화면은 "보냈다" 고 믿는데 서버가 422 로
    조용히 버립니다. 오류 보고가 사라지는 것은 **아무도 못 알아챕니다** —
    원래도 조용한 기능이니까요. 그래서 여기서 숫자를 맞대 봅니다.
    """
    import re

    from teamflow.api.main import ClientErrorIn

    ts = (
        Path(__file__).resolve().parents[2]
        / "frontend"
        / "src"
        / "lib"
        / "diag"
        / "report.ts"
    ).read_text(encoding="utf-8")

    def screen_limit(name: str) -> int:
        found = re.search(rf"export const {name} = (\d+);", ts)
        assert found is not None, f"{name} 를 report.ts 에서 못 찾았습니다"
        return int(found.group(1))

    def server_limit(field: str) -> int:
        meta = ClientErrorIn.model_fields[field].metadata
        for entry in meta:
            length = getattr(entry, "max_length", None)
            if length is not None:
                return int(length)
        raise AssertionError(f"{field} 에 max_length 가 없습니다")

    assert screen_limit("MAX_MESSAGE") == server_limit("message")
    assert screen_limit("MAX_STACK") == server_limit("stack")
    assert screen_limit("MAX_ROUTE") == server_limit("route")
