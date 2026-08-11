"""보고서에 어휘와 유일 제약을 준다

    reports.report_type   CHECK — `db/vocab.py` 의 ReportType 만
    reports.meeting_id    회의록이 매인 회의 (FK)
    reports.scope_key     무엇 하나에 매였는지 — 유일 제약이 쓰는 열

**왜 지금인가.** `reports` 표는 처음부터 있었는데 **쓰는 코드가 0곳**
이었습니다. 그래서 허용값이 주석 한 줄(`# weekly | final | meeting_minutes`)로만
있어도 아무도 알아차릴 일이 없었습니다. 주석은 아무것도 막지 않습니다 —
`String(20)` 이라 `"Weekly"` 도 `"주간"` 도 들어갑니다.

**왜 `scope_key` 라는 열을 따로 두는가.** 보고서를 다시 만들면 갈아끼워야지
쌓이면 안 됩니다. 이 저장소는 그 결함을 이미 한 번 당했습니다 — 미해결
사안이 재처리마다 한 벌씩 쌓였습니다. 보고서에서 그러면 "최종 보고서" 가
여러 벌 생기고 어느 것이 진짜인지 아무도 모릅니다.

그런데 `(project_id, report_type, period_start, period_end)` 로는 못 막습니다.
최종 보고서는 기간이 없어 두 칸이 널인데, **널은 서로 다른 값으로 쳐서**
같은 행이 몇 번이고 들어갑니다. 그래서 널이 될 수 있는 열들 대신 **널이 아닌
열 하나**로 모으고 거기에 유일 제약을 겁니다.

⚠️ **기존 행은 없습니다** — 쓰는 코드가 0곳이었으므로. 그래서 `scope_key` 를
곧바로 `nullable=False` 로 만들 수 있습니다. 채워 넣을 것이 없습니다.

Revision ID: b3f7c02e8a15
Revises: a71e3f9c8b02
Create Date: 2026-08-11 20:10:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b3f7c02e8a15"
down_revision: str | Sequence[str] | None = "a71e3f9c8b02"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# ⚠️ **값을 여기 박아 둡니다. `db/vocab.py` 에서 끌어오지 마십시오.**
#
# 모델은 vocab 에서 끌어오는 게 맞지만 마이그레이션은 반대입니다. 마이그레이션은
# "이때 이렇게 적용했다" 는 **기록**입니다. 여기서 vocab 을 import 해 문자열을
# 만들면, 나중에 누가 vocab 에 값을 더했을 때 이 파일의 **글자도 같이 움직여**
# 검사가 항상 통과합니다 — 그런데 이미 적용된 데이터베이스의 제약은 그대로라
# 새 값이 거절됩니다. 검사가 잡으라고 있는 바로 그 상황에서 눈을 감는 것입니다.
#
# 값을 늘리면 아래 제약이 `vocab` 과 어긋나고, `test_column_vocabularies.py` 가
# "새 마이그레이션이 필요합니다" 라고 알려 줍니다. 그게 맞는 동작입니다.
#
# ⚠️ 상수로 빼지도 마십시오. 검사는 이 파일을 **글자로** 읽으므로, 값이
#    다른 줄에 있으면 제약 표현식에서 아무것도 못 찾고 빈 목록을 봅니다.


def upgrade() -> None:
    op.add_column(
        "reports",
        sa.Column(
            "meeting_id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            nullable=True,
        ),
    )
    # 기존 행이 없으므로 곧바로 NOT NULL 로 만듭니다.
    op.add_column(
        "reports",
        sa.Column("scope_key", sa.String(length=64), nullable=False),
    )
    with op.batch_alter_table("reports") as batch:
        batch.create_foreign_key(
            "fk_reports_meeting_id", "meetings", ["meeting_id"], ["id"]
        )
        batch.create_check_constraint(
            "ck_report_type",
            "report_type IN ('final','meeting_minutes','weekly')",
        )
        batch.create_unique_constraint(
            "uq_report_scope", ["project_id", "report_type", "scope_key"]
        )


def downgrade() -> None:
    with op.batch_alter_table("reports") as batch:
        batch.drop_constraint("uq_report_scope", type_="unique")
        batch.drop_constraint("ck_report_type", type_="check")
        batch.drop_constraint("fk_reports_meeting_id", type_="foreignkey")
        batch.drop_column("scope_key")
        batch.drop_column("meeting_id")
