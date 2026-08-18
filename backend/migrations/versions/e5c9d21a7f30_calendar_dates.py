"""일정 — 업무 시작일과 예정된 회의 (요구사항 정의서 §16)

    tasks.start_date        업무 시작일 (CALENDAR-002)
    meetings.scheduled_at   **예정된** 회의 시각 (CALENDAR-003·004)

## ⚠️ `calendar_events` 표를 만들지 않았습니다

정의서 §16 이 요구하는 다섯 중 셋은 **이미 있는 행에서 나옵니다** —
업무 마감일(`tasks.deadline`)·프로젝트 마감일(`projects.deadline`)·회의.
그걸 따로 베껴 `calendar_events` 에 담으면 업무 마감일을 고쳤을 때 달력이
옛날 날짜를 말합니다. 이 저장소가 반복해서 당한 "두 벌이 있으면 한쪽만
고쳐진다" 가 정확히 그 모양입니다.

그래서 달력은 **읽어서 만드는 것**이고, 새로 저장하는 것은 위 두 칸뿐입니다.

## ⚠️ 예정된 회의도 `meetings` 행입니다

`scheduled_at` 이 있고 `started_at` 이 비어 있으면 **아직 안 연 회의**
입니다. 예정을 별도 표에 두면 "그 예정이 이 회의가 됐다" 를 잇는 칸이
또 필요하고, 안 이어진 것들이 쌓입니다.

⚠️ 그래서 `started_at` 이 **널을 받게** 바뀝니다. 지금까지는 회의가
곧 녹음이라 늘 값이 있었습니다.

Revision ID: e5c9d21a7f30
Revises: d70b95c1e4a8
Create Date: 2026-08-12 05:10:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e5c9d21a7f30"
down_revision: str | Sequence[str] | None = "d70b95c1e4a8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("start_date", sa.DateTime(timezone=True)))
    op.add_column("meetings", sa.Column("scheduled_at", sa.DateTime(timezone=True)))

    # ⚠️ 예정만 있고 아직 안 연 회의는 `started_at` 이 없습니다.
    #    SQLite 는 컬럼 변경을 통째로 다시 만들어야 하므로 batch 로 합니다.
    with op.batch_alter_table("meetings") as batch:
        batch.alter_column(
            "started_at", existing_type=sa.DateTime(timezone=True), nullable=True
        )


def downgrade() -> None:
    # ⚠️ 되돌리면 **예정만 있는 회의는 `started_at` 이 없어 되돌릴 수
    #    없습니다.** 예정 시각을 시작 시각으로 옮겨 놓고 좁힙니다 —
    #    지우는 것보다 낫습니다.
    op.execute(
        "UPDATE meetings SET started_at = scheduled_at WHERE started_at IS NULL"
    )
    with op.batch_alter_table("meetings") as batch:
        batch.alter_column(
            "started_at", existing_type=sa.DateTime(timezone=True), nullable=False
        )
        batch.drop_column("scheduled_at")
    op.drop_column("tasks", "start_date")
