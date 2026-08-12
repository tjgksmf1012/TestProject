"""기여도 이벤트 정의.

설계 원칙 (docs/05-기여도-산정-설계.md §1):
    점수 = f(불변 이벤트 로그, 가중치 버전, 역할)

이벤트는 append-only이며, 점수는 저장하지 않고 이 이벤트들로부터 재계산한다.
그래야 "왜 이 점수인가"에 답할 수 있고, 가중치를 바꿔도 과거가 오염되지 않는다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any


class Category(StrEnum):
    """기여 영역. 역할별 가중치가 이 단위로 붙는다."""

    TASK = "task"
    CODE = "code"
    MEETING = "meeting"
    DOCUMENT = "document"
    SCHEDULE = "schedule"
    PEER = "peer"


class EventType(StrEnum):
    """이벤트 종류.

    주의: COMMIT 이벤트는 의도적으로 존재하지 않는다.
    커밋은 쪼개기가 너무 쉬워서 지표로 쓸 수 없다 (docs/05 §2.1).
    코드 기여는 병합된 PR 단위로만 집계한다.
    """

    # ── code ──────────────────────────────────────────────
    PR_MERGED = "pr_merged"
    REVIEW_GIVEN = "review_given"  # 남에게 준 리뷰. 받은 건 세지 않는다
    ISSUE_RESOLVED = "issue_resolved"

    # ── task ──────────────────────────────────────────────
    TASK_COMPLETED = "task_completed"
    BLOCKER_RESOLVED = "blocker_resolved"

    # ── meeting ───────────────────────────────────────────
    # 발언 유형은 `db/vocab.py` 의 `UtteranceType` 과 **이름이 짝**입니다
    # (`_event_type_for` 가 `utt_ + 라벨` 로 만듭니다). 한쪽만 늘리면
    # `EventType(...)` 이 `ValueError` 로 터지고, 그것을 테스트가 잽니다.
    MEETING_ATTENDED = "meeting_attended"
    UTT_QUESTION = "utt_question"
    UTT_ANSWER = "utt_answer"
    UTT_PROPOSAL = "utt_proposal"
    UTT_AGREEMENT = "utt_agreement"  # 동의 (AI-SPEECH-004)
    UTT_OBJECTION = "utt_objection"  # 반대 의견 (AI-SPEECH-005)
    UTT_REFINEMENT = "utt_refinement"  # 보완 의견 (AI-SPEECH-006)
    UTT_OPINION = "utt_opinion"  # 어느 쪽도 아닌 의견
    UTT_DECISION = "utt_decision"
    UTT_REQUEST = "utt_request"  # 업무 요청 (AI-SPEECH-008)
    UTT_COMMITMENT = "utt_commitment"
    UTT_CONFIRMATION = "utt_confirmation"  # 확인 요청 (AI-SPEECH-010)
    UTT_SOCIAL = "utt_social"  # 맞장구·농담·잡담 → 0점
    UTT_OTHER = "utt_other"  # 기타·미완성 발언 → 0점

    # ── document ──────────────────────────────────────────
    DOCUMENT_REVISED = "document_revised"

    # ── schedule ──────────────────────────────────────────
    DEADLINE_MET = "deadline_met"
    DEADLINE_MISSED = "deadline_missed"
    DEADLINE_CHANGED = "deadline_changed"  # 점수 없음. 조작 탐지용 기록

    # ── peer ──────────────────────────────────────────────
    PEER_RATING = "peer_rating"


CATEGORY_OF: dict[EventType, Category] = {
    EventType.PR_MERGED: Category.CODE,
    EventType.REVIEW_GIVEN: Category.CODE,
    EventType.ISSUE_RESOLVED: Category.CODE,
    EventType.TASK_COMPLETED: Category.TASK,
    EventType.BLOCKER_RESOLVED: Category.TASK,
    EventType.MEETING_ATTENDED: Category.MEETING,
    EventType.UTT_QUESTION: Category.MEETING,
    EventType.UTT_ANSWER: Category.MEETING,
    EventType.UTT_PROPOSAL: Category.MEETING,
    EventType.UTT_AGREEMENT: Category.MEETING,
    EventType.UTT_OBJECTION: Category.MEETING,
    EventType.UTT_REFINEMENT: Category.MEETING,
    EventType.UTT_OPINION: Category.MEETING,
    EventType.UTT_DECISION: Category.MEETING,
    EventType.UTT_REQUEST: Category.MEETING,
    EventType.UTT_COMMITMENT: Category.MEETING,
    EventType.UTT_CONFIRMATION: Category.MEETING,
    EventType.UTT_SOCIAL: Category.MEETING,
    EventType.UTT_OTHER: Category.MEETING,
    EventType.DOCUMENT_REVISED: Category.DOCUMENT,
    EventType.DEADLINE_MET: Category.SCHEDULE,
    EventType.DEADLINE_MISSED: Category.SCHEDULE,
    EventType.DEADLINE_CHANGED: Category.SCHEDULE,
    EventType.PEER_RATING: Category.PEER,
}


class SourceKind(StrEnum):
    """이벤트의 원본 근거. 모든 점수는 여기까지 역추적되어야 한다."""

    GITHUB_EVENT = "github_event"
    TASK = "task"
    # ⚠️ 마감일 변경은 **업무와 다른 네임스페이스**다. `TASK` 를 쓰면 두 가지가
    # 한꺼번에 깨진다. (1) 같은 업무를 여러 번 미루면 두 번째부터 유니크
    # 제약에 막혀 "3회 이상" 문턱을 영원히 못 넘는다. (2) 근거 id 목록에
    # 업무 id 와 변경 id 가 섞여, 되짚어 가면 엉뚱한 업무가 나온다 —
    # GitHub 이슈 번호와 업무 번호를 섞었던 결함 39 와 같은 실수다.
    DEADLINE_CHANGE = "deadline_change"
    UTTERANCE = "utterance"
    MEETING = "meeting"
    DOCUMENT = "document"
    PEER_REVIEW = "peer_review"


@dataclass(frozen=True, slots=True)
class ContributionEvent:
    """불변 기여 이벤트.

    ``(source_kind, source_id, event_type)`` 가 유일 키다.
    GitHub 웹훅은 재전송될 수 있고 백필과 겹칠 수 있으므로,
    이 제약이 없으면 점수가 부풀려진다.
    """

    user_id: int
    event_type: EventType
    occurred_at: datetime
    source_kind: SourceKind
    source_id: int
    magnitude: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def category(self) -> Category:
        return CATEGORY_OF[self.event_type]

    @property
    def dedupe_key(self) -> tuple[str, int, str]:
        return (self.source_kind.value, self.source_id, self.event_type.value)


def deduplicate(events: list[ContributionEvent]) -> list[ContributionEvent]:
    """중복 이벤트 제거. 먼저 온 것을 남긴다.

    DB의 ``UNIQUE (source_kind, source_id, event_type)`` 제약과 같은 규칙을
    메모리에서도 적용해, 웹훅 재전송이나 백필 중복이 점수를 부풀리지 못하게 한다.
    """
    seen: set[tuple[str, int, str]] = set()
    out: list[ContributionEvent] = []
    for ev in events:
        if ev.dedupe_key in seen:
            continue
        seen.add(ev.dedupe_key)
        out.append(ev)
    return out
