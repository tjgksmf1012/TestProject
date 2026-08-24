"""권한 표 (요구사항 정의서 §5 `PROJECT-004`).

⚠️ 순수 함수만 잽니다. 배선은 `test_project_roles_api.py` 가 봅니다.
"""

from __future__ import annotations

import pytest

from teamflow.db.vocab import PROJECT_ROLES, ROLE_RANK, ProjectRole
from teamflow.projects.permissions import (
    Action,
    can,
    last_owner_problem,
    outranks,
)

OWNER = ProjectRole.OWNER
ADMIN = ProjectRole.ADMIN
MEMBER = ProjectRole.MEMBER


# ══════════════════════════════════════════════════════════════
# 위계
# ══════════════════════════════════════════════════════════════


def test_the_ranking_is_owner_admin_member():
    assert ROLE_RANK[OWNER] > ROLE_RANK[ADMIN] > ROLE_RANK[MEMBER]


def test_the_ranking_is_not_alphabetical():
    """⭐ 글자로 비교하면 **뜻이 정반대**입니다.

    `"admin" < "member"` 는 참입니다. 이 검사가 없으면 누군가 `ROLE_RANK`
    를 지우고 문자열 비교로 바꿔도 대부분의 테스트가 통과합니다.
    """
    assert "admin" < "member"  # 글자로는 이렇지만
    assert ROLE_RANK[ADMIN] > ROLE_RANK[MEMBER]  # 권한은 반대


def test_every_role_has_a_rank():
    """⚠️ 어휘에 값을 더하고 `ROLE_RANK` 를 안 고치면 `KeyError` 로 500 이 납니다."""
    for role in PROJECT_ROLES:
        assert role in ROLE_RANK


# ══════════════════════════════════════════════════════════════
# ⭐ 기본은 거절
# ══════════════════════════════════════════════════════════════


def test_an_unknown_action_is_refused():
    """⭐ 표에 없는 행동은 **아무도 못 합니다.**

    반대로 만들면(모르는 행동은 허용) 새 엔드포인트를 추가할 때마다
    아무 말 없이 열립니다.
    """
    assert can(OWNER, "brand_new_action") is False


def test_someone_who_is_not_a_member_can_do_nothing():
    for action in Action:
        assert can(None, action) is False


def test_a_junk_role_can_do_nothing():
    """⭐ DB 에 이상한 값이 하나 들어가도 권한이 열리면 안 됩니다."""
    for junk in ("superuser", "OWNER", "owner ", ""):
        assert can(junk, Action.EDIT_PROJECT) is False, junk


# ══════════════════════════════════════════════════════════════
# 표
# ══════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    "action",
    [
        Action.EDIT_PROJECT,
        Action.ROTATE_INVITE,
        Action.REMOVE_MEMBER,
        Action.CHANGE_ROLE,
    ],
)
def test_managing_the_team_needs_admin(action):
    assert can(OWNER, action) is True
    assert can(ADMIN, action) is True
    assert can(MEMBER, action) is False


def test_only_the_owner_deletes_the_project():
    """⭐ 되돌릴 수 없는 일은 소유자만. 휴지통이 없습니다."""
    assert can(OWNER, Action.DELETE_PROJECT) is True
    assert can(ADMIN, Action.DELETE_PROJECT) is False


def test_a_plain_member_can_delete_a_task():
    """⭐ 업무 삭제까지 관리자로 올리면 사람들이 **완료로 옮겨 버립니다.**

    칸반은 매일 쓰는 화면입니다. 잘못 만든 카드를 지우려고 관리자를
    불러야 하면, 사람은 지우는 대신 완료 칸으로 밀어 넣습니다 — 그러면
    진행률이 거짓이 되고 그 숫자가 기여도와 보고서로 흘러갑니다.
    """
    assert can(MEMBER, Action.DELETE_TASK) is True


# ══════════════════════════════════════════════════════════════
# ⭐ 같은 등급끼리는 못 건드린다
# ══════════════════════════════════════════════════════════════


def test_an_admin_cannot_touch_another_admin():
    """⭐ 안 막으면 **먼저 누른 쪽이 이기는 경주**가 됩니다."""
    assert outranks(ADMIN, ADMIN) is False
    assert outranks(OWNER, ADMIN) is True
    assert outranks(ADMIN, MEMBER) is True
    assert outranks(MEMBER, ADMIN) is False


def test_nobody_outranks_the_owner():
    for role in PROJECT_ROLES:
        assert outranks(role, OWNER) is False


# ══════════════════════════════════════════════════════════════
# ⭐ 소유자 없는 프로젝트를 만들지 않는다
# ══════════════════════════════════════════════════════════════


def test_the_last_owner_cannot_leave():
    """⭐ 소유자가 0명이면 **아무도 팀원을 못 다룹니다.**

    관리자 콘솔이 없어서 되돌릴 방법이 화면에 없습니다.
    """
    problem = last_owner_problem([OWNER, ADMIN, MEMBER], leaving=OWNER)
    assert problem is not None
    assert "마지막 소유자" in problem


def test_one_of_two_owners_can_leave():
    assert last_owner_problem([OWNER, OWNER, MEMBER], leaving=OWNER) is None


def test_anyone_else_can_leave_freely():
    assert last_owner_problem([OWNER, ADMIN], leaving=ADMIN) is None
    assert last_owner_problem([OWNER, MEMBER], leaving=MEMBER) is None


def test_the_sole_member_who_is_the_owner_cannot_leave():
    """혼자 있는 프로젝트에서도 같은 답입니다 — 나가면 주인 없는 프로젝트가 남습니다."""
    assert last_owner_problem([OWNER], leaving=OWNER) is not None


def test_demoting_the_last_owner_is_the_same_problem():
    """⭐ 나가기와 강등을 **한 함수**로 봅니다 — 결과가 똑같기 때문입니다.

    따로 만들면 한쪽만 고쳐집니다 (대표 실패 ②).
    """
    assert last_owner_problem([OWNER, ADMIN], leaving=OWNER) is not None


# ══════════════════════════════════════════════════════════════
# 권한 어휘에도 「부르는 곳」이 있는가 (결함 351)
# ══════════════════════════════════════════════════════════════
#
# 결함 306 이 「서버의 갈래마다 부르는 곳이 있는지 세는 가드가 낱말을
# 세는 것보다 낫습니다」라고 적어 뒀습니다. 그 자를 **라우트가 아니라
# 권한 어휘**에 대 보니 일곱 중 하나가 0곳이었습니다.
#
#     EDIT_PROJECT · ROTATE_INVITE · REMOVE_MEMBER · CHANGE_ROLE ·
#     DELETE_TASK · DELETE_MEETING                     → 각 1곳
#     DELETE_PROJECT                                   → **0곳**
#
# 그 값에는 「관리자에게 주면 되돌릴 수 없는 일을 여러 사람이…」라는
# 꼼꼼한 주석까지 붙어 있어서, 읽으면 **있는 기능**처럼 보입니다.
# 실제로는 `DELETE /api/projects/{id}` 가 없어 405 이고, 그래서
# `vocab.py` 의 「관리자는 프로젝트를 지우지는 못함」은 **없는 능력으로
# 관리자와 소유자를 가르고** 있었습니다.


def test_every_action_is_actually_asked_somewhere():
    """⭐ 권한 갈래마다 **묻는 곳이 있다** — 없으면 왜 없는지 적혀 있다.

    ⚠️ 주석은 아무것도 안 막습니다(결함 337·341). 「아직 라우트가 없다」를
    글로만 적어 두면 다음 사람은 그 글을 안 읽습니다.
    """
    import re
    from pathlib import Path

    from teamflow.projects.permissions import Action

    root = Path(__file__).resolve().parents[1] / "teamflow"
    here = root / "projects" / "permissions.py"

    #: 예외 — **왜 예외인가**를 같이 적습니다. 예외가 낡는 것도 아래에서
    #: 잽니다(결함 306 이 적어 둔 그것).
    exempt = {
        Action.DELETE_PROJECT: (
            "부르는 라우트가 아직 없습니다. `_ALLOWED` 의 「소유자만」은 근거를 "
            "적어 내린 결정이라(test_only_the_owner_deletes_the_project) 만들 때 "
            "그 정책부터 다시 정하지 않게 남겨 둡니다."
        )
    }

    asked: dict[Action, int] = {}
    for path in root.rglob("*.py"):
        if path == here:
            continue
        text = path.read_text()
        for action in Action:
            # ⚠️ 낱말이 아니라 **묻는 문법**으로 좁힙니다 (결함 240) —
            #    `"delete_project"` 라는 글자는 시연 도구에도 있습니다.
            asked[action] = asked.get(action, 0) + len(
                re.findall(rf"\bAction\.{action.name}\b", text)
            )

    silent = sorted(a.name for a in Action if asked.get(a, 0) == 0)
    unexplained = [name for name in silent if Action[name] not in exempt]
    assert unexplained == [], (
        f"묻는 곳이 0곳인 권한: {unexplained} — 만들어 놓고 아무도 안 부르는 "
        "것이거나(실패 ①), 예외라면 왜 예외인지 적으십시오"
    )

    # ⚠️ **예외가 낡는 것도 잽니다.** 나중에 라우트가 생겼는데 예외에
    #    남아 있으면 다음 사람이 「아직 없다」로 읽습니다.
    stale = sorted(a.name for a in exempt if asked.get(a, 0) > 0)
    assert stale == [], (
        f"이제 부르는데 예외에 남아 있습니다: {stale} — 예외에서 빼고 "
        "`vocab.py` 의 설명도 같이 고치십시오"
    )


def test_the_role_vocabulary_does_not_claim_capabilities_in_prose():
    """⛔ 등급 옆에 「무엇을 할 수 있다」를 글로 적지 않는다 (결함 351).

    예전에는 두 줄이 이랬고 **둘 다 거짓**이었습니다:

        OWNER … 넘겨줄 수는 있어도    → `owner` 를 주는 길이 아무에게도 없음
        ADMIN … 프로젝트를 지우지는 못함 → 아무도 못 지움 (라우트가 없음)

    할 수 있는 일의 원본은 `_ALLOWED` 하나입니다. 값 옆에 다시 쓰면
    두 벌이 되고, 한쪽만 낡습니다 — 결함 341 이 이 파일 **자신**에서
    겪은 그것입니다.
    """
    import re
    from pathlib import Path

    from teamflow.db.vocab import ProjectRole

    source = (
        Path(__file__).resolve().parents[1] / "teamflow" / "db" / "vocab.py"
    ).read_text()

    # ⚠️ **`.*?\n\n` 로 잘랐다가 아무것도 안 재고 있었습니다.** 클래스
    #    docstring 에 빈 줄이 있어서 블록이 값 줄까지 못 갔고, 고치기 전
    #    문장을 그대로 심어도 초록이었습니다. 들여쓰기가 풀릴 때까지
    #    걷습니다 — 값이 몇 개든, 설명이 얼마나 길든 걸립니다.
    lines = source.splitlines()
    start = next(
        (i for i, ln in enumerate(lines) if ln.startswith("class ProjectRole(StrEnum):")),
        None,
    )
    assert start is not None, "ProjectRole 을 못 찾았습니다 — 이 검사가 낡았습니다"

    values: list[str] = []
    for line in lines[start + 1 :]:
        if line.strip() != "" and not line.startswith(" "):
            break
        if re.match(r'\s+[A-Z_]+ = "', line):
            values.append(line)
    assert len(values) == len(ProjectRole), (
        f"값 줄을 {len(values)}개만 찾았습니다 (어휘는 {len(ProjectRole)}개) — 이 검사가 낡았습니다"
    )

    # 값 줄(`OWNER = "owner"  # …`)의 **꼬리 주석**만 봅니다. 클래스
    # docstring 은 왜 그렇게 정했는지를 적는 자리라 건드리지 않습니다.
    for line in values:
        tail = line.split("#", 1)[1].strip() if "#" in line else ""
        if tail == "":
            continue
        assert not re.search(r"할 수|못함|없음|있어도|지우|넘겨", tail), (
            f"등급 옆에 할 수 있는 일을 적었습니다: {tail!r} — "
            "원본은 `projects/permissions.py` 의 `_ALLOWED` 하나입니다"
        )
