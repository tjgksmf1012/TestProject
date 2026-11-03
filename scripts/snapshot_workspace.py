"""서버·워커를 멈춘 상태에서 사용하는 백업/새 위치 복원 CLI."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from sqlalchemy.engine import make_url

from teamflow.config import get_settings
from teamflow.jobs.snapshot import create_snapshot, restore_snapshot, verify_snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["backup", "verify", "restore"])
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("--database", type=Path)
    parser.add_argument("--audio-root", type=Path)
    args = parser.parse_args()
    if args.action == "verify":
        result = verify_snapshot(args.snapshot)
        print(json.dumps({"verified": True, "files": len(result["files"])}))
        return
    if args.action == "restore":
        if args.database is None or args.audio_root is None:
            parser.error("복원은 --database와 --audio-root에 새 위치를 명시해야 합니다")
        result = restore_snapshot(args.snapshot, args.database, args.audio_root)
    else:
        settings = get_settings()
        url = make_url(settings.database_url)
        if url.get_backend_name() != "sqlite" or not url.database or url.database == ":memory:":
            parser.error("이 도구는 로컬 SQLite 전용입니다. PostgreSQL은 pg_dump를 사용하세요")
        result = create_snapshot(
            args.database or Path(url.database), args.audio_root or settings.audio_storage_root,
            args.snapshot,
        )
    print(json.dumps(result))


if __name__ == "__main__":
    main()
