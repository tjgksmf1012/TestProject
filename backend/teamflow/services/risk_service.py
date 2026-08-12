"""프로젝트 위험 신호를 DB 에 잇는다 (정의서 §18 · 제안서 §4.5).

## ⚠️ 판단은 여기 없습니다

전부 `projects/risk.py` 의 순수 함수에 있고 테스트도 거기 붙어 있습니다.
이 파일은 **행을 읽어 넣는 것**만 합니다.

## ⚠️ 표를 안 만듭니다

위험 신호를 행으로 쌓지 않습니다. 쌓으면 업무를 끝냈는데 "마감 대비
완료율이 낮습니다" 가 남고, 담당자를 바꿨는데 "김민수에게 몰려 있습니다"
가 남습니다. **읽을 때 셉니다** — `calendar_service`·`notification_service`
와 같은 판단입니다.
"""

from __future__ import annotations

import logging
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from teamflow.clock import today as team_today
from teamflow.db import live
from teamflow.db import models as m
from teamflow.projects import risk

logger = logging.getLogger(__name__)


def _tasks(session: Session, project_id: int) -> list[risk.TaskFacts]:
    rows = session.scalars(
        live.live_tasks().where(m.Task.project_id == project_id).order_by(m.Task.id)
    ).all()
    return [
        risk.TaskFacts(
            id=row.id,
            title=row.title,
            status=row.status,
            assignee_id=row.assignee_id,
            deadline=risk.as_date(row.deadline),
            # ⚠️ `created_at` 은 NOT NULL 이지만 방어합니다 — 없으면 오늘로
            #    치는 쪽이 "21일 열려 있었다" 로 지어내는 것보다 낫습니다.
            created_at=risk.as_date(row.created_at) or team_today(),
            completed_at=risk.as_date(row.completed_at),
        )
        for row in rows
    ]


def _members(session: Session, project_id: int) -> list[risk.Member]:
    rows = session.execute(
        select(m.User.id, m.User.name)
        .join(m.Member, m.Member.user_id == m.User.id)
        .where(m.Member.project_id == project_id)
    ).all()
    return [risk.Member(user_id=uid, name=name) for uid, name in rows]


def _edges(session: Session, project_id: int) -> list[tuple[int, int]]:
    """이 프로젝트 안의 의존성만.

    ⚠️ 프로젝트 밖 업무를 가리키는 변은 버립니다 — 남의 프로젝트 업무를
    "우리가 막혀 있다" 의 근거로 쓰면 그 업무를 열어 볼 수도 없습니다.
    """
    mine = set(
        session.scalars(live.live_task_ids().where(m.Task.project_id == project_id))
    )
    rows = session.execute(
        select(m.TaskDependency.predecessor_id, m.TaskDependency.successor_id)
    ).all()
    return [(p, s) for p, s in rows if p in mine and s in mine]


def _activity_days(session: Session, project_id: int) -> list[date]:
    """활동이 있었던 날들.

    ⚠️ `audit_logs` 가 아니라 **기여 이벤트**를 봅니다. 감사 기록에는
    설정 변경이나 조회 같은 것도 들어 있어서, 그걸로 세면 **아무 일도
    안 하고 화면만 열어도 활동이 있는 것처럼** 보입니다.
    """
    rows = session.scalars(
        select(m.ContributionEventRow.occurred_at).where(
            m.ContributionEventRow.project_id == project_id
        )
    ).all()
    return [d for d in (risk.as_date(row) for row in rows) if d is not None]


def read(session: Session, project_id: int, *, today: date | None = None) -> dict:
    """이 프로젝트의 진행률·부하·위험 신호.

    ⚠️ **아무것도 저장하지 않습니다.** 읽을 때마다 셉니다.
    """
    project = session.get(m.Project, project_id)
    if project is None:
        raise LookupError(project_id)

    when = today or team_today()
    tasks = _tasks(session, project_id)
    members = _members(session, project_id)

    done = risk.progress(tasks, today=when)
    signals = risk.all_signals(
        tasks,
        members,
        _edges(session, project_id),
        _activity_days(session, project_id),
        today=when,
        started_at=risk.as_date(project.started_at),
        deadline=risk.as_date(project.deadline),
    )

    logger.info(
        "project=%s 진행 %s/%s · 신호 %s",
        project_id,
        done.finished,
        done.total,
        [s.kind for s in signals] or "없음",
    )

    return {
        "progress": {
            "total": done.total,
            "finished": done.finished,
            "overdue": done.overdue,
            # ⚠️ 업무가 없으면 `None` 입니다 — **0.0 이 아닙니다.**
            #    0을 보내면 화면이 "시작도 안 했다" 로 그립니다.
            "ratio": done.ratio,
        },
        "load": [
            {"user_id": row.user_id, "name": row.name, "open_tasks": row.open_tasks}
            for row in risk.load_by_person(tasks, members)
        ],
        "signals": [
            {"kind": s.kind, "detail": s.detail, "task_ids": s.task_ids}
            for s in signals
        ],
    }
