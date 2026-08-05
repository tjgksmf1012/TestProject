"""정기 유지보수 태스크.

보존기간 만료 삭제는 **법적 요구사항**이라 반드시 돌아야 한다 (docs/07 P5).
Celery beat 에 등록돼 있고, 실패하면 로그에 남는다.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlalchemy import select

from teamflow.config import get_settings
from teamflow.db import models as m
from teamflow.db.session import session_scope
from teamflow.jobs.retention import purge_expired_audio, revoke_project_voiceprints
from teamflow.tasks import app

logger = logging.getLogger(__name__)


@app.task(name="teamflow.tasks.maintenance.purge_expired_audio_task")
def purge_expired_audio_task(dry_run: bool = False) -> dict:
    """보존기간이 지난 오디오 원본을 지운다. 매일 04:00.

    전사 텍스트는 남긴다 — 회의록·기여도 근거로 계속 필요하다.
    """
    settings = get_settings()
    with session_scope() as session:
        report = purge_expired_audio(
            session, storage_root=settings.audio_storage_root, dry_run=dry_run
        )

    logger.info("보존기간 정리: %s", report.summary())
    if report.failed:
        logger.error("삭제 실패 %d건: %s", len(report.failed), report.failed)

    return {
        "deleted": len(report.deleted_assets),
        "freed_bytes": report.freed_bytes,
        "missing": len(report.missing_files),
        "failed": len(report.failed),
        "dry_run": dry_run,
    }


@app.task(name="teamflow.tasks.maintenance.revoke_finished_project_voiceprints_task")
def revoke_finished_project_voiceprints_task() -> dict:
    """종료된 프로젝트의 성문을 폐기한다.

    성문은 프로젝트 범위 한정 데이터다. 프로젝트가 끝났는데 남아 있으면
    목적 외 보관이 된다 (docs/07 §2.4).
    """
    revoked = 0
    with session_scope() as session:
        finished = session.scalars(
            select(m.Project.id).where(m.Project.status == "finished")
        ).all()
        for project_id in finished:
            report = revoke_project_voiceprints(session, project_id)
            revoked += len(report.revoked_voiceprints)

    logger.info("성문 폐기: %d건", revoked)
    return {"revoked": revoked}


@app.task(name="teamflow.tasks.maintenance.reconcile_github_task")
def reconcile_github_task(lookback_days: int = 7) -> dict:
    """웹훅 유실 대비 정합성 확인. 매일 05:00.

    웹훅은 유실될 수 있다. REST API로 최근 기간을 다시 훑어
    빠진 이벤트를 채운다. `delivery_id` 유니크 제약이 중복을 막아준다.

    ⚠️ GitHub App 자격증명이 필요해 이 개발 환경에서는 검증되지 않았습니다.
    """
    now = datetime.now(UTC)
    logger.info("GitHub 정합성 확인 시작 (최근 %d일, 기준 %s)", lookback_days, now)

    with session_scope() as session:
        linked = session.scalars(
            select(m.Project).where(m.Project.github_repo.isnot(None))
        ).all()
        repos = [p.github_repo for p in linked]

    # TODO: GitHub App 설치 토큰으로 REST API 백필.
    #       구현 전까지는 연결된 저장소 목록만 보고한다.
    logger.info("연결된 저장소 %d개: %s", len(repos), repos)
    return {"repos": len(repos), "backfilled": 0, "implemented": False}
