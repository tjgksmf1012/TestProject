"""녹음 청크 수집과 트랙 품질 기록

docs/04-회의-처리-파이프라인.md §2.6

두 가지를 더한다.

  1. `track_chunks` — 업로드된 청크의 **클라이언트 도착 시각**.
     파일은 디스크에 있지만 시각은 파일시스템에 없다. 그게 없으면
     공백을 절대 시각으로 복원할 수 없다.

  2. `meeting_tracks` 품질 컬럼 — 폰이 잠기면 트랙에 구멍이 뚫린다.
     모르고 쓰면 "말을 안 한 사람"이 되므로 커버리지를 남긴다.

⚠️ 자동생성을 쓰지 않고 직접 썼습니다. 초기 마이그레이션 때 autogenerate 가
   `sa.` 접두사 누락과 SQLite 리터럴 기본값을 뱉어 upgrade 가 터졌습니다.

NOT NULL 컬럼을 추가할 때 server_default 를 반드시 준 이유:
SQLite 는 테이블이 비어 있어도 기본값 없는 NOT NULL 컬럼 추가를 거부합니다
("Cannot add a NOT NULL column with default value NULL").

Revision ID: 8c1f4a2b7d90
Revises: 569fad5f8dde
Create Date: 2026-08-05 13:30:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "8c1f4a2b7d90"
down_revision: str | Sequence[str] | None = "569fad5f8dde"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# 모델의 JSONType 과 같은 변형. PostgreSQL 은 JSONB, SQLite 는 JSON.
_JSON = postgresql.JSONB().with_variant(sa.JSON(), "sqlite")
_PK = sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def upgrade() -> None:
    op.create_table(
        "track_chunks",
        sa.Column("id", _PK, autoincrement=True, nullable=False),
        sa.Column("track_id", sa.BigInteger(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("bytes", sa.Integer(), nullable=False),
        sa.Column("client_at_ms", sa.BigInteger(), nullable=False),
        sa.Column(
            "received_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["track_id"], ["meeting_tracks.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("track_id", "seq", name="uq_track_chunk"),
    )
    op.create_index("ix_chunk_track_seq", "track_chunks", ["track_id", "seq"])

    with op.batch_alter_table("meeting_tracks") as batch:
        batch.add_column(sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(
            sa.Column(
                "status",
                sa.String(length=20),
                nullable=False,
                server_default="recording",
            )
        )
        batch.add_column(sa.Column("coverage", sa.Numeric(4, 3), nullable=True))
        batch.add_column(sa.Column("total_gap_ms", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("longest_gap_ms", sa.Integer(), nullable=True))
        batch.add_column(
            sa.Column("gaps", _JSON, nullable=False, server_default=sa.text("'[]'"))
        )
        batch.add_column(sa.Column("capture_confidence", sa.Numeric(4, 3), nullable=True))
        batch.add_column(
            sa.Column(
                "capture_warnings", _JSON, nullable=False, server_default=sa.text("'[]'")
            )
        )
        batch.add_column(sa.Column("stop_reason", sa.String(length=30), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("meeting_tracks") as batch:
        for column in (
            "stop_reason",
            "capture_warnings",
            "capture_confidence",
            "longest_gap_ms",
            "total_gap_ms",
            "gaps",
            "coverage",
            "status",
            "ended_at",
        ):
            batch.drop_column(column)

    op.drop_index("ix_chunk_track_seq", table_name="track_chunks")
    op.drop_table("track_chunks")
