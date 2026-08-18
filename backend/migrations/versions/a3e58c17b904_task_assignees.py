"""업무 담당자를 여럿 (정의서 §15 `TASK-006`)

## 칸을 표로 바꿉니다

`tasks.assignee_id` 한 칸이었습니다. 요구는 "담당자 하나 이상" 입니다.

## ⚠️ 칸을 **남겨 두지 않습니다**

"대표 담당자는 칸에, 나머지는 표에" 가 제일 손이 덜 가는 길인데, 그건
같은 사실을 두 벌로 두는 것입니다. 담당자는 **기여 이벤트가 누구에게
가는지**를 정하므로 두 벌이 갈라지면 점수가 갈라집니다.

## ⚠️ 있던 담당자를 먼저 옮기고 칸을 지웁니다

순서를 바꾸면(칸을 먼저 지우면) 지금까지의 담당자가 통째로 사라지고,
그 순간 기여 이벤트가 붙을 사람이 없어집니다. 되돌릴 방법도 없습니다.

`downgrade` 는 반대로 **한 명만** 되살립니다 — 칸이 하나라 그럴 수밖에
없고, 그래서 여럿 맡은 업무는 되돌리면 정보를 잃습니다. 여기 적어 둡니다.

Revision ID: a3e58c17b904
Revises: f4c07d92ab13
Create Date: 2026-08-12 23:10:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a3e58c17b904"
down_revision: str | Sequence[str] | None = "f4c07d92ab13"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "task_assignees",
        sa.Column("task_id", sa.BigInteger(), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column(
            "assigned_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("task_id", "user_id"),
    )

    # 있던 담당자를 그대로 옮깁니다. `assignee_id` 가 NULL 인 업무는
    # 담당자가 없던 것이므로 행을 만들지 않습니다.
    op.execute(
        """
        INSERT INTO task_assignees (task_id, user_id)
        SELECT id, assignee_id FROM tasks WHERE assignee_id IS NOT NULL
        """
    )

    with op.batch_alter_table("tasks") as batch:
        batch.drop_column("assignee_id")


def downgrade() -> None:
    with op.batch_alter_table("tasks") as batch:
        batch.add_column(sa.Column("assignee_id", sa.BigInteger(), nullable=True))

    # ⚠️ 여럿 맡은 업무는 **한 명만** 남습니다. 칸이 하나뿐이라 그렇습니다.
    op.execute(
        """
        UPDATE tasks SET assignee_id = (
            SELECT MIN(user_id) FROM task_assignees WHERE task_id = tasks.id
        )
        """
    )

    op.drop_table("task_assignees")
