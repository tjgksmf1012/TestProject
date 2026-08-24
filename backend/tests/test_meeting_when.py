"""이 회의는 **언제인가** — 파이썬 쪽 (결함 358).

⚠️ **이 검사는 화면 쪽 검사와 같은 파일을 읽습니다.**

    frontend/src/lib/home/meeting_when_cases.json

같은 판단이 두 곳에 있으면 반드시 갈라집니다(대표 실패 ②). 실제로
갈라졌습니다 — 화면은 결함 287 이 만든 `meetingWhen` 으로 「예정
09-15 10:00」이라고 부르는데, 회의록 builder 는 `started_at` 하나만 보고
**「일시 못 쟀습니다」**라고 적었습니다. 「못 쟀습니다」는 이 제품의
불변식(**측정 불가 ≠ 0점**)이 쓰는 말이라, 아는 값에 붙이면 그 말이
닳습니다.

여기 한 벌을 두는 이유는 보고서가 **기록**이라 만든 순간의 글자를
저장하기 때문입니다(결함 345 와 같은 사정). 갈라지지 않게 하는 방법이
이 짝 검사입니다.

⚠️ **글자를 맞추지 않습니다.** 두 자리는 형식이 다릅니다 — 홈은 월-일,
회의록은 전체 날짜. 같은 것은 **판단**이고, 그것만 잽니다.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from teamflow.reports.minutes import meeting_when

CASES_FILE = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "src"
    / "lib"
    / "home"
    / "meeting_when_cases.json"
)


def _cases() -> list[dict]:
    return json.loads(CASES_FILE.read_text(encoding="utf-8"))["cases"]


def _at(value: str | None) -> datetime | None:
    """`""` 도 「없음」입니다 — 서버가 빈 칸을 보낸 적이 있습니다."""
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def test_the_shared_case_file_is_where_both_sides_look():
    """⭐ 짝 검사의 전제 — 그 파일이 **있고** 화면 쪽도 그것을 읽는다.

    파일이 사라지거나 화면 쪽이 자기 사례로 돌아가면, 두 검사는 각자
    통과하면서 규칙이 갈라집니다. 그 상태 자체가 실패여야 합니다.
    """
    assert CASES_FILE.exists(), f"{CASES_FILE} 이 없습니다"
    ts_test = CASES_FILE.with_name("next.test.ts").read_text(encoding="utf-8")
    assert "meeting_when_cases.json" in ts_test, (
        "화면 쪽 검사가 공용 사례 파일을 안 읽습니다 — 두 벌이 조용히 갈라집니다"
    )
    assert _cases(), "사례가 0개입니다"


def test_the_cases_actually_diverge():
    """⭐ 사례가 **갈라지는** 값을 담고 있다.

    ⚠️ `started_at` 만 보는 옛 코드도 통과하는 사례만 모으면 이 검사는
    아무것도 안 잽니다 — 그게 결함 358 이 오래 산 방식입니다. 「연 시각은
    없고 잡아 둔 시각만 있는」 경우가 **반드시** 있어야 합니다.
    """
    planned_only = [
        c for c in _cases() if not c["started_at"] and c["scheduled_at"] and c["at"]
    ]
    assert planned_only, (
        "「잡아만 둔 회의」 사례가 없습니다 — 옛 코드도 통과하는 사례뿐입니다"
    )


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["왜"])
def test_python_and_the_screen_make_the_same_judgment(case: dict):
    """⭐ 같은 입력에 **같은 판단**을 낸다."""
    at, planned = meeting_when(_at(case["started_at"]), _at(case["scheduled_at"]))
    assert at == _at(case["at"]), f"{case['왜']}: 어느 시각을 쓰는지가 다릅니다"
    assert planned == case["planned"], f"{case['왜']}: 「예정인가」가 다릅니다"
