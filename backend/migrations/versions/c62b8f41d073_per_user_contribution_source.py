"""한 근거에서 여러 사람의 기여 이벤트가 나올 수 있게 한다

`contribution_events` 의 유니크 제약이 이랬습니다.

    (source_kind, source_id, event_type)

웹훅 재전송·백필 중복을 막으려고 만든 것이고 그 목적에는 맞습니다. 그런데
**하나의 근거에서 여러 사람의 이벤트가 나오는 경우를 막습니다.**

회의 하나에 참석자가 셋이면 `meeting_attended` 는 이렇게 됩니다.

    user 1: 기록됨
    user 2: 실패 — UNIQUE constraint failed
    user 3: 실패 — UNIQUE constraint failed

참석자 3명 중 **1명만** 기여도에 잡히고, 나머지 둘은 회의에 참석했는데도
참석 기록이 없습니다. 그리고 그건 "참석 안 함"(0점)으로 읽힙니다.

`user_id` 를 제약에 넣으면 해결됩니다. **중복 방어는 그대로입니다** —
GitHub 이벤트는 행위자가 하나라 `user_id` 가 붙어도 같은 행으로 막히고,
같은 발화에서 같은 유형의 이벤트가 두 번 나오는 것도 여전히 막힙니다.

⚠️ 제약을 **넓히는** 방향이라 기존 데이터와 충돌할 수 없습니다. 지금
통과하는 행은 전부 새 제약도 통과합니다.

Revision ID: c62b8f41d073
Revises: d4a92f10b7c3
Create Date: 2026-08-07 04:20:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "c62b8f41d073"
down_revision: str | Sequence[str] | None = "d4a92f10b7c3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NAME = "uq_contribution_source"
_TABLE = "contribution_events"


def upgrade() -> None:
    # batch 모드인 이유: SQLite 는 제약을 ALTER 로 바꿀 수 없어 표를 다시
    # 만들어야 합니다. PostgreSQL 에서는 그냥 DROP/ADD 로 나갑니다.
    with op.batch_alter_table(_TABLE) as batch:
        batch.drop_constraint(_NAME, type_="unique")
        batch.create_unique_constraint(
            _NAME, ["source_kind", "source_id", "event_type", "user_id"]
        )


def downgrade() -> None:
    # ⚠️ 되돌리면 한 회의의 참석자 중 한 명만 남습니다. 그 상태로 되돌릴
    # 일이 있다면 사람이 먼저 중복을 정리해야 합니다 — 여기서 자동으로
    # 지우면 **누구의 기여를 지울지 코드가 고르는** 일이 됩니다.
    with op.batch_alter_table(_TABLE) as batch:
        batch.drop_constraint(_NAME, type_="unique")
        batch.create_unique_constraint(
            _NAME, ["source_kind", "source_id", "event_type"]
        )
