"""팀이 사는 달력.

## 왜 이 파일이 따로 있는가

이 저장소는 시각을 전부 UTC 로 저장합니다. 그건 옳습니다 — 순간을 저장할
때는 그래야 합니다. 문제는 **사람이 "며칠"이라고 읽는 값**입니다.

    완료 2026-09-04T16:00Z  ←  같은 순간
    UTC 달력으로 09-04       ←  기계
    KST 달력으로 09-05       ←  사람

`datetime.date()` 는 앞의 것을 줍니다. 마감을 지켰는지, 회의가 무슨
요일에 열렸는지처럼 **사람이 달력을 보고 답하는 질문**에 그 값을 쓰면
한국(UTC+9)에서는 밤 9시 이후가 통째로 하루 앞으로 밀립니다.

## 두 번 나왔다

같은 결함을 두 곳에서 따로 찾았습니다.

* 결함 107 — `task_service` 의 마감 준수 판정. `completed_at.date()` 로
  재고 있었습니다. 밤에 끝낸 업무가 **하루 늦어도 "제때"** 였습니다.
* 결함 108 — `meeting_tasks` 의 `meeting_date`. `started_at.date()` 를
  마감 표현("내일", "다음 주 월요일")의 기준일로 넘기고 있었습니다.
  새벽에 시작한 회의에서 **"다음 주 월요일"이 회의 당일**이 됐습니다.

두 번째를 찾고 나서야 이걸 한 곳에 모았습니다. 각자 고쳤으면 세 번째가
나왔을 때 또 따로 고쳤을 겁니다 — 이 저장소에서 가장 자주 나온 결함
부류가 **"두 벌이 있으면 한쪽만 고쳐진다"** 입니다.

## 왜 UTC 오차가 늘 한쪽으로만 기우는가

UTC 는 KST 보다 항상 뒤입니다. 그래서 이 오차는 **날짜를 앞당기는
쪽으로만** 작동합니다. 마감 판정에서는 늦은 사람을 봐주고, 기준일
계산에서는 마감을 하루 당깁니다. 무작위로 틀리는 게 아니라
편향돼 있습니다.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

from teamflow.config import get_settings


def team_zone() -> ZoneInfo:
    """이 프로젝트가 쓰는 달력의 시간대."""
    return ZoneInfo(get_settings().project_timezone)


def as_utc(at: datetime) -> datetime:
    """tzinfo 가 없는 값을 UTC 로 본다.

    ## ⚠️ 왜 필요한가 — SQLite 와 PostgreSQL 이 다릅니다

    `DateTime(timezone=True)` 로 저장해도 **SQLite 는 tzinfo 를 잃고**
    돌려줍니다. PostgreSQL 은 붙여서 돌려줍니다. 그래서 DB 에서 읽은 값과
    요청으로 들어온 값을 파이썬에서 비교하면

        TypeError: can't compare offset-naive and offset-aware datetimes

    가 **테스트(SQLite)에서만** 납니다. 반대 방향이었으면 더 나빴을
    것입니다 — 배포에서만 터졌을 테니까요.

    이 저장소는 naive datetime 을 **UTC 로만** 저장하므로 이 가정은
    안전합니다. `local_date` 가 같은 이유로 같은 가정을 씁니다.
    """
    return at if at.tzinfo is not None else at.replace(tzinfo=UTC)


def local_time(at: datetime) -> datetime:
    """이 순간을 **팀 달력의 시계**로 옮긴다.

    ⚠️ 보고서가 `f"{started_at:%Y-%m-%d %H:%M}"` 로 **UTC 를 그대로** 찍고
    있었습니다 (결함 290). 같은 회의를 홈 화면은 `09-08 19:00`, 회의록은
    `2026-09-08 10:00` 이라고 했습니다 — 아홉 시간이 어긋난 쪽이 **밖으로
    나가는 문서**였습니다.

    `local_date` 가 날짜만 답하므로 시각을 물을 자리가 없었고, 그래서
    보고서는 물어보지 않고 직접 찍었습니다.
    """
    return as_utc(at).astimezone(team_zone())


def local_date(at: datetime) -> date:
    """이 순간이 팀 달력에서 며칠인가.

    ⚠️ `at.date()` 를 쓰지 마세요. 그건 UTC 달력일입니다.

    tzinfo 가 없는 값은 UTC 로 봅니다 — SQLite 가 tzinfo 를 잃고
    돌려주기 때문입니다. 이 저장소는 naive datetime 을 UTC 로만
    저장하므로 그 가정은 안전합니다.
    """
    return as_utc(at).astimezone(team_zone()).date()


def today() -> date:
    """팀 달력에서 오늘.

    ⚠️ `date.today()` 를 쓰지 마세요. 그건 **서버가 놓인 기계의** 달력이고,
    이 저장소는 그것 때문에 이미 한 번 당했습니다 — 마감 준수 판정이
    보는 사람의 시간대를 따라가 서울에서는 지연, 뉴욕에서는 제때가 되던
    자리입니다(결함 109). 달력은 `settings.project_timezone` 하나뿐입니다.

    ⚠️ 이 함수가 없던 동안 `local_date()` 를 인자 없이 부르는 코드를
    썼다가 바로 터졌습니다. 그쪽은 "이 순간이 며칠인가" 이고 이쪽은
    "지금이 며칠인가" 라, 같은 이름으로 겹쳐 두면 안 됩니다.
    """
    return local_date(datetime.now(UTC))
