"""GitHub 이벤트 → 기여 이벤트 저장.

`contribution/github_ingest.py` 는 완성돼 있었고 테스트도 있었는데
**호출자가 0곳**이었습니다. 이 모듈이 그 자리를 채웁니다.

    웹훅 수신 → GithubEvent 저장 → (여기) API 로 diff·리뷰 조회
              → pr_to_events → ContributionEventRow 저장 → 기여도 화면

그 전까지 `contribution_events` 에 들어가는 경로는 **손으로 넣는 것과 업무
완료뿐**이었습니다. 즉 "관련 PR 병합이 기여도에 근거와 함께 반영된다" 는
주장은 코드상 어디서도 일어나지 않았습니다.
"""

from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from teamflow.contribution.events import ContributionEvent
from teamflow.contribution.github_ingest import pr_to_events, reviews_to_events
from teamflow.db import models as m
from teamflow.github import mapping
from teamflow.github.client import GitHubClient, GitHubError

logger = logging.getLogger(__name__)


def member_logins(session: Session, project_id: int) -> dict[str, int]:
    """GitHub 로그인 → user_id. **키는 소문자입니다.**

    GitHub 로그인은 대소문자를 보존하지만 비교는 대소문자 무관입니다.
    `MinSu` 로 등록해 두고 웹훅이 `minsu` 로 오면 못 찾고, 그 사람의 PR 이
    통째로 기여도에서 빠집니다.
    """
    rows = session.execute(
        select(m.Member.github_login, m.Member.user_id).where(
            m.Member.project_id == project_id, m.Member.github_login.is_not(None)
        )
    ).all()
    return {login.lower(): user_id for login, user_id in rows if login}


def persist_events(
    session: Session, project_id: int, events: list[ContributionEvent]
) -> int:
    """기여 이벤트를 저장한다. 이미 있는 것은 건너뛴다.

    멱등성이 필수입니다 — 웹훅은 재전송되고, 백필과 겹치고, Celery 는
    `task_acks_late` 라 워커가 죽으면 같은 잡이 다시 돕니다. 막지 않으면
    **재전송 한 번에 그 사람 점수가 두 배**가 됩니다.

    DB 유니크 제약이 최종 방어선이지만, 여기서 먼저 확인해야 IntegrityError
    로 배치 전체가 실패하지 않습니다.
    """
    written = 0
    for event in events:
        # ⚠️ `user_id` 까지 봐야 합니다. DB 유니크 제약이 그렇게 돼 있고,
        # 여기서 빼면 **다른 사람의 같은 유형 이벤트를 보고 건너뜁니다** —
        # 그 사람의 기여가 조용히 사라집니다.
        exists = session.scalar(
            select(m.ContributionEventRow.id).where(
                m.ContributionEventRow.source_kind == event.source_kind.value,
                m.ContributionEventRow.source_id == event.source_id,
                m.ContributionEventRow.event_type == event.event_type.value,
                m.ContributionEventRow.user_id == event.user_id,
            )
        )
        if exists:
            continue

        session.add(
            m.ContributionEventRow(
                project_id=project_id,
                user_id=event.user_id,
                occurred_at=event.occurred_at,
                category=event.category.value,
                event_type=event.event_type.value,
                source_kind=event.source_kind.value,
                source_id=event.source_id,
                magnitude=event.magnitude,
                event_metadata=dict(event.metadata),
            )
        )
        written += 1

    session.flush()
    return written


def ingest_merged_pull_request(
    session: Session,
    client: GitHubClient,
    *,
    project_id: int,
    repo: str,
    number: int,
    resolve_issue_id=None,
) -> dict:
    """병합된 PR 하나를 기여 이벤트로 옮긴다.

    `resolve_issue_id(repo, number) -> int | None` 은 이슈 **번호**를 전역
    **id** 로 바꾸는 함수입니다. 번호는 저장소 안에서만 유일해서, 그대로
    `source_id` 에 쓰면 저장소가 둘일 때 서로의 이슈와 충돌합니다.
    주지 않으면 이슈 해결 이벤트를 만들지 않습니다 — **틀린 id 로 만드는
    것보다 안 만드는 게 낫습니다.**
    """
    details = client.pull_request_details(repo, number)

    issue_ids: list[int] = []
    if resolve_issue_id is not None:
        for issue_number in mapping.parse_closing_issue_numbers(details.body):
            issue_id = resolve_issue_id(repo, issue_number)
            if issue_id is not None:
                issue_ids.append(issue_id)

    logins = member_logins(session, project_id)
    pull = mapping.to_pull_request(details, logins=logins, closed_issue_ids=issue_ids)

    if pull is None:
        # ⚠️ **두 가지 다른 상황입니다** (결함 62). 예전에는 한 이유
        # (`unmapped_author_or_not_merged`)로 묶어 둘 다 조용히 버렸습니다.
        #
        #   병합 안 됨      → 이벤트가 없는 게 맞습니다
        #   작성자 못 붙임  → 코드 기여는 못 세지만, **우리 팀원이 그 PR 에
        #                     준 리뷰는 그 사람의 기여**입니다
        #
        # 외부 기여자·봇의 PR 을 팀원이 리뷰하는 것은 흔한 일이고, 팀원이
        # GitHub 로그인을 아직 등록 안 한 동안에도 같은 일이 벌어집니다.
        # 그 리뷰를 버리면 **오류 없이 기여도만 빕니다.**
        if mapping.parse_time(details.merged_at) is None:
            return {"status": "skipped", "reason": "not_merged"}

        review_events = reviews_to_events(
            mapping.to_reviews(details, logins=logins),
            pr_id=int(details.id),
            pr_number=int(details.number),
            author_id=None,
        )
        written = persist_events(session, project_id, review_events)
        logger.info(
            "project=%s %s#%s 작성자 %r 를 못 붙였지만 리뷰 %d건은 살렸습니다",
            project_id,
            repo,
            number,
            details.author_login,
            len(review_events),
        )
        return {
            "status": "reviews_only",
            "reason": "unmapped_author",
            "events": len(review_events),
            "written": written,
        }

    events = pr_to_events(pull)
    written = persist_events(session, project_id, events)
    logger.info(
        "project=%s %s#%s → 기여 이벤트 %d건 중 %d건 신규",
        project_id,
        repo,
        number,
        len(events),
        written,
    )
    return {"status": "ok", "events": len(events), "written": written}


def ingest_github_event(session: Session, client: GitHubClient, event_id: int) -> dict:
    """저장된 웹훅 이벤트 하나를 처리한다.

    `GithubEvent` 행에서 시작하는 이유: 웹훅 본문은 이미 저장돼 있으므로,
    이 잡이 실패해도 **다시 걸 수 있습니다.** 웹훅 요청 안에서 API 를
    호출하면 GitHub 의 10초 제한에 걸리고, 실패하면 그 PR 의 기여는
    영영 사라집니다.
    """
    row = session.get(m.GithubEvent, event_id)
    if row is None:
        return {"status": "not_found", "event_id": event_id}
    if row.event_type != "pull_request.merged":
        return {"status": "ignored", "event_type": row.event_type}

    number = ((row.payload or {}).get("pull_request") or {}).get("number")
    if number is None:
        logger.warning("github_event=%s 에 PR 번호가 없습니다", event_id)
        return {"status": "ignored", "reason": "no_pr_number"}

    try:
        return ingest_merged_pull_request(
            session, client, project_id=row.project_id, repo=row.repo, number=int(number)
        )
    except GitHubError as exc:
        # 재시도 가능 여부를 호출자(Celery 태스크)에게 그대로 넘깁니다.
        # 여기서 삼키면 rate limit 한 번에 그 PR 의 기여가 사라집니다.
        logger.warning("github_event=%s 조회 실패: %s", event_id, exc)
        raise
