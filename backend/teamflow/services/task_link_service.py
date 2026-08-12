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

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from teamflow.db import assignees, live, vocab
from teamflow.db import models as m
from teamflow.github.linking import TaskRef, find_task_refs
from teamflow.services import notification_service

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
        _tell_the_assignee(session, event, linked)
        logger.info(
            "github_event=%s → 업무 %s 연결",
            event.id,
            [ref.task_id for ref in linked],
        )
    return linked


def _tell_the_assignee(
    session: Session, event: m.GithubEvent, linked: list[TaskRef]
) -> None:
    """`NOTIFICATION-006` — 내 업무에 PR 이 붙었다.

    이 알림 종류(`github`)는 **어휘에만 있고 만드는 코드가 0곳**이었습니다
    (`vocab.NOTIFICATION_NOT_PRODUCED_YET` 이 그렇게 적어 뒀습니다).
    붙일 자리가 여기입니다 — PR 과 업무가 실제로 이어지는 순간.

    ⚠️ **담당자에게만 갑니다.** 프로젝트 전원에게 쏘면 PR 하나에 알림이
    사람 수만큼 생기고, 그러면 사람들은 알림을 통째로 무시합니다.

    ⚠️ **자기가 올린 PR 은 자기에게 안 알립니다.** `record()` 가 그걸
    막는데, 막으려면 **누가 한 일인지**를 넘겨야 합니다.

    ⚠️ 담당자가 없는 업무는 조용합니다. 아무에게도 안 보내는 것이
    맞습니다 — 여기서 프로젝트 전원으로 넓히면 위 규칙이 무너집니다.

    ⚠️ 담당자가 여럿이면 **전원에게** 갑니다 (`TASK-006`). 여기서 한
    명만 고르면 그건 "대표 담당자" 를 만드는 것이고, 그런 것은 없습니다.
    사람 수만큼 알림이 생기는 것은 맞지만 그 수는 **한 업무의 담당자 수**로
    묶여 있어서, 위에서 막으려던 "프로젝트 전원" 과는 크기가 다릅니다.
    """
    actor_id = _github_actor(session, event)
    for ref in linked:
        task = session.get(m.Task, ref.task_id)
        if task is None:
            continue
        for user_id in assignees.of_task(session, task.id):
            # ⚠️ 자기가 올린 PR 은 자기에게 안 알립니다. `record_assignment` 가
            #    같은 방식으로 거릅니다 — `record()` 자체는 누가 했는지 모릅니다.
            if user_id == actor_id:
                continue
            notification_service.record(
                session,
                user_id=user_id,
                project_id=task.project_id,
                kind=vocab.NotificationKind.GITHUB,
                task_id=task.id,
            )


def _github_actor(session: Session, event: m.GithubEvent) -> int | None:
    """이 PR 을 움직인 사람이 우리 팀의 누구인가. 모르면 `None`.

    ⚠️ GitHub 로그인과 우리 사용자를 잇는 것은 `members.github_login`
    뿐입니다. 안 이어 놓았으면 모르는 것이고, **모르면 안 거릅니다** —
    자기 알림이 하나 오는 것이 남의 알림이 안 오는 것보다 낫습니다.
    """
    login = (event.actor_login or "").strip().lower()
    if not login:
        return None
    return session.scalars(
        select(m.Member.user_id).where(
            func.lower(m.Member.github_login) == login,
            m.Member.project_id == event.project_id,
        )
    ).first()


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
