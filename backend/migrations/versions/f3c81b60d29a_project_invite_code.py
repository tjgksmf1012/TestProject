"""프로젝트 초대 코드

`POST /api/projects` 가 `member_ids: list[int]` 를 받아서, **화면에서는
팀원을 넣을 수가 없었습니다** — 사용자는 남의 user_id 를 모릅니다.

이메일 초대를 안 쓴 이유는 `teamflow/projects/invites.py` 에 있습니다.

Revision ID: f3c81b60d29a
Revises: e91d4a06c7b2
Create Date: 2026-08-06 23:10:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f3c81b60d29a"
down_revision: str | Sequence[str] | None = "e91d4a06c7b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # nullable=True 가 의도입니다. 이 컬럼이 생기기 전 프로젝트는 코드가
    # 없고, 코드를 발급받기 전까지 **참가할 수 없어야** 합니다.
    # 빈 코드를 "아무나 통과" 로 읽으면 그 프로젝트 전부가 열립니다.
    with op.batch_alter_table("projects") as batch:
        batch.add_column(sa.Column("invite_code", sa.String(16), nullable=True))
        batch.create_unique_constraint("uq_projects_invite_code", ["invite_code"])


def downgrade() -> None:
    with op.batch_alter_table("projects") as batch:
        batch.drop_constraint("uq_projects_invite_code", type_="unique")
        batch.drop_column("invite_code")
