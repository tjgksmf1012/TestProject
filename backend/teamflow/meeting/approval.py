"""업무 후보 승인 워크플로.

docs/03-시스템-아키텍처.md §3, 제안서 5장

    회의 분석 → 업무 후보 → [사람 확인] → 칸반 등록

이 흐름의 **마지막 화살표가 시스템의 안전장치**다.
AI가 만든 것은 후보(candidate)일 뿐이고, 사람이 승인해야 실제 업무(task)가 된다.
음성 인식 오류로 엉뚱한 사람에게 업무가 배정되는 것을 막는다.

불변식 (테스트로 강제한다):
    1. 승인자 없이는 업무가 만들어지지 않는다
    2. 승인은 멱등이다 — 두 번 눌러도 업무는 하나
    3. 거절된 후보는 승인할 수 없다
    4. 담당자·마감일이 없으면 사람이 채워야 승인된다
    5. 모든 상태 변화는 감사 로그에 남는다
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import date, datetime
from enum import StrEnum

from teamflow.meeting.validation import ResolvedCandidate


class CandidateStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class ApprovalError(StrEnum):
    ALREADY_APPROVED = "already_approved"
    ALREADY_REJECTED = "already_rejected"
    MISSING_ASSIGNEE = "missing_assignee"
    MISSING_DEADLINE = "missing_deadline"
    NO_REVIEWER = "no_reviewer"
    DEADLINE_IN_PAST = "deadline_in_past"
    UNKNOWN_ASSIGNEE = "unknown_assignee"
    NO_EVIDENCE = "no_evidence"


_ERROR_TEXT: dict[ApprovalError, str] = {
    ApprovalError.ALREADY_APPROVED: "이미 승인된 후보입니다",
    ApprovalError.ALREADY_REJECTED: "이미 거절된 후보입니다",
    ApprovalError.MISSING_ASSIGNEE: "담당자를 지정해야 승인할 수 있습니다",
    ApprovalError.MISSING_DEADLINE: "마감일을 지정해야 승인할 수 있습니다",
    ApprovalError.NO_REVIEWER: "승인자 정보가 없습니다",
    ApprovalError.DEADLINE_IN_PAST: "마감일이 과거입니다",
    ApprovalError.UNKNOWN_ASSIGNEE: "담당자가 이 프로젝트의 팀원이 아닙니다",
    ApprovalError.NO_EVIDENCE: "근거 발화가 없습니다 — 회의에 없던 내용일 수 있습니다",
}


@dataclass(frozen=True, slots=True)
class StoredCandidate:
    """DB의 meeting_task_candidates 한 행에 대응하는 도메인 객체."""

    id: int
    meeting_id: int
    title: str
    assignee_id: int | None
    deadline: date | None
    confidence: float
    evidence_utterance_ids: tuple[int, ...]
    status: CandidateStatus = CandidateStatus.PENDING
    reviewed_by: int | None = None
    created_task_id: int | None = None
    warnings: tuple[str, ...] = ()

    @classmethod
    def from_resolved(
        cls, resolved: ResolvedCandidate, *, candidate_id: int, meeting_id: int
    ) -> StoredCandidate:
        return cls(
            id=candidate_id,
            meeting_id=meeting_id,
            title=resolved.title,
            assignee_id=resolved.assignee.user_id,
            deadline=resolved.deadline.value,
            confidence=resolved.overall_confidence,
            evidence_utterance_ids=resolved.evidence_utterance_ids,
            warnings=resolved.warnings,
        )


@dataclass(frozen=True, slots=True)
class ApprovalRequest:
    """사람이 승인 화면에서 제출하는 것.

    AI가 채우지 못했거나 잘못 채운 값을 여기서 덮어쓴다.
    """

    candidate_id: int
    reviewer_id: int
    approve: bool
    title_override: str | None = None
    assignee_override: int | None = None
    deadline_override: date | None = None
    note: str | None = None


@dataclass(frozen=True, slots=True)
class NewTask:
    """승인 결과로 만들어질 업무. 아직 DB에 없다."""

    project_id: int
    meeting_id: int
    title: str
    assignee_id: int
    deadline: date
    origin_candidate_id: int
    evidence_utterance_ids: tuple[int, ...]


@dataclass(frozen=True, slots=True)
class AuditEntry:
    actor_id: int
    action: str
    target: str
    before: dict
    after: dict
    at: datetime


@dataclass(frozen=True, slots=True)
class ApprovalOutcome:
    candidate: StoredCandidate
    task: NewTask | None = None
    audit: tuple[AuditEntry, ...] = ()
    errors: tuple[ApprovalError, ...] = ()

    @property
    def ok(self) -> bool:
        return not self.errors

    def error_messages(self) -> list[str]:
        return [_ERROR_TEXT[e] for e in self.errors]


def apply_approval(
    candidate: StoredCandidate,
    request: ApprovalRequest,
    *,
    project_id: int,
    project_member_ids: frozenset[int],
    now: datetime,
    today: date,
) -> ApprovalOutcome:
    """후보 하나에 승인/거절을 적용한다.

    순수 함수다. DB를 건드리지 않고 "무엇을 해야 하는지"만 돌려준다.
    호출자가 트랜잭션 안에서 반영한다.
    """
    errors: list[ApprovalError] = []

    if request.reviewer_id <= 0:
        errors.append(ApprovalError.NO_REVIEWER)

    # ── 멱등성: 이미 처리된 후보 ────────────────────────────
    if candidate.status is CandidateStatus.APPROVED:
        # 같은 결과를 다시 요청한 것이면 조용히 현 상태를 돌려준다.
        # 두 번 눌러도 업무가 두 개 생기지 않는다.
        if request.approve:
            return ApprovalOutcome(candidate=candidate)
        return ApprovalOutcome(candidate=candidate, errors=(ApprovalError.ALREADY_APPROVED,))

    if candidate.status is CandidateStatus.REJECTED:
        if not request.approve:
            return ApprovalOutcome(candidate=candidate)
        return ApprovalOutcome(candidate=candidate, errors=(ApprovalError.ALREADY_REJECTED,))

    # ── 거절 ────────────────────────────────────────────────
    if not request.approve:
        if errors:
            return ApprovalOutcome(candidate=candidate, errors=tuple(errors))
        updated = replace(
            candidate,
            status=CandidateStatus.REJECTED,
            reviewed_by=request.reviewer_id,
        )
        return ApprovalOutcome(
            candidate=updated,
            audit=(
                AuditEntry(
                    actor_id=request.reviewer_id,
                    action="candidate_rejected",
                    target=f"meeting_task_candidates/{candidate.id}",
                    before={"status": candidate.status.value},
                    after={"status": CandidateStatus.REJECTED.value, "note": request.note},
                    at=now,
                ),
            ),
        )

    # ── 승인 ────────────────────────────────────────────────
    title = (request.title_override or candidate.title).strip()
    assignee_id = (
        request.assignee_override
        if request.assignee_override is not None
        else candidate.assignee_id
    )
    deadline = (
        request.deadline_override
        if request.deadline_override is not None
        else candidate.deadline
    )

    # 근거 없는 후보는 사람이 고쳐도 통과시킬 수 없다.
    #
    # LLM 출력 단계에서 이미 막지만(meeting/schema.py 의 min_length=1,
    # meeting/validation.py), 여기서 한 번 더 본다. 환각을 담당자·마감일만
    # 채워 승인하는 경로가 생기면 환각 방어 전체가 무의미해진다.
    # docs/04 §4.1
    if not candidate.evidence_utterance_ids:
        errors.append(ApprovalError.NO_EVIDENCE)

    if assignee_id is None:
        errors.append(ApprovalError.MISSING_ASSIGNEE)
    elif assignee_id not in project_member_ids:
        errors.append(ApprovalError.UNKNOWN_ASSIGNEE)

    if deadline is None:
        errors.append(ApprovalError.MISSING_DEADLINE)
    elif deadline < today:
        errors.append(ApprovalError.DEADLINE_IN_PAST)

    if errors:
        return ApprovalOutcome(candidate=candidate, errors=tuple(errors))

    assert assignee_id is not None and deadline is not None

    updated = replace(
        candidate,
        title=title,
        assignee_id=assignee_id,
        deadline=deadline,
        status=CandidateStatus.APPROVED,
        reviewed_by=request.reviewer_id,
    )

    task = NewTask(
        project_id=project_id,
        meeting_id=candidate.meeting_id,
        title=title,
        assignee_id=assignee_id,
        deadline=deadline,
        origin_candidate_id=candidate.id,
        evidence_utterance_ids=candidate.evidence_utterance_ids,
    )

    audit = [
        AuditEntry(
            actor_id=request.reviewer_id,
            action="candidate_approved",
            target=f"meeting_task_candidates/{candidate.id}",
            before={
                "status": candidate.status.value,
                "title": candidate.title,
                "assignee_id": candidate.assignee_id,
                "deadline": candidate.deadline.isoformat() if candidate.deadline else None,
            },
            after={
                "status": CandidateStatus.APPROVED.value,
                "title": title,
                "assignee_id": assignee_id,
                "deadline": deadline.isoformat(),
            },
            at=now,
        )
    ]

    # 사람이 AI 결과를 고쳤다면 별도로 기록한다.
    # 이 로그가 쌓이면 모델 성능 개선의 학습 신호가 된다 (제안서 12장 "사용자 수정 로그").
    corrections: dict[str, dict] = {}
    if request.title_override and request.title_override.strip() != candidate.title:
        corrections["title"] = {"from": candidate.title, "to": title}
    if request.assignee_override is not None and request.assignee_override != candidate.assignee_id:
        corrections["assignee_id"] = {
            "from": candidate.assignee_id,
            "to": request.assignee_override,
        }
    if request.deadline_override is not None and request.deadline_override != candidate.deadline:
        corrections["deadline"] = {
            "from": candidate.deadline.isoformat() if candidate.deadline else None,
            "to": request.deadline_override.isoformat(),
        }
    if corrections:
        audit.append(
            AuditEntry(
                actor_id=request.reviewer_id,
                action="ai_output_corrected",
                target=f"meeting_task_candidates/{candidate.id}",
                before={},
                after=corrections,
                at=now,
            )
        )

    return ApprovalOutcome(candidate=updated, task=task, audit=tuple(audit))


@dataclass
class BatchOutcome:
    approved: list[NewTask] = field(default_factory=list)
    updated: list[StoredCandidate] = field(default_factory=list)
    audit: list[AuditEntry] = field(default_factory=list)
    failures: dict[int, tuple[ApprovalError, ...]] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.failures


def apply_batch(
    candidates: dict[int, StoredCandidate],
    requests: list[ApprovalRequest],
    *,
    project_id: int,
    project_member_ids: frozenset[int],
    now: datetime,
    today: date,
) -> BatchOutcome:
    """승인 화면에서 여러 후보를 한 번에 처리한다.

    실패한 항목이 있어도 나머지는 진행한다 — 하나 때문에 전체를 막지 않는다.
    호출자가 `failures` 를 보고 해당 항목만 다시 요청하면 된다.
    """
    outcome = BatchOutcome()
    for request in requests:
        candidate = candidates.get(request.candidate_id)
        if candidate is None:
            continue
        result = apply_approval(
            candidate,
            request,
            project_id=project_id,
            project_member_ids=project_member_ids,
            now=now,
            today=today,
        )
        if not result.ok:
            outcome.failures[request.candidate_id] = result.errors
            continue
        outcome.updated.append(result.candidate)
        outcome.audit.extend(result.audit)
        if result.task is not None:
            outcome.approved.append(result.task)
    return outcome
