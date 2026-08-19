"""동시 발언 급증을 회의 사건 어휘에 더한다 (정의서 §12 `AI-REVIEW-008`)

## 무엇이 없었나

겹침 자체는 진작 탐지하고 있었습니다 — `multitrack` 이 세그먼트마다
`is_overlap` 을 매기고 그 값이 `utterances` 에 저장됩니다. 없던 것은
**"늘었다" 는 판정**입니다.

회의 내내 조금씩 겹치는 것은 정상적인 대화입니다. 볼 만한 신호는 특정
구간에서 **바탕보다 갑자기 늘어난** 것이고, 그걸 판정하는 코드가 저장소
어디에도 없었습니다.

## ⚠️ 이건 회의에 대한 관찰이지 사람에 대한 것이 아닙니다

`detail` 에 **누가 겹쳤는지는 안 넣습니다.** 넣으면 화면이 적고, 그 순간
"말 끊은 사람" 표시가 됩니다 — 겹침은 두 사람 사이의 일이지 한 사람의
잘못이 아닙니다. `AI-REVIEW-007`(발언 편중)이 이름을 안 내보내는 것과
같은 원칙입니다.

`severity` 도 `info` 입니다. 격론이 벌어진 구간은 회의에서 제일 중요한
자리일 수 있습니다.

Revision ID: d5b93a1c07f2
Revises: c8a41f7e26b3
Create Date: 2026-08-19 03:05:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "d5b93a1c07f2"
down_revision: str | Sequence[str] | None = "c8a41f7e26b3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# ⚠️ **값을 여기 박아 둡니다. `db/vocab.py` 에서 끌어오지 마십시오.**
#    마이그레이션은 "이때 이렇게 적용했다" 는 기록입니다.

def upgrade() -> None:
    # ⚠️ **값을 글자로 적습니다.** f-string 으로 만들면 어휘 대조 가드가
    #    이 파일을 읽을 수 없어 "제약이 비었다" 로 잡습니다 — 실제로
    #    그렇게 잡혔습니다.
    with op.batch_alter_table("meeting_events") as batch:
        batch.drop_constraint("ck_meeting_event_type", type_="check")
        batch.create_check_constraint(
            "ck_meeting_event_type",
            "event_type IN ('decision_conflict','incomplete_task','overlap_surge',"
            "'repeated_discussion','topic_drift','unanswered_question')",
        )


def downgrade() -> None:
    # ⚠️ 되돌리기 전에 이 종류의 행을 **지웁니다.** 제약을 좁히기만 하면
    #    이미 들어간 행 때문에 배포가 여기서 멈춥니다. 이건 탐지 결과라
    #    다시 돌리면 나오는 값이고, 지워도 잃는 것이 없습니다 —
    #    `inefficiency_service.detect` 가 매번 `forget` 하고 다시 씁니다.
    op.execute("DELETE FROM meeting_events WHERE event_type = 'overlap_surge'")
    with op.batch_alter_table("meeting_events") as batch:
        batch.drop_constraint("ck_meeting_event_type", type_="check")
        batch.create_check_constraint(
            "ck_meeting_event_type",
            "event_type IN ('decision_conflict','incomplete_task',"
            "'repeated_discussion','topic_drift','unanswered_question')",
        )
