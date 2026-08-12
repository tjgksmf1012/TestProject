"""회의별 발언 유형 집계 (요구사항 정의서 §10 · `REVIEW-005`).

⚠️ 여기서 제일 중요한 것은 **사람별로 안 센다**는 것입니다. 발언을 사람별로
세는 순간 "누가 제일 많이 제안했나" 표가 만들어지고, 그건 이 저장소가 금지한
리더보드입니다. 그리고 `docs/05` §2.2 가 원본 대화에서 가져온 경고이기도
합니다 — **"회의에서 말을 많이 한다고 기여한 것은 아님".**
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from teamflow.db import models as m
from teamflow.db import session as db_session

from .conftest import login_as
from .test_api import client, engine, seeded  # noqa: F401  (픽스처)


def counts(client: TestClient, meeting_id: int) -> dict:
    return client.get(f"/api/meetings/{meeting_id}/utterance-types").json()


@pytest.fixture
def said(seeded) -> None:
    """분류된 발화 다섯 + 아직 분류 안 한 것 둘."""
    with db_session.session_scope() as session:
        rows = [
            ("로그인부터 할까요?", "proposal"),
            ("동의합니다. 다만 일정이 빠듯해 보입니다", "refinement"),
            ("그 일정은 좀 어려울 것 같습니다", "objection"),
            ("그럼 30분으로 하죠", "decision"),
            ("네", "social"),
            ("아직 안 잰 것", None),
            ("이것도 아직", None),
        ]
        for i, (text, label) in enumerate(rows):
            session.add(
                m.Utterance(
                    meeting_id=seeded["meeting_id"],
                    speaker_id=seeded["user_ids"][i % 2],
                    start_ms=i * 1000,
                    end_ms=i * 1000 + 500,
                    text=text,
                    speaker_source="track",
                    utterance_type=label,
                )
            )


def test_counting_by_type(client: TestClient, seeded, said):
    body = counts(client, seeded["meeting_id"])
    assert body["labels"]["proposal"] == 1
    assert body["labels"]["objection"] == 1
    assert body["labels"]["refinement"] == 1


def test_what_was_not_classified_is_counted_apart(client: TestClient, seeded, said):
    """⭐ 아직 안 잰 것과 재고 나서 모르는 것(`other`)은 **다릅니다.**

    섞으면 분석이 안 끝난 회의가 "분류가 안 되는 회의" 로 보입니다.
    불변식 3(측정 불가 ≠ 0점)이 화면에 나타나는 자리입니다.
    """
    body = counts(client, seeded["meeting_id"])
    assert body["unclassified"] == 2
    assert "other" not in body["labels"]
    assert body["total"] == 7


def test_a_meeting_with_nothing_said_says_zero_not_an_error(client: TestClient, seeded):
    body = counts(client, seeded["meeting_id"])
    assert body == {"labels": {}, "unclassified": 0, "total": 0}


# ══════════════════════════════════════════════════════════════
# ⭐ 여기서부터가 진짜 요구
# ══════════════════════════════════════════════════════════════


def test_the_counts_never_name_a_person(client: TestClient, seeded, said):
    """⭐ **사람별 건수가 나가지 않습니다.**

    나가면 화면이 그것으로 "누가 제일 많이 제안했나" 표를 만들 수 있고,
    화면 코드에는 자동 테스트가 없으므로 **막는 자리는 서버**입니다.

    ⚠️ 응답을 통째로 훑습니다. 키 이름만 보면 나중에 `by_user` 가 아닌
    다른 이름으로 들어왔을 때 못 봅니다.
    """
    body = counts(client, seeded["meeting_id"])

    assert set(body) == {"labels", "unclassified", "total"}, (
        f"응답에 새 칸이 생겼습니다: {sorted(body)}. 사람을 가리키는 것이면 "
        "리더보드로 가는 문입니다"
    )

    with db_session.session_scope() as session:
        names = {u.name for u in session.query(m.User).all()}
        ids = {str(u.id) for u in session.query(m.User).all()}

    flat = repr(body)
    for name in names:
        assert name not in flat, f"집계에 사람 이름이 들어 있습니다: {name}"
    assert set(body["labels"]) & ids == set(), "집계 키가 사용자 id 입니다"


def test_the_counts_do_not_leak_the_transcript(client: TestClient, seeded, said):
    """⭐ 숫자만 나갑니다 — 이걸로 회의록을 재구성할 수 없습니다.

    `GET /api/meetings/{id}/utterances` 가 `ids` 로만 원문을 주는 이유와
    같습니다. 집계라는 이름으로 대본이 새면 그 제한이 무의미해집니다.
    """
    flat = repr(counts(client, seeded["meeting_id"]))
    for said_text in ("로그인부터", "일정이 빠듯", "30분으로"):
        assert said_text not in flat, f"집계에 원문이 들어 있습니다: {said_text}"


def test_someone_outside_the_meeting_gets_nothing(client: TestClient, seeded, said):
    """⭐ 회의 전사는 팀 내부 자료이고, 그 요약 통계도 마찬가지입니다."""
    with db_session.session_scope() as session:
        outsider = m.User(name="남남", email="stranger-utt@example.com")
        session.add(outsider)
        session.flush()
        outsider_id = outsider.id
    login_as(client, outsider_id)

    response = client.get(f"/api/meetings/{seeded['meeting_id']}/utterance-types")
    assert response.status_code == 403


def test_an_unknown_label_cannot_be_stored(client: TestClient, seeded):
    """⭐ `utterance_type` 에 **제약이 아예 없었습니다** (같은 부류 다섯 번째).

    `String(20)` 이라 오타든 한글이든 다 들어갔고, 들어간 값은 어느 라벨에도
    안 맞아 화면에서 조용히 사라집니다.
    """
    import sqlalchemy.exc

    with (
        pytest.raises(sqlalchemy.exc.IntegrityError),
        db_session.session_scope() as session,
    ):
        session.add(
                m.Utterance(
                    meeting_id=seeded["meeting_id"],
                    start_ms=0,
                    end_ms=1,
                    text="심어 본 것",
                    speaker_source="track",
                    utterance_type="사르카즘",
                )
            )


def test_not_yet_classified_is_still_allowed(client: TestClient, seeded):
    """⚠️ `NULL` 은 막으면 안 됩니다.

    녹음만 끝나고 분석 전인 회의의 발화가 그것입니다. 제약에서 빼먹으면
    **업로드가 통째로 거절됩니다.**
    """
    with db_session.session_scope() as session:
        session.add(
            m.Utterance(
                meeting_id=seeded["meeting_id"],
                start_ms=0,
                end_ms=1,
                text="아직 분류 전",
                speaker_source="track",
                utterance_type=None,
            )
        )

    assert counts(client, seeded["meeting_id"])["unclassified"] == 1
