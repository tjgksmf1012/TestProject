"""프로젝트 분석 API (정의서 §18 · 제안서 §4.5).

⚠️ `test_project_risk.py` 는 순수 함수를 잽니다. 이 파일은 **경계**를
잽니다 — 서버가 화면에 무엇을 주는가. 순위표를 못 만들게 하는 자리는
화면이 아니라 **여기**입니다. 화면 코드에는 자동 테스트가 없으므로,
서버가 안 주는 것이 유일하게 확실합니다.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from teamflow.db import models as m
from teamflow.db import session as db_session

from .conftest import assign, login_as
from .test_api import client, engine, seeded  # noqa: F401  (픽스처)


def read(client: TestClient, project_id: int) -> dict:
    return client.get(f"/api/projects/{project_id}/analytics").json()


@pytest.fixture
def piled(seeded) -> None:
    """한 사람에게 몰린 미완료 다섯 + 남들 하나씩."""
    with db_session.session_scope() as session:
        for i in range(5):
            piled = m.Task(
                project_id=seeded["project_id"],
                title=f"몰린 일 {i}",
                status="todo",
                priority=2,
            )
            session.add(piled)
            assign(session, piled, seeded["user_ids"][0])
        theirs = m.Task(
            project_id=seeded["project_id"],
            title="남의 일",
            status="todo",
            priority=2,
        )
        session.add(theirs)
        assign(session, theirs, seeded["user_ids"][1])


def test_progress_comes_back(client: TestClient, seeded, piled):
    body = read(client, seeded["project_id"])
    assert body["progress"]["total"] >= 6
    assert "ratio" in body["progress"]


def test_a_project_with_no_tasks_sends_null_not_zero(client: TestClient, seeded):
    """⭐ **0.0 을 보내면 화면이 "시작도 안 했다" 로 그립니다.**

    측정 불가 ≠ 0점. 이 저장소가 제일 하면 안 된다고 정한 것입니다.
    """
    with db_session.session_scope() as session:
        session.query(m.Task).delete()

    assert read(client, seeded["project_id"])["progress"]["ratio"] is None


def test_the_load_list_is_by_name(client: TestClient, seeded, piled):
    """⭐ **정렬은 곧 순위입니다.** 서버가 이름 순으로 내려보냅니다.

    화면이 다시 정렬하지 않게 하려면 서버가 이미 맞는 순서로 줘야
    합니다 — `lib/contribution/view.ts` 가 같은 이유로 그렇게 합니다.
    """
    rows = read(client, seeded["project_id"])["load"]
    named = [r["name"] for r in rows if r["user_id"] is not None]
    assert named == sorted(named), f"이름 순이 아닙니다: {named}"


def test_the_load_list_is_not_by_count(client: TestClient, seeded, piled):
    """⭐ 건수 순이면 맨 위가 **"제일 많이 하는 사람"** 으로 읽힙니다."""
    counts = [r["open_tasks"] for r in read(client, seeded["project_id"])["load"]]
    assert counts != sorted(counts, reverse=True) or len(set(counts)) <= 1


def test_work_nobody_owns_is_last_and_marked(client: TestClient, seeded):
    """⭐ 담당자 없는 일을 빼고 세면 "다들 한가하다" 로 보입니다."""
    with db_session.session_scope() as session:
        session.add(
            m.Task(
                project_id=seeded["project_id"],
                title="주인 없는 일",
                status="todo",
                priority=2,
            )
        )

    rows = read(client, seeded["project_id"])["load"]
    assert rows[-1]["user_id"] is None
    assert rows[-1]["open_tasks"] >= 1


# ══════════════════════════════════════════════════════════════
# ⭐ 여기서부터가 진짜 요구
# ══════════════════════════════════════════════════════════════


def test_no_signal_carries_a_severity(client: TestClient, seeded, piled):
    """⭐ **회의를 빨갛게 칠할 재료를 안 줍니다.**

    규칙으로 센 값에 등급을 매기면 그건 팀에 대한 판정입니다
    (`AGENTS.md` 불변식 4). `meeting_events` 와 같은 규칙입니다.
    """
    body = read(client, seeded["project_id"])
    flat = repr(body)
    for word in ("severity", "level", "위험도", "심각"):
        assert word not in flat, f"등급이 화면으로 나갑니다: {word}"

    for signal in body["signals"]:
        assert set(signal) == {"kind", "detail", "task_ids"}, (
            f"신호에 새 칸이 생겼습니다: {sorted(signal)}"
        )


def test_the_server_never_suggests_moving_work_between_people(
    client: TestClient, seeded, piled
):
    """⭐ **재배정을 제안하지 않습니다** (제안서 §4.5 다섯째).

    "김민수의 업무를 이지연에게 넘기세요" 는 사람에 대한 판정이고, 그중
    에서도 제일 무거운 것입니다 — 누가 못 하고 있다는 말이 되니까요.
    사실만 내고 어떻게 할지는 팀이 정합니다.
    """
    flat = repr(read(client, seeded["project_id"]))
    for verdict in ("재배정", "제안", "권장", "넘기", "줄이", "과부하"):
        assert verdict not in flat, f"판정이 섞였습니다: {verdict}"


def test_the_skew_signal_names_only_the_one_carrying_the_most(
    client: TestClient, seeded, piled
):
    """⭐ **누가 적게 하는지는 안 나갑니다.**

    적게 맡은 사람을 지목하면 그건 곧 저성과자 표시가 되고, 이 제품이
    절대 되면 안 되는 물건이 됩니다.
    """
    signals = read(client, seeded["project_id"])["signals"]
    skew = next((s for s in signals if s["kind"] == "workload_skew"), None)
    assert skew is not None, "편중이 안 잡혔습니다 — 픽스처를 보십시오"

    with db_session.session_scope() as session:
        quiet = session.get(m.User, seeded["user_ids"][1])
        quiet_name = quiet.name

    assert quiet_name not in repr(skew), "적게 맡은 사람이 신호에 실렸습니다"


def test_the_server_sends_numbers_not_sentences(client: TestClient, seeded, piled):
    """⭐ **말은 화면이 만듭니다.**

    서버가 문장을 만들면 같은 판단이 두 벌이 되고, 한글 문구 하나를
    고치려고 서버를 배포해야 합니다.

    ⚠️ 사람 이름은 예외입니다 — 그건 문장이 아니라 값입니다.
    """
    for signal in read(client, seeded["project_id"])["signals"]:
        for key, value in signal["detail"].items():
            if key == "name":
                continue
            assert not isinstance(value, str), (
                f"{signal['kind']}.{key} 가 문장입니다: {value}"
            )


def test_nothing_is_stored(client: TestClient, seeded, piled):
    """⭐ 위험 신호를 **행으로 쌓지 않습니다.**

    쌓으면 업무를 끝냈는데 "완료율이 낮습니다" 가 남고, 담당자를 바꿨는데
    "한 사람에게 몰려 있습니다" 가 남습니다. 달력·알림과 같은 판단입니다.
    """
    with db_session.session_scope() as session:
        before = session.query(m.MeetingEvent).count()

    read(client, seeded["project_id"])
    read(client, seeded["project_id"])

    with db_session.session_scope() as session:
        assert session.query(m.MeetingEvent).count() == before
    assert "project_risks" not in set(m.Base.metadata.tables), (
        "위험 신호 표가 생겼습니다 — 읽을 때 세기로 한 결정을 다시 보십시오"
    )


def test_the_skew_signal_disappears_when_the_work_is_spread(
    client: TestClient, seeded, piled
):
    """⭐ 담당자를 나누면 **신호가 사라져야** 합니다.

    베껴 쌓아 두고 있으면 이 검사가 터집니다.

    ⚠️ **몰린 것만 나눠서는 안 됩니다.** 처음엔 다섯 건만 돌려 놓고
    "나눴다" 고 했는데, 남의 일 하나가 그대로 남아 다른 사람이 여섯 중
    셋(정확히 절반)을 들게 됐고 신호가 그대로 떴습니다. 검사가 틀렸던
    것이지 탐지가 틀린 것이 아닙니다 — 셋 중 하나가 절반을 들고 있으면
    그건 여전히 몰린 것입니다.
    """
    with db_session.session_scope() as session:
        open_tasks = (
            session.query(m.Task)
            .filter(m.Task.project_id == seeded["project_id"])
            .order_by(m.Task.id)
            .all()
        )
        for i, task in enumerate(open_tasks):
            assign(session, task, seeded["user_ids"][i % len(seeded["user_ids"])])

    kinds = {s["kind"] for s in read(client, seeded["project_id"])["signals"]}
    assert "workload_skew" not in kinds


def test_someone_outside_the_project_gets_nothing(client: TestClient, seeded, piled):
    """⭐ 누가 무엇을 얼마나 맡고 있는지는 **팀 내부 자료**입니다."""
    with db_session.session_scope() as session:
        outsider = m.User(name="남남", email="stranger-analytics@example.com")
        session.add(outsider)
        session.flush()
        outsider_id = outsider.id
    login_as(client, outsider_id)

    response = client.get(f"/api/projects/{seeded['project_id']}/analytics")
    assert response.status_code == 403


def test_an_unknown_project_is_a_404(client: TestClient, seeded):
    assert client.get("/api/projects/999999/analytics").status_code == 404
