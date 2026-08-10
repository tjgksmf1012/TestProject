"""연결 전의 GitHub 활동을 채운다 — 무엇을 가져올지 정하는 부분.

## 왜 필요한가

웹훅은 **연결한 순간부터** 옵니다. 그런데 팀은 대개 몇 주 코드를 짜다가
이 시스템을 붙입니다. 그러면 이런 일이 벌어집니다.

    3월~4월  PR 40개 병합          ← 기여도에 **없음**
    5월 1일  GitHub 연결
    5월~     PR 5개 병합           ← 기여도에 있음

진단 화면은 "연결됨" 이라고 말하고, 기여도 화면은 5건만 보여 줍니다.
**어디에도 오류가 없습니다.** 3월에 제일 많이 일한 사람이 가장 적게
일한 것으로 보이고, 본인도 왜 그런지 알 방법이 없습니다.

이 저장소가 반복해서 당한 부류 그대로입니다 — 오류 없이 기여도만 빕니다.

## 이 모듈이 정하는 것

무엇을 가져올지, 무엇을 건너뛸지, **어디서 잘렸는지**입니다. HTTP 도 DB 도
여기 없습니다. 그래서 네트워크 없이 전부 테스트할 수 있습니다.

## 세 가지를 조심합니다

**이미 있는 것을 다시 만들지 않습니다.** 백필과 웹훅은 같은 PR 을 두 번
가져올 수 있습니다. 기여 이벤트는 `persist_events` 가 막지만, 그 전에
`github_events` 행이 둘이 되면 업무 카드에 같은 PR 이 두 번 붙고 진단의
배달 수가 부풀려집니다.

**상한에 걸리면 반드시 말합니다.** 저장소가 크면 다 못 가져옵니다. 그때
조용히 자르면 "백필 했으니 이제 완전하다" 고 믿게 됩니다 — 백필을 안 한
것보다 나쁩니다. 안 한 줄 알면 최소한 의심은 하니까요.

**어디까지 훑었는지 기록합니다.** 이게 없으면 다음에 또 처음부터 훑습니다.
그리고 화면이 "언제 이후가 반영된 값인지" 말할 수 없습니다.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

#: 한 번에 가져올 PR 상한.
#:
#: ⚠️ 이 숫자는 성능이 아니라 **rate limit** 때문입니다. PR 하나에 API 를
#: 네 번 부릅니다 (본문·파일·리뷰·리뷰 코멘트). 설치 토큰은 시간당 5,000
#: 요청이므로 200건이면 800 요청 — 한 팀이 한 번 누르는 것으로는 안전하고,
#: 여러 팀이 동시에 눌러도 창 하나를 다 먹지 않습니다.
DEFAULT_LIMIT = 200

#: 상한의 상한. 화면이나 API 가 더 큰 값을 보내도 여기서 잘립니다.
MAX_LIMIT = 1000


@dataclass(frozen=True, slots=True)
class PullRequestSummary:
    """목록 조회로 알 수 있는 것만.

    상세(파일·리뷰)는 여기 없습니다. 그건 실제로 가져오기로 정한 PR 에
    대해서만 따로 부릅니다 — 건너뛸 것까지 상세를 부르면 rate limit 을
    건너뛰는 데 씁니다.
    """

    number: int
    merged_at: datetime | None
    author_login: str = ""
    title: str = ""
    body: str | None = None
    head_ref: str | None = None


@dataclass(frozen=True, slots=True)
class BackfillPlan:
    """무엇을 가져오고 무엇을 건너뛸 것인가."""

    fetch: tuple[PullRequestSummary, ...]
    #: 이미 `github_events` 에 있어서 건너뛴 것.
    already_have: int
    #: 병합되지 않아 건너뛴 것. 여는 것만으로는 기여가 아닙니다 (docs/05 §2.1).
    not_merged: int
    #: `since` 보다 오래되어 건너뛴 것.
    too_old: int
    #: ⚠️ 상한에 걸려 **못 가져온** 것이 남았는가.
    truncated: bool

    @property
    def covered_since(self) -> datetime | None:
        """이번에 가져오는 것 중 가장 오래된 병합 시각.

        ⚠️ `truncated` 면 이 값은 "여기까지만 봤다" 는 뜻이지
        "이 전에는 아무것도 없다" 는 뜻이 **아닙니다.**
        """
        times = [pr.merged_at for pr in self.fetch if pr.merged_at is not None]
        return min(times) if times else None


def clamp_limit(requested: int | None) -> int:
    """사람이나 API 가 준 상한을 안전한 범위로.

    상한이 없으면 저장소 하나가 rate limit 창을 통째로 먹고, 그동안 다른
    팀의 웹훅 처리가 전부 실패합니다.
    """
    if requested is None:
        return DEFAULT_LIMIT
    return max(1, min(int(requested), MAX_LIMIT))


def plan(
    listed: list[PullRequestSummary],
    *,
    known_numbers: set[int],
    since: datetime | None = None,
    limit: int | None = None,
) -> BackfillPlan:
    """가져올 목록을 정한다.

    **최신부터** 채웁니다. 상한에 걸려 일부만 가져올 때, 최근 것이 남는
    편이 낫습니다 — 지금 진행 중인 일이 기여도에 보이는 쪽이 먼저입니다.

    `since` 는 "이 시각 이후만" 입니다. 두 번째 백필에서 지난번에 훑은
    구간을 다시 안 훑으려고 씁니다.
    """
    cap = clamp_limit(limit)

    already_have = 0
    not_merged = 0
    too_old = 0
    fetch: list[PullRequestSummary] = []
    truncated = False

    # 최신 병합 순. 목록 API 의 정렬을 믿지 않습니다 — 정렬 파라미터가
    # 바뀌면 조용히 오래된 것부터 채우게 되고, 상한에 걸렸을 때 **최근
    # 활동이 통째로 빠집니다.**
    ordered = sorted(
        listed,
        key=lambda pr: (pr.merged_at is not None, pr.merged_at or datetime.min),
        reverse=True,
    )

    for pull in ordered:
        if pull.merged_at is None:
            not_merged += 1
            continue
        if since is not None and pull.merged_at <= since:
            too_old += 1
            continue
        if pull.number in known_numbers:
            already_have += 1
            continue
        if len(fetch) >= cap:
            # 여기서 멈추지만 **멈췄다는 사실을 들고 나갑니다.**
            truncated = True
            break
        fetch.append(pull)

    return BackfillPlan(
        fetch=tuple(fetch),
        already_have=already_have,
        not_merged=not_merged,
        too_old=too_old,
        truncated=truncated,
    )


def delivery_id_for(repo: str, number: int) -> str:
    """백필이 만든 이벤트의 배달 id.

    ⚠️ **결정적이어야 합니다.** 무작위로 만들면 백필을 두 번 돌릴 때
    `uq_github_delivery` 가 안 막아 주고, 같은 PR 의 행이 둘이 됩니다.

    `backfill:` 을 앞에 붙이는 이유: GitHub 의 진짜 배달 id 는 UUID 라
    절대 겹치지 않고, 로그에서 이 행이 웹훅이 아니라 백필에서 왔다는 것을
    바로 알 수 있습니다.
    """
    return f"backfill:{repo.strip().lower()}:{number}"


def is_backfilled(delivery_id: str | None) -> bool:
    return bool(delivery_id) and delivery_id.startswith("backfill:")


def to_webhook_payload(pull: PullRequestSummary, *, repo: str) -> dict:
    """목록 조회 결과를 **웹훅과 같은 모양**으로.

    ## 왜 웹훅 모양으로 맞추는가

    `task_link_service.link_pull_request` 와 `ingest_github_event` 가
    `payload["pull_request"]` 를 읽습니다. 백필이 다른 모양을 저장하면
    그 둘을 백필용으로 한 벌 더 만들어야 하고, 그러면 **웹훅에서 고친
    것이 백필에서는 안 고쳐집니다.**

    같은 모양으로 넣으면 그 뒤 경로가 통째로 재사용됩니다 — 백필로 들어온
    PR 도 업무 카드에 붙고, 기여 이벤트가 되고, 진단에 배달로 셉니다.
    """
    # ⚠️ `merged` 를 True 로 박아 두면 **병합되지 않은 PR 을 병합된 것으로
    # 만듭니다.** `plan` 이 먼저 거르지만, 거르는 쪽이 바뀌면 이 거짓이
    # 그대로 기여도가 됩니다. 여기서도 사실만 적습니다.
    merged = pull.merged_at is not None
    return {
        "action": "closed",
        "repository": {"full_name": repo},
        "pull_request": {
            "number": pull.number,
            "merged": merged,
            "merged_at": pull.merged_at.isoformat() if merged else None,
            "title": pull.title,
            "body": pull.body,
            "user": {"login": pull.author_login},
            "head": {"ref": pull.head_ref},
        },
    }


def describe(plan: BackfillPlan) -> str:
    """사람이 읽을 한 줄. 화면과 로그가 같은 문장을 씁니다."""
    parts = [f"가져올 PR {len(plan.fetch)}건"]
    if plan.already_have:
        parts.append(f"이미 있는 것 {plan.already_have}건")
    if plan.too_old:
        parts.append(f"기간 밖 {plan.too_old}건")
    if plan.not_merged:
        parts.append(f"병합 안 됨 {plan.not_merged}건")
    line = " · ".join(parts)
    if plan.truncated:
        # ⚠️ 이 문장이 없으면 "백필했으니 완전하다" 고 믿게 됩니다.
        line += " — ⚠️ 상한에 걸려 더 오래된 것은 못 가져왔습니다. 다시 실행하세요."
    return line
