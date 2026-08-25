"""보고서 서비스와 API.

여기서 제일 중요한 것은 **다시 만들어도 쌓이지 않는가**입니다. 이 저장소는
그 결함을 이미 한 번 당했습니다 — 미해결 사안이 재처리마다 한 벌씩 쌓였고,
두 번 돌려서야 재현됐습니다. 보고서에서 그러면 "최종 보고서" 가 여러 벌
생기고 어느 것이 진짜인지 아무도 모릅니다.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

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


# ── 「이번 주」는 서버가 정합니다 (결함 296) ────────────────────────
#
# ⚠️ **여기 있던 검사를 바꿨습니다.** 예전에는 기간 없는 `weekly` 를 400 으로
#    거절했고 이유가 이렇게 적혀 있었습니다 —
#
#        ⚠️ 조용히 기본 기간을 쓰면 **멀쩡한 주를 덮어씁니다.**
#
#    그 걱정은 **아무 기본값**을 두는 경우에 참입니다. 그런데 그 계약 때문에
#    유일한 실사용자(보고서 화면)가 「지난 7일」을 직접 만들어 보내고
#    있었고, 그 창은 누를 때마다 굴러가서 `scope_key` 가 날마다 달라졌습니다
#    — **하루에 한 벌씩 주간 보고서가 쌓였습니다**(사흘 눌러 세 벌, 그중
#    둘은 제목까지 같아 사람 눈에 구별이 안 됨). `_upsert` 가 「쌓으면 안
#    됩니다」라고 적어 둔 것이 아무것도 안 막고 있었습니다.
#
#    그래서 기본값을 **정해진 것**(팀 달력의 이번 주)으로 두고, 원래 걱정은
#    아래 둘째 검사가 **실제로 재도록** 옮겨 적었습니다.


def test_a_bare_weekly_report_means_this_team_week(client: TestClient, seeded):
    """기간을 안 주면 **팀 달력의 이번 주**입니다."""
    from teamflow import clock

    response = client.post(
        f"/api/projects/{seeded['project_id']}/reports",
        json={"report_type": "weekly"},
    )
    assert response.status_code == 201
    body = response.json()
    start, end = clock.team_week()
    assert clock.local_date(datetime.fromisoformat(body["period_start"])) == clock.local_date(
        start
    )
    assert clock.local_date(datetime.fromisoformat(body["period_end"])) == clock.local_date(end)
    # 월요일에서 시작해 일요일에 끝납니다.
    assert clock.local_date(datetime.fromisoformat(body["period_start"])).weekday() == 0
    assert clock.local_date(datetime.fromisoformat(body["period_end"])).weekday() == 6


def test_the_default_week_never_overwrites_another_week(client: TestClient, seeded):
    """⭐ 원래 걱정을 **실제로 잽니다** — 기본값이 남의 주를 덮으면 안 됩니다."""
    from teamflow import clock

    # 지지난 주를 손으로 만들어 둡니다.
    other_start, other_end = clock.team_week(datetime(2020, 6, 1, 3, 0, tzinfo=UTC))
    made = client.post(
        f"/api/projects/{seeded['project_id']}/reports",
        json={
            "report_type": "weekly",
            "period_start": other_start.isoformat(),
            "period_end": other_end.isoformat(),
        },
    )
    assert made.status_code == 201
    other_id = made.json()["id"]

    # 기간 없이 한 번 더 — 이번 주로 갑니다.
    fresh = client.post(
        f"/api/projects/{seeded['project_id']}/reports",
        json={"report_type": "weekly"},
    )
    assert fresh.status_code == 201
    assert fresh.json()["id"] != other_id

    # 옛 주는 그대로 있습니다.
    kept = client.get(f"/api/reports/{other_id}")
    assert kept.status_code == 200
    assert clock.local_date(
        datetime.fromisoformat(kept.json()["period_start"])
    ) == clock.local_date(other_start)


def test_pressing_the_weekly_button_on_different_days_does_not_stack(
    client: TestClient, seeded
):
    """⭐ 결함 296 본체 — **한 주에 주간 보고서는 한 벌**입니다.

    굴러가는 창이었을 때는 이 셋이 서로 다른 `scope_key` 를 만들어 세 벌이
    쌓였고, 그중 둘은 제목까지 같았습니다.
    """
    from teamflow import clock

    project_id = seeded["project_id"]
    monday = datetime(2026, 8, 17, 1, 0, tzinfo=UTC)
    for days in (0, 1, 3):
        start, end = clock.team_week(monday + timedelta(days=days))
        response = client.post(
            f"/api/projects/{project_id}/reports",
            json={
                "report_type": "weekly",
                "period_start": start.isoformat(),
                "period_end": end.isoformat(),
            },
        )
        assert response.status_code == 201

    listed = client.get(f"/api/projects/{project_id}/reports").json()
    weekly = [row for row in listed if row["report_type"] == "weekly"]
    assert len(weekly) == 1, [row["title"] for row in weekly]


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


def test_the_service_counts_the_utterances_it_hands_the_builder(
    client: TestClient, seeded, db: Session
):
    """⭐ 소리가 하나도 안 잡힌 회의의 회의록이 **API 를 통과한 뒤에도**
    없었다고 단언하지 않는가 (결함 369).

    ⚠️ 생성기만 보면 놓칩니다. 실제로 놓쳤습니다 — builder 는 갈래를 제대로
    가르는데 **서비스가 개수를 안 넘기면** 아무 일도 안 일어나고, 검사
    셋이 전부 초록이었습니다(대표 실패 ①). 여기서는 서비스가 **세어서
    넘기는가**를 봅니다.
    """
    silent = m.Meeting(
        project_id=seeded["project_id"],
        title="아무 말도 안 잡힌 회의",
        started_at=NOW,
        duration_sec=600,
        status=m.MeetingStatus.NEEDS_REVIEW.value,
        started_by=seeded["user_ids"][0],
    )
    db.add(silent)
    db.commit()
    db.refresh(silent)

    content = client.post(f"/api/meetings/{silent.id}/minutes").json()["content"]
    facts = next(b for b in content["blocks"] if b["kind"] == "facts")
    assert any(f["label"] == "기록된 발화" and f["value"] == "0건" for f in facts["items"]), (
        f"서비스가 발화 수를 안 넘겼습니다: {facts['items']}"
    )
    notes = [b["empty_note"] for b in content["blocks"] if b["kind"] == "list" and not b["items"]]
    assert notes and all(n == "확인할 수 없습니다." for n in notes), notes

    # 발화가 있는 회의는 그대로 「없습니다」 — 그건 진짜 없는 것입니다.
    heard = client.post(f"/api/meetings/{seeded['meeting_id']}/minutes").json()["content"]
    heard_facts = next(b for b in heard["blocks"] if b["kind"] == "facts")
    assert any(f["label"] == "기록된 발화" for f in heard_facts["items"]), heard_facts["items"]


def test_the_service_counts_failed_meetings_separately(
    client: TestClient, seeded, db: Session
):
    """⭐ 실패한 회의가 **API 를 통과한 뒤에도** 「아직 처리 전」이 아닌가
    (결함 370).

    ⚠️ builder 만 재면 놓칩니다 — 결함 369 에서 실제로 놓쳤습니다.
    builder 가 갈래를 제대로 갈라도 **서비스가 안 세면** 문서는 그대로
    입니다(대표 실패 ①).
    """
    db.add(
        m.Meeting(
            project_id=seeded["project_id"],
            title="처리에 실패한 회의",
            started_at=NOW,
            duration_sec=600,
            status=m.MeetingStatus.FAILED.value,
            started_by=seeded["user_ids"][0],
        )
    )
    db.commit()

    content = client.post(
        f"/api/projects/{seeded['project_id']}/reports",
        json={"report_type": "final"},
    ).json()["content"]

    note = _note(content, "처리된 회의")
    assert "처리에 실패" in note, f"서비스가 실패한 회의를 안 셌습니다: {note!r}"

    flat = str(content)
    assert "다시 처리해야 들어갑니다" in flat, "무엇을 해야 하는지 안 말합니다"


def test_every_line_that_ignores_the_window_says_so(
    client: TestClient, seeded, db: Session
):
    """⭐ 「이 기간에 **일어난** 일」 안에서 기간을 안 보는 줄은 이름표를 단다
    (결함 371).

    ⚠️ 손으로 고른 목록을 믿지 않습니다. **창을 비워서** 실제로 안 변하는
    값이 무엇인지 재고, 그 집합이 이름표를 단 집합과 같은지 봅니다 —
    서버가 새 값을 창 없이 세기 시작하면 그 자리에서 빨개집니다.
    """
    project_id = seeded["project_id"]
    # ⚠️ **씨앗에 안 끝난 업무가 없으면 이 검사는 아무것도 안 잽니다.**
    #    처음에 그대로 돌렸다가 「창을 비워도 안 변하는 값이 하나도 없습니다」
    #    로 스스로 걸렸습니다 — 자가 헛돌면 그것도 실패여야 합니다.
    db.add(m.Task(project_id=project_id, title="아직 안 끝난 일", status="todo"))
    db.add(
        m.Task(
            project_id=project_id,
            title="끝낸 일",
            status="done",
            completed_at=NOW,
        )
    )
    db.add(
        m.GithubEvent(
            project_id=project_id,
            repo="team/repo",
            event_type="pull_request",
            actor_login="minsu-dev",
            payload={},
            occurred_at=NOW,
        )
    )
    db.commit()

    def facts(**payload) -> dict[str, tuple[str, str]]:
        content = client.post(
            f"/api/projects/{project_id}/reports", json=payload
        ).json()["content"]
        for block in content["blocks"]:
            if block["kind"] == "facts":
                return {i["label"]: (i["value"], i.get("note", "")) for i in block["items"]}
        raise AssertionError("사실 칸이 없습니다 — 검사가 낡았습니다")

    # 이 팀의 활동이 하나도 안 들어오는 창.
    far = facts(
        report_type="weekly",
        period_start="2020-01-06T00:00:00Z",
        period_end="2020-01-12T00:00:00Z",
    )
    # 전부 들어오는 창.
    wide = facts(
        report_type="weekly",
        period_start="2020-01-01T00:00:00Z",
        period_end="2030-01-01T00:00:00Z",
    )

    # ⚠️ **모든 줄이 실제로 재어졌는가** 부터 봅니다. 양쪽 창에서 다 `0건`
    #    인 줄은 이 자가 **못 보는 줄**입니다 — 그런 줄이 하나라도 있으면
    #    검사 데이터를 늘려야 합니다(처음에 GitHub 줄이 그래서 심기 하나를
    #    놓쳤습니다).
    blind = sorted(
        label
        for label, (value, _) in wide.items()
        if value == "0건" and far[label][0] == "0건"
    )
    assert not blind, f"이 검사가 못 보는 줄이 있습니다 — 데이터를 늘리세요: {blind}"

    ignores_window = {
        label for label, (value, _) in far.items() if value == wide[label][0]
    }
    assert ignores_window, "창을 비워도 안 변하는 값이 하나도 없습니다 — 검사가 헛돕니다"

    unlabelled = sorted(label for label in ignores_window if not far[label][1])
    assert not unlabelled, (
        "기간을 안 보는 줄인데 이름표가 없습니다 — 읽는 사람은 「이번 주에 그랬다」로 읽습니다:\n"
        f"  {unlabelled}"
    )

    # 최종 보고서에는 기간이 없으므로 그 이름표를 안 답니다.
    final = facts(report_type="final")
    for label in ignores_window:
        assert not final[label][1], f"기간이 없는 문서에 기간 이름표를 답니다: {label}"
