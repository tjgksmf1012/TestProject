"""LLM 출력 계약.

docs/04-회의-처리-파이프라인.md §4

이 스키마는 프롬프트로 '부탁'하는 게 아니라 **디코딩 단계에서 강제**한다.
vLLM + xgrammar guided decoding이 JSON Schema로 문법을 만들어 매 토큰마다 마스크를 씌우므로,
스키마를 벗어나는 출력이 원리적으로 불가능해진다.

    schema = MeetingAnalysis.model_json_schema()
    # vLLM: guided_json=schema, guided_decoding_backend="xgrammar"
    # llama.cpp: JSON Schema → GBNF 변환 후 grammar 지정

이 결정 하나로 소형 모델의 실용성이 달라진다. 형식 붕괴가 사라지면
남는 약점은 내용 정확도뿐이다.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class TaskCandidate(BaseModel):
    """회의에서 추출한 업무 **후보**. 승인 전에는 절대 tasks 가 되지 않는다."""

    title: str = Field(description="업무 제목. 회의에서 언급된 표현을 유지할 것")

    assignee_hint: str | None = Field(
        default=None,
        description=(
            "전사에 등장한 담당자 이름 그대로. '민수', '김민수', '민수님' 등. "
            "추측하지 말고 실제로 언급된 것만. 없으면 null"
        ),
    )

    deadline_hint: str | None = Field(
        default=None,
        description=(
            "전사에 등장한 마감 표현 그대로. '금요일까지', '다음 주 월요일', '8월 8일' 등. "
            "날짜로 변환하지 말 것 — 서버가 회의일 기준으로 해석한다. 없으면 null"
        ),
    )

    confidence: float = Field(ge=0.0, le=1.0, description="이 추출의 확신도")

    evidence_utterance_ids: list[int] = Field(
        min_length=1,
        description=(
            "근거가 된 발화 ID. 반드시 입력에 실제로 존재하는 ID여야 한다. "
            "서버가 검증하며, 존재하지 않는 ID를 참조하면 이 후보는 폐기된다"
        ),
    )


class Decision(BaseModel):
    content: str = Field(description="결정된 내용 한 문장")

    supersedes_hint: str | None = Field(
        default=None,
        description="이 결정이 뒤집은 이전 결정이 있으면 그 내용. 없으면 null",
    )

    evidence_utterance_ids: list[int] = Field(min_length=1)


class UnresolvedIssue(BaseModel):
    content: str = Field(description="논의됐지만 결론이 나지 않은 사안")
    evidence_utterance_ids: list[int] = Field(min_length=1)


class MeetingAnalysis(BaseModel):
    """LLM이 회의 전사로부터 만들어야 하는 전체 구조."""

    summary: str = Field(description="회의 요약 3~5문장")
    decisions: list[Decision] = Field(default_factory=list)
    tasks: list[TaskCandidate] = Field(default_factory=list)
    unresolved_issues: list[UnresolvedIssue] = Field(default_factory=list)
    next_agenda: list[str] = Field(
        default_factory=list, description="다음 회의에서 다룰 안건"
    )


def json_schema() -> dict:
    """guided decoding 백엔드에 넘길 JSON Schema."""
    return MeetingAnalysis.model_json_schema()


# ── 프롬프트 ──────────────────────────────────────────────────
#
# 업무 추출은 **recall 우선**이다 (docs/04 §5.1).
# 업무 하나를 놓치면 담당자의 기여도가 통째로 누락되지만,
# 잘못 뽑힌 업무는 승인 화면에서 사람이 지우면 끝이다.

SYSTEM_PROMPT = """당신은 대학생 팀 프로젝트 회의록을 구조화하는 도구입니다.

규칙:
1. 회의에서 **실제로 언급된 것만** 추출하세요. 추측하거나 보완하지 마세요.
2. 모든 항목에 근거가 된 발화 ID를 반드시 넣으세요. 근거가 없으면 그 항목을 만들지 마세요.
3. 담당자와 마감일은 **전사에 나온 표현 그대로** 적으세요. 날짜로 변환하지 마세요.
4. 업무는 **빠뜨리는 것보다 많이 뽑는 편**이 낫습니다. 사람이 검토해서 지웁니다.
   담당자나 마감일이 없는 업무도 후보로 넣고 confidence를 낮추세요.
5. 확신이 낮으면 confidence를 낮게 주세요. 항목을 빼지는 마세요."""


def build_user_prompt(
    transcript: str,
    *,
    prior_decisions: list[str] | None = None,
    open_tasks: list[str] | None = None,
) -> str:
    """전사와 맥락으로 사용자 프롬프트를 만든다.

    이전 회의 결정과 현재 칸반 상태를 같이 넣어야 결정 번복을 잡을 수 있다
    (제안서 5장: "지난주에 JWT로 결정했는데 세션으로 바꾸자").
    """
    parts = ["# 회의 전사\n", transcript]

    if prior_decisions:
        parts.append("\n\n# 이전 회의에서 확정된 결정")
        parts.extend(f"\n- {d}" for d in prior_decisions)
        parts.append(
            "\n\n위 결정과 모순되는 발언이 있으면 supersedes_hint 에 해당 결정을 적으세요."
        )

    if open_tasks:
        parts.append("\n\n# 현재 진행 중인 업무")
        parts.extend(f"\n- {t}" for t in open_tasks)
        parts.append("\n\n이미 있는 업무는 새로 만들지 마세요.")

    return "".join(parts)


def format_transcript(
    utterances: list[tuple[int, str, str]],
) -> str:
    """발화 목록을 LLM 입력 형식으로 만든다.

    Args:
        utterances: (발화 ID, 화자 표시명, 텍스트) 목록

    Returns:
        ``[12] 김민수: 로그인은 제가 금요일까지 하겠습니다`` 형태의 줄들.

    발화 ID를 대괄호로 앞에 붙이는 게 핵심이다.
    이게 있어야 LLM이 evidence_utterance_ids 를 채울 수 있다.
    """
    return "\n".join(f"[{uid}] {speaker}: {text}" for uid, speaker, text in utterances)
