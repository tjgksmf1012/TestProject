"""로그인과 세션

지금까지 `user_id` 를 요청 본문으로 받았습니다 — 누구나 남을 사칭할 수
있었다는 뜻입니다. 기여도를 산정하는 시스템에서 그건 산출물 전체를
무의미하게 만드는 구멍입니다.

    users.password_hash    scrypt 해시. NULL 이면 로그인 불가(기존 사용자)
    user_sessions          세션. 토큰 **해시**만 저장한다

Revision ID: e91d4a06c7b2
Revises: c5b28e91a740
Create Date: 2026-08-06 12:40:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e91d4a06c7b2"
down_revision: str | Sequence[str] | None = "c5b28e91a740"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # nullable=True 가 의도입니다. 기존 사용자는 비밀번호가 없고, 그 상태는
    # "로그인 불가" 로 읽힙니다(`verify_password(…, None) is False`).
    op.add_column("users", sa.Column("password_hash", sa.String(255), nullable=True))

    op.create_table(
        "user_sessions",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.BigInteger(), sa.ForeignKey("users.id"), nullable=False),
        # unique: 같은 토큰이 두 세션을 가리키면 어느 쪽이 유효한지 알 수 없습니다.
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("user_agent", sa.String(300), nullable=True),
    )
    op.create_index("ix_user_sessions_user", "user_sessions", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_user_sessions_user", table_name="user_sessions")
    op.drop_table("user_sessions")
    with op.batch_alter_table("users") as batch:
        batch.drop_column("password_hash")
