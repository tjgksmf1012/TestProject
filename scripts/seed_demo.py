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
    업무 후보 3건 — 완전한 것 / 담당자 없는 것 / 확신도 낮은 것
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

from sqlalchemy import create_engine, select

from teamflow.auth import passwords
from teamflow.config import get_settings
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
    """승인 화면에서 서로 다르게 보여야 하는 세 가지.

    전부 완전한 후보만 넣으면 화면이 "전부 승인" 버튼 하나로 보인다.
    사람이 개입해야 하는 지점이 드러나야 이 화면의 존재 이유가 보인다.
    """
    return [
        {
            # 1) 완전한 후보 — 담당자·마감일이 다 풀렸다. 바로 승인 가능.
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
            # 3) 확신도가 낮은 후보 — 애초에 업무가 아닐 수 있다.
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

        return {
            "project_id": project.id,
            "meeting_id": meeting.id,
            "user_ids": user_ids,
            "emails": [u.email for u in users],
            "candidates": 3,
        }


def _delete_project(session, project_id: int) -> None:
    """프로젝트에 딸린 것을 참조 순서 반대로 지운다."""
    meeting_ids = list(
        session.scalars(select(m.Meeting.id).where(m.Meeting.project_id == project_id)).all()
    )
    if meeting_ids:
        for model in (
            m.MeetingTaskCandidate,
            m.Decision,
            m.Utterance,
            m.TrackChunk,
            m.MeetingTrack,
            m.RecordingConsent,
        ):
            column = (
                m.TrackChunk.track_id
                if model is m.TrackChunk
                else getattr(model, "meeting_id", None)
            )
            if column is None:
                continue
            if model is m.TrackChunk:
                track_ids = list(
                    session.scalars(
                        select(m.MeetingTrack.id).where(
                            m.MeetingTrack.meeting_id.in_(meeting_ids)
                        )
                    ).all()
                )
                if not track_ids:
                    continue
                rows = session.scalars(
                    select(model).where(m.TrackChunk.track_id.in_(track_ids))
                ).all()
            else:
                rows = session.scalars(select(model).where(column.in_(meeting_ids))).all()
            for row in rows:
                session.delete(row)
        session.flush()

    for model in (m.Task, m.Meeting, m.Member):
        for row in session.scalars(
            select(model).where(model.project_id == project_id)
        ).all():
            session.delete(row)
    session.flush()

    project = session.get(m.Project, project_id)
    if project is not None:
        session.delete(project)


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
        f"· 후보 {result['candidates']}건"
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
    print("  후보 3건이 확신도 낮은 순으로 뜹니다 —")
    print("  담당자가 안 풀린 것과 확신도 0.34 짜리가 왜 그대로 승인되지 않는지 보세요.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
