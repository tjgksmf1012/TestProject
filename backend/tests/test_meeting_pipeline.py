"""회의 분석 → 업무 후보 → 승인 → 칸반 등록.

docs/08-MVP-로드맵.md §5: 이 흐름이 프로젝트의 유일한 성공 기준이다.

    "가장 중요한 완성 기준은 '회의에서 나온 업무가 실제 칸반과
     GitHub 활동으로 이어지는 흐름'이다."

GPU 없이 검증하기 위해 LLM 호출부는 FakeLLMClient 로 대체한다.
검증·해석·승인 로직은 실제 구현 그대로다.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

import pytest

from teamflow.meeting.approval import (
    ApprovalError,
    ApprovalRequest,
    CandidateStatus,
    StoredCandidate,
    apply_approval,
    apply_batch,
)
from teamflow.meeting.llm import FakeLLMClient
from teamflow.meeting.resolve import TeamMemberName
from teamflow.meeting.schema import (
    Decision,
    MeetingAnalysis,
    TaskCandidate,
    UnresolvedIssue,
    format_transcript,
)
from teamflow.meeting.validation import RejectReason, validate_analysis

MEETING_DATE = date(2026, 9, 1)  # 화요일
NOW = datetime(2026, 9, 1, 20, 0, tzinfo=UTC)
PROJECT_ID = 7
MEETING_ID = 42
MEMBER_IDS = frozenset({1, 2, 3})

TEAM = [
    TeamMemberName(user_id=1, name="김민수"),
    TeamMemberName(user_id=2, name="이하늘"),
    TeamMemberName(user_id=3, name="박지원"),
]

# 제안서 18장 시연 시나리오를 그대로 옮긴 전사
TRANSCRIPT_UTTERANCES = [
    (101, "김민수", "로그인 API는 제가 이번 주 금요일까지 구현하겠습니다."),
    (102, "이하늘", "그럼 디자인 시안은 제가 수요일까지 올릴게요."),
    (103, "박지원", "인증 방식은 JWT로 가는 걸로 정하죠."),
    (104, "김민수", "네 좋습니다."),
    (105, "이하늘", "통합 테스트도 해야 하는데요."),
    (106, "박지원", "배포 서버는 아직 못 정했습니다."),
]
KNOWN_IDS = {u[0] for u in TRANSCRIPT_UTTERANCES}


def make_analysis(**overrides) -> MeetingAnalysis:
    base = {
        "summary": "로그인 API와 디자인 일정, 인증 방식을 논의함.",
        "decisions": [
            Decision(content="인증 방식은 JWT를 사용한다", evidence_utterance_ids=[103])
        ],
        "tasks": [
            TaskCandidate(
                title="로그인 API 구현",
                assignee_hint="김민수",
                deadline_hint="이번 주 금요일",
                confidence=0.94,
                evidence_utterance_ids=[101],
            ),
            TaskCandidate(
                title="디자인 시안 작성",
                assignee_hint="이하늘",
                deadline_hint="수요일",
                confidence=0.91,
                evidence_utterance_ids=[102],
            ),
        ],
        "unresolved_issues": [
            UnresolvedIssue(content="배포 서버 미정", evidence_utterance_ids=[106])
        ],
        "next_agenda": ["배포 서버 선정"],
    }
    base.update(overrides)
    return MeetingAnalysis(**base)


def validate(analysis: MeetingAnalysis, **kwargs):
    return validate_analysis(
        analysis,
        known_utterance_ids=KNOWN_IDS,
        members=TEAM,
        meeting_date=MEETING_DATE,
        **kwargs,
    )


# ══════════════════════════════════════════════════════════════
# 1. 전사 포맷 — 발화 ID가 있어야 근거를 붙일 수 있다
# ══════════════════════════════════════════════════════════════


def test_transcript_includes_utterance_ids():
    text = format_transcript(TRANSCRIPT_UTTERANCES)
    assert "[101] 김민수: 로그인 API는" in text
    # LLM이 evidence_utterance_ids 를 채울 수 있으려면 ID가 노출되어야 한다
    for uid, _, _ in TRANSCRIPT_UTTERANCES:
        assert f"[{uid}]" in text


# ══════════════════════════════════════════════════════════════
# 2. 환각 방어
# ══════════════════════════════════════════════════════════════


def test_task_with_unknown_utterance_id_is_rejected():
    """존재하지 않는 발화를 근거로 든 업무는 버린다.

    LLM이 없는 업무를 지어내면 여기서 걸린다.
    """
    analysis = make_analysis(
        tasks=[
            TaskCandidate(
                title="서버 배포 자동화",  # 회의에서 나온 적 없음
                assignee_hint="김민수",
                deadline_hint="금요일",
                confidence=0.88,
                evidence_utterance_ids=[999],  # 존재하지 않는 ID
            )
        ]
    )
    result = validate(analysis)
    assert result.candidates == []
    assert len(result.rejected) == 1
    assert result.rejected[0].reason == RejectReason.UNKNOWN_UTTERANCE


def test_partial_hallucination_keeps_valid_items():
    """일부만 환각이면 나머지는 살린다."""
    analysis = make_analysis(
        tasks=[
            TaskCandidate(
                title="로그인 API 구현",
                assignee_hint="김민수",
                deadline_hint="금요일",
                confidence=0.9,
                evidence_utterance_ids=[101],
            ),
            TaskCandidate(
                title="존재하지 않는 업무",
                assignee_hint="이하늘",
                deadline_hint="월요일",
                confidence=0.9,
                evidence_utterance_ids=[777],
            ),
        ]
    )
    result = validate(analysis)
    assert len(result.candidates) == 1
    assert result.candidates[0].title == "로그인 API 구현"
    assert len(result.rejected) == 1


def test_hallucinated_decision_is_rejected():
    analysis = make_analysis(
        decisions=[Decision(content="지어낸 결정", evidence_utterance_ids=[888])]
    )
    result = validate(analysis)
    assert result.decisions == []
    assert any(r.kind == "decision" for r in result.rejected)


def test_rejection_rate_signals_model_problems():
    """폐기율이 높으면 모델·프롬프트 문제라는 신호."""
    analysis = make_analysis(
        tasks=[
            TaskCandidate(
                title=f"가짜 업무 {i}",
                confidence=0.5,
                evidence_utterance_ids=[900 + i],
            )
            for i in range(4)
        ],
        decisions=[],
        unresolved_issues=[],
    )
    result = validate(analysis)
    assert result.rejection_rate == 1.0


def test_empty_title_rejected():
    analysis = make_analysis(
        tasks=[
            TaskCandidate(title="   ", confidence=0.9, evidence_utterance_ids=[101])
        ]
    )
    result = validate(analysis)
    assert result.rejected[0].reason == RejectReason.EMPTY_TITLE


def test_duplicate_of_existing_task_is_rejected():
    """이미 칸반에 있는 업무를 또 만들지 않는다."""
    result = validate(make_analysis(), existing_task_titles=["로그인 API 구현"])
    titles = [c.title for c in result.candidates]
    assert "로그인 API 구현" not in titles
    assert any(r.reason == RejectReason.DUPLICATE for r in result.rejected)


def test_duplicate_within_same_analysis_is_rejected():
    analysis = make_analysis(
        tasks=[
            TaskCandidate(
                title="로그인 API 구현",
                confidence=0.9,
                evidence_utterance_ids=[101],
            ),
            TaskCandidate(
                title="로그인  API   구현",  # 공백만 다름
                confidence=0.8,
                evidence_utterance_ids=[104],
            ),
        ]
    )
    result = validate(analysis)
    assert len(result.candidates) == 1


# ══════════════════════════════════════════════════════════════
# 3. 담당자·마감일 해석 통합
# ══════════════════════════════════════════════════════════════


def test_happy_path_resolves_everything():
    result = validate(make_analysis())
    assert len(result.candidates) == 2

    login = result.candidates[0]
    assert login.assignee.user_id == 1
    assert login.deadline.value == date(2026, 9, 4)  # 이번 주 금요일
    assert login.is_complete
    assert login.warnings == ()

    design = result.candidates[1]
    assert design.assignee.user_id == 2
    assert design.deadline.value == date(2026, 9, 2)  # 다음 수요일
    assert design.is_complete


def test_missing_assignee_produces_incomplete_candidate():
    """제안서 6.5의 '담당자·마감일이 빠진 불완전 업무' 탐지."""
    analysis = make_analysis(
        tasks=[
            TaskCandidate(
                title="통합 테스트",
                assignee_hint=None,
                deadline_hint=None,
                confidence=0.6,
                evidence_utterance_ids=[105],
            )
        ]
    )
    result = validate(analysis)
    candidate = result.candidates[0]
    assert not candidate.is_complete
    assert len(result.incomplete_candidates) == 1
    assert any("담당자가 지정되지 않았" in w for w in candidate.warnings)
    assert any("마감일이 언급되지 않았" in w for w in candidate.warnings)


def test_unresolvable_assignee_is_warned_not_guessed():
    analysis = make_analysis(
        tasks=[
            TaskCandidate(
                title="테스트",
                assignee_hint="최영희",  # 팀원이 아님
                deadline_hint="금요일",
                confidence=0.9,
                evidence_utterance_ids=[101],
            )
        ]
    )
    result = validate(analysis)
    candidate = result.candidates[0]
    assert candidate.assignee.user_id is None
    assert not candidate.is_complete
    assert any("담당자 미확정" in w for w in candidate.warnings)


def test_overall_confidence_is_the_weakest_link():
    """전체 확신도는 가장 약한 고리를 따른다. 승인 화면 정렬에 쓴다."""
    analysis = make_analysis(
        tasks=[
            TaskCandidate(
                title="테스트",
                assignee_hint="김민수",
                deadline_hint="이번 주 월요일",  # 이미 지남 → 확신도 0.5
                confidence=0.99,
                evidence_utterance_ids=[101],
            )
        ]
    )
    result = validate(analysis)
    candidate = result.candidates[0]
    assert candidate.llm_confidence == 0.99
    assert candidate.overall_confidence <= 0.6


# ══════════════════════════════════════════════════════════════
# 4. 승인 워크플로 불변식
# ══════════════════════════════════════════════════════════════


def make_candidate(**overrides) -> StoredCandidate:
    base = dict(
        id=1,
        meeting_id=MEETING_ID,
        title="로그인 API 구현",
        assignee_id=1,
        deadline=date(2026, 9, 4),
        confidence=0.9,
        evidence_utterance_ids=(101,),
    )
    base.update(overrides)
    return StoredCandidate(**base)


def approve(candidate, **kwargs):
    request = ApprovalRequest(
        candidate_id=candidate.id, reviewer_id=kwargs.pop("reviewer_id", 3), approve=True, **kwargs
    )
    return apply_approval(
        candidate,
        request,
        project_id=PROJECT_ID,
        project_member_ids=MEMBER_IDS,
        now=NOW,
        today=MEETING_DATE,
    )


def test_approval_creates_task():
    outcome = approve(make_candidate())
    assert outcome.ok
    assert outcome.task is not None
    assert outcome.task.title == "로그인 API 구현"
    assert outcome.task.assignee_id == 1
    assert outcome.task.deadline == date(2026, 9, 4)
    assert outcome.task.origin_candidate_id == 1
    assert outcome.candidate.status is CandidateStatus.APPROVED
    assert outcome.candidate.reviewed_by == 3


def test_task_carries_evidence_back_to_utterances():
    """업무에서 원본 발화로 역추적할 수 있어야 한다."""
    outcome = approve(make_candidate())
    assert outcome.task.evidence_utterance_ids == (101,)


def test_approval_is_idempotent():
    """두 번 눌러도 업무는 하나. 승인 버튼 연타 방어."""
    first = approve(make_candidate())
    second = approve(first.candidate)
    assert first.task is not None
    assert second.task is None  # 두 번째는 업무를 만들지 않는다
    assert second.ok


def test_cannot_approve_without_assignee():
    """불변식: 담당자 없이는 칸반에 올라가지 않는다."""
    outcome = approve(make_candidate(assignee_id=None))
    assert not outcome.ok
    assert ApprovalError.MISSING_ASSIGNEE in outcome.errors
    assert outcome.task is None


def test_cannot_approve_without_deadline():
    outcome = approve(make_candidate(deadline=None))
    assert not outcome.ok
    assert ApprovalError.MISSING_DEADLINE in outcome.errors


def test_human_can_fill_missing_fields():
    """AI가 못 채운 것을 사람이 채우면 승인된다."""
    outcome = approve(
        make_candidate(assignee_id=None, deadline=None),
        assignee_override=2,
        deadline_override=date(2026, 9, 10),
    )
    assert outcome.ok
    assert outcome.task.assignee_id == 2
    assert outcome.task.deadline == date(2026, 9, 10)


def test_assignee_must_be_project_member():
    outcome = approve(make_candidate(), assignee_override=999)
    assert ApprovalError.UNKNOWN_ASSIGNEE in outcome.errors


def test_past_deadline_rejected():
    outcome = approve(make_candidate(deadline=date(2026, 8, 1)))
    assert ApprovalError.DEADLINE_IN_PAST in outcome.errors


def test_rejected_candidate_cannot_be_approved():
    rejected = make_candidate(status=CandidateStatus.REJECTED)
    outcome = approve(rejected)
    assert not outcome.ok
    assert ApprovalError.ALREADY_REJECTED in outcome.errors
    assert outcome.task is None


def test_rejection_creates_no_task():
    request = ApprovalRequest(candidate_id=1, reviewer_id=3, approve=False, note="중복입니다")
    outcome = apply_approval(
        make_candidate(),
        request,
        project_id=PROJECT_ID,
        project_member_ids=MEMBER_IDS,
        now=NOW,
        today=MEETING_DATE,
    )
    assert outcome.ok
    assert outcome.task is None
    assert outcome.candidate.status is CandidateStatus.REJECTED
    assert outcome.audit[0].action == "candidate_rejected"


def test_every_state_change_is_audited():
    """불변식: 모든 상태 변화는 감사 로그에 남는다."""
    outcome = approve(make_candidate())
    assert outcome.audit
    entry = outcome.audit[0]
    assert entry.actor_id == 3
    assert entry.action == "candidate_approved"
    assert entry.target == "meeting_task_candidates/1"
    assert entry.at == NOW


def test_human_corrections_are_logged_separately():
    """사람이 AI 결과를 고치면 별도 로그가 남는다.

    이 로그가 쌓이면 모델 개선의 학습 신호가 된다 (제안서 12장).
    """
    outcome = approve(
        make_candidate(),
        assignee_override=2,
        deadline_override=date(2026, 9, 8),
        title_override="로그인 API 및 세션 구현",
    )
    actions = [a.action for a in outcome.audit]
    assert "ai_output_corrected" in actions
    correction = next(a for a in outcome.audit if a.action == "ai_output_corrected")
    assert correction.after["assignee_id"] == {"from": 1, "to": 2}
    assert correction.after["title"]["to"] == "로그인 API 및 세션 구현"


def test_no_correction_log_when_nothing_changed():
    outcome = approve(make_candidate())
    assert [a.action for a in outcome.audit] == ["candidate_approved"]


def test_batch_partial_failure_does_not_block_others():
    """하나가 실패해도 나머지는 진행한다."""
    candidates = {
        1: make_candidate(id=1),
        2: make_candidate(id=2, title="디자인 시안", assignee_id=None),
        3: make_candidate(id=3, title="테스트 작성", assignee_id=2),
    }
    requests = [
        ApprovalRequest(candidate_id=i, reviewer_id=3, approve=True) for i in (1, 2, 3)
    ]
    outcome = apply_batch(
        candidates,
        requests,
        project_id=PROJECT_ID,
        project_member_ids=MEMBER_IDS,
        now=NOW,
        today=MEETING_DATE,
    )
    assert len(outcome.approved) == 2
    assert 2 in outcome.failures
    assert ApprovalError.MISSING_ASSIGNEE in outcome.failures[2]


# ══════════════════════════════════════════════════════════════
# 5. 전 구간 통합 — docs/08 §5.1 데모 성공 조건
# ══════════════════════════════════════════════════════════════


def test_end_to_end_transcript_to_kanban():
    """회의 녹음 → 분석 → 후보 → 승인 → 칸반 등록.

    이 경로가 끊김 없이 돌아가는 것이 프로젝트의 유일한 성공 기준이다.
    """
    # 1. 전사를 LLM 입력 형식으로
    transcript = format_transcript(TRANSCRIPT_UTTERANCES)

    # 2. LLM 호출 (GPU 없이 Fake로 대체. 검증·해석·승인은 실제 구현)
    client = FakeLLMClient(make_analysis())
    analysis = client.analyze_meeting(
        transcript,
        prior_decisions=["프론트엔드는 Next.js를 쓴다"],
        open_tasks=["DB 스키마 설계"],
    )
    assert "이전 회의에서 확정된 결정" in client.calls[0]
    assert "현재 진행 중인 업무" in client.calls[0]

    # 3. 검증 + 해석
    result = validate(analysis, existing_task_titles=["DB 스키마 설계"])
    assert result.rejected == []
    assert len(result.candidates) == 2
    assert len(result.decisions) == 1
    assert len(result.unresolved_issues) == 1

    # 4. 저장 형태로 변환
    stored = {
        i: StoredCandidate.from_resolved(c, candidate_id=i, meeting_id=MEETING_ID)
        for i, c in enumerate(result.candidates, start=1)
    }
    assert all(c.status is CandidateStatus.PENDING for c in stored.values())

    # 5. 팀장이 일괄 승인
    outcome = apply_batch(
        stored,
        [ApprovalRequest(candidate_id=i, reviewer_id=3, approve=True) for i in stored],
        project_id=PROJECT_ID,
        project_member_ids=MEMBER_IDS,
        now=NOW,
        today=MEETING_DATE,
    )

    # 6. 칸반에 등록될 업무
    assert outcome.ok
    assert len(outcome.approved) == 2

    login = next(t for t in outcome.approved if "로그인" in t.title)
    assert login.assignee_id == 1
    assert login.deadline == date(2026, 9, 4)
    assert login.project_id == PROJECT_ID
    assert login.meeting_id == MEETING_ID
    assert login.evidence_utterance_ids == (101,)

    # 7. 모든 승인이 감사 로그에 남았다
    assert len(outcome.audit) == 2
    assert all(a.action == "candidate_approved" for a in outcome.audit)


def test_end_to_end_blocks_unapproved_candidates_from_kanban():
    """불변식: 승인하지 않은 후보는 절대 칸반에 가지 않는다."""
    result = validate(make_analysis())
    stored = {
        i: StoredCandidate.from_resolved(c, candidate_id=i, meeting_id=MEETING_ID)
        for i, c in enumerate(result.candidates, start=1)
    }
    # 승인 요청을 아예 보내지 않는다
    outcome = apply_batch(
        stored,
        [],
        project_id=PROJECT_ID,
        project_member_ids=MEMBER_IDS,
        now=NOW,
        today=MEETING_DATE,
    )
    assert outcome.approved == []
    assert all(c.status is CandidateStatus.PENDING for c in stored.values())


def test_schema_is_exportable_for_guided_decoding():
    """JSON Schema를 뽑을 수 있어야 vLLM/llama.cpp에 넘길 수 있다."""
    from teamflow.meeting.schema import json_schema

    schema = json_schema()
    assert schema["type"] == "object"
    assert "tasks" in schema["properties"]
    assert "summary" in schema["properties"]
    # 근거 필드가 스키마에 필수로 들어가 있어야 환각 방어가 성립한다
    defs = schema.get("$defs", {})
    assert "evidence_utterance_ids" in defs["TaskCandidate"]["required"]


@pytest.mark.parametrize("bad_confidence", [-0.1, 1.5])
def test_schema_rejects_out_of_range_confidence(bad_confidence: float):
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        TaskCandidate(
            title="테스트", confidence=bad_confidence, evidence_utterance_ids=[101]
        )


def test_schema_requires_at_least_one_evidence():
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        TaskCandidate(title="테스트", confidence=0.9, evidence_utterance_ids=[])
