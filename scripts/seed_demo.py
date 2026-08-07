#!/usr/bin/env python3
"""시연용 데이터를 만든다.

    python3 scripts/seed_demo.py

**이 스크립트가 없으면 만든 것을 볼 방법이 없습니다.**

`frontend/public/review.html` 은 `/api/meetings/{id}/candidates` 를 부르는데,
프로젝트·회의·업무후보를 만드는 POST API 가 하나도 없습니다. 후보를 쓰는
코드는 Celery + GPU 파이프라인 안뿐이라, 지금 그 화면을 열면 404 만 뜹니다.

그래서 여기서 DB 에 직접 넣습니다. 승인 화면과 기여도 화면을 **오늘** 열어
볼 수 있게 하는 것이 목적입니다.

무엇을 만드는가:

    프로젝트 1 · 팀원 3 · 회의 1 (전원 동의, 종료됨)
    발화 5건 (화자별)
    업무 후보 4건 — 이미 승인된 것 둘 / 담당자 없는 것 / 확신도 낮은 것
    결정 1건
    병합된 PR 3건 → 기여도 이벤트

후보 세 개의 성격을 일부러 다르게 뒀습니다. 승인 화면의 값어치는 "전부
승인" 버튼이 아니라 **사람이 고쳐야 하는 것을 골라내는 데** 있고, 그게
보이려면 고칠 거리가 있어야 합니다.

⚠️ 개발용입니다. `--reset` 은 같은 이름의 프로젝트를 지웁니다.
"""

from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from sqlalchemy import create_engine, func, or_, select

from teamflow.auth import passwords
from teamflow.config import get_settings
from teamflow.contribution.events import CATEGORY_OF, EventType
from teamflow.db import models as m
from teamflow.db import session as db_session

PROJECT_TITLE = "TeamFlow 시연 프로젝트"

# 시연 계정 비밀번호. 운영에 쓸 값이 아니고, 이 파일은 시연 데이터 전용이다.
DEMO_PASSWORD = "teamflow-demo"

#: 회의 시작 시각. 마감일 해석("금요일까지")의 기준이 되므로 요일이 중요하다.
#: 2026-09-01 은 화요일 — "금요일까지" 는 09-04 로 풀린다.
MEETING_START = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)

MEMBERS = [
    ("김민수", "minsu@example.com", "minsu-dev", {"developer": 1.0}),
    ("이하늘", "haneul@example.com", "haneul-fe", {"developer": 0.7, "planner": 0.3}),
    ("박지원", "jiwon@example.com", "jiwon-db", {"developer": 0.6, "designer": 0.4}),
]

#: (발화자 인덱스, 시작ms, 끝ms, 내용)
UTTERANCES = [
    (0, 1_000, 8_000, "로그인 API는 민수가 금요일까지 만들기로 하죠"),
    (1, 9_000, 15_000, "네 저는 회원가입 화면을 맡을게요"),
    (0, 16_000, 23_000, "인증 방식은 JWT로 가는 게 좋겠습니다"),
    (2, 24_000, 31_000, "그럼 저는 DB 스키마를 다음 주 화요일까지 정리하겠습니다"),
    (1, 32_000, 38_000, "배포는 아직 정하지 말고 다음 회의에서 다시 얘기해요"),
]


def build_candidates(utterance_ids: list[int], user_ids: list[int]) -> list[dict]:
    """승인 화면에서 서로 다르게 보여야 하는 것들.

    전부 완전한 후보만 넣으면 화면이 "전부 승인" 버튼 하나로 보인다.
    사람이 개입해야 하는 지점이 드러나야 이 화면의 존재 이유가 보인다.

    ⚠️ 여기 제목은 `_TASKS` 의 다섯 번째 항목과 **글자까지 같아야** 한다.
    `_seed_tasks` 가 제목으로 잇고, 못 찾으면 그 자리에서 멈춘다 —
    예전에는 목록 순서로 이어서 'DB 스키마 정리' 가 '배포 방식 결정'
    후보를 가리키고 있었다.
    """
    return [
        {
            # 1) 완전한 후보 — 담당자·마감일이 다 풀렸다. 바로 승인 가능.
            #    **아직 업무가 없다.** 시연자가 이걸 승인하면 칸반에 카드가
            #    새로 생기는데, 그게 이 프로젝트의 대표 주장을 눈으로
            #    확인하는 순간이다.
            "title": "로그인 API 구현",
            "assignee_hint": "민수",
            "assignee_id": user_ids[0],
            "deadline": datetime(2026, 9, 4, tzinfo=UTC),
            "confidence": 0.92,
            "evidence": [utterance_ids[0], utterance_ids[2]],
            "warnings": [],
        },
        {
            # 2) 담당자가 안 풀린 후보 — "저는" 은 누구인지 알 수 없다.
            #    승인하려면 사람이 담당자를 골라야 한다 (missing_assignee).
            "title": "회원가입 화면 작업",
            "assignee_hint": "저",
            "assignee_id": None,
            "deadline": None,
            "confidence": 0.71,
            "evidence": [utterance_ids[1]],
            "warnings": ["담당자 미확정 — '저' 는 명단의 누구와도 맞지 않습니다"],
        },
        {
            # 3) **이미 승인된** 후보 — `_seed_tasks` 가 칸반 업무와 이어 준다.
            #    승인 화면에는 안 뜨고 칸반에서 "🗣 회의에서 나온 업무" 로
            #    보인다. 승인 전(1번)과 후(이것)가 둘 다 있어야 승인
            #    게이트가 무엇을 하는지 화면에서 보인다.
            "title": "DB 스키마 정리",
            "assignee_hint": "저",
            "assignee_id": user_ids[2],
            "deadline": datetime(2026, 9, 8, tzinfo=UTC),
            "confidence": 0.88,
            "evidence": [utterance_ids[3]],
            "warnings": [],
        },
        {
            # 4) 확신도가 낮은 후보 — 애초에 업무가 아닐 수 있다.
            #    화면이 이걸 맨 위로 올려 준다 (sortForReview).
            "title": "배포 방식 결정",
            "assignee_hint": None,
            "assignee_id": None,
            "deadline": None,
            "confidence": 0.34,
            "evidence": [utterance_ids[4]],
            "warnings": [
                "회의에서 담당자가 지정되지 않았습니다",
                "회의에서 마감일이 언급되지 않았습니다",
            ],
        },
    ]


def seed(*, reset: bool) -> dict:
    with db_session.session_scope() as s:
        existing = s.scalars(
            select(m.Project).where(m.Project.title == PROJECT_TITLE)
        ).first()
        if existing and not reset:
            raise SystemExit(
                f"이미 있습니다 (project_id={existing.id}). "
                "다시 만들려면 --reset 을 붙이세요."
            )
        if existing:
            _delete_project(s, existing.id)
            s.flush()

        users = []
        for name, email, _login, _roles in MEMBERS:
            user = s.scalars(select(m.User).where(m.User.email == email)).first()
            if user is None:
                user = m.User(
                    name=name,
                    email=email,
                    # 시연 계정. 비밀번호가 없으면 로그인할 수 없고,
                    # 로그인 없이는 이제 어떤 화면도 열리지 않는다.
                    password_hash=passwords.hash_password(DEMO_PASSWORD),
                )
                s.add(user)
            users.append(user)
        s.flush()

        project = m.Project(
            title=PROJECT_TITLE,
            started_at=MEETING_START - timedelta(days=14),
            github_repo="tjgksmf1012/teamflow-demo",
        )
        s.add(project)
        s.flush()

        for user, (_n, _e, login, roles) in zip(users, MEMBERS, strict=True):
            s.add(
                m.Member(
                    project_id=project.id,
                    user_id=user.id,
                    role_shares=roles,
                    github_login=login,
                )
            )

        meeting = m.Meeting(
            project_id=project.id,
            title="1주차 정기회의",
            started_at=MEETING_START,
            duration_sec=40 * 60,
            started_by=users[0].id,
            capture_mode="multitrack",
            status="needs_review",
            # 파이프라인이 만들어 저장하는 것과 같은 자리. 승인 화면이 후보를
            # 판단하는 맥락으로 읽는다 — 요약 없이 제목만 보고 누르면 이 화면의
            # 의미가 없다.
            summary=(
                "로그인 기능 분담과 인증 방식을 정했습니다.\n"
                "· 인증은 JWT 로 합니다.\n"
                "· 로그인 API 는 김민수, 회원가입 화면은 이하늘이 맡습니다.\n"
                "· DB 스키마는 박지원이 다음 주 화요일까지 정리합니다.\n"
                "· 배포 방식은 다음 회의로 미뤘습니다."
            ),
        )
        s.add(meeting)
        s.flush()

        for user in users:
            s.add(
                m.RecordingConsent(
                    meeting_id=meeting.id,
                    user_id=user.id,
                    consented=True,
                    consent_type="recording",
                )
            )

        # 트랙 셋. 박지원의 폰은 중간에 잠겨 커버리지가 낮다 —
        # "측정 불가" 표시가 화면에서 어떻게 보이는지 확인하려면 필요하다.
        coverages = [1.0, 0.98, 0.42]
        # 정렬 보정값. 기준 트랙이 0 이고 나머지는 GCC-PHAT 이 추정한 값이다.
        offsets_ms = [0, 187, -64]
        for user, coverage, offset_ms in zip(users, coverages, offsets_ms, strict=True):
            usable = coverage >= 0.8
            s.add(
                m.MeetingTrack(
                    meeting_id=meeting.id,
                    user_id=user.id,
                    started_at=MEETING_START,
                    ended_at=MEETING_START + timedelta(minutes=40),
                    device_label="iPhone 14" if usable else "Galaxy S23",
                    sample_rate=16_000,
                    offset_ms=offset_ms,
                    status="completed" if usable else "unusable",
                    coverage=coverage,
                    total_gap_ms=0 if usable else 1_392_000,
                    longest_gap_ms=0 if usable else 1_200_000,
                    gaps=[]
                    if usable
                    else [{"start_ms": 600_000, "end_ms": 1_800_000, "reason": "recorder_stalled"}],
                )
            )
        s.flush()

        utterance_ids: list[int] = []
        for speaker_index, start_ms, end_ms, text in UTTERANCES:
            row = m.Utterance(
                meeting_id=meeting.id,
                speaker_id=users[speaker_index].id,
                start_ms=start_ms,
                end_ms=end_ms,
                text=text,
                speaker_source="track",
                speaker_confidence=1.0,
                is_overlap=False,
            )
            s.add(row)
            s.flush()
            utterance_ids.append(row.id)

        user_ids = [u.id for u in users]
        for spec in build_candidates(utterance_ids, user_ids):
            s.add(
                m.MeetingTaskCandidate(
                    meeting_id=meeting.id,
                    title=spec["title"],
                    assignee_hint=spec["assignee_hint"],
                    assignee_id=spec["assignee_id"],
                    deadline=spec["deadline"],
                    confidence=spec["confidence"],
                    evidence_utterance_ids=spec["evidence"],
                    warnings=spec["warnings"],
                )
            )

        s.add(
            m.Decision(
                project_id=project.id,
                meeting_id=meeting.id,
                content="인증 방식은 JWT 로 간다",
                evidence_utterance_ids=[utterance_ids[2]],
            )
        )

        _seed_contribution_events(s, project.id, user_ids)
        _seed_tasks(s, project.id, user_ids, meeting.id)

        return {
            "project_id": project.id,
            "meeting_id": meeting.id,
            "user_ids": user_ids,
            "emails": [u.email for u in users],
            "candidates": s.scalar(
                select(func.count())
                .select_from(m.MeetingTaskCandidate)
                .where(m.MeetingTaskCandidate.meeting_id == meeting.id)
            ),
            # 승인 화면에 실제로 뜨는 것. 승인된 후보는 안 뜬다.
            "pending": s.scalar(
                select(func.count())
                .select_from(m.MeetingTaskCandidate)
                .where(
                    m.MeetingTaskCandidate.meeting_id == meeting.id,
                    m.MeetingTaskCandidate.review_status == "pending",
                )
            ),
        }


# 기여 이벤트. 기여도 화면이 보여줄 게 있어야 그 화면의 주장을 확인할 수 있다.
#
# 값을 일부러 이렇게 잡았다:
#   · 김민수  코드 위주 — PR·리뷰가 많다
#   · 이하늘  회의·업무 위주 — 코드는 적다. **역할이 다르면 분포도 다르다**
#   · 박지원  폰이 죽어 회의 기여를 **측정하지 못한다**. 코드·업무는 정상
#
# 세 번째가 이 화면의 존재 이유다. 박지원의 회의 기여를 0 으로 처리하면
# 기여도가 통째로 내려가는데, 그건 측정이 아니라 오답이다 (docs/04 §2.6).
# 시연 데이터에 그 경우가 없으면 "측정 불가는 0점이 아니다" 를 주장할
# 거리가 없다 — 승인 화면에서 확신도 0.34 짜리를 넣어 둔 것과 같은 이유다.
_EVENTS: list[tuple[int, str, str, float, int]] = [
    # (팀원 index, event_type, source_kind, magnitude, 회의 시작 후 며칠)
    (0, "pr_merged", "github_event", 180.0, 1),
    (0, "pr_merged", "github_event", 240.0, 3),
    (0, "review_given", "github_event", 1.0, 2),
    (0, "review_given", "github_event", 1.0, 4),
    (0, "task_completed", "task", 1.0, 3),
    (0, "utt_proposal", "utterance", 1.0, 0),
    (0, "utt_decision", "utterance", 1.0, 0),
    (1, "pr_merged", "github_event", 90.0, 2),
    (1, "review_given", "github_event", 1.0, 3),
    (1, "task_completed", "task", 1.0, 2),
    (1, "task_completed", "task", 1.0, 5),
    (1, "utt_question", "utterance", 1.0, 0),
    (1, "utt_answer", "utterance", 1.0, 0),
    (1, "utt_commitment", "utterance", 1.0, 0),
    (2, "pr_merged", "github_event", 120.0, 4),
    (2, "review_given", "github_event", 1.0, 5),
    (2, "task_completed", "task", 1.0, 4),
    # 박지원의 회의 발언은 없다 — 폰이 죽어서 **기록되지 않았다.**
    # 트랙 커버리지 0.42 가 그 사실을 남기고, 기여도 엔진이 그걸 읽어
    # 회의 카테고리를 "측정 불가" 로 뺀다.
]


# ⚠️ 시연용 합성 이벤트의 `source_id` 를 두는 자리.
#
# 예전에는 `index * 1000 + seq` 였고, 첫 항목이 `0*1000 + 4 = 4` 로 계산돼
# **실제 `tasks.id = 4` 와 정면 충돌**했습니다. `task_service._emit` 은
# `(source_kind, source_id, event_type)` 로 선점 여부를 보고 이미 있으면
# **아무것도 안 하고 False 를 돌려줍니다** — 로그도 예외도 없습니다.
# 그래서 시연에서 그 카드를 완료해도 기여 이벤트가 조용히 안 생겼습니다.
# 게다가 선점한 이벤트의 주인은 그 업무의 담당자가 아니었습니다.
#
# 실제 행 id 가 절대 닿지 않는 자리로 옮깁니다. 아래에서 충돌이 없는지
# 실제로 확인하므로, 시드가 커져도 조용히 다시 겹치지는 않습니다.
_SEED_SOURCE_BASE = 900_000


def _seed_contribution_events(session, project_id: int, user_ids: list[int]) -> None:
    for seq, (index, event_type, source_kind, magnitude, day) in enumerate(_EVENTS):
        session.add(
            m.ContributionEventRow(
                project_id=project_id,
                user_id=user_ids[index],
                occurred_at=MEETING_START + timedelta(days=day),
                category=CATEGORY_OF[EventType(event_type)].value,
                event_type=event_type,
                source_kind=source_kind,
                # `(source_kind, source_id, event_type)` 이 유니크다 — 웹훅이
                # 같은 이벤트를 두 번 보내도 한 번만 세도록 만든 중복 제거 키다.
                # 전부 0 으로 두면 두 번째 이벤트부터 IntegrityError 가 난다.
                source_id=_SEED_SOURCE_BASE + seq,
                magnitude=magnitude,
                # 실제 PR·업무 행을 가리키지 않는 합성 이벤트라고 남긴다.
                # 남기지 않으면 "화면의 숫자는 원본 이벤트로 역추적된다"
                # (docs/07 E5) 를 확인하러 온 사람이 사라진 행을 찾는다.
                event_metadata={"seeded": True},
            )
        )
    session.flush()

    # 합성 이벤트가 실제 업무를 선점하지 않았는지 확인한다. 선점하면
    # 그 업무를 완료해도 기여 이벤트가 **조용히** 안 생긴다.
    taken = session.scalars(
        select(m.Task.id).where(
            m.Task.id.in_(
                select(m.ContributionEventRow.source_id).where(
                    m.ContributionEventRow.project_id == project_id,
                    m.ContributionEventRow.source_kind == "task",
                )
            )
        )
    ).all()
    if taken:
        raise SystemExit(
            f"시연 이벤트의 source_id 가 실제 업무 {sorted(taken)} 를 선점했습니다. "
            "_SEED_SOURCE_BASE 를 올려야 합니다."
        )


# 칸반에 이미 올라가 있는 업무.
#
# 상태가 서로 달라야 화면이 의미가 있고, **회의에서 나온 것과 손으로 만든
# 것이 섞여 있어야** 이 프로젝트의 주장이 화면에서 구분됩니다.
#
# ⚠️ 회의에서 나온 업무는 **승인을 거친 것만** 여기 있어야 합니다.
#
# 예전에는 후보 셋이 전부 `pending` 인데 그 후보를 가리키는 업무가 이미
# 칸반에 있었습니다. `approval.py` 의 불변식 1번이 "승인자 없이는 업무가
# 만들어지지 않는다" 인데, 시연 시작 상태가 그걸 어기고 있었습니다.
# 게다가 README 가 시연자에게 시키는 그 동작(승인 화면에서 승인)을 하면
# `created_task_id` 가 비어 있으니 **같은 업무 카드가 하나 더** 생겼습니다.
#
# 그리고 후보를 목록 순서(`candidates[index]`)로 집었는데 두 목록의 세
# 번째가 서로 달라서, 'DB 스키마 정리' 가 '배포 방식 결정' 후보를 가리키고
# 근거 발화로 "배포는 아직 정하지 말고…" 를 보여주고 있었습니다. 이제
# **제목으로** 잇습니다.
#
#   (제목, 담당자 index(-1 이면 없음), 상태, 마감일 오프셋(일), 나온 후보 제목)
_TASKS: list[tuple[str, int, str, int | None, str | None]] = [
    # 승인을 거쳐 칸반에 올라온 업무. 이게 이 프로젝트의 대표 주장이
    # 화면에서 보이는 자리다 — 카드에서 회의 발화까지 거슬러 올라간다.
    ("DB 스키마 정리", 2, "done", 2, "DB 스키마 정리"),
    # 손으로 만든 업무. 회의에서 나오지 않은 것도 칸반에는 있습니다.
    ("개발 환경 문서 정리", 1, "in_progress", None, None),
    # 담당자가 없는 업무 — 완료해도 기여도에 잡히지 않는다는 걸 화면이
    # 말해 줘야 하는 경우입니다.
    ("배포 방식 조사", -1, "todo", 10, None),
]

# ⭐ '로그인 API 구현' 은 일부러 여기 없습니다. 승인 화면에 완전한 후보로
# 떠 있고, 시연자가 그걸 승인하면 칸반에 카드가 **새로 생깁니다.** 미리
# 넣어 두면 승인해도 아무 변화가 없거나(멱등이 아니면) 카드가 둘이 됩니다.


def _seed_tasks(session, project_id: int, user_ids: list[int], meeting_id: int) -> None:
    """칸반 업무를 만들고, 회의에서 나온 것은 후보와 **양방향으로** 잇는다.

    한쪽만 이으면 승인 화면과 칸반이 서로 다른 말을 합니다 — 승인 화면은
    "아직 승인 안 됨" 이라고 하는데 칸반에는 그 업무가 이미 있습니다.
    그 상태에서 승인하면 카드가 하나 더 생깁니다.
    """
    candidates = {
        candidate.title: candidate
        for candidate in session.scalars(
            select(m.MeetingTaskCandidate).where(
                m.MeetingTaskCandidate.meeting_id == meeting_id
            )
        ).all()
    }
    reviewer = user_ids[0]

    for title, owner, status, due_days, origin_title in _TASKS:
        origin = candidates.get(origin_title) if origin_title else None
        if origin_title and origin is None:
            raise SystemExit(
                f"업무 '{title}' 이 가리키는 후보 '{origin_title}' 이 없습니다. "
                "build_candidates() 와 _TASKS 의 제목이 어긋났습니다."
            )

        deadline = (
            MEETING_START + timedelta(days=due_days) if due_days is not None else None
        )
        completed_at = MEETING_START + timedelta(days=1) if status == "done" else None
        task = m.Task(
            project_id=project_id,
            title=title,
            assignee_id=user_ids[owner] if owner >= 0 else None,
            deadline=deadline,
            status=status,
            completed_at=completed_at,
            # 회의에서 나온 업무는 후보를 가리킨다. 그 연결이 화면에서
            # "🗣 회의에서 나온 업무" 로 보인다.
            origin_candidate_id=origin.id if origin else None,
        )
        session.add(task)

        if origin is not None:
            session.flush()
            # ⭐ 반대 방향도 잇는다. 이게 없으면 승인 화면이 이 후보를
            # "아직 승인 안 됨" 으로 보여주고, 승인하면 업무가 하나 더 생긴다.
            origin.review_status = "approved"
            origin.reviewed_by = reviewer
            origin.created_task_id = task.id
    session.flush()


def _delete_project(session, project_id: int) -> None:
    """프로젝트에 딸린 것을 **전부** 지운다.

    ⚠️ 예전에는 지울 표를 손으로 나열했고, 그래서 목록에 없는 표가 생길
    때마다 `--reset` 이 외래키 위반으로 터졌습니다. 그것도 **시연을 한 번
    제대로 해 본 뒤에만** 터집니다 — 승인 화면에서 승인하면 `audit_logs`
    가 생기고, 칸반에서 되돌리면 또 생기고, GitHub 웹훅이 오면
    `github_events` 가 생기기 때문입니다. 즉 처음 한 번은 잘 되고,
    시연을 마친 뒤 다시 하려는 순간 안 됩니다.

    표를 손으로 나열하는 방식 자체를 버렸습니다. 스키마에서 **프로젝트에
    닿는 모든 표를 찾아** 자식부터 지웁니다. 표가 새로 생겨도 저절로
    포함되고, 혹시 못 찾은 게 있으면 아래 확인에서 이름과 함께 걸립니다.
    """
    # 이 프로젝트에 딸린 id 들. 아래 표들이 이 중 하나를 가리킨다.
    scope: dict[str, set[int]] = {"projects": {project_id}}

    def ids_of(model, column, parent_table: str) -> set[int]:
        parents = scope.get(parent_table, set())
        if not parents:
            return set()
        return set(
            session.scalars(select(model.id).where(column.in_(parents))).all()
        )

    scope["meetings"] = ids_of(m.Meeting, m.Meeting.project_id, "projects")
    scope["tasks"] = ids_of(m.Task, m.Task.project_id, "projects")
    scope["github_events"] = ids_of(
        m.GithubEvent, m.GithubEvent.project_id, "projects"
    )
    scope["score_runs"] = ids_of(m.ScoreRun, m.ScoreRun.project_id, "projects")
    scope["scoring_profiles"] = ids_of(
        m.ScoringProfileRow, m.ScoringProfileRow.project_id, "projects"
    )
    scope["meeting_tracks"] = ids_of(
        m.MeetingTrack, m.MeetingTrack.meeting_id, "meetings"
    )
    scope["audio_assets"] = ids_of(
        m.AudioAsset, m.AudioAsset.meeting_id, "meetings"
    )
    scope["decisions"] = ids_of(m.Decision, m.Decision.project_id, "projects")

    # `sorted_tables` 는 부모가 앞이다. 뒤집으면 자식부터가 된다.
    for table in reversed(m.Base.metadata.sorted_tables):
        conditions = []
        for column in table.columns:
            for foreign_key in column.foreign_keys:
                targets = scope.get(foreign_key.column.table.name)
                if targets:
                    conditions.append(column.in_(targets))
        if conditions:
            session.execute(table.delete().where(or_(*conditions)))
    session.flush()

    project = session.get(m.Project, project_id)
    if project is not None:
        session.delete(project)
    session.flush()

    _assert_nothing_is_left_pointing_at(session, project_id)


def _assert_nothing_is_left_pointing_at(session, project_id: int) -> None:
    """정말로 다 지워졌는가.

    외래키 위반은 `DELETE FROM projects WHERE id = ?` 에서 터지므로,
    **어느 표가 원인인지 말해 주지 않습니다.** 여기서 미리 이름을 찾아
    둡니다 — 표가 새로 생겼는데 지우지 못한 경우가 그렇습니다.
    """
    leftovers = []
    for table in m.Base.metadata.sorted_tables:
        column = table.columns.get("project_id")
        if column is None:
            continue
        remaining = session.scalar(
            select(func.count()).select_from(table).where(column == project_id)
        )
        if remaining:
            leftovers.append(f"{table.name}({remaining}행)")

    if leftovers:
        raise SystemExit(
            "프로젝트를 지웠는데 아직 이 표들이 프로젝트를 가리킵니다: "
            + ", ".join(leftovers)
            + "\n_delete_project 의 scope 에 이 표의 부모를 추가해야 합니다."
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="시연용 데이터를 만든다")
    parser.add_argument(
        "--reset", action="store_true", help="같은 이름의 프로젝트를 지우고 다시 만든다"
    )
    parser.add_argument("--database-url", help="설정 대신 이 URL 을 쓴다")
    args = parser.parse_args()

    url = args.database_url or get_settings().database_url
    db_session.configure(create_engine(url))

    result = seed(reset=args.reset)

    print("시연 데이터를 만들었습니다.\n")
    print(
        f"  프로젝트 {result['project_id']} · 회의 {result['meeting_id']} "
        f"· 후보 {result['candidates']}건 (승인 대기 {result['pending']}건)"
    )
    print(f"  팀원 user_id: {result['user_ids']}\n")
    print("로그인 계정 (비밀번호는 셋 다 같습니다):\n")
    for email in result["emails"]:
        print(f"  {email} / {DEMO_PASSWORD}")
    print()
    print("이제 이렇게 엽니다:\n")
    print("  ASR_BACKEND=fake .venv/bin/uvicorn teamflow.api.main:app --app-dir backend --reload")
    print(f"  http://localhost:8000/lobby.html?meeting={result['meeting_id']}\n")
    print("  주소에 누구인지 적지 않습니다 — 로그인 화면으로 넘어가고,")
    print("  그 뒤로는 서버가 세션에서 신원을 읽습니다.\n")
    print(f"  http://localhost:8000/review.html?meeting={result['meeting_id']}\n")
    print(f"  승인 대기 {result['pending']}건이 확신도 낮은 순으로 뜹니다 —")
    print("  담당자가 안 풀린 것과 확신도 0.34 짜리가 왜 그대로 승인되지 않는지 보세요.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
