"""프로젝트 안에서 누가 무엇을 할 수 있는가 (요구사항 정의서 §5 `PROJECT-004`).

## ⚠️ 여기 말고 다른 데서 판단하지 마십시오

권한 판단이 두 곳에 있으면 **반드시 갈라집니다** — 이 저장소의 대표
실패 ② 입니다. 그리고 권한이 갈라지는 것은 화면 색이 갈라지는 것과
다릅니다. **한쪽에서만 막히면 다른 쪽은 뚫린 것**입니다.

그래서 표 하나(`_ALLOWED`)만 두고 `can()` 으로만 묻습니다.

## ⚠️ 기본은 **거절**입니다

`_ALLOWED` 에 없는 행동은 아무도 못 합니다. 반대로 만들면(모르는 행동은
허용) 새 엔드포인트를 추가할 때마다 **아무 말 없이 열립니다** — 빠뜨린
것이 곧 구멍이 되는 설계는 언젠가 반드시 뚫립니다.

## ⚠️ 소유자가 없는 프로젝트를 만들지 않습니다

마지막 소유자가 나가거나 강등되면 그 프로젝트는 **아무도 팀원을 못
다루는** 상태가 됩니다. 되돌릴 방법이 화면에 없습니다(관리자 콘솔이
없으니까요). `last_owner_problem()` 이 그 자리를 막습니다.
"""

from __future__ import annotations

from enum import StrEnum

from teamflow.db.vocab import ROLE_RANK, ProjectRole


class Action(StrEnum):
    """권한을 묻는 행동들.

    ⚠️ **읽기는 여기 없습니다.** 조회는 "구성원인가" 로 충분하고, 그건
    `_require_project_member` 가 이미 봅니다. 여기 있는 것은 전부
    **바꾸는 것**입니다.
    """

    #: 프로젝트 이름·저장소 같은 설정
    EDIT_PROJECT = "edit_project"
    #: 초대 코드를 새로 뽑기 — 옛 코드가 죽으므로 팀원 관리에 가깝습니다
    ROTATE_INVITE = "rotate_invite"
    #: 남을 내보내기
    REMOVE_MEMBER = "remove_member"
    #: 남의 권한을 바꾸기
    CHANGE_ROLE = "change_role"
    #: 프로젝트를 통째로 지우기
    DELETE_PROJECT = "delete_project"
    #: 업무를 지우기 (`TASK-001~003`)
    DELETE_TASK = "delete_task"


#: 이 행동을 하려면 **최소 이 등급**이어야 한다.
#:
#: ⚠️ 등급 비교는 `ROLE_RANK` 로 합니다. 문자열로 비교하면
#: `"admin" < "member"` 가 참이라 뜻이 정반대가 됩니다.
_ALLOWED: dict[Action, ProjectRole] = {
    Action.EDIT_PROJECT: ProjectRole.ADMIN,
    Action.ROTATE_INVITE: ProjectRole.ADMIN,
    Action.REMOVE_MEMBER: ProjectRole.ADMIN,
    Action.CHANGE_ROLE: ProjectRole.ADMIN,
    # ⚠️ 프로젝트 삭제만 소유자입니다. 관리자에게 주면 **되돌릴 수 없는
    #    일**을 여러 사람이 할 수 있게 되고, 이 저장소에는 휴지통이
    #    없습니다.
    Action.DELETE_PROJECT: ProjectRole.OWNER,
    # ⚠️ 업무 삭제는 **팀원도** 합니다. 칸반은 매일 쓰는 화면이고,
    #    잘못 만든 카드 하나를 지우려고 관리자를 부르게 하면 사람들은
    #    지우는 대신 **완료로 옮겨 버립니다** — 그러면 진행률이 거짓이
    #    되고, 그 숫자가 기여도와 보고서로 흘러갑니다.
    Action.DELETE_TASK: ProjectRole.MEMBER,
}


def can(role: ProjectRole | str | None, action: Action | str) -> bool:
    """이 등급이 이 행동을 해도 되는가.

    ⚠️ **모르는 값은 거절**입니다. 등급이 `None`(구성원이 아님)이거나
    어휘에 없는 글자면 `False` 입니다 — 여기서 관대하면 DB 에 이상한
    값이 하나 들어가는 순간 권한이 열립니다.
    """
    try:
        needed = _ALLOWED[Action(action)]
    except ValueError:
        return False
    if role is None:
        return False
    try:
        mine = ProjectRole(role)
    except ValueError:
        return False
    return ROLE_RANK[mine] >= ROLE_RANK[needed]


def outranks(actor: ProjectRole | str, target: ProjectRole | str) -> bool:
    """행위자가 대상보다 **위**인가.

    ⚠️ 같은 등급끼리는 서로 못 건드립니다. 관리자 둘이 서로를 내보낼 수
    있으면 **먼저 누른 쪽이 이기는** 경주가 되고, 소유자가 잠든 사이에
    팀이 뒤집힙니다.
    """
    return ROLE_RANK[ProjectRole(actor)] > ROLE_RANK[ProjectRole(target)]


def last_owner_problem(
    roles: list[ProjectRole | str], *, leaving: ProjectRole | str
) -> str | None:
    """이 사람이 빠지면 소유자가 사라지는가. 문제가 없으면 `None`.

    `roles` 는 **빠지는 사람을 포함한** 지금 구성원 전부의 등급입니다.

    ⚠️ 나가기와 강등을 **같은 함수**로 봅니다. 둘 다 결과가 똑같기
    때문입니다 — 소유자가 0명인 프로젝트. 따로 만들면 한쪽만 고쳐집니다.
    """
    if ProjectRole(leaving) is not ProjectRole.OWNER:
        return None
    owners = sum(1 for r in roles if ProjectRole(r) is ProjectRole.OWNER)
    if owners > 1:
        return None
    return (
        "마지막 소유자입니다. 다른 사람에게 소유자를 넘긴 뒤에 하십시오 — "
        "소유자가 없으면 아무도 팀원을 다룰 수 없게 됩니다."
    )
