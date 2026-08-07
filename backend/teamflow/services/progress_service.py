"""회의 처리가 **어디까지 갔는지** 읽는다.

## 왜 필요한가

`pipeline/steps.py` 의 `RedisProgress` 는 처음부터 있었고, 그 docstring 은
이렇게 적혀 있었습니다.

    "Redis 해시에 진행률을 쓴다. **API가 SSE로 프런트에 흘린다.**"

그 API 가 없었습니다. 쓰기만 하고 **읽는 곳이 0곳**이었습니다 — 이
저장소가 반복해 당한 부류 그대로입니다 (감사 #8).

그동안 화면이 할 수 있는 말은 "처리 중입니다" 뿐이었습니다. 1시간 회의는
처리에 10분이 걸릴 수 있는데, 그 10분 동안 사람이 아는 것은 **아무것도
없습니다.** 멈춘 건지 도는 건지도 모릅니다.

## ⚠️ SSE 로 안 만든 이유

감사는 "SSE 엔드포인트가 존재하지 않는다" 고 적었지만, **SSE 는 이
저장소가 이미 거부한 방식**입니다. `src/demo/lobby.ts` 의 주석:

    "SSE·WebSocket 을 붙이면 서버에 상태가 생기고, 그건 이 화면 하나
     때문에 지불하기엔 비쌉니다. 3초 폴링이면 충분합니다."

로비는 이미 3초마다 폴링합니다. 그 요청에 진행률을 얹으면 새 연결도,
새 상태도 필요 없습니다. **읽기 엔드포인트 하나면 됩니다.**

## ⚠️ 없는 것을 0% 로 답하지 않는다

진행률이 없는 이유는 여럿입니다.

    아직 시작 안 함     처리 큐에 들어갔지만 첫 단계 전
    이미 끝남           TTL 24시간이 지났거나 처리가 완료됨
    Redis 가 없음       이 환경이 그렇습니다

셋 다 "0%" 로 답하면 사람은 **멈춰 있다**고 읽습니다. 그건 이 프로젝트가
가장 피하는 실패입니다 — 모르는 것을 아는 것처럼 답하는 것.
그래서 `None` 을 돌려주고, 문구는 회의 상태를 함께 봐서 정합니다.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)

#: `pipeline/steps.py` 의 `RedisProgress` 가 쓰는 키. **두 곳이 같아야
#: 합니다** — 한쪽만 바꾸면 읽는 쪽이 조용히 빈 값을 받습니다.
KEY_TEMPLATE = "teamflow:meeting:{meeting_id}:progress"


@dataclass(frozen=True, slots=True)
class Progress:
    """파이프라인이 마지막으로 보고한 지점."""

    stage: str
    percent: int
    detail: str = ""


def progress_key(meeting_id: int) -> str:
    return KEY_TEMPLATE.format(meeting_id=meeting_id)


def parse_progress(raw: object) -> Progress | None:
    """Redis 해시 → `Progress`. **못 읽으면 `None`.**

    ⚠️ 값이 깨져 있어도 예외를 내지 않습니다. 진행률은 **보조 정보**라,
    이것 때문에 로비 화면 전체가 죽으면 안 됩니다. 못 읽으면 모르는
    것으로 답합니다.
    """
    if not isinstance(raw, dict) or not raw:
        return None

    stage = str(raw.get("stage") or "").strip()
    if not stage:
        # 단계 이름이 없으면 백분율만으로는 아무 뜻이 없습니다.
        return None

    try:
        percent = int(raw.get("percent") or 0)
    except (TypeError, ValueError):
        percent = 0

    # 100 을 넘거나 음수인 값을 그대로 보여주면 화면이 고장 나 보입니다.
    percent = max(0, min(percent, 100))
    return Progress(stage=stage, percent=percent, detail=str(raw.get("detail") or ""))


def read_progress(client: object, meeting_id: int) -> Progress | None:
    """Redis 에서 읽는다. **없거나 못 읽으면 `None`.**

    `client` 가 `None` 이면 이 배포에 Redis 가 없다는 뜻입니다 — 그것도
    "모른다" 입니다. 예외를 던지면 로비가 통째로 오류 화면이 됩니다.
    """
    if client is None:
        return None
    try:
        raw = client.hgetall(progress_key(meeting_id))  # type: ignore[attr-defined]
    except Exception as exc:  # 진행률 때문에 화면이 죽으면 안 된다
        logger.warning("meeting=%s 진행률을 읽지 못했습니다: %s", meeting_id, exc)
        return None
    return parse_progress(raw)


_client_cache: list[object] = []


def progress_client(redis_url: str | None) -> object | None:
    """진행률을 읽을 Redis 클라이언트. **없으면 `None`.**

    ⚠️ 여기서 예외를 던지면 안 됩니다. Redis 는 이 시스템의 **선택
    부품**입니다 — 없어도 회의는 열리고 녹음은 되고 기여도는 나옵니다.
    진행률만 못 보는 것이지, 그것 때문에 API 가 죽으면 안 됩니다.

    클라이언트는 한 번만 만듭니다. 요청마다 만들면 연결 풀이 요청 수만큼
    생깁니다.
    """
    if _client_cache:
        return _client_cache[0]
    if not redis_url:
        return None
    try:
        import redis as redis_lib

        client = redis_lib.Redis.from_url(redis_url, decode_responses=True)
    except Exception as exc:  # Redis 는 선택 부품이다
        logger.warning("진행률용 Redis 를 만들지 못했습니다: %s", exc)
        return None
    _client_cache.append(client)
    return client


#: 단계 이름을 사람의 말로. **우리 용어를 화면에 내보내지 않습니다.**
STAGE_TEXT: dict[str, str] = {
    "load": "녹음 파일을 읽는 중",
    "align": "트랙 시각을 맞추는 중",
    "transcribe": "말을 글로 옮기는 중",
    "diarize": "누가 말했는지 가리는 중",
    "analyze": "회의 내용을 정리하는 중",
    "persist": "결과를 저장하는 중",
}


def describe(progress: Progress | None, *, meeting_status: str) -> str:
    """화면에 그대로 쓸 한 줄.

    ⚠️ 진행률이 없을 때 **회의 상태에 따라 다른 말을 합니다.** 사람이 할
    일이 다르기 때문입니다.

        처리 전/중 + 진행률 없음  → 아직 못 받았다. 기다리면 된다
        처리 끝    + 진행률 없음  → 끝난 것이다. 기다릴 필요 없다
    """
    if progress is not None:
        stage = STAGE_TEXT.get(progress.stage, "처리 중")
        line = f"{stage} · {progress.percent}%"
        return f"{line} — {progress.detail}" if progress.detail else line

    if meeting_status in ("queued", "processing"):
        # ⚠️ "0%" 가 아닙니다. 모르는 것과 안 한 것은 다릅니다.
        return "처리 중입니다 — 진행 상황은 아직 알 수 없습니다"
    if meeting_status == "failed":
        return "처리에 실패했습니다"
    return ""
