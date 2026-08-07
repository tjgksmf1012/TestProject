"""GitHub 연결 — 배달을 증거로 삼는 쪽.

판단은 `teamflow/github/connection.py` 에 있습니다. 여기는 DB 를 읽고 쓰는
부분만 담당합니다.

**이 모듈의 한 문장** — 저장소를 적는 것은 *주장*이고, 서명된 배달이 오는
것이 *증거*입니다. 둘을 섞으면 아무것도 확인하지 않은 프로젝트가 연결된
것처럼 보입니다.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from teamflow.db import models as m
from teamflow.github.connection import (
    ConnectionFacts,
    NearMiss,
    looks_like_typo_of,
    repo_key,
)

#: 진단 화면에 보여 줄 오타 후보 수. 늘어놓으면 고르는 일이 사람에게 넘어갑니다.
MAX_NEAR_MISSES = 5


def find_project_for_repo(session: Session, repo: str) -> m.Project | None:
    """배달이 온 저장소로 프로젝트를 찾는다.

    ⚠️ **`github_repo` 로 찾으면 안 됩니다.** 대소문자가 하나만 달라도
    못 찾고, 배달은 오류 없이 사라집니다.
    """
    key = repo_key(repo)
    if key is None:
        return None
    return session.scalar(select(m.Project).where(m.Project.github_repo_key == key))


def record_delivery(
    session: Session,
    *,
    repo: str,
    installation_id: int | None,
    now: datetime | None = None,
) -> m.Project | None:
    """배달 하나가 도착했다는 사실을 기록한다.

    **저장할 만한 이벤트인지와 무관하게** 부릅니다. `ping` 도, 우리가 안
    쓰는 이벤트도 전부 "이 저장소에서 배달이 온다" 는 증거이기 때문입니다.
    특히 `ping` 은 App 을 설치하면 GitHub 이 **가장 먼저** 보내는 것이라,
    이걸 놓치면 방금 연결을 마친 팀에게도 "아직 아무것도 안 왔습니다" 가
    나갑니다.

    붙을 프로젝트가 있으면 그 프로젝트를 확인 상태로 만들고 돌려줍니다.
    없으면 흔적만 남기고 None 을 돌려줍니다.
    """
    at = now or datetime.now(UTC)
    project = find_project_for_repo(session, repo)
    if project is None:
        _remember_unlinked(session, repo=repo, now=at)
        return None

    # 서명이 검증된 배달입니다 — 이 저장소에 App 이 설치돼 있다는 뜻이고,
    # App 설치는 저장소 관리 권한이 있어야 할 수 있습니다.
    if project.github_verified_at is None:
        project.github_verified_at = at

    # 정식 표기로 맞춰 둡니다. 사람이 적은 표기가 대소문자만 다르면
    # 이 순간부터 GitHub 이 쓰는 이름이 화면에 보입니다.
    if project.github_repo != repo:
        project.github_repo = repo

    # ⚠️ 설치 id 는 **오직 여기서만** 채웁니다. 요청 본문으로 받으면 남의
    # 설치 id 를 적어 넣어 서버가 그 설치의 액세스 토큰을 발급하게 만들 수
    # 있습니다. 이 값은 서명이 검증된 본문에서 나온 것입니다.
    if installation_id:
        project.github_installation_id = installation_id

    return project


def _remember_unlinked(session: Session, *, repo: str, now: datetime) -> None:
    """어느 프로젝트에도 안 붙은 배달. **오타의 유일한 증거입니다.**

    저장소 이름과 횟수·시각만 남깁니다 — 본문도 작성자도 남기지 않습니다.
    우리 자료가 아닌 것을 보관할 근거가 없습니다.
    """
    key = repo_key(repo)
    if key is None:
        return

    row = session.scalar(
        select(m.GithubUnlinkedDelivery).where(m.GithubUnlinkedDelivery.repo_key == key)
    )
    if row is not None:
        row.delivery_count += 1
        row.last_seen_at = now
        row.repo = repo
        return

    try:
        # ⚠️ SAVEPOINT 안에서 넣습니다.
        #
        # 같은 저장소로 배달이 동시에 둘 오면 둘 다 새 행을 만들려 하고,
        # 유니크 제약이 한쪽을 막습니다. 그때 그냥 `session.rollback()` 을
        # 부르면 **이 요청에서 지금까지 한 일이 전부** 되돌아갑니다 —
        # 진단용 집계 한 건 때문에 배달 처리를 통째로 잃습니다.
        # SAVEPOINT 면 되돌아가는 것이 이 INSERT 하나뿐입니다.
        #
        # 한 건 덜 세는 것은 괜찮습니다. 이건 "이 이름으로 배달이 온다" 를
        # 보여 주기 위한 집계이고, 정확한 횟수가 목적이 아닙니다.
        with session.begin_nested():
            session.add(
                m.GithubUnlinkedDelivery(
                    repo_key=key,
                    repo=repo,
                    delivery_count=1,
                    first_seen_at=now,
                    last_seen_at=now,
                )
            )
    except IntegrityError:
        pass


def collect_facts(
    session: Session,
    project_id: int,
    *,
    app_credentials_present: bool,
    webhook_secret_present: bool,
) -> ConnectionFacts:
    """진단에 필요한 사실을 모은다."""
    project = session.get(m.Project, project_id)
    if project is None:
        return ConnectionFacts(
            app_credentials_present=app_credentials_present,
            webhook_secret_present=webhook_secret_present,
        )

    delivery_count = (
        session.scalar(
            select(func.count(m.GithubEvent.id)).where(
                m.GithubEvent.project_id == project_id
            )
        )
        or 0
    )
    last_delivery_at = session.scalar(
        select(func.max(m.GithubEvent.recorded_at)).where(
            m.GithubEvent.project_id == project_id
        )
    )
    actor_logins = frozenset(
        login
        for login in session.scalars(
            select(m.GithubEvent.actor_login)
            .where(m.GithubEvent.project_id == project_id)
            .distinct()
        )
        if login
    )

    members = session.execute(
        select(m.Member.github_login, m.User.name)
        .join(m.User, m.User.id == m.Member.user_id)
        .where(m.Member.project_id == project_id)
    ).all()
    member_logins = frozenset(login for login, _ in members if login)
    members_without_login = tuple(name for login, name in members if not login)

    return ConnectionFacts(
        repo=project.github_repo,
        verified_at=project.github_verified_at,
        app_credentials_present=app_credentials_present,
        webhook_secret_present=webhook_secret_present,
        last_delivery_at=last_delivery_at,
        delivery_count=delivery_count,
        member_logins=member_logins,
        members_without_login=members_without_login,
        actor_logins=actor_logins,
        near_misses=_near_misses(session, project.github_repo),
        backfilled_at=project.github_backfilled_at,
        backfilled_to=project.github_backfilled_to,
    )


def _near_misses(session: Session, claimed: str | None) -> tuple[NearMiss, ...]:
    """적어 둔 이름의 오타로 볼 만한, 안 붙은 배달들.

    ⚠️ 전부 보여 주면 **App 이 설치된 저장소 목록을 캐내는 도구**가 됩니다.
    걸러 내는 규칙과 그 이유는 `connection.looks_like_typo_of` 에 있습니다.
    """
    if not claimed:
        return ()

    rows = session.scalars(
        select(m.GithubUnlinkedDelivery).order_by(
            m.GithubUnlinkedDelivery.delivery_count.desc()
        )
    ).all()

    hits = [
        NearMiss(repo=row.repo, last_seen_at=row.last_seen_at, count=row.delivery_count)
        for row in rows
        if looks_like_typo_of(claimed, row.repo)
    ]
    return tuple(hits[:MAX_NEAR_MISSES])
