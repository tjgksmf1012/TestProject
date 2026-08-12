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
