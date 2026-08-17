"""프로필 이미지·자기소개 (요구사항 정의서 §4 `USER-004`).

## ⚠️ 파일 업로드 통로를 열지 않고 만들었습니다

이 저장소는 채팅 업로드(`CHAT-006·007`)를 일부러 안 만들었습니다 —
저장 자리 + 인증 붙은 내려받기 + MIME 판별 + 크기 상한이 **한 벌**로
필요하고, 하나만 빠져도 주소만 알면 열리는 통로가 되기 때문입니다.
프로필 이미지도 같은 벽 앞에 서는데, 여기는 돌아가는 길이 있습니다.

**이미지가 파일로 서빙되지 않게 만드는 것**입니다.

1. 화면이 사진을 캔버스에 **다시 그려** 96×96 PNG 로 재부호화합니다.
   이때 원본의 EXIF(찍은 위치·기기)가 떨어져 나갑니다 — 사진 원본을
   그대로 받으면 그 사람의 **집 좌표**를 저장하게 될 수 있습니다
2. 그 결과를 `data:image/png;base64,…` 글자로 받아 **행에 저장**합니다
3. 나갈 때는 이미 인증이 걸린 JSON 응답(`MeOut`·`MemberOut`)에 실려
   나갑니다 — 내려받기 문이 따로 없으니 안 잠긴 문도 없습니다

서버는 화면의 재부호화를 **믿지 않습니다**. 여기 있는 검사가 전부
다시 봅니다 — 형식이 PNG 데이터 URI 인가 · 진짜 PNG 인가(시그니처) ·
치수가 상한 아래인가(IHDR) · 몇 바이트인가. SVG 는 형식부터 거절됩니다
— 문서로 열리는 순간 스크립트가 돌 수 있는 유일한 이미지 형식입니다.

## ⚠️ 빈 문자열과 None 은 다릅니다

`GithubLoginIn` 과 같은 규칙입니다 — `None` 은 "안 건드림", `""` 는
"지움" 입니다. 지울 방법이 없으면 잘못 올린 사진이 영영 남습니다.
"""

from __future__ import annotations

import base64
import re
import struct

#: 자기소개 최대 길이. 이력서가 아니라 팀원에게 하는 한두 마디입니다.
MAX_BIO = 300

#: 아바타 원본(디코드한 PNG)의 최대 크기. 96×96 PNG 는 보통 5~25KB 라
#: 여유를 두고도 한참 아래입니다 — 이 상한에 걸리는 것은 재부호화를
#: 거치지 않은 무언가입니다.
MAX_AVATAR_BYTES = 64 * 1024

#: 아바타 한 변의 최대 픽셀. 화면은 96 으로 만들지만, 기기 배율에 따라
#: 2배로 만들 수도 있어 여유를 둡니다.
MAX_AVATAR_SIDE = 192

#: 허용하는 데이터 URI 형식. PNG 하나뿐입니다 — 화면이 언제나 PNG 로
#: 재부호화하므로 다른 형식이 오는 것 자체가 이 경로를 안 지난 것입니다.
_DATA_URI = re.compile(r"^data:image/png;base64,([A-Za-z0-9+/]+={0,2})$")

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

_TOO_BIG = "이미지가 너무 큽니다 — 화면의 사진 고르기를 거치면 이 크기가 나올 수 없습니다"


def clean_bio(text: str | None) -> str | None:
    """자기소개를 다듬는다. `None`/빈 글은 `None` — "없음" 은 한 가지로.

    글자 수만 봅니다. 무슨 말을 쓰는가는 팀의 일이지 시스템의 일이
    아닙니다 — 채팅을 검사하지 않는 것과 같은 이유입니다.
    """
    if text is None:
        return None
    cleaned = text.strip()
    if cleaned == "":
        return None
    if len(cleaned) > MAX_BIO:
        raise ValueError(f"자기소개는 {MAX_BIO}자까지입니다 (지금 {len(cleaned)}자)")
    return cleaned


def clean_avatar(data_uri: str | None) -> str | None:
    """아바타 데이터 URI 를 검증한다. `None`/빈 글은 `None`.

    돌려주는 값은 **받은 글자 그대로**입니다 — 다시 만들지 않습니다.
    다시 부호화하면 서버에 이미지 라이브러리가 필요해지고, 그 라이브러리가
    곧 공격면입니다(이미지 파서 취약점은 흔합니다). 검사는 전부 바이트를
    직접 봅니다.
    """
    if data_uri is None:
        return None
    if data_uri == "":
        return None

    # ⚠️ 디코드 전에 글자 길이부터 봅니다 — 수십 MB 문자열을 받아 놓고
    # 디코드하며 상한을 재면 이미 메모리를 쓴 뒤입니다.
    if len(data_uri) > MAX_AVATAR_BYTES * 4 // 3 + 64:
        raise ValueError(_TOO_BIG)

    matched = _DATA_URI.match(data_uri)
    if matched is None:
        raise ValueError("프로필 이미지는 PNG 데이터 URI 만 받습니다")

    try:
        # binascii.Error 는 ValueError 의 하위 클래스입니다.
        raw = base64.b64decode(matched.group(1), validate=True)
    except ValueError as exc:
        raise ValueError("이미지 데이터를 읽을 수 없습니다") from exc

    if len(raw) > MAX_AVATAR_BYTES:
        raise ValueError(_TOO_BIG)
    if not raw.startswith(_PNG_SIGNATURE) or len(raw) < 24:
        raise ValueError("PNG 가 아닙니다")

    # PNG 첫 청크는 언제나 IHDR 이고, 폭·높이가 그 앞머리에 있습니다.
    if raw[12:16] != b"IHDR":
        raise ValueError("PNG 가 아닙니다")
    width, height = struct.unpack(">II", raw[16:24])
    if width == 0 or height == 0:
        raise ValueError("PNG 가 아닙니다")
    if width > MAX_AVATAR_SIDE or height > MAX_AVATAR_SIDE:
        raise ValueError(
            f"프로필 이미지는 한 변 {MAX_AVATAR_SIDE}px 까지입니다 (지금 {width}×{height})"
        )

    return data_uri
