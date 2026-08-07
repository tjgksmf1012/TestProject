"""GitHub 수집 태스크.

웹훅 **요청 안에서** API 를 부르지 않는 이유가 둘입니다.

  1. GitHub 은 웹훅 응답을 10초 안에 받기를 기대합니다. PR 파일이 수백 개면
     페이지를 여러 번 넘겨야 하고, 그 사이에 GitHub 이 배달을 실패로 보고
     재전송합니다.
  2. 실패했을 때 **다시 걸 수 있어야 합니다.** 웹훅 본문은 `GithubEvent` 로
     이미 저장돼 있으므로, 이 잡은 그 행 id 하나만 들고 다시 돌 수 있습니다.
"""

from __future__ import annotations

import logging

from celery import Task

from teamflow.config import get_settings
from teamflow.db import models as m
from teamflow.db.session import session_scope
from teamflow.github.client import GitHubError, build_client
from teamflow.services import github_ingest_service
from teamflow.tasks import app

logger = logging.getLogger(__name__)

# rate limit 은 보통 창이 끝나면 풀립니다. 회의 처리(30초)보다 길게 잡습니다.
RETRY_COUNTDOWN = 120
MAX_RETRIES = 5


@app.task(
    bind=True,
    name="teamflow.tasks.github_tasks.ingest_github_event_task",
    max_retries=MAX_RETRIES,
)
def ingest_github_event_task(self: Task, event_id: int) -> dict:
    """웹훅 이벤트 하나 → 기여 이벤트.

    자격 증명이 없으면 **조용히 건너뛰지 않고 상태로 알립니다.** GitHub 을
    연결하지 않은 팀도 이 시스템을 쓰므로 예외를 던지지는 않지만, 연결한 줄
    알았는데 안 된 경우와 구분되어야 합니다.
    """
    settings = get_settings()

    with session_scope() as session:
        row = session.get(m.GithubEvent, event_id)
        if row is None:
            return {"status": "not_found", "event_id": event_id}

        project = session.get(m.Project, row.project_id)
        installation_id = getattr(project, "github_installation_id", None)
        client = build_client(settings, installation_id)
        if client is None:
            logger.info(
                "project=%s 에 GitHub App 자격 증명 또는 설치 id 가 없어 "
                "기여 이벤트를 만들지 않습니다",
                row.project_id,
            )
            return {"status": "not_configured", "project_id": row.project_id}

        try:
            return github_ingest_service.ingest_github_event(session, client, event_id)
        except GitHubError as exc:
            if exc.retryable:
                raise self.retry(countdown=RETRY_COUNTDOWN, exc=exc) from exc
            # 권한 없음·삭제된 PR 등. 다시 걸어도 같은 결과라 여기서 끝냅니다.
            logger.warning("github_event=%s 를 처리할 수 없습니다: %s", event_id, exc)
            return {"status": "failed", "event_id": event_id, "error": str(exc)}
