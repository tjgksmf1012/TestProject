"""업무 ↔ PR 연결 저장.

판단은 `teamflow/github/linking.py` 에 있습니다. 여기는 DB 만 봅니다.

## 이 프로젝트의 대표 주장에서 끊겨 있던 곳

docs/08 §5.1 의 필수 경로는 이렇습니다.

    회의 녹음 → 화자별 자막 → 업무 후보 → 승인 → 칸반에 등록
        → **관련 PR 병합 → 업무 카드에 수행 근거 표시**
        → 기여도 화면에 근거와 함께 반영

굵은 부분이 코드에 없었습니다. `task_github_links` 표는 처음부터 있었고
`extract_task_refs` 도 있었는데, **둘을 잇는 코드가 0곳**이라 그 표에 행이
한 번도 쓰인 적이 없습니다.

## 왜 웹훅 안에서 하는가 (워커가 아니라)

`ingest_github_event_task` 는 이렇게 시작합니다.

    client = build_client(settings, installation_id)
    if client is None:
        return {"status": "not_configured", ...}

즉 **GitHub App 자격 증명이 없으면 아무것도 안 합니다.** 그 안에 연결을
두면, 자격 증명을 갖추기 전까지 업무 카드에 PR 이 영영 안 붙습니다.

그런데 연결에는 **API 도 자격 증명도 필요 없습니다.** 웹훅 본문에 PR 제목·
본문·브랜치가 이미 다 들어 있습니다. 필요한 것은 select 하나와 insert
몇 개뿐이라 GitHub 의 10초 응답 기대에도 여유가 있습니다.

그래서 여기서 바로 합니다. 자격 증명이 없는 팀도, 워커가 죽어 있는
동안에도 업무와 PR 은 이어집니다.
"""

from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from teamflow.db import live
from teamflow.db import models as m
from teamflow.github.linking import TaskRef, find_task_refs

logger = logging.getLogger(__name__)

#: 연결을 만드는 이벤트. 리뷰나 이슈는 "이 업무가 이 PR 로 끝났다" 가 아닙니다.
LINKED_EVENT_TYPES = frozenset({"pull_request.merged"})


def link_pull_request(session: Session, event: m.GithubEvent) -> list[TaskRef]:
    """PR 이벤트 하나를 이 프로젝트의 업무에 잇는다.

    실제로 연결된 참조만 돌려줍니다 — 없는 업무나 **남의 프로젝트 업무**를
    가리킨 참조는 버립니다.
    """
    if event.event_type not in LINKED_EVENT_TYPES:
        return []

    pull = (event.payload or {}).get("pull_request") or {}
    refs = find_task_refs(
        title=pull.get("title"),
        body=pull.get("body"),
        # `event.ref` 가 곧 `head.ref` 입니다. 본문에서 다시 파내면 둘이
        # 어긋날 수 있고, 어긋나면 어느 쪽이 맞는지 알 방법이 없습니다.
        branch=event.ref,
    )
    if not refs:
        return []

    # ⚠️ **반드시 이 프로젝트의 업무여야 합니다.**
    #
    # `tasks.id` 는 전역 시퀀스입니다. 프로젝트마다 1번부터 시작하지
    # 않습니다. 그래서 `TASK-12` 를 적으면 그 12번은 **다른 팀의 업무**일
    # 수 있고, 범위를 안 걸면 남의 업무 카드에 우리 PR 이 붙습니다.
    wanted = {ref.task_id for ref in refs}
    real = set(
        session.scalars(
            live.live_task_ids().where(
                m.Task.id.in_(wanted), m.Task.project_id == event.project_id
            )
        )
    )

    dropped = wanted - real
    if dropped:
        # 조용히 버리면 사람은 왜 안 붙었는지 알 수 없습니다. 로그에는 남깁니다.
        logger.info(
            "github_event=%s 가 가리킨 업무 %s 는 project=%s 에 없습니다",
            event.id,
            sorted(dropped),
            event.project_id,
        )

    linked: list[TaskRef] = []
    for ref in refs:
        if ref.task_id not in real:
            continue
        # 웹훅은 재전송됩니다. 복합 기본키가 막아 주지만, 여기서 먼저
        # 확인해야 IntegrityError 로 배달 처리 전체가 실패하지 않습니다.
        exists = session.scalar(
            select(m.TaskGithubLink.task_id).where(
                m.TaskGithubLink.task_id == ref.task_id,
                m.TaskGithubLink.github_event_id == event.id,
            )
        )
        if exists is None:
            session.add(
                m.TaskGithubLink(
                    task_id=ref.task_id,
                    github_event_id=event.id,
                    relevance=ref.relevance,
                    link_source=ref.source,
                )
            )
        linked.append(ref)

    if linked:
        session.flush()
        logger.info(
            "github_event=%s → 업무 %s 연결",
            event.id,
            [ref.task_id for ref in linked],
        )
    return linked


def links_for_tasks(
    session: Session, task_ids: list[int]
) -> dict[int, list[tuple[m.TaskGithubLink, m.GithubEvent]]]:
    """업무별 연결된 PR. 칸반 화면이 한 번에 읽습니다.

    업무마다 따로 물으면 카드 스무 개짜리 보드에서 쿼리가 스무 번 나갑니다.
    """
    if not task_ids:
        return {}

    rows = session.execute(
        select(m.TaskGithubLink, m.GithubEvent)
        .join(m.GithubEvent, m.GithubEvent.id == m.TaskGithubLink.github_event_id)
        .where(m.TaskGithubLink.task_id.in_(task_ids))
        # 확실한 근거부터, 그다음 최근 것부터. 화면이 위에서부터 읽습니다.
        .order_by(
            m.TaskGithubLink.relevance.desc(), m.GithubEvent.occurred_at.desc()
        )
    ).all()

    by_task: dict[int, list[tuple[m.TaskGithubLink, m.GithubEvent]]] = {}
    for link, event in rows:
        by_task.setdefault(link.task_id, []).append((link, event))
    return by_task
