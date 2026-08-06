"""LLM 출력 검증 — 환각이 UI까지 도달하지 못하게 막는다.

docs/04-회의-처리-파이프라인.md §4.1, 제안서 17장 "LLM 환각" 대응

핵심 장치는 `evidence_utterance_ids` 다.
LLM이 없는 업무를 지어내면 근거 필드가 비거나 존재하지 않는 ID를 참조하게 된다.
서버가 이걸 검증해서 **버린다**. 그러면 환각이 승인 화면까지 오지 못한다.

guided decoding이 형식을 보장하고, 이 모듈이 내용을 보장한다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

from teamflow.meeting.resolve import (
    AssigneeMatch,
    DeadlineMatch,
    TeamMemberName,
    resolve_assignee,
    resolve_deadline,
)
from teamflow.meeting.schema import MeetingAnalysis, TaskCandidate


class RejectReason:
    NO_EVIDENCE = "no_evidence"
    UNKNOWN_UTTERANCE = "unknown_utterance"
    EMPTY_TITLE = "empty_title"
    DUPLICATE = "duplicate"


@dataclass(frozen=True, slots=True)
class Rejected:
    kind: str  # task | decision | issue
    reason: str
    detail: str
    payload: dict


@dataclass(frozen=True, slots=True)
class ResolvedCandidate:
    """검증·해석을 마친 업무 후보. 아직 tasks 가 아니다."""

    title: str
    assignee: AssigneeMatch
    deadline: DeadlineMatch
    llm_confidence: float
    evidence_utterance_ids: tuple[int, ...]
    warnings: tuple[str, ...] = ()
    # 전사에 등장한 이름 **그대로**. `assignee.matched_name` 과 다르다 —
    # 저쪽은 명단에서 찾아낸 이름이고 매칭에 실패하면 None 이다.
    #
    # 매칭이 실패했을 때야말로 원문이 필요하다. 사람이 검토 화면에서
    # "회의에서 '민수님' 이라고 했는데 명단에 민수가 둘" 을 보고 고르는 것과,
    # 담당자 칸이 그냥 비어 있는 것은 전혀 다른 작업이다.
    assignee_hint: str | None = None

    @property
    def is_complete(self) -> bool:
        """담당자와 마감일이 모두 정해졌는가.

        제안서 6.5의 '불완전 업무' 판정과 같은 기준이다.
        """
        return self.assignee.user_id is not None and self.deadline.value is not None

    @property
    def overall_confidence(self) -> float:
        """LLM 확신도와 해석 확신도를 결합한 값.

        승인 화면의 정렬 기준으로 쓴다. 낮은 것부터 보여주면
        사람이 검토해야 할 것을 먼저 보게 된다.
        """
        parts = [self.llm_confidence]
        if self.assignee.user_id is not None:
            parts.append(self.assignee.score)
        if self.deadline.value is not None:
            parts.append(self.deadline.confidence)
        return min(parts)


@dataclass
class ValidationResult:
    candidates: list[ResolvedCandidate] = field(default_factory=list)
    decisions: list[tuple[str, tuple[int, ...], str | None]] = field(default_factory=list)
    unresolved_issues: list[tuple[str, tuple[int, ...]]] = field(default_factory=list)
    summary: str = ""
    next_agenda: list[str] = field(default_factory=list)
    rejected: list[Rejected] = field(default_factory=list)

    @property
    def rejection_rate(self) -> float:
        """폐기 비율. 높으면 모델이나 프롬프트에 문제가 있다는 신호다."""
        total = (
            len(self.candidates)
            + len(self.decisions)
            + len(self.unresolved_issues)
            + len(self.rejected)
        )
        return len(self.rejected) / total if total else 0.0

    @property
    def incomplete_candidates(self) -> list[ResolvedCandidate]:
        """담당자나 마감일이 빠진 후보. 승인 화면에서 경고로 표시한다."""
        return [c for c in self.candidates if not c.is_complete]


def _check_evidence(
    ids: list[int], known: set[int]
) -> tuple[tuple[int, ...] | None, str | None]:
    if not ids:
        return None, RejectReason.NO_EVIDENCE
    unknown = [i for i in ids if i not in known]
    if unknown:
        return None, RejectReason.UNKNOWN_UTTERANCE
    # 중복 제거하되 순서는 유지
    seen: set[int] = set()
    ordered = tuple(i for i in ids if not (i in seen or seen.add(i)))
    return ordered, None


def _normalize_title(title: str) -> str:
    return " ".join(title.split()).strip().lower()


def validate_analysis(
    analysis: MeetingAnalysis,
    *,
    known_utterance_ids: set[int],
    members: list[TeamMemberName],
    meeting_date: date,
    existing_task_titles: list[str] | None = None,
) -> ValidationResult:
    """LLM 출력을 검증하고 담당자·마감일을 해석한다.

    Args:
        analysis: guided decoding으로 받은 구조화 출력
        known_utterance_ids: 이 회의에 실제로 존재하는 발화 ID
        members: 팀원 이름 목록
        meeting_date: 상대 날짜 해석의 기준일
        existing_task_titles: 이미 칸반에 있는 업무 (중복 생성 방지)

    Returns:
        검증을 통과한 항목과 폐기된 항목.
    """
    result = ValidationResult(summary=analysis.summary, next_agenda=list(analysis.next_agenda))

    seen_titles = {_normalize_title(t) for t in (existing_task_titles or [])}

    for task in analysis.tasks:
        rejected = _validate_task(
            task, known_utterance_ids, members, meeting_date, seen_titles
        )
        if isinstance(rejected, Rejected):
            result.rejected.append(rejected)
        else:
            result.candidates.append(rejected)
            seen_titles.add(_normalize_title(task.title))

    for decision in analysis.decisions:
        evidence, reason = _check_evidence(decision.evidence_utterance_ids, known_utterance_ids)
        if reason:
            result.rejected.append(
                Rejected(
                    kind="decision",
                    reason=reason,
                    detail=f"근거 발화 검증 실패: {decision.evidence_utterance_ids}",
                    payload={"content": decision.content},
                )
            )
            continue
        assert evidence is not None
        result.decisions.append((decision.content, evidence, decision.supersedes_hint))

    for issue in analysis.unresolved_issues:
        evidence, reason = _check_evidence(issue.evidence_utterance_ids, known_utterance_ids)
        if reason:
            result.rejected.append(
                Rejected(
                    kind="issue",
                    reason=reason,
                    detail=f"근거 발화 검증 실패: {issue.evidence_utterance_ids}",
                    payload={"content": issue.content},
                )
            )
            continue
        assert evidence is not None
        result.unresolved_issues.append((issue.content, evidence))

    return result


def _validate_task(
    task: TaskCandidate,
    known_utterance_ids: set[int],
    members: list[TeamMemberName],
    meeting_date: date,
    seen_titles: set[str],
) -> ResolvedCandidate | Rejected:
    payload = {"title": task.title, "assignee_hint": task.assignee_hint}

    if not task.title.strip():
        return Rejected("task", RejectReason.EMPTY_TITLE, "제목이 비어 있음", payload)

    evidence, reason = _check_evidence(task.evidence_utterance_ids, known_utterance_ids)
    if reason:
        detail = (
            "근거 발화가 없음"
            if reason == RejectReason.NO_EVIDENCE
            else f"존재하지 않는 발화 ID 참조: {task.evidence_utterance_ids}"
        )
        return Rejected("task", reason, detail, payload)
    assert evidence is not None

    if _normalize_title(task.title) in seen_titles:
        return Rejected("task", RejectReason.DUPLICATE, "이미 존재하는 업무", payload)

    assignee = resolve_assignee(task.assignee_hint, members)
    deadline = resolve_deadline(task.deadline_hint, meeting_date)

    warnings: list[str] = []
    if task.assignee_hint and assignee.user_id is None:
        warnings.append(f"담당자 미확정 — {assignee.reason}")
    elif not task.assignee_hint:
        warnings.append("회의에서 담당자가 지정되지 않았습니다")

    if task.deadline_hint and deadline.value is None:
        warnings.append(f"마감일 미확정 — {deadline.reason}")
    elif not task.deadline_hint:
        warnings.append("회의에서 마감일이 언급되지 않았습니다")

    if deadline.value and deadline.value < meeting_date:
        warnings.append("해석된 마감일이 회의일보다 이전입니다. 확인이 필요합니다")

    if deadline.confidence and deadline.confidence < 0.7:
        warnings.append(f"마감일 해석 확신도가 낮습니다 ({deadline.reason})")

    return ResolvedCandidate(
        title=task.title.strip(),
        assignee=assignee,
        deadline=deadline,
        llm_confidence=task.confidence,
        evidence_utterance_ids=evidence,
        warnings=tuple(warnings),
        assignee_hint=task.assignee_hint,
    )
