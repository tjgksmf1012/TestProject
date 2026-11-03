from datetime import UTC, datetime, timedelta

from sqlalchemy import create_engine, select

from teamflow.config import Settings
from teamflow.db import models as m
from teamflow.db import session as db
from teamflow.jobs import local_maintenance


def test_local_maintenance_purges_only_expired_or_finished_data(tmp_path, monkeypatch):
    engine = create_engine("sqlite://")
    m.Base.metadata.create_all(engine)
    db.configure(engine)
    monkeypatch.setattr(local_maintenance, "get_settings", lambda: Settings(
        _env_file=None, audio_storage_root=tmp_path,
    ))
    now = datetime.now(UTC)
    for name in ("old.chunk", "keep.chunk"):
        (tmp_path / name).write_bytes(b"synthetic-audio")
    with db.session_scope() as session:
        user = m.User(name="합성 사용자", email="synthetic@example.com")
        active = m.Project(title="진행 중", status="active")
        finished = m.Project(title="종료", status="finished")
        session.add_all([user, active, finished])
        session.flush()
        meeting = m.Meeting(project_id=active.id, started_by=user.id, started_at=now)
        session.add(meeting)
        session.flush()
        for project in (active, finished):
            session.add(m.Voiceprint(project_id=project.id, user_id=user.id, embedding=[0.1]))
        for name, days in (("old.chunk", -1), ("keep.chunk", 1)):
            session.add(m.AudioAsset(meeting_id=meeting.id, storage_key=name,
                                     encryption_key_id="synthetic",
                                     kind="raw", retention_until=now + timedelta(days=days)))
    first = local_maintenance.run_once()
    assert first["deleted"] == 1 and first["revoked"] == 1
    assert not (tmp_path / "old.chunk").exists()
    assert (tmp_path / "keep.chunk").exists()
    assert local_maintenance.run_once()["deleted"] == 0
    with db.session_scope() as session:
        prints = session.scalars(select(m.Voiceprint)).all()
        assert sum(bool(vp.embedding) for vp in prints) == 1
    engine.dispose()
