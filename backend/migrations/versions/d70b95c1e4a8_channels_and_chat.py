"""채널과 채팅 (요구사항 정의서 §6·§7)

    channels            텍스트 채널 · 음성 채널
    messages            채팅 메시지
    message_mentions    이 메시지가 부른 사람 (서버가 본문에서 뽑음)
    message_reactions   이모지 반응
    meetings.channel_id 회의가 열린 음성 채널

**왜 이제야 만드는가.** 정의서 §26 이 이걸 **1단계**로 정했는데 저장소는
3~5단계(AI 회의 분석·GitHub·보고서)부터 만들어져 있었습니다. `docs/20` 이
그 어긋남을 적어 둔 문서입니다.

⚠️ **`messages` 는 `contribution_events` 와 닿지 않습니다.**

정의서 §7 머리말이 "채팅 내용에 대한 AI 분석, 업무 자동 생성, 프로젝트
분석 등의 기능은 제공하지 않는다" 고 못 박습니다. 그냥 안 만든 게 아니라
**만들면 안 되는** 것입니다 — 이 제품은 사람의 기여를 숫자로 말하는데,
메시지가 기여로 세어지면 **도배가 기여도를 올리는 방법**이 됩니다. 회의
발언은 트랙·근거·신뢰도가 붙어 조작이 어렵지만 채팅은 아무나 무한히
칠 수 있습니다. `test_chat_is_not_measured.py` 가 그 경계를 지킵니다.

⚠️ **행을 지우는 삭제가 없습니다.** 채널을 지우면 `archived_at`, 메시지를
지우면 `deleted_at` 입니다. 채널을 통째로 지우면 남이 쓴 말이 같이
사라지고, 답글이 달린 말을 지우면 남의 답글이 허공에 뜹니다.

Revision ID: d70b95c1e4a8
Revises: c4a81e37f209
Create Date: 2026-08-12 06:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d70b95c1e4a8"
down_revision: str | Sequence[str] | None = "c4a81e37f209"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# ⚠️ **값을 여기 박아 둡니다. `db/vocab.py` 에서 끌어오지 마십시오.**
#    마이그레이션은 "이때 이렇게 적용했다" 는 기록입니다. vocab 을 import 하면
#    나중에 값을 더했을 때 이 파일의 글자도 같이 움직여 검사가 항상 통과하는데,
#    이미 적용된 데이터베이스의 제약은 그대로라 새 값이 거절됩니다.
#    상수로 빼지도 마십시오 — 검사는 이 파일을 **글자로** 읽습니다.

_PK = sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def upgrade() -> None:
    op.create_table(
        "channels",
        sa.Column("id", _PK, autoincrement=True, nullable=False),
        sa.Column("project_id", _PK, nullable=False),
        sa.Column("kind", sa.String(length=10), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_by", _PK, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("kind IN ('text','voice')", name="ck_channel_kind"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "kind", "name", name="uq_channel_name"),
    )
    op.create_index(
        "ix_channels_project_order", "channels", ["project_id", "position", "id"]
    )

    op.create_table(
        "messages",
        sa.Column("id", _PK, autoincrement=True, nullable=False),
        sa.Column("channel_id", _PK, nullable=False),
        sa.Column("author_id", _PK, nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("reply_to_id", _PK, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["channel_id"], ["channels.id"]),
        sa.ForeignKeyConstraint(["author_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["reply_to_id"], ["messages.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_messages_channel_time", "messages", ["channel_id", "id"])

    op.create_table(
        "message_mentions",
        sa.Column("message_id", _PK, nullable=False),
        sa.Column("user_id", _PK, nullable=False),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("message_id", "user_id"),
    )

    op.create_table(
        "message_reactions",
        sa.Column("message_id", _PK, nullable=False),
        sa.Column("user_id", _PK, nullable=False),
        sa.Column("mark", sa.String(length=16), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "mark IN ('agree','ok','question','thanks')", name="ck_reaction_mark"
        ),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        # ⚠️ 기본키가 (메시지, 사람) 이라 **한 사람당 하나**입니다. mark 를
        #    키에 넣으면 한 사람이 넷을 다 달아 반응 수를 부풀립니다.
        sa.PrimaryKeyConstraint("message_id", "user_id"),
    )

    # ⚠️ 기존 회의는 `channel_id` 가 널로 남습니다. 아무 채널에나 밀어 넣으면
    #    **없던 사실을 만드는** 것입니다 — 그 회의들은 채널 밖에서 열렸습니다.
    op.add_column("meetings", sa.Column("channel_id", _PK, nullable=True))
    with op.batch_alter_table("meetings") as batch:
        batch.create_foreign_key(
            "fk_meetings_channel_id", "channels", ["channel_id"], ["id"]
        )


def downgrade() -> None:
    with op.batch_alter_table("meetings") as batch:
        batch.drop_constraint("fk_meetings_channel_id", type_="foreignkey")
        batch.drop_column("channel_id")
    op.drop_table("message_reactions")
    op.drop_table("message_mentions")
    op.drop_index("ix_messages_channel_time", table_name="messages")
    op.drop_table("messages")
    op.drop_index("ix_channels_project_order", table_name="channels")
    op.drop_table("channels")
