"""업무 삭제 — 행은 남기고 지운 때만 적는다 (정의서 §15 `TASK-003`)

## ⚠️ 진짜로 지우면 **근거가 사라집니다**

`tasks.id` 를 가리키는 곳이 여섯입니다 — 기여 이벤트·PR 연결·마감일 변경
이력·의존성 두 방향·회의 업무 후보. 행을 지우면 그 참조가 아무것도 안
가리키게 되고, 화면의 `근거 업무 #7` 이 빈손이 됩니다. 이 저장소의
대표 실패 ③("할 일을 알려 주고 그 일을 할 자리를 안 줌")입니다.

채널을 `archive_channel` 로 다루는 것과 같은 판단입니다 — 채널을
지웠다고 남이 쓴 말이 사라지면 안 되는 것처럼, 업무를 지웠다고 그
업무로 쌓인 기여가 사라지면 안 됩니다.

## ⚠️ 읽는 곳이 일곱이라 조건을 손으로 적지 않습니다

`db/live.py` 하나만 씁니다. 각자 적게 두면 그중 하나는 반드시 빠지고,
빠진 곳에서 지운 업무가 조용히 되살아납니다 — 달력에만, 진행률에만.

Revision ID: e7b19c40da35
Revises: d2f6a83b1e47
Create Date: 2026-08-12 12:20:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e7b19c40da35"
down_revision: str | Sequence[str] | None = "d2f6a83b1e47"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ⚠️ nullable 입니다. NULL 이 "안 지웠다" 이고, 이미 있는 업무는 전부
    #    그 상태여야 합니다.
    with op.batch_alter_table("tasks") as batch:
        batch.add_column(
            sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True)
        )


def downgrade() -> None:
    # ⚠️ 되돌리면 **지웠던 업무가 칸반에 돌아옵니다.** 다른 방법이
    #    없습니다 — 지웠다는 사실을 담을 칸이 사라지니까요. 되돌리기 전에
    #    그것을 알고 하십시오.
    with op.batch_alter_table("tasks") as batch:
        batch.drop_column("deleted_at")
