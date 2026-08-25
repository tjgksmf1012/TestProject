"""알림이 **어느 GitHub 사건인지** 가리킨다 (결함 396)

## ⚠️ 같은 글자가 두 줄, 그중 하나는 **추정**이었습니다

`notifications` 는 일부러 문장을 저장하지 않고 「무엇을 가리키는지」만
담습니다(업무 번호·메시지 번호). GitHub 알림은 `task_id` 만 채웁니다.

결함 357 이 그 자리에 문장을 만들 때 이렇게 적었습니다 —

> 이 집합이 하나뿐이면 그 하나의 이름을 그대로 말할 수 있습니다.
> ⛔ 둘 이상으로 늘리려면 알림 쪽을 같이 고쳐야 합니다 … 그때는 알림
> 행이 사건을 가리키게(`github_event_id`) 만드는 것이 맞습니다.

집합은 안 늘었는데 **같은 종류의 사건이 둘** 오면 똑같은 일이 납니다.
한 업무에 PR 이 둘 붙으면 알림이 두 줄인데 글자도 시각도 링크도 같아서
**어느 PR 인지 알 방법이 없습니다.** 재현했습니다(서명한 웹훅 둘).

그리고 더 나쁜 쪽 — 그 둘 중 하나가 `link_source=branch` **추정**이어도
확정과 **한 자도 다르지 않습니다.** 같은 저장소의 `sortLinks` 주석이
그 해악을 이미 적어 뒀습니다: 「추정이 위에 있으면 그게 사실로 보이고,
"이 업무는 이 PR 로 끝났다" 를 틀리게 믿습니다」.

## 왜 칸이 하나 더 필요한가

「어느 사건인가」는 **가리키는 것**이지 문장이 아닙니다 — 이 표의 원칙
그대로입니다. 문장은 읽을 때 만들고(`_text_for`), 확정/추정은 그 사건과
업무를 잇는 `task_github_links.relevance` 에서 그때 읽습니다. 알림 행에
「추정」이라고 **적어 두지 않습니다** — 사람이 나중에 확인해서 확정으로
바꾸면 그 글자만 옛말이 되기 때문입니다.

Revision ID: f3c07a92b6d1
Revises: d5b93a1c07f2
Create Date: 2026-08-25 18:05:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f3c07a92b6d1"
down_revision: str | Sequence[str] | None = "d5b93a1c07f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ⚠️ nullable 입니다. GitHub 말고 다른 종류(멘션·담당·회의)는 영영
    #    비어 있고, **이미 쌓인 GitHub 알림도** 비어 있습니다 — 그때는
    #    어느 사건이었는지 알 방법이 없고, 모르는 것은 모른다고 둡니다.
    with op.batch_alter_table("notifications") as batch:
        batch.add_column(sa.Column("github_event_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(
            "fk_notifications_github_event",
            "github_events",
            ["github_event_id"],
            ["id"],
        )


def downgrade() -> None:
    # ⚠️ 되돌리면 **알림이 다시 어느 PR 인지 못 가리킵니다.** 한 업무에
    #    PR 이 둘 붙은 사람은 똑같은 두 줄을 보게 됩니다(결함 396).
    with op.batch_alter_table("notifications") as batch:
        batch.drop_constraint("fk_notifications_github_event", type_="foreignkey")
        batch.drop_column("github_event_id")
