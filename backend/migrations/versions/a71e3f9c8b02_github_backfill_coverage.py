"""백필이 어디까지 훑었는지 기록한다

    projects.github_backfilled_at   백필을 마지막으로 돌린 시각
    projects.github_backfilled_to   **이 시각 이후는 GitHub 에 물어봤다**

**왜 이 두 칸이 필요한가.** 웹훅은 연결한 순간부터만 옵니다. 팀은 대개 몇
주 코드를 짜다가 이 시스템을 붙이므로, 그 전의 PR 은 통째로 기여도에
없습니다. 그런데 진단 화면은 "연결됨" 이라고 말합니다 — **어디에도 오류가
없습니다.** 연결 전에 제일 많이 일한 사람이 제일 적게 일한 것으로 보이고,
본인도 왜 그런지 알 방법이 없습니다.

이벤트만 봐서는 이걸 구분할 수 없습니다. `min(github_events.occurred_at)`
은 "우리가 가진 가장 오래된 활동" 이지 "그 전에 활동이 없었다" 가
아닙니다. 둘을 가르는 것이 `github_backfilled_to` 한 칸입니다.

⚠️ **기존 행은 NULL 로 둡니다.** 지금까지 백필을 돌린 적이 없으므로
그게 사실입니다. 여기서 `github_verified_at` 같은 값으로 채우면 "연결
전 활동까지 확인했다" 는 거짓이 되고, 화면이 그 거짓을 그대로 말합니다.

Revision ID: a71e3f9c8b02
Revises: c62b8f41d073
Create Date: 2026-08-07 07:45:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a71e3f9c8b02"
down_revision: str | Sequence[str] | None = "c62b8f41d073"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column("github_backfilled_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "projects",
        sa.Column("github_backfilled_to", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    with op.batch_alter_table("projects") as batch:
        batch.drop_column("github_backfilled_to")
        batch.drop_column("github_backfilled_at")
