"""`@이름` 을 고르는 규칙 — 서버와 화면이 같은가 (결함 411).

같은 규칙이 두 벌입니다:

    파이썬  backend/teamflow/chat/mentions.py       `find_mentions`  (판정)
    TS      frontend/src/lib/chat/view.ts           `mentionSegments` (강조)

⚠️ **하는 일이 다르니 합칠 수 없습니다** — 한쪽은 알림을 보낼 사람을
정하고 한쪽은 글자를 굵게 그립니다. 그런데 **누구를 고르는가**는 같아야
합니다. 화면 쪽 주석이 「서버의 판정과 **같은 규칙**입니다」라고 단언하고
있었는데, 서버만 같은 사람을 두 번 부를 때 더 짧은 이름으로 흘러내려
`@한동희` 를 두 번 쓴 글이 **`한동`** 을 부른 것으로 기록됐습니다.

⚠️ **가드를 넓히는 것보다 사본을 없애는 것이 낫지만**(결함 363) 언어가
달라 못 합칩니다. 결함 345 의 방법을 씁니다 — 사례를
`frontend/src/lib/chat/mention_cases.json` 한 곳에 두고 **두 검사가 같이
읽습니다.** 한쪽만 고치면 양쪽 다 빨개집니다.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from teamflow.chat.mentions import find_mentions

REPO_ROOT = Path(__file__).resolve().parents[2]
CASES = REPO_ROOT / "frontend" / "src" / "lib" / "chat" / "mention_cases.json"
VIEW_TEST = REPO_ROOT / "frontend" / "src" / "lib" / "chat" / "view.test.ts"


def _cases() -> list[dict]:
    return json.loads(CASES.read_text(encoding="utf-8"))["cases"]


def _old_rule(body: str, candidates: list[str]) -> list[str]:
    """결함 411 **이전**의 서버 규칙 — `break` 가 중복 판정 안에 있던 것."""
    if not candidates:
        return []
    by_length = sorted(candidates, key=len, reverse=True)
    found: list[str] = []
    for match in re.finditer(r"@([0-9A-Za-z가-힣_.\-]+)", body):
        tail = match.group(1)
        for name in by_length:
            if tail.startswith(name) and name not in found:
                found.append(name)
                break
    return found


def test_the_server_picks_exactly_what_the_shared_cases_say() -> None:
    """⭐ 서버가 **사례대로** 고르는가."""
    wrong = [
        f"{case['왜']}: 서버 {find_mentions(case['body'], list(case['names']))}"
        f" · 사례 {case['picked']}"
        for case in _cases()
        if find_mentions(case["body"], list(case["names"])) != case["picked"]
    ]
    assert not wrong, "공용 사례와 다릅니다:\n  " + "\n  ".join(wrong)


def test_the_cases_contain_a_row_where_the_old_rule_disagrees() -> None:
    """⭐ 사례에 **옛 규칙과 갈라지는 줄**이 있는가.

    ⚠️ 없으면 결함 411 이전 코드도 이 검사를 통과합니다 — 아무것도 안
    재는 짝 검사가 됩니다(결함 347·410).
    """
    diverging = [
        case["왜"]
        for case in _cases()
        if _old_rule(case["body"], list(case["names"])) != case["picked"]
    ]
    assert diverging, (
        "옛 규칙도 사례를 전부 통과합니다 — 갈라지는 줄을 넣으십시오"
    )


def test_the_cases_exercise_both_a_hit_and_a_miss() -> None:
    """⭐ 사례가 **양쪽 답을 다 만드는가** — 전부 빈 목록이면 안 잽니다."""
    sizes = {len(case["picked"]) == 0 for case in _cases()}
    assert sizes == {True, False}, f"사례가 한쪽 답만 만듭니다: {sizes}"


def test_the_screen_side_really_reads_the_same_file() -> None:
    """⭐ TS 검사가 **이 파일을 실제로 읽는가**.

    ⚠️ 한쪽이 사례를 안 읽으면 짝이 아니라 파이썬 검사 하나입니다.
    """
    source = VIEW_TEST.read_text(encoding="utf-8")
    assert "mention_cases.json" in source, (
        "frontend/src/lib/chat/view.test.ts 가 공용 사례를 안 읽습니다"
    )
