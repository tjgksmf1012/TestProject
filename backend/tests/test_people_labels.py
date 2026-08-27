"""사람 이름표 — 파이썬 쪽 (결함 345).

⚠️ **이 검사는 화면 쪽 검사와 같은 파일을 읽습니다.**

    frontend/src/lib/people/label_cases.json

같은 판단이 두 곳에 있으면 반드시 갈라집니다(대표 실패 ②). 여기 한 벌을
두는 이유는 보고서가 **기록**이라 만든 순간의 글자를 저장하기 때문이고,
갈라지지 않게 하는 방법이 이 짝 검사입니다 — 한쪽 규칙만 고치면 양쪽 다
빨개집니다.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from teamflow.people.labels import PersonRef, label_in_list, tells_apart_in_list

CASES_FILE = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "src"
    / "lib"
    / "people"
    / "label_cases.json"
)


def _cases() -> list[dict]:
    return json.loads(CASES_FILE.read_text(encoding="utf-8"))["cases"]


def test_the_shared_case_file_is_where_both_sides_look():
    """⭐ 짝 검사의 전제 — 그 파일이 **있고** 화면 쪽도 그것을 읽는다.

    파일이 사라지거나 화면 쪽이 자기 상수로 돌아가면, 두 검사는 각자
    통과하면서 규칙이 갈라집니다. 그 상태 자체가 실패여야 합니다.
    """
    assert CASES_FILE.exists(), f"{CASES_FILE} 이 없습니다"
    ts_test = CASES_FILE.with_name("labels.test.ts").read_text(encoding="utf-8")
    assert "label_cases.json" in ts_test, (
        "화면 쪽 검사가 공용 사례 파일을 안 읽습니다 — 두 벌이 조용히 갈라집니다"
    )
    assert _cases(), "사례가 0개입니다"


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["왜"])
def test_python_and_the_screen_say_the_same_words(case: dict):
    """⭐ 같은 입력에 **같은 글자**를 낸다."""
    people = [
        PersonRef(
            user_id=p["user_id"],
            name=p.get("name"),
            github_login=p.get("github_login"),
        )
        for p in case["people"]
    ]
    assert [label_in_list(p, people) for p in people] == case["labels"]
    assert [tells_apart_in_list(p, people) for p in people] == case["tells_apart"]
