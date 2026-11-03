from contextlib import contextmanager
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from teamflow.db import models as m
from teamflow.db import vocab
from teamflow.jobs import local_github
from teamflow.jobs.local_github import enqueue, recover, run_once


def test_local_jobs_survive_restart_and_retry_without_broker(tmp_path):
    enqueue("backfill", 3, 200, root=tmp_path)
    (tmp_path / "backfill-3.json").replace(tmp_path / "backfill-3.running")
    assert recover(tmp_path) == 1
    calls = []

    def fail_once(job):
        calls.append(job)
        raise ConnectionError("synthetic network failure")

    assert run_once(tmp_path, execute=fail_once, now=100)
    assert not run_once(tmp_path, execute=fail_once, now=101)
    assert len(calls) == 1
    assert run_once(tmp_path, execute=lambda job: {"status": "ok"}, now=221)
    assert not list(tmp_path.glob("*.json"))
    assert not list(tmp_path.glob("*.running"))


def test_request_during_processing_is_not_lost(tmp_path):
    enqueue("ingest", 7, root=tmp_path)

    def process(job):
        enqueue("ingest", 7, root=tmp_path)
        return {"status": "ok"}

    assert run_once(tmp_path, execute=process)
    assert (tmp_path / "ingest-7.json").exists()
    assert run_once(tmp_path, execute=lambda job: {"status": "ok"})
    assert not list(tmp_path.glob("*.json"))


@pytest.mark.parametrize("failed_operation", ["_write", "_return_pending"])
def test_retry_storage_failure_keeps_job_for_recovery(tmp_path, monkeypatch, failed_operation):
    enqueue("backfill", 3, 200, root=tmp_path)

    def storage_unavailable(*args):
        raise OSError("synthetic storage failure")

    with monkeypatch.context() as patch:
        patch.setattr(local_github, failed_operation, storage_unavailable)
        with pytest.raises(OSError, match="storage failure"):
            run_once(tmp_path, execute=lambda job: {"status": "failed"}, now=100)
    assert (tmp_path / "backfill-3.running").is_file()
    assert recover(tmp_path) == 1
    calls = []

    def complete(job):
        calls.append((job["kind"], job["id"], job["limit"]))
        return {"status": "ok"}

    assert run_once(tmp_path, execute=complete, now=221)
    assert calls == [("backfill", 3, 200)]
    assert not list(tmp_path.glob("*.running"))


def test_failed_atomic_write_preserves_pending_job_and_removes_temporary_file(
    tmp_path, monkeypatch
):
    enqueue("backfill", 3, 10, root=tmp_path)
    original = (tmp_path / "backfill-3.json").read_bytes()

    def no_disk_space(*args):
        raise OSError("synthetic disk full")

    monkeypatch.setattr(local_github.os, "fsync", no_disk_space)
    with pytest.raises(OSError, match="disk full"):
        enqueue("backfill", 3, 200, root=tmp_path)
    assert (tmp_path / "backfill-3.json").read_bytes() == original
    assert not list(tmp_path.glob("*.tmp"))


def test_worker_recovers_storage_failure_on_next_cycle_without_restart(tmp_path, monkeypatch):
    enqueue("backfill", 3, 200, root=tmp_path)
    monkeypatch.setattr(
        local_github, "get_settings", lambda: SimpleNamespace(local_processing=True)
    )
    monkeypatch.setattr(local_github, "queue_root", lambda: tmp_path)
    monkeypatch.setattr(local_github, "configure_logging", lambda: None)
    monkeypatch.setattr(local_github, "restore_missing_ingest", lambda root: 0)
    write = local_github._write
    attempts = []
    failed_write = False
    cycles = 0

    def execute(job):
        attempts.append(job["id"])
        return {"status": "failed" if len(attempts) == 1 else "ok"}

    def transient_storage_failure(path, job):
        nonlocal failed_write
        if not failed_write:
            failed_write = True
            raise OSError("synthetic temporary storage failure")
        write(path, job)

    def next_cycle(seconds):
        nonlocal cycles
        cycles += 1
        if cycles == 2:
            raise KeyboardInterrupt

    monkeypatch.setattr(local_github, "_execute", execute)
    monkeypatch.setattr(local_github, "_write", transient_storage_failure)
    monkeypatch.setattr(local_github.time, "sleep", next_cycle)
    with pytest.raises(KeyboardInterrupt):
        local_github.main()
    assert attempts == [3, 3]
    assert not list(tmp_path.glob("*.json"))
    assert not list(tmp_path.glob("*.running"))


def test_worker_restores_committed_pr_after_initial_queue_write_failed(tmp_path, monkeypatch):
    engine = create_engine("sqlite://")
    m.Base.metadata.create_all(engine)

    @contextmanager
    def isolated_session():
        with Session(engine) as session:
            yield session
            session.commit()

    with isolated_session() as session:
        linked = m.Project(title="검사", github_repo="team/repo", github_installation_id=77)
        unlinked = m.Project(title="미설치", github_repo="team/other")
        session.add_all([linked, unlinked])
        session.flush()
        rows = []
        for project, repo, completed in [
            (linked, "team/repo", False),
            (linked, "team/repo", True),
            (unlinked, "team/other", False),
            (linked, "team/old-repo", False),
        ]:
            row = m.GithubEvent(
                project_id=project.id,
                repo=repo,
                actor_login="synthetic-actor",
                event_type=str(vocab.GithubEventKind.PR_MERGED),
                payload={"pull_request": {"number": 1}, "_teamflow_ingested": completed},
                occurred_at=datetime.now(UTC),
            )
            session.add(row)
            rows.append(row)
        session.flush()
        pending_id = rows[0].id

    def no_disk_space(*args):
        raise OSError("synthetic disk full")

    with monkeypatch.context() as patch:
        patch.setattr(local_github, "_write", no_disk_space)
        with pytest.raises(OSError):
            enqueue("ingest", pending_id, root=tmp_path)
    attempted = []

    def execute(job):
        attempted.append(job["id"])
        return {"status": "ok"}

    def stop_after_cycle(seconds):
        raise KeyboardInterrupt

    monkeypatch.setattr(
        local_github, "get_settings", lambda: SimpleNamespace(local_processing=True)
    )
    monkeypatch.setattr(local_github, "queue_root", lambda: tmp_path)
    monkeypatch.setattr(local_github, "configure_logging", lambda: None)
    monkeypatch.setattr(local_github, "session_scope", isolated_session, raising=False)
    monkeypatch.setattr(local_github, "_execute", execute)
    monkeypatch.setattr(local_github.time, "sleep", stop_after_cycle)
    try:
        with pytest.raises(KeyboardInterrupt):
            local_github.main()
        assert attempted == [pending_id]
        assert not list(tmp_path.glob("*.json"))
    finally:
        engine.dispose()
