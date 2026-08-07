"""LLM 이 만든 것을 버리지 않는다

파이프라인은 회의 하나에서 다섯 가지를 만듭니다 — 요약·결정·업무 후보·
미해결 사안·다음 안건. 그중 **셋이 저장 단계에서 버려지고 있었습니다.**

    supersedes         Celery 페이로드까지 실려 오는데 `m.Decision(...)` 이
                       안 씀 → `supersedes_id` 가 **영원히 NULL**.
                       결정 번복 추적은 표만 있고 데이터가 없는 기능이었다
    next_agenda        `_serialize` 에 아예 없음 → 파이프라인 밖으로 나온 적 없음
    unresolved_issues  같음

전부 검증(`validation.py`)을 통과한 산출물입니다 — 근거 발화 id 가 실재하는지
확인까지 마친 것들이 그대로 버려졌습니다. 그리고 회의 재처리는 사람이
검토한 뒤에는 거부되므로(`5번 결함`), 이건 **영구 손실**이었습니다.

    meetings.next_agenda        다음 회의 안건 (근거 발화가 없어 회의에 붙인다)
    decisions.supersedes_hint   id 를 못 찾았을 때의 원문

미해결 사안은 새 컬럼이 필요 없습니다 — `meeting_events` 의
`unanswered_question` 이 정확히 그 자리이고, 근거 발화 id 도 들어갑니다.

`supersedes_hint` 를 따로 두는 이유: LLM 에게 넘긴 `prior_decisions` 는
우리가 준 원문 목록이라 대개 정확히 일치하지만, 바꿔 쓰면 못 찾습니다.
그때 **추측해서 아무 결정이나 뒤집힌 것으로 표시하면** 회의 기록이
틀려집니다. 사람이 보고 고칠 수 있게 남깁니다.

Revision ID: b8e1c37a49f2
Revises: a7d4e2f91c05
Create Date: 2026-08-07 01:40:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b8e1c37a49f2"
down_revision: str | Sequence[str] | None = "a7d4e2f91c05"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: 모델의 `JSONType` 과 같은 것. PostgreSQL 은 JSONB, 그 외는 JSON.
_JSON = sa.JSON().with_variant(sa.dialects.postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.add_column("meetings", sa.Column("next_agenda", _JSON, nullable=True))
    op.add_column("decisions", sa.Column("supersedes_hint", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("decisions") as batch:
        batch.drop_column("supersedes_hint")
    with op.batch_alter_table("meetings") as batch:
        batch.drop_column("next_agenda")
