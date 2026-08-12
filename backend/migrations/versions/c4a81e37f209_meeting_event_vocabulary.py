"""회의 분석 이벤트에 어휘를 준다

    meeting_events.event_type  CHECK — `db/vocab.py` 의 MeetingEventType 만
    meeting_events.end_ms      CHECK — 끝이 시작보다 앞설 수 없다

**같은 결함의 세 번째 사례입니다.** `speaker_source` 는 값이 다섯 곳에서
갈라져 있었고(결함 118), `report_type` 은 주석 한 줄이 전부였으며(결함 119),
이 열은 **둘 다**입니다 — 주석이 다섯 값을 선언하는데 CHECK 제약은 없고,
그중 실제로 만들어지는 것은 `unanswered_question` 하나뿐입니다.

⚠️ **제약에는 다섯을 다 넣습니다.** `speaker_source` 와 다른 판단인데,
저쪽은 못 만드는 값을 데이터베이스가 거절해야 "앞단이 없다" 는 사실이
드러납니다. 이쪽은 탐지기 코드만 붙으면 곧바로 값이 들어오므로, 그때
마이그레이션을 또 하게 만들 이유가 없습니다. "아직 안 나온다" 는 사실은
`vocab.EVENT_NOT_PRODUCED_YET` 과 테스트가 지킵니다.

⚠️ **기존 행이 있을 수 있습니다.** 지금 만들어지는 값은 하나뿐이고 그것도
어휘 안에 있으므로 제약을 어기는 행은 없습니다. 그래도 SQLite 는
batch_alter_table 이 표를 다시 만들며 검사하므로, 어긋나면 여기서 터집니다 —
조용히 넘어가는 것보다 낫습니다.

Revision ID: c4a81e37f209
Revises: b3f7c02e8a15
Create Date: 2026-08-11 22:30:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "c4a81e37f209"
down_revision: str | Sequence[str] | None = "b3f7c02e8a15"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# ⚠️ **값을 여기 박아 둡니다. `db/vocab.py` 에서 끌어오지 마십시오.**
#    마이그레이션은 "이때 이렇게 적용했다" 는 기록입니다. vocab 을 import 하면
#    나중에 값을 더했을 때 이 파일의 글자도 같이 움직여 검사가 항상 통과하는데,
#    이미 적용된 데이터베이스의 제약은 그대로라 새 값이 거절됩니다.
#    상수로 빼지도 마십시오 — 검사는 이 파일을 **글자로** 읽습니다.


def upgrade() -> None:
    with op.batch_alter_table("meeting_events") as batch:
        batch.create_check_constraint(
            "ck_meeting_event_type",
            "event_type IN ('decision_conflict','incomplete_task',"
            "'repeated_discussion','topic_drift','unanswered_question')",
        )
        batch.create_check_constraint("ck_meeting_event_span", "end_ms >= start_ms")


def downgrade() -> None:
    with op.batch_alter_table("meeting_events") as batch:
        batch.drop_constraint("ck_meeting_event_span", type_="check")
        batch.drop_constraint("ck_meeting_event_type", type_="check")
