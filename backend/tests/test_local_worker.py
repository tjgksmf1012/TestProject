import importlib.util
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import create_engine, select

from teamflow.db import models as m
from teamflow.db import session as db
from teamflow.jobs.local_worker import recover_interrupted, run_once, worker_lease


def test_worker_process_crash_releases_exclusive_lease(tmp_path):
    spec = importlib.util.spec_from_file_location(
        "teamflow_test_watchdog", Path(__file__).resolve().parents[2] / "scripts/watchdog.py"
    )
    watchdog = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(watchdog)
    process = subprocess.Popen(
        [sys.executable, "-u", "-c",
         "import sys,time; from pathlib import Path; "
         "from teamflow.jobs.local_worker import worker_lease; "
         "lease=worker_lease(Path(sys.argv[1])); lease.__enter__(); "
         "print('locked',flush=True); time.sleep(30)", str(tmp_path)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        assert process.stdout.readline().strip() == "locked"
        with pytest.raises(OSError), worker_lease(tmp_path):
            pass
        watchdog.stop_process(process)
        with worker_lease(tmp_path):
            pass
    finally:
        if process.poll() is None:
            watchdog.stop_process(process)
        process.wait(timeout=5)


def test_local_worker_restart_preserves_queued_and_completed_jobs(tmp_path):
    engine = create_engine("sqlite://")
    m.Base.metadata.create_all(engine)
    db.configure(engine)
    with db.session_scope() as session:
        user = m.User(name="합성 사용자", email="worker@example.test")
        project = m.Project(title="워커 검사")
        session.add_all([user, project])
        session.flush()
        for status in ("processing", "queued", "confirmed"):
            session.add(
                m.Meeting(
                    project_id=project.id,
                    started_by=user.id,
                    started_at=datetime.now(UTC),
                    status=status,
                )
            )
    with worker_lease(tmp_path):
        assert recover_interrupted() == 1
        with pytest.raises(OSError), worker_lease(tmp_path):
            pass
        calls = []
        assert run_once(calls.append) == 2
        assert calls == [2]
    with db.session_scope() as session:
        assert list(session.scalars(select(m.Meeting.status).order_by(m.Meeting.id))) == [
            "failed",
            "queued",
            "confirmed",
        ]
    with worker_lease(tmp_path):
        assert recover_interrupted() == 0
    engine.dispose()
