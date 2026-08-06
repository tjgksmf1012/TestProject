"""로그 설정.

이 저장소의 결함은 거의 전부 **조용히** 일어난다.

    · 커밋 전에 큐에 넣어서 마지막 트랙이 버려진다
    · `--profile app` 이 gpu 큐 소비자를 안 띄워 회의가 영영 queued 다
    · 없는 후보를 승인해도 200 이 나온다
    · 재처리가 이미 검토된 회의라 건너뛴다

예외가 안 나므로 **로그가 유일한 흔적**이다. 그런데 지금까지 이 저장소에는
로그 설정이 한 줄도 없었다. 그 상태에서 무슨 일이 일어나는지가 중요하다.

  · `logging.getLogger("teamflow.…")` 는 핸들러가 없으면 상위로 전파한다.
  · 루트 로거도 핸들러가 없다.
  · 그러면 파이썬은 `logging.lastResort` 로 떨어지는데, 그 핸들러의 레벨이
    **WARNING** 이다.

즉 위 네 가지가 남기는 `logger.info(...)` 는 **전부 버려지고 있었다.** 워커에서
운 좋게 보였던 것은 Celery 가 자기 로깅을 따로 세팅하기 때문이고, API
컨테이너에서는 아무것도 안 보였다.

## 왜 dictConfig 인가

`basicConfig` 는 루트에 핸들러가 이미 있으면 **아무 일도 하지 않는다.**
uvicorn·Celery 는 자기 핸들러를 붙이므로, 어느 쪽이 먼저 뜨느냐에 따라
설정이 적용되기도 하고 안 되기도 한다. 그건 "테스트는 통과하는데 실제로는
동작하지 않는" 결함이 자라는 자리다. dictConfig 는 지정한 로거를 덮어쓴다.
"""

from __future__ import annotations

import json
import logging
import logging.config
from typing import Any

from teamflow.config import Settings, get_settings

TEXT_FORMAT = "%(asctime)s %(levelname)-7s %(name)s %(message)s"

# 개인정보·시크릿이 아닌 것만 JSON 최상위로 올린다.
# LogRecord 의 나머지 속성은 넣지 않는다 — args 에 사용자 데이터가 들어 있고,
# 그걸 통째로 직렬화하면 로그 수집기로 개인정보가 흘러간다 (docs/07 P4).
_JSON_FIELDS = ("levelname", "name", "module", "funcName", "lineno")


class JsonFormatter(logging.Formatter):
    """의존성 없는 한 줄 JSON 포매터.

    `python-json-logger` 를 쓰지 않는 이유는 이 프로젝트의 제약이다 —
    의존성 하나가 늘면 그만큼 설치가 무거워지고, 이 정도는 20줄이면 된다.
    """

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "message": record.getMessage(),
        }
        for field in _JSON_FIELDS:
            payload[field] = getattr(record, field, None)
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        # ensure_ascii=False 여야 한국어 로그가 \uXXXX 로 깨지지 않는다.
        return json.dumps(payload, ensure_ascii=False, default=str)


def build_config(settings: Settings | None = None) -> dict[str, Any]:
    """dictConfig 에 넣을 사전. 테스트가 들여다볼 수 있게 따로 뺐다."""
    settings = settings or get_settings()
    level = settings.log_level.upper()
    formatter = "json" if settings.log_format.lower() == "json" else "text"

    return {
        "version": 1,
        # ⚠️ False 여야 한다. True 로 두면 이 함수가 불리기 **전에** 만들어진
        # 로거 — 즉 `teamflow.*` 모듈들이 import 시점에 만든 로거 전부 —
        # 가 비활성화된다. 설정을 켰는데 로그가 사라지는 최악의 조합이다.
        "disable_existing_loggers": False,
        "formatters": {
            "text": {"format": TEXT_FORMAT},
            "json": {"()": f"{__name__}.JsonFormatter"},
        },
        "handlers": {
            "console": {
                "class": "logging.StreamHandler",
                "formatter": formatter,
                # stdout 이다. stderr 로 보내면 컨테이너 로그에서 정상 동작이
                # 전부 오류처럼 보인다.
                "stream": "ext://sys.stdout",
            }
        },
        "loggers": {
            # 우리 코드. 루트에 맡기지 않고 명시하는 이유는, 라이브러리가
            # 루트 레벨을 올려 버려도 우리 로그는 살아 있어야 하기 때문이다.
            "teamflow": {"level": level, "handlers": ["console"], "propagate": False},
            # uvicorn 은 자기 핸들러를 붙인다. 여기서 다시 잡아 형식을 통일한다.
            "uvicorn": {"level": level, "handlers": ["console"], "propagate": False},
            "uvicorn.error": {"level": level, "handlers": ["console"], "propagate": False},
            "uvicorn.access": {"level": level, "handlers": ["console"], "propagate": False},
            "celery": {"level": level, "handlers": ["console"], "propagate": False},
            # SQLAlchemy 는 WARNING 으로 눌러 둔다. INFO 면 쿼리가 전부 찍히고,
            # 그 쿼리 파라미터에는 회의 내용과 사용자 이름이 들어 있다.
            "sqlalchemy.engine": {"level": "WARNING", "handlers": ["console"], "propagate": False},
        },
        "root": {"level": "WARNING", "handlers": ["console"]},
    }


def configure_logging(settings: Settings | None = None) -> None:
    """프로세스 로깅을 설정한다. 여러 번 불러도 안전하다."""
    logging.config.dictConfig(build_config(settings))
