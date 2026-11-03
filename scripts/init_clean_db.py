#!/usr/bin/env python3
"""실제 팀 운영을 위한 깨끗한 초기 데이터베이스 생성기.

가짜 시연 계정(minsu, haneul 등), 더미 회의, 더미 업무, 하드코딩된 기여도 데이터를
일절 포함하지 않고, 데이터베이스 스키마와 기본 워크스페이스(프로젝트 1)만 깨끗하게 초기화합니다.
"""

from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime
from pathlib import Path

# backend 패키지 경로 추가
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from sqlalchemy import create_engine, select

from teamflow.config import get_settings
from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.projects import invites


def init_clean_db(database_url: str | None = None, reset: bool = False) -> None:
    url = database_url or get_settings().database_url
    engine = create_engine(url)
    m.Base.metadata.create_all(engine)
    db_session.configure(engine)

    with db_session.session_scope() as session:
        if reset:
            print("[초기화] 시연용 더미 데이터 정리 중...")
            for table in reversed(m.Base.metadata.sorted_tables):
                session.execute(table.delete())
            session.flush()

        proj = session.scalars(select(m.Project).where(m.Project.id == 1)).first()
        if proj is None:
            invite_code = invites.generate_code()
            proj = m.Project(
                id=1,
                title="TeamFlow 워크스페이스",
                started_at=datetime.now(UTC),
                invite_code=invite_code,
            )
            session.add(proj)
            session.flush()
            print(f"[초기화 완료] 깨끗한 워크스페이스 생성됨 (ID: 1, 초대코드: {invite_code})")
        else:
            print(f"[초기화 확인] 기존 워크스페이스(ID: 1, 초대코드: {proj.invite_code}) 유지됨.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="실사용을 위한 깨끗한 초기 DB 생성")
    parser.add_argument("--database-url", help="설정 대신 이 URL을 쓴다")
    parser.add_argument("--reset", action="store_true", help="기존 DB 데이터를 완전히 비우고 깨끗하게 초기화한다")
    args = parser.parse_args()
    init_clean_db(args.database_url, reset=args.reset)
