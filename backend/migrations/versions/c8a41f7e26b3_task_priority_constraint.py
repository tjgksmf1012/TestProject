"""업무 우선순위에 제약을 건다 (요구사항 정의서 TASK-007)

## ⚠️ 칸만 있고 아무도 안 읽고 있었습니다

`tasks.priority` 는 `Integer NOT NULL DEFAULT 2` 로 진작 있었고, 검색
API(`/api/projects/{id}/search?priority=`)는 이 값으로 거르기까지
했습니다. 그런데 **사람이 값을 정할 자리도 볼 자리도 없었습니다** —
있지도 않은 값으로 거를 수 있는 필터였습니다.

이 저장소의 실패 ①(만들어 놓고 아무도 안 부름)과 ③(할 일을 알려 주고
그 일을 할 자리를 안 줌)이 겹친 자리입니다.

## 제약이 없어서 무엇이든 들어갔습니다

`status` 가 그랬던 것(`a7d3f0e51b62`)과 같은 부류입니다 — `Integer` 라
`-1` 도 `99` 도 받았고, 그런 값이 들어오면 화면은 라벨을 못 찾아
**빈 칸**을 그립니다. 값을 `db/vocab.py` 의 `TaskPriority` 로 옮기면서
제약도 같이 겁니다.

## ⚠️ 작을수록 급합니다

`0 긴급 · 1 높음 · 2 보통 · 3 낮음`. 방향을 헷갈리면 정렬이 조용히
뒤집힙니다.

## ⛔ 기여도에 연결하지 마십시오

우선순위가 점수에 닿는 순간 드롭다운 하나가 점수 발행기가 됩니다.
이건 "무엇부터 볼까" 를 정하는 값이지 "누가 잘했나" 가 아닙니다.

Revision ID: c8a41f7e26b3
Revises: b7d2f5a91c04
Create Date: 2026-08-19 02:10:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "c8a41f7e26b3"
down_revision: str | Sequence[str] | None = "b7d2f5a91c04"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# ⚠️ **값을 여기 박아 둡니다. `db/vocab.py` 에서 끌어오지 마십시오.**
#    마이그레이션은 "이때 이렇게 적용했다" 는 기록입니다.


def upgrade() -> None:
    # ⚠️ 제약을 걸기 **전에** 범위 밖 값을 보통(2)으로 끌어옵니다.
    #    제약이 없던 열이라 이상한 값이 이미 들어 있을 수 있고, 그러면
    #    배포가 여기서 멈춥니다. 여기서는 **지우지 않고 기본값으로**
    #    옮깁니다 — 우선순위는 업무의 부수적 성질이라 값 하나 때문에
    #    업무를 잃는 편이 훨씬 나쁩니다.
    op.execute("UPDATE tasks SET priority = 2 WHERE priority NOT IN (0, 1, 2, 3)")
    with op.batch_alter_table("tasks") as batch:
        batch.create_check_constraint("ck_task_priority", "priority IN (0, 1, 2, 3)")


def downgrade() -> None:
    # 값은 그대로 둡니다 — 제약만 풉니다. 되돌린다고 사람이 정한
    # 우선순위를 지울 이유가 없습니다.
    with op.batch_alter_table("tasks") as batch:
        batch.drop_constraint("ck_task_priority", type_="check")
