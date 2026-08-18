"""비효율 구간 탐지를 DB 에 잇는다 (요구사항 정의서 §12).

## ⚠️ 판단은 여기 없습니다

전부 `meeting/inefficiency.py` 의 순수 함수에 있고, 테스트도 거기 붙어
있습니다. 이 파일은 **행을 읽어 넣고 결과를 행으로 쓰는 것**만 합니다.

## ⚠️ 다시 돌려도 쌓이지 않습니다

회의를 재처리하면 탐지도 다시 돕니다. 안 지우고 넣으면 같은 지적이 두
번, 세 번 쌓이고 화면은 "반복 논의 6건" 이라고 말합니다 — 실제로는 두
건인데 세 번 돌린 것입니다.

⚠️ **`unanswered_question` 은 안 지웁니다.** 그건 LLM 경로가 만들고
(`tasks/meeting_tasks.py`), 여기서 만들지 않습니다. 남의 행을 지우면
재처리할 때마다 회의록의 절반이 사라집니다.
"""

from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from teamflow.db import models as m
from teamflow.db import vocab
from teamflow.meeting import inefficiency as ie

logger = logging.getLogger(__name__)

#: 이 서비스가 만드는 것. **재처리 때 지우는 것도 이것뿐입니다.**
#:
#: ⚠️ `vocab.EVENT_PRODUCED` 와 짝입니다. 한쪽만 늘리면
#: `test_the_detectors_produce_what_the_vocabulary_claims` 가 터집니다.
DETECTED: tuple[str, ...] = (
    str(vocab.MeetingEventType.REPEATED_DISCUSSION),
    str(vocab.MeetingEventType.TOPIC_DRIFT),
    str(vocab.MeetingEventType.INCOMPLETE_TASK),
    str(vocab.MeetingEventType.DECISION_CONFLICT),
)


def _said(session: Session, meeting_id: int) -> list[ie.Said]:
    rows = session.scalars(
        select(m.Utterance)
        .where(m.Utterance.meeting_id == meeting_id)
        .order_by(m.Utterance.start_ms, m.Utterance.id)
    ).all()
    return [
        ie.Said(
            id=row.id,
            start_ms=row.start_ms,
            end_ms=row.end_ms,
            text=row.text,
            label=row.utterance_type,
            speaker_id=row.speaker_id,
        )
        for row in rows
    ]


def _decisions(session: Session, meeting_id: int) -> list[ie.Decided]:
    """이 회의의 결정 + **이 회의가 뒤집은 앞 회의의 결정**.

    ⚠️ 프로젝트의 결정을 전부 가져오지 않습니다. 그러면 반년 전 결정과
    오늘 결정이 낱말이 겹친다는 이유로 "번복" 이 되고, 회의를 열 때마다
    같은 지적이 다시 뜹니다. 이 회의가 실제로 가리킨 것만 봅니다.
    """
    mine = list(
        session.scalars(
            select(m.Decision).where(m.Decision.meeting_id == meeting_id)
        ).all()
    )
    wanted = {d.supersedes_id for d in mine if d.supersedes_id is not None}
    seen = {d.id for d in mine}
    if wanted - seen:
        mine += list(
            session.scalars(
                select(m.Decision).where(m.Decision.id.in_(wanted - seen))
            ).all()
        )

    spans = _spans(session, meeting_id)
    out: list[ie.Decided] = []
    for row in mine:
        evidence = list(row.evidence_utterance_ids or [])
        start, end = _span_of(evidence, spans)
        out.append(
            ie.Decided(
                id=row.id,
                content=row.content,
                supersedes_id=row.supersedes_id,
                evidence=evidence,
                start_ms=start,
                end_ms=end,
            )
        )
    return out


def _spans(session: Session, meeting_id: int) -> dict[int, tuple[int, int]]:
    return {
        row.id: (row.start_ms, row.end_ms)
        for row in session.scalars(
            select(m.Utterance).where(m.Utterance.meeting_id == meeting_id)
        ).all()
    }


def _span_of(ids: list[int], spans: dict[int, tuple[int, int]]) -> tuple[int, int]:
    """근거 발화의 구간. ⚠️ 없으면 `(0, 0)` — **시각을 지어내지 않습니다.**"""
    known = [spans[i] for i in ids if i in spans]
    if not known:
        return 0, 0
    return min(s for s, _ in known), max(e for _, e in known)


def _candidate_evidence(session: Session, meeting_id: int) -> set[int]:
    """업무 후보가 가리키는 발화들."""
    seen: set[int] = set()
    for row in session.scalars(
        select(m.MeetingTaskCandidate).where(
            m.MeetingTaskCandidate.meeting_id == meeting_id
        )
    ).all():
        seen.update(row.evidence_utterance_ids or [])
    return seen


def forget(session: Session, meeting_id: int) -> int:
    """이 서비스가 만든 행만 지운다. ⚠️ 남의 행은 안 건드립니다."""
    rows = session.scalars(
        select(m.MeetingEvent).where(
            m.MeetingEvent.meeting_id == meeting_id,
            m.MeetingEvent.event_type.in_(DETECTED),
        )
    ).all()
    for row in rows:
        session.delete(row)
    return len(rows)


def detect(session: Session, meeting_id: int) -> dict[str, int]:
    """회의 하나를 훑어 비효율 구간을 기록한다.

    ⚠️ **발화 분류가 끝난 뒤에** 부릅니다 — 미완성 업무 탐지가
    `utterance_type == "commitment"` 을 봅니다. 분류 전에 부르면 라벨이
    전부 `None` 이라 **조용히 0건**이 나옵니다.
    """
    forget(session, meeting_id)

    said = _said(session, meeting_id)
    found = [
        *ie.find_repeated_discussion(said),
        *ie.find_topic_drift(said),
        *ie.find_incomplete_tasks(
            said, candidate_evidence=_candidate_evidence(session, meeting_id)
        ),
        *ie.find_decision_conflicts(_decisions(session, meeting_id)),
    ]

    counts: dict[str, int] = {}
    for one in found:
        session.add(
            m.MeetingEvent(
                meeting_id=meeting_id,
                event_type=one.event_type,
                severity=one.severity,
                start_ms=one.start_ms,
                end_ms=one.end_ms,
                evidence_utterance_ids=one.evidence,
                detail=one.detail,
            )
        )
        counts[one.event_type] = counts.get(one.event_type, 0) + 1

    session.flush()
    logger.info("meeting=%s 비효율 구간 %s", meeting_id, counts or "없음")
    return counts
