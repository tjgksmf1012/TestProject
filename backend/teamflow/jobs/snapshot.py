"""로컬 SQLite와 오디오를 함께 백업하고 새 위치로 복원합니다.

오디오와 DB의 같은 시점을 보장하려면 쓰는 서버/워커를 멈춘 뒤 호출합니다.
설정·인증 정보는 수집하지 않으며 기존 복원 대상은 덮어쓰지 않습니다.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath


def _digest(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def _files(root: Path) -> list[Path]:
    result = []
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError("백업에 심볼릭 링크를 포함할 수 없습니다")
        if path.is_file() and path.name != ".teamflow-worker.lock":
            result.append(path)
    return sorted(result)


def create_snapshot(database: Path, audio_root: Path, destination: Path) -> dict:
    database, audio_root, destination = (
        path.resolve() for path in (database, audio_root, destination)
    )
    if not database.is_file() or not audio_root.is_dir():
        raise ValueError("백업할 DB 파일과 오디오 폴더가 필요합니다")
    if destination.exists() or destination.is_relative_to(audio_root):
        raise ValueError("백업 위치는 원본 오디오 밖의 새 폴더여야 합니다")
    destination.mkdir(parents=True)
    (destination / "audio").mkdir()
    with (
        sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as source,
        sqlite3.connect(destination / "database.sqlite3") as target,
    ):
        source.backup(target)
    for path in _files(audio_root):
        target = destination / "audio" / path.relative_to(audio_root)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
    manifest = {
        "version": 1,
        "created_at": datetime.now(UTC).isoformat(),
        "files": {
            path.relative_to(destination).as_posix(): _digest(path) for path in _files(destination)
        },
    }
    (destination / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    verify_snapshot(destination)
    return {"files": len(manifest["files"]), "verified": True}


def verify_snapshot(snapshot: Path) -> dict:
    snapshot = snapshot.resolve()
    manifest = json.loads((snapshot / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("version") != 1 or "database.sqlite3" not in manifest.get("files", {}):
        raise ValueError("지원하지 않는 백업 형식입니다")
    for name, digest in manifest["files"].items():
        relative = PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts or "\\" in name:
            raise ValueError("백업 파일 경로가 올바르지 않습니다")
        if name != "database.sqlite3" and not name.startswith("audio/"):
            raise ValueError("백업에 허용되지 않은 경로가 있습니다")
        path = snapshot / name
        if not path.resolve().is_relative_to(snapshot) or path.is_symlink():
            raise ValueError("백업 밖의 파일을 참조하고 있습니다")
        if not path.is_file() or _digest(path) != digest:
            raise ValueError(f"백업 무결성 검사 실패: {name}")
    actual = {p.relative_to(snapshot).as_posix() for p in _files(snapshot)}
    if actual != set(manifest["files"]) | {"manifest.json"}:
        raise ValueError("백업 파일 목록이 일치하지 않습니다")
    with sqlite3.connect((snapshot / "database.sqlite3").as_uri() + "?mode=ro", uri=True) as db:
        if db.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise ValueError("백업 DB 검사에 실패했습니다")
    return manifest


def restore_snapshot(snapshot: Path, database: Path, audio_root: Path) -> dict:
    manifest = verify_snapshot(snapshot)
    database, audio_root = database.resolve(), audio_root.resolve()
    if database.exists() or audio_root.exists() or database.is_relative_to(audio_root):
        raise ValueError("복원 대상 DB와 오디오 폴더는 모두 새 위치여야 합니다")
    database.parent.mkdir(parents=True, exist_ok=True)
    audio_root.mkdir(parents=True)
    with database.open("xb") as target, (snapshot / "database.sqlite3").open("rb") as source:
        shutil.copyfileobj(source, target)
    for name in manifest["files"]:
        if name.startswith("audio/"):
            target = audio_root / PurePosixPath(name).relative_to("audio")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(snapshot / name, target)
    return {"files": len(manifest["files"]), "restored": True}
