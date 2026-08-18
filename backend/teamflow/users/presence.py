"""지금 붙어 있는가 (요구사항 정의서 §4 `USER-005`).

## ⚠️ 이건 근태 기록이 **아닙니다**

상태를 행으로 쌓으면 그 표는 곧 출퇴근부가 됩니다. 이 제품은 기여를
**무엇을 했는가**로 재기로 했는데, 옆에 "언제 앉아 있었는가" 가 쌓이면
사람은 그 둘을 같이 봅니다 — 그리고 늦게 접속하는 사람이 일을 덜 한
것으로 읽힙니다. 실제로는 아무 관계가 없습니다.

그래서 셋을 지킵니다.

1. **저장하지 않습니다.** 읽을 때마다 계산합니다
2. **과거를 말하지 않습니다.** `마지막 접속 3일 전` 은 상태가 아니라
   기록입니다. 지금 없으면 그냥 `offline` 입니다
3. **기여도에 안 들어갑니다.** 접속 시간은 점수가 아닙니다

## ⚠️ 눈금이 굵습니다

분 단위로 정확히 말하지 않습니다. 정확할수록 감시에 가까워지고, 정확할
이유도 없습니다 — 사람이 알고 싶은 것은 "지금 말 걸어도 되나" 하나입니다.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from teamflow.db.vocab import PresenceStatus

#: 이 안에 움직였으면 붙어 있는 것으로 봅니다.
ONLINE_WITHIN = timedelta(minutes=5)

#: 여기까지는 로그인은 살아 있다고 봅니다. 넘으면 오프라인.
#:
#: ⚠️ 30분은 **눈금이 굵어야 한다**는 판단에서 나온 값입니다. 짧게 잡으면
#: 잠깐 자리를 비운 것이 계속 오프라인으로 깜빡이고, 사람은 그걸
#: "쟤 또 없네" 로 읽습니다.
AWAY_WITHIN = timedelta(minutes=30)


def status_of(
    *,
    last_seen: datetime | None,
    in_meeting: bool,
    now: datetime,
) -> PresenceStatus:
    """지금 상태.

    ⚠️ **회의 중이 제일 셉니다.** 녹음 중인 회의에 트랙이 열려 있으면
    마지막 요청이 언제였든 회의 중입니다 — 회의 화면은 요청을 자주
    보내지 않아서, 시간만 보면 회의하는 사람이 자리 비움으로 뜹니다.

    ⚠️ **`last_seen` 이 없으면 오프라인입니다.** 한 번도 안 들어온 것과
    오래전에 나간 것을 구분하지 않습니다 — 구분해서 보여 주면 그게 곧
    "가입만 하고 안 들어온 사람" 표시가 됩니다.
    """
    if in_meeting:
        return PresenceStatus.IN_MEETING
    if last_seen is None:
        return PresenceStatus.OFFLINE

    quiet = now - last_seen
    # ⚠️ 시계가 어긋나 미래로 찍힌 값을 **온라인으로 봅니다.** 음수를
    #    오프라인으로 처리하면 서버 시계가 조금 뒤처진 순간 팀 전체가
    #    오프라인으로 보입니다.
    if quiet <= ONLINE_WITHIN:
        return PresenceStatus.ONLINE
    if quiet <= AWAY_WITHIN:
        return PresenceStatus.AWAY
    return PresenceStatus.OFFLINE


def should_touch(last_seen: datetime | None, now: datetime) -> bool:
    """`last_seen` 을 다시 적을 때가 됐는가.

    ⚠️ **요청마다 쓰지 않습니다.** 화면 하나가 API 를 여럿 부르므로
    그대로 두면 쓰기가 읽기만큼 생깁니다. 눈금이 5분이라 1분마다 적어도
    답은 안 달라집니다.
    """
    if last_seen is None:
        return True
    return now - last_seen >= timedelta(minutes=1)
