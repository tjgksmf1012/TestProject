"""테스트 픽스처와 팩토리."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import event
from sqlalchemy.engine import Engine

from teamflow.contribution.confidence import CoverageStats
from teamflow.contribution.diff_filter import ChangedFile
from teamflow.contribution.events import ContributionEvent, EventType, SourceKind
from teamflow.contribution.github_ingest import PullRequest, Review
from teamflow.contribution.profiles import DEFAULT_PROFILES, Role

# ══════════════════════════════════════════════════════════════
# SQLite 에서 외래키를 강제한다
# ══════════════════════════════════════════════════════════════
#
# SQLite 는 기본값이 **꺼짐**이다. 그래서 592개 테스트가 전부 참조 무결성이
# 없는 DB 에서 돌고 있었다 — 없는 user_id 를 넣어도 통과한다.
#
# 프로덕션은 PostgreSQL 이고 거기서는 강제된다. 즉 요청 본문의 id 를 그대로
# FK 컬럼에 쓰는 엔드포인트는 **테스트에서 200, 배포에서 500** 이 된다.
# 이 프로젝트에서 반복해서 나온 "테스트는 통과하는데 실제로는 안 되는"
# 부류이고, 이건 그 부류를 자동으로 잡는 그물이다.
#
# 여기서 깨지는 테스트가 곧 프로덕션에서 깨질 것들이다.


@event.listens_for(Engine, "connect")
def _enforce_sqlite_foreign_keys(dbapi_connection, _record) -> None:
    if type(dbapi_connection).__module__.startswith("sqlite3"):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


T0 = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)


def at(minutes: int = 0) -> datetime:
    return T0 + timedelta(minutes=minutes)


class Ids:
    """테스트 안에서 고유 ID를 발급한다. 중복 제거 로직에 걸리지 않게."""

    def __init__(self, start: int = 1) -> None:
        self._n = start

    def next(self) -> int:
        self._n += 1
        return self._n


@pytest.fixture
def ids() -> Ids:
    return Ids()


def code_file(name: str, body_lines: int, *, prefix: str = "line") -> ChangedFile:
    """실질 내용이 있는 코드 파일 변경을 만든다."""
    patch = f"@@ -0,0 +1,{body_lines} @@\n"
    patch += "\n".join(f"+    {prefix}_{i} = compute({i})" for i in range(body_lines))
    return ChangedFile(filename=name, status="added", additions=body_lines, patch=patch)


def reformat_file(name: str, body_lines: int) -> ChangedFile:
    """들여쓰기만 바꾼 변경. 실질 내용은 동일."""
    removed = "\n".join(f"-  value_{i} = f({i})" for i in range(body_lines))
    added = "\n".join(f"+    value_{i} = f({i})" for i in range(body_lines))
    patch = f"@@ -1,{body_lines} +1,{body_lines} @@\n{removed}\n{added}"
    return ChangedFile(
        filename=name,
        status="modified",
        additions=body_lines,
        deletions=body_lines,
        patch=patch,
    )


def lockfile(name: str = "package-lock.json", body_lines: int = 3000) -> ChangedFile:
    patch = f"@@ -1,1 +1,{body_lines} @@\n"
    patch += "\n".join(f'+    "dep_{i}": "1.0.{i}",' for i in range(body_lines))
    return ChangedFile(
        filename=name, status="modified", additions=body_lines, patch=patch
    )


def typo_file(name: str, index: int) -> ChangedFile:
    """오타 하나 고친 변경."""
    patch = (
        f"@@ -{index},1 +{index},1 @@\n"
        f"-# 이 함수는 사용자를 처리합니당 {index}\n"
        f"+# 이 함수는 사용자를 처리합니다 {index}\n"
    )
    return ChangedFile(
        filename=name, status="modified", additions=1, deletions=1, patch=patch
    )


def merged_pr(
    pr_id: int,
    author_id: int,
    files: list[ChangedFile],
    *,
    reviewers: list[int] | None = None,
    minutes: int = 0,
) -> PullRequest:
    reviews = [
        Review(reviewer_id=r, submitted_at=at(minutes), comment_count=2, state="APPROVED")
        for r in (reviewers or [])
    ]
    return PullRequest(
        id=pr_id,
        number=pr_id,
        author_id=author_id,
        merged_at=at(minutes),
        files=files,
        reviews=reviews,
    )


def utterance(
    user_id: int, kind: EventType, uid: int, *, minutes: int = 0, **meta: object
) -> ContributionEvent:
    return ContributionEvent(
        user_id=user_id,
        event_type=kind,
        occurred_at=at(minutes),
        source_kind=SourceKind.UTTERANCE,
        source_id=uid,
        magnitude=1.0,
        metadata=dict(meta),
    )


def task_done(
    user_id: int, tid: int, *, difficulty: int = 1, minutes: int = 0
) -> ContributionEvent:
    return ContributionEvent(
        user_id=user_id,
        event_type=EventType.TASK_COMPLETED,
        occurred_at=at(minutes),
        source_kind=SourceKind.TASK,
        source_id=tid,
        metadata={"difficulty": difficulty},
    )


def deadline(
    user_id: int, tid: int, kind: EventType, *, minutes: int = 0
) -> ContributionEvent:
    return ContributionEvent(
        user_id=user_id,
        event_type=kind,
        occurred_at=at(minutes),
        source_kind=SourceKind.TASK,
        source_id=tid,
    )


@pytest.fixture
def full_coverage() -> CoverageStats:
    """모든 데이터가 갖춰진 이상적 상태. 신뢰도 1.0."""
    return CoverageStats(
        meetings_total=10,
        meetings_recorded=10,
        utterances_total=100,
        utterances_speaker_certain=100,
        project_days=90,
        github_connected_days=90,
        peer_reviews_expected=4,
        peer_reviews_submitted=4,
    )


@pytest.fixture
def dev_profiles() -> dict[int, object]:
    return {
        1: DEFAULT_PROFILES[Role.DEVELOPER],
        2: DEFAULT_PROFILES[Role.DEVELOPER],
    }


# ══════════════════════════════════════════════════════════════
# 로그인 헬퍼
# ══════════════════════════════════════════════════════════════
#
# 인증이 생기기 전에는 HTTP 테스트가 `user_id` 를 요청 본문에 적었습니다.
# 그게 **정확히 고친 결함**이라, 테스트도 이제 로그인을 거쳐야 합니다.
#
# 비밀번호를 태우지 않고 세션을 직접 발급하는 이유: scrypt 는 일부러
# 느리게 만든 함수이고(16MiB), HTTP 테스트 수십 개가 매번 그걸 돌면
# 스위트가 눈에 띄게 느려집니다. 비밀번호 검증 경로는 `test_auth.py` 가
# 따로 잽니다 — 여기서 확인할 것은 **세션이 없으면 막히는가**입니다.


def login_as(client, user_id: int) -> str:
    """이 클라이언트를 이 사용자로 로그인시킨다. 토큰을 돌려준다."""
    from teamflow.db import session as db_session
    from teamflow.services import auth_service

    with db_session.session_scope() as session:
        token, _ = auth_service.issue_session(session, user_id=user_id)

    client.cookies.set(auth_service.COOKIE_NAME, token)
    return token


def logout(client) -> None:
    from teamflow.services import auth_service

    client.cookies.delete(auth_service.COOKIE_NAME)


# ══════════════════════════════════════════════════════════════
# 담당자 (`TASK-006`)
# ══════════════════════════════════════════════════════════════


def assign(session, task, *user_ids: int):
    """이 업무의 담당자를 이 사람들로 정한다.

    ⚠️ `m.Task(assignee_id=...)` 는 **없어졌습니다** — 담당자는 칸이 아니라
    표입니다(`task_assignees`). 검사에서 `m.TaskAssignee(...)` 를 직접
    만들지 말고 이걸 쓰십시오. 한 곳에 모아 두면 표가 또 바뀌어도 여기만
    고치면 됩니다.
    """
    from teamflow.db import assignees

    session.flush()  # task.id 확보
    assignees.replace(session, task.id, [uid for uid in user_ids if uid is not None])
    return task
