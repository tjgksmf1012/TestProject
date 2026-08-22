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

    프로젝트 1 · 팀원 3 · 회의 5
      └ 알맹이가 있는 것은 **1주차 정기회의 하나**입니다 (전원 동의, 종료됨).
        나머지 넷은 껍데기뿐 — 채널 목록이 한 줄이면 "회의는 방이다" 가
        화면에서 안 보이고, 상태 점도 한 종류밖에 못 봅니다.
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
from teamflow.db import assignees, vocab
from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.projects import invites
from teamflow.services import meeting_contribution_service

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
    # ⚠️ **아래 셋은 뒤에만 붙이십시오.** `build_candidates` 가 위 다섯을
    #    `utterance_ids[0..4]` 로 가리킵니다 — 가운데 끼우면 근거가 통째로
    #    엉뚱한 발언을 가리키게 되고, 화면에서는 멀쩡해 보입니다.
    #
    # 정의서 §10 의 찬반·보완을 화면에서 볼 수 있게 하는 줄들입니다.
    # 이게 없으면 검토 화면의 "무슨 말이 오갔나" 가 늘 비어 있고,
    # 갈라 놓은 라벨을 **아무도 눈으로 확인할 수 없습니다.**
    (2, 39_000, 46_000, "금요일까지는 좀 어려울 것 같습니다. 테스트까지 하면 빠듯해요"),
    (0, 47_000, 54_000, "동의합니다. 다만 화면 쪽은 그대로 가도 될 것 같습니다"),
    (1, 55_000, 60_000, "저도 같은 생각입니다. 그 순서가 맞다고 봅니다"),
    # ── 아래는 §12 비효율 탐지를 **화면에서 볼 수 있게** 하는 줄들입니다 ──
    #
    # 없으면 시연 회의가 1분짜리라 덩어리가 하나뿐이고, 반복 논의도 주제
    # 이탈도 원리상 나올 수 없습니다 — 탐지기를 만들어 놓고 **아무도 눈으로
    # 확인할 수 없게** 됩니다.
    #
    # ⚠️ 트랙은 40분짜리인데 발화가 1분 안에만 있던 것도 이상했습니다.
    #
    # 12분쯤 — 본줄기에서 샌 구간 (주제 이탈)
    (1, 12 * 60_000, 12 * 60_000 + 8_000, "잠깐, 점심 뭐 먹을지 정해야 하는데요"),
    (2, 12 * 60_000 + 30_000, 12 * 60_000 + 38_000, "김치찌개 아니면 파스타 어때요"),
    (0, 13 * 60_000, 13 * 60_000 + 9_000, "파스타 말고 김치찌개로 하죠 점심은"),
    # 25분쯤 — 앞에서 이미 정한 인증 얘기가 다시 (반복 논의)
    (0, 25 * 60_000, 25 * 60_000 + 9_000, "인증 방식을 다시 볼까요 JWT 로그인 말인데요"),
    (2, 25 * 60_000 + 40_000, 25 * 60_000 + 50_000, "JWT 로그인 인증은 아까 정하지 않았나요"),
    (1, 26 * 60_000, 26 * 60_000 + 8_000, "로그인 인증 JWT 로 이미 갔습니다"),
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
            # ⚠️ **API 가 만드는 프로젝트와 같은 모양이어야 한다** (결함 91).
            #
            # 이게 없던 동안 시연 프로젝트만 `invite_code` 가 NULL 이었다.
            # 화면은 정직하게 `(없음)` 을 띄우고 복사 버튼을 잠갔지만
            # (결함 71), 그 결과 **시연에서 팀원을 초대할 방법이 없었다** —
            # 이 제품의 첫 화면이 "시작하는 두 가지 방법" 인데 그중 하나가
            # 막힌 채였다. 제품이 만들 수 없는 상태를 시드가 만들고 있었고,
            # 그 상태로 화면을 재고 캡처해 왔다.
            invite_code=invites.generate_code(),
        )
        s.add(project)
        s.flush()

        # ⚠️ **첫 팀원을 소유자로 넣습니다.**
        #
        # 이게 없던 동안 시연 프로젝트의 세 사람이 전부 `member` 였고,
        # 그래서 **아무도 팀원을 다룰 수 없었습니다** — 등급을 바꾸거나
        # 내보내는 것도, 프로젝트 이름·저장소를 저장하는 것도 관리자
        # 이상이라 셋 다 영영 막혀 있었습니다.
        #
        # 제품은 그런 상태를 만들 수 없습니다. `POST /api/projects` 는
        # 만든 사람을 소유자로 넣고, 그 주석에 "소유자가 0명이면 아무도
        # 못 고치는 프로젝트가 된다" 고 적혀 있습니다. **시드가 제품이
        # 만들 수 없는 상태를 만들고 있었고, 그 상태로 화면을 재 왔습니다**
        # — 초대 코드 때(결함 71) 겪은 것과 같은 종류입니다.
        for index, (user, (_n, _e, login, roles)) in enumerate(
            zip(users, MEMBERS, strict=True)
        ):
            s.add(
                m.Member(
                    project_id=project.id,
                    user_id=user.id,
                    role_shares=roles,
                    github_login=login,
                    project_role=str(
                        vocab.ProjectRole.OWNER if index == 0 else vocab.ProjectRole.MEMBER
                    ),
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
        #
        # ⚠️ **커버리지를 손으로 적지 않습니다** (결함 99). 운영 코드는 셋을
        # 하나의 원천에서 뽑습니다 — `audio/assembly.py` 가
        # `coverage = 1 - total_gap_ms / duration` 이고 `total_gap_ms` 는
        # 구멍의 합입니다. 그래서 여기서도 **구멍만 적고 나머지는 계산**합니다.
        #
        # 손으로 적던 동안 이런 트랙이 나왔습니다.
        #
        #     이하늘  커버리지 98%  ·  총 공백 0  ·  구멍 0개
        #     박지원  커버리지 42%  ·  총 공백 23.2분  ·  구멍 합 15분
        #
        # 운영이 만들 수 없는 상태입니다. 화면에서는 이하늘이 100% 인
        # 김민수와 **똑같이 꽉 찬 막대**로 보였고, 박지원은 빗금이 37.5%
        # 인데 "42% 커버리지"(= 58% 빔)라고 말했습니다. 이 저장소의
        # 시그니처가 "구멍이 **언제** 생겼는지" 인데, 시연 자료가 바로 그
        # 질문에 답하지 못하고 있었습니다. 결함 91 과 같은 부류입니다.
        MEETING_MS = 40 * 60 * 1000
        track_gaps: list[list[dict[str, object]]] = [
            # 김민수 — 끊긴 데 없음
            [],
            # 이하늘 — 22분쯤 마이크가 48초 꺼져 있었다.
            # `track_muted` 는 **서버가 절대 못 보는** 구멍이라
            # (`assembly.GapReason` 주석) 클라이언트 보고로만 남는다.
            [{"reason": "track_muted", "startMs": 1_320_000, "endMs": 1_368_000}],
            # 박지원 — 폰이 잠겨 오래 멈췄고, 조각도 일부 유실됐다
            [
                {"reason": "recorder_stalled", "startMs": 600_000, "endMs": 1_560_000},
                {"reason": "chunk_lost", "startMs": 1_680_000, "endMs": 2_112_000},
            ],
        ]
        for gaps in track_gaps:
            for gap in gaps:
                gap["durationMs"] = int(gap["endMs"]) - int(gap["startMs"])  # type: ignore[arg-type]
        totals = [sum(int(g["durationMs"]) for g in gaps) for gaps in track_gaps]
        coverages = [round(1 - total / MEETING_MS, 3) for total in totals]
        # 정렬 보정값. 기준 트랙이 0 이고 나머지는 GCC-PHAT 이 추정한 값이다.
        offsets_ms = [0, 187, -64]
        for user, coverage, total_gap_ms, gaps, offset_ms in zip(
            users, coverages, totals, track_gaps, offsets_ms, strict=True
        ):
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
                    total_gap_ms=total_gap_ms,
                    longest_gap_ms=max(
                        (int(g["durationMs"]) for g in gaps), default=0
                    ),
                    # ⚠️ **운영 코드와 같은 키**를 씁니다 (카멜).
                    # `recording_service._finalize` 가 이렇게 씁니다:
                    #     {"reason", "startMs", "endMs", "durationMs"}
                    # 예전 시드는 `start_ms`(스네이크)였고, 그래서 화면이
                    # 이 값을 읽으면 **조용히 아무것도 안 그렸습니다** —
                    # 시연에서는 멀쩡해 보이는데 운영에서만 나오는 부류의
                    # 반대, 즉 시연에서만 안 나오는 결함이었습니다.
                    gaps=gaps,
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

        # ⚠️ **회의록은 요약 하나가 아닙니다** (결함 110·111). 파이프라인은
        # 다음 안건과 미해결 사안도 만들어 저장하는데, 그 둘을 **읽는 곳이
        # 저장소에 0곳**이라 시연에서도 안 보였습니다. 여기서도 안 넣으면
        # 배선을 고쳐도 시연 화면은 그대로 비어 있습니다.
        #
        # 근거는 지어내지 않습니다 — 다섯 번째 발화("배포는 아직 정하지
        # 말고 다음 회의에서 다시 얘기해요")가 실제로 그 근거입니다.
        # 운영도 이 모양입니다: `validation._check_evidence` 가 **근거가
        # 없는 미해결 사안을 거부**하므로 저장된 것은 전부 근거를 답니다.
        deferred = UTTERANCES[4]
        s.add(
            m.MeetingEvent(
                meeting_id=meeting.id,
                event_type="unanswered_question",
                severity="info",
                start_ms=deferred[1],
                end_ms=deferred[2],
                evidence_utterance_ids=[utterance_ids[4]],
                detail={"content": "배포 방식을 정하지 못했습니다"},
            )
        )
        # 요약 마지막 줄("배포 방식은 다음 회의로 미뤘습니다")과 같은 것을
        # 가리킵니다 — 회의록 안에서 두 칸이 서로 어긋나 있으면 사람은
        # 어느 쪽을 믿을지 모릅니다.
        meeting.next_agenda = ["배포 방식 결정", "1주차 업무 진행 상황 공유"]

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

        # ⭐ 회의 발화 → 기여 이벤트. **운영 코드와 같은 함수**를 부릅니다.
        #
        # 시연 데이터를 손으로 만들면 시연과 운영이 갈라집니다. 실제로
        # 그랬습니다 — 배선이 0곳인 동안에도 시연 화면에는 회의 기여도가
        # 멀쩡히 떠 있어서, 운영에서 언제나 0이라는 사실이 가려졌습니다.
        meeting_contribution_service.record_meeting(s, meeting)

        _seed_tasks(s, project.id, user_ids, meeting.id)
        _seed_sibling_meetings(s, project.id, users[0].id)

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
    (1, "pr_merged", "github_event", 90.0, 2),
    (1, "review_given", "github_event", 1.0, 3),
    (1, "task_completed", "task", 1.0, 2),
    (1, "task_completed", "task", 1.0, 5),
    (2, "pr_merged", "github_event", 120.0, 4),
    (2, "review_given", "github_event", 1.0, 5),
    (2, "task_completed", "task", 1.0, 4),
    # ⚠️ `utt_*` 는 **여기 없습니다.** 예전에는 손으로 넣었는데, 이제
    # 회의 발화에서 진짜로 만들어집니다(`meeting_contribution_service`).
    #
    # 손으로 넣으면 시연은 되는데 실제 파이프라인에서는 안 되는 상태를
    # 못 알아챕니다 — 실제로 그랬습니다. 배선이 0곳인 동안에도 시연
    # 화면에는 회의 기여도가 멀쩡히 떠 있었습니다.
    #
    # 박지원의 회의 기여는 트랙 커버리지 0.42 때문에 **측정 불가**로
    # 빠집니다. 발언은 기록됐지만(폰이 10분 뒤에 죽었다) 그 사람의
    # 발언량을 비교에 쓸 수 없기 때문입니다.
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
#: `(제목, 담당자 자리들, 상태, 마감까지 며칠, 나온 후보 제목)`.
#:
#: 담당자 자리는 `user_ids` 의 첨자입니다. **빈 튜플이면 담당자 없음**이고,
#: 둘 이상이면 같이 맡은 업무입니다 (`TASK-006`).
_TASKS: list[tuple[str, tuple[int, ...], str, int | None, str | None]] = [
    # 승인을 거쳐 칸반에 올라온 업무. 이게 이 프로젝트의 대표 주장이
    # 화면에서 보이는 자리다 — 카드에서 회의 발화까지 거슬러 올라간다.
    ("DB 스키마 정리", (2,), "done", 2, "DB 스키마 정리"),
    # ⚠️ 출처 없는 업무. 예전 주석은 「회의에서 나오지 않은 것도 칸반에는
    #    있습니다」였는데, **제품에는 그 길이 없습니다** —
    #    `approval_service.py` 의 불변식과 어긋납니다 (결함 318).
    #    `test_demo_path.py` 가 이 상태를 못 박고 있어 여기서 고르지
    #    않았습니다. docs/17 318번 「결정이 필요한 자리」.
    ("개발 환경 문서 정리", (1,), "in_progress", None, None),
    # 담당자가 없는 업무 — 완료해도 기여도에 잡히지 않는다는 걸 화면이
    # 말해 줘야 하는 경우입니다.
    ("배포 방식 조사", (), "todo", 10, None),
    # ⭐ **둘이 같이 맡은 업무** (`TASK-006`). 시연에서 이게 없으면
    #    "나눠 셌습니다" 안내와 이름 둘이 그려지는 자리를 눈으로 볼 수
    #    없습니다 — 이 저장소의 대표 실패 ③ 입니다.
    ("접근성 점검", (0, 1), "todo", 6, None),
]

# ⭐ '로그인 API 구현' 은 일부러 여기 없습니다. 승인 화면에 완전한 후보로
# 떠 있고, 시연자가 그걸 승인하면 칸반에 카드가 **새로 생깁니다.** 미리
# 넣어 두면 승인해도 아무 변화가 없거나(멱등이 아니면) 카드가 둘이 됩니다.


def _seed_sibling_meetings(session, project_id: int, host_id: int) -> None:
    """회의를 **여럿** 만든다. 내용은 없고 껍데기만.

    ## 왜 필요한가

    회의가 하나뿐이면 채널 목록이 **한 줄**입니다. 그러면 "회의는 페이지가
    아니라 들어가고 나오는 방" 이라는 이 제품의 주장이 화면에서 안 보이고,
    상태 점 다섯 종류(열림·처리중·검토필요·끝남·실패)도 한 번에 하나밖에
    못 봅니다.

    ⚠️ **발화도 후보도 트랙도 넣지 않습니다.** 여기서 만드는 것은
    "목록에 서는 회의" 뿐입니다. 알맹이까지 흉내 내면 위의 1주차 회의와
    구분이 안 되고, 시연에서 어느 것이 진짜 파이프라인을 거친 것인지
    아무도 모르게 됩니다.

    ⚠️ 제목 없는 회의를 **일부러 하나** 둡니다. 서버는 `title` 을
    `null` 로 줄 수 있고, 화면은 그때 "회의 5" 처럼 번호로 불러야 합니다
    (`channelLabel`). 그 자리가 실제로 그려지는지 눈으로 보려면 하나는
    있어야 합니다.
    """
    others = [
        # 아직 안 끝난 회의 — 채널 목록에서 초록 점. "지금 들어갈 수 있다"
        ("스프린트 2 계획", timedelta(days=7), "pending"),
        # 서버가 돌리는 중 — 속이 빈 점. 눌러도 아직 볼 것이 없다
        ("DB 스키마 확정 논의", timedelta(days=4), "processing"),
        # 제목을 안 지은 회의. 화면이 번호로 불러야 한다
        (None, timedelta(days=2), "confirmed"),
        # 처리에 실패한 회의 — 빨간 점. 숨기지 않습니다
        ("중간발표 리허설", timedelta(days=1), "failed"),
    ]
    for title, offset, status in others:
        session.add(
            m.Meeting(
                project_id=project_id,
                title=title,
                started_at=MEETING_START + offset,
                duration_sec=30 * 60,
                started_by=host_id,
                capture_mode="multitrack",
                status=status,
            )
        )


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

    for title, owners, status, due_days, origin_title in _TASKS:
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
            deadline=deadline,
            status=status,
            completed_at=completed_at,
            # 회의에서 나온 업무는 후보를 가리킨다. 그 연결이 화면에서
            # "🗣 회의에서 나온 업무" 로 보인다.
            origin_candidate_id=origin.id if origin else None,
        )
        session.add(task)
        session.flush()
        assignees.replace(session, task.id, [user_ids[i] for i in owners])

        if origin is not None:
            # ⭐ 반대 방향도 잇는다. 이게 없으면 승인 화면이 이 후보를
            # "아직 승인 안 됨" 으로 보여주고, 승인하면 업무가 하나 더 생긴다.
            origin.review_status = "approved"
            origin.reviewed_by = reviewer
            origin.created_task_id = task.id
            if status == "done":
                _seed_merged_pull_request(
                    session, project_id, task, user_ids[owners[0]]
                )
    session.flush()


def _seed_merged_pull_request(session, project_id: int, task, user_id: int) -> None:
    """완료된 업무 하나에 병합된 PR 을 붙인다.

    ⭐ **이게 없으면 시연에서 마지막 칸이 안 보입니다.**

        회의 녹음 → 자막 → 업무 후보 → 승인 → 칸반
            → **관련 PR 병합 → 업무 카드에 수행 근거**   ← 여기
            → 기여도

    docs/08 §5.1 의 필수 경로이고, 여기까지 화면에서 보여야 이 프로젝트가
    "회의록 만드는 툴" 과 다르다는 주장이 성립합니다.

    ⚠️ 연결을 손으로 만들지 않고 **운영 코드와 같은 함수**(`link_pull_request`)
    를 부릅니다. 손으로 넣으면 시연은 되는데 실제 웹훅에서는 안 되는 상태를
    못 알아챕니다 — 이 저장소에서 반복해서 나온 실패 방식입니다.
    """
    from teamflow.github.linking import task_marker
    from teamflow.services import task_link_service

    login = session.scalar(
        select(m.Member.github_login).where(
            m.Member.project_id == project_id, m.Member.user_id == user_id
        )
    )
    merged_at = (task.completed_at or MEETING_START) + timedelta(hours=2)

    event = m.GithubEvent(
        project_id=project_id,
        delivery_id=f"seed-pr-{task.id}",
        repo="tjgksmf1012/teamflow-demo",
        event_type="pull_request.merged",
        actor_login=login or "minsu-dev",
        actor_user_id=user_id,
        ref=f"feat/{task.id}-schema",
        payload={
            "action": "closed",
            "repository": {"full_name": "tjgksmf1012/teamflow-demo"},
            "pull_request": {
                "number": 17,
                "title": f"{task.title}",
                # 시연자가 화면에서 볼 표식과 **같은 것**을 씁니다.
                "body": f"회의에서 정한 대로 정리했습니다.\n\n{task_marker(task.id)}",
                "merged": True,
                "merged_at": merged_at.isoformat(),
                "user": {"login": login or "minsu-dev"},
                "head": {"ref": f"feat/{task.id}-schema"},
            },
        },
        occurred_at=merged_at,
    )
    session.add(event)
    session.flush()

    linked = task_link_service.link_pull_request(session, event)
    if not linked:
        # 조용히 넘어가면 시연 직전에 카드가 비어 있는 걸 발견합니다.
        raise SystemExit(
            f"업무 {task.id} 에 PR 을 잇지 못했습니다. "
            "link_pull_request 나 표식 규칙이 바뀌었는지 확인하세요."
        )


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
