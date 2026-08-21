"""역할별 가중치 프로파일.

docs/05-기여도-산정-설계.md §3

⚠️ 아래 기본값은 **근거가 없는 예시값**이다. ChatGPT 대화에서 제시된 숫자를
그대로 옮긴 것이고, 실증적으로 검증된 바 없다.

그래서 이 값들은 **기본값일 뿐 고정값이 아니다.** 팀이 프로젝트 시작 시
조정하고, 조정 이력을 남긴다 (scoring_profiles 테이블).

발표에서는 "가중치는 팀이 합의해 정하는 값이며 우리는 기본 프로파일을 제공한다"고
설명한다. "우리가 정한 가중치가 옳다"보다 훨씬 방어하기 쉽다.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from teamflow.contribution.events import Category


class Role(StrEnum):
    DEVELOPER = "developer"
    PLANNER = "planner"
    DESIGNER = "designer"


#: 사람이 읽을 이름.
#:
#: ⚠️ **화면의 `lib/contribution/view.ts` 와 짝입니다** (`PROJECT_ROLE_LABEL`
#: 과 같은 방식). 갈라지면 `test_role_label.py` 가 터집니다.
#:
#: ⚠️ 이 표가 없어서 최종 보고서가 역할을 **`developer` 라고 그대로**
#: 적었습니다 (결함 291). 한국어 제품의 제출물에 영어 식별자가 뜬 것이고,
#: 화면은 같은 사람을 「개발 60% · 디자인 40%」라고 부르고 있었습니다.
ROLE_LABEL: dict[Role, str] = {
    Role.DEVELOPER: "개발",
    Role.PLANNER: "기획",
    Role.DESIGNER: "디자인",
}


def role_label(key: str) -> str:
    """역할의 한국어 이름.

    ⚠️ 모르는 값은 **그대로 돌려줍니다.** 역할을 하나 더 만들었는데 표에
    안 넣었으면, 지어낸 한국어보다 영어 식별자가 정직합니다 — 화면의
    `roleLabel` 과 같은 규칙입니다.
    """
    try:
        return ROLE_LABEL[Role(key)]
    except ValueError:
        return key


def describe_role_shares(shares: dict[str, float] | None, primary: str) -> str:
    """이 사람을 뭐라고 부를 것인가 — 화면(`roleOf`)과 **같은 글자**.

    ⚠️ **절반만 말하지 않습니다.** 기획 60% · 개발 40% 인 사람을 「기획」
    이라고만 적으면, 그 사람의 코드 활동이 왜 가중치가 낮은지 읽는 사람이
    알 수 없습니다. 기여도 문서에서 그건 사람을 깎는 쪽으로 읽힙니다.

    비중을 모르면 서버가 가진 주 역할을 그대로 씁니다 — **지어내지
    않습니다.**
    """
    named = [(k, v) for k, v in (shares or {}).items() if v > 0]
    if not named:
        return role_label(primary)
    if len(named) == 1:
        return role_label(named[0][0])
    named.sort(key=lambda kv: kv[1], reverse=True)
    return " · ".join(f"{role_label(k)} {round(v * 100)}%" for k, v in named)


@dataclass(frozen=True, slots=True)
class ScoringProfile:
    """역할 하나의 카테고리별 가중치."""

    role: Role
    weights: dict[Category, float]
    version: str = "default-v1"

    def __post_init__(self) -> None:
        total = sum(self.weights.values())
        if abs(total - 1.0) > 1e-6:
            raise ValueError(f"{self.role} 가중치 합이 1.0이 아닙니다: {total}")
        for cat, w in self.weights.items():
            if w < 0:
                raise ValueError(f"{self.role}/{cat} 가중치가 음수입니다: {w}")

    def weight(self, category: Category) -> float:
        return self.weights.get(category, 0.0)


DEFAULT_PROFILES: dict[Role, ScoringProfile] = {
    Role.DEVELOPER: ScoringProfile(
        role=Role.DEVELOPER,
        weights={
            Category.CODE: 0.35,
            Category.TASK: 0.30,
            Category.DOCUMENT: 0.05,
            Category.MEETING: 0.10,
            Category.SCHEDULE: 0.10,
            Category.PEER: 0.10,
        },
    ),
    Role.PLANNER: ScoringProfile(
        role=Role.PLANNER,
        weights={
            Category.CODE: 0.0,
            Category.TASK: 0.30,
            Category.DOCUMENT: 0.30,
            Category.MEETING: 0.15,
            Category.SCHEDULE: 0.10,
            Category.PEER: 0.15,
        },
    ),
    Role.DESIGNER: ScoringProfile(
        role=Role.DESIGNER,
        weights={
            Category.CODE: 0.0,
            Category.TASK: 0.30,
            Category.DOCUMENT: 0.35,  # 디자인 산출물
            Category.MEETING: 0.10,
            Category.SCHEDULE: 0.10,
            Category.PEER: 0.15,
        },
    ),
}


def blended_profile(shares: dict[Role, float]) -> ScoringProfile:
    """겸직 역할의 혼합 프로파일.

    대학 팀플에서는 한 사람이 개발 70% + 기획 30% 처럼 겸하는 경우가 흔하다.
    """
    total = sum(shares.values())
    if total <= 0:
        raise ValueError("역할 비중 합이 0 이하입니다")

    merged: dict[Category, float] = dict.fromkeys(Category, 0.0)
    for role, share in shares.items():
        profile = DEFAULT_PROFILES[role]
        for category in Category:
            merged[category] += profile.weight(category) * (share / total)

    primary = max(shares, key=lambda r: shares[r])
    label = "+".join(f"{r.value}:{shares[r] / total:.2f}" for r in sorted(shares, key=str))
    return ScoringProfile(role=primary, weights=merged, version=f"blend({label})")


def clean_role_shares(raw: dict[str, float] | None) -> dict[str, float]:
    """사람이 보낸 역할 비중을 **받아들일 수 있는 모양으로** 검사한다.

    ## 왜 여기 있나

    가입·초대가 `{"developer": 1.0}` 을 하드코딩하고 있었고, 이걸 바꾸는
    API 도 화면도 없었습니다. 그래서 `PLANNER`·`DESIGNER` 프로파일과
    `blended_profile` 은 **실사용 경로로 도달 불가**였고, 기획자·디자이너
    팀원의 기여도가 **개발자 가중치로** 계산됐습니다.

    기획자 프로파일은 코드 0%, 문서 30% 인데 개발자로 계산하면 코드 35%,
    문서 5% 입니다. 문서만 쓴 사람이 이유 없이 낮게 나옵니다 — 오류는
    어디에도 안 납니다.

    ## 검사하는 것

    ⚠️ **합이 1 이 아니면 거절합니다.** `blended_profile` 은 합으로 나눠
    정규화하므로 `{"developer": 5, "planner": 5}` 도 "돌아가긴" 합니다.
    그런데 그러면 화면에 적힌 숫자와 실제 비중이 달라지고, 사람은 자기가
    적은 값이 그대로 쓰인다고 믿습니다. 받아들일 때 막는 편이 낫습니다.

    ⚠️ **0 은 빼고 저장합니다.** `{"developer": 1.0, "planner": 0.0}` 은
    겸직이 아니라 개발자입니다. 남겨 두면 `blended_profile` 이 이름표를
    `blend(developer:1.00+planner:0.00)` 로 만들어 화면이 겸직처럼 보입니다.
    """
    if not raw:
        raise ValueError("역할을 하나 이상 골라야 합니다")

    cleaned: dict[str, float] = {}
    for key, value in raw.items():
        try:
            role = Role(key)
        except ValueError as exc:
            known = ", ".join(sorted(r.value for r in Role))
            raise ValueError(f"모르는 역할입니다: {key} (가능: {known})") from exc
        share = float(value)
        if share < 0:
            raise ValueError(f"역할 비중은 음수일 수 없습니다: {key}={share}")
        if share > 0:
            cleaned[role.value] = share

    if not cleaned:
        raise ValueError("역할 비중이 전부 0 입니다")

    total = sum(cleaned.values())
    # 0.1 씩 세 번이면 0.30000000000000004 가 된다. 화면에서 온 값이라
    # 부동소수 오차는 통과시키되, 0.9 나 1.1 은 막는다.
    if abs(total - 1.0) > 1e-6:
        raise ValueError(f"역할 비중의 합이 1 이어야 합니다 (지금 {total:g})")
    return cleaned
