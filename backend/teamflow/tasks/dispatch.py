"""큐에 넣는 지점을 한 곳으로 모은다.

API 가 Celery 를 직접 부르지 않는 이유:

  - **테스트에 브로커가 필요 없어진다.** 이 모듈의 함수 하나만 갈아끼우면
    "큐에 들어갔는가"를 검사할 수 있다.
  - Celery import 가 요청 경로에 들어오지 않는다. `app` 을 import 하는 순간
    브로커 설정이 읽히므로, API 기동이 Redis 에 묶이면 안 된다.

그래서 여기서만 지연 import 한다.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def enqueue_meeting_processing(meeting_id: int) -> str | None:
    """회의 처리를 GPU 큐에 넣는다.

    Returns:
        Celery 태스크 id. 큐에 넣지 못했으면 None.

    브로커가 죽어 있어도 **요청을 실패시키지 않는다.** 녹음은 이미 저장됐고,
    처리는 나중에 다시 걸 수 있다. 여기서 500 을 내면 사용자는 녹음이
    날아간 줄 알고 다시 녹음한다 — 그게 더 나쁘다.
    """
    try:
        from teamflow.tasks.meeting_tasks import process_meeting_task

        # retry=False 가 핵심이다.
        #
        # 기본값(retry=True)이면 브로커가 죽었을 때 Celery 가 백오프하며
        # **재연결을 반복한다.** 그 동안 HTTP 요청이 통째로 붙잡힌다 —
        # 사용자는 "정지" 를 누르고 몇 십 초를 기다리게 된다.
        # 여기서는 빨리 실패하고 로그를 남기는 게 맞다.
        # ignore_result=True 도 중요하다. 결과를 안 쓰는데 결과 백엔드에
        # 연결하려 들면 그것도 재시도한다 — 실측으로 3.5초를 더 잡아먹었다.
        # 진행 상황은 RedisProgress 로 따로 보고, 여기서는 잡을 넣기만 한다.
        result = process_meeting_task.apply_async(
            args=[meeting_id], retry=False, ignore_result=True
        )
        return str(result.id)
    except Exception:  # 브로커 장애 종류를 여기서 나열할 수 없다
        logger.exception("회의 %s 처리를 큐에 넣지 못했습니다", meeting_id)
        return None
