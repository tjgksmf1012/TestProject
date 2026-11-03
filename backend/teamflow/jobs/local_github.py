"""Redis 없는 실행의 GitHub 작업을 디스크에 남겨 재시작 뒤에도 처리합니다."""

from __future__ import annotations

import json
import logging
import os
import tempfile
import time
from contextlib import suppress
from pathlib import Path

from teamflow.config import get_settings
from teamflow.jobs.local_worker import worker_lease
from teamflow.logging_config import configure_logging

logger = logging.getLogger(__name__)
KINDS = {"ingest", "backfill"}


def queue_root() -> Path:
    return get_settings().audio_storage_root / ".github-jobs"


def _write(path: Path, job: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, suffix=".tmp", delete=False
        ) as handle:
            temporary = Path(handle.name)
            json.dump(job, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def enqueue(
    kind: str,
    identifier: int,
    limit: int | None = None,
    *,
    root: Path | None = None,
) -> str:
    if kind not in KINDS or not isinstance(identifier, int) or identifier <= 0:
        raise ValueError("지원하지 않는 GitHub 작업입니다")
    name = f"{kind}-{identifier}"
    _write(
        (root or queue_root()) / f"{name}.json", {"kind": kind, "id": identifier, "limit": limit}
    )
    return f"local-github-{name}"


def recover(root: Path) -> int:
    restored = 0
    for path in root.glob("*.running"):
        pending = path.with_suffix(".json")
        _return_pending(path, pending)
        restored += 1
    return restored


def _return_pending(running: Path, pending: Path) -> None:
    # 기존 최신 요청을 덮어쓰지 않으면서 완성된 파일만 원자적으로 노출합니다.
    with suppress(FileExistsError):
        os.link(running, pending)
    running.unlink()


def _execute(job: dict) -> dict:
    from teamflow.tasks.github_tasks import backfill_project_task, ingest_github_event_task

    if job["kind"] == "ingest":
        return ingest_github_event_task.run(job["id"])
    return backfill_project_task.run(job["id"], job["limit"])


def run_once(root: Path, *, execute=None, now: float | None = None) -> bool:
    at = time.time() if now is None else now
    for pending in sorted(root.glob("*.json"), key=lambda p: p.stat().st_mtime):
        running = pending.with_suffix(".running")
        pending.replace(running)
        try:
            job = json.loads(running.read_text(encoding="utf-8"))
            if job["kind"] not in KINDS or pending.stem != f"{job['kind']}-{int(job['id'])}":
                raise ValueError("작업 식별자가 올바르지 않습니다")
            if job.get("retry_at", 0) > at:
                _return_pending(running, pending)
                continue
        except (ValueError, KeyError, TypeError):
            running.replace(pending.with_suffix(".invalid"))
            logger.warning("손상된 로컬 GitHub 작업을 격리했습니다")
            continue
        try:
            result = (execute or _execute)(job)
            if result.get("status") in {"failed", "not_configured"} or result.get("failed", 0):
                raise RuntimeError("GitHub 수집이 완료되지 않았습니다")
        except Exception:
            logger.exception("GitHub 작업 실패 — 120초 뒤 재시도합니다")
            job["retry_at"] = at + 120
            _write(running, job)
            _return_pending(running, pending)
        else:
            running.unlink(missing_ok=True)
        return True
    return False


def main() -> None:
    if not get_settings().local_processing:
        raise SystemExit("LOCAL_PROCESSING=true인 로컬 실행에서만 시작합니다")
    configure_logging()
    root = queue_root()
    with worker_lease(root):
        while True:
            try:
                restored = recover(root)
                if restored:
                    logger.info("중단된 GitHub 작업 %s건 복구", restored)
                run_once(root)
            except Exception:
                logger.exception("로컬 GitHub 큐 조회 실패")
            time.sleep(1)


if __name__ == "__main__":
    main()
