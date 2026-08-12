"""프로젝트 권한 3단계 (정의서 §5 `PROJECT-004`)

## 지금까지는 **구성원이거나 아니거나** 둘뿐이었습니다

`_require_project_member` 하나가 모든 조회를 지켰고, 통과한 사람은 전부
같은 것을 할 수 있었습니다. 즉 **초대 코드를 아는 사람은 누구나 프로젝트
이름을 바꾸고 초대 코드를 새로 뽑을 수 있었습니다.**

## ⚠️ `role_shares` 를 쓰지 않았습니다

그 칸은 `{"developer": 0.7}` 처럼 **기여도 가중치**를 담습니다. 권한을
거기 섞으면 기획자 비중을 0.3 으로 바꾼 것이 권한 변경이 됩니다.
완전히 다른 것이라 칸을 따로 뒀습니다.

## ⚠️ 있던 구성원을 전부 `member` 로 두면 **주인 없는 프로젝트**가 됩니다

기본값만 넣고 끝내면 모든 프로젝트에 소유자가 0명이 되고, 그 순간
아무도 팀원을 못 다룹니다 — 되돌릴 화면이 없습니다.

그래서 프로젝트마다 **`members` 에서 제일 먼저 생긴 행**을 소유자로
올립니다. `create_project` 가 만든 사람을 첫 구성원으로 넣으므로
(그리고 나머지는 초대 코드로 나중에 들어오므로) 그 행이 만든 사람입니다.

⚠️ `projects` 에 만든 사람을 가리키는 칸이 없어서 이렇게 합니다. 완벽한
근거는 아니지만 **소유자가 없는 것보다는 낫고**, 틀렸더라도 그 팀의
소유자가 다른 사람에게 넘길 수 있습니다.

Revision ID: d2f6a83b1e47
Revises: b8e2c05fa471
Create Date: 2026-08-12 12:05:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d2f6a83b1e47"
down_revision: str | Sequence[str] | None = "b8e2c05fa471"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# ⚠️ **값을 여기 박아 둡니다. `db/vocab.py` 에서 끌어오지 마십시오.**
#    마이그레이션은 "이때 이렇게 적용했다" 는 기록입니다.
_ALLOWED = ("admin", "member", "owner")

_CHECK = "project_role IN (" + ",".join(f"'{v}'" for v in _ALLOWED) + ")"


def upgrade() -> None:
    # ⚠️ `server_default` 로 채웁니다. 없으면 이미 있는 행이 NULL 이 되고
    #    NOT NULL 을 못 겁니다.
    with op.batch_alter_table("members") as batch:
        batch.add_column(
            sa.Column(
                "project_role",
                sa.String(length=20),
                nullable=False,
                server_default="member",
            )
        )
        batch.create_check_constraint("ck_member_project_role", _CHECK)

    # 프로젝트마다 제일 먼저 생긴 구성원을 소유자로.
    #
    # ⚠️ `id` 로 고릅니다 — `members` 에는 만든 시각 칸이 없습니다.
    #    자동 증가 기본키라 순서는 생긴 순서와 같습니다.
    op.execute(
        """
        UPDATE members SET project_role = 'owner'
         WHERE id IN (SELECT MIN(id) FROM members GROUP BY project_id)
        """
    )


def downgrade() -> None:
    with op.batch_alter_table("members") as batch:
        batch.drop_constraint("ck_member_project_role", type_="check")
        batch.drop_column("project_role")
