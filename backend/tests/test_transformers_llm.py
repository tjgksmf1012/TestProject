"""TransformersLLMClient 단위 테스트."""

from __future__ import annotations

import json
from unittest.mock import MagicMock

from teamflow.meeting.llm import LLMClient, TransformersLLMClient
from teamflow.meeting.schema import MeetingAnalysis


def test_transformers_llm_client_protocol():
    client = TransformersLLMClient()
    assert isinstance(client, LLMClient)
    assert client._model is None
    assert client._tokenizer is None


def test_transformers_llm_client_mocked_analysis(monkeypatch):
    client = TransformersLLMClient()

    mock_analysis_dict = {
        "summary": "회의 요약 테스트입니다.",
        "decisions": [
            {"content": "JWT 인증 도입", "evidence_utterance_ids": [1]}
        ],
        "tasks": [
            {
                "title": "로그인 API 개발",
                "assignee_hint": "민수",
                "deadline_hint": "금요일까지",
                "confidence": 0.95,
                "evidence_utterance_ids": [1],
            }
        ],
        "unresolved_issues": [],
        "next_agenda": ["DB 스키마 논의"],
    }
    mock_json_str = "```json\n" + json.dumps(mock_analysis_dict, ensure_ascii=False) + "\n```"

    fake_tokenizer = MagicMock()
    fake_tokenizer.apply_chat_template.return_value = "<mock_prompt>"
    fake_tokenizer.return_value = {"input_ids": MagicMock(shape=[1, 10])}
    fake_tokenizer.decode.return_value = mock_json_str

    fake_model = MagicMock()
    fake_model.generate.return_value = MagicMock()

    monkeypatch.setattr(client, "_ensure_loaded", lambda: None)
    client._tokenizer = fake_tokenizer
    client._model = fake_model
    client.device = "cpu"

    transcript = "[1] 김민수: 로그인 API는 제가 금요일까지 개발하겠습니다."
    result = client.analyze_meeting(transcript)

    assert isinstance(result, MeetingAnalysis)
    assert result.summary == "회의 요약 테스트입니다."
    assert len(result.decisions) == 1
    assert result.decisions[0].content == "JWT 인증 도입"
    assert len(result.tasks) == 1
    assert result.tasks[0].title == "로그인 API 개발"
    assert result.tasks[0].assignee_hint == "민수"
    assert result.tasks[0].evidence_utterance_ids == [1]
    assert result.next_agenda == ["DB 스키마 논의"]
