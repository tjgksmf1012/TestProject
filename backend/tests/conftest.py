"""테스트 픽스처와 팩토리."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from teamflow.contribution.confidence import CoverageStats
from teamflow.contribution.diff_filter import ChangedFile
from teamflow.contribution.events import ContributionEvent, EventType, SourceKind
from teamflow.contribution.github_ingest import PullRequest, Review
from teamflow.contribution.profiles import DEFAULT_PROFILES, Role

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
