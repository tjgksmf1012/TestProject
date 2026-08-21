"""역할 이름 한 벌 — 화면(`view.ts`)과 **글자까지 같아야** 한다.

결함 291. 최종 보고서가 역할을 `developer` 라고 그대로 적었습니다.
한국어 제품의 **제출물**에 영어 식별자가 뜬 것이고, 같은 사람을 기여도
화면은 「개발 60% · 디자인 40%」라고 부르고 있었습니다.

판단(`roleLabel`·`roleOf`)은 `@lib` 에 이미 있었는데 서버가 그 개념을
안 갖고 있어서, 보고서는 물어볼 자리가 없었습니다 — 실패 ①의 사촌입니다.
"""

from __future__ import annotations

import re
from pathlib import Path

from teamflow.contribution.profiles import (
    ROLE_LABEL,
    Role,
    describe_role_shares,
    role_label,
)

TS = (
    Path(__file__).resolve().parents[2]
    / "frontend" / "src" / "lib" / "contribution" / "view.ts"
)


def test_every_role_has_a_korean_name() -> None:
    assert set(ROLE_LABEL) == set(Role), "역할이 늘거나 줄었습니다 — 이름표에도 넣으십시오"
    for name in ROLE_LABEL.values():
        assert re.search(r"[가-힣]", name), f"한국어 이름이 아닙니다: {name}"


def test_an_unknown_role_is_not_invented() -> None:
    """⚠️ 지어낸 한국어보다 영어 식별자가 정직합니다 — 화면과 같은 규칙."""
    assert role_label("researcher") == "researcher"


def test_one_role_reads_as_that_role() -> None:
    assert describe_role_shares({"developer": 1.0}, "developer") == "개발"


def test_a_blend_says_both_halves() -> None:
    """⭐ **절반만 말하지 않습니다.**

    기획 60% · 개발 40% 인 사람을 「기획」이라고만 적으면, 그 사람의 코드
    활동이 왜 가중치가 낮은지 읽는 사람이 알 수 없습니다.
    """
    got = describe_role_shares({"developer": 0.4, "planner": 0.6}, "planner")
    assert got == "기획 60% · 개발 40%", got


def test_no_shares_falls_back_to_the_primary_role_without_inventing() -> None:
    assert describe_role_shares(None, "designer") == "디자인"
    assert describe_role_shares({}, "designer") == "디자인"


def test_the_server_and_the_screen_use_the_same_words() -> None:
    """⚠️ 언어가 달라 두 벌인 것은 어쩔 수 없지만, **갈라지는 것**은 막습니다.

    화면 쪽 파일에서 표를 **읽어서** 맞춥니다 — 여기 상수를 하나 더 적으면
    그것이 세 번째 벌입니다 (결함 285 에서 쓴 것과 같은 방식).
    """
    source = TS.read_text(encoding="utf-8")
    # 주석의 「나쁜 예」를 물지 않게 걷어냅니다 (AGENTS.md).
    code = re.sub(r"/\*[\s\S]*?\*/", "", source)
    code = re.sub(r"^\s*//.*$", "", code, flags=re.M)

    block = re.search(r"ROLE_NAMES:\s*Record<string,\s*string>\s*=\s*\{([^}]*)\}", code)
    assert block is not None, "화면 쪽 이름표를 못 찾았습니다 — 검사가 낡았습니다"
    screen = dict(re.findall(r"(\w+):\s*'([^']+)'", block.group(1)))

    server = {str(role): name for role, name in ROLE_LABEL.items()}
    assert server == screen, f"서버 {server} · 화면 {screen}"


def test_the_server_and_the_screen_use_the_same_category_words() -> None:
    """⚠️ 카테고리도 두 벌이 갈라지면 안 됩니다 (결함 291).

    짝 검사(`test_repo_integrity`)는 **키 집합만** 봅니다. 서버에 한국어
    이름이 아예 없어서, 최종 보고서가 `document, schedule, peer` 를 그대로
    실었습니다.
    """
    from teamflow.contribution.events import CATEGORY_LABEL, Category

    source = TS.read_text(encoding="utf-8")
    code = re.sub(r"/\*[\s\S]*?\*/", "", source)
    code = re.sub(r"^\s*//.*$", "", code, flags=re.M)
    block = re.search(
        r"CATEGORY_LABEL:\s*Record<string,\s*string>\s*=\s*\{([^}]*)\}", code
    )
    assert block is not None, "화면 쪽 카테고리 이름표를 못 찾았습니다 — 검사가 낡았습니다"
    screen = dict(re.findall(r"(\w+):\s*'([^']+)'", block.group(1)))

    server = {str(c): name for c, name in CATEGORY_LABEL.items()}
    assert set(CATEGORY_LABEL) == set(Category), "카테고리가 늘거나 줄었습니다"
    assert server == screen, f"서버 {server} · 화면 {screen}"
