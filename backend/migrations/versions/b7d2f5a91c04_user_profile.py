"""프로필 이미지·자기소개 (정의서 §4 `USER-004`)

## 이미지가 칸에 들어가는 이유

파일로 받으면 저장 자리 + 인증 붙은 내려받기 + MIME 판별 + 크기 상한이
**한 벌**로 필요합니다 — `CHAT-006·007` 업로드를 안 만든 바로 그 이유.
대신 화면이 캔버스로 96×96 PNG 로 재부호화한 것(EXIF 가 떨어져 나감 —
사진 원본에는 찍은 **위치**가 들어 있습니다)을 `data:image/png;base64,…`
글자로 받아 행에 저장합니다. 나갈 때는 이미 인증이 걸린 JSON 응답에
실려 나가므로 안 잠긴 내려받기 문이 생기지 않습니다.

검증(형식·PNG 시그니처·치수·크기 상한)은 `teamflow/users/profile.py`
가 합니다. TEXT 인 것은 상한(64KB)을 스키마가 아니라 그 모듈이 재기
때문입니다 — 두 곳에 적으면 갈라집니다.

## nullable 인 이유

안 적은 사람이 대부분이고, 그건 잘못이 아닙니다. 화면은 없으면
이름 첫 글자 동그라미(지금까지의 모양)를 그대로 그립니다.

Revision ID: b7d2f5a91c04
Revises: a3e58c17b904
Create Date: 2026-08-17 06:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b7d2f5a91c04"
down_revision: str | Sequence[str] | None = "a3e58c17b904"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("bio", sa.String(300), nullable=True))
        batch.add_column(sa.Column("avatar", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.drop_column("avatar")
        batch.drop_column("bio")
