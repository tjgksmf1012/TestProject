"""팀 달력 (결함 107·108).

이 저장소는 시각을 전부 UTC 로 저장합니다. 그건 옳습니다. 틀린 것은
**그 순간을 "며칠" 로 읽을 때 `.date()` 를 쓴 것**입니다. 그건 UTC
달력일이라, 한국(UTC+9)에서는 밤 9시 이후가 통째로 하루 앞으로 밀립니다.

UTC 는 KST 보다 항상 뒤이므로 이 오차는 무작위가 아닙니다. **늘 날짜를
앞당기는 쪽으로만** 기웁니다.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

import pytest

from teamflow.clock import local_date
from teamflow.meeting.resolve import resolve_deadline

KST = ZoneInfo("Asia/Seoul")


def test_the_team_calendar_is_the_one_these_tests_assume():
    """이 파일의 날짜는 전부 KST 기준이다. 설정이 바뀌면 여기서 먼저 안다."""
    from teamflow.clock import team_zone

    assert team_zone() == KST


@pytest.mark.parametrize(
    ("moment", "expected"),
    [
        # KST 로 같은 날 — UTC 도 같은 날.
        (datetime(2026, 9, 4, 10, 0, tzinfo=UTC), date(2026, 9, 4)),
        # KST 23:00 — 아직 같은 날. 경계 바로 앞.
        (datetime(2026, 9, 4, 14, 0, tzinfo=UTC), date(2026, 9, 4)),
        # KST 00:00 — 날짜가 넘어간 첫 순간. `.date()` 는 아직 09-04 라 한다.
        (datetime(2026, 9, 4, 15, 0, tzinfo=UTC), date(2026, 9, 5)),
        (datetime(2026, 9, 4, 16, 0, tzinfo=UTC), date(2026, 9, 5)),
    ],
)
def test_an_instant_becomes_the_day_the_team_was_living(
    moment: datetime, expected: date
):
    assert local_date(moment) == expected


def test_a_naive_datetime_is_read_as_utc():
    """SQLite 는 tzinfo 를 잃고 돌려준다.

    그때 조용히 **로컬 시간으로 읽으면** 저장한 값과 다른 순간이 됩니다.
    이 저장소는 naive datetime 을 UTC 로만 저장하므로 UTC 로 되살립니다.
    """
    naive = datetime(2026, 9, 4, 16, 0)
    assert local_date(naive) == local_date(naive.replace(tzinfo=UTC))
    assert local_date(naive) == date(2026, 9, 5)


def test_a_late_night_meeting_does_not_shift_its_own_deadlines():
    """⭐ 결함 108 — 새벽 회의에서 "다음 주 월요일" 이 **회의 당일**이 됐다.

    `meeting_tasks` 는 `meeting.started_at.date()` 를 `resolve_deadline`
    의 기준일로 넘기고 있었습니다. 새벽 1시에 시작한 월요일 회의는 UTC
    로는 아직 일요일이라, 요일까지 하루 밀립니다 — 그리고 "다음 주"는
    요일에서 주를 세므로 **주 단위로** 틀립니다.

        회의 시작 2026-09-07 01:00 KST (월) = 09-06 16:00Z (일)
        "다음 주 월요일"   UTC기준 09-07   팀달력 09-14

    UTC 기준 값 09-07 은 회의가 열린 바로 그 날입니다. 승인 화면에는
    **이미 지난 마감**이 뜹니다.
    """
    started = datetime(2026, 9, 7, 1, 0, tzinfo=KST)  # 월요일 새벽 1시
    team_day = local_date(started)
    utc_day = started.astimezone(UTC).date()

    assert team_day == date(2026, 9, 7), "팀은 월요일에 모였다"
    assert utc_day == date(2026, 9, 6), "UTC 로는 아직 일요일 — 이게 함정이었다"

    assert resolve_deadline("다음 주 월요일까지", team_day).value == date(2026, 9, 14)
    assert resolve_deadline("내일까지", team_day).value == date(2026, 9, 8)
    assert resolve_deadline("3일 안에", team_day).value == date(2026, 9, 10)

    # 되돌리면 이렇게 된다 — 마감이 **회의 당일**로 잡힌다.
    assert resolve_deadline("다음 주 월요일까지", utc_day).value == date(2026, 9, 7)


# ══════════════════════════════════════════════════════════════
# 시각도 팀 달력으로 (결함 290)
# ══════════════════════════════════════════════════════════════


def test_local_time_moves_the_clock_not_just_the_date() -> None:
    """⭐ **자정을 넘는 순간**으로 잰다.

    `10:00Z` 같은 값으로 재면 날짜가 안 넘어가서, 팀 달력이든 UTC 든
    날짜가 같습니다. `16:30Z` 는 서울에서 **다음 날 01:30** 이라
    시·날짜가 둘 다 갈립니다.
    """
    from datetime import UTC, datetime

    from teamflow.clock import local_time

    at = datetime(2026, 8, 25, 16, 30, tzinfo=UTC)
    got = local_time(at)
    assert f"{got:%Y-%m-%d %H:%M}" == "2026-08-26 01:30"
    # UTC 를 그대로 찍으면 나올 값이 **안** 나와야 합니다.
    assert f"{got:%Y-%m-%d %H:%M}" != "2026-08-25 16:30"


def test_local_time_treats_a_naive_value_as_utc() -> None:
    """⚠️ SQLite 는 tzinfo 를 잃고 돌려줍니다 — `as_utc` 와 같은 가정입니다."""
    from datetime import datetime

    from teamflow.clock import local_time

    naive = datetime(2026, 8, 25, 16, 30)
    assert f"{local_time(naive):%Y-%m-%d %H:%M}" == "2026-08-26 01:30"


# ══════════════════════════════════════════════════════════════
# 이번 주 — 팀 달력의 월~일 (결함 296)
# ══════════════════════════════════════════════════════════════


def test_team_week_runs_monday_to_sunday_in_the_team_calendar() -> None:
    """이 제품의 「이번 주」는 월~일입니다.

    ⚠️ 기준을 **UTC 로 잡으면 갈라지는 순간**을 골랐습니다. 2026-08-16 은
    일요일이지만 `17:25Z` 는 서울에서 **월요일 02:25** 라, 팀 달력에서는
    이미 다음 주입니다.
    """
    from datetime import UTC, datetime

    from teamflow import clock

    start, end = clock.team_week(datetime(2026, 8, 16, 17, 25, tzinfo=UTC))
    assert clock.local_date(start).isoformat() == "2026-08-17"
    assert clock.local_date(end).isoformat() == "2026-08-23"
    # 월요일에서 시작해 일요일에 끝납니다 (0=월 … 6=일).
    assert clock.local_date(start).weekday() == 0
    assert clock.local_date(end).weekday() == 6


def test_team_week_is_the_same_week_every_day_of_that_week() -> None:
    """⭐ **주 안에서는 언제 물어도 같은 주**입니다.

    이게 결함 296 의 핵심입니다 — 굴러가는 창이면 누를 때마다 다른 주가
    나오고 `scope_key` 가 날마다 달라집니다.
    """
    from datetime import UTC, datetime, timedelta

    from teamflow import clock

    monday = datetime(2026, 8, 17, 0, 0, tzinfo=UTC)
    weeks = {clock.team_week(monday + timedelta(days=n)) for n in range(7)}
    assert len(weeks) == 1


def test_team_week_rolls_over_at_the_team_calendar_midnight_not_utc() -> None:
    """일요일 밤 `15:30Z` 은 서울에서 **월요일 00:30** — 다음 주입니다."""
    from datetime import UTC, datetime

    from teamflow import clock

    before = clock.team_week(datetime(2026, 8, 23, 14, 0, tzinfo=UTC))
    after = clock.team_week(datetime(2026, 8, 23, 15, 30, tzinfo=UTC))
    assert clock.local_date(before[0]).isoformat() == "2026-08-17"
    assert clock.local_date(after[0]).isoformat() == "2026-08-24"


def test_team_week_ends_on_sunday_night_not_next_monday_midnight() -> None:
    """⚠️ 끝을 다음 월요일 00:00 으로 두면 제목이 하루 더 길게 나갑니다."""
    from datetime import UTC, datetime

    from teamflow import clock

    _, end = clock.team_week(datetime(2026, 8, 19, 3, 0, tzinfo=UTC))
    local_end = clock.local_time(end)
    assert local_end.hour == 23 and local_end.minute == 59
