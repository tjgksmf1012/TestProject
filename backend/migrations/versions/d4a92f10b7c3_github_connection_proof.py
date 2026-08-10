"""연결됐다는 증거를 기록한다

세 가지를 더합니다.

    projects.github_repo_key      웹훅이 프로젝트를 찾는 대조용 표기(소문자)
    projects.github_verified_at   서명된 배달이 처음 도착한 시각
    github_unlinked_deliveries    어느 프로젝트에도 안 붙은 배달의 흔적

**왜 대조용 표기가 따로 필요한가.** 웹훅 본문의 `repository.full_name` 은
GitHub 의 정식 표기(`tjgksmf1012/TestProject`)로 옵니다. 사람은 설정 화면에
소문자로 적습니다(`tjgksmf1012/testproject`). PostgreSQL 의 `=` 는 대소문자를
구분하므로 둘은 다른 문자열이고, 웹훅 처리기는 "연결되지 않은 저장소" 로
보고 **조용히 버립니다.** 팀은 PR 을 백 번 병합해도 기여도가 0 이고 오류는
어디에도 남지 않습니다.

**왜 유니크인가.** 대조를 대소문자 무시로 바꾸는 순간, 지금까지 `team/x` 와
`team/X` 로 나뉘어 있던 두 프로젝트가 **같은 저장소를 가리키게** 됩니다.
그러면 배달이 어느 쪽에 붙을지 정해지지 않습니다. 응용 코드의 검사만으로는
동시에 들어온 두 요청을 막을 수 없어 DB 제약으로 못 박습니다.

⚠️ **이 마이그레이션은 기존 충돌을 스스로 고치지 않습니다.** 대소문자만
다르게 같은 저장소를 쓰던 프로젝트가 이미 있으면 멈추고 사람에게 알립니다.
한쪽을 골라 지우는 것은 **어느 팀의 기여도를 지울지 고르는 일**이고,
그건 코드가 할 판단이 아닙니다.

Revision ID: d4a92f10b7c3
Revises: b8e1c37a49f2
Create Date: 2026-08-07 02:40:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d4a92f10b7c3"
down_revision: str | Sequence[str] | None = "b8e1c37a49f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PK = sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def upgrade() -> None:
    op.add_column(
        "projects", sa.Column("github_repo_key", sa.String(255), nullable=True)
    )
    op.add_column(
        "projects",
        sa.Column("github_verified_at", sa.DateTime(timezone=True), nullable=True),
    )

    bind = op.get_bind()

    # 기존 행 채우기.
    bind.execute(
        sa.text(
            "UPDATE projects SET github_repo_key = lower(trim(github_repo)) "
            "WHERE github_repo IS NOT NULL AND trim(github_repo) <> ''"
        )
    )

    # 충돌 확인. 있으면 여기서 멈춥니다.
    clashes = bind.execute(
        sa.text(
            "SELECT github_repo_key, count(*) AS n FROM projects "
            "WHERE github_repo_key IS NOT NULL "
            "GROUP BY github_repo_key HAVING count(*) > 1"
        )
    ).fetchall()
    if clashes:
        names = ", ".join(f"{row[0]} ({row[1]}개 프로젝트)" for row in clashes)
        raise RuntimeError(
            "같은 저장소를 대소문자만 다르게 쓰는 프로젝트가 있습니다: "
            f"{names}. 어느 프로젝트가 이 저장소를 쓸지 사람이 정한 뒤 "
            "나머지의 github_repo 를 비우고 다시 실행하세요. "
            "여기서 자동으로 고르면 한 팀의 GitHub 기여도가 근거 없이 사라집니다."
        )

    # 제약이 아니라 인덱스인 이유: SQLite 는 `ALTER TABLE ... ADD CONSTRAINT`
    # 를 지원하지 않습니다. 유니크 인덱스는 두 DB 에서 같은 보장을 줍니다.
    op.create_index(
        "uq_projects_github_repo_key", "projects", ["github_repo_key"], unique=True
    )

    # 서명이 검증된 배달만 여기 옵니다. `verified_at` 은 그 사실의 기록이고,
    # 기존 행에는 채울 근거가 없으므로 NULL 로 둡니다 — 모르는 것을 아는 척
    # 하면 신뢰도가 근거 없이 올라갑니다.

    op.create_table(
        "github_unlinked_deliveries",
        sa.Column("id", _PK, primary_key=True),
        sa.Column("repo_key", sa.String(255), nullable=False),
        sa.Column("repo", sa.String(255), nullable=False),
        sa.Column("delivery_count", sa.Integer(), nullable=False, server_default="1"),
        sa.Column(
            "first_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("repo_key", name="uq_unlinked_repo"),
    )


def downgrade() -> None:
    op.drop_table("github_unlinked_deliveries")
    op.drop_index("uq_projects_github_repo_key", table_name="projects")
    with op.batch_alter_table("projects") as batch:
        batch.drop_column("github_verified_at")
        batch.drop_column("github_repo_key")
