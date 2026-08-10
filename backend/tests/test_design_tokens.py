"""디자인 토큰이 **스스로 주장하는 대비를 실제로 내는가**.

`frontend/public/tokens.css` 는 맨 위에 이렇게 적어 뒀습니다.

    ⚠️ 모든 색은 계산값입니다. 눈으로 고른 값은 하나도 없습니다.
    스파이크에서 눈으로 골랐다가 `--line` 대비를 1.46:1 로 만들었고,
    그건 이 파일이 고치려던 결함 그 자체였습니다.

그런데 그 주장을 **아무도 다시 재지 않았습니다.** 값 하나를 손으로 고치면
옆의 `/* surface 7.02:1 ✅ */` 는 그대로 남습니다. 주석은 안 틀리고 색만
틀립니다 — 이 저장소가 여러 번 당한 "두 벌이 갈라진다" 그대로입니다.

그래서 파일이 적어 둔 비율을 **매번 다시 잽니다.**
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

TOKENS = Path(__file__).resolve().parents[2] / "frontend" / "public" / "tokens.css"

#: 주석에 쓰인 바탕 이름 → 토큰 이름.
#: 파일이 사람 말로 적어 둔 것을 기계가 읽을 수 있게 잇습니다.
BASE_ALIASES = {
    "surface": "--surface",
    "primary": "--primary",
    "gap-tint": "--gap-tint",
    "기준면": "--chrome-side",
}

#: `--토큰: 값;  /* … 바탕 N.NN:1 … */` 한 줄에서 주장 하나를 뽑습니다.
CLAIM = re.compile(
    r"(--[a-z0-9-]+)\s*:\s*([^;]+);\s*/\*[^*]*?"
    r"(surface|primary|gap-tint|기준면)\s+(\d+\.\d+):1"
)


def _rel_lum(hex_color: str) -> float:
    v = hex_color.lstrip("#")
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
    parts = [int(v[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in parts]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contrast(a: str, b: str) -> float:
    la, lb = _rel_lum(a), _rel_lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def _blocks(css: str) -> tuple[str, str]:
    """(밝은 모드에서 유효한 부분, 어두운 블록) 으로 가릅니다."""
    dark_at = css.index("@media (prefers-color-scheme: dark)")
    return css[:dark_at], css[dark_at:]


def _raw_values(text: str) -> dict[str, str]:
    """`--토큰: #hex;` 만 모읍니다. `var(...)` 참조는 여기 안 들어옵니다."""
    return {
        m.group(1): m.group(2).strip()
        for m in re.finditer(r"(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;", text)
    }


def _resolve(name: str, css_light: str, css_dark: str, *, dark: bool) -> str | None:
    """토큰 → 최종 hex. `var(--x)` 한 겹을 풀고, 어두운 모드면 덮어씁니다."""
    light_raw = _raw_values(css_light)
    dark_raw = _raw_values(css_dark) if dark else {}

    refs = {
        m.group(1): m.group(2)
        for m in re.finditer(r"(--[a-z0-9-]+)\s*:\s*var\((--[a-z0-9-]+)\)\s*;", css_light)
    }

    seen: set[str] = set()
    cur = name
    while cur not in seen:
        seen.add(cur)
        if cur in dark_raw:
            return dark_raw[cur]
        if cur in light_raw:
            return light_raw[cur]
        if cur in refs:
            cur = refs[cur]
            continue
        return None
    return None


@pytest.fixture(scope="module")
def css() -> str:
    return TOKENS.read_text(encoding="utf-8")


def test_the_file_still_says_its_colors_are_calculated(css: str):
    """⚠️ 이 검사의 전제가 파일에 남아 있는지부터 봅니다.

    전제가 사라졌는데 검사만 남으면, 무엇을 지키는지 모르는 검사가 됩니다.
    """
    assert "모든 색은 계산값입니다" in css


def test_every_contrast_claim_in_the_file_is_true(css: str):
    """⭐ 주석이 적어 둔 비율을 **전부 다시 잽니다** (밝은 모드).

    값을 손으로 고치면 옆의 비율 주석은 그대로 남습니다. 주석은 안 틀리고
    색만 틀리는데, 화면에서는 색이 이깁니다.
    """
    light, dark = _blocks(css)

    # ⚠️ **어두운 블록에 적힌 주장은 어두운 값으로 재야 합니다.**
    # 처음엔 둘을 한 자루에 담아 전부 밝은 값으로 쟀고, 그래서 다크의
    # `--primary-fg 7.83:1` 을 밝은 값(#ffffff)으로 재서 7.70 이 나왔습니다.
    # **파일이 틀린 게 아니라 이 검사가 틀렸습니다.** 이 저장소가 스물세 번
    # 겪은 그것입니다 — 새 검사 도구를 쓸 때마다 그 도구부터 틀립니다.
    claims = [(m, False) for m in CLAIM.finditer(light)]
    claims += [(m, True) for m in CLAIM.finditer(dark)]

    assert len(claims) >= 12, (
        f"대비 주장을 {len(claims)}개밖에 못 찾았습니다. 주석 모양이 바뀌었으면 "
        "이 검사도 같이 고치십시오 — 아무것도 못 찾은 검사는 언제나 통과합니다."
    )

    wrong: list[str] = []
    for m, is_dark in claims:
        token, base_word, claimed = m.group(1), m.group(3), float(m.group(4))
        base = BASE_ALIASES[base_word]
        mode = "어두운" if is_dark else "밝은"

        fg = _resolve(token, light, dark, dark=is_dark)
        bg = _resolve(base, light, dark, dark=is_dark)
        if fg is None or bg is None:
            wrong.append(f"{token} 또는 {base} 의 값을 못 풀었습니다")
            continue

        actual = contrast(fg, bg)
        # 0.05 는 반올림 여유입니다. 그보다 크게 벌어지면 주석이 낡은 것입니다.
        if abs(actual - claimed) > 0.05:
            wrong.append(
                f"[{mode}] {token} on {base}: 주석은 {claimed}:1 인데 실제는 {actual:.2f}:1"
            )

    assert wrong == [], "대비 주석이 실제 색과 다릅니다 — " + " | ".join(wrong)


def test_the_chrome_ladder_does_not_flip_in_dark_mode(css: str):
    """⚠️ 껍데기는 **두 모드 다 짙어야** 합니다. 뒤집히면 안 됩니다.

    밝은 모드에서 껍데기까지 밝아지면 표면 네 겹이 뭉개집니다 — 실험판
    v3 에서 실제로 그렇게 됐고, 채널 목록과 본문이 구분되지 않았습니다.
    """
    light, dark = _blocks(css)
    chrome = [n for n in _raw_values(light) if n.startswith("--chrome-")]
    assert len(chrome) >= 8, f"껍데기 토큰을 {len(chrome)}개밖에 못 찾았습니다"

    flipped = sorted(set(chrome) & set(_raw_values(dark)))
    assert flipped == [], (
        f"껍데기 토큰이 어두운 모드에서 다시 정의됐습니다: {flipped}. "
        "껍데기는 뒤집히지 않는 것이 설계입니다 (docs/19 §4)."
    )


def test_a_gap_is_still_clay_not_red_even_on_the_chrome(css: str):
    """⭐ **결측은 빨강이 아닙니다.** 껍데기 위에서도 흙빛입니다.

    `tokens.css` 가 그렇게 적어 뒀습니다 — 녹음이 끊긴 것은 오류가 아니라
    결측이고, 빨강으로 그리면 사람은 "고장 났다" 로 읽습니다. 고장이 아니라
    "이 구간은 잴 수 없었다" 입니다 (docs/05 §5 — 측정 불가 ≠ 0점).

    그런데 껍데기가 새로 생기면서 **그 위에서도 보이는지**는 아무도 안
    쟀습니다. 안 보이면 결국 다른 색을 쓰게 되고, 그 다른 색은 빨강이
    되기 쉽습니다.
    """
    light, dark = _blocks(css)
    side = _resolve("--chrome-side", light, dark, dark=False)
    assert side is not None

    for mode, is_dark in (("밝은", False), ("어두운", True)):
        clay = _resolve("--clay-600", light, dark, dark=is_dark)
        assert clay is not None
        ratio = contrast(clay, side)
        assert ratio >= 3.0, (
            f"{mode} 모드의 결측색 {clay} 이 껍데기({side}) 위에서 {ratio:.2f}:1 "
            "입니다. 3:1 미만이면 안 보이고, 안 보이면 누군가 빨강으로 바꿉니다."
        )


def test_the_chrome_surfaces_step_by_the_ladder_this_file_uses(css: str):
    """표면 사다리는 **대비비가 아니라 명도 간격**으로 잽니다.

    ⚠️ 이 파일의 기준은 "HSL 명도 간격 3.1% (지시서 §4.1 의 2~4%)" 입니다.
    표면끼리를 대비비로 재면 1.09:1 이 나오는데, 그걸 미달로 신고하면
    **잣대가 틀린 것**입니다. 실제로 한 번 그렇게 신고할 뻔했습니다.
    """
    import colorsys

    light, dark = _blocks(css)

    def lightness(name: str) -> float:
        value = _resolve(name, light, dark, dark=False)
        assert value is not None, f"{name} 을 못 풀었습니다"
        v = value.lstrip("#")
        r, g, b = (int(v[i : i + 2], 16) / 255 for i in (0, 2, 4))
        return colorsys.rgb_to_hls(r, g, b)[1] * 100

    base = lightness("--chrome-side")

    rail = abs(lightness("--chrome-rail") - base)
    assert 2.0 <= rail <= 4.5, (
        f"레일과 채널 목록의 명도 간격이 {rail:.1f}% 입니다. 사다리는 2~4% 입니다."
    )

    # 호버·선택은 사다리가 아니라 **상호작용 상태**입니다. 눈에 띄어야 하므로
    # 사다리보다 크게 벌립니다.
    for name in ("--chrome-hover", "--chrome-sel"):
        gap = abs(lightness(name) - base)
        assert gap >= 4.0, (
            f"{name} 이 기준면과 {gap:.1f}% 밖에 안 떨어졌습니다. "
            "상태는 사다리보다 크게 벌려야 눈에 띕니다."
        )
