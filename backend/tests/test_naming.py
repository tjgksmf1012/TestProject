"""회의 이름 한 벌 — 화면 쪽(`naming.ts`)과 **글자까지 같아야** 한다.

결함 285. 같은 회의가 여덟 가지 이름으로 불리고 있었고, 그중 넷이
서버에서 나왔습니다. 언어가 달라 두 벌인 것은 어쩔 수 없지만, 두 벌이
**갈라지는 것**은 막을 수 있습니다.
"""

from __future__ import annotations

import re
from pathlib import Path

from teamflow.services.naming import meeting_label

TS = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "ui" / "naming.ts"


def test_이름이_있으면_그_이름() -> None:
    assert meeting_label("1주차 정기회의", 1) == "1주차 정기회의"


def test_이름이_없으면_어느_회의인지를_남긴다() -> None:
    assert meeting_label(None, 4) == "제목 없는 회의 #4"
    assert meeting_label("", 4) == "제목 없는 회의 #4"
    assert meeting_label("   ", 4) == "제목 없는 회의 #4"


def test_이름_없는_회의_둘은_서로_다르게_불린다() -> None:
    assert meeting_label(None, 4) != meeting_label(None, 5)


def test_번호를_모르면_번호를_붙이지_않는다() -> None:
    assert meeting_label(None, None) == "제목 없는 회의"


def test_앞뒤_공백은_다듬는다() -> None:
    assert meeting_label("  스프린트 2 계획  ", 2) == "스프린트 2 계획"


def test_화면_쪽과_같은_글자를_쓴다() -> None:
    """⚠️ 낱말 하나만 달라도 사람은 다른 것으로 읽습니다.

    예전에 알림만 「**이름** 없는 회의」였고 나머지는 「**제목** 없는
    회의」였습니다. 화면 쪽 파일에서 문자열을 **읽어서** 맞춥니다 —
    여기 상수를 하나 더 적으면 그것이 세 번째 벌이 됩니다.
    """
    ts = TS.read_text(encoding="utf-8")
    # 주석에 「나쁜 예」가 적혀 있으므로 주석부터 걷습니다 (AGENTS.md).
    code = re.sub(r"/\*[\s\S]*?\*/", "", ts)
    code = re.sub(r"^\s*//.*$", "", code, flags=re.M)

    with_id = re.search(r"`(제목[^`]*\$\{id\}[^`]*)`", code)
    # 삼항이라 `return` 뒤가 아니라 `: '…'` 자리에 있습니다.
    without_id = re.search(r"'(제목[^'{]*)'", code)
    assert with_id is not None, "화면 쪽에서 번호 붙는 이름을 못 찾았습니다 — 검사가 낡았습니다"
    assert without_id is not None, "화면 쪽에서 번호 없는 이름을 못 찾았습니다 — 검사가 낡았습니다"

    assert meeting_label(None, 4) == with_id.group(1).replace("${id}", "4")
    assert meeting_label(None, None) == without_id.group(1)
