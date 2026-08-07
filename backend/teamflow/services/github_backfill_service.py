"""백필 실행 — 웹훅이 지나가는 길을 그대로 다시 걷는다.

판단은 `teamflow/github/backfill.py` 에 있습니다. 여기는 DB 와 클라이언트만
봅니다.

## 왜 웹훅 경로를 재사용하는가

백필용 저장 경로를 따로 만들면 **웹훅에서 고친 것이 백필에서는 안
고쳐집니다.** 이 저장소는 이미 그 부류로 여러 번 당했습니다. 그래서
백필은 웹훅과 똑같이 합니다.

    목록 조회 → 웹훅 모양 payload → GithubEvent 저장
              → task_link_service.link_pull_request  (업무 카드에 붙는다)
              → github_ingest_service.ingest_merged_pull_request  (기여 이벤트)

바뀐 것은 **어디서 왔는가** 하나뿐입니다 — 배달 id 가 `backfill:` 로
시작합니다.

## 겹쳐도 한 번만

백필과 웹훅이 같은 PR 을 가져올 수 있습니다. 세 겹으로 막습니다.

    1. `plan` 이 이미 있는 PR 번호를 건너뜁니다 (여기서 대부분 걸립니다)
    2. `uq_github_delivery` 가 같은 배달 id 를 막습니다 (백필 재실행)
    3. `persist_events` 가 기여 이벤트를 (근거, 유형, 사람) 으로 막습니다

1번이 중요합니다. 2번만 있으면 웹훅으로 이미 들어온 PR 을 백필이 **다른
배달 id 로** 또 넣고, 업무 카드에 같은 PR 이 두 번 붙습니다.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from teamflow.db import models as m
from teamflow.github import backfill as bf
from teamflow.github import webhook
from teamflow.github.client import GitHubClient, GitHubError
from teamflow.services import github_ingest_service, task_link_service

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class BackfillResult:
    status: str
    listed: int = 0
    stored: int = 0
    events_written: int = 0
    tasks_linked: int = 0
    already_have: int = 0
    failed: int = 0
    truncated: bool = False
    covered_since: datetime | None = None
    note: str = ""

    def as_dict(self) -> dict:
        return {
            "status": self.status,
            "listed": self.listed,
            "stored": self.stored,
            "events_written": self.events_written,
            "tasks_linked": self.tasks_linked,
            "already_have": self.already_have,
            "failed": self.failed,
            "truncated": self.truncated,
            "covered_since": (
                self.covered_since.isoformat() if self.covered_since else None
            ),
            "note": self.note,
        }


def known_pull_request_numbers(session: Session, project_id: int) -> set[int]:
    """이미 저장된 병합 PR 번호.

    payload 를 파이썬에서 읽습니다. JSON 경로 질의는 SQLite 와 PostgreSQL
    에서 문법이 갈리고, **한쪽에서만 도는 질의는 다른 쪽에서 조용히 빈
    집합을 줍니다** — 그러면 백필이 전부 중복으로 들어옵니다.

    행 수는 저장소 하나의 병합 PR 수라 파이썬에서 훑어도 괜찮습니다.
    """
    rows = session.scalars(
        select(m.GithubEvent).where(
            m.GithubEvent.project_id == project_id,
            m.GithubEvent.event_type == "pull_request.merged",
        )
    ).all()

    numbers: set[int] = set()
    for row in rows:
        number = ((row.payload or {}).get("pull_request") or {}).get("number")
        if isinstance(number, int):
            numbers.add(number)
    return numbers


def _store_one(
    session: Session,
    project: m.Project,
    pull: bf.PullRequestSummary,
) -> m.GithubEvent | None:
    """PR 하나를 웹훅과 같은 모양으로 저장한다. 이미 있으면 None."""
    repo = project.github_repo or ""
    delivery_id = bf.delivery_id_for(repo, pull.number)

    payload = bf.to_webhook_payload(pull, repo=repo)
    normalized = webhook.normalize("pull_request", delivery_id, payload)
    if normalized is None:
        # 병합 안 된 것. `plan` 이 걸렀어야 하지만 두 겹으로 막습니다.
        return None

    exists = session.scalar(
        select(m.GithubEvent.id).where(
            m.GithubEvent.repo == normalized.repo,
            m.GithubEvent.event_type == normalized.event_type,
            m.GithubEvent.delivery_id == normalized.delivery_id,
        )
    )
    if exists:
        return None

    actor_user_id = session.scalar(
        select(m.Member.user_id).where(
            m.Member.project_id == project.id,
            m.Member.github_login == normalized.actor_login,
        )
    )

    row = m.GithubEvent(
        project_id=project.id,
        delivery_id=normalized.delivery_id,
        repo=normalized.repo,
        event_type=normalized.event_type,
        actor_login=normalized.actor_login,
        actor_user_id=actor_user_id,
        ref=normalized.ref,
        payload=normalized.payload,
        occurred_at=normalized.occurred_at,
    )
    session.add(row)
    session.flush()
    return row


def run_backfill(
    session: Session,
    client: GitHubClient,
    *,
    project_id: int,
    limit: int | None = None,
    since: datetime | None = None,
    now: datetime | None = None,
) -> BackfillResult:
    """연결 전의 병합 PR 을 채운다.

    `since` 를 안 주면 **이 프로젝트가 지난번에 훑은 지점**에서 이어갑니다.
    처음이면 전부입니다.
    """
    project = session.get(m.Project, project_id)
    if project is None:
        return BackfillResult(status="not_found")
    if not project.github_repo:
        return BackfillResult(status="no_repo", note="저장소가 연결되지 않았습니다.")

    repo = project.github_repo
    cap = bf.clamp_limit(limit)

    # 목록은 상한보다 넉넉히 받습니다 — 이미 있는 것과 병합 안 된 것이
    # 섞여 오므로, 딱 맞게 받으면 **건너뛴 만큼 덜 채웁니다.**
    listed = client.list_closed_pull_requests(repo, limit=min(cap * 2, bf.MAX_LIMIT))

    plan = bf.plan(
        list(listed),
        known_numbers=known_pull_request_numbers(session, project_id),
        since=since,
        limit=cap,
    )
    note = bf.describe(plan)
    logger.info("project=%s 백필 계획 — %s", project_id, note)

    stored = 0
    events_written = 0
    tasks_linked = 0
    failed = 0

    for pull in plan.fetch:
        row = _store_one(session, project, pull)
        if row is None:
            continue
        stored += 1

        # 업무 연결은 API 도 자격 증명도 필요 없습니다. 아래 상세 조회가
        # 실패해도 **이건 남아야** 합니다 — 그래서 먼저 합니다.
        tasks_linked += len(task_link_service.link_pull_request(session, row))

        try:
            outcome = github_ingest_service.ingest_merged_pull_request(
                session,
                client,
                project_id=project_id,
                repo=repo,
                number=pull.number,
            )
            events_written += int(outcome.get("written", 0))
        except GitHubError as exc:
            # ⚠️ 하나가 실패해도 나머지를 계속합니다. 여기서 던지면 지금까지
            # 채운 것이 통째로 롤백되고, 다시 실행해도 같은 PR 에서 또
            # 멈춥니다. 실패 건수는 결과에 실어 보냅니다.
            failed += 1
            logger.warning(
                "project=%s %s#%s 상세 조회 실패: %s",
                project_id,
                repo,
                pull.number,
                exc,
            )

    # ── 어디까지 훑었는지 기록 ────────────────────────────────
    #
    # ⚠️ **잘렸으면 기록하지 않습니다.** 잘린 지점을 "여기까지 훑었다" 로
    # 적으면 다음 실행이 그 앞을 안 봅니다 — 못 가져온 구간이 영구히
    # 빈 채로 굳습니다.
    stamped = now or datetime.now(UTC)
    project.github_backfilled_at = stamped
    if not plan.truncated:
        oldest = plan.covered_since
        current = project.github_backfilled_to
        # 더 오래된 쪽으로만 넓힙니다. 좁히면 이미 채운 구간을 안 채운
        # 것으로 만들고, 화면이 사실보다 나쁘게 말합니다.
        if oldest is not None and (current is None or oldest < current):
            project.github_backfilled_to = oldest
        elif oldest is None and current is None:
            # 가져올 것이 없었습니다 — 그것도 "훑었다" 입니다.
            project.github_backfilled_to = stamped
    session.flush()

    return BackfillResult(
        status="ok",
        listed=len(listed),
        stored=stored,
        events_written=events_written,
        tasks_linked=tasks_linked,
        already_have=plan.already_have,
        failed=failed,
        truncated=plan.truncated,
        covered_since=plan.covered_since,
        note=note,
    )
