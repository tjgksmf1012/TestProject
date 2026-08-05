"""Celery 앱.

    celery -A teamflow.tasks worker -Q cpu --concurrency=4
    celery -A teamflow.tasks worker -Q gpu --concurrency=1   # ⚠️ 1 필수
    celery -A teamflow.tasks beat

docs/03-시스템-아키텍처.md §2.1

GPU 큐의 concurrency 가 1이어야 하는 이유: VRAM에 ASR + 화자분리 + LLM을
동시에 못 올린다. 잡을 병렬로 돌리면 OOM 이다.
Redis 배타 락(`jobs/gpu_lock.py`)이 2차 방어선이다 — 워커를 여러 대 띄우거나
워커 밖에서 GPU를 쓰는 경로가 생겨도 막힌다.
"""

from __future__ import annotations

from celery import Celery
from celery.schedules import crontab

from teamflow.config import get_settings

settings = get_settings()

app = Celery("teamflow", broker=settings.redis_url, backend=settings.redis_url)

app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="Asia/Seoul",
    enable_utc=True,
    # 워커가 죽어도 잡을 잃지 않는다. 회의 처리는 몇 분씩 걸려서
    # 중간에 워커가 재시작되면 통째로 날아간다.
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    # GPU 워커는 한 번에 하나만 가져간다. prefetch 를 키우면
    # 다른 워커가 놀고 있는데 잡이 한쪽에 쌓인다.
    worker_prefetch_multiplier=1,
    task_routes={
        "teamflow.tasks.meeting_tasks.process_meeting_task": {"queue": "gpu"},
        "teamflow.tasks.meeting_tasks.persist_results_task": {"queue": "cpu"},
        "teamflow.tasks.maintenance.*": {"queue": "cpu"},
    },
    beat_schedule={
        # 보존기간 만료 오디오 삭제. 법적 요구사항이라 반드시 돌아야 한다.
        # docs/07 P5
        "purge-expired-audio": {
            "task": "teamflow.tasks.maintenance.purge_expired_audio_task",
            "schedule": crontab(hour=4, minute=0),
        },
        # 웹훅 유실 대비 정합성 확인. docs/03 §4.2
        "reconcile-github": {
            "task": "teamflow.tasks.maintenance.reconcile_github_task",
            "schedule": crontab(hour=5, minute=0),
        },
    },
)

app.autodiscover_tasks(["teamflow.tasks"], force=True)

__all__ = ["app"]
