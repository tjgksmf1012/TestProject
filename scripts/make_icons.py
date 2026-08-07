#!/usr/bin/env python3
"""앱 아이콘 PNG 를 만든다 — `frontend/public/icon.svg` 와 같은 그림으로.

## 왜 손으로 래스터라이저를 쓰는가

PNG 가 **필요합니다.** iOS 의 `apple-touch-icon` 은 SVG 를 받지 않고,
안드로이드 홈 화면의 적응형 아이콘도 maskable PNG 를 원합니다. SVG 하나만
두면 아이폰에서는 홈 화면에 추가했을 때 **화면 캡처가 아이콘이 됩니다.**

그런데 이 프로젝트의 제약은 두 가지입니다.

  · **비용 0원** — 유료 도구를 쓰지 않는다
  · **의존성을 늘리지 않는다** — 프런트에는 런타임 의존성이 0개고,
    파이썬 쪽도 아이콘 하나 만들자고 cairosvg/Pillow 를 넣으면
    빌드 환경마다 네이티브 라이브러리를 맞춰야 합니다

`zlib` 은 표준 라이브러리이고 PNG 는 그 위에 얇게 얹힌 형식입니다. 그림도
원·둥근 사각형·굵은 선분 셋뿐이라 거리 함수로 그릴 수 있습니다. 그래서
40줄짜리 인코더와 짧은 래스터라이저로 끝냅니다 — **결과가 결정적이라**
같은 입력이면 언제나 같은 바이트가 나오고, 그래서 저장소에 커밋해도
매번 diff 가 생기지 않습니다.

    .venv/bin/python scripts/make_icons.py

## 그림

    ●  ●  ●     회의 — 사람 셋이 말한다
     \\ | /
       ●        하나로 모인다 (결정)
       |
    ▭  ▭  ▭     갈라져 나간다 (칸반 업무)
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

PUBLIC = Path(__file__).resolve().parents[1] / "frontend" / "public"

BG = (0x25, 0x63, 0xEB)
FG = (0xFF, 0xFF, 0xFF)

#: 한 픽셀을 몇 번 찍어 볼 것인가. 가장자리 계단을 없앤다.
#: 3 이면 픽셀당 9번 — 512px 기준 240만 번이라 1초 안에 끝난다.
SUPERSAMPLE = 3

STROKE = 26.0
DOT_R = 34.0

#: SVG 와 같은 좌표계(512 기준). 크기가 달라지면 비례로 늘린다.
BASE = 512.0
CORNER = 112.0


def _segment_distance(
    px: float, py: float, ax: float, ay: float, bx: float, by: float
) -> float:
    """점에서 선분까지의 거리. 굵은 선을 그리는 데 쓴다."""
    dx, dy = bx - ax, by - ay
    length_squared = dx * dx + dy * dy
    if length_squared == 0.0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_squared))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _rounded_rect_distance(
    px: float, py: float, x: float, y: float, w: float, h: float, r: float
) -> float:
    """둥근 사각형 바깥으로의 거리. 안이면 0 이하."""
    cx = abs(px - (x + w / 2)) - (w / 2 - r)
    cy = abs(py - (y + h / 2)) - (h / 2 - r)
    outside = math.hypot(max(cx, 0.0), max(cy, 0.0))
    return outside + min(max(cx, cy), 0.0) - r


def _glyph_hit(px: float, py: float) -> bool:
    """이 점이 흰 그림 안에 있는가. 좌표는 512 기준."""
    half = STROKE / 2

    strokes = [
        # 회의 → 결정: 위 점 셋에서 가운데로 모인다
        (136.0, 150.0, 256.0, 214.0),
        (256.0, 214.0, 376.0, 150.0),
        (256.0, 214.0, 256.0, 300.0),
        # 결정 → 업무: 아래로 내려가 셋으로 갈라진다
        (256.0, 300.0, 256.0, 336.0),
        (156.0, 336.0, 356.0, 336.0),
        (156.0, 336.0, 156.0, 384.0),
        (356.0, 336.0, 356.0, 384.0),
    ]
    for ax, ay, bx, by in strokes:
        if _segment_distance(px, py, ax, ay, bx, by) <= half:
            return True

    for cx in (136.0, 256.0, 376.0):
        if math.hypot(px - cx, py - 150.0) <= DOT_R:
            return True

    for x in (122.0, 222.0, 322.0):
        if _rounded_rect_distance(px, py, x, 384.0, 68.0, 46.0, 12.0) <= 0.0:
            return True

    return False


def _render(size: int, *, maskable: bool) -> bytes:
    """RGB 픽셀을 만든다. 알파는 쓰지 않는다 — 배경이 꽉 차 있다.

    `maskable` 이면 그림을 안쪽으로 줄인다. 안드로이드 적응형 아이콘은
    제조사마다 다른 모양으로 **잘라내므로**, 가장자리에 있는 것은 잘릴
    수 있다고 봐야 한다. 안전 영역은 가운데 원 80% 다.
    """
    scale = size / BASE
    # maskable 은 배경이 화면 끝까지 가고 모서리를 둥글게 하지 않는다 —
    # 잘라내는 쪽이 자기 모양대로 깎기 때문이다.
    corner = 0.0 if maskable else CORNER * scale
    glyph_scale = 0.72 if maskable else 1.0

    step = 1.0 / SUPERSAMPLE
    offset = step / 2
    samples = SUPERSAMPLE * SUPERSAMPLE

    rows = bytearray()
    for py in range(size):
        rows.append(0)  # PNG 필터 바이트: 0 = None
        for px in range(size):
            inside_bg = 0
            inside_fg = 0
            for sy in range(SUPERSAMPLE):
                y = py + offset + sy * step
                for sx in range(SUPERSAMPLE):
                    x = px + offset + sx * step
                    if _rounded_rect_distance(x, y, 0.0, 0.0, size, size, corner) > 0.0:
                        continue
                    inside_bg += 1
                    # 그림 좌표로 되돌린다.
                    gx = (x - size / 2) / (scale * glyph_scale) + BASE / 2
                    gy = (y - size / 2) / (scale * glyph_scale) + BASE / 2
                    if _glyph_hit(gx, gy):
                        inside_fg += 1

            if inside_bg == 0:
                # 모서리 바깥. 흰색으로 둔다 — 알파 없는 PNG 라
                # 어차피 둥근 모서리는 OS 가 다시 깎는다.
                rows.extend(FG)
                continue

            bg_weight = inside_bg / samples
            fg_weight = inside_fg / samples
            for channel in range(3):
                value = (
                    FG[channel] * (1 - bg_weight)
                    + BG[channel] * (bg_weight - fg_weight)
                    + FG[channel] * fg_weight
                )
                rows.append(round(value))
    return bytes(rows)


def _png(size: int, raw: bytes) -> bytes:
    """최소 PNG. 8비트 RGB, 인터레이스 없음."""

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


#: (파일 이름, 한 변 픽셀, maskable 인가)
#:
#: 180 은 iOS `apple-touch-icon` 이 쓰는 크기다. 안 만들면 아이폰에서
#: 홈 화면에 추가했을 때 **화면 캡처가 아이콘이 된다.**
TARGETS = [
    ("icon-180.png", 180, False),
    ("icon-192.png", 192, False),
    ("icon-512.png", 512, False),
    ("icon-maskable-512.png", 512, True),
]


def main() -> int:
    PUBLIC.mkdir(parents=True, exist_ok=True)
    for name, size, maskable in TARGETS:
        path = PUBLIC / name
        data = _png(size, _render(size, maskable=maskable))
        path.write_bytes(data)
        print(f"  {name:26} {size}×{size}  {len(data):>7,} bytes")
    print(f"\n{len(TARGETS)}개를 {PUBLIC} 에 만들었습니다.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
