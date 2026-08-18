"""회의 개선 추세 읽기 (`REVIEW-006`) — DB 의 사실을 모아 `meeting/trends.py` 에 넘긴다.

판단(절반 자르기·방향·측정 가능 여부)은 전부 저쪽 순수 모듈에 있고
여기는 질의만 합니다.

## ⚠️ 분석된 회의만 셉니다

`needs_review` 와 `confirmed` — 파이프라인이 실제로 돈 회의입니다.
`failed`·`processing`·`pending` 을 넣으면 **못 잰 회의가 "구간 0건"**
으로 세어집니다 — 측정 불가를 0으로 바꾸는 바로 그 실수입니다.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from teamflow.db import models as m
from teamflow.meeting import trends

#: 파이프라인이 돌아 구간을 찾아봤다는 뜻의 상태들.
ANALYZED_STATUSES = ("needs_review", "confirmed")


def read(session: Session, project_id: int) -> dict:
    meetings = session.scalars(
        select(m.Meeting)
        .where(
            m.Meeting.project_id == project_id,
            m.Meeting.status.in_(ANALYZED_STATUSES),
        )
        .order_by(m.Meeting.started_at, m.Meeting.id)
    ).all()

    if not trends.measurable(len(meetings)):
        # ⚠️ 문장이 아니라 숫자를 보냅니다 — 말은 화면이 만듭니다
        #    (위험 신호와 같은 규칙 · `lib/analytics/trends.ts`).
        return {
            "measurable": False,
            "meetings_counted": len(meetings),
            "needed": trends.MIN_MEETINGS,
            "kinds": [],
        }

    meeting_ids = [meeting.id for meeting in meetings]
    rows = session.execute(
        select(m.MeetingEvent.meeting_id, m.MeetingEvent.event_type).where(
            m.MeetingEvent.meeting_id.in_(meeting_ids)
        )
    ).all()

    counts: dict[tuple[int, str], int] = {}
    for meeting_id, event_type in rows:
        key = (meeting_id, event_type)
        counts[key] = counts.get(key, 0) + 1

    # 회의 시간 순 수열. 구간이 없던 회의는 0 — **분석은 됐는데 안 걸린**
    # 것이라 0 이 맞습니다 (분석 안 된 회의는 위에서 이미 뺐습니다).
    series_by_kind = {
        str(kind): [counts.get((meeting_id, str(kind)), 0) for meeting_id in meeting_ids]
        for kind in trends.vocab.MeetingEventType
    }

    return {
        "measurable": True,
        "meetings_counted": len(meetings),
        "needed": trends.MIN_MEETINGS,
        "kinds": [
            {
                "kind": t.kind,
                "early_avg": t.early_avg,
                "late_avg": t.late_avg,
                "direction": t.direction,
            }
            for t in trends.kind_trends(series_by_kind)
        ],
    }
