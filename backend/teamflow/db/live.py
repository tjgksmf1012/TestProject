"""지운 것을 빼고 읽는 자리 (`TASK-003`).

## ⚠️ 왜 한 곳이어야 하는가

업무를 읽는 곳이 **일곱 군데**입니다 — 칸반·달력·검색·알림·위험 신호·
회의 업무 후보·PR 연결. 각자 `deleted_at IS NULL` 을 적게 두면 그중
하나는 반드시 빠지고, 빠진 곳에서 **지운 업무가 되살아납니다.**

그리고 되살아난 자리가 조용합니다. 오류가 안 나고, 달력에만 · 진행률에만
남습니다. 이 저장소의 대표 실패 ② 가 정확히 이 모양입니다.

⚠️ `test_repo_integrity.py` 가 `m.Task` 를 읽는 파일이 여기를 안 거치면
터집니다.
"""

from __future__ import annotations

from sqlalchemy import ColumnElement, Select, select

from teamflow.db import models as m


def not_deleted() -> ColumnElement[bool]:
    """살아 있는 업무 조건.

    다른 칸을 같이 고르는 질의(`select(m.Task, m.User.name)`)에서 씁니다 —
    거기서는 `live_tasks()` 로 시작할 수 없습니다.
    """
    return m.Task.deleted_at.is_(None)


def live_tasks() -> Select:
    """지우지 않은 업무만.

    ⚠️ `where()` 를 이어 붙여 쓰십시오. 처음부터 다시 `select(m.Task)` 로
    시작하면 이 조건이 사라집니다.
    """
    return select(m.Task).where(not_deleted())


def live_task_ids() -> Select:
    """지우지 않은 업무의 번호만. 의존성 변을 거를 때 씁니다."""
    return select(m.Task.id).where(not_deleted())
