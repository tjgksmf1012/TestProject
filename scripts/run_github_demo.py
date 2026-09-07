#!/usr/bin/env python3
"""GitHub 활동 인제스트 및 Anti-Gaming(조작 저항성) 실기 시연 스크립트.

docs/09-리스크와-검증-실험.md 실험 4:
"기여도 산식이 맞다는 것은 증명 못 하지만, 뻔한 조작에 견디는지는
정답 없이 검증할 수 있으며 발표에서 가장 인상적인 부분이 된다."

이 스크립트는 실제 diff 필터 및 점수 산정 엔진을 통과시켜:
1. 김민수 (정상 개발): 실질 코드 구현 + 테스트 + 동료 리뷰 PR ➔ 정상 점수 획득
2. 이하늘 (조작 시도): README 오타 수정 30건 PR 스팸 ➔ 2.97점으로 억제 + trivial_pr_spam 경고
3. 이하늘 (조작 시도): 외부 리뷰 없는 셀프 머지 4건 ➔ no_external_review 경고
4. 박지원 (조작 시도): 3,000줄 package-lock.json + black 전체 재포맷 ➔ 0점으로 완전 배제
를 데모 DB에 실제로 주입하고 재계산하여 화면(/app/project/1/contributions)에서
눈으로 확인할 수 있도록 합니다.

사용법:
    .venv\\Scripts\\python -X utf8 scripts/run_github_demo.py
    .venv\\Scripts\\python -X utf8 scripts/run_github_demo.py --reset
"""

from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

# backend 경로 추가
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from sqlalchemy import create_engine, delete, select

from teamflow.config import get_settings
from teamflow.contribution.diff_filter import ChangedFile
from teamflow.contribution.events import Category, SourceKind
from teamflow.contribution.github_ingest import PullRequest, Review, pr_to_events
from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.services import github_ingest_service, scoring_service

BASE_TIME = datetime.now(UTC) - timedelta(days=2)


def at(minutes: int = 0) -> datetime:
    return BASE_TIME + timedelta(minutes=minutes)


def code_file(name: str, body_lines: int, *, prefix: str = "line") -> ChangedFile:
    """실질 내용이 있는 코드 파일 변경."""
    patch = f"@@ -0,0 +1,{body_lines} @@\n"
    patch += "\n".join(f"+    {prefix}_{i} = compute({i})" for i in range(body_lines))
    return ChangedFile(filename=name, status="added", additions=body_lines, patch=patch)


def reformat_file(name: str, body_lines: int) -> ChangedFile:
    """들여쓰기만 바꾼 변경 (실질 내용 동일)."""
    removed = "\n".join(f"-  value_{i} = f({i})" for i in range(body_lines))
    added = "\n".join(f"+    value_{i} = f({i})" for i in range(body_lines))
    patch = f"@@ -1,{body_lines} +1,{body_lines} @@\n{removed}\n{added}"
    return ChangedFile(
        filename=name,
        status="modified",
        additions=body_lines,
        deletions=body_lines,
        patch=patch,
    )


def lockfile(name: str = "package-lock.json", body_lines: int = 3000) -> ChangedFile:
    """자동 생성된 lock 파일 변경."""
    patch = f"@@ -1,1 +1,{body_lines} @@\n"
    patch += "\n".join(f'+    "dep_{i}": "1.0.{i}",' for i in range(body_lines))
    return ChangedFile(filename=name, status="modified", additions=body_lines, patch=patch)


def typo_file(name: str, index: int) -> ChangedFile:
    """단 1줄 오타 수정 변경."""
    patch = (
        f"@@ -{index},1 +{index},1 @@\n"
        f"-# 이 모듈은 데이터 처리를 담당합니당 {index}\n"
        f"+# 이 모듈은 데이터 처리를 담당합니다 {index}\n"
    )
    return ChangedFile(filename=name, status="modified", additions=1, deletions=1, patch=patch)


def merged_pr(
    pr_id: int,
    author_id: int,
    files: list[ChangedFile],
    *,
    reviewers: list[int] | None = None,
    minutes: int = 0,
) -> PullRequest:
    reviews = [
        Review(reviewer_id=r, submitted_at=at(minutes), comment_count=2, state="APPROVED")
        for r in (reviewers or [])
    ]
    return PullRequest(
        id=pr_id,
        number=pr_id,
        author_id=author_id,
        merged_at=at(minutes),
        files=files,
        reviews=reviews,
    )


def run_demo(*, reset: bool = False, database_url: str | None = None) -> int:
    settings = get_settings()
    url = database_url or settings.database_url
    engine = create_engine(url)
    db_session.configure(engine)

    with db_session.session_scope() as s:
        # 1. 프로젝트 및 멤버 조회
        project = s.scalar(select(m.Project).where(m.Project.id == 1))
        if project is None:
            project = s.scalars(select(m.Project)).first()

        if project is None:
            print("❌ 프로젝트를 찾을 수 없습니다. 먼저 scripts/seed_demo.py 를 실행하세요.")
            return 1

        members = s.scalars(
            select(m.Member).where(m.Member.project_id == project.id).order_by(m.Member.id)
        ).all()

        if len(members) < 3:
            print(f"❌ 팀원이 3명 이상이어야 시연이 가능합니다 (현재: {len(members)}명).")
            return 1

        u1, u2, u3 = members[0].user_id, members[1].user_id, members[2].user_id
        name1 = s.get(m.User, u1).name if s.get(m.User, u1) else f"User {u1}"
        name2 = s.get(m.User, u2).name if s.get(m.User, u2) else f"User {u2}"
        name3 = s.get(m.User, u3).name if s.get(m.User, u3) else f"User {u3}"

        # GitHub login 매핑 보장
        members[0].github_login = "minsu"
        members[1].github_login = "haneul"
        members[2].github_login = "jiwon"
        s.flush()

        print("=" * 68)
        print("🛡️  TeamFlow AI — GitHub 활동 & Anti-Gaming(조작 저항성) 실기 시연")
        print("=" * 68)
        print(f"프로젝트 : {project.title} (ID: {project.id})")
        print(f"참여 팀원: {name1}(ID:{u1}), {name2}(ID:{u2}), {name3}(ID:{u3})\n")

        # 기존 시연 PR 이벤트 초기화 옵션
        DEMO_PR_BASE = 5000
        if reset:
            deleted = s.execute(
                delete(m.ContributionEventRow).where(
                    m.ContributionEventRow.project_id == project.id,
                    m.ContributionEventRow.source_kind == SourceKind.GITHUB_EVENT.value,
                    m.ContributionEventRow.source_id >= DEMO_PR_BASE,
                )
            ).rowcount
            print(f"[*] 기존 시연 GitHub 이벤트 {deleted}건을 초기화했습니다.\n")

        # ── 시나리오 1: 정상 기능 개발 (김민수) ─────────────────────────
        # 실질 구현 180줄 + 테스트 60줄 + 이하늘의 코드 리뷰
        pr_real = merged_pr(
            DEMO_PR_BASE + 1,
            author_id=u1,
            files=[
                code_file("src/auth/jwt_service.py", 180),
                code_file("tests/test_jwt_service.py", 60, prefix="assert"),
            ],
            reviewers=[u2],
            minutes=10,
        )

        # ── 시나리오 2: 오타 30건 스팸 + 셀프 머지 조작 시도 (이하늘) ──────
        # README.md 한 줄짜리 오타 수정 30건을 외부 리뷰 없이 셀프 머지로 대량 생성
        typo_prs = [
            merged_pr(
                DEMO_PR_BASE + 100 + i,
                author_id=u2,
                files=[typo_file("README.md", i + 1)],
                reviewers=[],  # 외부 리뷰 없는 셀프 머지
                minutes=20 + i,
            )
            for i in range(30)
        ]

        # ── 시나리오 3: 3000줄 lockfile & 재포맷 조작 시도 (박지원) ─────────
        # 3,000줄짜리 package-lock.json 수정 + 20개 파일 prettier 전체 재포맷
        lockfile_pr = merged_pr(
            DEMO_PR_BASE + 301,
            author_id=u3,
            files=[lockfile("frontend/package-lock.json", 3000)],
            minutes=100,
        )
        reformat_pr = merged_pr(
            DEMO_PR_BASE + 302,
            author_id=u3,
            files=[reformat_file(f"src/utils_{i}.py", 100) for i in range(20)],
            minutes=110,
        )

        # ── 이벤트 변환 및 DB 영구 적재 ──────────────────────────────
        all_prs = [pr_real, *typo_prs, lockfile_pr, reformat_pr]
        all_events = []
        for pr in all_prs:
            all_events.extend(pr_to_events(pr))

        written = github_ingest_service.persist_events(s, project.id, all_events)
        print(
            f"[*] 총 {len(all_prs)}개 PR에서 {len(all_events)}건의 이벤트 추출, "
            f"{written}건 신규 적재.\n"
        )

        # ── 점수 엔진 실시간 재계산 ──────────────────────────────────
        score_result = scoring_service.compute(s, project.id)

        print("-" * 68)
        print("📊 [실측 결과] 팀원별 기여도 및 Anti-Gaming 방어 판정")
        print("-" * 68)

        for uid, name, scenario_title in [
            (u1, name1, "정상 구현 1건 + 테스트 + 동료 리뷰"),
            (u2, name2, "오타 PR 30건 스팸 + 셀프머지 조작 시도"),
            (u3, name3, "3000줄 package-lock.json + black 전체 재포맷"),
        ]:
            m_score = score_result.members[uid]
            code_cat = m_score.categories.get(Category.CODE)
            raw = code_cat.raw if code_cat else 0.0
            events_count = code_cat.event_count if code_cat else 0
            flags = [f.code for f in m_score.integrity_flags]

            print(f"• {name} ({scenario_title})")
            print(f"   - 코드 카테고리 점수 (raw): {raw:.2f}점 / PR 근거: {events_count}건")
            print(
                f"   - 팀 기여 지분 (share): {m_score.share:.1f}% "
                f"[구간: {m_score.range_low:.1f}% ~ {m_score.range_high:.1f}%]"
            )

            if flags:
                flag_str = ", ".join(f"🚩 {f}" for f in flags)
                print(f"   - 무결성 경고 플래그: {flag_str}")
                for f in m_score.integrity_flags:
                    print(f"     └ [{f.code}] {f.message}")
            else:
                print("   - 무결성 상태: ✅ 정상 (플래그 없음)")
            print()

        # ── 핵심 불변식 및 방어력 검증 리포트 ──────────────────────────
        score1 = score_result.members[u1].categories.get(Category.CODE).raw
        score2 = score_result.members[u2].categories.get(Category.CODE).raw
        code3 = score_result.members[u3].categories.get(Category.CODE)
        score3 = code3.raw if code3 else 0.0

        u2_flags = {f.code for f in score_result.members[u2].integrity_flags}

        print("=" * 68)
        print("🎯 Anti-Gaming 3대 방어 메커니즘 검증 판정:")
        print("=" * 68)

        # 1. 오타 30건 스팸 억제
        typo_damped = score1 > score2
        print(
            " 1. [사소 변경 감쇠 및 천장] "
            f"오타 30건 스팸({score2:.2f}점) < 실제 구현 1건({score1:.2f}점)"
        )
        print(f"    결과: {'✅ 방어 성공! (스팸이 제압됨)' if typo_damped else '❌ 실패'}")

        # 2. lockfile & 재포맷 0점 필터링
        print(" 2. [생성 파일 및 포맷팅 제외] 3000줄 lockfile 및 재포맷 점수 기여")
        is_filtered = score3 == 0.0 or score3 < 1.0
        print(f"    결과: {'✅ 완전 방어! (0점 반영)' if is_filtered else '❌ 실패'}")

        # 3. 조작 탐지 플래그 발동
        spam_flagged = "trivial_pr_spam" in u2_flags
        review_flagged = "no_external_review" in u2_flags
        s_res = "✅ trivial_pr_spam 부착됨" if spam_flagged else "❌ 미감지"
        r_res = "✅ no_external_review 부착됨" if review_flagged else "❌ 미감지"
        print(f" 3. [무결성 플래그] 사소 PR 스팸 감지: {s_res}")
        print(f"                 외부 리뷰 누락 감지: {r_res}")
        print("=" * 68)

        print("\n🌐 지금 바로 웹 UI에서 시연 결과를 눈으로 확인하세요:")
        print(f"  👉 http://127.0.0.1:8811/app/project/{project.id}/contributions")
        print("  • 기여 사슬(Chain)의 '코드 N건' 배지 확인")
        print("  • '모름' 옆 '?' 팝오버를 눌러 무결성 경고 문구가 실시간 표시되는지 확인\n")

    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="GitHub Anti-Gaming 시연 실행기")
    parser.add_argument(
        "--reset", action="store_true", help="기존 시연 GitHub 이벤트를 초기화하고 새로 주입"
    )
    parser.add_argument("--database-url", help="사용할 데이터베이스 URL")
    args = parser.parse_args()

    raise SystemExit(run_demo(reset=args.reset, database_url=args.database_url))
