"""마이그레이션 테스트.

실제로 upgrade/downgrade 를 돌리고, **모델과 마이그레이션이 어긋나지 않는지** 검사한다.

마지막 항목이 핵심이다. 모델만 고치고 마이그레이션을 안 만들면 로컬은 멀쩡한데
배포에서 터진다. 그 시차가 길수록 원인을 찾기 어렵다.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, inspect

from teamflow.db.models import Base

REPO_ROOT = Path(__file__).resolve().parents[2]
ALEMBIC_INI = REPO_ROOT / "alembic.ini"


@pytest.fixture
def alembic_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    db_path = tmp_path / "migration-test.db"
    url = f"sqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", url)

    config = Config(str(ALEMBIC_INI))
    config.set_main_option("script_location", str(REPO_ROOT / "backend" / "migrations"))
    config.set_main_option("sqlalchemy.url", url)
    config.attributes["url"] = url
    return config


def _table_names(url: str) -> set[str]:
    engine = create_engine(url)
    try:
        return set(inspect(engine).get_table_names())
    finally:
        engine.dispose()


def test_upgrade_creates_all_tables(alembic_config: Config):
    command.upgrade(alembic_config, "head")
    tables = _table_names(alembic_config.get_main_option("sqlalchemy.url"))

    expected = set(Base.metadata.tables)
    missing = expected - tables
    assert not missing, f"마이그레이션이 만들지 않은 테이블: {sorted(missing)}"
    assert "alembic_version" in tables


def test_downgrade_removes_everything(alembic_config: Config):
    command.upgrade(alembic_config, "head")
    command.downgrade(alembic_config, "base")
    tables = _table_names(alembic_config.get_main_option("sqlalchemy.url"))
    assert tables == {"alembic_version"}, f"downgrade 후 남은 테이블: {sorted(tables)}"


def test_upgrade_downgrade_upgrade_is_repeatable(alembic_config: Config):
    """롤백 후 재배포가 가능해야 한다."""
    command.upgrade(alembic_config, "head")
    command.downgrade(alembic_config, "base")
    command.upgrade(alembic_config, "head")
    tables = _table_names(alembic_config.get_main_option("sqlalchemy.url"))
    assert set(Base.metadata.tables) <= tables


def test_models_and_migrations_are_in_sync(alembic_config: Config):
    """⭐ 모델을 고치고 마이그레이션을 안 만들면 여기서 실패한다.

    이게 없으면 로컬은 멀쩡한데 배포에서 "column does not exist" 가 난다.
    """
    command.upgrade(alembic_config, "head")

    url = alembic_config.get_main_option("sqlalchemy.url")
    engine = create_engine(url)
    try:
        with engine.connect() as connection:
            context = MigrationContext.configure(
                connection,
                opts={"compare_type": True, "render_as_batch": True},
            )
            diff = compare_metadata(context, Base.metadata)
    finally:
        engine.dispose()

    # SQLite는 일부 제약(CHECK, 서버 기본값 표현)을 그대로 반영하지 못해
    # 오탐이 난다. 테이블·컬럼 수준의 차이만 본다 — 진짜 잊어버린 마이그레이션은
    # 반드시 이 범주로 나타난다.
    significant = [
        d
        for d in diff
        if isinstance(d, tuple)
        and d[0] in ("add_table", "remove_table", "add_column", "remove_column")
    ]
    assert not significant, (
        "모델과 마이그레이션이 어긋났습니다. "
        "`alembic revision --autogenerate` 로 새 마이그레이션을 만드세요:\n"
        + "\n".join(f"  {d[0]}: {d[1:]}" for d in significant)
    )


def test_alembic_ini_has_no_hardcoded_credentials():
    """접속 문자열을 ini 에 박아두면 커밋에 비밀번호가 섞인다."""
    text = ALEMBIC_INI.read_text(encoding="utf-8")
    active = [
        line
        for line in text.splitlines()
        if line.strip().startswith("sqlalchemy.url") and not line.strip().startswith("#")
    ]
    assert not active, f"alembic.ini 에 접속 문자열이 있습니다: {active}"


def test_env_reads_database_url_from_environment(monkeypatch: pytest.MonkeyPatch):
    """DB URL은 환경 변수에서 온다."""
    env_path = REPO_ROOT / "backend" / "migrations" / "env.py"
    source = env_path.read_text(encoding="utf-8")
    assert 'os.environ.get("DATABASE_URL")' in source


def test_migration_creates_pgvector_extension():
    """반복 논의 탐지·화자 임베딩에 pgvector 가 필요하다 (docs/06 §5)."""
    versions = (REPO_ROOT / "backend" / "migrations" / "versions").glob("*.py")
    sources = [p.read_text(encoding="utf-8") for p in versions]
    assert any("CREATE EXTENSION IF NOT EXISTS vector" in s for s in sources)


@pytest.mark.skipif(
    os.environ.get("SKIP_PG_RENDER") == "1", reason="PostgreSQL 렌더링 검사 생략"
)
def test_postgresql_types_survive_variants(tmp_path: Path):
    """SQLite 변형 때문에 PostgreSQL 타입이 낮아지면 안 된다.

    with_variant 를 잘못 쓰면 프로덕션까지 JSON/TEXT 로 떨어질 수 있다.
    """
    from sqlalchemy.dialects import postgresql
    from sqlalchemy.schema import CreateTable

    ddl = "\n".join(
        str(CreateTable(t).compile(dialect=postgresql.dialect()))
        for t in Base.metadata.sorted_tables
    )
    assert "JSONB" in ddl
    assert "BIGINT[]" in ddl
    assert "INET" in ddl
    assert "BIGSERIAL" in ddl
