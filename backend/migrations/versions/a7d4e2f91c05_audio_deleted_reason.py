"""왜 지웠는가

`audio_assets.deleted_at` 만으로는 **보존기간 만료**와 **본인 삭제 요청**을
구분할 수 없었습니다.

이 구분이 필요한 자리는 기여도 화면입니다. 원본이 없어진 트랙은 재처리해도
발화가 안 나오는데, 그 상태를 "말을 안 한 사람" 으로 처리하면 측정이 아니라
오답입니다 (docs/04 §2.6). 그런데 **왜 없어졌는지에 따라 사람이 할 일이
다릅니다** — 녹음이 끊긴 것은 "다음엔 화면을 켜 두자" 로 고칠 수 있지만,
만료와 삭제 요청은 그렇지 않습니다. 같은 문구가 나가면 안 됩니다.

    retention_expired   보존기간 30일이 지나 자동으로 지웠다 (docs/07 P5)
    user_request        본인이 삭제를 요청했다 (docs/07 P6)

nullable 입니다. 이 컬럼이 생기기 전에 지워진 행은 이유를 모르고, **모르는
것을 아는 척하면 안 됩니다** — 기본값으로 아무거나 채우면 화면이 틀린 이유를
말하게 됩니다.

Revision ID: a7d4e2f91c05
Revises: f3c81b60d29a
Create Date: 2026-08-07 01:10:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a7d4e2f91c05"
down_revision: str | Sequence[str] | None = "f3c81b60d29a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "audio_assets", sa.Column("deleted_reason", sa.String(30), nullable=True)
    )


def downgrade() -> None:
    with op.batch_alter_table("audio_assets") as batch:
        batch.drop_column("deleted_reason")
