"""탐지기가 **실제로 불리고 화면까지 가는가** (정의서 §12).

⚠️ `test_inefficiency.py` 는 순수 함수를 잽니다. 이 파일은 다른 것을
잽니다 — **아무도 안 부르는 함수가 되지 않았는가.** 결함 122 가 정확히
그것이었습니다: 어휘에 다섯 값이 있고 CHECK 제약도 받아 주는데 만드는
코드가 하나뿐이었고, 오류는 안 났습니다.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.db import vocab
from teamflow.services import inefficiency_service, meeting_contribution_service

from .test_api import client, engine, seeded  # noqa: F401  (픽스처)

M = 60_000


@pytest.fixture
def long_meeting(seeded) -> None:
    """반복 논의와 주제 이탈이 둘 다 나오는 회의."""
    lines = [
        (0, "로그인 인증 방식을 JWT 토큰으로 정할까요"),
        (1, "JWT 토큰 인증이 로그인 흐름에 맞습니다"),
        (12, "잠깐 점심 뭐 먹을지 정해야 하는데요 김치찌개"),
        (13, "김치찌개 말고 파스타 먹으러 갑시다 점심은"),
        (25, "인증 방식 다시 볼까요 JWT 토큰 로그인"),
        (26, "JWT 로그인 인증 토큰 아까 정했잖아요"),
    ]
    with db_session.session_scope() as session:
        for i, (minute, text) in enumerate(lines):
            session.add(
                m.Utterance(
                    meeting_id=seeded["meeting_id"],
                    speaker_id=seeded["user_ids"][i % 2],
                    start_ms=minute * M,
                    end_ms=minute * M + 9_000,
                    text=text,
                    speaker_source="track",
                )
            )


def kinds(session) -> list[str]:
    return [
        row.event_type
        for row in session.query(m.MeetingEvent).all()
    ]


def test_the_detectors_run_and_write_rows(seeded, long_meeting):
    with db_session.session_scope() as session:
        counts = inefficiency_service.detect(session, seeded["meeting_id"])
    assert counts.get("repeated_discussion", 0) >= 1
    assert counts.get("topic_drift", 0) >= 1


def test_running_twice_does_not_pile_up(seeded, long_meeting):
    """⭐ 회의를 재처리하면 탐지도 다시 돕니다.

    안 지우고 넣으면 같은 지적이 두 번 쌓이고, 화면은 "반복 논의 4건"
    이라고 말합니다 — 실제로는 두 건인데 두 번 돌린 것입니다.
    """
    with db_session.session_scope() as session:
        first = inefficiency_service.detect(session, seeded["meeting_id"])
    with db_session.session_scope() as session:
        second = inefficiency_service.detect(session, seeded["meeting_id"])
    assert first == second

    with db_session.session_scope() as session:
        assert len(kinds(session)) == sum(second.values())


def test_it_never_deletes_rows_it_did_not_make(seeded, long_meeting):
    """⭐ `unanswered_question` 은 **LLM 경로**가 만듭니다.

    남의 행을 지우면 재처리할 때마다 회의록의 절반이 사라집니다.
    """
    with db_session.session_scope() as session:
        session.add(
            m.MeetingEvent(
                meeting_id=seeded["meeting_id"],
                event_type="unanswered_question",
                severity="info",
                start_ms=0,
                end_ms=1,
                evidence_utterance_ids=[],
                detail={"content": "남의 행"},
            )
        )

    with db_session.session_scope() as session:
        inefficiency_service.detect(session, seeded["meeting_id"])

    with db_session.session_scope() as session:
        assert "unanswered_question" in kinds(session)


def test_the_pipeline_calls_the_detectors(seeded, long_meeting):
    """⭐ **아무도 안 부르는 함수가 되지 않았는가** (대표 실패 ①).

    `record_meeting` 이 회의 처리의 끝자락입니다. 여기서 안 부르면 탐지기는
    테스트에서만 도는 코드가 됩니다 — 결함 122 가 그 상태였습니다.
    """
    with db_session.session_scope() as session:
        meeting = session.get(m.Meeting, seeded["meeting_id"])
        result = meeting_contribution_service.record_meeting(session, meeting)

    assert "inefficiency" in result, (
        "`record_meeting` 이 탐지 결과를 안 돌려줍니다 — 안 부르고 있을 수 있습니다"
    )
    assert result["inefficiency"], "탐지기가 아무것도 못 찾았습니다"


def test_classification_runs_before_detection(seeded):
    """⚠️ 순서가 뒤집히면 **조용히 0건**이 됩니다.

    미완성 업무 탐지가 `utterance_type == "commitment"` 을 봅니다. 분류
    전에 부르면 라벨이 전부 `None` 이라 오류 없이 아무것도 안 나옵니다.
    """
    with db_session.session_scope() as session:
        session.add(
            m.Utterance(
                meeting_id=seeded["meeting_id"],
                speaker_id=seeded["user_ids"][0],
                start_ms=0,
                end_ms=5_000,
                text="제가 로그인 API 를 내일까지 하겠습니다",
                speaker_source="track",
            )
        )

    with db_session.session_scope() as session:
        meeting = session.get(m.Meeting, seeded["meeting_id"])
        meeting_contribution_service.record_meeting(session, meeting)

    with db_session.session_scope() as session:
        assert "incomplete_task" in kinds(session), (
            "약속이 후보로 안 이어졌는데 못 잡았습니다 — 분류가 탐지보다 "
            "뒤에 도는지 보십시오"
        )


# ══════════════════════════════════════════════════════════════
# 화면까지 가는가
# ══════════════════════════════════════════════════════════════


def test_the_meeting_endpoint_carries_the_findings(
    client: TestClient, seeded, long_meeting
):
    """⭐ 만들어 놓고 **화면이 못 받으면** DB 까지만 간 것입니다.

    `next_agenda`·`unresolved_issues` 가 실제로 그랬습니다 (결함 110·111).
    """
    with db_session.session_scope() as session:
        inefficiency_service.detect(session, seeded["meeting_id"])

    body = client.get(f"/api/meetings/{seeded['meeting_id']}").json()
    assert body["findings"], "회의 상세에 비효율 구간이 안 실립니다"
    assert {f["kind"] for f in body["findings"]} <= set(vocab.event_values())


def test_the_findings_carry_a_reason(client: TestClient, seeded, long_meeting):
    """⭐ 근거 없는 지적은 반박할 수 없고, 반박할 수 없으면 잔소리입니다."""
    with db_session.session_scope() as session:
        inefficiency_service.detect(session, seeded["meeting_id"])

    for one in client.get(f"/api/meetings/{seeded['meeting_id']}").json()["findings"]:
        assert one["detail"], f"{one['kind']}: 왜 걸렸는지가 비었습니다"
        pointers = one["evidence_utterance_ids"] or one["detail"].get("decision_ids")
        assert pointers, f"{one['kind']}: 가리키는 것이 없습니다"


def test_the_findings_do_not_carry_a_severity(
    client: TestClient, seeded, long_meeting
):
    """⭐ **회의를 빨갛게 칠할 재료를 안 줍니다.**

    `severity` 는 전부 `info` 라 실을 이유가 없고, 실으면 화면이 그걸로
    등급을 칠하게 됩니다. 규칙 기반 추정에 등급을 매기면 그건 **팀에
    대한 판정**입니다 (`AGENTS.md` 불변식 4).
    """
    with db_session.session_scope() as session:
        inefficiency_service.detect(session, seeded["meeting_id"])

    for one in client.get(f"/api/meetings/{seeded['meeting_id']}").json()["findings"]:
        assert "severity" not in one, "등급이 화면으로 나갑니다"


def test_the_findings_never_name_a_person(client: TestClient, seeded, long_meeting):
    """⭐ 이건 **회의**에 대한 관찰이지 사람에 대한 것이 아닙니다.

    화자가 실리면 화면이 "누가 회의를 늘어지게 했는가" 를 만들 수 있습니다.
    """
    with db_session.session_scope() as session:
        inefficiency_service.detect(session, seeded["meeting_id"])
        names = {u.name for u in session.query(m.User).all()}

    flat = repr(client.get(f"/api/meetings/{seeded['meeting_id']}").json()["findings"])
    for name in names:
        assert name not in flat, f"비효율 구간에 사람 이름이 있습니다: {name}"
    for key in ("speaker", "user_id"):
        assert key not in flat, f"비효율 구간에 `{key}` 가 있습니다"


def test_everything_the_vocabulary_names_can_be_stored(seeded):
    """⭐ 어휘에 있는 값이 DB 에 **정말 들어가는가.**

    ⚠️ 예전에는 반대였습니다 — `speaker_source` 에서 enum 은 일곱을
    선언하는데 CHECK 가 넷만 받아, 융합 로직의 결과를 **저장할 수가
    없었습니다**(결함 118). 값이 늘어날 때마다 이걸 봐야 합니다.
    """
    with db_session.session_scope() as session:
        for kind in vocab.event_values():
            session.add(
                m.MeetingEvent(
                    meeting_id=seeded["meeting_id"],
                    event_type=kind,
                    severity="info",
                    start_ms=0,
                    end_ms=1,
                    evidence_utterance_ids=[],
                    detail={},
                )
            )
        session.flush()
