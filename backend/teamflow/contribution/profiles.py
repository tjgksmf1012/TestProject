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
