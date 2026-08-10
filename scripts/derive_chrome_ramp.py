"""껍데기(chrome) 색 계단을 **계산해서** 뽑는다.

`tokens.css` 가 맨 위에 이렇게 적어 뒀다 —

    ⚠️ 모든 색은 계산값입니다. 눈으로 고른 값은 하나도 없습니다.
    스파이크에서 눈으로 골랐다가 --line 대비를 1.46:1 로 만들었고,
    그건 이 파일이 고치려던 결함 그 자체였습니다.

내가 실험판에서 고른 색은 전부 눈으로 고른 값이다. 그래서 버리고,
같은 색조(183°)에서 **대비 목표를 만족하는 명도**를 찾아 쓴다.

껍데기는 밝은 모드에서도 어둡다(슬랙이 그렇게 한다). 그래서 Layer 1 의
뒤집히는 램프에 얹을 수 없고, **안 뒤집히는 별도 램프**가 되어야 한다.
"""

from __future__ import annotations

import colorsys

HUE = 183 / 360


def hsl_hex(h: float, s: float, ell: float) -> str:
    r, g, b = colorsys.hls_to_rgb(h, ell, s)
    return f"#{round(r * 255):02x}{round(g * 255):02x}{round(b * 255):02x}"


def rel_lum(hex_color: str) -> float:
    v = hex_color.lstrip("#")
    parts = [int(v[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in parts]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def ratio(a: str, b: str) -> float:
    la, lb = rel_lum(a), rel_lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def find_lightness(base: str, target: float, *, sat: float, lighter: bool) -> tuple[str, float]:
    """`base` 에 대해 목표 대비를 **처음 넘는** 명도를 찾는다.

    0.1% 씩 훑는다 — 눈으로 고르는 것이 아니라 훑어서 찾는다.
    """
    steps = range(1, 1000) if lighter else range(999, 0, -1)
    for i in steps:
        cand = hsl_hex(HUE, sat, i / 1000)
        if ratio(cand, base) >= target:
            return cand, ratio(cand, base)
    raise SystemExit(f"목표 {target}:1 을 만족하는 명도가 없습니다 (base={base})")


# ── 껍데기 바탕 ───────────────────────────────────────────────
# 채널 목록이 껍데기의 기준면이다. 기존 다크 --ink-050(#161c1d, L≈9.8%) 보다
# 약간 밝게 잡아 본문(다크 bg #0e1213)과 구분되게 한다.
SAT_SURFACE = 0.13

CHROME_800 = hsl_hex(HUE, SAT_SURFACE, 0.098)   # 채널 목록
CHROME_900 = hsl_hex(HUE, SAT_SURFACE, 0.062)   # 레일 — 더 깊다
CHROME_700 = hsl_hex(HUE, SAT_SURFACE, 0.145)   # 호버
CHROME_600 = hsl_hex(HUE, SAT_SURFACE, 0.190)   # 선택

# ── 껍데기 글자 3단 — 목표 대비를 만족하는 명도를 찾는다 ──────
SAT_TEXT = 0.08
CHROME_TEXT, R_TEXT = find_lightness(CHROME_800, 12.0, sat=SAT_TEXT, lighter=True)
CHROME_MUTED, R_MUTED = find_lightness(CHROME_800, 7.0, sat=SAT_TEXT, lighter=True)
CHROME_SUBTLE, R_SUBTLE = find_lightness(CHROME_800, 4.5, sat=SAT_TEXT, lighter=True)

# ── 껍데기 선 — 장식이므로 낮게, 다만 보이긴 해야 한다 ────────
CHROME_LINE, R_LINE = find_lightness(CHROME_800, 1.35, sat=SAT_SURFACE, lighter=True)

# ── 껍데기 위의 강조(현재 위치 막대·활성 아이콘·배지) ─────────
# UI 컴포넌트라 3:1 이 하한(WCAG 1.4.11). 여유를 두고 4.5 를 목표로.
SAT_ACCENT = 0.42
CHROME_ACCENT, R_ACCENT = find_lightness(CHROME_800, 4.5, sat=SAT_ACCENT, lighter=True)

# ⚠️ 표면끼리는 **대비비로 재지 않는다.** `tokens.css` 는 표면 사다리를
# "HSL 명도 간격 3.1% (지시서 §4.1 의 2~4%)" 로 판정한다. 대비비로 재면
# 1.09:1 이 나오고 그걸 미달로 신고하게 되는데, 그건 내 잣대가 틀린 것이다.
LADDER = {"--chrome-rail": 6.2, "--chrome-side": 9.8, "--chrome-hover": 14.5, "--chrome-sel": 19.0}

rows = [
    ("--chrome-rail",   CHROME_900, "레일 (가장 깊다)",   ratio(CHROME_900, CHROME_800)),
    ("--chrome-side",   CHROME_800, "채널 목록 (기준면)",  1.0),
    ("--chrome-hover",  CHROME_700, "호버",               ratio(CHROME_700, CHROME_800)),
    ("--chrome-sel",    CHROME_600, "선택",               ratio(CHROME_600, CHROME_800)),
    ("--chrome-line",   CHROME_LINE, "선 (장식)",          R_LINE),
    ("--chrome-text",   CHROME_TEXT, "본문 글자",          R_TEXT),
    ("--chrome-muted",  CHROME_MUTED, "중간 글자",         R_MUTED),
    ("--chrome-subtle", CHROME_SUBTLE, "보조 글자",        R_SUBTLE),
    ("--chrome-accent", CHROME_ACCENT, "강조 (현재 위치)",  R_ACCENT),
]

print(f"색조 183° 고정 · 채널 목록 기준면 {CHROME_800}\n")
print(f"{'토큰':16} {'값':9} {'채널목록 대비':>12}  쓰임")
print("─" * 62)
for name, value, use, r in rows:
    if name in LADDER:
        gap = abs(LADDER[name] - LADDER["--chrome-side"])
        if name == "--chrome-side":
            mark, note = "", "기준면"
        elif name == "--chrome-rail":
            mark = "✅" if 2.0 <= gap <= 4.5 else "⚠️"
            note = f"명도 간격 {gap:.1f}% (사다리 2~4%)"
        else:
            # 호버·선택은 사다리가 아니라 **상호작용 상태**다. 눈에 띄어야 하므로
            # 사다리보다 크게 벌린다.
            mark = "✅" if gap >= 4.0 else "⚠️"
            note = f"명도 간격 {gap:.1f}% (상태는 크게)"
        print(f"{name:16} {value:9} {'':>12} {mark} {use} — {note}")
    else:
        mark = "✅" if r >= 1.3 else "⚠️"
        print(f"{name:16} {value:9} {r:11.2f}:1 {mark} {use}")

print("\n[교차 확인]")
checks = [
    ("본문 글자 on 레일",     CHROME_TEXT, CHROME_900, 12.0),
    ("본문 글자 on 선택",     CHROME_TEXT, CHROME_600, 7.0),
    ("보조 글자 on 레일",     CHROME_SUBTLE, CHROME_900, 4.5),
    ("보조 글자 on 선택",     CHROME_SUBTLE, CHROME_600, 3.0),
    ("강조 on 레일",         CHROME_ACCENT, CHROME_900, 4.5),
    ("강조 on 선택",         CHROME_ACCENT, CHROME_600, 3.0),
]
worst = 99.0
for label, fg, bg, need in checks:
    r = ratio(fg, bg)
    worst = min(worst, r / need)
    print(f"  {label:22} {r:5.2f}:1  (필요 {need})  {'✅' if r >= need else '❌'}")

print("\n[결측 — 흙빛은 껍데기 위에서도 보이는가]")
# tokens.css Layer 1 의 --clay-600 (밝은 모드) / 다크값 둘 다 확인
for label, clay in [("clay 밝은모드 #ae7747", "#ae7747"), ("clay 다크 #c08a52", "#c08a52")]:
    r = ratio(clay, CHROME_800)
    print(f"  {label:24} on 채널목록 {r:5.2f}:1  {'✅' if r >= 3.0 else '❌ 3:1 미만'}")

if worst < 1.0:
    raise SystemExit("\n❌ 교차 확인에서 떨어진 것이 있습니다 — 명도를 다시 잡으세요")
print("\n전부 통과")
