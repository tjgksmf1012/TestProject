"""세션이 마지막으로 쓰인 때 (정의서 §4 `USER-005`)

## ⚠️ 상태를 담는 칸이 **아닙니다**

`접속 중`·`자리 비움`·`오프라인` 은 여기서 **읽을 때 계산**합니다
(`teamflow/users/presence.py`). 상태를 행으로 쌓으면 그 표는 곧
출퇴근부가 되고, 이 제품은 기여를 "무엇을 했는가" 로 재기로 했는데
옆에 "언제 앉아 있었는가" 가 쌓이면 사람은 그 둘을 같이 봅니다.

달력·알림·위험 신호를 표로 안 만든 것과 같은 판단이고, 여기서는 이유가
하나 더 있습니다 — **감시입니다.**

## nullable 인 이유

이 칸이 생기기 전에 만들어진 세션이 있고, 그 세션은 **한 번도 안 쟀다**
가 맞습니다. `created_at` 으로 채우면 몇 달 전에 로그인한 사람이 지금
접속 중으로 보일 수 있습니다.

Revision ID: f4c07d92ab13
Revises: e7b19c40da35
Create Date: 2026-08-12 12:55:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f4c07d92ab13"
down_revision: str | Sequence[str] | None = "e7b19c40da35"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("user_sessions") as batch:
        batch.add_column(
            sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True)
        )


def downgrade() -> None:
    with op.batch_alter_table("user_sessions") as batch:
        batch.drop_column("last_seen_at")
