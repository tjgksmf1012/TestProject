"""사용자 상태 표시 (정의서 §4 `USER-005`).

⚠️ 순수 함수만 잽니다. 배선은 `test_presence_api.py` 가 봅니다.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from teamflow.db.vocab import PresenceStatus
from teamflow.users.presence import (
    AWAY_WITHIN,
    ONLINE_WITHIN,
    should_touch,
    status_of,
)

NOW = datetime(2026, 9, 1, 14, 0, tzinfo=UTC)


def status(**over) -> PresenceStatus:
    args = {"last_seen": NOW, "in_meeting": False, "now": NOW}
    args.update(over)
    return status_of(**args)


def test_just_moved_is_online():
    assert status(last_seen=NOW - timedelta(seconds=30)) is PresenceStatus.ONLINE


def test_quiet_for_a_while_is_away():
    assert status(last_seen=NOW - ONLINE_WITHIN - timedelta(minutes=1)) is (
        PresenceStatus.AWAY
    )


def test_quiet_for_long_is_offline():
    assert status(last_seen=NOW - AWAY_WITHIN - timedelta(minutes=1)) is (
        PresenceStatus.OFFLINE
    )


def test_never_seen_is_offline():
    """⭐ 한 번도 안 들어온 것과 오래전에 나간 것을 **구분하지 않습니다.**

    구분해 보여 주면 그게 곧 "가입만 하고 안 들어온 사람" 표시가 됩니다.
    """
    assert status(last_seen=None) is PresenceStatus.OFFLINE


def test_being_in_a_meeting_wins():
    """⭐ 회의 화면은 요청을 자주 안 보냅니다.

    시간만 보면 **회의하는 사람이 자리 비움으로** 뜹니다.
    """
    assert status(
        last_seen=NOW - timedelta(hours=3), in_meeting=True
    ) is PresenceStatus.IN_MEETING
    assert status(last_seen=None, in_meeting=True) is PresenceStatus.IN_MEETING


def test_a_clock_skew_into_the_future_is_not_offline():
    """⭐ 음수를 오프라인으로 처리하면 서버 시계가 조금 뒤처진 순간
    **팀 전체가 오프라인**으로 보입니다."""
    assert status(last_seen=NOW + timedelta(minutes=10)) is PresenceStatus.ONLINE


def test_the_scale_is_coarse():
    """⭐ 분 단위로 정확히 말하지 않습니다.

    정확할수록 감시에 가까워지고, 정확할 이유도 없습니다 — 사람이 알고
    싶은 것은 "지금 말 걸어도 되나" 하나입니다.
    """
    assert timedelta(minutes=5) <= ONLINE_WITHIN
    assert timedelta(minutes=30) <= AWAY_WITHIN


def test_we_do_not_write_on_every_request():
    """⚠️ 화면 하나가 API 를 여럿 부릅니다. 그대로 두면 쓰기가 읽기만큼 생깁니다."""
    assert should_touch(None, NOW) is True
    assert should_touch(NOW - timedelta(seconds=5), NOW) is False
    assert should_touch(NOW - timedelta(minutes=2), NOW) is True
