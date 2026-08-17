"""프로필 이미지·자기소개 (`USER-004`) — users/profile.py 와 그 API 계약.

가장 중요한 것 셋:
  - **파일 업로드 통로가 아니다** — PNG 데이터 URI 하나만, 시그니처·치수·
    크기를 서버가 바이트로 직접 본다. SVG 는 형식부터 거절 (문서로 열리는
    순간 스크립트가 도는 유일한 이미지 형식)
  - `None` 은 안 건드림 · `""` 는 지움 — 지울 방법이 없으면 잘못 올린
    사진이 영영 남는다
  - **적은 것을 팀원이 본다** — 팀원 목록에 실린다. 적을 수 있는데 아무도
    못 보면 "할 일을 알려 주고 자리를 안 줌" 이다
"""

from __future__ import annotations

import base64
import struct
import zlib
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from teamflow.config import Settings, get_settings
from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.users import profile

from .conftest import login_as

NOW = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)


def png_bytes(width: int = 1, height: int = 1) -> bytes:
    """진짜 PNG 를 만든다 — 시그니처·IHDR·CRC 전부 규격대로.

    가짜 입력이 실기와 다른 모양이면 통과가 아무 말도 못 한다(결함 171).
    """

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    scanlines = b"".join(b"\x00" + b"\x00\x00\x00" * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(scanlines))
        + chunk(b"IEND", b"")
    )


def data_uri(raw: bytes, mime: str = "image/png") -> str:
    return f"data:{mime};base64,{base64.b64encode(raw).decode()}"


# ── 순수 검증 ─────────────────────────────────────────────────


class TestBio:
    def test_비었거나_공백뿐이면_None_이다(self):
        assert profile.clean_bio(None) is None
        assert profile.clean_bio("") is None
        assert profile.clean_bio("   ") is None

    def test_앞뒤_공백을_걷어낸다(self):
        assert profile.clean_bio("  백엔드를 맡고 있습니다  ") == "백엔드를 맡고 있습니다"

    def test_상한을_넘으면_몇_자인지까지_말한다(self):
        with pytest.raises(ValueError, match="300자"):
            profile.clean_bio("가" * 301)


class TestAvatar:
    def test_비었으면_None_이다(self):
        assert profile.clean_avatar(None) is None
        assert profile.clean_avatar("") is None

    def test_작은_PNG_는_받은_글자_그대로_돌려준다(self):
        uri = data_uri(png_bytes(96, 96))
        assert profile.clean_avatar(uri) == uri

    def test_PNG_아닌_형식은_거절한다(self):
        # ⚠️ SVG 가 특히 위험하다 — 문서로 열면 스크립트가 돈다.
        for mime in ("image/jpeg", "image/svg+xml", "image/webp"):
            with pytest.raises(ValueError, match="PNG 데이터 URI"):
                profile.clean_avatar(data_uri(png_bytes(), mime))

    def test_형식만_PNG_라고_주장하는_것은_시그니처에서_걸린다(self):
        fake = data_uri(b"<svg onload=alert(1)>" + b"\x00" * 32)
        with pytest.raises(ValueError, match="PNG 가 아닙니다"):
            profile.clean_avatar(fake)

    def test_치수가_큰_PNG_는_거절한다(self):
        with pytest.raises(ValueError, match="192px"):
            profile.clean_avatar(data_uri(png_bytes(200, 96)))
        with pytest.raises(ValueError, match="192px"):
            profile.clean_avatar(data_uri(png_bytes(96, 200)))

    def test_바이트가_많으면_치수와_무관하게_거절한다(self):
        # 작은 치수를 주장하면서 데이터만 부풀린 PNG — 치수 검사만 믿으면
        # 여기가 뚫린다.
        fat = png_bytes(96, 96) + b"\x00" * (profile.MAX_AVATAR_BYTES + 1)
        with pytest.raises(ValueError, match="너무 큽니다"):
            profile.clean_avatar(data_uri(fat))

    def test_base64_가_아니면_형식에서_걸린다(self):
        with pytest.raises(ValueError):
            profile.clean_avatar("data:image/png;base64,이건 base64 가 아님")


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
def team(engine) -> dict[str, int]:
    """같은 프로젝트의 두 사람 — 적은 것을 팀원이 보는지 재기 위해."""
    with db_session.session_scope() as s:
        minsu = m.User(name="김민수", email="minsu@example.com")
        haneul = m.User(name="이하늘", email="haneul@example.com")
        s.add_all([minsu, haneul])
        s.flush()
        project = m.Project(title="TeamFlow", started_at=NOW)
        s.add(project)
        s.flush()
        for user in (minsu, haneul):
            s.add(
                m.Member(
                    project_id=project.id,
                    user_id=user.id,
                    role_shares={"developer": 1.0},
                )
            )
        return {
            "project_id": project.id,
            "minsu": minsu.id,
            "haneul": haneul.id,
        }


AVATAR = data_uri(png_bytes(96, 96))


def test_적은_프로필이_me_와_팀원_목록에_같이_나온다(client, team):
    login_as(client, team["minsu"])
    response = client.patch(
        "/api/auth/me/profile",
        json={"bio": "백엔드를 맡고 있습니다", "avatar": AVATAR},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["bio"] == "백엔드를 맡고 있습니다"
    assert body["avatar"] == AVATAR

    # ⭐ 볼 자리 — 팀원(이하늘)이 팀원 목록에서 본다.
    login_as(client, team["haneul"])
    members = client.get(f"/api/projects/{team['project_id']}/members").json()
    mine = next(row for row in members if row["user_id"] == team["minsu"])
    assert mine["bio"] == "백엔드를 맡고 있습니다"
    assert mine["avatar"] == AVATAR


def test_빈_문자열은_지움이고_안_보낸_칸은_안_건드린다(client, team):
    login_as(client, team["minsu"])
    client.patch("/api/auth/me/profile", json={"bio": "소개", "avatar": AVATAR})

    # bio 만 지운다 — avatar 는 안 보냈으니 그대로여야 한다.
    response = client.patch("/api/auth/me/profile", json={"bio": ""})
    body = response.json()
    assert body["bio"] is None
    assert body["avatar"] == AVATAR

    # avatar 도 지운다.
    body = client.patch("/api/auth/me/profile", json={"avatar": ""}).json()
    assert body["avatar"] is None


def test_틀린_이미지는_400_이고_아무것도_안_바뀐다(client, team):
    login_as(client, team["minsu"])
    client.patch("/api/auth/me/profile", json={"avatar": AVATAR})

    response = client.patch(
        "/api/auth/me/profile", json={"avatar": data_uri(png_bytes(), "image/svg+xml")}
    )
    assert response.status_code == 400

    assert client.get("/api/auth/me").json()["avatar"] == AVATAR


def test_로그인_없이는_못_적는다(client, team):
    response = client.patch("/api/auth/me/profile", json={"bio": "소개"})
    assert response.status_code == 401


def test_모르는_칸은_거절한다(client, team):
    # `user_id` 같은 칸을 몰래 실어도 무시가 아니라 **거절**이어야 한다.
    login_as(client, team["minsu"])
    response = client.patch(
        "/api/auth/me/profile", json={"bio": "소개", "user_id": team["haneul"]}
    )
    assert response.status_code == 422
