"""회의 → 기여 이벤트.

## 기여도의 세 다리 중 마지막

    칸반 업무 완료 → 기여 이벤트   ✅ task_service._record_completion
    GitHub 활동   → 기여 이벤트   ✅ github_ingest_service
    회의 발화     → 기여 이벤트   ← 이 모듈 (그 전까지 **운영 코드에 0곳**)

`scoring.py` 는 `UTT_DECISION`(5.0) · `UTT_COMMITMENT`(1.5/6.0) 같은
가중치를 정확히 알고 있었는데 **그 이벤트를 만드는 코드가 없었습니다.**
즉 운영에서 회의 기여도는 언제나 0이었고, 시연 화면의 숫자는
`seed_demo.py` 가 손으로 넣은 것이었습니다.

하필 **회의 분석 시스템에서 회의 쪽 다리**입니다.

## 무엇을 조심하는가

**화자가 확정되지 않은 발화는 아무에게도 주지 않습니다.** 화자 미상
발언을 아무에게나 붙이면 그건 측정이 아니라 오답입니다 (docs/05 §5).
멀티트랙에서는 트랙=사람이라 대부분 확정되지만, 모드 B(단일 파일)의
`SPEAKER_XX` 는 사람이 이름을 매기기 전까지 주인이 없습니다.

**재처리하면 이벤트가 두 배가 됩니다.** `persist_results_task` 는 발화를
지우고 새로 만드는데, 옛 발화에 딸린 기여 이벤트를 같이 지우지 않으면
같은 회의가 두 번 계산됩니다. 그래서 발화를 지우기 **전에**
`forget_meeting_events` 를 부릅니다.

**0점 라벨은 이벤트를 만들지 않습니다.** `social`·`other` 는 어차피 0점
이고, 행만 늘리면 조작 탐지(`mostly_social_utterances`)의 분모가 흐려집니다
— 라고 생각하기 쉬운데 **틀렸습니다.** 그 탐지가 바로 "맞장구 비율" 을
보므로 `social` 은 **반드시 기록해야** 합니다. 자세한 것은 아래 주석.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from teamflow.contribution.events import CATEGORY_OF, EventType
from teamflow.db import models as m
from teamflow.meeting import utterance_types as ut

logger = logging.getLogger(__name__)

Classifier = Callable[[str], ut.Classification]

#: 이 회의에서 나온 기여 이벤트의 근거 종류.
_UTTERANCE = "utterance"
_MEETING = "meeting"


def _event_type_for(label: str) -> EventType:
    return EventType(f"utt_{label}")


def forget_meeting_events(session: Session, meeting_id: int) -> int:
    """이 회의에서 나온 기여 이벤트를 지운다.

    ⚠️ **발화를 지우기 전에** 불러야 합니다. 발화가 사라지면 어떤 이벤트가
    이 회의 것이었는지 알 방법이 없어지고, 남은 이벤트는 주인 없는 점수가
    됩니다.

    `ContributionEventRow` 는 "INSERT 만, UPDATE/DELETE 없음" 이 원칙인데
    여기서는 지웁니다. 그 원칙은 **확정된 사실**을 정정할 때의 이야기이고,
    여기서 지우는 것은 곧바로 다시 만들 **파생 결과**입니다. 안 지우면
    같은 회의가 두 번 계산돼 점수가 두 배가 됩니다.
    """
    utterance_ids = list(
        session.scalars(
            select(m.Utterance.id).where(m.Utterance.meeting_id == meeting_id)
        )
    )

    removed = 0
    if utterance_ids:
        for row in session.scalars(
            select(m.ContributionEventRow).where(
                m.ContributionEventRow.source_kind == _UTTERANCE,
                m.ContributionEventRow.source_id.in_(utterance_ids),
            )
        ).all():
            session.delete(row)
            removed += 1

    for row in session.scalars(
        select(m.ContributionEventRow).where(
            m.ContributionEventRow.source_kind == _MEETING,
            m.ContributionEventRow.source_id == meeting_id,
        )
    ).all():
        session.delete(row)
        removed += 1

    session.flush()
    return removed


def classify_utterances(
    session: Session, meeting_id: int, *, classifier: Classifier = ut.classify
) -> dict[str, int]:
    """발화마다 유형을 매긴다.

    `utterance_type` 컬럼은 스키마에 처음부터 있었지만 **저장 단계에서 한
    번도 채워지지 않았습니다.**
    """
    counts: dict[str, int] = {}
    for utterance in session.scalars(
        select(m.Utterance).where(m.Utterance.meeting_id == meeting_id)
    ).all():
        result = classifier(utterance.text)
        utterance.utterance_type = result.label
        utterance.type_confidence = result.confidence
        counts[result.label] = counts.get(result.label, 0) + 1
    session.flush()
    return counts


def _decision_times(session: Session, meeting_id: int) -> list[int]:
    return sorted(
        session.scalars(
            select(m.Utterance.start_ms).where(
                m.Utterance.meeting_id == meeting_id,
                m.Utterance.utterance_type == ut.DECISION,
            )
        )
    )


def record_utterance_events(
    session: Session, meeting: m.Meeting, *, classifier_name: str = ut.CLASSIFIER_RULES
) -> int:
    """분류된 발화를 기여 이벤트로 만든다.

    `classify_utterances` 가 먼저 돌아야 합니다.
    """
    started_at = meeting.started_at or datetime.now(UTC)
    decisions = _decision_times(session, meeting.id)

    written = 0
    for utterance in session.scalars(
        select(m.Utterance).where(m.Utterance.meeting_id == meeting.id)
    ).all():
        label = utterance.utterance_type
        if label is None:
            continue

        # ⚠️ **화자가 없으면 아무에게도 주지 않습니다.**
        #
        # 모드 B 의 `SPEAKER_XX` 는 사람이 이름을 매기기 전까지 주인이
        # 없습니다. 그걸 아무에게나 붙이면 측정이 아니라 오답입니다.
        # 여기서 빠진 발언은 사라지는 게 아니라 **아직 누구 것인지 모르는
        # 상태**로 회의록에 남습니다.
        if utterance.speaker_id is None:
            continue

        # ⭐ `social` 도 기록합니다. 0점이라 무의미해 보이지만,
        # `detect_integrity_flags` 의 `mostly_social_utterances` 가 **맞장구
        # 비율**을 봅니다. 안 기록하면 분모가 사라져서 "네" 만 백 번 한
        # 사람이 오히려 탐지를 피해 갑니다.
        event_type = _event_type_for(label)

        metadata: dict[str, object] = {
            "classifier": classifier_name,
            "type_confidence": float(utterance.type_confidence or 0.0),
            "speaker_source": utterance.speaker_source,
        }

        # 제안이 실제로 결정으로 이어졌는가 (2.0 → 5.0).
        #
        # 같은 회의 안에서 이 제안 **뒤에** 결정이 있었으면 이어진 것으로
        # 봅니다. 어떤 결정이 어떤 제안에서 나왔는지는 표면형으로 알 수
        # 없으므로 이건 **추정**이고, 메타데이터에 그렇게 적어 둡니다.
        if label == ut.PROPOSAL:
            led = any(at > utterance.start_ms for at in decisions)
            metadata["led_to_decision"] = led
            metadata["led_to_decision_is_a_guess"] = True

        session.add(
            m.ContributionEventRow(
                project_id=meeting.project_id,
                user_id=utterance.speaker_id,
                occurred_at=started_at + timedelta(milliseconds=utterance.start_ms),
                category=CATEGORY_OF[event_type].value,
                event_type=event_type.value,
                source_kind=_UTTERANCE,
                source_id=utterance.id,
                magnitude=1.0,
                event_metadata=metadata,
            )
        )
        written += 1

    session.flush()
    return written


def record_attendance(session: Session, meeting: m.Meeting) -> int:
    """참석한 사람에게 참석 이벤트를 만든다 (3.0점).

    ⚠️ 이것도 **배선이 0곳**이었습니다. `MEETING_ATTENDED` 는 가중치까지
    정해져 있는데 그 이벤트를 만드는 코드가 없었습니다.

    참석의 근거는 **트랙**입니다 — 그 사람의 기기가 이 회의를 녹음했다는
    기록이고, 오디오 원본이 보존기간으로 지워져도 트랙 행은 남습니다.
    그래서 나중에 녹음이 지워진 사람도 "참석하지 않은 사람" 이 되지
    않습니다.
    """
    started_at = meeting.started_at or datetime.now(UTC)
    user_ids = sorted(
        set(
            session.scalars(
                select(m.MeetingTrack.user_id).where(
                    m.MeetingTrack.meeting_id == meeting.id
                )
            )
        )
    )

    for user_id in user_ids:
        session.add(
            m.ContributionEventRow(
                project_id=meeting.project_id,
                user_id=user_id,
                occurred_at=started_at,
                category=CATEGORY_OF[EventType.MEETING_ATTENDED].value,
                event_type=EventType.MEETING_ATTENDED.value,
                source_kind=_MEETING,
                source_id=meeting.id,
                magnitude=1.0,
                event_metadata={"meeting_title": meeting.title},
            )
        )
    session.flush()
    return len(user_ids)


def record_meeting(
    session: Session,
    meeting: m.Meeting,
    *,
    classifier: Classifier = ut.classify,
    classifier_name: str = ut.CLASSIFIER_RULES,
) -> dict[str, object]:
    """회의 하나를 기여 이벤트로 옮긴다. 발화가 저장된 **뒤에** 부릅니다."""
    counts = classify_utterances(session, meeting.id, classifier=classifier)
    utterance_events = record_utterance_events(
        session, meeting, classifier_name=classifier_name
    )
    attendance = record_attendance(session, meeting)

    logger.info(
        "meeting=%s → 발화 이벤트 %d건, 참석 %d명 (분류기=%s, 분포=%s)",
        meeting.id,
        utterance_events,
        attendance,
        classifier_name,
        counts,
    )
    return {
        "utterance_events": utterance_events,
        "attendance": attendance,
        "labels": counts,
        "classifier": classifier_name,
    }


def count_by_type(session: Session, meeting_id: int) -> dict[str, int | dict[str, int]]:
    """이 회의의 발언을 **유형별로** 센다 (요구사항 정의서 §10 · `REVIEW-005`).

    ## ⚠️ 사람별로 세지 않습니다

    회의 단위 집계입니다. 사람별로 세면 그 순간 **"누가 제일 많이
    제안했나" 표**가 만들어지고, 그건 이 저장소가 금지한 리더보드입니다
    (`AGENTS.md` 불변식 1). 발언을 많이 한 것이 기여가 아니라는 것은
    `docs/05` §2.2 가 원본 대화에서 가져온 경고이기도 합니다.

    ## ⚠️ 대본을 주지 않습니다

    `GET /api/meetings/{id}/utterances` 가 `ids` 로만 원문을 주는 이유와
    같습니다. 여기서 세어서 **숫자만** 돌려주면 회의록 전체를 뜨지 않고도
    "이 회의에 반대가 몇 번 있었나" 를 말할 수 있습니다.

    ## ⚠️ 분류 전과 `other` 를 **섞지 않습니다**

    `utterance_type` 이 `NULL` 인 것은 아직 안 잰 것이고, `other` 는 재고
    나서 모르는 것입니다. 섞으면 "분석이 아직 안 끝났다" 가 "분석했는데
    분류가 안 됐다" 로 보입니다 — 불변식 3(측정 불가 ≠ 0점)이 여기서
    나타납니다.
    """
    labels: dict[str, int] = {}
    unclassified = 0

    for value in session.scalars(
        select(m.Utterance.utterance_type).where(m.Utterance.meeting_id == meeting_id)
    ).all():
        if value is None:
            unclassified += 1
        else:
            labels[value] = labels.get(value, 0) + 1

    return {
        "labels": labels,
        "unclassified": unclassified,
        "total": sum(labels.values()) + unclassified,
    }
