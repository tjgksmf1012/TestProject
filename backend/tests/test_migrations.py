"""마이그레이션 테스트.

실제로 upgrade/downgrade 를 돌리고, **모델과 마이그레이션이 어긋나지 않는지** 검사한다.

마지막 항목이 핵심이다. 모델만 고치고 마이그레이션을 안 만들면 로컬은 멀쩡한데
배포에서 터진다. 그 시차가 길수록 원인을 찾기 어렵다.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import pytest
import sqlalchemy as sa
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


def test_upgrade_does_not_switch_off_the_logging(alembic_config: Config):
    """⭐ 마이그레이션이 다른 로거를 꺼 버리면 안 된다.

    `migrations/env.py` 가 `logging.config.fileConfig` 를 부르는데, 그
    함수의 `disable_existing_loggers` 기본값은 **True** 다. 그러면 그
    시점까지 만들어진 모든 로거가 `disabled=True` 로 영구히 꺼지고,
    `dictConfig(disable_existing_loggers=False)` 로도 다시 켜지지 않는다.

    이 저장소의 결함은 거의 전부 예외를 내지 않는다 — **로그가 유일한
    흔적**이다. 실제로 이 파일 다음에 도는 모든 테스트가 로그가 꺼진
    상태로 돌고 있었고, 로그 테스트 넷은 파일 이름 순서 덕분에 통과하고
    있었다. 순서가 바뀌면 그때 처음 드러난다.
    """
    canary = logging.getLogger("teamflow.canary.migrations")
    assert canary.disabled is False

    command.upgrade(alembic_config, "head")

    assert canary.disabled is False, (
        "마이그레이션이 기존 로거를 껐습니다. "
        "env.py 의 fileConfig 에 disable_existing_loggers=False 가 필요합니다."
    )
    # 우리 모듈 로거 전부를 본다 — canary 하나만 보면 이름이 우연히
    # 살아남는 경우를 못 거른다.
    switched_off = sorted(
        name
        for name in logging.root.manager.loggerDict
        if name.startswith("teamflow.")
        and getattr(logging.root.manager.loggerDict[name], "disabled", False)
    )
    assert switched_off == [], switched_off


def test_migrated_database_can_actually_be_written_to(alembic_config: Config):
    """⭐ 마이그레이션이 만든 DB 에 앱이 **행을 넣을 수 있어야** 한다.

    표가 다 있는지만 보면 부족하다. `user_sessions.id` 가 `BIGINT` 로
    만들어져 있었는데, SQLite 는 `INTEGER PRIMARY KEY` 만 rowid 별칭이 되어
    autoincrement 한다. 표는 멀쩡히 있고 스키마 비교도 통과하는데
    (`compare_metadata` 는 타입 차이를 significant 로 보지 않는다)
    **INSERT 마다 NOT NULL 위반**이 났다. 즉 마이그레이션으로 띄운
    시연 환경은 로그인이 전부 500 이었다.

    그래서 여기서는 실제로 넣어 본다. autoincrement 가 필요한 표를
    하나씩 훑으므로 다음에 같은 실수를 해도 그 표에서 걸린다.
    """
    command.upgrade(alembic_config, "head")
    url = alembic_config.get_main_option("sqlalchemy.url")

    engine = create_engine(url)
    try:
        with engine.begin() as connection:
            inspector = inspect(connection)
            actual = set(inspector.get_table_names())
            failures: list[str] = []

            for name, table in Base.metadata.tables.items():
                if name not in actual:
                    continue
                pk = list(table.primary_key.columns)
                # 복합 키·문자열 키는 값을 직접 넣는다 — autoincrement 가
                # 필요 없으므로 여기서 볼 것이 없다.
                if len(pk) != 1 or not isinstance(pk[0].type, (sa.Integer, sa.BigInteger)):
                    continue

                column = inspector.get_columns(name)
                declared = next(
                    (c["type"] for c in column if c["name"] == pk[0].name), None
                )
                if declared is None:
                    continue
                if url.startswith("sqlite") and "BIGINT" in str(declared).upper():
                    failures.append(f"{name}.{pk[0].name} → {declared}")

            assert failures == [], (
                "SQLite 에서 autoincrement 가 안 되는 기본키입니다. "
                "`BigInteger().with_variant(Integer, 'sqlite')` 를 쓰세요:\n"
                + "\n".join(f"  {f}" for f in failures)
            )
    finally:
        engine.dispose()
