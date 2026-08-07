"""비밀번호 해싱.

의존성을 늘리지 않습니다 — `hashlib.scrypt` 는 표준 라이브러리에 있고
`bcrypt`·`argon2-cffi` 는 둘 다 C 확장 빌드가 필요합니다. 이 프로젝트의
제약(비용 0원, 설치는 가벼워야 함)에서는 표준 라이브러리가 맞습니다.

## 왜 scrypt 인가

`pbkdf2_hmac` 도 표준 라이브러리에 있지만 **메모리를 안 씁니다.** GPU 는
해시 연산을 수천 개씩 병렬로 돌리므로, 계산량만 늘리는 방식은 공격자에게
훨씬 유리합니다. scrypt 는 메모리를 요구해서 그 병렬화를 막습니다.

## 저장 형식

    scrypt$16384$8$1$<salt hex>$<hash hex>

파라미터를 같이 저장하는 이유: 나중에 n 을 올리면 **기존 해시를 검증할 수
없게 됩니다.** 형식에 박아 두면 옛 해시는 옛 파라미터로 검증하고, 로그인
성공 시점에 새 파라미터로 다시 해싱할 수 있습니다.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

# 128 * n * r 바이트를 씁니다 → 16384 * 8 * 128 = 16MiB.
# 이 값을 올리면 서버 로그인 처리도 그만큼 무거워집니다. 32GB RAM 에
# 동시 로그인이 몰릴 일이 없는 규모라 16MiB 로 둡니다.
SCRYPT_N = 16_384
SCRYPT_R = 8
SCRYPT_P = 1
SALT_BYTES = 16
KEY_BYTES = 32

# 비밀번호 길이 상한이 필요한 이유: scrypt 는 입력 길이에 비례해 느려지지
# 않지만, 상한이 없으면 수 MB 짜리 문자열로 요청을 반복해 서버를 묶을 수
# 있습니다. 로그인은 인증 **전** 경로라 누구나 두드릴 수 있습니다.
MAX_PASSWORD_BYTES = 1024
MIN_PASSWORD_LENGTH = 8


class WeakPassword(ValueError):
    """사람이 고칠 수 있는 문제라 메시지를 그대로 보여줍니다."""


def check_strength(password: str) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise WeakPassword(f"비밀번호는 {MIN_PASSWORD_LENGTH}자 이상이어야 합니다")
    if len(password.encode("utf-8")) > MAX_PASSWORD_BYTES:
        raise WeakPassword("비밀번호가 너무 깁니다")


def hash_password(password: str) -> str:
    check_strength(password)
    salt = secrets.token_bytes(SALT_BYTES)
    derived = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        dklen=KEY_BYTES,
        # maxmem 기본값(0)은 32MiB 한도라 n 을 올리면 바로 터집니다.
        # 파라미터가 요구하는 만큼 명시적으로 허용합니다.
        maxmem=128 * SCRYPT_N * SCRYPT_R * 2,
    )
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${derived.hex()}"


def verify_password(password: str, encoded: str | None) -> bool:
    """비밀번호가 맞는가.

    `encoded` 가 None 이어도 False 를 돌려줍니다 — 비밀번호를 설정하지 않은
    계정(마이그레이션 이전에 만들어진 사용자)은 **로그인할 수 없어야** 합니다.
    여기서 True 를 주면 그 계정 전부가 무인증으로 열립니다.
    """
    if not encoded:
        return False

    try:
        scheme, n_raw, r_raw, p_raw, salt_hex, hash_hex = encoded.split("$")
        if scheme != "scrypt":
            return False
        n, r, p = int(n_raw), int(r_raw), int(p_raw)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
    except (ValueError, AttributeError):
        # 형식이 깨진 해시는 "맞지 않음" 이지 예외가 아닙니다. 여기서 터지면
        # DB 한 행 때문에 로그인 엔드포인트 전체가 500 이 됩니다.
        return False

    if len(password.encode("utf-8")) > MAX_PASSWORD_BYTES:
        return False

    derived = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=n,
        r=r,
        p=p,
        dklen=len(expected),
        maxmem=128 * n * r * 2,
    )
    # ⚠️ `==` 로 비교하면 앞에서부터 몇 바이트가 맞았는지가 **시간으로**
    # 새어 나갑니다. 해시 비교는 항상 상수 시간으로 합니다.
    return hmac.compare_digest(derived, expected)


# 존재하지 않는 이메일로 로그인을 시도했을 때 태울 더미 해시.
#
# 이게 없으면 "사용자 없음" 은 즉시 돌아오고 "비밀번호 틀림" 은 scrypt 한 번
# 만큼 늦게 돌아옵니다. 그 차이로 **어떤 이메일이 가입돼 있는지** 알아낼 수
# 있습니다. 대학 프로젝트 명단이라도 이메일 목록은 개인정보입니다.
DUMMY_HASH = hash_password("this-password-is-never-correct")


def waste_time_like_a_real_verification() -> None:
    verify_password("x" * MIN_PASSWORD_LENGTH, DUMMY_HASH)
