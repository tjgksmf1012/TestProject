"""반응 어휘 — 서버가 주인이고 화면은 받아 쓴다 (결함 414).

`GET /api/chat/reactions` 는 **화면이 자기 표를 안 들게 하려고** 있습니다.
그 docstring 이 그렇게 적어 두고 순서까지 어휘 순서로 못 박는데, 화면은
받아 놓고 이름표만 꺼내 쓰고 **집합과 순서를 자기 배열**로 정하고
있었습니다 — 서버 `ok·agree·question·thanks`, 화면 `agree·ok·question·thanks`.

여기서 재는 것은 둘입니다:

1. 화면이 고를 것을 **서버 응답에서** 만드는가 (자기 배열이 아니라)
2. 어휘의 반응마다 화면에 **그림이 있는가** — 없으면 서버가 다섯째를
   더해도 그 하나는 조용히 안 그려집니다 (`reactionIcon` 이 `null` 이면
   화면이 건너뜁니다)

⚠️ 2번은 결함 326 의 방법입니다 — 낱개를 늘리지 말고 **짝을 세십시오**.
그림은 화면이 그리는 것이 맞고(`ReactionMark` docstring), 재야 할 것은
**어휘의 값 집합 == 그림의 키 집합**입니다.
"""

from __future__ import annotations

import re
from pathlib import Path

from teamflow.db import vocab

REPO_ROOT = Path(__file__).resolve().parents[2]
VIEW = REPO_ROOT / "frontend" / "src" / "lib" / "chat" / "view.ts"
CHAT = REPO_ROOT / "frontend" / "src" / "demo" / "chat.tsx"


def _blanked_ts(source: str) -> str:
    """주석을 **길이를 지켜** 지운 코드.

    ⚠️ 이 저장소의 화면 주석은 「예전에는 이렇게 적었다」를 옛 코드 그대로
    인용합니다. 안 걷으면 그 주석이 배선으로 잡힙니다(결함 238).
    """
    out = list(source)
    i = 0
    while i < len(source):
        if source.startswith("/*", i):
            end = source.find("*/", i + 2)
            end = len(source) if end == -1 else end + 2
            for j in range(i, end):
                if out[j] != "\n":
                    out[j] = " "
            i = end
            continue
        if source.startswith("//", i):
            end = source.find("\n", i)
            end = len(source) if end == -1 else end
            for j in range(i, end):
                out[j] = " "
            i = end
            continue
        i += 1
    return "".join(out)


def _icon_marks() -> set[str]:
    """`reactionIcon` 이 그림을 주는 반응 이름들."""
    code = _blanked_ts(VIEW.read_text(encoding="utf-8"))
    start = code.index("export function reactionIcon(")
    end = code.index("\n}", start)
    body = code[start:end]
    return set(re.findall(r"case '([a-z_]+)':", body))


def test_every_reaction_in_the_vocabulary_has_a_picture() -> None:
    """⭐ 어휘의 반응 == 그림이 있는 반응.

    ⚠️ 한쪽만 늘어나면 조용합니다 — 어휘에만 있으면 화면이 건너뛰고,
    화면에만 있으면 눌러도 서버가 400 을 줍니다. **양방향**으로 잽니다.
    """
    vocabulary = {str(mark) for mark in vocab.ReactionMark}
    drawn = _icon_marks()
    assert vocabulary == drawn, (
        "반응 어휘와 화면의 그림이 어긋납니다 — "
        f"어휘에만: {sorted(vocabulary - drawn)} · 화면에만: {sorted(drawn - vocabulary)}"
    )


def test_the_screen_does_not_keep_its_own_reaction_table() -> None:
    """⭐ 화면이 **고를 것**을 서버 응답에서 만든다.

    ⚠️ 낱말이 아니라 요구를 잽니다 — 이름이 `REACTION_MARKS` 가 아니어도
    **화면 안에 반응 이름 배열**이 있으면 그것이 두 번째 표입니다.
    """
    for path in (VIEW, CHAT):
        code = _blanked_ts(path.read_text(encoding="utf-8"))
        names = "|".join(sorted(str(m) for m in vocab.ReactionMark))
        literal = re.search(rf"\[\s*'({names})'\s*,[^\]]*\]", code)
        assert literal is None, (
            f"{path.name} 안에 반응 이름 배열이 있습니다 — 서버의 어휘와 두 벌입니다: "
            f"{literal.group(0) if literal else ''}"
        )

    chat = _blanked_ts(CHAT.read_text(encoding="utf-8"))
    assert "offerableReactions(" in chat, (
        "화면이 고를 것을 서버 응답에서 만들지 않습니다"
    )
    assert "'/api/chat/reactions'" in chat, (
        "화면이 반응 목록을 서버에서 안 받아 옵니다"
    )


def test_the_endpoint_still_promises_the_vocabulary_order() -> None:
    """⚠️ 이 검사가 기대는 **서버 쪽 약속**이 살아 있는가.

    화면이 서버 순서를 그대로 그리기로 했으므로, 서버가 순서를 안 정하면
    화면 순서도 정해지지 않습니다 — 기대는 것을 같이 잽니다(결함 354).
    """
    main = (REPO_ROOT / "backend" / "teamflow" / "api" / "main.py").read_text(
        encoding="utf-8"
    )
    start = main.index('@app.get("/api/chat/reactions"')
    block = main[start : start + 1200]
    assert "for mark in vocab.ReactionMark" in block, (
        "엔드포인트가 어휘 순서로 안 내려보냅니다 — 화면 순서도 같이 흔들립니다"
    )
