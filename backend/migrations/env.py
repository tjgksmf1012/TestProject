"""Alembic 환경 설정.

DB URL은 alembic.ini 가 아니라 환경 변수 / 애플리케이션 설정에서 가져온다.
ini 파일에 접속 문자열을 박아두면 커밋에 비밀번호가 섞인다.
"""

from __future__ import annotations

import os
import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool

# backend/ 를 import 경로에 넣는다
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from teamflow.config import get_settings
from teamflow.db.models import Base

config = context.config

if config.config_file_name is not None:
    # ⚠️ `disable_existing_loggers` 를 반드시 False 로 둔다. 기본값은 True 다.
    #
    # `alembic upgrade` 를 **인프로세스로** 부르는 곳이 있다 (테스트,
    # 앱 기동 스크립트). 기본값이면 그 시점까지 만들어진 모든 로거가
    # `disabled=True` 로 영구히 꺼지고, `dictConfig(disable_existing_loggers=
    # False)` 로도 다시 켜지지 않는다.
    #
    # 이 저장소의 결함은 거의 전부 예외를 내지 않는다 — **로그가 유일한
    # 흔적**이다. 그 흔적을 마이그레이션 한 번이 통째로 꺼 버렸다. 실제로
    # pytest 에서 `test_migrations.py` 다음에 도는 모든 파일이 로그가 꺼진
    # 상태로 돌고 있었고, 로그 테스트 4개는 파일 이름 순서 덕분에 통과하고
    # 있었다.
    fileConfig(config.config_file_name, disable_existing_loggers=False)

# 우선순위: 환경 변수 > 애플리케이션 설정 기본값
config.set_main_option(
    "sqlalchemy.url",
    os.environ.get("DATABASE_URL") or get_settings().database_url,
)

target_metadata = Base.metadata


def _is_sqlite() -> bool:
    return config.get_main_option("sqlalchemy.url", "").startswith("sqlite")


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
        # SQLite는 ALTER 제약이 심해 배치 모드가 필요하다 (테스트 경로)
        render_as_batch=_is_sqlite(),
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            render_as_batch=connection.dialect.name == "sqlite",
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
