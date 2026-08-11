"""보고서를 이루는 블록. **불변식이 사는 곳입니다.**

화면이 아니라 여기에 박아 둔 이유는 `__init__.py` 머리말에 적었습니다 —
보고서는 앱 밖으로 나가는 문서라, 글자가 된 뒤에는 어떤 가드도 안 닿습니다.
"""

from __future__ import annotations

from typing import Any

#: 보고서 맨 위에 늘 붙는 말.
#:
#: ⚠️ 줄이지 마십시오. 기여도 화면의 팀 경고와 **같은 자리**입니다 — 이
#: 제품의 윤리가 사는 곳이고, 보고서는 그 화면보다 더 멀리 갑니다.
TEAM_NOTICE = "이 수치로 서로를 비교하지 마세요. 사람마다 잴 수 있었던 양이 다릅니다."
SYSTEM_NOTICE = (
    "계산값은 활동 기록에 기반한 참고값입니다. 최종 기여도는 팀이 합의하여 "
    "확정하며, 시스템은 판정하지 않습니다."
)


def heading(text: str) -> dict[str, Any]:
    return {"kind": "heading", "text": text}


def paragraph(text: str) -> dict[str, Any]:
    return {"kind": "paragraph", "text": text}


def facts(items: list[dict[str, Any]]) -> dict[str, Any]:
    """이름=값 목록.

    값을 못 잰 항목은 `{"gap": True}` 를 답니다 — 화면은 그걸 흙빛으로
    그리고, 글자로 뽑을 때는 "못 쟀습니다" 로 나갑니다. **0 으로 채우지
    않습니다.**
    """
    return {"kind": "facts", "items": items}


def fact(label: str, value: str, *, gap: bool = False, note: str = "") -> dict[str, Any]:
    """이름=값 한 줄.

    ⚠️ **`gap=True` 와 값을 같이 줄 수 없습니다.** 둘은 서로 모순입니다 —
    못 잰 것에는 값이 없습니다.

    이 규칙이 생긴 이유: `gap` 을 "못 쟀다" 와 "흙빛으로 그려라" **두 뜻으로**
    겹쳐 쓰다가, 회의록의 `처리` 줄에 상태 문장과 `gap=True` 를 같이 줬습니다.
    화면에서는 문장이 흙빛으로 잘 떴는데, **글자로 복사하니 그 문장이
    "못 쟀습니다" 로 통째로 바뀌어** 나갔습니다. 복사 버튼을 실제로 눌러
    클립보드를 읽어 보고서야 찾았습니다.

    색을 바꾸고 싶은 것뿐이라면 값을 그대로 두고 `note` 로 말하십시오.
    """
    if gap and value.strip():
        raise ValueError(
            f"`{label}` 에 `gap=True` 와 값 {value!r} 을 같이 줬습니다 — "
            "못 잰 것에는 값이 없습니다. 흙빛으로 그리고 싶을 뿐이면 값을 "
            "그대로 두고 gap 을 빼십시오."
        )
    out: dict[str, Any] = {"label": label, "value": value, "gap": gap}
    if note:
        out["note"] = note
    return out


def bullets(items: list[str], *, empty_note: str) -> dict[str, Any]:
    """줄 목록.

    ⚠️ `empty_note` 가 **필수**인 이유: 비어 있는 목록을 그냥 빈 자리로 두면
    "이 회의에는 다음 안건이 없었다" 와 "아직 못 뽑았다" 가 같아 보입니다.
    둘은 완전히 다른 말입니다.
    """
    return {"kind": "list", "items": list(items), "empty_note": empty_note}


def gap(text: str) -> dict[str, Any]:
    """못 잰 것을 통째로 말하는 자리.

    ⚠️ 빨강이 아니라 흙빛입니다. 못 잰 것은 누가 뭘 잘못한 게 아닙니다.
    """
    return {"kind": "gap", "text": text}


def person(
    *,
    name: str,
    role: str,
    measured: bool,
    range_low: float | None = None,
    range_high: float | None = None,
    confidence: float | None = None,
    confidence_label: str | None = None,
    reasons: list[str] | None = None,
    evidence_count: int = 0,
    gaps: list[str] | None = None,
    final_value: float | None = None,
    final_reason: str | None = None,
) -> dict[str, Any]:
    """한 사람의 몫.

    ⚠️ **`share`(단일 계산값)를 받지 않습니다.** 받는 통로 자체를 두지
    않았습니다 — 있으면 언젠가 실리고, 실리면 복사한 사람 손에 "홍길동 34%"
    가 남습니다. 계산값은 구간으로만 나갑니다.

    `final_value` 는 다릅니다. 그건 시스템의 판정이 아니라 **팀이 합의한
    값**이라 단일 숫자로 나갈 자격이 있습니다. 대신 계산 구간 밖이면
    `final_reason` 이 반드시 따라붙어야 합니다 — 아래 `people` 이 검사합니다.
    """
    return {
        "name": name,
        "role": role,
        "measured": measured,
        "range_low": range_low,
        "range_high": range_high,
        "confidence": confidence,
        "confidence_label": confidence_label,
        "reasons": list(reasons or []),
        "evidence_count": evidence_count,
        "gaps": list(gaps or []),
        "final_value": final_value,
        "final_reason": final_reason,
    }


def people(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """사람별 기여 블록.

    ⚠️ **받는 즉시 이름 순으로 다시 세웁니다.** 부르는 쪽이 어떤 순서로
    넘겼든 상관없게 만드는 것이 핵심입니다 — "부르는 쪽이 정렬해서 주겠지"
    로 두면 언젠가 점수 순으로 넘어오고, 그때 이 파일에는 아무 잘못이
    없어 보입니다. 순위표는 그렇게 생깁니다.

    ⚠️ 팀이 확정한 값이 계산 구간을 벗어났는데 이유가 없으면 **터집니다.**
    "시스템은 판정하지 않는다" 의 반대쪽 짝입니다 — 사람도 근거 없이
    판정하면 안 됩니다. 화면이 이미 막고 있지만, 보고서는 화면을 안 거치는
    경로(배치·API)로도 만들어질 수 있습니다.
    """
    for entry in entries:
        final = entry.get("final_value")
        if final is None:
            continue
        low, high = entry.get("range_low"), entry.get("range_high")
        if low is None or high is None:
            continue
        if (final < low or final > high) and not (entry.get("final_reason") or "").strip():
            raise ValueError(
                f"{entry.get('name')} 의 확정값 {final} 이 계산 구간 "
                f"{low}~{high} 밖인데 이유가 없습니다"
            )

    return {
        "kind": "people",
        # 한글 음절은 코드포인트 순서가 곧 가나다 순서입니다. 값이 아니라
        # 이름으로만 세우고, 동명이인은 역할로 갈라 순서를 고정합니다.
        "people": sorted(entries, key=lambda p: (p["name"], p["role"])),
    }
