import json
import sqlite3

import pytest

from teamflow.jobs.snapshot import create_snapshot, restore_snapshot, verify_snapshot


def test_snapshot_is_restorable_and_preserves_audio(tmp_path):
    database = tmp_path / "source.db"
    with sqlite3.connect(database) as db:
        db.execute("CREATE TABLE records (value TEXT)")
        db.execute("INSERT INTO records VALUES ('synthetic')")
    audio = tmp_path / "source-audio"
    audio.mkdir()
    (audio / "record.chunk").write_bytes(b"synthetic-audio")
    snapshot = tmp_path / "backup"
    assert create_snapshot(database, audio, snapshot)["verified"]
    with sqlite3.connect(database) as db:
        db.execute("UPDATE records SET value='later'")
    target = tmp_path / "restored.db"
    target_audio = tmp_path / "restored-audio"
    assert restore_snapshot(snapshot, target, target_audio)["restored"]
    with sqlite3.connect(target) as db:
        assert db.execute("SELECT value FROM records").fetchone() == ("synthetic",)
    assert (target_audio / "record.chunk").read_bytes() == b"synthetic-audio"
    with pytest.raises(ValueError, match="새 위치"):
        restore_snapshot(snapshot, target, target_audio)
    (snapshot / "audio/record.chunk").write_bytes(b"changed")
    with pytest.raises(ValueError, match="무결성"):
        verify_snapshot(snapshot)


def test_snapshot_rejects_escaping_manifest_before_restoring(tmp_path):
    snapshot = tmp_path / "backup"
    snapshot.mkdir()
    (snapshot / "manifest.json").write_text(
        json.dumps(
            {
                "version": 1,
                "files": {"../outside": "bad", "database.sqlite3": "bad"},
            }
        )
    )
    with pytest.raises(ValueError, match="경로"):
        restore_snapshot(snapshot, tmp_path / "new.db", tmp_path / "new-audio")
    assert not (tmp_path / "new.db").exists()
