"""업무 상태에 `review` 를 더한다 (요구사항 정의서 TASK-004)

## ⚠️ 이 열에는 **제약이 아예 없었습니다**

허용값이 `services/task_service.py` 의 튜플 하나뿐이었고 데이터베이스는
`String(20)` 이라 무엇이든 받았습니다 — `"Done"` 도 `"완료"` 도
`"todo "`(뒤 공백)도. 서비스를 안 거치는 경로가 하나라도 생기면 칸반에
**어느 열에도 안 속하는 카드**가 생기고, 화면에서는 그냥 사라진 것처럼
보입니다.

`speaker_source`·`report_type`·`meeting_events.event_type` 에 이은 **네 번째**
같은 부류입니다. 값을 `db/vocab.py` 로 옮기면서 제약도 같이 겁니다.

## ⚠️ 넷째 열이 왜 필요한가

`review` 가 없던 동안 "다 만들었는데 아직 아무도 안 본" 일이 `in_progress`
와 `done` 어느 쪽에도 정확히 안 맞았습니다 — `done` 에 두면 검토를 건너뛴
것이 완료로 보이고, `in_progress` 에 두면 만든 사람이 아직 붙잡고 있는
것처럼 보입니다.

⚠️ **`review` 는 완료로 세지 않습니다** (`vocab.TASK_FINISHED`). 검토 중인
일을 완료로 세면 진행률이 실제보다 높게 나옵니다.

Revision ID: a7d3f0e51b62
Revises: f1a4b8c209de
Create Date: 2026-08-12 06:40:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "a7d3f0e51b62"
down_revision: str | Sequence[str] | None = "f1a4b8c209de"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# ⚠️ **값을 여기 박아 둡니다. `db/vocab.py` 에서 끌어오지 마십시오.**
#    마이그레이션은 "이때 이렇게 적용했다" 는 기록입니다.


def upgrade() -> None:
    # ⚠️ 제약을 걸기 **전에** 지금 값이 다 통과하는지 확인합니다. 제약이
    #    없던 열이라 이상한 값이 이미 들어 있을 수 있고, 그러면 배포가
    #    여기서 멈춥니다 — 멈추는 편이 낫습니다(조용히 지우면 안 됩니다).
    with op.batch_alter_table("tasks") as batch:
        batch.create_check_constraint(
            "ck_task_status", "status IN ('done','in_progress','review','todo')"
        )


def downgrade() -> None:
    # ⚠️ 되돌리면 `review` 인 업무가 **어느 열에도 안 속하게** 됩니다.
    #    지우지 않고 `in_progress` 로 되돌립니다 — 검토 중인 것은 아직
    #    끝난 것이 아니므로 `done` 이 아니라 이쪽입니다.
    op.execute("UPDATE tasks SET status = 'in_progress' WHERE status = 'review'")
    with op.batch_alter_table("tasks") as batch:
        batch.drop_constraint("ck_task_status", type_="check")
