"""인증 테스트.

이 파일이 고정하는 것은 하나입니다 — **서버가 "누가 요청했는가" 를 요청
본문이 아니라 세션에서 읽는가.**

그 전까지는 `user_id` 를 본문에 적으면 그대로 믿었습니다. 누구나 남의
번호로 동의를 제출하고, 남의 트랙에 목소리를 올리고, 남의 이름으로 업무를
승인할 수 있었습니다. 기여도를 산정하는 시스템에서 그건 기능 하나가 빠진
게 아니라 **산출물 전체가 근거를 잃는** 문제입니다.

그래서 여기서는 "로그인이 되는가" 보다 **"사칭이 막히는가"** 를 더 많이
잽니다. 로그인 화면이 도는 것만 확인하면, 옛 클라이언트가 `user_id` 를
계속 보내도 아무도 모릅니다 — pydantic 은 모르는 필드를 조용히 버리므로
그 요청은 여전히 200 입니다.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.pool import StaticPool

from teamflow.auth import passwords
from teamflow.config import Settings, get_settings
from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.services import auth_service

from .conftest import login_as

NOW = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)
PASSWORD = "graduation-2026"


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
def team(engine) -> dict:
    """팀원 둘 + 외부인 하나. 비밀번호는 첫 사람만 갖고 있다."""
    with db_session.session_scope() as s:
        members = [
            m.User(
                name="김민수",
                email="minsu@example.com",
                password_hash=passwords.hash_password(PASSWORD),
            ),
            m.User(name="이하늘", email="haneul@example.com"),
        ]
        outsider = m.User(name="외부인", email="outsider@example.com")
        s.add_all([*members, outsider])
        s.flush()

        project = m.Project(title="TeamFlow", started_at=NOW)
        s.add(project)
        s.flush()
        for user in members:
            s.add(m.Member(project_id=project.id, user_id=user.id, role_shares={}))

        meeting = m.Meeting(
            project_id=project.id, started_at=NOW, started_by=members[0].id
        )
        s.add(meeting)
        s.flush()
        return {
            "project_id": project.id,
            "meeting_id": meeting.id,
            "members": [u.id for u in members],
            "outsider": outsider.id,
        }


# ══════════════════════════════════════════════════════════════
# 비밀번호
# ══════════════════════════════════════════════════════════════


def test_hash_and_verify_roundtrip():
    encoded = passwords.hash_password(PASSWORD)
    assert passwords.verify_password(PASSWORD, encoded) is True
    assert passwords.verify_password(PASSWORD + "x", encoded) is False


def test_same_password_hashes_differently_every_time():
    """소금이 없으면 같은 비밀번호를 쓴 사람이 DB 에서 한눈에 보인다."""
    a = passwords.hash_password(PASSWORD)
    b = passwords.hash_password(PASSWORD)
    assert a != b
    assert passwords.verify_password(PASSWORD, a)
    assert passwords.verify_password(PASSWORD, b)


def test_hash_never_contains_the_password():
    assert PASSWORD not in passwords.hash_password(PASSWORD)


def test_parameters_are_stored_with_the_hash():
    """⭐ n 을 올리면 옛 해시를 검증할 수 없게 된다.

    형식에 파라미터가 없으면 비용을 올리는 순간 **모든 기존 사용자가
    로그인 불가**가 된다. 저장해 두면 옛 해시는 옛 파라미터로 검증된다.
    """
    encoded = passwords.hash_password(PASSWORD)
    scheme, n, r, p, _salt, _hash = encoded.split("$")
    assert scheme == "scrypt"
    assert (int(n), int(r), int(p)) == (
        passwords.SCRYPT_N,
        passwords.SCRYPT_R,
        passwords.SCRYPT_P,
    )


def test_an_old_hash_with_different_parameters_still_verifies():
    """비용을 올리기 전에 만들어진 해시가 계속 통해야 한다."""
    import hashlib
    import secrets

    salt = secrets.token_bytes(16)
    weak_n = 1024
    derived = hashlib.scrypt(
        PASSWORD.encode(), salt=salt, n=weak_n, r=8, p=1, dklen=32
    )
    old = f"scrypt${weak_n}$8$1${salt.hex()}${derived.hex()}"
    assert passwords.verify_password(PASSWORD, old) is True


def test_password_without_a_hash_never_verifies():
    """⭐ 비밀번호를 설정한 적 없는 계정은 로그인할 수 없어야 한다.

    인증이 생기기 전에 만들어진 사용자는 `password_hash` 가 NULL 이다.
    None 을 "확인할 게 없으니 통과" 로 읽으면 그 계정 전부가 무인증으로
    열린다 — 인증을 추가하면서 뚫는 셈이다.
    """
    assert passwords.verify_password("아무거나", None) is False
    assert passwords.verify_password("아무거나", "") is False


def test_broken_hash_is_a_mismatch_not_a_crash():
    """DB 한 행이 깨졌다고 로그인 엔드포인트 전체가 500 이 되면 안 된다."""
    for junk in ("", "not-a-hash", "scrypt$x$8$1$aa$bb", "bcrypt$2b$12$xxx"):
        assert passwords.verify_password(PASSWORD, junk) is False


def test_short_passwords_are_refused():
    with pytest.raises(passwords.WeakPassword):
        passwords.hash_password("short")


def test_absurdly_long_passwords_are_refused():
    """상한이 없으면 수 MB 문자열로 로그인 경로를 두드려 서버를 묶을 수 있다."""
    with pytest.raises(passwords.WeakPassword):
        passwords.hash_password("x" * (passwords.MAX_PASSWORD_BYTES + 1))


def test_korean_passwords_work():
    """한국어 비밀번호가 깨지면 그 사람은 영영 로그인 못 한다."""
    encoded = passwords.hash_password("우리팀최고비밀번호")
    assert passwords.verify_password("우리팀최고비밀번호", encoded) is True


# ══════════════════════════════════════════════════════════════
# 세션
# ══════════════════════════════════════════════════════════════


def test_session_token_is_not_stored_in_the_clear(engine, team: dict):
    """⭐ 토큰 원문을 저장하면 DB 를 읽은 사람이 모두로 로그인할 수 있다.

    비밀번호를 해싱해 놓고 세션 토큰을 평문으로 두면 앞의 노력이 무의미하다 —
    토큰이 곧 그 계정이기 때문이다.
    """
    with db_session.session_scope() as s:
        token, row = auth_service.issue_session(s, user_id=team["members"][0])
        stored = row.token_hash

    assert token not in stored
    assert len(stored) == 64  # sha256 hex


def test_resolve_returns_the_user(engine, team: dict):
    with db_session.session_scope() as s:
        token, _ = auth_service.issue_session(s, user_id=team["members"][0])
    with db_session.session_scope() as s:
        assert auth_service.resolve_session(s, token).id == team["members"][0]


def test_unknown_or_missing_token_resolves_to_nobody(engine):
    with db_session.session_scope() as s:
        assert auth_service.resolve_session(s, None) is None
        assert auth_service.resolve_session(s, "") is None
        assert auth_service.resolve_session(s, "made-up") is None


def test_expired_session_is_dead(engine, team: dict):
    with db_session.session_scope() as s:
        token, row = auth_service.issue_session(s, user_id=team["members"][0])
        row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    with db_session.session_scope() as s:
        assert auth_service.resolve_session(s, token) is None


def test_revoked_session_is_dead(engine, team: dict):
    with db_session.session_scope() as s:
        token, _ = auth_service.issue_session(s, user_id=team["members"][0])
        assert auth_service.revoke(s, token) is True
    with db_session.session_scope() as s:
        assert auth_service.resolve_session(s, token) is None


def test_revoking_all_kills_every_device(engine, team: dict):
    """기기를 잃었을 때 쓰는 경로. 하나만 끊으면 남은 기기가 계속 열려 있다."""
    with db_session.session_scope() as s:
        tokens = [
            auth_service.issue_session(s, user_id=team["members"][0])[0]
            for _ in range(3)
        ]
        assert auth_service.revoke_all_for_user(s, team["members"][0]) == 3

    with db_session.session_scope() as s:
        assert all(auth_service.resolve_session(s, t) is None for t in tokens)


def test_revoking_one_user_does_not_touch_another(engine, team: dict):
    with db_session.session_scope() as s:
        mine, _ = auth_service.issue_session(s, user_id=team["members"][0])
        theirs, _ = auth_service.issue_session(s, user_id=team["members"][1])
        auth_service.revoke_all_for_user(s, team["members"][0])

    with db_session.session_scope() as s:
        assert auth_service.resolve_session(s, mine) is None
        assert auth_service.resolve_session(s, theirs) is not None


def test_every_session_gets_a_different_token(engine, team: dict):
    with db_session.session_scope() as s:
        tokens = {
            auth_service.issue_session(s, user_id=team["members"][0])[0]
            for _ in range(5)
        }
    assert len(tokens) == 5


def test_an_expired_session_stops_working_but_stays_in_the_record(engine, team: dict):
    """⭐ 만료는 **판정**이지 삭제가 아닙니다 (결함 116).

    `UserSession` 모델은 "행을 지우지 않는 이유는 감사 때문" 이라고 적어
    뒀습니다 — 학기 말 기여도 분쟁에서 "누가 언제 로그인해 있었는가" 를
    확인할 거리이기 때문입니다. 그런데 `auth_service` 에는 만료된 행을
    **지우는** 함수가 있었고, 독스트링은 유지보수 잡이 부른다고
    단언했습니다. 배선됐다면 그 기록이 매일 사라졌을 것입니다.

    지울 이유도 없습니다 — 아래 두 줄이 그것을 말합니다. 행이 남아 있어도
    그 토큰으로는 아무것도 못 합니다.
    """
    with db_session.session_scope() as s:
        live, _ = auth_service.issue_session(s, user_id=team["members"][0])
        dead, row = auth_service.issue_session(s, user_id=team["members"][0])
        row.expires_at = datetime.now(UTC) - timedelta(days=1)

    with db_session.session_scope() as s:
        # 만료된 토큰은 그 자리에서 거절됩니다 — 잡이 돌기를 기다리지 않습니다.
        assert auth_service.resolve_session(s, dead) is None
        assert auth_service.resolve_session(s, live) is not None
        # 그리고 두 행 다 남아 있습니다. 이게 감사 기록입니다.
        assert len(s.scalars(select(m.UserSession)).all()) == 2


def test_email_case_is_folded(engine):
    """⭐ 접지 않으면 `A@x.com` 과 `a@x.com` 이 다른 계정이 된다.

    사람은 같은 주소라고 생각하므로 로그인이 안 될 때 비밀번호를 의심하지,
    계정이 둘이라고는 생각하지 않는다. 기여도가 두 계정으로 갈라지면
    나중에 어느 쪽이 진짜인지 판단할 수 없다.
    """
    with db_session.session_scope() as s:
        auth_service.register(s, name="가", email="  MiXeD@Example.COM ", password=PASSWORD)
    with db_session.session_scope() as s:
        user = auth_service.authenticate(s, email="mixed@example.com", password=PASSWORD)
        assert user.email == "mixed@example.com"


def test_duplicate_email_is_refused(engine):
    with db_session.session_scope() as s:
        auth_service.register(s, name="가", email="dup@example.com", password=PASSWORD)
    with db_session.session_scope() as s, pytest.raises(auth_service.EmailTaken):
        auth_service.register(s, name="나", email="DUP@example.com", password=PASSWORD)


def test_wrong_password_and_unknown_email_say_the_same_thing(engine, team: dict):
    """가입 여부가 새어 나가면 안 된다. 이메일 목록도 개인정보다."""
    with db_session.session_scope() as s:
        with pytest.raises(auth_service.AuthError) as wrong:
            auth_service.authenticate(s, email="minsu@example.com", password="틀림")
        with pytest.raises(auth_service.AuthError) as missing:
            auth_service.authenticate(s, email="nobody@example.com", password="틀림")
    assert str(wrong.value) == str(missing.value)


def test_user_without_a_password_cannot_authenticate(engine, team: dict):
    """`password_hash` 가 NULL 인 기존 사용자."""
    with db_session.session_scope() as s, pytest.raises(auth_service.AuthError):
        auth_service.authenticate(s, email="haneul@example.com", password=PASSWORD)


# ══════════════════════════════════════════════════════════════
# HTTP
# ══════════════════════════════════════════════════════════════


def test_signup_login_me_logout(client: TestClient, engine):
    created = client.post(
        "/api/auth/signup",
        json={"name": "새사람", "email": "new@example.com", "password": PASSWORD},
    )
    assert created.status_code == 201, created.text
    assert client.get("/api/auth/me").json()["email"] == "new@example.com"

    assert client.post("/api/auth/logout").status_code == 200
    assert client.get("/api/auth/me").status_code == 401

    again = client.post(
        "/api/auth/login", json={"email": "new@example.com", "password": PASSWORD}
    )
    assert again.status_code == 200
    assert client.get("/api/auth/me").json()["name"] == "새사람"


def test_session_cookie_is_httponly(client: TestClient, engine):
    response = client.post(
        "/api/auth/signup",
        json={"name": "가", "email": "cookie@example.com", "password": PASSWORD},
    )
    header = response.headers["set-cookie"].lower()
    # 스크립트가 토큰을 읽을 수 있으면 XSS 하나로 계정이 통째로 넘어간다.
    assert "httponly" in header
    # 다른 사이트에서 온 POST 에 쿠키가 실리면 CSRF 가 열린다.
    assert "samesite=lax" in header


def test_session_cookie_gets_secure_behind_a_tls_terminating_proxy(
    client: TestClient, engine
):
    """⭐ 이 프로젝트의 배포(Cloudflare Tunnel)에서 `Secure` 가 붙어야 한다.

    예전에는 `settings.is_production` 하나만 봤는데, **그 "운영" 을
    만드는 방법이 저장소에 없었다** — `.env.example` 은
    `ENVIRONMENT=development` 고정이고 docker-compose 도 안 덮어쓴다.
    즉 이 코드가 실제로 뜨는 모든 경우에 14일짜리 세션 토큰이 평문으로
    나갈 수 있었다. `httponly` 로 XSS 를 막아 둔 그 토큰인데 전송 구간만
    벗겨져 있었다.

    터널 뒤에서는 앱이 보는 스킴이 http 다. 진짜 스킴은
    `X-Forwarded-Proto` 에 있다.
    """
    response = client.post(
        "/api/auth/signup",
        json={"name": "가", "email": "tls@example.com", "password": PASSWORD},
        headers={"X-Forwarded-Proto": "https"},
    )
    assert "secure" in response.headers["set-cookie"].lower()


def test_session_cookie_has_no_secure_on_plain_localhost(client: TestClient, engine):
    """개발에서 붙이면 http 라 브라우저가 쿠키를 아예 저장하지 않는다.

    그러면 로그인이 안 되고, 사람은 비밀번호를 의심한다.
    """
    response = client.post(
        "/api/auth/signup",
        json={"name": "나", "email": "plain@example.com", "password": PASSWORD},
    )
    assert "secure" not in response.headers["set-cookie"].lower()


@pytest.mark.parametrize(
    ("is_production", "scheme", "forwarded", "expected"),
    [
        (True, "http", None, True),  # 설정이 운영이면 무조건
        (False, "https", None, True),  # 앱이 직접 TLS 를 받는 경우
        (False, "http", "https", True),  # 터널·리버스 프록시 뒤
        (False, "http", "https, http", True),  # 프록시가 여럿
        (False, "http", "http", False),  # 진짜 평문
        (False, "http", None, False),  # localhost 개발
    ],
)
def test_secure_flag_rule(
    is_production: bool, scheme: str, forwarded: str | None, expected: bool
):
    from teamflow.api.main import should_mark_cookie_secure

    assert (
        should_mark_cookie_secure(
            is_production=is_production, scheme=scheme, forwarded_proto=forwarded
        )
        is expected
    )


def test_logout_kills_the_token_on_the_server(client: TestClient, engine):
    """⭐ 쿠키만 지우면 토큰은 살아 있다.

    그 토큰이 어딘가에 복사돼 있으면 사용자는 로그아웃한 줄 알고 있는 동안
    남이 그 계정으로 들어온다.
    """
    client.post(
        "/api/auth/signup",
        json={"name": "가", "email": "revoke@example.com", "password": PASSWORD},
    )
    token = client.cookies.get(auth_service.COOKIE_NAME)
    client.post("/api/auth/logout")

    # 쿠키를 손으로 되돌려 놔도 통하지 않아야 한다.
    client.cookies.set(auth_service.COOKIE_NAME, token)
    assert client.get("/api/auth/me").status_code == 401


def test_bad_login_is_401(client: TestClient, team: dict):
    response = client.post(
        "/api/auth/login", json={"email": "minsu@example.com", "password": "틀림"}
    )
    assert response.status_code == 401


def test_weak_password_at_signup_is_400_with_a_reason(client: TestClient, engine):
    response = client.post(
        "/api/auth/signup",
        json={"name": "가", "email": "weak@example.com", "password": "1234"},
    )
    assert response.status_code == 400
    assert "8자" in response.json()["detail"]


def test_duplicate_signup_is_409(client: TestClient, engine):
    body = {"name": "가", "email": "dup2@example.com", "password": PASSWORD}
    assert client.post("/api/auth/signup", json=body).status_code == 201
    assert client.post("/api/auth/signup", json=body).status_code == 409


# ══════════════════════════════════════════════════════════════
# 보호되는가 — 이 파일의 본론
# ══════════════════════════════════════════════════════════════

# ⭐ **로그인 없이 열려 있어도 되는 것들.** 여기 없는 `/api/*` 는 전부
# 401 이어야 하고, 아래 테스트가 앱의 라우트를 훑어서 확인합니다.
#
# 예전에는 보호 대상을 **손으로 나열**했습니다. 그때 13개를 적어 뒀는데
# 실제 보호 대상은 25개였습니다 — 12개가 한 번도 검사된 적이 없었습니다.
# 목록을 손으로 관리하면 새 엔드포인트가 조용히 빠집니다. 그래서 방향을
# 뒤집었습니다: **열린 것만 적고, 나머지는 전부 닫혀 있어야 한다.**
PUBLIC: set[tuple[str, str]] = {
    # 시각 동기화는 로그인 전에도 돌아야 하고, 개인정보가 없습니다.
    ("GET", "/api/time"),
    ("GET", "/health"),
    # 로그인·가입은 당연히 열려 있어야 합니다.
    ("POST", "/api/auth/login"),
    ("POST", "/api/auth/signup"),
    # 로그아웃은 세션이 없으면 할 일이 없습니다. 401 로 막으면
    # 만료된 쿠키를 든 사람이 로그아웃도 못 합니다.
    ("POST", "/api/auth/logout"),
    # 웹훅은 **세션이 아니라 HMAC 서명**으로 인증합니다. GitHub 은
    # 우리 쿠키를 갖고 있지 않습니다.
    ("POST", "/api/github/webhook"),
    # 화면이 터졌다는 보고. **로그인 화면에서 터진 것이 가장 알고 싶은
    # 것인데**, 인증을 걸면 그건 영영 안 들어옵니다. 개인정보는 없습니다 —
    # 오류 메시지·스택·`?…` 를 뗀 경로뿐이고(`lib/diag/report.ts`), 길이와
    # 빈도에 상한이 있어 로그를 채우는 데도 쓸 수 없습니다.
    ("POST", "/api/client-errors"),
}

#: 경로 파라미터에 넣을 값. 실제로 존재하는 id 를 넣어야 "없어서 404"
#: 와 "인증이 없어서 401" 을 구분할 수 있습니다.
def _fill(path: str, team: dict) -> str:
    return (
        path.replace("{meeting_id}", str(team["meeting_id"]))
        .replace("{project_id}", str(team["project_id"]))
        .replace("{track_id}", "1")
        .replace("{task_id}", "1")
        .replace("{seq}", "0")
    )


def _api_routes() -> list[tuple[str, str]]:
    from teamflow.api.main import app

    routes: list[tuple[str, str]] = []
    for route in app.routes:
        path = getattr(route, "path", "")
        if not path.startswith("/api") and path != "/health":
            continue
        for method in sorted(getattr(route, "methods", None) or []):
            if method in {"HEAD", "OPTIONS"}:
                continue
            routes.append((method, path))
    return sorted(set(routes))


def test_the_route_list_is_not_empty():
    """경로가 0개면 아래 테스트가 조용히 통과합니다."""
    assert len(_api_routes()) > 20


@pytest.mark.parametrize(("method", "path"), _api_routes())
def test_every_endpoint_is_either_public_on_purpose_or_refuses_anonymous(
    client: TestClient, team: dict, method: str, path: str
):
    """⭐ 앱의 **모든** 경로를 훑는다. 하나라도 빠지면 그리로 전부 새어 나간다.

    엔드포인트를 새로 추가할 때 인증을 빠뜨리는 것이 가장 흔한 사고인데,
    개별 테스트로 흩어 두면 새 엔드포인트에는 아무도 테스트를 안 붙인다.
    목록을 손으로 관리하는 것도 같은 문제였다 — 13개를 적어 두는 동안
    실제 보호 대상은 25개였다.

    새 엔드포인트를 열어 두려면 `PUBLIC` 에 **이유와 함께** 적어야 한다.
    """
    if (method, path) in PUBLIC:
        return

    url = _fill(path, team)
    response = client.request(method, url, json={} if method != "GET" else None)

    assert response.status_code == 401, (
        f"{method} {url} 가 로그인 없이 {response.status_code} 를 돌려줍니다. "
        "일부러 연 것이라면 PUBLIC 에 이유와 함께 적으세요."
    )


def test_public_entries_all_point_at_real_routes():
    """⭐ `PUBLIC` 에 오타가 있으면 그 경로가 **조용히 검사에서 빠진다.**

    경로 이름이 바뀌었을 때도 마찬가지다 — 옛 이름이 남아 있으면
    새 경로는 아무도 안 본다.
    """
    stale = sorted(PUBLIC - set(_api_routes()))
    assert not stale, f"PUBLIC 에 실재하지 않는 경로가 있습니다: {stale}"


def test_time_and_health_stay_open(client: TestClient):
    """시각 동기화는 인증 전에도 돌아야 한다 — 그리고 개인정보가 없다."""
    assert client.get("/api/time").status_code == 200
    assert client.get("/health").status_code == 200


# ══════════════════════════════════════════════════════════════
# 사칭이 막히는가
# ══════════════════════════════════════════════════════════════


def test_consent_is_recorded_for_the_session_user_not_the_body(
    client: TestClient, team: dict
):
    """⭐ 동의는 본인만 할 수 있다.

    남의 번호를 적어 동의를 대신 제출할 수 있으면 이 게이트는 법적
    방어선이 아니라 장식이다 (통신비밀보호법 L1 · 개인정보보호법 P1).
    """
    login_as(client, team["members"][0])
    response = client.post(
        f"/api/meetings/{team['meeting_id']}/consent",
        # 사칭 시도 — 이하늘 대신 동의해 주려는 요청
        json={"user_id": team["members"][1], "consent_type": "recording", "consented": True},
    )
    assert response.status_code == 200, response.text

    with db_session.session_scope() as s:
        rows = s.scalars(select(m.RecordingConsent)).all()
        assert [r.user_id for r in rows] == [team["members"][0]]


def test_track_owner_comes_from_the_session(client: TestClient, team: dict):
    """⭐ 트랙 = 사람이 화자 라벨의 근거다.

    남의 트랙을 만들 수 있으면 "이 목소리는 이 사람" 이라는 전제가 무너지고
    그 위에 쌓인 발언량·기여도가 전부 근거를 잃는다.
    """
    for user_id in team["members"]:
        login_as(client, user_id)
        client.post(
            f"/api/meetings/{team['meeting_id']}/consent",
            json={"consent_type": "recording", "consented": True},
        )

    login_as(client, team["members"][0])
    body = client.post(
        f"/api/meetings/{team['meeting_id']}/tracks",
        json={"user_id": team["members"][1], "started_at": NOW.isoformat()},
    ).json()

    assert body["user_id"] == team["members"][0]


def test_cannot_upload_into_someone_elses_track(client: TestClient, team: dict):
    """⭐ 남의 트랙에 목소리를 올릴 수 있으면 기여도는 조작 가능하다."""
    for user_id in team["members"]:
        login_as(client, user_id)
        client.post(
            f"/api/meetings/{team['meeting_id']}/consent",
            json={"consent_type": "recording", "consented": True},
        )

    login_as(client, team["members"][1])
    victim_track = client.post(
        f"/api/meetings/{team['meeting_id']}/tracks",
        json={"started_at": NOW.isoformat()},
    ).json()["track_id"]

    login_as(client, team["members"][0])
    response = client.put(
        f"/api/meetings/{team['meeting_id']}/tracks/{victim_track}/chunks/0",
        content=b"not-my-voice" * 20,
        headers={"X-Client-At-Ms": str(int(NOW.timestamp() * 1000))},
    )
    # 404 다 — "남의 트랙" 이라고 알려 주면 id 를 훑어 참가자를 알아낼 수 있다.
    assert response.status_code == 404


def test_cannot_finish_someone_elses_track(client: TestClient, team: dict):
    for user_id in team["members"]:
        login_as(client, user_id)
        client.post(
            f"/api/meetings/{team['meeting_id']}/consent",
            json={"consent_type": "recording", "consented": True},
        )

    login_as(client, team["members"][1])
    victim_track = client.post(
        f"/api/meetings/{team['meeting_id']}/tracks",
        json={"started_at": NOW.isoformat()},
    ).json()["track_id"]

    login_as(client, team["members"][0])
    response = client.post(
        f"/api/meetings/{team['meeting_id']}/tracks/{victim_track}/complete",
        json={
            "ended_at": (NOW + timedelta(minutes=1)).isoformat(),
            "coverage": 0.0,
            "total_gap_ms": 60_000,
        },
    )
    assert response.status_code == 404


def test_outsider_cannot_read_a_meeting(client: TestClient, team: dict):
    """⭐ 로그인만 확인하면 가입만 하고 남의 팀 회의록을 읽을 수 있다."""
    login_as(client, team["outsider"])
    for path in (
        f"/api/meetings/{team['meeting_id']}",
        f"/api/meetings/{team['meeting_id']}/consent",
        f"/api/meetings/{team['meeting_id']}/candidates",
        f"/api/meetings/{team['meeting_id']}/tracks",
        f"/api/meetings/{team['meeting_id']}/members",
    ):
        assert client.get(path).status_code == 403, path


def test_outsider_cannot_see_contributions(client: TestClient, team: dict):
    """기여도는 성적에 반영될 수 있는 값이다."""
    login_as(client, team["outsider"])
    response = client.get(f"/api/projects/{team['project_id']}/contributions")
    assert response.status_code == 403


def test_project_creator_is_always_a_member(client: TestClient, team: dict):
    """⭐ 빠뜨리면 자기가 만든 프로젝트를 자기가 못 본다.

    모든 조회가 구성원 확인을 지나기 때문이다.
    """
    login_as(client, team["outsider"])
    created = client.post("/api/projects", json={"title": "내 프로젝트"})
    assert created.status_code == 201, created.text
    assert created.json()["member_ids"] == [team["outsider"]]

    project_id = created.json()["project_id"]
    assert client.get(f"/api/projects/{project_id}/contributions").status_code == 200


def test_nobody_can_be_put_into_a_project_by_someone_else(
    client: TestClient, team: dict
):
    """⭐ 남을 내 팀에 넣을 수 없다 — `Member` 행이 곧 권한이다.

    예전에는 `member_ids` 를 요청 본문으로 받아 그대로 믿었다. 그러면
    가입만 한 사람이 남을 자기 프로젝트에 넣고, 그 프로젝트의 회의를
    열고, `GET /api/meetings/{id}/members` 로 **그 사람의 실명**을 받아
    갈 수 있었다. 팀원은 초대 코드로 스스로 들어와야 한다.
    """
    victim = team["members"][0]
    login_as(client, team["outsider"])

    created = client.post(
        "/api/projects", json={"title": "가로채기", "member_ids": [victim]}
    )
    # 필드를 무시하든 거절하든 상관없다. **피해자가 안 들어가는 것**이
    # 지켜야 할 것이다.
    assert created.status_code in (201, 422), created.text
    if created.status_code == 201:
        assert victim not in created.json()["member_ids"]

        # 실제로 못 보는지까지 확인한다. 응답 모양만 보면, 넣어 놓고
        # 응답에서만 빼는 구현도 통과해 버린다.
        project_id = created.json()["project_id"]
        meeting = client.post(
            f"/api/projects/{project_id}/meetings", json={"title": "x"}
        )
        assert meeting.status_code == 201, meeting.text
        members = client.get(f"/api/meetings/{meeting.json()['meeting_id']}/members")
        assert members.status_code == 200
        assert [row["user_id"] for row in members.json()] == [team["outsider"]]


def test_creating_a_project_does_not_reveal_who_is_signed_up(
    client: TestClient, team: dict
):
    """⭐ 가입자 명단이 새지 않는다.

    예전에는 없는 id 만 골라 `없는 사용자입니다: [4, 5, …]` 로 답했다.
    **목록에서 빠진 것이 곧 "존재하는 사용자"** 였으므로, 1..N 을 넣어
    보면 전체 가입자 id 를 얻을 수 있었다. 로그인 화면이 일부러 감춘
    것을 여기서 열어 주는 셈이었다.
    """
    login_as(client, team["outsider"])
    response = client.post(
        "/api/projects",
        json={"title": "탐색", "member_ids": [1, 2, 3, 4, 5, 99_999]},
    )
    body = response.text
    assert "없는 사용자" not in body
    # 존재하는 id 든 아니든, 응답이 그 둘을 구분해 주지 않아야 한다.
    for probe in ("99999", "99_999"):
        assert probe not in body
