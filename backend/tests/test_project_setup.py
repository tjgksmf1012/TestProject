"""프로젝트 만들기·참가·설정.

이 파일이 고정하는 것: **가입한 사람이 실제로 팀을 만들고 팀원을 넣을 수
있는가.**

`POST /api/projects` 는 처음부터 있었지만 `member_ids: list[int]` 를
받았습니다. **화면에서는 그걸 채울 수가 없습니다** — 사용자는 남의
user_id 를 모릅니다. 그래서 가입한 첫 사용자는 아무것도 할 수 없었고,
"팀원이 넣어 주기를 기다리세요" 로 끝나는데 그 팀원도 같은 처지였습니다.

이메일 초대를 안 쓴 이유는 `teamflow/projects/invites.py` 모듈 주석에
있습니다 — 요약하면 **가입 여부를 노출하거나(로그인 화면에서 일부러 감춘
것) 발송 인프라가 필요해서**(비용 0원 제약)입니다.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.pool import StaticPool

from teamflow.config import Settings, get_settings
from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.projects import invites

from .conftest import login_as

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
def people(engine) -> dict:
    with db_session.session_scope() as s:
        founder = m.User(name="김민수", email="minsu@example.com")
        joiner = m.User(name="이하늘", email="haneul@example.com")
        stranger = m.User(name="외부인", email="out@example.com")
        s.add_all([founder, joiner, stranger])
        s.flush()
        return {"founder": founder.id, "joiner": joiner.id, "stranger": stranger.id}


def create_project(client: TestClient, title: str = "졸업작품") -> dict:
    response = client.post("/api/projects", json={"title": title})
    assert response.status_code == 201, response.text
    return response.json()


# ══════════════════════════════════════════════════════════════
# 초대 코드 — 순수 함수
# ══════════════════════════════════════════════════════════════


def test_generated_codes_avoid_confusable_characters():
    """⭐ `0/O`·`1/I/L` 을 빼지 않으면 카톡으로 받아 적을 때 반드시 틀린다.

    그리고 틀렸을 때 "코드가 없습니다" 만 나오면 사람은 상대를 의심한다.
    """
    banned = set("01OILU")
    for _ in range(200):
        assert not (set(invites.generate_code()) & banned)


def test_generated_codes_are_the_right_length_and_alphabet():
    for _ in range(50):
        code = invites.generate_code()
        assert len(code) == invites.CODE_LENGTH
        assert all(ch in invites.ALPHABET for ch in code)


def test_codes_do_not_repeat():
    codes = {invites.generate_code() for _ in range(500)}
    assert len(codes) == 500


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("ABCD-EFGH", "ABCDEFGH"),
        ("  abcd efgh  ", "ABCDEFGH"),
        ("abcdefgh", "ABCDEFGH"),
        ("ABCD_EFGH", "ABCDEFGH"),
        (None, ""),
        ("", ""),
    ],
)
def test_normalize_accepts_what_people_actually_type(raw, expected):
    """⭐ 화면에 하이픈을 보여주면 사람은 하이픈을 친다.

    그걸 "틀린 코드" 로 처리하면 **맞는 코드를 들고도 못 들어온다.**
    카톡에서 복사하면 앞뒤 공백도 붙는다.
    """
    assert invites.normalize_code(raw) == expected


def test_format_breaks_the_code_in_two():
    """여덟 글자를 한 번에 읽으면 틀린다."""
    assert invites.format_code("ABCDEFGH") == "ABCD-EFGH"


def test_format_leaves_broken_values_alone():
    """망가진 값을 그럴듯하게 꾸미지 않는다 — 그러면 원인을 못 본다."""
    assert invites.format_code("ABC") == "ABC"


@pytest.mark.parametrize(
    ("raw", "ok"),
    [
        ("ABCDEFGH", True),
        ("abcd-efgh", True),
        ("ABCDEFG", False),  # 짧다
        ("ABCDEFGHI", False),  # 길다
        ("ABCDEFG0", False),  # 알파벳 밖
        ("ABCDEFGI", False),
        ("", False),
        (None, False),
    ],
)
def test_looks_like_code(raw, ok):
    assert invites.looks_like_code(raw) is ok


# ══════════════════════════════════════════════════════════════
# 만들기
# ══════════════════════════════════════════════════════════════


def test_creating_a_project_needs_only_a_title(client: TestClient, people: dict):
    """⭐ `member_ids` 없이 만들 수 있어야 화면에서 부를 수 있다."""
    login_as(client, people["founder"])
    body = create_project(client)

    assert body["member_ids"] == [people["founder"]]
    assert invites.looks_like_code(body["invite_code"])


def test_the_founder_is_always_a_member(client: TestClient, people: dict):
    """빠뜨리면 자기가 만든 프로젝트를 자기가 못 본다 — 조회가 전부 구성원 확인을 지난다."""
    login_as(client, people["founder"])
    project_id = create_project(client)["project_id"]

    assert client.get(f"/api/projects/{project_id}").status_code == 200
    assert [p["project_id"] for p in client.get("/api/projects").json()] == [project_id]


def test_every_project_gets_a_different_code(client: TestClient, people: dict):
    login_as(client, people["founder"])
    codes = {create_project(client, f"p{i}")["invite_code"] for i in range(5)}
    assert len(codes) == 5


def test_anonymous_cannot_create_a_project(client: TestClient, people: dict):
    client.cookies.clear()
    assert client.post("/api/projects", json={"title": "몰래"}).status_code == 401


# ══════════════════════════════════════════════════════════════
# 참가
# ══════════════════════════════════════════════════════════════


def test_joining_with_a_code(client: TestClient, people: dict):
    login_as(client, people["founder"])
    created = create_project(client)

    login_as(client, people["joiner"])
    response = client.post(
        "/api/projects/join", json={"invite_code": created["invite_code"]}
    )

    assert response.status_code == 200, response.text
    assert response.json()["project_id"] == created["project_id"]
    assert response.json()["already_member"] is False
    # 이제 목록에 보인다 — 목록이 곧 권한 경계다.
    assert [p["project_id"] for p in client.get("/api/projects").json()] == [
        created["project_id"]
    ]


def test_the_code_works_the_way_people_type_it(client: TestClient, people: dict):
    """⭐ 화면이 `ABCD-EFGH` 로 보여주므로 사람은 하이픈을 친다."""
    login_as(client, people["founder"])
    created = create_project(client)
    pretty = invites.format_code(created["invite_code"])

    login_as(client, people["joiner"])
    assert (
        client.post("/api/projects/join", json={"invite_code": f"  {pretty.lower()} "})
        .status_code
        == 200
    )


def test_joining_twice_is_not_an_error(client: TestClient, people: dict):
    """두 번 눌러도 오류가 아니다 — 이미 팀원인 게 원하던 결과다."""
    login_as(client, people["founder"])
    code = create_project(client)["invite_code"]

    login_as(client, people["joiner"])
    client.post("/api/projects/join", json={"invite_code": code})
    second = client.post("/api/projects/join", json={"invite_code": code})

    assert second.status_code == 200
    assert second.json()["already_member"] is True

    with db_session.session_scope() as s:
        rows = s.scalars(
            select(m.Member).where(m.Member.user_id == people["joiner"])
        ).all()
        assert len(rows) == 1


def test_a_malformed_code_says_so(client: TestClient, people: dict):
    """⭐ 오타와 "없는 코드" 를 다르게 답한다.

    사람이 고쳐야 할 것이 다르다 — 앞은 자기가 잘못 친 것이고, 뒤는
    상대에게 다시 물어야 한다. 둘 다 "코드가 없습니다" 로 답하면 사람은
    상대를 의심한다.
    """
    login_as(client, people["joiner"])
    response = client.post("/api/projects/join", json={"invite_code": "ABC"})

    assert response.status_code == 400
    assert "형식" in response.json()["detail"]


def test_an_unknown_code_is_404(client: TestClient, people: dict):
    login_as(client, people["joiner"])
    response = client.post("/api/projects/join", json={"invite_code": "ABCDEFGH"})
    assert response.status_code == 404


def test_a_project_without_a_code_cannot_be_joined(client: TestClient, people: dict):
    """⭐ 이 컬럼이 생기기 전 프로젝트는 코드가 NULL 이다.

    빈 코드를 "아무나 통과" 로 읽으면 그 프로젝트 전부가 열린다.
    """
    with db_session.session_scope() as s:
        legacy = m.Project(title="옛 프로젝트", started_at=NOW)
        s.add(legacy)
        s.flush()

    login_as(client, people["stranger"])
    for attempt in ("", "        "):
        response = client.post("/api/projects/join", json={"invite_code": attempt or " "})
        assert response.status_code in (400, 422), attempt


def test_anonymous_cannot_join(client: TestClient, people: dict):
    login_as(client, people["founder"])
    code = create_project(client)["invite_code"]

    client.cookies.clear()
    assert (
        client.post("/api/projects/join", json={"invite_code": code}).status_code == 401
    )


# ══════════════════════════════════════════════════════════════
# 코드 회전
# ══════════════════════════════════════════════════════════════


def test_rotating_invalidates_the_old_code(client: TestClient, people: dict):
    """⭐ 코드는 메신저로 돌아다니므로 샌다.

    회수할 방법이 없으면 한 번 새면 그 프로젝트는 영영 열려 있다.
    """
    login_as(client, people["founder"])
    created = create_project(client)
    old_code = created["invite_code"]

    rotated = client.post(f"/api/projects/{created['project_id']}/invite/rotate")
    assert rotated.status_code == 200
    new_code = invites.normalize_code(rotated.json()["invite_code"])
    assert new_code != old_code

    login_as(client, people["stranger"])
    assert client.post("/api/projects/join", json={"invite_code": old_code}).status_code == 404
    assert client.post("/api/projects/join", json={"invite_code": new_code}).status_code == 200


def test_only_members_can_see_or_rotate_the_code(client: TestClient, people: dict):
    """초대 코드는 구성원에게만. 아니면 코드가 곧 무의미해진다."""
    login_as(client, people["founder"])
    project_id = create_project(client)["project_id"]

    login_as(client, people["stranger"])
    assert client.get(f"/api/projects/{project_id}").status_code == 403
    assert client.post(f"/api/projects/{project_id}/invite/rotate").status_code == 403


def test_the_detail_screen_shows_the_code_broken_in_two(client: TestClient, people: dict):
    login_as(client, people["founder"])
    project_id = create_project(client)["project_id"]

    body = client.get(f"/api/projects/{project_id}").json()
    assert body["invite_code"][4] == "-"
    assert body["member_count"] == 1


# ══════════════════════════════════════════════════════════════
# GitHub 연결
# ══════════════════════════════════════════════════════════════


def test_connecting_a_repository(client: TestClient, people: dict):
    login_as(client, people["founder"])
    project_id = create_project(client)["project_id"]

    body = client.patch(
        f"/api/projects/{project_id}", json={"github_repo": "team/teamflow"}
    ).json()

    assert body["github_repo"] == "team/teamflow"
    with db_session.session_scope() as s:
        assert s.get(m.Project, project_id).github_connected_at is not None


def test_a_repository_url_is_refused(client: TestClient, people: dict):
    """⭐ 웹훅은 `repository.full_name` 으로 프로젝트를 찾는다.

    주소 전체를 넣으면 **웹훅이 영원히 이 프로젝트를 못 찾습니다** —
    오류도 안 나고 기여도만 이유 없이 빕니다.
    """
    login_as(client, people["founder"])
    project_id = create_project(client)["project_id"]

    response = client.patch(
        f"/api/projects/{project_id}",
        json={"github_repo": "https://github.com/team/teamflow"},
    )
    assert response.status_code == 400
    assert "owner/repo" in response.json()["detail"]


def test_two_projects_cannot_claim_the_same_repository(client: TestClient, people: dict):
    """⭐ 웹훅은 저장소로 프로젝트를 찾는다.

    둘이 같은 저장소를 가리키면 한쪽만 이벤트를 받고 다른 쪽은 이유 없이 빈다.
    """
    login_as(client, people["founder"])
    first = create_project(client, "A")["project_id"]
    second = create_project(client, "B")["project_id"]

    client.patch(f"/api/projects/{first}", json={"github_repo": "team/teamflow"})
    response = client.patch(f"/api/projects/{second}", json={"github_repo": "team/teamflow"})

    assert response.status_code == 409


def test_creating_a_project_checks_the_repository_the_same_way(
    client: TestClient, people: dict
):
    """⚠️ 검사가 **PATCH 에만** 있었다. 만들 때는 그냥 통과했다.

    위 두 테스트(`_a_repository_url_is_refused`, `_two_projects_cannot_claim_`)가
    전부 PATCH 를 지나가는 동안, `POST /api/projects` 는 같은 값을 검사 없이
    저장했습니다. 화면이 마침 만들 때 저장소를 안 보내서 아무도 몰랐습니다 —
    API 는 화면보다 오래 삽니다.

    주소를 넣으면 웹훅이 영원히 그 프로젝트를 못 찾고, 오류도 안 납니다.
    """
    login_as(client, people["founder"])

    response = client.post(
        "/api/projects", json={"title": "주소", "github_repo": "https://github.com/team/x"}
    )
    assert response.status_code == 400
    assert "owner/repo" in response.json()["detail"]


def test_creating_a_project_cannot_steal_a_claimed_repository(
    client: TestClient, people: dict
):
    """같은 저장소를 만들기로 두 번 잡으면 409 다 — 500 이 아니라.

    유니크 제약이 최종 방어이긴 했지만, 만들기 경로에는 그 앞에 아무 검사도
    없어서 **처리되지 않은 IntegrityError** 가 났습니다. 사용자에게는
    "서버 오류" 로 보이고, 무엇을 고쳐야 하는지 알 수 없습니다.
    """
    login_as(client, people["founder"])
    first = create_project(client, "A")["project_id"]
    client.patch(f"/api/projects/{first}", json={"github_repo": "team/teamflow"})

    response = client.post(
        "/api/projects", json={"title": "B", "github_repo": "Team/TeamFlow"}
    )
    assert response.status_code == 409, response.text


def test_clearing_the_repository_disconnects(client: TestClient, people: dict):
    login_as(client, people["founder"])
    project_id = create_project(client)["project_id"]
    client.patch(f"/api/projects/{project_id}", json={"github_repo": "team/teamflow"})

    body = client.patch(f"/api/projects/{project_id}", json={"github_repo": ""}).json()
    assert body["github_repo"] is None
    with db_session.session_scope() as s:
        assert s.get(m.Project, project_id).github_connected_at is None


def test_nobody_can_write_the_installation_id_through_the_api(
    client: TestClient, people: dict
):
    """⭐ **이 자리에 있던 테스트가 결함을 고정하고 있었습니다.**

    예전 테스트는 `{"github_installation_id": 12345}` 를 보내고 응답에 그
    숫자가 안 나오는지만 봤습니다. 나가는 길은 막혀 있었지만 **들어오는 길이
    열려 있었고**, 테스트는 그걸 정상으로 못 박고 있었습니다.

    설치 id 는 워커가 `build_client()` 로 **그 설치의 액세스 토큰을 발급**할
    때 씁니다. 아무 숫자나 써 넣을 수 있다는 것은, 이 팀과 아무 상관 없는
    설치의 권한으로 GitHub API 를 부르게 만들 수 있다는 뜻입니다.
    요청 본문의 id 를 권한에 그대로 쓰던 `member_ids` 결함과 같은 부류입니다.

    이제 이 필드는 스키마에 아예 없고, 보내면 422 로 거절합니다. 조용히
    무시하면 보낸 쪽은 저장된 줄 압니다.
    """
    login_as(client, people["founder"])
    project_id = create_project(client)["project_id"]

    response = client.patch(
        f"/api/projects/{project_id}", json={"github_installation_id": 12345}
    )

    assert response.status_code == 422
    with db_session.session_scope() as s:
        assert s.get(m.Project, project_id).github_installation_id is None


def test_the_installation_id_is_never_sent_back(client: TestClient, people: dict):
    """화면이 쓸 일이 없습니다 — 연결 여부만 알면 됩니다."""
    login_as(client, people["founder"])
    project_id = create_project(client)["project_id"]

    with db_session.session_scope() as s:
        s.get(m.Project, project_id).github_installation_id = 12345

    body = client.get(f"/api/projects/{project_id}").json()

    assert "github_installation_id" not in body
    assert "12345" not in str(body)


def test_connected_means_a_signed_delivery_arrived_not_that_a_name_was_typed(
    client: TestClient, people: dict
):
    """⭐ "연결됨" 의 뜻이 바뀝니다.

    예전에는 설치 id 가 있으면 참이었고, 그 id 는 화면에서 아무 숫자나
    보내면 채워졌습니다. 즉 **아무것도 확인하지 않고** "연결됨" 을 보여
    주고 있었습니다.
    """
    login_as(client, people["founder"])
    project_id = create_project(client)["project_id"]

    body = client.patch(
        f"/api/projects/{project_id}", json={"github_repo": "team/teamflow"}
    ).json()
    assert body["github_connected"] is False

    with db_session.session_scope() as s:
        s.get(m.Project, project_id).github_verified_at = NOW

    assert client.get(f"/api/projects/{project_id}").json()["github_connected"] is True


def test_changing_the_repository_throws_away_the_old_proof(
    client: TestClient, people: dict
):
    """앞 저장소에서 배달이 왔다는 사실은 **새 저장소의 근거가 아닙니다.**"""
    login_as(client, people["founder"])
    project_id = create_project(client)["project_id"]
    client.patch(f"/api/projects/{project_id}", json={"github_repo": "team/teamflow"})

    with db_session.session_scope() as s:
        project = s.get(m.Project, project_id)
        project.github_verified_at = NOW
        project.github_installation_id = 555

    body = client.patch(
        f"/api/projects/{project_id}", json={"github_repo": "team/other"}
    ).json()

    assert body["github_connected"] is False
    with db_session.session_scope() as s:
        assert s.get(m.Project, project_id).github_installation_id is None


def test_fixing_only_the_letter_case_keeps_the_proof(client: TestClient, people: dict):
    """대소문자만 고친 것은 **저장소를 바꾼 게 아닙니다.**

    이걸 바뀐 것으로 보면, 표기를 정리한 순간 연결이 끊긴 것처럼 보이고
    신뢰도가 근거 없이 떨어집니다.
    """
    login_as(client, people["founder"])
    project_id = create_project(client)["project_id"]
    client.patch(f"/api/projects/{project_id}", json={"github_repo": "team/teamflow"})

    with db_session.session_scope() as s:
        s.get(m.Project, project_id).github_verified_at = NOW

    body = client.patch(
        f"/api/projects/{project_id}", json={"github_repo": "Team/TeamFlow"}
    ).json()

    assert body["github_connected"] is True


def test_the_lookup_key_cannot_drift_from_the_repository(
    client: TestClient, people: dict
):
    """⭐ 둘이 어긋나면 웹훅이 조용히 사라집니다.

    저장소를 바꾸는 자리마다 손으로 둘을 같이 쓰게 하면 언젠가 빠뜨립니다.
    모델이 묶어 두고 있는지 확인합니다.
    """
    login_as(client, people["founder"])
    project_id = create_project(client)["project_id"]

    for typed in ("Team/TeamFlow", "team/teamflow", "  OTHER/Repo  ", ""):
        client.patch(f"/api/projects/{project_id}", json={"github_repo": typed})
        with db_session.session_scope() as s:
            project = s.get(m.Project, project_id)
            expected = typed.strip().lower() or None
            assert project.github_repo_key == expected
            assert project.github_repo == (typed.strip() or None)


def test_two_projects_cannot_claim_the_same_repo_in_different_case(
    client: TestClient, people: dict
):
    """⭐ 대소문자를 무시하고 찾게 된 순간 **이게 막히지 않으면** 배달이
    어느 프로젝트에 붙을지 정해지지 않습니다."""
    login_as(client, people["founder"])
    first = create_project(client, "A")["project_id"]
    second = create_project(client, "B")["project_id"]

    client.patch(f"/api/projects/{first}", json={"github_repo": "team/teamflow"})
    response = client.patch(
        f"/api/projects/{second}", json={"github_repo": "TEAM/TeamFlow"}
    )

    assert response.status_code == 409


def test_renaming_a_project(client: TestClient, people: dict):
    login_as(client, people["founder"])
    project_id = create_project(client)["project_id"]

    body = client.patch(f"/api/projects/{project_id}", json={"title": "새 이름"}).json()
    assert body["title"] == "새 이름"


def test_outsiders_cannot_change_anything(client: TestClient, people: dict):
    login_as(client, people["founder"])
    project_id = create_project(client)["project_id"]

    login_as(client, people["stranger"])
    patched = client.patch(f"/api/projects/{project_id}", json={"title": "가로채기"})
    assert patched.status_code == 403


# ══════════════════════════════════════════════════════════════
# 회의 열기 — 화면이 부르는 그대로
# ══════════════════════════════════════════════════════════════


def test_a_member_can_open_a_meeting(client: TestClient, people: dict):
    login_as(client, people["founder"])
    project_id = create_project(client)["project_id"]

    response = client.post(
        f"/api/projects/{project_id}/meetings", json={"title": "1주차"}
    )
    assert response.status_code == 201, response.text
    assert response.json()["status"] == "pending"

    # 그리고 곧바로 홈 목록에 보인다.
    meetings = client.get(f"/api/projects/{project_id}/meetings").json()
    assert [row["title"] for row in meetings] == ["1주차"]


def test_the_home_list_carries_coverage_so_it_does_not_ask_row_by_row(
    client: TestClient, engine, people: dict
):
    """⭐ 홈이 **줄마다 따로 묻지 않아도** 되게 목록이 커버리지를 싣는다.

    예전에는 회의 줄마다 `GET /api/meetings/{id}/tracks` 를 따로 불렀다.
    회의 다섯짜리 시연 데이터로 홈 한 번에 요청 7건이었고(브라우저로
    재서 확인), 회의 서른인 팀이면 33건이다.

    ⭐⭐ **못 잰 것은 `None` 이다. 0.0 이 아니다.** 이 제품의 불변식
    셋째(docs/05)이고, 0.0 으로 채우면 화면은 "녹음이 하나도 안 됐다" 를
    그린다 — 실제로는 아직 회의가 안 끝나서 **잰 적이 없는** 것인데.
    """
    from sqlalchemy.orm import Session

    login_as(client, people["founder"])
    project_id = create_project(client)["project_id"]
    opened = client.post(f"/api/projects/{project_id}/meetings", json={"title": "잰 회의"})
    measured_id = opened.json()["meeting_id"]
    未 = client.post(f"/api/projects/{project_id}/meetings", json={"title": "아직 안 잰 회의"})
    unmeasured_id = 未.json()["meeting_id"]

    with Session(engine) as session:
        # 잰 회의 — 트랙 둘(사람 둘), 커버리지 0.8 과 0.6 → 평균 0.7
        # ⚠️ 한 회의에 같은 사람의 트랙은 하나뿐입니다 (UNIQUE 제약).
        for who, value in ((people["founder"], 0.8), (people["joiner"], 0.6)):
            session.add(
                m.MeetingTrack(
                    meeting_id=measured_id,
                    user_id=who,
                    started_at=NOW,
                    status="completed",
                    coverage=value,
                )
            )
        # 아직 안 잰 회의 — 트랙은 있는데 커버리지가 NULL
        session.add(
            m.MeetingTrack(
                meeting_id=unmeasured_id,
                user_id=people["founder"],
                started_at=NOW,
                status="recording",
                coverage=None,
            )
        )
        session.commit()

    rows = {r["meeting_id"]: r for r in client.get(f"/api/projects/{project_id}/meetings").json()}
    assert rows[measured_id]["coverage"] == pytest.approx(0.7)
    assert rows[unmeasured_id]["coverage"] is None, "못 잰 것을 0 으로 채우면 안 됩니다"


def test_one_unfinished_track_does_not_drag_the_average_down(
    client: TestClient, engine, people: dict
):
    """⚠️ NULL 인 트랙을 0 으로 세어 평균에 넣으면 안 된다.

    회의가 끝나 가는데 한 명이 아직 안 끝냈다는 이유로 커버리지가 절반이
    되면, 화면은 "녹음이 반만 됐다" 를 그린다. 그건 측정이 아니라 착시다.
    """
    from sqlalchemy.orm import Session

    login_as(client, people["founder"])
    project_id = create_project(client)["project_id"]
    meeting_id = client.post(
        f"/api/projects/{project_id}/meetings", json={"title": "한 명이 아직"}
    ).json()["meeting_id"]

    with Session(engine) as session:
        session.add(
            m.MeetingTrack(
                meeting_id=meeting_id,
                user_id=people["founder"],
                started_at=NOW,
                status="completed",
                coverage=1.0,
            )
        )
        session.add(
            m.MeetingTrack(
                meeting_id=meeting_id,
                user_id=people["joiner"],
                started_at=NOW,
                status="recording",
                coverage=None,
            )
        )
        session.commit()

    rows = client.get(f"/api/projects/{project_id}/meetings").json()
    assert rows[0]["coverage"] == pytest.approx(1.0)


def test_the_whole_first_run_works(client: TestClient, people: dict):
    """⭐ 가입 → 프로젝트 → 초대 → 참가 → 회의까지 한 번에.

    이 경로가 막혀 있어서 가입한 첫 사용자가 아무것도 할 수 없었다.
    구간별로 200 을 확인하는 것과 **이어서 도는지**는 다르다.
    """
    client.cookies.clear()
    signup = client.post(
        "/api/auth/signup",
        json={"name": "새사람", "email": "new@example.com", "password": "graduation-2026"},
    )
    assert signup.status_code == 201

    assert client.get("/api/projects").json() == []

    created = create_project(client, "우리 팀플")
    project_id = created["project_id"]
    code = created["invite_code"]

    opened = client.post(f"/api/projects/{project_id}/meetings", json={"title": "킥오프"})
    assert opened.status_code == 201

    login_as(client, people["joiner"])
    assert client.post("/api/projects/join", json={"invite_code": code}).status_code == 200
    assert len(client.get(f"/api/projects/{project_id}/meetings").json()) == 1
    assert len(client.get(f"/api/projects/{project_id}/members").json()) == 2


# ══════════════════════════════════════════════════════════════
# 역할 — 이 값이 기여도 가중치를 정한다
# ══════════════════════════════════════════════════════════════


def test_everyone_starts_as_a_developer_and_can_change_it(
    client: TestClient, people: dict
):
    """⭐ 기획자·디자이너 프로파일이 **실사용 경로로 도달 불가**였다.

    가입도 초대도 `role_shares={"developer": 1.0}` 을 하드코딩했고 바꾸는
    API 가 없었습니다. 기획자 프로파일은 코드 0% · 문서 30% 인데 개발자로
    계산하면 코드 35% · 문서 5% 입니다 — 문서만 쓴 사람이 이유 없이 낮게
    나오고, **오류는 어디에도 안 납니다.**
    """
    login_as(client, people["founder"])
    project_id = create_project(client)["project_id"]

    before = client.get(f"/api/projects/{project_id}/members").json()
    assert before[0]["role_shares"] == {"developer": 1.0}, "기본값"

    response = client.patch(
        f"/api/projects/{project_id}/members/me",
        json={"role_shares": {"developer": 0.6, "planner": 0.4}},
    )
    assert response.status_code == 200, response.text
    assert response.json()["role_shares"] == {"developer": 0.6, "planner": 0.4}

    after = client.get(f"/api/projects/{project_id}/members").json()
    assert after[0]["role_shares"] == {"developer": 0.6, "planner": 0.4}


def test_the_new_role_actually_reaches_the_scoring(client: TestClient, people: dict):
    """⭐ 저장만 되고 산정이 안 읽으면 고친 게 아니다.

    기획자는 코드 가중치가 0 입니다. 역할을 바꾸면 같은 이벤트로도
    카테고리 가중치가 달라져야 합니다.
    """
    from teamflow.contribution.profiles import Role
    from teamflow.services import scoring_service

    login_as(client, people["founder"])
    project_id = create_project(client)["project_id"]

    with db_session.session_scope() as s:
        profiles = scoring_service.load_profiles(s, project_id)
        assert profiles[people["founder"]].role is Role.DEVELOPER

    client.patch(
        f"/api/projects/{project_id}/members/me",
        json={"role_shares": {"planner": 1.0}},
    )

    with db_session.session_scope() as s:
        profile = scoring_service.load_profiles(s, project_id)[people["founder"]]
        assert profile.role is Role.PLANNER, "산정이 새 역할을 안 읽습니다"


def test_a_role_change_is_logged(client: TestClient, people: dict):
    """역할은 가중치를 바꾸고 가중치는 점수를 바꾼다. 유리한 쪽으로
    옮겨 두는 것도 조작이고, 그건 사람이 볼 수 있어야 한다."""
    login_as(client, people["founder"])
    project_id = create_project(client)["project_id"]
    client.patch(
        f"/api/projects/{project_id}/members/me",
        json={"role_shares": {"designer": 1.0}},
    )

    with db_session.session_scope() as s:
        log = s.scalars(
            select(m.AuditLog).where(m.AuditLog.action == "weights_changed")
        ).one()
        assert log.actor_id == people["founder"]
        assert log.before["role_shares"] == {"developer": 1.0}
        assert log.after["role_shares"] == {"designer": 1.0}


def test_a_bad_split_is_refused_with_a_reason(client: TestClient, people: dict):
    login_as(client, people["founder"])
    project_id = create_project(client)["project_id"]

    for bad, word in (
        ({"developer": 0.5, "planner": 0.2}, "합이 1"),
        ({"tester": 1.0}, "모르는 역할"),
        ({}, "골라야"),
    ):
        response = client.patch(
            f"/api/projects/{project_id}/members/me", json={"role_shares": bad}
        )
        assert response.status_code == 400, (bad, response.text)
        assert word in response.json()["detail"], (bad, response.json())


def test_there_is_no_way_to_set_someone_elses_role(client: TestClient, people: dict):
    """⚠️ 남의 역할을 바꾸는 것은 **남의 점수를 바꾸는 일**이다.

    경로가 `/members/me` 라 남의 id 를 넣을 자리 자체가 없습니다 —
    요청 본문의 id 를 믿던 결함(`member_ids`)과 같은 부류를 설계로
    막습니다. 그래도 누가 우회를 시도할 수 있으니 확인해 둡니다.
    """
    login_as(client, people["founder"])
    project_id = create_project(client)["project_id"]

    # 남의 id 를 경로에 넣어 보기
    assert client.patch(
        f"/api/projects/{project_id}/members/{people['joiner']}",
        json={"role_shares": {"planner": 1.0}},
    ).status_code in (404, 405, 422)

    # 본문에 몰래 실어 보기 — `extra: forbid` 가 막는다
    assert client.patch(
        f"/api/projects/{project_id}/members/me",
        json={"role_shares": {"planner": 1.0}, "user_id": people["joiner"]},
    ).status_code == 422


def test_an_outsider_cannot_set_a_role(client: TestClient, people: dict):
    login_as(client, people["founder"])
    project_id = create_project(client)["project_id"]

    login_as(client, people["stranger"])
    assert client.patch(
        f"/api/projects/{project_id}/members/me",
        json={"role_shares": {"planner": 1.0}},
    ).status_code in (403, 404)


def test_the_home_list_says_how_many_are_in_the_recording_screen(
    client: TestClient, engine, people: dict
):
    """⭐ 목록이 **지금 녹음 화면에 들어와 있는 사람 수**를 싣는다 (결함 444).

    이 칸이 없어서 홈은 「아직 아무도 안 들어왔다」와 「지금 녹음 중이다」를
    못 갈랐습니다. 셋이 동의하고 한 사람이 조각을 올리는 동안 홈은 계속
    「동의를 받고 녹음을 시작합니다」였고, 같은 순간 로비는 세 사람이 전부
    「동의함」이라고 적고 있었습니다 — 브라우저로 나란히 놓고 쟀습니다.

    ⚠️ **칸 이름을 맞추는 짝 가드로는 이걸 못 잡습니다.** 서버가 칸을
    선언해 놓고 **안 채우면** 언제나 기본값 0 이 나가는데, 이름은 세 곳에
    다 있으므로 그 가드는 초록입니다 (결함 312 의 모양). 심어서 확인했고
    그때 빨간 것은 이 검사뿐이었습니다 — API 를 통과한 뒤를 재는 검사가
    따로 있어야 합니다 (결함 370).

    ⚠️ **`recording` 은 「참가했다」이지 「소리가 오고 있다」가 아닙니다.**
    `join_track` 에서 붙으므로 조각이 0개여도 셉니다 — 결함 404 가 통화
    화면에서 정확히 그것을 「녹음 중입니다」로 읽었습니다. 그래서 이 칸의
    이름도 문장도 「들어와 있다」까지만 말합니다.
    """
    from sqlalchemy.orm import Session

    login_as(client, people["founder"])
    project_id = create_project(client)["project_id"]
    def open_meeting(title: str) -> int:
        made = client.post(f"/api/projects/{project_id}/meetings", json={"title": title})
        return int(made.json()["meeting_id"])

    live = open_meeting("지금 녹음 중")
    idle = open_meeting("아직 안 들어옴")
    done = open_meeting("다 끝남")

    with Session(engine) as session:
        # 들어와 있는 사람 둘. ⚠️ 한 회의에 같은 사람의 트랙은 하나뿐입니다.
        for who in (people["founder"], people["joiner"]):
            session.add(
                m.MeetingTrack(
                    meeting_id=live, user_id=who, started_at=NOW, status="recording", coverage=None
                )
            )
        # 끝난 트랙은 안 셉니다 — 그 갈래는 `coverage` 가 말합니다(결함 405).
        session.add(
            m.MeetingTrack(
                meeting_id=done,
                user_id=people["founder"],
                started_at=NOW,
                status="completed",
                coverage=1.0,
            )
        )
        session.commit()

    rows = {r["meeting_id"]: r for r in client.get(f"/api/projects/{project_id}/meetings").json()}
    assert rows[live]["recording_tracks"] == 2
    assert rows[idle]["recording_tracks"] == 0, "트랙이 없으면 0 입니다"
    assert rows[done]["recording_tracks"] == 0, (
        "끝난 트랙을 여기 세면 회의가 끝난 뒤에도 홈이 「들어와 있습니다」라고 합니다"
    )
