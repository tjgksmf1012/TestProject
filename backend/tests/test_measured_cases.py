"""「쟀는데 0건」과 「안 잰」을 가르는 판단 — 파이썬과 TS 가 같은가 (결함 410).

같은 규칙이 두 벌입니다:

    파이썬  backend/teamflow/services/report_service.py  (보고서의 `measured`)
    TS      frontend/src/lib/contribution/view.ts        (`nothingMeasured`)

⚠️ **가드를 넓히는 것보다 사본을 없애는 것이 낫지만**(결함 363) 언어가
달라 합칠 수가 없습니다. 그래서 결함 345 의 방법을 씁니다 — 사례를
`frontend/src/lib/contribution/measured_cases.json` 한 곳에 두고 **두 검사가
같이 읽습니다.** 한쪽만 고치면 양쪽 다 빨개집니다.
"""

from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CASES = REPO_ROOT / "frontend" / "src" / "lib" / "contribution" / "measured_cases.json"


def _cases() -> list[dict]:
    data = json.loads(CASES.read_text(encoding="utf-8"))
    return data["cases"]


def test_the_cases_file_actually_splits_the_two_answers() -> None:
    """⭐ 사례가 **양쪽 답을 다 만드는가**.

    ⚠️ 전부 `True` 인 사례만 모으면 이 검사는 아무것도 안 잽니다 —
    결함 347 의 「빈손으로 통과한 짝 검사」와 같은 함정입니다.
    """
    answers = {case["measured"] for case in _cases()}
    assert answers == {True, False}, f"사례가 한쪽 답만 만듭니다: {answers}"

    # ⭐ **갈라지는 사례**가 있어야 합니다 — 옛 규칙
    #    (`confidence > 0 and evidence_count`)과 새 규칙(`category_count`)이
    #    **다른 답**을 내는 줄. 없으면 옛 코드도 통과합니다.
    diverging = [
        case
        for case in _cases()
        if (case["confidence"] > 0 and case["evidence_count"] > 0)
        != (case["category_count"] > 0)
    ]
    assert diverging, (
        "옛 규칙과 새 규칙이 **모든 사례에서 같은 답**을 냅니다 — "
        "이 검사는 아무것도 안 재고 있습니다"
    )


def test_the_report_calls_a_measured_zero_measured() -> None:
    """⭐ 보고서의 판단이 사례와 맞는가 (결함 410).

    막 들어와 활동이 0인 사람에게 「측정하지 못했습니다」라고 적으면,
    불변식 ③(측정 불가 ≠ 0점)이 쓰는 말을 **아는 값**에 쓰는 것입니다
    (결함 358). 그것도 팀 밖으로 나가는 문서에서.
    """
    import re

    src = (
        REPO_ROOT
        / "backend"
        / "teamflow"
        / "services"
        / "report_service.py"
    ).read_text(encoding="utf-8")
    # 주석을 **같은 길이의 공백으로** 덮습니다 — 줄 번호가 안 밀립니다.
    code = re.sub(r"#[^\n]*", lambda m: " " * len(m.group(0)), src)
    hit = re.search(r"measured\s*=\s*([^\n]+)", code)
    assert hit is not None, "보고서의 `measured` 판단을 못 찾았습니다 — 검사가 낡았습니다"
    rule = hit.group(1).strip()

    def decide(case: dict) -> bool:
        """소스에 적힌 규칙을 사례에 그대로 적용합니다."""
        if "score.categories" in rule:
            return case["category_count"] > 0
        # 옛 규칙 — 이 갈래로 떨어지면 아래 비교에서 걸립니다.
        return case["confidence"] > 0 and case["evidence_count"] > 0

    wrong = [
        f"{case['왜']}: 규칙은 {decide(case)}, 사례는 {case['measured']}"
        for case in _cases()
        if decide(case) != case["measured"]
    ]
    assert not wrong, (
        f"보고서의 판단(`{rule}`)이 공용 사례와 다릅니다:\n  " + "\n  ".join(wrong)
    )


def test_the_ts_side_reads_the_same_file() -> None:
    """⭐ 예외가 낡지 않았는가 — TS 검사도 이 파일을 **정말** 읽는가.

    한쪽이 조용히 손을 놓으면 이 짝은 그 순간 아무것도 안 잽니다.
    """
    ts = (
        REPO_ROOT
        / "frontend"
        / "src"
        / "lib"
        / "contribution"
        / "view.test.ts"
    ).read_text(encoding="utf-8")
    assert "measured_cases.json" in ts, (
        "TS 쪽 검사가 공용 사례 파일을 안 읽습니다 — 짝이 한쪽만 남았습니다"
    )
