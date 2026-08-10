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


def enqueue_github_ingest(event_id: int) -> str | None:
    """웹훅 이벤트를 기여 이벤트로 옮기는 잡을 CPU 큐에 넣는다.

    회의 처리와 같은 이유로 `retry=False` 입니다 — 브로커가 죽었을 때
    **GitHub 의 웹훅 요청을 붙잡으면 안 됩니다.** GitHub 은 응답을 10초 안에
    기대하고, 늦으면 배달 실패로 보고 재전송합니다. 재전송은 `GithubEvent`
    의 `delivery_id` 중복 검사가 막지만, 그 전에 우리 워커가 요청 슬롯을
    붙잡고 있는 상태가 됩니다.

    큐에 못 넣어도 잃지 않습니다 — 웹훅 본문은 이미 DB 에 저장돼 있으므로
    나중에 이 잡을 event_id 로 다시 걸면 됩니다.
    """
    try:
        from teamflow.tasks.github_tasks import ingest_github_event_task

        result = ingest_github_event_task.apply_async(
            args=[event_id], retry=False, ignore_result=True
        )
        return str(result.id)
    except Exception:
        logger.exception("github_event %s 수집을 큐에 넣지 못했습니다", event_id)
        return None


def enqueue_github_backfill(project_id: int, limit: int) -> str | None:
    """연결 전 활동을 채우는 잡을 CPU 큐에 넣는다.

    ⚠️ 여기는 `retry=False` 가 **아닙니다.** 웹훅과 달리 이건 사람이 버튼을
    눌러 시작합니다. 브로커가 잠깐 느릴 때 조용히 포기하면, 화면은
    "가져오는 중" 이라고 말했는데 아무 일도 안 일어난 채로 끝납니다 —
    그러고 나면 사람은 기여도가 왜 안 늘었는지 알 방법이 없습니다.

    실패하면 None 을 돌려주고 로그를 남깁니다. 다시 누르면 됩니다 —
    백필은 이미 있는 PR 을 건너뛰므로 두 번 눌러도 안전합니다.
    """
    try:
        from teamflow.tasks.github_tasks import backfill_project_task

        result = backfill_project_task.apply_async(
            args=[project_id, limit], ignore_result=True
        )
        return str(result.id)
    except Exception:
        logger.exception("project %s 백필을 큐에 넣지 못했습니다", project_id)
        return None
