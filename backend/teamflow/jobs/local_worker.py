"""Redis 없이도 서버 재시작과 분리해 회의 큐를 처리하는 로컬 워커.

한 프로세스만 OS 파일 잠금을 쥐고 GPU 작업을 순서대로 실행합니다.
프로세스가 죽으면 잠금이 풀리고, 다음 기동은 중단된 작업을 재시도 가능하게 합니다.
"""

from __future__ import annotations

import logging
import os
import time
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import select

from teamflow.config import get_settings
from teamflow.db import models as m
from teamflow.db.session import session_scope
from teamflow.logging_config import configure_logging

logger = logging.getLogger(__name__)


@contextmanager
def worker_lease(root: Path):
    root.mkdir(parents=True, exist_ok=True)
    with (root / ".teamflow-worker.lock").open("a+b") as handle:
        handle.seek(0)
        if not handle.read(1):
            handle.write(b"1")
            handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def recover_interrupted() -> int:
    """로컬 전용 잠금을 획득한 뒤에만 호출합니다. 완료된 결과는 유지합니다."""
    with session_scope() as session:
        rows = session.scalars(
            select(m.Meeting).where(m.Meeting.status == m.MeetingStatus.PROCESSING)
        ).all()
        for meeting in rows:
            meeting.status = m.MeetingStatus.FAILED
        return len(rows)


def run_once(process=None) -> int | None:
    from teamflow.tasks.meeting_tasks import process_meeting_sync

    with session_scope() as session:
        meeting_id = session.scalar(
            select(m.Meeting.id)
            .where(m.Meeting.status == m.MeetingStatus.QUEUED)
            .order_by(m.Meeting.id)
            .limit(1)
        )
    if meeting_id is None:
        return None
    try:
        (process or process_meeting_sync)(meeting_id)
    except Exception:
        logger.exception("회의 %s 로컬 처리 실패", meeting_id)
    return meeting_id


def main() -> None:
    settings = get_settings()
    if not settings.local_processing:
        raise SystemExit("LOCAL_PROCESSING=true인 로컬 실행에서만 워커를 시작할 수 있습니다")
    configure_logging()
    with worker_lease(settings.audio_storage_root):
        logger.info("중단된 로컬 작업 %s건을 재시도 가능한 상태로 전환", recover_interrupted())
        while True:
            try:
                if run_once() is None:
                    time.sleep(1)
            except Exception:
                logger.exception("로컬 큐 조회 실패 — 다음 회차 재시도")
                time.sleep(3)


if __name__ == "__main__":
    main()
