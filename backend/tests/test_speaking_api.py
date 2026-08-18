"""발언 비중이 화면까지 오는가 (정의서 §9 `AI-AUDIO-005` · §12 `AI-REVIEW-007`).

⚠️ `test_speaking.py` 는 순수 함수를 잽니다. 이 파일은 **경계**를 잽니다 —
서버가 무엇을 주고 무엇을 **안 주는가.**

⚠️ 안 주는 쪽이 훨씬 중요합니다. 정의서의 예시가 그대로 리더보드라서,
아무 생각 없이 만들면 요구를 지키면서 불변식을 어기게 됩니다.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from teamflow.db import models as m
from teamflow.db import session as db_session

from .conftest import login_as
from .test_api import client, engine, seeded  # noqa: F401  (픽스처)

MIN = 60 * 1000


def talk(meeting_id: int, user_id: int, start_s: int, end_s: int) -> None:
    with db_session.session_scope() as s:
        s.add(
            m.Utterance(
                meeting_id=meeting_id,
                speaker_id=user_id,
                start_ms=start_s * 1000,
                end_ms=end_s * 1000,
                text="말",
                speaker_source="track",
            )
        )


def read(client: TestClient, meeting_id: int) -> dict:
    response = client.get(f"/api/meetings/{meeting_id}/speaking")
    assert response.status_code == 200, response.text
    return response.json()


def test_the_shares_come_back(client: TestClient, seeded):
    body = read(client, seeded["meeting_id"])
    assert len(body["shares"]) == len(seeded["user_ids"])


def test_the_list_is_by_name(client: TestClient, seeded):
    """⭐ **몫 순으로 정렬하면 그게 곧 리더보드입니다.**

    정의서 `AI-AUDIO-005` 의 예시가 정확히 그 모양이었습니다 —
    `윤식 32% / 민수 27% / 지연 25% / 철수 16%`.
    """
    names = [row["name"] for row in read(client, seeded["meeting_id"])["shares"]]
    assert names == sorted(names), f"이름 순이 아닙니다: {names}"


def test_the_list_is_not_by_share(client: TestClient, seeded):
    """말 많이 한 사람이 위로 올라오지 않는지 직접 봅니다."""
    meeting_id = seeded["meeting_id"]
    # 이름이 뒤인 사람에게 말을 몰아 줍니다.
    with db_session.session_scope() as s:
        people = (
            s.query(m.User).filter(m.User.id.in_(seeded["user_ids"])).all()
        )
        last = max(people, key=lambda u: u.name)
        loud = last.id
    talk(meeting_id, loud, 0, 540)

    rows = read(client, meeting_id)["shares"]
    assert rows[-1]["user_id"] == loud, "말 많이 한 사람이 맨 위로 올라왔습니다"


def test_a_silent_meeting_sends_null_not_zero(client: TestClient, seeded):
    """⭐ 분모가 0이면 **비중이라는 것이 존재하지 않습니다** (결함 121)."""
    with db_session.session_scope() as s:
        s.query(m.Utterance).delete()

    for row in read(client, seeded["meeting_id"])["shares"]:
        assert row["ratio"] is None


def test_a_short_meeting_is_not_measurable(client: TestClient, seeded):
    """⭐ 3분짜리에서 나온 70% 를 보여 주면 사람은 그걸 **경향**으로 읽습니다."""
    with db_session.session_scope() as s:
        s.query(m.Utterance).delete()
    talk(seeded["meeting_id"], seeded["user_ids"][0], 0, 60)

    assert read(client, seeded["meeting_id"])["measurable"] is False


# ══════════════════════════════════════════════════════════════
# ⭐ 여기서부터가 진짜 요구
# ══════════════════════════════════════════════════════════════


def test_the_server_never_says_who_is_dominating(client: TestClient, seeded):
    """⭐ **쏠렸는지는 참/거짓 하나**입니다. 누가인지는 안 보냅니다.

    이름을 실으면 화면이 그걸 적고, 그 순간 **"이 회의를 독점한 사람"
    표시**가 됩니다. 회의에는 발제하는 사람이 있고 그 사람이 많이 말하는
    것은 정상입니다 — 사실은 목록에 다 있으니 사람이 보고 판단합니다.
    """
    meeting_id = seeded["meeting_id"]
    with db_session.session_scope() as s:
        s.query(m.Utterance).delete()
    talk(meeting_id, seeded["user_ids"][0], 0, 540)
    talk(meeting_id, seeded["user_ids"][1], 540, 600)

    body = read(client, meeting_id)
    assert body["skewed"] is True
    assert isinstance(body["skewed"], bool), "쏠린 사람을 실어 보냈습니다"

    # 응답 어디에도 "누가 독점" 을 뜻하는 칸이 없어야 합니다.
    for banned in ("dominant", "top_speaker", "most", "독점", "편중된"):
        assert banned not in repr(body), f"누가인지가 나갑니다: {banned}"


def test_the_server_does_not_rank(client: TestClient, seeded):
    """⭐ 등수·순위를 뜻하는 칸이 없는지."""
    body = read(client, seeded["meeting_id"])
    for banned in ("rank", "position", "order", "순위", "등수", "1위"):
        assert banned not in repr(body), f"순위가 나갑니다: {banned}"


def test_nothing_is_stored(client: TestClient, seeded):
    """⭐ 비중을 **행으로 쌓지 않습니다.**

    쌓으면 발화를 지워도(동의 철회) 비중이 남습니다.
    """
    read(client, seeded["meeting_id"])
    read(client, seeded["meeting_id"])

    tables = set(m.Base.metadata.tables)
    for banned in ("speaking_shares", "speaking_ratios", "meeting_shares"):
        assert banned not in tables, f"비중을 쌓는 표가 생겼습니다: {banned}"


def test_deleting_an_utterance_removes_it_from_the_share(client: TestClient, seeded):
    """⭐ 발화는 **동의의 산물**입니다.

    참가자가 지워 달라고 한 말이 비중에는 남아 있으면 안 됩니다 —
    베껴 쌓아 두고 있으면 이 검사가 터집니다.
    """
    meeting_id = seeded["meeting_id"]
    with db_session.session_scope() as s:
        s.query(m.Utterance).delete()
    talk(meeting_id, seeded["user_ids"][0], 0, 300)
    talk(meeting_id, seeded["user_ids"][1], 300, 600)

    before = {r["user_id"]: r["speaking_ms"] for r in read(client, meeting_id)["shares"]}
    assert before[seeded["user_ids"][0]] > 0

    with db_session.session_scope() as s:
        s.query(m.Utterance).filter(
            m.Utterance.speaker_id == seeded["user_ids"][0]
        ).delete()

    after = {r["user_id"]: r["speaking_ms"] for r in read(client, meeting_id)["shares"]}
    assert after[seeded["user_ids"][0]] == 0


def test_speaking_time_never_reaches_contribution():
    """⭐ **총 발언 시간은 점수가 아닙니다** (`docs/05` §5).

    기여도 코드가 이걸 읽기 시작하면 말 많이 한 사람이 점수를 받습니다.
    """
    from pathlib import Path

    root = Path(__file__).resolve().parents[2] / "backend" / "teamflow" / "contribution"
    for path in root.rglob("*.py"):
        body = path.read_text(encoding="utf-8")
        assert "speaking" not in body, f"{path.name} 이 발언 시간을 읽습니다"


def test_someone_outside_the_project_gets_nothing(client: TestClient, seeded):
    with db_session.session_scope() as s:
        outsider = m.User(name="남남", email="stranger-speaking@example.com")
        s.add(outsider)
        s.flush()
        outsider_id = outsider.id
    login_as(client, outsider_id)

    assert client.get(f"/api/meetings/{seeded['meeting_id']}/speaking").status_code == 403
