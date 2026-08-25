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


# ══════════════════════════════════════════════════════════════════════
# 리디자인 SPA 팔레트 (`webapp/src/app.css`)
#
# ⚠️ **이 팔레트는 여태 아무도 안 쟀습니다.** 위의 검사들은 전부
# `frontend/public/tokens.css` 만 읽습니다. 주 화면 아홉의 새 얼굴은
# `webapp/` 이고 색은 거기 따로 적혀 있는데, 그쪽에는 대비를 재는 코드가
# 한 줄도 없었습니다 — 이 저장소가 여러 번 당한 "두 벌이 있으면 한쪽만
# 고쳐진다" 그대로입니다. 레거시가 결함 117 로 이미 겪고 고친 문제
# (결측색이 글자 하한 아래)가 SPA 에 **그대로 다시 있었습니다.**
#
# ⚠️ 색 계산은 **위의 `contrast()` 를 그대로 씁니다.** 두 벌로 만들면
# 언젠가 한쪽만 고쳐집니다.
# ══════════════════════════════════════════════════════════════════════

SPA = Path(__file__).resolve().parents[2] / "webapp" / "src" / "app.css"
#: 레거시 화면(녹음·통화·`demo/`)이 쓰는 공용 스타일.
LEGACY_APP_CSS = Path(__file__).resolve().parents[2] / "frontend" / "public" / "app.css"

#: 본문 글자로 쓰는 색.
#:
#: ⚠️ `--c-ink-faint-base`·`--c-unknown-base` 는 **여기 없습니다** — 재료라
#: 글자로 쓰면 안 되고, 그 규칙은 아래 `test_spa_..._재료를_직접_쓰지_않는가`
#: 가 따로 잽니다.
SPA_INKS = ("--c-ink", "--c-ink-muted", "--c-ink-faint", "--c-unknown", "--c-ok")

#: 그 글자가 놓이는 바탕. 네 면 전부입니다 — 하나라도 빼면 **뺀 면에서만
#: 안 읽히는** 상태가 영원히 안 잡힙니다 (결함 117 이 그렇게 오래 남았습니다).
SPA_BEDS = ("--c-paper", "--c-surface", "--c-surface-raised", "--c-sunken")

#: 띠 위에 같은 뜻의 글자가 얹히는 자리 (칩·알림 배너).
SPA_TINTED = (
    ("--c-unknown", "--c-unknown-tint"),
    ("--c-evidence", "--c-evidence-tint"),
    ("--c-danger", "--c-danger-tint"),
    ("--c-ok", "--c-ok-tint"),
)


def _brace_block(css: str, start_at: int) -> str:
    """`{` 부터 짝이 맞는 `}` 까지."""
    open_at = css.index("{", start_at)
    depth = 0
    for i in range(open_at, len(css)):
        if css[i] == "{":
            depth += 1
        elif css[i] == "}":
            depth -= 1
            if depth == 0:
                return css[open_at : i + 1]
    raise AssertionError("닫는 중괄호를 못 찾았습니다")


def _spa_declarations(block: str) -> dict[str, str]:
    return {
        m.group(1): m.group(2).strip()
        for m in re.finditer(r"(--[a-z0-9-]+)\s*:\s*([^;{}]+);", block)
    }


def _spa_blocks(css: str) -> tuple[dict[str, str], dict[str, str]]:
    """(밝은 선언, 어두운 선언).

    ⚠️ **어두운 블록이 두 곳**입니다 — `:root[data-theme="dark"]`(사람이 고른
    것)과 `@media (prefers-color-scheme: dark)`(기계 설정). 위쪽 `_blocks()`
    처럼 "미디어 쿼리에서 자른다" 로 가르면 `[data-theme]` 블록이 **밝은
    쪽에 섞여** 밝은 값이 통째로 다크 값으로 오염됩니다. 그래서 여는
    선택자를 이름으로 집습니다.
    """
    light = _spa_declarations(_brace_block(css, css.index(":root {")))
    dark = _spa_declarations(_brace_block(css, css.index(':root[data-theme="dark"]')))
    return light, dark


def _spa_resolve(name: str, light: dict[str, str], dark: dict[str, str], *, mode: str) -> str:
    decls = dict(light)
    if mode == "dark":
        decls.update(dark)

    seen: set[str] = set()
    cur = name
    while cur not in seen:
        seen.add(cur)
        expr = decls.get(cur)
        assert expr is not None, f"[{mode}] {name} → {cur} 을 못 찾았습니다"
        if expr.startswith("#"):
            return expr
        mix = MIX.search(expr)
        if mix is not None:
            a = _spa_resolve(mix.group(1), light, dark, mode=mode)
            b = _spa_resolve(mix.group(3), light, dark, mode=mode)
            w = int(mix.group(2)) / 100
            return "#" + "".join(
                f"{round(ca * w + cb * (1 - w)):02x}"
                for ca, cb in zip(_hex_to_rgb(a), _hex_to_rgb(b), strict=True)
            )
        var = re.fullmatch(r"var\((--[a-z0-9-]+)\)", expr)
        assert var is not None, f"[{mode}] {cur} 의 값을 못 읽었습니다: {expr}"
        cur = var.group(1)
    raise AssertionError(f"[{mode}] {name} 이 자기를 참조합니다")


@pytest.fixture(scope="module")
def spa() -> str:
    return SPA.read_text(encoding="utf-8")


def test_spa_body_ink_reads_on_every_body_bed(spa: str):
    """SPA 의 본문 글자색이 **네 면 전부**에서 4.5:1 을 넘는가.

    ⚠️ 처음 재 봤을 때 밝은 모드 93건·어두운 모드 69건이 미달이었습니다.
    종류로는 열아홉 가지 — 칸반 열의 개수, 타임라인의 시각, 후보의 출처와
    신뢰도, 역할 이름, 카드의 표식처럼 **하필 뜻을 나르는 11~12px 글자**
    들이었습니다. 화면은 "조용한 회색" 이라고 생각하고 썼고, 아무도 재지
    않았습니다.
    """
    light, dark = _spa_blocks(spa)
    weak: list[str] = []
    for mode in ("light", "dark"):
        for ink in SPA_INKS:
            fg = _spa_resolve(ink, light, dark, mode=mode)
            for bed in SPA_BEDS:
                bg = _spa_resolve(bed, light, dark, mode=mode)
                ratio = contrast(fg, bg)
                if ratio < 4.5:
                    weak.append(f"[{mode}] {ink} on {bed}: {ratio:.2f}:1")

    assert weak == [], (
        "SPA 본문 글자가 안 읽힙니다 (하한 4.5:1) — " + " | ".join(weak)
    )


def test_spa_text_on_a_tinted_chip_still_reads(spa: str):
    """띠 위 글자.

    ⚠️ 흙빛이 제 띠 위에서 3.75:1 이었습니다. 흰 바탕(4.20:1)만 재고
    넘어가면 **칩 안에서만 안 읽히는** 상태가 남습니다 — 그리고 결측을
    설명하는 말은 대부분 칩 안에 있습니다.
    """
    light, dark = _spa_blocks(spa)
    weak: list[str] = []
    for mode in ("light", "dark"):
        for ink, tint in SPA_TINTED:
            fg = _spa_resolve(ink, light, dark, mode=mode)
            bg = _spa_resolve(tint, light, dark, mode=mode)
            ratio = contrast(fg, bg)
            if ratio < 4.5:
                weak.append(f"[{mode}] {ink} on {tint}: {ratio:.2f}:1")

    assert weak == [], "칩 안 글자가 안 읽힙니다 (하한 4.5:1) — " + " | ".join(weak)


def test_spa_a_filled_button_label_reads_on_every_fill(spa: str):
    """채운 버튼의 글자 — **의미색 셋 전부**.

    ⚠️ `--c-ink-inverse` 는 다크에서 **어두운 색으로 뒤집힙니다**(#121319).
    채움도 같이 밝아지므로 두 모드 다 재야 합니다.

    ⚠️ 예전에는 `--c-evidence` 하나만 쟀습니다. 그동안 위험 버튼은
    `color: #fff` 를 손으로 적어 두고 있었고, 다크에서 밝은 빨강 위 흰
    글자가 **3.26:1** 이었습니다 — 하필 "내 녹음과 성문 지우기", 되돌릴 수
    없는 버튼입니다. 재는 자리가 하나 모자라면 안 재는 자리가 남습니다.
    """
    light, dark = _spa_blocks(spa)
    weak: list[str] = []
    for mode in ("light", "dark"):
        fg = _spa_resolve("--c-ink-inverse", light, dark, mode=mode)
        for fill in ("--c-evidence", "--c-danger", "--c-ok"):
            bg = _spa_resolve(fill, light, dark, mode=mode)
            ratio = contrast(fg, bg)
            if ratio < 4.5:
                weak.append(f"[{mode}] --c-ink-inverse on {fill}: {ratio:.2f}:1")

    assert weak == [], "채운 버튼 글자가 안 읽힙니다 — " + " | ".join(weak)


def test_spa_a_pressable_button_is_never_dimmed_by_opacity(spa: str):
    """⛔ 누를 수 있는 것을 `opacity` 로 흐리게 하지 않았는가.

    ⚠️ **대비 검사가 못 잡는 구멍입니다.** `opacity` 는 글자와 채움을 같이
    바탕 쪽으로 끌어당기므로 색 토큰은 그대로인데 눈에 보이는 대비만
    떨어집니다 — `getComputedStyle().color` 를 읽는 감사는 0건이라고
    답합니다. 실제로 "이 값으로 확정" 버튼이 **2.57:1** 인 채로 그렇게
    통과하고 있었습니다.

    이 저장소의 "조건 미충족" 버튼은 `aria-disabled` 라 **초점도 받고 눌리기도
    합니다** (누르면 첫 빈 칸으로 데려갑니다). 그러니 WCAG 1.4.3 의 비활성
    컨트롤 예외를 쓸 수 없습니다. 흐리게 하지 말고 **모양**을 바꾸세요.

    ⚠️ 정말로 못 누르는 것은 예외입니다 — 예외의 경계는 "보기에 흐린가" 가
    아니라 **누를 수 있는가** 입니다. 그래서 같은 규칙이 `pointer-events:
    none` 을 걸었거나 선택자가 HTML `:disabled` 인 경우만 통과시킵니다.

    ⚠️ **두 팔레트를 다 봅니다.** 레거시 `app.css` 도 `.btn[aria-disabled=
    "true"]` 를 0.45 로 흐리고 있었습니다 — 같은 결함이 두 곳에 있었고,
    SPA 만 고쳤으면 녹음·통화 화면은 그대로였습니다.
    """
    dim: list[str] = []
    legacy = LEGACY_APP_CSS.read_text(encoding="utf-8")
    for where, css_text in (("webapp", spa), ("frontend", legacy)):
        rules = re.sub(r"/\*.*?\*/", "", css_text, flags=re.S)
        for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", rules):
            selector, body = m.group(1).strip(), m.group(2)
            pressable = (
                "btn" in selector
                or 'role="button"' in selector
                or "aria-disabled" in selector
            )
            if not pressable:
                continue
            if ":disabled" in selector or re.search(r"pointer-events:\s*none", body):
                continue
            for o in re.finditer(r"(?<![-a-z])opacity:\s*([0-9.]+)", body):
                if float(o.group(1)) < 0.8:
                    last = selector.splitlines()[-1].strip()
                    dim.append(f"[{where}] {last} → opacity {o.group(1)}")

    assert dim == [], (
        "누를 수 있는 버튼이 흐려져 있습니다 — " + " | ".join(dim) + ". "
        "`opacity` 대신 채움·테두리·글자색으로 상태를 말하세요."
    )


def test_spa_no_rule_hardcodes_black_or_white_text(spa: str):
    """⛔ 규칙 안에 `color: #fff` · `color: #000` 을 적지 않았는가.

    ⚠️ 팔레트 밖에 적은 날 hex 는 **영영 안 뒤집힙니다.** 채움만 밝아지고
    글자는 흰색으로 남아 다크에서만 안 읽히는 상태가 되고, 자기 모드로
    보고 있는 사람에게는 **보이지 않습니다.** 레거시가 화면 넷에서 겪은
    결함 60 이 이 모양이었고, SPA 에도 하나 있었습니다.

    글자색은 `--c-ink-inverse` 를 쓰십시오 — 그 토큰이 뒤집힙니다.
    """
    palette_end = spa.index("}", spa.index(":root {"))
    # ⚠️ **주석을 먼저 걷어냅니다.** 안 걷으면 "여기 `color: #fff` 가 박혀
    #    있었습니다" 라고 적은 설명 자체가 잡힙니다 — 고친 사실을 적을수록
    #    검사가 빨개지는, 아무도 못 고치는 검사가 됩니다.
    rules = re.sub(r"/\*.*?\*/", "", spa[palette_end:], flags=re.S)
    # ⚠️ `(?<![-a-z])` 가 없으면 `background-color: #fff` 가 같이 걸립니다.
    #    바탕은 이 검사의 대상이 아닙니다 (면은 `--c-surface` 가 정합니다).
    bad = re.findall(r"(?<![-a-z])color:\s*(#(?:fff|ffffff|000|000000))\b", rules, re.I)
    assert bad == [], (
        "규칙에 날 hex 글자색이 있습니다 — " + ", ".join(bad) + ". "
        "`--c-ink-inverse` 를 쓰세요 (다크에서 같이 뒤집힙니다)."
    )


def test_spa_controls_have_a_visible_edge(spa: str):
    """입력창·버튼의 테두리가 보이는가 (UI 컴포넌트 하한 3:1, WCAG 1.4.11).

    ⚠️ `--c-line` 은 **장식선**이라 여기 없습니다. 칸을 가르는 얇은 줄까지
    3:1 을 요구하면 화면이 표가 됩니다 — 재는 것은 "누를 수 있는 것의
    가장자리" 뿐입니다.
    """
    light, dark = _spa_blocks(spa)
    weak: list[str] = []
    for mode in ("light", "dark"):
        edge = _spa_resolve("--c-line-strong", light, dark, mode=mode)
        for bed in ("--c-surface", "--c-paper"):
            bg = _spa_resolve(bed, light, dark, mode=mode)
            ratio = contrast(edge, bg)
            if ratio < 3.0:
                weak.append(f"[{mode}] --c-line-strong on {bed}: {ratio:.2f}:1")

    assert weak == [], "컨트롤 가장자리가 안 보입니다 — " + " | ".join(weak)


def test_spa_the_missing_colour_is_still_clay_not_red(spa: str):
    """⭐ **결측은 빨강이 아닙니다** (AGENTS.md 불변식 ③ · docs/05 §5).

    잉크 쪽으로 밀면서 색이 죽으면 흙빛이 빨강 쪽으로 갈 수 있습니다. 그러면
    "못 쟀다" 가 "네가 뭘 잘못했다" 로 읽힙니다 — 이 제품이 제일 하면 안
    되는 일입니다. 그래서 **위험색과 색상환에서 떨어져 있는지** 잽니다.
    """
    light, dark = _spa_blocks(spa)
    for mode in ("light", "dark"):
        clay = _hex_to_rgb(_spa_resolve("--c-unknown", light, dark, mode=mode))
        red = _hex_to_rgb(_spa_resolve("--c-danger", light, dark, mode=mode))
        gap = abs(_hue(clay) - _hue(red))
        gap = min(gap, 360 - gap)
        assert gap >= 20, (
            f"[{mode}] 결측색이 위험색과 색상 {gap:.0f}° 차이입니다. "
            "빨강으로 읽히면 결측이 오류가 됩니다 — 흙빛을 유지하세요."
        )


def _hue(rgb: tuple[int, int, int]) -> float:
    r, g, b = (c / 255 for c in rgb)
    hi, lo = max(r, g, b), min(r, g, b)
    if hi == lo:
        return 0.0
    d = hi - lo
    if hi == r:
        h = ((g - b) / d) % 6
    elif hi == g:
        h = (b - r) / d + 2
    else:
        h = (r - g) / d + 4
    return h * 60


def test_spa_raw_material_is_never_painted_directly(spa: str):
    """⚠️ 재료값(`--c-*-base`)을 화면이 직접 쓰고 있지 않은가.

    재료는 하한 아래입니다. "직접 쓰지 마십시오" 를 **주석으로만** 적어 두면
    다음 사람이 `var(--c-unknown-base)` 라고 적고, 그 자리만 조용히 3.28:1 로
    돌아갑니다 — 주석은 안 틀리고 색만 틀립니다.
    """
    light, _ = _spa_blocks(spa)
    materials = [name for name in light if name.endswith("-base")]
    assert materials, "재료 토큰이 하나도 없습니다 — 이 검사가 아무것도 안 잽니다"

    palette_end = spa.index("}", spa.index(":root {"))
    rules = spa[palette_end:]
    used = [name for name in materials if f"var({name})" in rules]
    assert used == [], (
        "재료값을 화면이 직접 쓰고 있습니다 — " + ", ".join(used) + ". "
        "파생값(`--c-ink-faint`·`--c-unknown`)을 쓰세요."
    )


def test_spa_both_dark_blocks_say_the_same_thing(spa: str):
    """⚠️ 어두운 값이 **두 곳**에 적혀 있습니다.

    `:root[data-theme="dark"]`(사람이 고른 것)과
    `@media (prefers-color-scheme: dark)`(기계 설정). 두 벌이 있으면
    갈라집니다 — 실제로 이 저장소가 여러 번 당한 모양이고, 갈라져도
    **자기 모드로 보고 있는 사람에게는 안 보입니다.**
    """
    picked = _spa_declarations(_brace_block(spa, spa.index(':root[data-theme="dark"]')))
    system = _spa_declarations(
        _brace_block(spa, spa.index('@media (prefers-color-scheme: dark)'))
    )
    drift = [
        f"{name}: 고른 것 {picked[name]} · 기계 설정 {system.get(name, '없음')}"
        for name in picked
        if picked[name] != system.get(name)
    ]
    assert drift == [], "두 다크 블록이 갈라졌습니다 — " + " | ".join(drift)


def test_spa_the_claims_written_next_to_the_derived_colours_are_true(spa: str):
    """파생색 옆에 적어 둔 비율을 **다시 잽니다.**

    `카드 N:1` 은 밝은 모드의 `--c-surface` 위, `다크 N:1` 은 어두운 모드의
    `--c-surface` 위입니다. 값만 고치고 숫자를 안 고치면 여기서 터집니다 —
    이 파일이 위쪽 팔레트에 대해 하는 일과 같습니다.
    """
    light, dark = _spa_blocks(spa)
    claim = re.compile(r"(카드|다크)\s+(\d+\.\d+):1")
    checked = 0
    for decl in DECL.finditer(spa):
        token, comment = decl.group(1), decl.group(3)
        for m in claim.finditer(comment):
            mode = "light" if m.group(1) == "카드" else "dark"
            said = float(m.group(2))
            fg = _spa_resolve(token, light, dark, mode=mode)
            bg = _spa_resolve("--c-surface", light, dark, mode=mode)
            actual = contrast(fg, bg)
            assert abs(actual - said) < 0.05, (
                f"{token} 이 {m.group(1)} {said}:1 이라고 적어 뒀는데 "
                f"실제는 {actual:.2f}:1 입니다"
            )
            checked += 1

    assert checked >= 4, (
        f"주장을 {checked} 개밖에 못 읽었습니다. 주석 모양이 바뀌면 이 검사는 "
        "아무것도 안 재면서 통과합니다 — 정규식을 고치세요."
    )


def test_no_button_is_dimmed_with_opacity(spa: str):
    """⛔ **버튼을 `opacity` 로 흐리게 하지 않습니다** (결함 236).

    `opacity` 는 글자와 채움을 **같이** 끌어당깁니다. 그래서 색 토큰은
    그대로인데 실제로 읽히는 대비만 무너집니다 — `getComputedStyle` 을
    읽는 감사는 **구조적으로 못 봅니다**(결함 180 에서 이미 당했습니다).

    재 봤습니다. 통화 화면에서 마이크 권한을 거절한 사람의
    「마이크 끄기」가 이랬습니다.

        합성 전 (색 토큰)  17.16:1   ← 감사가 보던 값
        합성 후 (사람이 봄) 2.91:1   ← 밝은 모드
                            3.98:1   ← 어두운 모드

    ⚠️ `disabled` 는 WCAG 1.4.3 의 비활성 예외에 걸리지만, 이 저장소는
    그 예외를 **안 쓰기로 이미 정했습니다** — 같은 앱 안에서 「안 됨」이
    두 가지 얼굴(흐림 · 덜 채운 모양)을 가지면 안 되기 때문입니다
    (`webapp/src/app.css` 의 `.btn--disabled-link` 주석).

    흐림 대신 **모양**으로 말합니다.
    """
    legacy = LEGACY_APP_CSS.read_text(encoding="utf-8")
    bad: list[str] = []
    for name, css in (("webapp/src/app.css", spa), ("frontend/public/app.css", legacy)):
        # 주석을 걷어냅니다 — 이 결함을 **설명하는 주석**이 스스로 걸립니다.
        body = re.sub(r"/\*.*?\*/", " ", css, flags=re.S)
        for block in re.finditer(r"([^{}]+)\{([^{}]*)\}", body):
            selector, decls = block.group(1).strip(), block.group(2)
            if not re.search(r"\bbutton\b|\.btn\b", selector):
                continue
            # 깜빡임(`@keyframes`)은 상태가 아니라 움직임이라 예외입니다.
            m = re.search(r"(?<![-\w])opacity\s*:\s*([0-9.]+)", decls)
            if m and float(m.group(1)) < 1:
                bad.append(f"{name}: `{selector}` 에 opacity {m.group(1)}")
    assert not bad, (
        "버튼을 흐리게 하고 있습니다 — 글자와 채움이 같이 내려가 색 토큰만 "
        "보는 감사는 못 잡습니다. 모양으로 말하세요:\n  " + "\n  ".join(bad)
    )


def test_hover_steps_around_blocked_buttons(spa: str):
    """⛔ **hover 는 막힌 것을 비켜 간다** (결함 239).

    막힌 버튼은 「덜 채운 모양」(`btn--unmet` · `:disabled` 규칙)으로
    말합니다. 그런데 hover 규칙이 채움만 되돌려 놓으면 글자는 잉크색으로
    남아 **사라집니다.** 재 봤습니다 — 마우스를 올린 채로:

        SPA  「검토 끝내기」·「등록」·「이 값으로 확정」·「동의했습니다」
             밝은 1.23:1  ·  어두운 1.25:1
        레거시 「녹음 시작」
             밝은 1.16:1  ·  어두운 1.27:1

    막던 것은 `:not(:disabled)` 하나였습니다. 그건 `disabled` 를 쓰던
    시절의 방패인데, 결함 234·235 에서 막힌 버튼을 전부 `aria-disabled`
    로 옮기면서 **아무것도 안 막게 됐습니다.** 요구가 아니라 방패가
    낡은 것이고, `AGENTS.md` 가 경고하는 바로 그 부류입니다.

    ⚠️ 결함 236 의 사촌입니다. 저기는 `opacity`, 여기는 `:hover` — 둘 다
    **쉬고 있는 상태만 재는 감사**가 구조적으로 못 보는 자리입니다.
    """
    legacy = LEGACY_APP_CSS.read_text(encoding="utf-8")
    bad: list[str] = []
    checked = 0
    for name, css in (("webapp/src/app.css", spa), ("frontend/public/app.css", legacy)):
        # 주석을 걷어냅니다 — 이 결함을 **설명하는 주석**이 스스로 걸립니다.
        body = re.sub(r"/\*.*?\*/", " ", css, flags=re.S)
        for block in re.finditer(r"([^{}]+)\{([^{}]*)\}", body):
            selector, decls = block.group(1).strip(), block.group(2)
            if ":hover" not in selector:
                continue
            if not re.search(r"\bbutton\b|\.btn\b", selector):
                continue
            # 색을 바꾸지 않는 hover(밑줄·그림자)는 모양을 안 무릅니다.
            if not re.search(r"(?<![-\w])(background|color)\s*:", decls):
                continue
            checked += 1
            # ⚠️ 셀렉터가 여럿이면 **하나하나** 봅니다 — 콤마로 묶어 두면
            #    한쪽만 막아 놓고 통과합니다(레거시가 실제로 그랬습니다:
            #    `button:hover:not(:disabled), .btn:hover` — 뒤쪽은 맨몸).
            for one in selector.split(","):
                one = one.strip()
                if ":hover" not in one:
                    continue
                if not re.search(r"\bbutton\b|\.btn\b", one):
                    continue
                if "[aria-disabled" not in one:
                    bad.append(f"{name}: `{one}`")
    assert checked > 0, "hover 규칙을 하나도 안 봤습니다 — 검사가 헛돕니다"
    assert not bad, (
        "막힌 버튼 위에서 hover 가 채움을 되돌립니다 — 글자가 사라집니다. "
        "`:not([aria-disabled='true'])` 를 붙이세요:\n  " + "\n  ".join(bad)
    )


def test_a_destructive_control_differs_when_it_is_just_sitting_there(spa: str):
    """⛔ **되돌릴 수 없는 단추는 쉬고 있을 때도 달라 보여야 합니다** (결함 322).

    ## 무엇이 잘못돼 있었나

    레거시의 `.linkish.danger` 규칙이 **`@media (hover: hover)` 안에만**
    있었습니다. 즉 위험 신호가 **마우스를 올린 사람에게만** 보이고,
    키보드로 도는 사람과 손가락으로 쓰는 사람에게는 평생 안 보입니다.

    쉬고 있는 상태를 재 보니 「강제 종료」(`linkish danger`)와 옆의 평범한
    「칸반 보기」(`linkish`)가 `rgb(102, 109, 128)` 으로 **글자색까지
    똑같았습니다.** 클래스는 꼬박꼬박 붙어 있었고 **아무 색도 안
    나갔습니다** — 결함 250 이 녹음 화면에서 겪은 것과 같은 모양이고,
    이번에는 규칙이 **아예 없던** 쪽입니다.

    ⚠️ 이 자리의 빨강은 불변식 ③ 의 「결측은 빨강이 아니라 흙빛」과 **다른
    자리**입니다. 결측은 「못 잰 것」이고, 이건 「사람이 되돌릴 수 없는 일을
    누르는 것」입니다.

    ## ⚠️ 이 자의 한계

    글자로 잽니다 — 「그 규칙이 실제로 이겼는가」(특성도)까지는 못 봅니다.
    그건 렌더해서 픽셀로 확인했고(밝은 `rgb(176,46,46)` · 다크
    `rgb(224,106,106)`, 다크 대비 5.27:1·5.68:1), 여기서는 **규칙이
    `:hover` 밖에 있는지**만 지킵니다.
    """
    legacy = LEGACY_APP_CSS.read_text(encoding="utf-8")

    # 「되돌릴 수 없다」를 말하는 클래스들. 뿌리마다 이름이 다릅니다.
    # ⚠️ **자를 한 번 조였습니다.** 처음에는 `\.linkish\.danger` 였는데 그
    #    자는 `.linkish.dangerXX` 도 **통과시킵니다** — 규칙 이름을 바꿔
    #    심었더니 초록이 떴습니다. 이름 끝을 못 박습니다.
    WANTED = (
        ("frontend", legacy, r"\.linkish\.danger(?![-\w])"),
        ("webapp", spa, r"\.btn--danger-quiet(?![-\w])"),
    )

    missing: list[str] = []
    for where, css_text, selector_rx in WANTED:
        rules = re.sub(r"/\*.*?\*/", "", css_text, flags=re.S)
        resting = False
        for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", rules):
            selector, body = m.group(1).strip(), m.group(2)
            if not re.search(selector_rx, selector):
                continue
            # ⚠️ `:hover`·`:active`·`:focus` 안에만 있는 것은 **쉬고 있을 때**
            #    아무 말도 안 합니다 — 그게 이 결함이었습니다.
            if re.search(r":(hover|active|focus)", selector):
                continue
            if re.search(r"(?<![-a-z])color:", body):
                resting = True
        if not resting:
            missing.append(
                f"[{where}] {selector_rx} 가 쉬고 있을 때 `color` 를 정하지 않습니다"
            )

    assert missing == [], (
        "되돌릴 수 없는 단추가 **쉬고 있을 때** 평범한 단추와 같아 보입니다 — "
        + " | ".join(missing)
        + ". `:hover` 안에만 적으면 키보드·터치 사용자에게는 영영 안 보입니다."
    )


def test_being_late_is_never_painted_as_blame(spa: str):
    """⛔ **늦은 것을 빨강으로 칠하지 않습니다** (결함 324).

    ## 이 제품이 이미 세 번 내린 결정

    - 결함 319 (칸반): 「늦은 것은 **사실**이지 『네가 뭘 잘못했다』가
      아닙니다」 → `.task .latemark { color: var(--text-subtle) }`
    - SPA 우선순위 칩: 「긴급만 색을 씁니다. **빨강이 아니라 황토** —
      빨강은 "네가 뭘 잘못했다"」 → `.kprio--urgent`
    - 불변식 ③: 결측은 빨강이 아니라 흙빛(`--gap`)

    그런데 **알림 화면만** 「지연」을 `--bad`(빨강)로 그리고 있었습니다.
    같은 사실을 칸반은 옅은 잉크로, 알림은 빨강으로 — 결함 290 이 적어 둔
    「같은 사실을 말하는 두 자리를 나란히 놓으십시오」의 위반이고, 하필
    빨강 쪽이 **그 사람에게 직접 보내는 알림**이었습니다.

    ## ⚠️ 무엇을 재는가

    「빨강을 쓰지 마라」가 아니라 **「늦음·긴급을 뜻하는 자리가 위험색을
    쓰지 마라」**입니다. 위험색 자체는 되돌릴 수 없는 단추에 필요합니다
    (결함 322) — 거기서는 옳습니다.
    """
    ROOT_DIR = LEGACY_APP_CSS.parent   # frontend/public

    # (파일, 선택자, 그 선택자가 무슨 뜻인가) — 뜻을 적어 둡니다.
    PLACES = [
        ("notifications.html", ".nitem.urgent", "`isUrgent` = kind가 overdue — 마감이 지난 알림"),
        ("notifications.html", ".nitem.urgent .nkind", "그 알림의 「지연」 이름표"),
        ("kanban.html", ".task .latemark", "카드의 「마감 지남」·「늦게 완료」"),
    ]
    DANGER = ("--bad", "--c-danger")

    offenders: list[str] = []
    for filename, selector, meaning in PLACES:
        path = ROOT_DIR / filename
        assert path.exists(), f"{filename} 이 없습니다 — 가드가 헛돕니다"
        css = re.sub(r"/\*.*?\*/", "", path.read_text(encoding="utf-8"), flags=re.S)
        found = False
        for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", css):
            sel, body = m.group(1).strip(), m.group(2)
            # 선택자가 정확히 이것인 규칙만 (앞부분만 물지 않게)
            if not any(s.strip() == selector for s in sel.split(",")):
                continue
            found = True
            for token in DANGER:
                if token in body:
                    offenders.append(f"{filename} `{selector}` ({meaning}) → {token}")
        assert found, (
            f"{filename} 에서 `{selector}` 규칙을 못 찾았습니다 — 화면을 옮겼으면 "
            "이 가드의 자리도 같이 고치십시오(결함 286)"
        )

    assert offenders == [], (
        "늦음을 위험색으로 칠하고 있습니다 — " + " | ".join(offenders) + ". "
        "늦은 것은 사실이지 「네가 뭘 잘못했다」가 아닙니다(결함 319·324). "
        "구별은 글자와 잉크 세기로 하십시오."
    )

    # ⭐ SPA 가 같은 결정을 적어 둔 자리도 지킵니다 — 한쪽만 지키면 갈라집니다.
    for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", re.sub(r"/\*.*?\*/", "", spa, flags=re.S)):
        sel, body = m.group(1).strip(), m.group(2)
        if any(s.strip() == ".kprio--urgent" for s in sel.split(",")):
            assert "--c-danger" not in body, (
                "SPA 의 「긴급」 칩이 위험색을 씁니다 — 그 규칙 옆에 "
                "「빨강이 아니라 황토」라고 적혀 있습니다"
            )


def test_the_uncertainty_dots_survive_forced_colors() -> None:
    """⭐ 「점 하나가 4%p」라고 적으면 고대비에서도 **점이 보여야** 한다.

    ## ⛔ 점 열여섯이 통째로 사라졌습니다 (결함 393)

    `.unc-dots i` 는 `background: var(--gap)` 하나로 그려집니다. 그런데
    `forced-colors: active`(고대비)는 채움을 **시스템 배경색으로 덮습니다** —
    밝은 쪽에서는 흰 바탕에 흰색, 다크에서는 검은 바탕에 검은색이라 하나도
    안 보였습니다. 브라우저로 재서 확인했습니다:

        고대비        점 rgb(255,255,255) · body rgb(255,255,255)
        고대비+다크    점 rgb(0,0,0)       · body rgb(0,0,0)

    바로 옆 문구는 「모르는 폭 20%p · **점 하나가 4%p**」입니다.
    `lib/contribution/view.ts` 가 그 자리에 「점을 안 찍는데 "점 하나가
    4%p" 라고 적으면 없는 그림을 설명합니다」라고 적어 두고 **개수가 0인
    경우만** 막고 있었습니다 — 고대비는 개수가 열여섯인데 **안 보이는**
    경우입니다.

    ⚠️ 색이 뜻을 나르는 것이 아닙니다. 뜻은 **개수**이고(「값은 글자로,
    그림은 폭이나 개수만」), 고대비에서도 개수는 셀 수 있어야 합니다.

    ⚠️ 이 검사가 **못 보는 것**: 다른 화면의 작은 그림들. 같은 회차에
    전수로 세어 보니 채움만으로 그려지는 것이 더 있는데(레일 상태 점 ·
    SPA 리본 · 검토 타임라인 점), 그것들은 **뜻이 같은 줄의 글자에**
    있어서 사라져도 사실이 안 없어집니다 — 결함 350 이 레일 점에 대해
    「값이 아니라 장식」이라고 적어 둔 그것입니다.
    """
    html = (
        Path(__file__).resolve().parents[2] / "frontend" / "public" / "contributions.html"
    ).read_text(encoding="utf-8")

    assert ".unc-dots i" in html, "점 규칙이 없습니다 — 이 검사가 낡았습니다"
    forced = re.search(
        r"@media\s*\(\s*forced-colors:\s*active\s*\)\s*\{(?P<body>[^}]*\{[^}]*\}[^}]*)\}",
        html,
    )
    assert forced is not None, (
        "고대비 규칙이 없습니다 — 채움만으로 그린 점은 고대비에서 배경색으로 "
        "덮여 사라지는데, 옆 문구는 「점 하나가 4%p」라고 그 그림을 가리킵니다 "
        "(결함 393)"
    )
    body = forced.group("body")
    assert ".unc-dots i" in body, f"고대비 규칙이 점을 안 다룹니다: {body[:120]}"
    # 시스템 색 이름만 안 덮입니다 — 토큰이나 hex 를 적으면 그대로 사라집니다.
    assert re.search(r"background:\s*(CanvasText|LinkText|Highlight)\b", body), (
        f"고대비 규칙이 시스템 색이 아닌 값을 씁니다: {body[:120]} — "
        "`var(--gap)` 이나 hex 는 그 모드에서 다시 덮입니다"
    )


def test_the_unread_bar_survives_forced_colors() -> None:
    """⭐ 고대비에서도 **어느 줄이 안 읽은 것인지** 보여야 한다.

    ## ⛔ 「안 읽음」이 통째로 사라졌습니다 (결함 399)

    알림 줄의 안 읽음 표시는 왼쪽 2px 막대 하나입니다 — 읽은 줄은
    `border-left: 2px solid transparent`, 안 읽은 줄만 `--primary`.
    그런데 `forced-colors: active` 는 색을 시스템 값으로 덮고 **거기에는
    `transparent` 도 들어갑니다.** 브라우저로 재서 확인했습니다:

        고대비   안읽음 rgb(0,0,0) · 읽음 rgb(0,0,0) · 지연 rgb(0,0,0)

    넷이 전부 같은 검정 막대가 됐습니다. 그런데 바로 위 배지는 **「안 읽은
    알림 2」**라고 말합니다 — 몇 개인지는 아는데 **어느 줄인지** 알 수
    없습니다(결함 393 이 「점 하나가 4%p」에서 만난 그 모양).

    ⚠️ **「지연」은 살아남습니다** — 그 규칙은 `.nkind` 의 **무게**도 한 단
    올리고, 무게는 고대비가 안 덮습니다. 「안 읽음」만 색 하나에 실려
    있었습니다(결함 361: 뜻을 색 하나에 실었으면 고대비로 재 보십시오).

    고친 뒤 네 값이 갈립니다 —

        고대비      안읽음 Highlight(남색) · 읽음 Canvas(흰색=안 보임) · 지연 CanvasText
        고대비+다크  안읽음 Highlight(청록) · 읽음 Canvas(검정=안 보임) · 지연 CanvasText

    ⚠️ 이 검사가 **못 보는 것**: 다른 화면의 「테두리 하나로 말하는」 표시.
    이 회차에는 알림 화면만 셌습니다.
    """
    html = (
        Path(__file__).resolve().parents[2] / "frontend" / "public" / "notifications.html"
    ).read_text(encoding="utf-8")

    assert ".nitem.fresh" in html, "안 읽음 규칙이 없습니다 — 이 검사가 낡았습니다"
    forced = re.search(
        r"@media\s*\(\s*forced-colors:\s*active\s*\)\s*\{(?P<body>(?:[^{}]*\{[^{}]*\})+[^{}]*)\}",
        html,
    )
    assert forced is not None, (
        "고대비 규칙이 없습니다 — 테두리 하나로 말하는 「안 읽음」은 고대비에서 "
        "읽은 줄과 **같은 막대**가 되는데, 배지는 「안 읽은 알림 N」이라고 "
        "그 표시를 가리킵니다 (결함 399)"
    )
    body = forced.group("body")

    # ⚠️ 세 갈래가 **모두** 있어야 갈립니다. 안 읽음만 정하면 읽은 줄의
    #    `transparent` 가 그대로 덮여 둘 다 보이는 막대가 됩니다.
    for needed in (".nitem ", ".nitem.fresh", ".nitem.urgent"):
        assert needed in body, f"고대비 규칙에 `{needed}` 가 없습니다: {body[:160]}"

    # ⚠️ 값을 **넓게** 집습니다. `[A-Za-z]+` 로만 집으면 `var(--primary)` 가
    #    아예 안 잡혀서 「셋 다 안 정했다」는 **엉뚱한 문장**이 나옵니다 —
    #    가드가 가리키는 줄이 틀리면 다음 사람이 그 줄을 보고 「없는데?」 합니다.
    colors = [v.strip() for v in re.findall(r"border-left-color:\s*([^;]+);", body)]
    assert len(colors) >= 3, f"고대비 규칙이 테두리 색을 셋 다 안 정합니다: {colors}"

    # 시스템 색 이름만 안 덮입니다 — 토큰이나 hex 를 적으면 그대로 사라집니다.
    allowed = {"Canvas", "CanvasText", "Highlight", "LinkText", "GrayText"}
    assert set(colors) <= allowed, (
        f"고대비 규칙이 시스템 색이 아닌 값을 씁니다: {sorted(set(colors) - allowed)} — "
        "`var(--primary)` 나 hex 는 그 모드에서 다시 덮입니다"
    )
    # 갈라져야 하는 것이 갈리는가. 같은 색을 셋에 주면 고친 것이 아닙니다.
    assert len(set(colors)) >= 3, (
        f"고대비에서 세 갈래가 같은 색입니다: {colors} — 읽음·안읽음·지연이 "
        "구별되지 않습니다"
    )
