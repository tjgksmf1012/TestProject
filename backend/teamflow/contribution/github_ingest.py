"""GitHub 활동 → 기여 이벤트 정규화.

docs/03-시스템-아키텍처.md §4, docs/05-기여도-산정-설계.md §2.1

핵심 규칙: **커밋은 세지 않는다.** 병합된 PR만 센다.
커밋은 쪼개기가 너무 쉬워서 지표가 될 수 없다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from teamflow.contribution.diff_filter import ChangedFile, DiffSummary, summarize_diff
from teamflow.contribution.events import ContributionEvent, EventType, SourceKind

# 리뷰가 "실질적"이라고 인정되는 최소 코멘트 수.
# 승인 버튼만 누른 것은 리뷰로 세지 않는다.
MIN_SUBSTANTIVE_COMMENTS = 1


@dataclass(frozen=True, slots=True)
class Review:
    reviewer_id: int
    submitted_at: datetime
    comment_count: int = 0
    state: str = "COMMENTED"  # APPROVED | CHANGES_REQUESTED | COMMENTED

    @property
    def is_substantive(self) -> bool:
        return self.comment_count >= MIN_SUBSTANTIVE_COMMENTS


@dataclass(frozen=True, slots=True)
class PullRequest:
    id: int
    number: int
    author_id: int
    merged_at: datetime | None
    files: list[ChangedFile] = field(default_factory=list)
    reviews: list[Review] = field(default_factory=list)
    closes_issue_ids: list[int] = field(default_factory=list)

    @property
    def is_merged(self) -> bool:
        return self.merged_at is not None

    @property
    def external_reviewers(self) -> set[int]:
        """작성자 본인을 제외한 리뷰어."""
        return {r.reviewer_id for r in self.reviews if r.reviewer_id != self.author_id}

    @property
    def was_reviewed(self) -> bool:
        """남이 실질적으로 리뷰했는가. 셀프 머지와 구분한다."""
        return any(
            r.is_substantive and r.reviewer_id != self.author_id for r in self.reviews
        )


def reviews_to_events(
    reviews: list[Review],
    *,
    pr_id: int,
    pr_number: int,
    author_id: int | None,
) -> list[ContributionEvent]:
    """리뷰들을 기여 이벤트로. **남에게 준 리뷰만** 센다.

    ⚠️ `author_id` 가 `None` 일 수 있습니다 (결함 62). 작성자를 팀원에게
    붙이지 못한 PR — 외부 기여자나 봇 — 이 그렇습니다. 그때도 **우리
    팀원이 준 리뷰는 그 사람의 기여**입니다. 예전에는 이 루프가
    `pr_to_events` 안에만 있어서, 작성자를 못 붙이면 리뷰까지 통째로
    사라졌습니다.

    작성자가 `None` 이면 자기 리뷰 제외 규칙은 아무도 걸러내지 않습니다 —
    작성자를 모르는데 "작성자 본인" 을 가려낼 수는 없고, 그 로그인이
    팀원에 없다는 것은 리뷰어로도 못 붙는다는 뜻이므로 안전합니다.
    """
    events: list[ContributionEvent] = []
    for review in reviews:
        if author_id is not None and review.reviewer_id == author_id:
            continue
        if not review.is_substantive:
            continue
        events.append(
            ContributionEvent(
                user_id=review.reviewer_id,
                event_type=EventType.REVIEW_GIVEN,
                occurred_at=review.submitted_at,
                source_kind=SourceKind.GITHUB_EVENT,
                # PR id 와 리뷰어 id 를 조합해 유일 키를 만든다.
                # 같은 사람이 한 PR에 여러 번 리뷰해도 한 번만 센다.
                #
                # ⚠️ 이 식이 **두 경로에서 같아야** 합니다. 나중에 작성자가
                # 로그인을 등록해 그 PR 이 다시 처리되면, 같은 리뷰가 같은
                # source_id 로 와서 `persist_events` 가 막아 줍니다.
                source_id=pr_id * 100_000 + review.reviewer_id,
                magnitude=float(review.comment_count),
                metadata={"pr_number": pr_number, "state": review.state},
            )
        )
    return events


def pr_to_events(pr: PullRequest) -> list[ContributionEvent]:
    """병합된 PR 하나를 기여 이벤트들로 변환한다.

    병합되지 않은 PR은 이벤트를 만들지 않는다 — 열기만 하면 점수가 오르는 것을 막는다.
    """
    if not pr.is_merged:
        return []
    assert pr.merged_at is not None

    summary: DiffSummary = summarize_diff(pr.files)
    events: list[ContributionEvent] = []

    # 실질 변경이 0이면 PR 자체를 세지 않는다.
    # (lock 파일만 고친 PR, 전체 재포맷 PR 등)
    if summary.meaningful_lines > 0:
        events.append(
            ContributionEvent(
                user_id=pr.author_id,
                event_type=EventType.PR_MERGED,
                occurred_at=pr.merged_at,
                source_kind=SourceKind.GITHUB_EVENT,
                source_id=pr.id,
                magnitude=float(summary.meaningful_lines),
                metadata={
                    "pr_number": pr.number,
                    "reviewed": pr.was_reviewed,
                    "has_tests": summary.has_tests,
                    # 점수 계산에는 이쪽을 쓴다. 사소한 변경이 감쇠된 값.
                    "weighted_lines": summary.weighted_lines,
                    "test_lines": summary.test_lines,
                    "counted_files": summary.counted_files,
                    "excluded_files": summary.excluded_files,
                    "trivial_files": summary.trivial_files,
                },
            )
        )

    events.extend(
        reviews_to_events(
            pr.reviews, pr_id=pr.id, pr_number=pr.number, author_id=pr.author_id
        )
    )

    # PR이 이슈를 닫았다면 해결로 기록
    for issue_id in pr.closes_issue_ids:
        events.append(
            ContributionEvent(
                user_id=pr.author_id,
                event_type=EventType.ISSUE_RESOLVED,
                occurred_at=pr.merged_at,
                source_kind=SourceKind.GITHUB_EVENT,
                source_id=issue_id,
                magnitude=1.0,
                metadata={"pr_number": pr.number},
            )
        )

    return events


def ingest_pull_requests(prs: list[PullRequest]) -> list[ContributionEvent]:
    events: list[ContributionEvent] = []
    for pr in prs:
        events.extend(pr_to_events(pr))
    return events
