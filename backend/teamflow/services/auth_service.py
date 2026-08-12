"""로그인·세션.

지금까지 이 시스템은 **요청 본문에 적힌 `user_id` 를 그대로 믿었습니다.**
누구나 남의 번호를 적어 동의를 제출하고, 남의 트랙에 오디오를 올리고,
남의 이름으로 업무를 승인할 수 있었습니다. 기여도를 산정하는 시스템에서
그건 기능 결함이 아니라 산출물 전체를 무의미하게 만드는 구멍입니다.

여기서 범위를 최소로 잡습니다 — **이메일·비밀번호 로그인과 세션 쿠키까지**.
비밀번호 재설정, 이메일 인증, OAuth, 권한 등급은 넣지 않습니다. 사용자가
기록해 둔 최대 위험이 "범위 과다" 입니다.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from teamflow.auth import passwords
from teamflow.db import models as m
from teamflow.users import presence

# 세션 수명. 회의 하나가 몇 시간이고 팀플은 며칠 단위로 이어지므로,
# 짧게 잡으면 녹음 도중에 로그아웃되는 사고가 납니다.
SESSION_DAYS = 14

COOKIE_NAME = "teamflow_session"
TOKEN_BYTES = 32


class AuthError(Exception):
    """로그인 실패. 호출자가 401 로 옮깁니다."""


class EmailTaken(Exception):
    pass


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(UTC)


def _aware(value: datetime | None) -> datetime | None:
    """SQLite 는 tzinfo 를 잃어버립니다.

    저장할 때는 UTC 를 넣었는데 읽을 때 naive 로 돌아오므로, 그대로
    비교하면 `TypeError: can't compare offset-naive and offset-aware`
    가 납니다. **PostgreSQL 에서는 안 나고 SQLite 에서만 납니다** —
    테스트가 SQLite 라 반대로 운영에서만 났으면 더 나빴을 겁니다.
    """
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def register(session: Session, *, name: str, email: str, password: str) -> m.User:
    """새 사용자. 비밀번호 규칙 위반은 `passwords.WeakPassword` 로 올라갑니다."""
    normalized = normalize_email(email)
    existing = session.scalars(select(m.User).where(m.User.email == normalized)).first()
    if existing is not None:
        raise EmailTaken("이미 가입된 이메일입니다")

    user = m.User(
        name=name.strip(),
        email=normalized,
        password_hash=passwords.hash_password(password),
    )
    session.add(user)
    session.flush()
    return user


def normalize_email(email: str) -> str:
    """⭐ 대소문자를 접습니다.

    접지 않으면 `A@x.com` 과 `a@x.com` 이 **다른 계정**이 됩니다. 사람은
    같은 주소라고 생각하므로, 로그인이 안 될 때 비밀번호를 의심하지 계정이
    둘이라고는 생각하지 않습니다. 가입 단계에서 접어야 합니다 — 나중에
    합치려면 어느 쪽 기여도가 진짜인지 판단할 수 없습니다.
    """
    return email.strip().lower()


def authenticate(session: Session, *, email: str, password: str) -> m.User:
    user = session.scalars(
        select(m.User).where(m.User.email == normalize_email(email))
    ).first()

    if user is None:
        # ⚠️ 여기서 바로 돌아가면 응답 시간으로 가입 여부가 새어 나갑니다.
        # 있는 계정과 같은 만큼 시간을 씁니다.
        passwords.waste_time_like_a_real_verification()
        raise AuthError("이메일 또는 비밀번호가 올바르지 않습니다")

    if not passwords.verify_password(password, user.password_hash):
        raise AuthError("이메일 또는 비밀번호가 올바르지 않습니다")

    return user


def issue_session(
    session: Session, *, user_id: int, user_agent: str | None = None
) -> tuple[str, m.UserSession]:
    """세션을 만들고 **원문 토큰**을 돌려줍니다.

    원문은 이 순간에만 존재합니다 — DB 에는 해시만 들어갑니다. 그래서
    나중에 "이 세션의 토큰이 뭐였지" 를 물을 수 없고, 그게 맞습니다.
    """
    token = secrets.token_urlsafe(TOKEN_BYTES)
    row = m.UserSession(
        user_id=user_id,
        token_hash=_hash_token(token),
        expires_at=_now() + timedelta(days=SESSION_DAYS),
        user_agent=(user_agent or "")[:300] or None,
    )
    session.add(row)
    session.flush()
    return token, row


def resolve_session(session: Session, token: str | None) -> m.User | None:
    """토큰 → 사용자. 만료·취소된 세션은 None 입니다."""
    if not token:
        return None

    row = session.scalars(
        select(m.UserSession).where(m.UserSession.token_hash == _hash_token(token))
    ).first()
    if row is None:
        return None
    if row.revoked_at is not None:
        return None

    expires_at = _aware(row.expires_at)
    if expires_at is not None and expires_at <= _now():
        return None

    # ⚠️ **상태를 저장하는 것이 아닙니다** (`USER-005`). "이 세션이 마지막으로
    #    쓰인 때" 라는 사실 하나만 적고, `접속 중`·`자리 비움` 은 읽을 때
    #    계산합니다 (`users/presence.py`). 상태를 행으로 쌓으면 그 표는 곧
    #    출퇴근부가 됩니다.
    #
    # ⚠️ 요청마다 쓰지 않습니다 — 화면 하나가 API 를 여럿 부르므로 그대로
    #    두면 쓰기가 읽기만큼 생깁니다.
    now = _now()
    if presence.should_touch(_aware(row.last_seen_at), now):
        row.last_seen_at = now

    return session.get(m.User, row.user_id)


def revoke(session: Session, token: str | None) -> bool:
    """로그아웃. 이미 취소된 세션을 다시 취소해도 조용히 성공합니다."""
    if not token:
        return False
    row = session.scalars(
        select(m.UserSession).where(m.UserSession.token_hash == _hash_token(token))
    ).first()
    if row is None:
        return False
    if row.revoked_at is None:
        row.revoked_at = _now()
    return True


def revoke_all_for_user(session: Session, user_id: int) -> int:
    """이 사용자의 모든 세션을 끊습니다.

    비밀번호를 바꿨거나 기기를 잃었을 때 쓰는 경로입니다. 지금은
    화면이 없지만 함수는 있어야 합니다 — 사고가 났을 때 파이썬 셸에서
    한 줄로 끊을 수 있는 것과, 그때부터 코드를 짜는 것은 다릅니다.
    """
    rows = session.scalars(
        select(m.UserSession).where(
            m.UserSession.user_id == user_id, m.UserSession.revoked_at.is_(None)
        )
    ).all()
    now = _now()
    for row in rows:
        row.revoked_at = now
    return len(rows)


# ⚠️ **세션 정리 잡은 없습니다. 일부러 없습니다** (결함 116).
#
# 예전에는 여기 `purge_expired(session)` 가 있었습니다 — 만료된
# `user_sessions` 행을 `session.delete()` 로 지우고, 독스트링은
# **"유지보수 잡에서 부릅니다"** 라고 단언했습니다. 그런데 그 잡은
# 없었습니다. `tasks/maintenance.py` 에도, `beat_schedule` 에도
# 없었습니다. 부르는 곳이 **0곳**이었습니다.
#
# 안 불린 것이 다행이었습니다. `UserSession` 모델은 이렇게 적어 뒀습니다.
#
#     로그아웃 시각. 행을 지우지 않는 이유는 감사 때문입니다 —
#     "누가 언제 로그인해 있었는가" 는 기여도 분쟁에서 확인할 거리가 됩니다.
#
# 그 잡을 배선했다면 **모델이 지키겠다고 적어 둔 그 기록을 매일 지웠을
# 것**입니다. 학기 말 분쟁에서 확인할 것이 남아 있지 않습니다. 조용히,
# 되돌릴 수 없게.
#
# 지울 이유도 없습니다. 만료 판정은 `resolve_session` 이 `expires_at` 으로
# 그 자리에서 합니다 — 행이 남아 있어도 그 토큰으로는 아무것도 못 합니다.
# `token_hash` 는 무작위 32바이트의 sha256 이라 되돌릴 수도 없습니다.
# **지워서 얻는 것은 없고 잃는 것은 감사 기록입니다.**
#
# 그래서 함수를 지웠습니다. 남겨 두면 다음 사람이 독스트링을 믿고
# 배선합니다 — 이 저장소가 결함 63 에서 겪은 바로 그 모양입니다
# (맞는 함수가 있고 아무도 안 부름). 다만 이쪽은 **불렀다면 더 나빴습니다.**
#
# 정리가 정말 필요해지면 지우는 것이 아니라 `token_hash` 만 비우는 쪽으로
# 가야 합니다. 그때는 감사 기록을 무엇까지 남길지부터 정하는 것이 먼저고,
# 그건 코드가 아니라 정책 문제입니다 (docs/07 §2.4).
