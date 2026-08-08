"""GitHub 연결 — 대조용 표기와 연결 상태 진단.

이 모듈이 있는 이유는 docs/15 §4.2 의 첫 줄입니다.

> 연결이 됐는지 사람이 알 방법이 없다. 저장소를 적어 넣어도 웹훅이 오는지,
> 서명이 맞는지, 설치 id 가 유효한지 화면에 아무것도 안 나옵니다.
> **틀리면 오류 없이 기여도만 빕니다.**

"오류 없이 빈다" 가 이 프로젝트에서 가장 위험한 실패 방식입니다. 기여도는
성적에 쓰일 수 있는 값이고, 빈 값은 "활동을 안 했다" 로 읽힙니다. 그래서
연결이 안 된 상태는 **조용하면 안 되고**, 화면이 무엇을 고쳐야 하는지까지
말해야 합니다.

여기에는 DB 도 네트워크도 없습니다. 사실(`ConnectionFacts`)을 받아 판단
(`ConnectionState`)만 돌려줍니다 — 그래야 테스트할 수 있습니다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

# ══════════════════════════════════════════════════════════════
# 대조용 표기
# ══════════════════════════════════════════════════════════════
#
# ⚠️ 이걸 안 쓰면 **대소문자가 하나만 달라도 모든 웹훅이 조용히 버려집니다.**
#
# GitHub 은 `owner/repo` 를 대소문자를 구분하지 않고 취급합니다 — 같은
# 이름의 저장소를 대소문자만 바꿔 두 개 만들 수 없고, 주소창에 소문자로
# 쳐도 열립니다. 그런데 웹훅 본문의 `repository.full_name` 은 **정식 표기**
# 로 옵니다(`tjgksmf1012/TestProject`). 사람은 손으로 적을 때 소문자로 적기
# 쉽습니다(`tjgksmf1012/testproject`).
#
# PostgreSQL 의 `=` 도 SQLite 의 기본 대조도 대소문자를 구분합니다. 그래서
# 둘은 다른 문자열이 되고, 웹훅 처리기는 "연결되지 않은 저장소" 로 보고
# 202 를 돌려주며 조용히 버립니다. 팀은 PR 을 100개 병합해도 기여도가
# 0 이고, 아무 곳에도 오류가 남지 않습니다.
#
# `casefold()` 가 아니라 `lower()` 인 이유: GitHub 의 소유자·저장소 이름은
# ASCII 만 허용됩니다(`[A-Za-z0-9._-]`). 그 범위에서 둘은 같고, `lower()`
# 는 터키어 `I` 같은 언어별 예외를 만들지 않습니다.


def repo_key(repo: str | None) -> str | None:
    """웹훅이 프로젝트를 찾을 때 쓰는 대조용 표기.

    화면에 보여줄 표기(`github_repo`)는 사람이 적은 그대로 두고, **찾는
    데만** 이 값을 씁니다. 사람이 적은 걸 소문자로 덮어쓰면 정식 표기를
    잃어버리고, 나중에 GitHub 링크를 만들 때 다시 알 방법이 없습니다.
    """
    if repo is None:
        return None
    key = repo.strip().lower()
    return key or None


def same_repo(left: str | None, right: str | None) -> bool:
    """둘이 같은 저장소를 가리키는가."""
    a, b = repo_key(left), repo_key(right)
    return a is not None and a == b


def split_repo(repo: str) -> tuple[str, str]:
    """`owner/repo` 를 둘로. 형식이 아니면 뒤쪽이 빈 문자열."""
    owner, _, name = repo.partition("/")
    return owner, name


# ══════════════════════════════════════════════════════════════
# 진단
# ══════════════════════════════════════════════════════════════


@dataclass(frozen=True, slots=True)
class NearMiss:
    """서명은 맞는데 **어느 프로젝트에도 안 붙은** 배달.

    이게 오타의 유일한 증거입니다. 웹훅이 도착했다는 건 GitHub App 이 그
    저장소에 설치돼 있다는 뜻이고, 안 붙었다는 건 적어 둔 이름이 다르다는
    뜻입니다. 이 기록이 없으면 화면은 "아직 아무것도 안 왔습니다" 밖에
    말할 수 없고, 사람은 App 설치를 의심하며 엉뚱한 곳을 고칩니다.
    """

    repo: str
    last_seen_at: datetime
    count: int


@dataclass(frozen=True, slots=True)
class ConnectionFacts:
    """진단의 재료. 전부 이미 가지고 있는 사실입니다."""

    #: 프로젝트가 적어 둔 저장소. 없으면 None.
    repo: str | None = None
    #: 서명된 배달이 처음 도착한 시각. **소유권 확인의 유일한 근거입니다.**
    verified_at: datetime | None = None
    #: 서버에 GitHub App 자격 증명(app id·개인키)이 설정돼 있는가.
    app_credentials_present: bool = False
    #: 서버에 웹훅 시크릿이 설정돼 있는가. 없으면 배달이 401 로 거절됩니다.
    webhook_secret_present: bool = False
    #: 이 저장소로 마지막 배달이 온 시각.
    last_delivery_at: datetime | None = None
    #: 이 프로젝트에 쌓인 GitHub 이벤트 수.
    delivery_count: int = 0
    #: 팀원이 연결해 둔 GitHub 계정들.
    member_logins: frozenset[str] = frozenset()
    #: 아직 GitHub 계정을 연결하지 않은 팀원 이름들.
    members_without_login: tuple[str, ...] = ()
    #: 실제로 이 저장소에서 활동한 계정들.
    actor_logins: frozenset[str] = frozenset()
    #: 비슷한 이름으로 도착한, 안 붙은 배달들.
    near_misses: tuple[NearMiss, ...] = ()
    #: 백필을 마지막으로 돌린 시각. None 이면 **한 번도 안 돌렸습니다.**
    backfilled_at: datetime | None = None
    #: 이 시각 이후는 GitHub 에 물어봤다. None 이면 연결 이후만 있습니다.
    backfilled_to: datetime | None = None


@dataclass(frozen=True, slots=True)
class ConnectionState:
    """화면에 그대로 내보내는 진단 결과."""

    code: str
    headline: str
    #: 왜 그렇게 판단했는지. 근거 없이 상태만 말하면 못 고칩니다.
    detail: str
    #: 'ok' | 'warn' | 'bad'
    severity: str
    #: 사람이 지금 할 일. 없으면 None.
    next_step: str | None = None
    #: 곁들여 알려야 하는 것들 (치명적이지는 않지만 기여도를 비게 만드는 것).
    warnings: list[str] = field(default_factory=list)


def _unlinked_members_warning(facts: ConnectionFacts) -> str | None:
    """GitHub 계정을 안 연결한 팀원은 **조용히 0이 됩니다.**

    기여 이벤트는 `actor_login` 으로 사람을 찾습니다. 연결이 없으면 그
    사람의 PR 은 주인 없는 이벤트가 되고, 화면에는 "활동 없음" 으로
    보입니다 — 실제로는 활동을 했는데 이어 붙일 곳이 없었을 뿐입니다.
    """
    if not facts.members_without_login:
        return None
    names = ", ".join(facts.members_without_login)
    return (
        f"GitHub 계정을 연결하지 않은 팀원이 있습니다: {names}. "
        "이 팀원들의 PR은 주인을 찾지 못해 기여도에 들어가지 않습니다."
    )


def _missing_history_warning(facts: ConnectionFacts) -> str | None:
    """⭐ **연결 전의 활동은 아무 데도 없습니다.**

    웹훅은 연결한 순간부터 옵니다. 팀은 대개 몇 주 코드를 짜다가 이
    시스템을 붙이므로 그 전의 PR 은 통째로 빠집니다.

        3월~4월  PR 40개 병합   ← 기여도에 **없음**
        5월 1일  연결
        5월~     PR 5개 병합    ← 기여도에 있음

    그런데 이 화면은 "연결됨" 이라고 말하고 기여도 화면은 5건을
    보여 줍니다. **어디에도 오류가 없습니다.** 3월에 제일 많이 일한
    사람이 제일 적게 일한 것으로 보이고, 본인도 이유를 알 수 없습니다.

    ⚠️ 배달이 하나도 없으면 말하지 않습니다 — 그때는 위쪽 headline 이
    이미 더 급한 것을 말하고 있고, 여기서 또 말하면 어느 쪽을 고쳐야
    하는지 흐려집니다.
    """
    if facts.delivery_count <= 0:
        return None
    if facts.backfilled_at is not None:
        return None
    # ⚠️ 마크다운을 쓰지 않습니다. 경고 줄은 화면에서 `escapeHtml` 로만
    # 지나가므로 별표가 그대로 보입니다 (결함 44 와 같은 부류).
    return (
        "연결하기 전의 PR은 기여도에 들어가 있지 않습니다. "
        "웹훅은 연결한 순간부터 오기 때문입니다. "
        "아래 ‘지난 활동 가져오기’ 를 누르면 채웁니다."
    )


def describe_coverage(facts: ConnectionFacts) -> str:
    """"이 수치는 언제부터의 활동인가" 를 한 줄로.

    기여도 화면이 그대로 씁니다. 범위를 안 밝힌 숫자는 **전부를 센 것처럼**
    읽힙니다.
    """
    if not facts.repo:
        return "GitHub 활동은 이 계산에 들어 있지 않습니다."
    if facts.delivery_count <= 0:
        return "이 저장소에서 받은 활동이 아직 없습니다."
    if facts.backfilled_to is not None:
        when = facts.backfilled_to.date().isoformat()
        return f"{when} 이후의 GitHub 활동이 반영돼 있습니다."
    if facts.verified_at is not None:
        when = facts.verified_at.date().isoformat()
        return (
            f"{when}(연결한 날) 이후의 활동만 반영돼 있습니다 — "
            "그 전의 PR은 아직 가져오지 않았습니다."
        )
    return "연결 이후의 활동만 반영돼 있습니다 — 그 전의 PR은 아직 가져오지 않았습니다."


def diagnose(facts: ConnectionFacts) -> ConnectionState:
    """연결 상태를 사람이 고칠 수 있는 말로 바꾼다.

    순서가 중요합니다. **지금 고쳐야 할 것 하나**를 맨 앞에 놓습니다 —
    문제를 다섯 개 늘어놓으면 사람은 아무것도 안 고칩니다.
    """
    warnings = [
        w
        for w in (
            _unlinked_members_warning(facts),
            _missing_history_warning(facts),
        )
        if w
    ]

    if not facts.repo:
        return ConnectionState(
            code="no_repo",
            headline="저장소가 연결되지 않았습니다",
            detail=(
                "GitHub 활동은 기여도의 세 다리 중 하나입니다. "
                "연결하지 않으면 그 몫이 통째로 비어 있게 됩니다."
            ),
            severity="warn",
            next_step="위 칸에 `owner/repo` 형식으로 적고 저장하세요.",
            warnings=warnings,
        )

    # 서버 설정 문제는 팀이 고칠 수 없습니다. 팀에게 "기다리세요" 라고
    # 하면 영원히 기다립니다 — 관리자에게 말하라고 해야 합니다.
    if not facts.webhook_secret_present:
        return ConnectionState(
            code="server_missing_webhook_secret",
            headline="서버에 웹훅 시크릿이 없습니다",
            detail=(
                "이 상태에서는 GitHub이 보낸 배달이 전부 401로 거절됩니다. "
                "저장소 설정과 무관하며 팀에서 고칠 수 없습니다."
            ),
            severity="bad",
            next_step="서버 관리자에게 `GITHUB_WEBHOOK_SECRET` 설정을 요청하세요.",
            warnings=warnings,
        )

    # ⚠️ 배달이 이미 들어와 있으면 그 자체가 연결됐다는 증거입니다.
    #
    # `verified_at` 은 나중에 추가한 칸이라, 그 전에 저장된 이벤트를 가진
    # 프로젝트에는 값이 없습니다. `verified_at` 만 보면 그런 프로젝트에
    # "아직 배달이 온 적이 없습니다" 라고 말하게 되는데, 같은 화면 바로
    # 아래에 "배달 12건 · 마지막 3분 전" 이 나옵니다 — 화면이 스스로를
    # 반박합니다. 게다가 다음 할 일로 "App이 설치돼 있는지 확인하세요"
    # 를 시킵니다. 가 보면 멀쩡히 설치돼 있고, 사람은 고칠 것이 없는
    # 문제를 찾느라 시간을 씁니다. (결함 48)
    proven = facts.verified_at is not None or facts.delivery_count > 0

    if not proven:
        near = _closest_near_miss(facts)
        if near is not None:
            return ConnectionState(
                code="repo_name_mismatch",
                headline="웹훅은 오고 있는데 저장소 이름이 다릅니다",
                detail=(
                    f"`{near.repo}` 로 배달이 {near.count}건 도착했지만, 이 프로젝트에 "
                    f"적힌 것은 `{facts.repo}` 입니다. 이름이 다르면 오류 없이 버려집니다."
                ),
                severity="bad",
                next_step=f"저장소를 `{near.repo}` 로 고치세요.",
                warnings=warnings,
            )
        return ConnectionState(
            code="waiting_for_delivery",
            headline="아직 이 저장소에서 배달이 온 적이 없습니다",
            detail=(
                "저장소 이름을 적는 것만으로는 연결되지 않습니다. GitHub App이 그 "
                "저장소에 설치돼야 하고, 설치되면 첫 활동에서 배달이 옵니다."
            ),
            severity="warn",
            next_step="GitHub 저장소 설정 → GitHub Apps에서 이 App이 설치돼 있는지 확인하세요.",
            warnings=warnings,
        )

    # 여기부터는 배달이 실제로 왔습니다 — 소유권이 확인된 상태입니다.
    if not facts.app_credentials_present:
        return ConnectionState(
            code="server_missing_app_credentials",
            headline="배달은 오지만 서버가 GitHub API를 부를 수 없습니다",
            detail=(
                "웹훅 본문만으로는 PR의 변경 파일을 알 수 없어 diff 필터를 걸 수 "
                "없습니다. 이벤트는 저장되지만 기여 이벤트로 바뀌지 않습니다."
            ),
            severity="bad",
            next_step="서버 관리자에게 `GITHUB_APP_ID` 와 개인키 설정을 요청하세요.",
            warnings=warnings,
        )

    if not facts.member_logins:
        return ConnectionState(
            code="no_member_logins",
            headline="연결됐지만 팀원의 GitHub 계정이 하나도 등록되지 않았습니다",
            detail=(
                f"배달은 {facts.delivery_count}건 들어왔습니다. 그런데 활동한 계정을 "
                "팀원과 이어 줄 수 없어 **전원의 GitHub 기여도가 0** 이 됩니다."
            ),
            severity="bad",
            next_step="팀원 각자의 GitHub 계정을 등록하세요.",
            warnings=warnings,
        )

    if facts.actor_logins and not (facts.actor_logins & facts.member_logins):
        seen = ", ".join(sorted(facts.actor_logins)[:5])
        return ConnectionState(
            code="actors_do_not_match",
            headline="이 저장소에서 활동하는 계정이 팀원과 하나도 겹치지 않습니다",
            detail=(
                f"활동한 계정: {seen}. 다른 팀의 저장소를 적었거나, 팀원의 GitHub "
                "계정을 잘못 등록했을 수 있습니다."
            ),
            severity="bad",
            next_step="저장소 이름과 팀원 GitHub 계정을 다시 확인하세요.",
            warnings=warnings,
        )

    return ConnectionState(
        code="connected",
        headline="연결되어 있습니다",
        detail=f"배달 {facts.delivery_count}건을 받았습니다.",
        severity="ok",
        next_step=None,
        warnings=warnings,
    )


def _closest_near_miss(facts: ConnectionFacts) -> NearMiss | None:
    """오타 후보 중 가장 그럴듯한 것 하나.

    여러 개를 늘어놓으면 고르는 일이 사람에게 넘어갑니다. 배달이 가장 많이
    온 것이 가장 그럴듯합니다 — 실제로 팀이 쓰고 있는 저장소일 테니까요.
    """
    if not facts.near_misses:
        return None
    return max(facts.near_misses, key=lambda n: (n.count, n.last_seen_at))


def looks_like_typo_of(claimed: str, delivered: str) -> bool:
    """`delivered` 가 `claimed` 의 오타로 볼 만한가.

    ⚠️ 여기서 느슨하게 잡으면 **남의 저장소 이름을 알아내는 도구**가 됩니다.
    이 프로젝트의 구성원이면 누구나 진단 화면을 볼 수 있으므로, 아무
    저장소나 보여 주면 "우리 App 이 설치된 저장소 목록" 을 한 글자씩
    맞춰 가며 캐낼 수 있습니다.

    그래서 **절반은 정확히 맞아야** 보여 줍니다 — 소유자가 같거나
    저장소 이름이 같을 때만. 이미 알고 있는 이름의 나머지 반쪽만
    알려 주는 셈이라, 실제로 흔한 오타(소유자 오타, 이름 오타)는
    전부 잡으면서 캐내기에는 쓸모가 없습니다.

    대소문자 차이는 여기 오지 않습니다 — `repo_key` 가 이미 같은 것으로
    묶어 주므로 그건 애초에 배달이 정상으로 붙습니다.
    """
    if same_repo(claimed, delivered):
        return False
    c_owner, c_name = split_repo(repo_key(claimed) or "")
    d_owner, d_name = split_repo(repo_key(delivered) or "")
    if not c_name or not d_name:
        return False
    return c_owner == d_owner or c_name == d_name
