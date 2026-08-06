"""LLM 클라이언트 — 백엔드 교체 가능한 인터페이스.

세 가지 구현을 상정한다.
    FakeLLMClient      테스트용. GPU 없이 전체 파이프라인을 검증한다
    VLLMClient         GPU. vLLM + xgrammar guided decoding
    LlamaCppClient     CPU. llama.cpp + GBNF 문법 (RAM 32GB면 이쪽이 1순위)

docs/02 §5 전략 C에 따라 CPU 경로가 기본이 될 수 있으므로,
호출부는 어느 구현인지 몰라야 한다.

⚠️ VLLMClient / LlamaCppClient 는 이 개발 환경에 GPU와 모델이 없어
**아직 실행 검증되지 않았습니다.** 실제 머신에서 확인이 필요합니다.
"""

from __future__ import annotations

import json
from typing import Protocol

from teamflow.meeting.schema import (
    SYSTEM_PROMPT,
    MeetingAnalysis,
    build_user_prompt,
    json_schema,
)


class LLMClient(Protocol):
    def analyze_meeting(
        self,
        transcript: str,
        *,
        prior_decisions: list[str] | None = None,
        open_tasks: list[str] | None = None,
    ) -> MeetingAnalysis: ...


class FakeLLMClient:
    """미리 정해둔 결과를 돌려주는 테스트용 클라이언트.

    GPU 없이 검증·해석·승인 파이프라인 전체를 테스트할 수 있게 한다.
    환각 상황(존재하지 않는 발화 ID 참조)도 이걸로 재현한다.
    """

    def __init__(self, response: MeetingAnalysis | list[MeetingAnalysis]) -> None:
        self._queue = list(response) if isinstance(response, list) else [response]
        self.calls: list[str] = []

    def analyze_meeting(
        self,
        transcript: str,
        *,
        prior_decisions: list[str] | None = None,
        open_tasks: list[str] | None = None,
    ) -> MeetingAnalysis:
        self.calls.append(
            build_user_prompt(transcript, prior_decisions=prior_decisions, open_tasks=open_tasks)
        )
        if len(self._queue) > 1:
            return self._queue.pop(0)
        return self._queue[0]


class VLLMClient:
    """vLLM + xgrammar guided decoding (GPU).

    스키마를 벗어나는 토큰은 생성 자체가 불가능하므로 파싱 실패율이 0이 된다.
    같은 스키마를 반복 사용하므로 xgrammar의 문법 캐싱 이득이 크다.
    """

    def __init__(
        self,
        base_url: str = "http://localhost:8000/v1",
        model: str = "Qwen/Qwen3-8B-AWQ",
        *,
        timeout: float = 600.0,
        max_tokens: int = 4096,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.max_tokens = max_tokens

    def analyze_meeting(
        self,
        transcript: str,
        *,
        prior_decisions: list[str] | None = None,
        open_tasks: list[str] | None = None,
    ) -> MeetingAnalysis:
        import httpx

        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": build_user_prompt(
                        transcript, prior_decisions=prior_decisions, open_tasks=open_tasks
                    ),
                },
            ],
            "temperature": 0.1,
            "max_tokens": self.max_tokens,
            # 여기가 핵심 — 형식을 프롬프트가 아니라 디코딩으로 강제한다
            "guided_json": json_schema(),
            "guided_decoding_backend": "xgrammar",
        }
        response = httpx.post(
            f"{self.base_url}/chat/completions", json=payload, timeout=self.timeout
        )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        return MeetingAnalysis.model_validate_json(content)


class LlamaCppClient:
    """llama.cpp 서버 + GBNF 문법 (CPU).

    RAM 32GB 환경에서는 이쪽이 1순위다 (docs/02 §5 전략 C).
    GPU는 ASR·화자분리에만 쓰고 LLM은 CPU가 맡으면 VRAM 압박이 사라지고,
    GPU/CPU가 병렬로 일할 수 있다.

    llama.cpp 서버는 OpenAI 호환 엔드포인트에서 `response_format` 의
    `json_schema` 를 지원한다 (내부적으로 GBNF로 변환).
    """

    def __init__(
        self,
        base_url: str = "http://localhost:8080/v1",
        model: str = "local",
        *,
        timeout: float = 1800.0,  # CPU라 넉넉하게
        max_tokens: int = 4096,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.max_tokens = max_tokens

    def analyze_meeting(
        self,
        transcript: str,
        *,
        prior_decisions: list[str] | None = None,
        open_tasks: list[str] | None = None,
    ) -> MeetingAnalysis:
        import httpx

        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": build_user_prompt(
                        transcript, prior_decisions=prior_decisions, open_tasks=open_tasks
                    ),
                },
            ],
            "temperature": 0.1,
            "max_tokens": self.max_tokens,
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "meeting_analysis", "schema": json_schema()},
            },
        }
        response = httpx.post(
            f"{self.base_url}/chat/completions", json=payload, timeout=self.timeout
        )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        return MeetingAnalysis.model_validate_json(content)


def export_schema(path: str) -> None:
    """JSON Schema를 파일로 내보낸다.

    llama.cpp의 `json_schema_to_grammar.py` 로 GBNF를 만들 때 쓴다.
    """
    with open(path, "w", encoding="utf-8") as f:
        json.dump(json_schema(), f, ensure_ascii=False, indent=2)
