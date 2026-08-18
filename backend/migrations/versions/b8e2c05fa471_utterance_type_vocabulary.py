"""발언 유형을 요구대로 가르고, 제약이 없던 열에 제약을 건다 (정의서 §10)

## ⚠️ 이 열에도 **제약이 아예 없었습니다** — 같은 부류 다섯 번째

허용값이 `meeting/utterance_types.py` 의 `LABELS` 튜플 하나뿐이었고
데이터베이스는 `String(20)` 이라 무엇이든 받았습니다.
`speaker_source`(118) · `report_type`(119) · `meeting_events`(122) ·
`tasks.status`(132) 에 이은 다섯 번째입니다.

## ⚠️ 라벨 여덟 개가 요구 열 개와 **1:1 이 아니었습니다**

동의(`AI-SPEECH-004`) · 반대(`005`) · 보완(`006`)이 전부 `opinion` 하나로
뭉개져 있었고, 업무 요청(`008`)과 확인 요청(`010`)은 아예 없었습니다.

그래서 `REVIEW-005`("동의 수 · 반대 의견 수")를 **셀 수가 없었습니다.**
화면부터 만들었으면 0 이 뜨거나 빈 칸이 생겼을 것입니다.

## 옛 값은 그대로 둡니다

새 목록이 옛 여덟 개를 **전부 포함**합니다(`opinion` 은 "어느 쪽도 아닌
의견" 으로 남습니다). 그래서 이미 매겨진 발화를 건드릴 것이 없습니다.

⚠️ **다시 분류하지 않습니다.** 옛 `opinion` 을 지금 규칙으로 다시 돌리면
사람이 손으로 고친 것까지 덮어씁니다. 새로 처리하는 회의부터 갈린 라벨이
붙고, 옛 회의는 `opinion` 인 채로 남습니다 — 화면이 그것을 "의견" 이라고
정직하게 부릅니다.

Revision ID: b8e2c05fa471
Revises: a7d3f0e51b62
Create Date: 2026-08-12 08:20:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "b8e2c05fa471"
down_revision: str | Sequence[str] | None = "a7d3f0e51b62"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# ⚠️ **값을 여기 박아 둡니다. `db/vocab.py` 에서 끌어오지 마십시오.**
#    마이그레이션은 "이때 이렇게 적용했다" 는 기록입니다. 끌어오면 나중에
#    어휘가 바뀔 때 **과거의 기록까지 같이 바뀝니다.**

_ALLOWED = (
    "agreement",
    "answer",
    "commitment",
    "confirmation",
    "decision",
    "objection",
    "opinion",
    "other",
    "proposal",
    "question",
    "refinement",
    "request",
    "social",
)

# ⚠️ `NULL` 을 **허용해야 합니다.** 아직 분류하지 않은 발화가 그것이고,
#    `other`("모르겠음")와 뜻이 다릅니다. 빼먹으면 녹음만 끝나고 분석 전인
#    회의의 발화가 전부 거절됩니다.
_CHECK = "utterance_type IS NULL OR utterance_type IN (" + ",".join(
    f"'{v}'" for v in _ALLOWED
) + ")"


def upgrade() -> None:
    with op.batch_alter_table("utterances") as batch:
        batch.create_check_constraint("ck_utterance_type", _CHECK)


def downgrade() -> None:
    # ⚠️ 되돌려도 **값은 그대로 둡니다.** 옛 제약이 없었으므로 되돌린 뒤에도
    #    `agreement` 같은 값이 그냥 남아 있으면 됩니다. 여기서 `opinion` 으로
    #    합쳐 버리면 되돌렸다 다시 올릴 때 갈라 둔 것이 영영 사라집니다.
    with op.batch_alter_table("utterances") as batch:
        batch.drop_constraint("ck_utterance_type", type_="check")
