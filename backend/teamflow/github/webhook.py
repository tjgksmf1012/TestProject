"""GitHub 웹훅 수신 — 서명 검증과 이벤트 정규화.

docs/03-시스템-아키텍처.md §4

⚠️ **서명 검증이 없으면 누구나 가짜 이벤트를 주입할 수 있습니다.**
이 서비스에서 그건 곧 기여도 조작입니다. 아무나 "내가 PR 50개를 병합했다"고
POST 할 수 있게 됩니다. 검증은 선택이 아닙니다.
"""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

SIGNATURE_HEADER = "X-Hub-Signature-256"
EVENT_HEADER = "X-GitHub-Event"
DELIVERY_HEADER = "X-GitHub-Delivery"

# 이 서비스가 처리하는 이벤트. 나머지는 무시한다.
HANDLED_EVENTS = frozenset(
    {"pull_request", "pull_request_review", "pull_request_review_comment", "issues", "ping"}
)


class WebhookError(Exception):
    """서명 검증 실패 등 요청 자체가 잘못된 경우."""


def verify_signature(payload: bytes, signature: str | None, secret: str) -> None:
    """GitHub이 보낸 HMAC-SHA256 서명을 검증한다.

    Raises:
        WebhookError: 서명이 없거나 일치하지 않을 때.

    타이밍 공격을 막기 위해 ``hmac.compare_digest`` 를 쓴다.
    일반 ``==`` 비교는 앞부분부터 다르면 빨리 반환하므로 바이트를 하나씩 알아낼 수 있다.
    """
    if not secret:
        raise WebhookError("웹훅 시크릿이 설정되지 않았습니다")
    if not signature:
        raise WebhookError(f"{SIGNATURE_HEADER} 헤더가 없습니다")
    if not signature.startswith("sha256="):
        raise WebhookError("지원하지 않는 서명 형식입니다 (sha256= 필요)")

    expected = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    provided = signature.removeprefix("sha256=")

    if not hmac.compare_digest(expected, provided):
        raise WebhookError("서명이 일치하지 않습니다")


@dataclass(frozen=True, slots=True)
class NormalizedEvent:
    """DB의 github_events 한 행이 될 정규화된 이벤트."""

    delivery_id: str
    event_type: str
    repo: str
    actor_login: str
    ref: str | None
    occurred_at: datetime
    payload: dict[str, Any]


def _parse_time(value: str | None, *, fallback: datetime) -> datetime:
    if not value:
        return fallback
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return fallback


def normalize(
    event_type: str,
    delivery_id: str,
    body: dict[str, Any],
    *,
    received_at: datetime | None = None,
) -> NormalizedEvent | None:
    """웹훅 본문을 저장 가능한 형태로 정규화한다.

    처리 대상이 아니거나 의미 없는 액션이면 ``None`` 을 돌려준다.
    (예: PR이 열리기만 하고 병합되지 않은 것 — 열기만 해서는 기여가 아니다)
    """
    now = received_at or datetime.now(UTC)

    repo = (body.get("repository") or {}).get("full_name")
    if not repo:
        return None

    if event_type == "ping":
        return None

    if event_type not in HANDLED_EVENTS:
        return None

    if event_type == "pull_request":
        action = body.get("action")
        pr = body.get("pull_request") or {}
        # 병합된 것만 센다. 열기·닫기는 기여가 아니다. docs/05 §2.1
        if action != "closed" or not pr.get("merged"):
            return None
        return NormalizedEvent(
            delivery_id=delivery_id,
            event_type="pull_request.merged",
            repo=repo,
            actor_login=(pr.get("user") or {}).get("login", ""),
            ref=(pr.get("head") or {}).get("ref"),
            occurred_at=_parse_time(pr.get("merged_at"), fallback=now),
            payload=body,
        )

    if event_type in ("pull_request_review", "pull_request_review_comment"):
        review = body.get("review") or body.get("comment") or {}
        pr = body.get("pull_request") or {}
        if body.get("action") not in ("submitted", "created"):
            return None
        return NormalizedEvent(
            delivery_id=delivery_id,
            event_type="pull_request.review",
            repo=repo,
            actor_login=(review.get("user") or {}).get("login", ""),
            ref=(pr.get("head") or {}).get("ref"),
            occurred_at=_parse_time(
                review.get("submitted_at") or review.get("created_at"), fallback=now
            ),
            payload=body,
        )

    if event_type == "issues":
        if body.get("action") != "closed":
            return None
        issue = body.get("issue") or {}
        return NormalizedEvent(
            delivery_id=delivery_id,
            event_type="issues.closed",
            repo=repo,
            actor_login=(body.get("sender") or {}).get("login", ""),
            ref=None,
            occurred_at=_parse_time(issue.get("closed_at"), fallback=now),
            payload=body,
        )

    return None


# ── 업무 ↔ 코드 활동 연결은 `github/linking.py` 로 옮겼습니다 ──────
#
# 여기 `extract_task_refs(*texts)` 가 있었습니다. 호출자도 테스트도 0이었고,
# 그래서 **세 가지를 한꺼번에 틀리고 있다는 사실이 드러난 적이 없었습니다.**
#
#     extract_task_refs("2026-08-07 회의 정리")  → {2026}
#     extract_task_refs("1000-line refactor")   → {1000}
#     extract_task_refs("Closes #12")           → {12}   ← GitHub 이슈 번호
#     extract_task_refs("TASK-12")              → {12}   ← 우리 업무 번호
#
# 브랜치용 패턴(`숫자-`)을 자유 텍스트에도 적용해서 **날짜와 줄 수가 업무
# 번호**가 됐고, GitHub 이슈 번호와 우리 업무 번호가 **같은 집합에** 섞였습니다.
#
# 지운 이유: 남겨 두면 다음 사람이 이걸 부릅니다. 고친 것은
# `teamflow/github/linking.py` 에 있고 33개 테스트가 붙습니다.
