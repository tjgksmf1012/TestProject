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
