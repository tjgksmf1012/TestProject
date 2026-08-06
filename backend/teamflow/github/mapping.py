"""GitHub API 응답 → 기여 이벤트 입력.

이 모듈에 HTTP 가 없습니다. `client.py` 가 받아 온 사전을 도메인 객체로
옮기기만 합니다 — 그래서 **네트워크 없이 전부 테스트됩니다.** 실제로 틀리기
쉬운 건 요청을 보내는 부분이 아니라 여기입니다:

  · 리뷰 코멘트 수를 어떻게 세는가 (승인 버튼만 누른 건 리뷰가 아니다)
  · GitHub 로그인을 어떤 팀원에게 붙이는가 (못 붙이면 어떻게 하는가)
  · 본문의 `Closes #12` 를 어떻게 읽는가
"""

from __future__ import annotations

import logging
import re
from datetime import UTC, datetime
from typing import Any

from teamflow.contribution.diff_filter import ChangedFile
from teamflow.contribution.github_ingest import PullRequest, Review
from teamflow.github.client import PullRequestDetails

logger = logging.getLogger(__name__)

# GitHub 이 인정하는 이슈 종료 키워드. 대소문자를 가리지 않습니다.
# https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue
_CLOSES = re.compile(
    r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s*#(\d+)",
    re.IGNORECASE,
)


def parse_time(value: str | None) -> datetime | None:
    """GitHub 의 ISO8601(`...Z`) 을 파싱한다.

    `Z` 를 파이썬 3.11 이전 `fromisoformat` 이 못 읽습니다. 3.11 부터는
    읽지만, 여기서 명시적으로 바꿔 두면 파이썬 버전에 안 걸립니다.
    실패하면 None — **오늘 날짜로 대체하지 않습니다.** 시각이 틀린 이벤트는
    잘못된 기간에 귀속되고, 그건 없는 것보다 나쁩니다.
    """
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        logger.warning("시각을 읽지 못했습니다: %r", value)
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def to_changed_files(rows: list[dict[str, Any]]) -> list[ChangedFile]:
    """`/pulls/{n}/files` 응답 → diff 필터 입력.

    `patch` 가 없는 경우가 정상입니다 — 파일이 너무 크거나 바이너리면
    GitHub 이 생략합니다. 그때 빈 문자열로 채우지 않습니다: 빈 patch 는
    "변경 없음" 으로 읽히는데 실제로는 "모른다" 입니다.
    """
    files: list[ChangedFile] = []
    for row in rows:
        filename = row.get("filename")
        if not filename:
            continue
        files.append(
            ChangedFile(
                filename=filename,
                status=row.get("status", "modified"),
                additions=int(row.get("additions") or 0),
                deletions=int(row.get("deletions") or 0),
                patch=row.get("patch"),
                previous_filename=row.get("previous_filename"),
            )
        )
    return files


def count_review_comments(
    reviews: list[dict[str, Any]], comments: list[dict[str, Any]]
) -> dict[int, int]:
    """리뷰 id → 그 리뷰에 달린 코멘트 수.

    ⭐ **승인 버튼만 누른 것을 리뷰로 세지 않기 위해 필요합니다**
    (`github_ingest.MIN_SUBSTANTIVE_COMMENTS`). 그런데 `/pulls/{n}/reviews`
    응답에는 코멘트 수가 없습니다 — `/pulls/{n}/comments` 를 따로 받아
    `pull_request_review_id` 로 묶어야 합니다.

    리뷰 본문(`body`)만 쓰고 인라인 코멘트가 없는 리뷰도 있습니다. 그건
    "실질적" 으로 셉니다 — 글로 의견을 남긴 것이므로 승인 클릭과 다릅니다.
    """
    counts: dict[int, int] = {}
    for comment in comments:
        review_id = comment.get("pull_request_review_id")
        if review_id is None:
            continue
        counts[int(review_id)] = counts.get(int(review_id), 0) + 1

    for review in reviews:
        review_id = review.get("id")
        if review_id is None:
            continue
        review_id = int(review_id)
        if counts.get(review_id):
            continue
        # 인라인 코멘트가 없어도 본문이 있으면 의견을 남긴 것이다.
        if (review.get("body") or "").strip():
            counts[review_id] = 1
    return counts


def parse_closing_issue_numbers(body: str | None) -> list[int]:
    """PR 본문에서 `Closes #12` 를 읽는다.

    ⚠️ 여기서 나오는 건 **저장소 안에서만 유일한 번호**이지 전역 id 가
    아닙니다. `pr_to_events` 는 이 값을 `source_id` 로 쓰는데, 그 컬럼의
    유일 키는 `(source_kind, source_id, event_type)` 이라 저장소가 둘이면
    **다른 저장소의 12번 이슈와 충돌합니다.**

    그래서 이 값은 `ingest_service` 가 전역 id 로 바꾼 뒤에야 쓰입니다.
    번호를 그대로 넘기지 마세요.
    """
    if not body:
        return []
    seen: list[int] = []
    for match in _CLOSES.finditer(body):
        number = int(match.group(1))
        if number not in seen:
            seen.append(number)
    return seen


def to_pull_request(
    details: PullRequestDetails,
    *,
    logins: dict[str, int],
    closed_issue_ids: list[int] | None = None,
) -> PullRequest | None:
    """API 응답 → `github_ingest.PullRequest`.

    작성자를 팀원에게 붙이지 못하면 **None 을 돌려줍니다.** 외부 기여자나
    봇의 PR 이 그렇습니다. 아무에게나 붙이거나 0번 사용자로 만들면 그게
    곧 잘못된 기여도입니다.

    `logins` 는 소문자 키로 받습니다 — GitHub 로그인은 대소문자를 보존하지만
    비교는 대소문자 무관이라, `MinSu` 로 등록해 두고 `minsu` 로 들어오면
    못 찾습니다.
    """
    merged_at = parse_time(details.merged_at)
    if merged_at is None:
        # 병합되지 않은 PR. `pr_to_events` 도 어차피 빈 목록을 돌려줍니다.
        return None

    author_id = logins.get((details.author_login or "").lower())
    if author_id is None:
        logger.info(
            "PR #%s 의 작성자 %r 를 팀원에게 연결하지 못해 건너뜁니다",
            details.number,
            details.author_login,
        )
        return None

    comment_counts = count_review_comments(details.reviews, details.review_comments)
    reviews: list[Review] = []
    for row in details.reviews:
        reviewer_login = ((row.get("user") or {}).get("login") or "").lower()
        reviewer_id = logins.get(reviewer_login)
        submitted_at = parse_time(row.get("submitted_at"))
        if reviewer_id is None or submitted_at is None:
            continue
        reviews.append(
            Review(
                reviewer_id=reviewer_id,
                submitted_at=submitted_at,
                comment_count=comment_counts.get(int(row.get("id") or 0), 0),
                state=row.get("state", "COMMENTED"),
            )
        )

    return PullRequest(
        id=int(details.id),
        number=int(details.number),
        author_id=author_id,
        merged_at=merged_at,
        files=to_changed_files(details.files),
        reviews=reviews,
        closes_issue_ids=list(closed_issue_ids or []),
    )
