"""Redis가 없는 로컬 실행에서도 동의와 보존기간 정책을 실행합니다."""

from __future__ import annotations

import logging
import time
from datetime import UTC, datetime

from sqlalchemy import select

from teamflow.config import get_settings
from teamflow.db import models as m
from teamflow.db import vocab
from teamflow.db.session import session_scope
from teamflow.jobs import retention
from teamflow.logging_config import configure_logging
from teamflow.services import notification_service

logger = logging.getLogger(__name__)


def run_once() -> dict[str, int]:
    """만료·종료된 대상만 처리하며 반복 실행해도 중복 효과가 없습니다."""
    settings = get_settings()
    now = datetime.now(UTC)
    with session_scope() as session:
        purged = retention.purge_expired_audio(
            session, storage_root=settings.audio_storage_root, now=now,
        )
        revoked = retention.purge_revoked_voiceprints(session)
        for project_id in session.scalars(
            select(m.Project.id).where(m.Project.status == vocab.ProjectStatus.FINISHED)
        ).all():
            revoked += len(retention.revoke_project_voiceprints(
                session, project_id, now=now,
            ).revoked_voiceprints)
        notices = notification_service.announce_upcoming_meetings(session, now=now)
    result = {"deleted": len(purged.deleted_assets), "failed": len(purged.failed),
              "revoked": revoked, "notices": notices}
    logger.info("로컬 보존기간 점검: %s", result)
    return result


def main() -> None:
    configure_logging()
    while True:
        try:
            run_once()
        except Exception:
            logger.exception("로컬 유지보수 실패 — 다음 회차에 다시 시도합니다")
        time.sleep(300)


if __name__ == "__main__":
    main()
