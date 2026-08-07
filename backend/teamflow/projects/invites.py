"""프로젝트 초대 코드.

## 왜 이메일 초대가 아닌가

`POST /api/projects` 는 `member_ids: list[int]` 를 받습니다. **화면에서는
그걸 채울 수가 없습니다** — 사용자는 남의 user_id 를 모릅니다. API 는
있는데 사람이 쓸 수 없는 형태였습니다.

이메일로 받는 방법도 있지만 둘 중 하나가 됩니다.

  · 없는 이메일에 "가입하지 않았습니다" 라고 답한다
    → **누가 가입돼 있는지 알아낼 수 있습니다.** 로그인 화면에서 일부러
      감춘 것을 여기서 열어 주는 셈입니다.
  · 초대 메일을 보낸다
    → 발송 인프라가 필요합니다. 이 프로젝트의 제약은 **비용 0원**입니다.

초대 코드는 둘 다 피합니다. 코드를 만든 사람이 카톡으로 던지면 되고,
서버는 누구의 이메일도 확인하지 않습니다.

## 코드 모양

    ABCD-EFGH   (8자, 하이픈은 읽기용이라 입력할 때는 없어도 된다)

**헷갈리는 글자를 뺐습니다** — `0/O`, `1/I/L` 을 빼지 않으면 카톡으로
받아 적을 때 반드시 틀립니다. 그리고 틀렸을 때 "코드가 없습니다" 만
나오면 사람은 상대를 의심합니다.
"""

from __future__ import annotations

import re
import secrets

# Crockford Base32 에서 헷갈리는 것을 더 뺀 알파벳.
# 0·O·1·I·L·U 제외 (U 는 우연히 비속어가 만들어지는 걸 줄이려고 뺍니다).
ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
CODE_LENGTH = 8

# 30^8 ≈ 6.6e11. 로그인한 사람만 시도할 수 있고 코드는 회전 가능하므로
# 온라인 추측에는 충분합니다.
_NOISE = re.compile(r"[^0-9A-Za-z]")


def generate_code() -> str:
    """새 초대 코드. `secrets` 를 씁니다 — `random` 은 예측 가능합니다."""
    return "".join(secrets.choice(ALPHABET) for _ in range(CODE_LENGTH))


def normalize_code(raw: str | None) -> str:
    """사람이 입력한 것을 저장 형태로.

    하이픈·공백을 빼고 대문자로 올립니다. 카톡에서 복사하면 앞뒤 공백이
    붙고, 사람은 화면에 보이는 하이픈을 그대로 칩니다. 그걸 "틀린 코드" 로
    처리하면 **맞는 코드를 들고도 못 들어옵니다.**

    소문자 `l` 을 `1` 로, `O` 를 `0` 로 바꾸는 식의 추측은 하지 않습니다 —
    알파벳에서 그 글자들을 아예 뺐으므로 그런 입력은 진짜로 틀린 것입니다.
    """
    if not raw:
        return ""
    return _NOISE.sub("", raw).upper()


def format_code(code: str) -> str:
    """화면에 보여줄 형태. 네 글자마다 끊습니다.

    끊어 주지 않으면 여덟 글자를 한 번에 읽다 틀립니다.
    """
    cleaned = normalize_code(code)
    if len(cleaned) != CODE_LENGTH:
        return cleaned
    return f"{cleaned[:4]}-{cleaned[4:]}"


def looks_like_code(raw: str | None) -> bool:
    """서버에 물어보기 전에 걸러낼 수 있는가.

    형식이 틀린 것을 조회로 보내면 "없는 코드" 와 "잘못 친 코드" 가 같은
    답을 받습니다. 사람은 그 둘을 다르게 고쳐야 합니다.
    """
    cleaned = normalize_code(raw)
    if len(cleaned) != CODE_LENGTH:
        return False
    return all(character in ALPHABET for character in cleaned)
