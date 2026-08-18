"""알림 (요구사항 정의서 §19)

    notifications   멘션 · 업무 배정 · 회의 임박 · GitHub

## ⚠️ 여섯 중 **넷만** 저장합니다

정의서의 여섯 중 `due_soon`(마감 임박)과 `overdue`(지연)는 **지금 상태에서
나옵니다.** 행으로 쌓으면 마감일을 미뤘을 때 "곧 마감" 알림이 남아 있고,
업무를 끝냈을 때 "지연" 알림이 남아 있습니다 — 알림이 사실이 아니라
**베낀 순간의 사실**을 가리키게 됩니다. 아래 CHECK 제약이 그 둘을
아예 거절합니다.

## ⚠️ 문장을 저장하지 않습니다

가리키는 번호만 있고 "…님이 나를 불렀습니다" 같은 글자는 없습니다.
저장하면 업무 이름을 고쳤을 때 알림만 옛 이름을 말합니다.

Revision ID: f1a4b8c209de
Revises: e5c9d21a7f30
Create Date: 2026-08-12 05:40:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f1a4b8c209de"
down_revision: str | Sequence[str] | None = "e5c9d21a7f30"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# ⚠️ **값을 여기 박아 둡니다. `db/vocab.py` 에서 끌어오지 마십시오.**
#    마이그레이션은 "이때 이렇게 적용했다" 는 기록입니다. vocab 을 import 하면
#    나중에 값을 더했을 때 이 파일의 글자도 같이 움직여 검사가 항상 통과하는데,
#    이미 적용된 데이터베이스의 제약은 그대로라 새 값이 거절됩니다.

_PK = sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def upgrade() -> None:
    op.create_table(
        "notifications",
        sa.Column("id", _PK, autoincrement=True, nullable=False),
        sa.Column("user_id", _PK, nullable=False),
        sa.Column("project_id", _PK, nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("task_id", _PK, nullable=True),
        sa.Column("meeting_id", _PK, nullable=True),
        sa.Column("message_id", _PK, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "kind IN ('assigned','github','meeting_soon','mention')",
            name="ck_notification_kind",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"]),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"]),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_notifications_inbox", "notifications", ["user_id", "project_id", "id"]
    )


def downgrade() -> None:
    op.drop_index("ix_notifications_inbox", table_name="notifications")
    op.drop_table("notifications")
