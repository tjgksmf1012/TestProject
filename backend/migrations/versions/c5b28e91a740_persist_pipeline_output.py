"""파이프라인이 만든 것을 저장할 자리

파이프라인은 이미 요약과 경고를 만들고 있었고, Celery 페이로드에 실어
저장 태스크까지 넘기고 있었다. 저장 태스크가 그걸 **읽지 않았다.**

    meetings.summary                    LLM 회의 요약 — 통째로 버려지고 있었다
    meeting_task_candidates.warnings    확신도를 깎은 이유 — 사람이 볼 유일한 단서

`assignee_hint`(meeting_task_candidates)와 `offset_ms`(meeting_tracks)도
같이 버려지고 있었지만 그 둘은 **컬럼이 이미 있다.** 코드만 고치면 된다.
그래서 이 마이그레이션은 두 컬럼만 만든다.

Revision ID: c5b28e91a740
Revises: 8c1f4a2b7d90
Create Date: 2026-08-06 11:30:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c5b28e91a740"
down_revision: str | Sequence[str] | None = "8c1f4a2b7d90"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_JSON = postgresql.JSONB().with_variant(sa.JSON(), "sqlite")


def upgrade() -> None:
    op.add_column("meetings", sa.Column("summary", sa.Text(), nullable=True))
    # NOT NULL 인데 server_default 를 주는 이유는 앞 마이그레이션과 같다:
    # SQLite 는 테이블이 비어 있어도 기본값 없는 NOT NULL 컬럼 추가를 거부한다.
    with op.batch_alter_table("meeting_task_candidates") as batch:
        batch.add_column(
            sa.Column("warnings", _JSON, nullable=False, server_default=sa.text("'[]'"))
        )


def downgrade() -> None:
    with op.batch_alter_table("meeting_task_candidates") as batch:
        batch.drop_column("warnings")
    with op.batch_alter_table("meetings") as batch:
        batch.drop_column("summary")
