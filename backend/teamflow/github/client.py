"""GitHub API 클라이언트.

## 왜 필요한가 — 웹훅만으로는 부족합니다

`contribution/github_ingest.pr_to_events` 는 완성돼 있고 테스트도 있는데
**호출하는 곳이 0곳**이었습니다. 부를 수가 없었기 때문입니다.

    pr_to_events(pr)  ← pr.files (diff 전체)와 pr.reviews (코멘트 수)를 요구

그런데 `pull_request` 웹훅 페이로드에는 **둘 다 없습니다.** 파일 목록도,
리뷰 코멘트 수도 들어 있지 않습니다. 즉 `GET /repos/{}/pulls/{}/files` 와
`/reviews` 를 따로 불러야 합니다.

이게 없는 동안 이 프로젝트의 대표 주장 중 하나 — **"관련 PR 병합 → 기여도에
근거와 함께 반영"** — 은 코드상 어디서도 일어나지 않았습니다.

## 인증

GitHub App 입니다 (docs/03 §4.1). OAuth App 이 아닌 이유는 저장소 단위로
설치·회수되고 토큰이 짧게 만료되기 때문입니다.

    앱 개인키 → JWT(RS256, 10분) → 설치 액세스 토큰(1시간) → API 호출

`pyjwt[crypto]` 는 **이미 `pyproject.toml` 에 선언돼 있었습니다.** 이 경로를
만들려고 넣어 놓고 쓰지 않은 채로 있었습니다 — 이 저장소에서 반복되는
"만들어 놓고 안 이은" 것의 또 다른 형태입니다.

## ⚠️ 이 모듈은 이 환경에서 실측되지 않았습니다

GitHub App 자격 증명도 네트워크도 없습니다. 그래서 **HTTP 를 타지 않는
부분과 타는 부분을 갈라 놨습니다** — 응답을 도메인 객체로 옮기는 것은
`github/mapping.py` 의 순수 함수이고 테스트가 붙습니다. 여기 있는 것은
요청을 만들고 페이지를 넘기는 얇은 껍질입니다.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

logger = logging.getLogger(__name__)

API_ROOT = "https://api.github.com"
ACCEPT = "application/vnd.github+json"
API_VERSION = "2022-11-28"

# 앱 JWT 수명. GitHub 상한이 10분이고, 시계 오차를 감안해 9분으로 둡니다 —
# 상한을 그대로 쓰면 서버 시계가 조금만 빨라도 401 이 납니다.
APP_JWT_TTL = 9 * 60
# 설치 토큰은 1시간짜리입니다. 만료 직전에 쓰다 실패하지 않도록 미리 버립니다.
TOKEN_REFRESH_MARGIN = 5 * 60

# 한 PR 의 파일을 최대 몇 페이지까지 가져올 것인가.
# GitHub 은 PR 당 3000 파일까지 돌려주는데, 그만한 PR 의 diff 를 세는 건
# 의미가 없습니다 (대개 생성 코드나 vendor 디렉터리). 상한에 걸리면
# **조용히 자르지 않고 로그를 남깁니다.**
MAX_FILE_PAGES = 10
PER_PAGE = 100


class GitHubError(Exception):
    """호출자가 재시도할지 판단한다."""

    def __init__(self, message: str, *, status: int | None = None, retryable: bool = False):
        super().__init__(message)
        self.status = status
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class PullRequestDetails:
    """API 응답 중 기여도 계산에 필요한 것만.

    `github_ingest.PullRequest` 로 옮기는 것은 `mapping.py` 가 합니다 —
    거기서 GitHub 로그인을 팀원 user_id 로 바꿔야 하기 때문입니다.
    """

    id: int
    number: int
    author_login: str
    merged_at: str | None
    body: str | None = None
    files: list[dict[str, Any]] = field(default_factory=list)
    reviews: list[dict[str, Any]] = field(default_factory=list)
    review_comments: list[dict[str, Any]] = field(default_factory=list)
    closed_issue_ids: list[int] = field(default_factory=list)


class GitHubClient(Protocol):
    def pull_request_details(self, repo: str, number: int) -> PullRequestDetails: ...

    def list_closed_pull_requests(self, repo: str, *, limit: int) -> list[Any]: ...


class FakeGitHubClient:
    """테스트·시연용. 미리 넣어 둔 응답을 돌려준다.

    `meeting/llm.py` 의 `FakeLLMClient` 와 같은 자리입니다 — 네트워크 없이
    **그 뒤의 전 구간**을 실제로 돌려 보기 위한 것입니다.
    """

    def __init__(
        self,
        responses: dict[tuple[str, int], PullRequestDetails] | None = None,
        listings: dict[str, list[Any]] | None = None,
    ):
        self.responses = responses or {}
        self.listings = listings or {}
        self.calls: list[tuple[str, int]] = []
        self.list_calls: list[tuple[str, int]] = []

    def pull_request_details(self, repo: str, number: int) -> PullRequestDetails:
        self.calls.append((repo, number))
        try:
            return self.responses[(repo, number)]
        except KeyError as exc:
            raise GitHubError(f"준비된 응답이 없습니다: {repo}#{number}", status=404) from exc

    def list_closed_pull_requests(self, repo: str, *, limit: int) -> list[Any]:
        self.list_calls.append((repo, limit))
        return list(self.listings.get(repo, []))[:limit]


class HttpGitHubClient:
    """실제 GitHub API.

    ⚠️ 이 클래스는 이 환경에서 실행된 적이 없습니다. 자격 증명과 네트워크가
    없습니다. 요청 형태와 오류 분류는 문서 기준으로 작성했고, 실제 머신에서
    확인해야 합니다.
    """

    def __init__(
        self,
        *,
        app_id: str,
        private_key: str,
        installation_id: int,
        api_root: str = API_ROOT,
        timeout: float = 10.0,
        now: object = time.time,
    ):
        self._app_id = app_id
        self._private_key = private_key
        self._installation_id = installation_id
        self._api_root = api_root.rstrip("/")
        self._timeout = timeout
        self._now = now
        self._token: str | None = None
        self._token_expires_at = 0.0

    # ── 인증 ──────────────────────────────────────────────

    def _app_jwt(self) -> str:
        # import 를 함수 안에 두는 이유: `pyjwt` 가 없어도 이 모듈을 import 할
        # 수 있어야 합니다. FakeGitHubClient 만 쓰는 경로(테스트·시연)에서는
        # 서명이 필요 없습니다.
        import jwt

        issued = int(self._now()) - 60  # 시계가 빨라도 "미래 발급" 이 안 되게
        return jwt.encode(
            {"iat": issued, "exp": issued + APP_JWT_TTL, "iss": self._app_id},
            self._private_key,
            algorithm="RS256",
        )

    def _installation_token(self) -> str:
        if self._token and self._now() < self._token_expires_at - TOKEN_REFRESH_MARGIN:
            return self._token

        url = f"{self._api_root}/app/installations/{self._installation_id}/access_tokens"
        response = httpx.post(
            url,
            headers={
                "Authorization": f"Bearer {self._app_jwt()}",
                "Accept": ACCEPT,
                "X-GitHub-Api-Version": API_VERSION,
            },
            timeout=self._timeout,
        )
        if response.status_code != 201:
            raise _classify(response, "설치 토큰을 받지 못했습니다")

        body = response.json()
        self._token = body["token"]
        # 만료 시각은 ISO 문자열로 옵니다. 파싱이 실패해도 요청을 죽이지
        # 않고 보수적으로 짧게 잡습니다 — 다음 호출에서 다시 받으면 됩니다.
        self._token_expires_at = self._now() + 3600
        return self._token

    def _get(self, path: str, params: dict[str, Any] | None = None) -> httpx.Response:
        response = httpx.get(
            f"{self._api_root}{path}",
            params=params,
            headers={
                "Authorization": f"Bearer {self._installation_token()}",
                "Accept": ACCEPT,
                "X-GitHub-Api-Version": API_VERSION,
            },
            timeout=self._timeout,
        )
        if response.status_code >= 400:
            raise _classify(response, f"GET {path} 실패")
        return response

    # ── 조회 ──────────────────────────────────────────────

    def pull_request_details(self, repo: str, number: int) -> PullRequestDetails:
        pr = self._get(f"/repos/{repo}/pulls/{number}").json()

        return PullRequestDetails(
            id=pr["id"],
            number=pr["number"],
            author_login=(pr.get("user") or {}).get("login", ""),
            merged_at=pr.get("merged_at"),
            body=pr.get("body"),
            files=self._paged(f"/repos/{repo}/pulls/{number}/files"),
            reviews=self._paged(f"/repos/{repo}/pulls/{number}/reviews"),
            review_comments=self._paged(f"/repos/{repo}/pulls/{number}/comments"),
        )

    def list_closed_pull_requests(self, repo: str, *, limit: int) -> list[Any]:
        """닫힌 PR 목록. 백필이 "무엇이 있었는가" 를 알아내는 유일한 길입니다.

        ⚠️ **`state=closed` 이지 `state=merged` 가 아닙니다.** GitHub 에는
        merged 필터가 없습니다. 닫히기만 하고 병합 안 된 것이 섞여 오므로
        `merged_at` 이 있는 것만 골라야 합니다 — 안 고르면 **거절된 PR 이
        기여가 됩니다.** 거르는 것은 `backfill.plan` 이 합니다.

        ⚠️ 정렬을 `updated` 로 겁니다. `created` 로 걸면 오래된 PR 에 최근
        댓글이 달려도 뒤로 밀려 나가고, `merged_at` 순서와도 어긋납니다.
        어차피 `backfill.plan` 이 병합 시각으로 다시 정렬하지만, 상한에
        걸릴 때 **어떤 것이 후보에 들어오는지**가 여기서 정해집니다.
        """
        from teamflow.github.backfill import PullRequestSummary

        rows: list[dict[str, Any]] = []
        pages = max(1, min(MAX_FILE_PAGES, -(-limit // PER_PAGE)))
        for page in range(1, pages + 1):
            batch = self._get(
                f"/repos/{repo}/pulls",
                {
                    "state": "closed",
                    "sort": "updated",
                    "direction": "desc",
                    "per_page": PER_PAGE,
                    "page": page,
                },
            ).json()
            rows.extend(batch)
            if len(batch) < PER_PAGE:
                break
            if len(rows) >= limit:
                break

        summaries: list[Any] = []
        for row in rows[:limit]:
            merged_at = _parse_iso(row.get("merged_at"))
            summaries.append(
                PullRequestSummary(
                    number=row.get("number", 0),
                    merged_at=merged_at,
                    author_login=(row.get("user") or {}).get("login", ""),
                    title=row.get("title") or "",
                    body=row.get("body"),
                    head_ref=(row.get("head") or {}).get("ref"),
                )
            )
        return summaries

    def _paged(self, path: str) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for page in range(1, MAX_FILE_PAGES + 1):
            batch = self._get(path, {"per_page": PER_PAGE, "page": page}).json()
            rows.extend(batch)
            if len(batch) < PER_PAGE:
                return rows

        # ⚠️ 잘랐다는 사실을 반드시 남깁니다. 조용히 자르면 그 PR 의 기여도가
        # 낮게 나오는데 아무도 이유를 모릅니다.
        logger.warning(
            "%s 가 %d 페이지를 넘어 잘렸습니다 — 이 PR 의 diff 집계는 불완전합니다",
            path,
            MAX_FILE_PAGES,
        )
        return rows


def _parse_iso(value: str | None) -> Any:
    """GitHub 의 `2026-05-01T12:00:00Z` → aware datetime. 못 읽으면 None.

    ⚠️ 여기서 예외를 던지면 **PR 하나의 이상한 값이 백필 전체를 죽입니다.**
    못 읽은 것은 "병합 안 됨" 으로 흘러가고, 그건 안 세는 쪽이라 안전합니다.
    """
    from datetime import datetime

    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        logger.warning("병합 시각을 읽지 못했습니다: %r", value)
        return None


def _classify(response: httpx.Response, message: str) -> GitHubError:
    """오류를 "다시 걸어볼 것" 과 "걸어봐야 소용없는 것" 으로 나눈다.

    구분하지 않으면 둘 중 하나가 됩니다 — 권한이 없는 저장소를 영원히
    재시도하거나, 잠깐의 rate limit 때문에 그 PR 의 기여를 영영 잃거나.
    """
    status = response.status_code

    # 403 + rate limit 헤더, 429 는 기다렸다 다시. 그냥 403 은 권한 문제다.
    rate_limited = status == 429 or (
        status == 403 and response.headers.get("x-ratelimit-remaining") == "0"
    )
    retryable = rate_limited or status >= 500

    return GitHubError(
        f"{message} (HTTP {status})",
        status=status,
        retryable=retryable,
    )


def build_client(settings: object, installation_id: int | None) -> GitHubClient | None:
    """설정에서 클라이언트를 만든다. 쓸 수 없으면 None.

    None 을 돌려주는 게 중요합니다 — GitHub 을 연결하지 않은 팀도 이 시스템을
    써야 하고, 그때 웹훅 경로가 예외로 죽으면 안 됩니다.

    `installation_id` 를 인자로 받는 이유: **설치는 프로젝트마다 다릅니다.**
    앱 하나가 여러 팀의 저장소에 설치되고, 토큰은 설치 단위로 발급됩니다.
    설정에 하나만 박아 두면 두 번째 팀부터 남의 저장소 토큰으로 조회하거나
    404 를 받습니다.
    """
    app_id = getattr(settings, "github_app_id", None)
    private_key = getattr(settings, "github_private_key", None)
    if not app_id or not private_key or not installation_id:
        return None
    return HttpGitHubClient(
        app_id=app_id, private_key=private_key, installation_id=installation_id
    )
