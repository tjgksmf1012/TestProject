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
    "bg": "--bg",
    "기준면": "--chrome-side",
    "선택줄": "--chrome-sel",
}

#: `--토큰: 값;  /* … */` — 선언과 **바로 뒤에 붙은** 주석.
#:
#: ⚠️ 주석이 같은 줄에서 시작해야 합니다(`[ \t]*`). `\s*` 로 두면 주석 없는
#: 선언이 저 아래 문단 주석을 자기 것으로 삼습니다.
DECL = re.compile(r"(--[a-z0-9-]+)\s*:\s*([^;]+);[ \t]*/\*(.*?)\*/", re.S)

#: 주석 안의 주장. **한 줄에 여러 개** 있을 수 있습니다 —
#: `--chrome-live` 는 기준면과 선택줄 두 곳에서의 대비를 함께 적습니다.
#:
#: ⚠️ 처음엔 선언과 주장을 정규식 하나로 묶어 잡았고, 그래서 **둘째 주장은
#: 아예 안 걸렸습니다.** 안 걸린 주장은 틀려도 통과합니다 — 이 파일이
#: 막으려던 바로 그 모양(주석과 색이 갈라진다)이 검사 안에 생긴 것입니다.
#:
#: ⚠️ `bg` 를 나중에 넣었습니다. 그 전에는 **`--bg`(페이지 바탕) 위 대비를
#: 아무도 주장하지 않았고**, 이 파일은 "주장을 다시 잰다" 만 하므로 주장하지
#: 않은 바탕은 영원히 안 재집니다. 결측색이 페이지 위에서 3.46:1 인 채로
#: 오래 있었던 것이 그래서입니다 (결함 117).
CLAIM = re.compile(r"(surface|primary|gap-tint|bg|기준면|선택줄)\s+(\d+\.\d+):1")


def _claims(text: str) -> list[tuple[str, str, float]]:
    """`(토큰, 바탕 이름, 주장한 비율)` 을 전부 뽑습니다."""
    found: list[tuple[str, str, float]] = []
    for decl in DECL.finditer(text):
        token, comment = decl.group(1), decl.group(3)
        for claim in CLAIM.finditer(comment):
            found.append((token, claim.group(1), float(claim.group(2))))
    return found


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


#: `color-mix(in srgb, var(--a) N%, var(--b))` 한 겹.
#:
#: ⚠️ `srgb` 는 **감마 인코딩된 값끼리** 섞습니다 (선형화하지 않습니다).
#: 선형으로 섞으면 결과가 눈에 띄게 밝아지는데 주장 숫자는 그래도 얼추 맞아서
#: **안 걸립니다** — 그래서 아래 `test_the_mix_matches_the_browser` 가 브라우저
#: 픽셀을 못 박아 둡니다.
MIX = re.compile(
    r"color-mix\(\s*in\s+srgb\s*,\s*var\((--[a-z0-9-]+)\)\s+(\d{1,3})%\s*,"
    r"\s*var\((--[a-z0-9-]+)\)\s*\)"
)


def _hex_to_rgb(value: str) -> tuple[int, int, int]:
    v = value.lstrip("#")
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
    return int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16)


def _resolve(name: str, css_light: str, css_dark: str, *, dark: bool) -> str | None:
    """토큰 → 최종 hex. `var(--x)`·`color-mix()` 를 풀고, 어두운 모드면 덮어씁니다."""
    light_raw = _raw_values(css_light)
    dark_raw = _raw_values(css_dark) if dark else {}

    # ⚠️ 참조 표에 **선언 전부**를 담습니다. 예전에는 `var(--x)` 한 모양만
    # 담아서, Layer 2 가 `color-mix` 로 파생되는 순간 값을 못 풀었습니다.
    refs = {
        m.group(1): m.group(2).strip()
        for m in re.finditer(r"(--[a-z0-9-]+)\s*:\s*([^;{}]+);", css_light)
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
            expr = refs[cur]
            mix = MIX.search(expr)
            if mix is not None:
                a = _resolve(mix.group(1), css_light, css_dark, dark=dark)
                b = _resolve(mix.group(3), css_light, css_dark, dark=dark)
                if a is None or b is None:
                    return None
                w = int(mix.group(2)) / 100
                return "#" + "".join(
                    f"{round(ca * w + cb * (1 - w)):02x}"
                    for ca, cb in zip(_hex_to_rgb(a), _hex_to_rgb(b), strict=True)
                )
            var = re.fullmatch(r"var\((--[a-z0-9-]+)\)", expr)
            if var is None:
                return None
            cur = var.group(1)
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
    claims = [(c, False) for c in _claims(light)]
    claims += [(c, True) for c in _claims(dark)]

    assert len(claims) >= 18, (
        f"대비 주장을 {len(claims)}개밖에 못 찾았습니다. 주석 모양이 바뀌었으면 "
        "이 검사도 같이 고치십시오 — 아무것도 못 찾은 검사는 언제나 통과합니다."
    )

    wrong: list[str] = []
    for (token, base_word, claimed), is_dark in claims:
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


def test_the_mix_matches_the_browser(css: str):
    """`color-mix` 를 **파이썬이 브라우저와 같게** 푸는가.

    위 검사는 전부 `_resolve` 위에 서 있습니다. 그러니 `_resolve` 가 틀리면
    주장 스무 개가 **한꺼번에 조용히** 틀립니다 — 이 저장소가 반복해 당한
    "측정 방법이 틀리면 헛다리를 짚는다" 의 가장 비싼 형태입니다.

    ⚠️ 함정은 색 공간입니다. 선형 보간으로 바꿔 심어 보니 `#8f633d` 가
    나왔고(브라우저는 `#775939`), 그런데도 대비 주장들은 얼추 맞아서
    **위 검사만으로는 안 걸렸습니다.**

    그래서 Chromium 이 실제로 칠한 픽셀을 못 박습니다. 캔버스에 칠하고
    `getImageData` 로 읽은 값입니다 (scratchpad `gap-n.mjs`) —
    `getComputedStyle` 로 재면 안 됩니다. `color-mix` 는 Chromium 에서
    `color(srgb 0.46 0.35 0.22)` 라는 **0~1 실수**로 나오고, 그걸 0~255 로
    읽으면 전부 검정에 가깝게 잡힙니다 (실제로 한 번 그렇게 틀렸습니다).
    """
    light, dark = _blocks(css)
    for token, want_light, want_dark in [("--gap", "#785539", "#ceac8a")]:
        got_light = _resolve(token, light, dark, dark=False)
        got_dark = _resolve(token, light, dark, dark=True)
        assert got_light == want_light, (
            f"{token} 을 밝은 모드에서 {got_light} 로 풀었는데 "
            f"브라우저는 {want_light} 을 칠합니다"
        )
        assert got_dark == want_dark, (
            f"{token} 을 어두운 모드에서 {got_dark} 로 풀었는데 "
            f"브라우저는 {want_dark} 을 칠합니다"
        )


#: 본문에서 **문장을 이고 다니는** 색들. 화면은 이것들을 `color:` 로 씁니다.
#:
#: ⚠️ 껍데기 색(`--chrome-*`)·바탕 위 글자(`--on-semantic`·`--primary-fg`)·
#: 아이콘용(`--line-strong`)은 여기 없습니다. 그것들은 **다른 바탕**에
#: 앉으므로 각자 자기 검사가 따로 있습니다.
BODY_INKS = ("--text", "--text-muted", "--text-subtle", "--ok", "--warn", "--bad", "--gap")

#: 본문 글자가 실제로 앉는 면 둘. 렌더해서 확인한 결과 이 둘과, `--gap` 14%
#: 띠(배지)뿐이었습니다. 띠는 이 둘보다 대비가 낮으므로 여기를 통과하면
#: 띠도 통과하는 것은 아닙니다 — 그래서 아래에서 띠도 같이 잽니다.
BODY_BEDS = ("--bg", "--surface")


def test_every_body_ink_reads_on_every_body_bed(css: str):
    """⭐ **문장을 이고 다니는 색은 본문 면에서 읽혀야 합니다** (결함 117).

    이 파일의 다른 검사들은 전부 "**주석이 주장한 것**을 다시 잽니다".
    좋은 규칙이지만 구멍이 하나 있습니다 — **주장하지 않은 바탕은 영원히
    안 재집니다.**

    실제로 그랬습니다. `--gap` 은 `gap-tint 3.04:1` 하나만 주장했고,
    그래서 아무도 `--bg`·`--surface` 위에서 재지 않았습니다. 그동안 화면
    여덟이 그 색으로 **문장을 찍고 있었습니다**:

        "기여도에 반영 안 됨"    3.80:1
        "측정하지 못했습니다"     3.46:1
        "커버리지 42% — …"       3.80:1

    하필 결측을 **설명하는** 문장들이라, 안 읽히면 "측정 불가 ≠ 0점" 이라는
    이 제품의 약속이 화면에서 사라집니다.

    그래서 이 검사는 주석을 안 봅니다. **목록을 들고 직접 잽니다.**
    """
    light, dark = _blocks(css)
    weak: list[str] = []

    for ink in BODY_INKS:
        for is_dark in (False, True):
            mode = "어두운" if is_dark else "밝은"
            fg = _resolve(ink, light, dark, dark=is_dark)
            assert fg is not None, f"{ink} 을 못 풀었습니다"

            for bed in BODY_BEDS:
                bg = _resolve(bed, light, dark, dark=is_dark)
                assert bg is not None, f"{bed} 을 못 풀었습니다"
                ratio = contrast(fg, bg)
                if ratio < 4.5:
                    weak.append(f"[{mode}] {ink} on {bed}: {ratio:.2f}:1")

    assert weak == [], (
        "본문 글자가 안 읽힙니다 (하한 4.5:1) — "
        + " | ".join(weak)
        + ". 이 색으로 문장을 찍는 화면이 있습니다. 색을 짙게 하거나, "
        "글자는 읽히는 색으로 두고 신호는 점·띠에 맡기십시오."
    )


#: 화면 CSS — 배지처럼 **자기 색 띠 위에 자기 색 글자**를 얹는 자리를 찾습니다.
SCREEN_CSS = [*sorted(TOKENS.parent.glob("*.html")), TOKENS.parent / "app.css"]

#: `background: color-mix(in srgb, var(--X) N%, transparent)` 와 `color: var(--Y)`
#: 가 **같은 규칙 안에** 있는 모양.
BAND_RULE = re.compile(r"\{([^{}]*)\}")
BAND_BG = re.compile(
    r"background:\s*color-mix\(\s*in\s+srgb\s*,\s*var\((--[a-z0-9-]+)\)\s+(\d{1,3})%\s*,"
    r"\s*transparent\s*\)"
)
BAND_FG = re.compile(r"color:\s*var\((--[a-z0-9-]+)\)")


def test_text_on_a_tinted_band_still_reads(css: str):
    """⭐ **띠 위의 글자**는 카드 위보다 대비가 낮습니다 — 거기서도 재야 합니다.

    확신도 배지(`.badge.low`)와 통화의 `헤드폰 없음` 배지는 **자기 색을 14%
    로 깐 띠 위에 자기 색 글자**를 얹습니다. 카드(`--surface`)보다 어두운
    바탕이라 같은 색이라도 더 안 읽힙니다 — 결함 117 에서 여기가 3.25:1 로
    가장 나빴습니다.

    ⚠️ **띠 목록을 손으로 적지 않습니다.** 처음에 "본문 색 전부에 대해 자기
    14% 띠" 를 재게 했더니 `--text-subtle` 이 4.24:1 로 걸렸는데, 그런 띠는
    **저장소에 없습니다.** 있지도 않은 바탕을 재서 낸 실패였습니다. 지금은
    화면 CSS 를 읽어 **실제로 쓰인 (띠 색, 글자 색) 짝**만 잽니다.
    """
    light, dark = _blocks(css)

    pairs: list[tuple[str, str, int, str]] = []
    for path in SCREEN_CSS:
        text = path.read_text(encoding="utf-8")
        for rule in BAND_RULE.finditer(text):
            body = rule.group(1)
            bg, fg = BAND_BG.search(body), BAND_FG.search(body)
            if bg is not None and fg is not None:
                pairs.append((fg.group(1), bg.group(1), int(bg.group(2)), path.name))

    assert pairs, (
        "띠 위 글자를 한 짝도 못 찾았습니다. `.badge.low` 가 아직 있는데 못 찾았다면 "
        "이 검사의 정규식이 낡은 것입니다 — 아무것도 못 찾은 검사는 언제나 통과합니다."
    )

    weak: list[str] = []
    for ink, tint, pct, where in pairs:
        for is_dark in (False, True):
            mode = "어두운" if is_dark else "밝은"
            fg = _resolve(ink, light, dark, dark=is_dark)
            band_ink = _resolve(tint, light, dark, dark=is_dark)
            # 띠는 `transparent` 와 섞이므로 **뒤에 있는 면**이 비칩니다.
            # 배지가 앉는 면은 카드입니다.
            card = _resolve("--surface", light, dark, dark=is_dark)
            assert fg is not None and band_ink is not None and card is not None
            w = pct / 100
            band = "#" + "".join(
                f"{round(a * w + b * (1 - w)):02x}"
                for a, b in zip(_hex_to_rgb(band_ink), _hex_to_rgb(card), strict=True)
            )
            ratio = contrast(fg, band)
            if ratio < 4.5:
                weak.append(f"[{mode}] {where}: {ink} on {tint} {pct}% 띠 = {ratio:.2f}:1")

    assert weak == [], "띠 위 글자가 안 읽힙니다 (하한 4.5:1) — " + " | ".join(weak)


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


def test_the_count_pill_reads_on_the_accent_it_sits_on(css: str):
    """개수 알약 — **글자색을 따로 두지 않기로 한 결정**을 붙들어 둡니다.

    채널 옆 "3" 알약은 바탕이 `--chrome-accent`, 글자가 `--chrome-side`
    입니다. 글자색 토큰을 따로 뽑았더니 `#161c1d` 가 나왔는데 기준면과
    파랑 한 칸 차이여서, 대비가 대칭인 점을 이용해 기준면을 그대로 썼습니다.

    ⚠️ 그래서 이 쌍에는 **`--토큰: 값; /* 주장 */` 이 없습니다.** 위의
    주석 검사가 못 보는 자리라는 뜻이고, 그러면 강조색을 손보는 날 알약이
    조용히 안 읽히게 됩니다. 여기서 직접 잽니다.
    """
    light, dark = _blocks(css)
    fg = _resolve("--chrome-side", light, dark, dark=False)
    bg = _resolve("--chrome-accent", light, dark, dark=False)
    assert fg is not None and bg is not None

    ratio = contrast(fg, bg)
    assert ratio >= 4.5, (
        f"개수 알약이 {ratio:.2f}:1 입니다. 11px 굵은 글자라 큰 글자 예외"
        "(3:1)를 못 씁니다 — 4.5:1 이 하한입니다."
    )


def test_the_channel_dots_are_visible_on_both_the_list_and_the_selected_row(css: str):
    """채널 상태 점 셋이 **두 바탕 위 모두**에서 보이는가.

    점은 기본 줄(`--chrome-side`) 위에도, 지금 보고 있는 회의의 선택 줄
    (`--chrome-sel`) 위에도 놓입니다. 기준면만 재고 넘어가면 **선택된
    회의의 점만 안 보이는** 상태가 됩니다 — 하필 지금 보고 있는 그 줄에서.

    점은 글자가 아니라 UI 컴포넌트라 하한이 3:1 입니다 (WCAG 1.4.11).
    """
    light, dark = _blocks(css)
    weak: list[str] = []
    for dot in ("--chrome-live", "--chrome-bad", "--chrome-accent", "--chrome-subtle"):
        color = _resolve(dot, light, dark, dark=False)
        assert color is not None, f"{dot} 을 못 풀었습니다"
        for bed, need in (("--chrome-side", 4.5), ("--chrome-sel", 3.0)):
            base = _resolve(bed, light, dark, dark=False)
            assert base is not None
            ratio = contrast(color, base)
            if ratio < need:
                weak.append(f"{dot} on {bed}: {ratio:.2f}:1 (필요 {need})")

    assert weak == [], "채널 점이 안 보입니다 — " + " | ".join(weak)
