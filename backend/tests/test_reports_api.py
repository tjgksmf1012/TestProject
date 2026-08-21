"""보고서 서비스와 API.

여기서 제일 중요한 것은 **다시 만들어도 쌓이지 않는가**입니다. 이 저장소는
그 결함을 이미 한 번 당했습니다 — 미해결 사안이 재처리마다 한 벌씩 쌓였고,
두 번 돌려서야 재현됐습니다. 보고서에서 그러면 "최종 보고서" 가 여러 벌
생기고 어느 것이 진짜인지 아무도 모릅니다.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from teamflow.config import Settings, get_settings
from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.db.vocab import ReportType

from .conftest import login_as, logout

NOW = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    m.Base.metadata.create_all(eng)
    db_session.configure(eng)
    yield eng
    m.Base.metadata.drop_all(eng)
    eng.dispose()


@pytest.fixture
def db(engine) -> Iterator[Session]:
    with db_session.session_scope() as session:
        yield session


@pytest.fixture
def client(engine) -> Iterator[TestClient]:
    from teamflow.api.main import app

    app.dependency_overrides[get_settings] = lambda: Settings(
        environment="test", database_url="sqlite://"
    )
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def seeded(engine, client: TestClient) -> dict:
    """프로젝트 하나 + 팀원 둘 + 회의 하나(후보·사안·트랙 포함)."""
    with db_session.session_scope() as s:
        users = [
            m.User(name="홍길동", email="gildong@example.com"),
            m.User(name="김하늘", email="haneul@example.com"),
        ]
        s.add_all(users)
        s.flush()

        project = m.Project(
            title="TeamFlow 졸업작품",
            started_at=datetime(2026, 8, 1, tzinfo=UTC),
        )
        s.add(project)
        s.flush()
        for user in users:
            s.add(
                m.Member(
                    project_id=project.id,
                    user_id=user.id,
                    role_shares={"developer": 1.0},
                )
            )

        meeting = m.Meeting(
            project_id=project.id,
            title="9월 1일 정기회의",
            started_at=NOW,
            duration_sec=1800,
            # ⚠️ 예전에는 `status="done"` 이었습니다 (결함 288). `"done"` 은
            #    **업무** 상태이지 회의 상태가 아닙니다. 실기가 절대 만들지
            #    않는 값을 검사 데이터가 만들고 있었고, 그래서 보고서의
            #    「처리된 회의」가 언제나 0 인데도 검사는 초록이었습니다 —
            #    **통과는 넣은 값에 대해서만 참입니다.**
            status=m.MeetingStatus.NEEDS_REVIEW.value,
            started_by=users[0].id,
            summary="배포 일정을 다음 회의로 미뤘습니다",
            next_agenda=["배포 일정 재논의"],
        )
        s.add(meeting)
        s.flush()

        s.add(
            m.MeetingEvent(
                meeting_id=meeting.id,
                event_type="unanswered_question",
                severity="info",
                start_ms=1000,
                end_ms=2000,
                evidence_utterance_ids=[11, 12],
                detail={"content": "배포를 언제 할지"},
            )
        )
        s.add(
            m.MeetingTaskCandidate(
                meeting_id=meeting.id,
                title="스키마 확정",
                confidence=0.9,
                evidence_utterance_ids=[11],
                review_status="approved",
            )
        )
        # ⚠️ 끊긴 트랙 하나 — "못 잰 것" 이 실제로 적히는지 보려고.
        s.add_all(
            [
                m.MeetingTrack(
                    meeting_id=meeting.id,
                    user_id=users[0].id,
                    started_at=NOW,
                    status="completed",
                ),
                m.MeetingTrack(
                    meeting_id=meeting.id,
                    user_id=users[1].id,
                    started_at=NOW,
                    status="unusable",
                ),
            ]
        )

        result = {
            "project_id": project.id,
            "meeting_id": meeting.id,
            "user_ids": [u.id for u in users],
        }

    login_as(client, result["user_ids"][0])
    return result


def _count_reports(project_id: int) -> int:
    with db_session.session_scope() as s:
        return int(
            s.scalar(
                select(func.count(m.Report.id)).where(
                    m.Report.project_id == project_id
                )
            )
            or 0
        )


# ══════════════════════════════════════════════════════════════
# 1. ⭐ 다시 만들어도 쌓이지 않는다
# ══════════════════════════════════════════════════════════════


def test_regenerating_minutes_replaces_instead_of_stacking(
    client: TestClient, seeded
):
    """⚠️ 두 번 돌려서 재현합니다 — 미해결 사안 때 그렇게 잡혔습니다."""
    meeting_id, project_id = seeded["meeting_id"], seeded["project_id"]

    first = client.post(f"/api/meetings/{meeting_id}/minutes")
    assert first.status_code == 201, first.text
    assert _count_reports(project_id) == 1

    second = client.post(f"/api/meetings/{meeting_id}/minutes")
    assert second.status_code == 201
    assert _count_reports(project_id) == 1, "회의록이 쌓였습니다"
    assert second.json()["id"] == first.json()["id"], "새 행이 생겼습니다"


def test_regenerating_the_final_report_replaces_it(client: TestClient, seeded):
    """최종 보고서가 두 벌이면 그건 최종이 아닙니다."""
    project_id = seeded["project_id"]
    body = {"report_type": "final"}

    first = client.post(f"/api/projects/{project_id}/reports", json=body)
    assert first.status_code == 201, first.text
    second = client.post(f"/api/projects/{project_id}/reports", json=body)
    assert second.status_code == 201

    assert _count_reports(project_id) == 1
    assert first.json()["id"] == second.json()["id"]


def test_different_weeks_do_not_overwrite_each_other(client: TestClient, seeded):
    """⚠️ 반대쪽 실패 — 열쇠가 뭉개지면 **멀쩡한 것을 덮어씁니다.**"""
    project_id = seeded["project_id"]
    first = client.post(
        f"/api/projects/{project_id}/reports",
        json={
            "report_type": "weekly",
            "period_start": "2026-08-03T00:00:00Z",
            "period_end": "2026-08-09T00:00:00Z",
        },
    )
    second = client.post(
        f"/api/projects/{project_id}/reports",
        json={
            "report_type": "weekly",
            "period_start": "2026-08-10T00:00:00Z",
            "period_end": "2026-08-16T00:00:00Z",
        },
    )
    assert first.status_code == second.status_code == 201
    assert first.json()["id"] != second.json()["id"]
    assert _count_reports(project_id) == 2


def test_the_database_itself_refuses_a_duplicate(db: Session, seeded):
    """서비스를 건너뛰어도 막히는가.

    다른 경로가 하나 생기는 순간(배치·재처리·수동 스크립트) 서비스의 약속은
    깨집니다. 그때 **오류가 나야** 합니다 — 조용히 쌓이면 아무도 모릅니다.
    """
    from sqlalchemy.exc import IntegrityError

    for _ in range(2):
        db.add(
            m.Report(
                project_id=seeded["project_id"],
                report_type=str(ReportType.FINAL),
                scope_key="project",
                content={},
            )
        )
    with pytest.raises(IntegrityError):
        db.flush()
    # 터진 트랜잭션을 그대로 두면 픽스처 뒷정리가 같이 죽습니다 — 테스트가
    # 실패한 것처럼 보이지만 실제로는 여기서 안 치운 것입니다.
    db.rollback()


# ══════════════════════════════════════════════════════════════
# 2. 내용이 실제로 들어간다
# ══════════════════════════════════════════════════════════════


def test_minutes_carry_what_happened_in_the_meeting(client: TestClient, seeded):
    content = client.post(f"/api/meetings/{seeded['meeting_id']}/minutes").json()[
        "content"
    ]
    flat = str(content)
    assert "배포 일정을 다음 회의로 미뤘습니다" in flat
    assert "배포 일정 재논의" in flat
    assert "배포를 언제 할지 (근거 2건)" in flat
    assert "스키마 확정 — 등록함" in flat
    # 끊긴 트랙이 "못 잰 것" 으로 적혔는가
    assert "잴 수 없었습니다" in flat


def test_a_period_report_lists_people_in_name_order(client: TestClient, seeded):
    """⚠️ API 를 통과한 뒤에도 이름 순인가 — 생성기만 보면 놓칩니다."""
    content = client.post(
        f"/api/projects/{seeded['project_id']}/reports",
        json={"report_type": "final"},
    ).json()["content"]
    people = next(b for b in content["blocks"] if b["kind"] == "people")["people"]
    names = [p["name"] for p in people]
    assert names == sorted(names) == ["김하늘", "홍길동"]


def test_a_period_report_says_it_is_not_confirmed_yet(client: TestClient, seeded):
    content = client.post(
        f"/api/projects/{seeded['project_id']}/reports",
        json={"report_type": "final"},
    ).json()["content"]
    assert "확정하지 않았습니다" in str(content)


# ══════════════════════════════════════════════════════════════
# 3. 어휘 밖은 400 이지 500 이 아니다
# ══════════════════════════════════════════════════════════════


def test_an_unknown_report_type_is_a_bad_request_not_a_crash(
    client: TestClient, seeded
):
    """⚠️ 느슨하게 받으면 CHECK 제약이 500 으로 튀어나옵니다.

    사용자에게는 "서버가 고장 났다" 로 보이는데 실제로는 잘못된 요청입니다.
    """
    response = client.post(
        f"/api/projects/{seeded['project_id']}/reports",
        json={"report_type": "주간"},
    )
    assert response.status_code == 400
    assert "모르는 보고서 종류" in response.json()["detail"]


def test_minutes_cannot_be_requested_from_the_project_route(
    client: TestClient, seeded
):
    """회의록은 회의에 매입니다 — 프로젝트 주소로 만들면 열쇠가 없습니다."""
    response = client.post(
        f"/api/projects/{seeded['project_id']}/reports",
        json={"report_type": "meeting_minutes"},
    )
    assert response.status_code == 400
    assert "회의록은 회의에서" in response.json()["detail"]


def test_a_weekly_report_without_a_period_is_refused(client: TestClient, seeded):
    """⚠️ 조용히 기본 기간을 쓰면 **멀쩡한 주를 덮어씁니다.**"""
    response = client.post(
        f"/api/projects/{seeded['project_id']}/reports",
        json={"report_type": "weekly"},
    )
    assert response.status_code == 400
    assert "period_start" in response.json()["detail"]


# ══════════════════════════════════════════════════════════════
# 4. 팀 자료입니다 — 아무나 못 봅니다
# ══════════════════════════════════════════════════════════════


def test_a_stranger_cannot_read_the_reports(client: TestClient, seeded, db: Session):
    """보고서에는 사람별 기여가 들어갑니다. 남이 보면 안 됩니다."""
    client.post(
        f"/api/projects/{seeded['project_id']}/reports",
        json={"report_type": "final"},
    )
    stranger = m.User(name="남남", email="stranger@example.com")
    db.add(stranger)
    db.flush()
    stranger_id = stranger.id
    db.commit()

    logout(client)
    login_as(client, stranger_id)
    assert client.get(f"/api/projects/{seeded['project_id']}/reports").status_code == 403


def test_reading_requires_a_session(client: TestClient, seeded):
    logout(client)
    assert client.get(f"/api/projects/{seeded['project_id']}/reports").status_code == 401


# ══════════════════════════════════════════════════════════════
# 5. 목록과 단건
# ══════════════════════════════════════════════════════════════


def test_the_list_does_not_ship_the_whole_body(client: TestClient, seeded):
    """목록에 내용까지 실으면 화면이 안 쓸 것을 다 받습니다."""
    client.post(f"/api/meetings/{seeded['meeting_id']}/minutes")
    rows = client.get(f"/api/projects/{seeded['project_id']}/reports").json()
    assert len(rows) == 1
    assert "content" not in rows[0]
    assert rows[0]["title"].startswith("회의록 —")
    assert rows[0]["meeting_id"] == seeded["meeting_id"]


def test_a_single_report_can_be_read_back(client: TestClient, seeded):
    created = client.post(f"/api/meetings/{seeded['meeting_id']}/minutes").json()
    fetched = client.get(f"/api/reports/{created['id']}").json()
    assert fetched["content"] == created["content"]


# ══════════════════════════════════════════════════════════════
# 「처리된 회의」가 사실이어야 한다 (결함 288)
# ══════════════════════════════════════════════════════════════


def _facts(content: dict) -> dict[str, str]:
    for block in content["blocks"]:
        if block["kind"] == "facts":
            return {i["label"]: i["value"] for i in block["items"]}
    raise AssertionError("보고서에 사실 칸이 없습니다 — 검사가 낡았습니다")


def _note(content: dict, label: str) -> str:
    for block in content["blocks"]:
        if block["kind"] == "facts":
            for i in block["items"]:
                if i["label"] == label:
                    return i.get("note", "")
    return ""


def test_processed_meetings_are_actually_counted(client: TestClient, seeded):
    """⭐ 「처리된 회의」가 **언제나 0** 이었습니다.

    `x.status == "done"` 으로 세고 있었는데 `"done"` 은 **업무** 상태라
    어느 회의도 해당하지 않습니다. 씨앗에는 전사가 끝난 회의가 둘 있습니다
    (`needs_review` 하나 · `confirmed` 하나).

    그리고 그 0 은 조용하지 않았습니다 — 옆의 설명이 「N건은 아직 처리
    전이라 그 회의의 발언은 기여도에 안 들어갔습니다」로 나갔고, 같은 제품의
    기여도 화면은 그 사람의 회의 근거를 세고 있었습니다. **팀이 제출하는
    문서가 제품 자신의 데이터와 반대되는 말을 한 것**입니다.
    """
    project_id = seeded["project_id"]
    made = client.post(
        f"/api/projects/{project_id}/reports", json={"report_type": "final"}
    )
    assert made.status_code == 201, made.text
    facts = _facts(made.json()["content"])

    assert facts["처리된 회의"] != "0건", (
        "전사가 끝난 회의가 있는데 「처리된 회의 0건」입니다 — "
        f"회의 {facts['회의']}"
    )
    # 이 파일의 씨앗은 회의 **하나**(`needs_review`)입니다. 전부 처리됐으니
    # 「회의」와 「처리된 회의」가 같아야 합니다.
    assert facts["처리된 회의"] == "1건"
    assert facts["회의"] == facts["처리된 회의"]


def test_a_meeting_that_has_not_happened_is_not_counted_as_having_happened(
    client: TestClient, seeded
):
    """⭐ 머리말이 「이 기간에 **일어난** 일」입니다.

    잡아만 두고 아직 안 연 회의는 일어나지 않았습니다 (결함 287). 최종
    보고서는 기간을 안 받으므로 아무것도 안 걸러 주고, 예정 회의가 그대로
    「회의 N건」에 섞여 들어갔습니다.
    """
    project_id = seeded["project_id"]
    before = _facts(
        client.post(
            f"/api/projects/{project_id}/reports", json={"report_type": "final"}
        ).json()["content"]
    )["회의"]

    made = client.post(
        f"/api/projects/{project_id}/scheduled-meetings",
        json={"title": "앞으로 할 회의", "at": "2027-01-05T02:00:00Z"},
    )
    assert made.status_code == 201, made.text

    after = _facts(
        client.post(
            f"/api/projects/{project_id}/reports", json={"report_type": "final"}
        ).json()["content"]
    )["회의"]
    assert after == before, (
        f"일정을 잡았더니 「일어난 일」의 회의가 {before} → {after} 로 늘었습니다"
    )


def test_the_note_only_appears_when_something_really_is_unprocessed(
    client: TestClient, seeded
):
    """⚠️ 설명이 **숫자와 같은 것**을 말해야 한다.

    처리 안 된 회의가 0 이면 그 문장은 아예 안 나옵니다.
    """
    project_id = seeded["project_id"]
    content = client.post(
        f"/api/projects/{project_id}/reports", json={"report_type": "final"}
    ).json()["content"]
    facts = _facts(content)
    note = _note(content, "처리된 회의")

    total = int(facts["회의"].removesuffix("건"))
    processed = int(facts["처리된 회의"].removesuffix("건"))
    if total == processed:
        assert note == "", "다 처리했는데 「아직 처리 전」이라고 합니다"
    else:
        assert f"{total - processed}건" in note, (
            f"설명의 숫자가 사실과 다릅니다 — {total}−{processed} 인데 「{note}」"
        )
