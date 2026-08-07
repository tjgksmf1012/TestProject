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
from celery.signals import setup_logging as _setup_logging

from teamflow.config import get_settings
from teamflow.logging_config import configure_logging

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
    # ── Redis 가 죽었을 때 빨리 실패한다 ────────────────────────
    #
    # 기본값이면 연결 실패 시 백오프하며 재시도를 반복한다. 워커에서는
    # 그래도 되지만, **API 가 잡을 큐에 넣을 때는 재앙**이다. 사용자가
    # "정지" 를 누르고 20초를 기다리게 된다 (실측 19.5초).
    #
    # 녹음은 이미 저장돼 있으므로 큐잉 실패는 나중에 복구할 수 있다.
    # 요청을 붙잡는 것보다 빨리 실패하고 로그를 남기는 게 낫다.
    broker_transport_options={
        "socket_connect_timeout": 2,
        "socket_timeout": 2,
        "max_retries": 1,
    },
    result_backend_transport_options={
        "socket_connect_timeout": 2,
        "socket_timeout": 2,
        "max_retries": 1,
        "retry_policy": {"timeout": 3.0},
    },
    broker_connection_retry_on_startup=False,
    # ⚠️ **워커가 import 할 모듈을 여기 적는다.**
    #
    # 예전에는 아래에서 `autodiscover_tasks(["teamflow.tasks"], force=True)`
    # 를 불렀는데, `related_name` 기본값이 `"tasks"` 라 그건
    # **`teamflow.tasks.tasks`** 모듈을 찾습니다. 그런 모듈은 없습니다.
    #
    # 결과는 워커의 태스크 레지스트리가 **비어 있는 것**이었습니다. beat 가
    # 04:00 에 `purge_expired_audio_task` 를 이름으로 보내면 워커는
    # unregistered 로 버립니다. 즉 문서대로 스케줄러를 정확히 띄워도
    # **원본 음성(생체인식정보)이 무기한 남습니다.** 회의 처리도 마찬가지로
    # 조용히 멈춥니다.
    #
    # 테스트가 초록이던 이유: 테스트는 `from teamflow.tasks import
    # meeting_tasks` 를 직접 import 하므로 데코레이터가 그때 실행됩니다.
    # 워커의 기동 경로(`loader.import_default_modules()`)와 다릅니다.
    #
    # 자동 탐색 대신 **명시적으로 적습니다.** 모듈이 늘면 여기 추가해야
    # 하는데, 빠뜨리면 `test_packaging.py` 가 잡습니다.
    imports=(
        "teamflow.tasks.meeting_tasks",
        "teamflow.tasks.github_tasks",
        "teamflow.tasks.maintenance",
    ),
    task_routes={
        "teamflow.tasks.meeting_tasks.process_meeting_task": {"queue": "gpu"},
        "teamflow.tasks.meeting_tasks.persist_results_task": {"queue": "cpu"},
        "teamflow.tasks.github_tasks.*": {"queue": "cpu"},
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
        # 끝난 프로젝트의 성문 폐기. docs/07 §2.4
        #
        # 성문 임베딩은 문서가 **가장 민감한 데이터**로 분류한
        # 생체인식정보이고, 보존기간이 "프로젝트 종료 시" 로 가장
        # 짧습니다. 그런데 그 만료를 실행하는 스케줄이 없었습니다 —
        # 태스크는 선언돼 있고 docstring 에 "프로젝트가 끝났는데 남아
        # 있으면 목적 외 보관이 된다" 라고 적혀 있는데 **부르는 곳이
        # 하나도 없었습니다.**
        "revoke-finished-project-voiceprints": {
            "task": "teamflow.tasks.maintenance.revoke_finished_project_voiceprints_task",
            "schedule": crontab(hour=4, minute=30),
        },
    },
)


@_setup_logging.connect
def _configure_worker_logging(**_kwargs: object) -> None:
    """워커 로깅을 우리 설정으로 잡는다.

    이 시그널에 **연결하는 것 자체가** Celery 에게 "로깅은 내가 한다" 는
    뜻이다. 연결하지 않으면 Celery 가 루트 로거를 가로채(`worker_hijack_root_logger`
    기본값 True) 자기 형식으로 덮어쓴다. 그러면 API 와 워커의 로그 형식이
    갈리고, `log_format=json` 을 켜도 워커만 텍스트로 나간다.
    """
    configure_logging()


__all__ = ["app"]
