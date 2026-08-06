"""로그 설정 테스트.

이 저장소에서 반복해서 나온 결함이 "그물을 켰다고 적어 놓고 안 켜진" 것이라,
여기서도 **로그가 실제로 흘러나오는지**를 잰다. 설정 사전의 모양만 보는
테스트는 아무것도 보장하지 않는다 — dictConfig 가 그 사전을 어떻게 해석하는지가
전부이기 때문이다. 그래서 대부분의 테스트가 진짜 dictConfig 를 돌리고
스트림에 찍힌 글자를 읽는다.
"""

from __future__ import annotations

import io
import json
import logging
import logging.config
from collections.abc import Iterator
from pathlib import Path

import pytest

from teamflow.config import TRUSTED_FIELDS, Settings
from teamflow.logging_config import JsonFormatter, build_config, configure_logging

BACKEND = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def restore_logging() -> Iterator[None]:
    """전역 로깅을 건드리는 테스트라 원상복구가 필수다.

    복구하지 않으면 이 파일 이후의 테스트가 우리 핸들러를 물고 돌게 되고,
    실패 원인이 파일 순서에 따라 바뀐다.
    """
    root = logging.getLogger()
    saved_handlers = list(root.handlers)
    saved_level = root.level
    saved = {
        name: (lg.level, list(lg.handlers), lg.propagate, lg.disabled)
        for name, lg in list(logging.getLogger().manager.loggerDict.items())
        if isinstance(lg, logging.Logger)
    }
    try:
        yield
    finally:
        root.handlers[:] = saved_handlers
        root.setLevel(saved_level)
        for name, (level, handlers, propagate, disabled) in saved.items():
            lg = logging.getLogger(name)
            lg.setLevel(level)
            lg.handlers[:] = handlers
            lg.propagate = propagate
            lg.disabled = disabled


def apply(settings: Settings) -> io.StringIO:
    """진짜 dictConfig 를 돌리되 출력만 가로챈다."""
    config = build_config(settings)
    stream = io.StringIO()
    config["handlers"]["console"]["stream"] = stream
    logging.config.dictConfig(config)
    return stream


def settings(**over: object) -> Settings:
    return Settings(_env_file=None, **over)  # type: ignore[arg-type]


# ══════════════════════════════════════════════════════════════
# 결함의 원리
# ══════════════════════════════════════════════════════════════


def test_python_drops_info_when_nobody_configured_logging():
    """⭐ 설정이 없으면 INFO 가 버려진다 — 이게 고치려는 결함 그 자체다.

    핸들러가 하나도 없으면 파이썬은 `logging.lastResort` 로 떨어지는데,
    그 핸들러의 레벨이 WARNING 이다. 즉 "큐잉을 건너뜁니다", "트랙을
    찾지 못했습니다" 같은 INFO 는 **아무 데도 남지 않는다.** 이 저장소의
    결함은 대부분 예외를 내지 않으므로, 그 로그가 유일한 흔적이었다.
    """
    assert logging.lastResort is not None
    assert logging.lastResort.level == logging.WARNING


def test_our_modules_all_log_under_the_teamflow_prefix():
    """⭐ 설정은 `teamflow` 로거만 잡는다. 그 밖에서 찍으면 새어 나간다.

    `logging.getLogger("meeting")` 처럼 최상위 이름을 쓰면 우리 설정을
    타지 않는다. 소스를 직접 훑어서 고정한다 — 규칙을 문서에만 적어 두면
    다음 파일에서 깨진다.
    """
    # 문자열이 아니라 **호출**을 본다. 주석·독스트링에 적힌 예시를 결함으로
    # 세면 이 테스트는 곧 무시당하고, 무시당하는 테스트는 없는 것과 같다.
    import ast

    offenders = []
    for path in (BACKEND / "teamflow").rglob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if not (isinstance(func, ast.Attribute) and func.attr == "getLogger"):
                continue
            args = node.args
            ok = len(args) == 1 and isinstance(args[0], ast.Name) and args[0].id == "__name__"
            if not ok:
                offenders.append(f"{path.relative_to(BACKEND)}:{node.lineno}")
    assert not offenders, "getLogger(__name__) 이 아닌 곳: " + ", ".join(offenders)


# ══════════════════════════════════════════════════════════════
# 실제로 흘러나오는가
# ══════════════════════════════════════════════════════════════


def test_info_actually_reaches_the_stream():
    """⭐ 설정을 켠 뒤에는 INFO 가 나온다."""
    stream = apply(settings())
    logging.getLogger("teamflow.tasks.meeting_tasks").info("회의 %s 큐잉", 7)

    out = stream.getvalue()
    assert "회의 7 큐잉" in out
    assert "INFO" in out
    assert "teamflow.tasks.meeting_tasks" in out


def test_debug_is_off_by_default_and_on_when_asked():
    quiet = apply(settings())
    logging.getLogger("teamflow.x").debug("숨어야 한다")
    assert quiet.getvalue() == ""

    loud = apply(settings(log_level="DEBUG"))
    logging.getLogger("teamflow.x").debug("보여야 한다")
    assert "보여야 한다" in loud.getvalue()


def test_level_is_case_insensitive():
    stream = apply(settings(log_level="debug"))
    logging.getLogger("teamflow.x").debug("소문자 레벨도 먹어야 한다")
    assert "소문자 레벨도" in stream.getvalue()


def test_exceptions_carry_their_traceback():
    """오류 로그에 스택이 없으면 원인을 못 찾는다."""
    stream = apply(settings())
    try:
        raise ValueError("터졌다")
    except ValueError:
        logging.getLogger("teamflow.x").exception("처리 실패")

    out = stream.getvalue()
    assert "처리 실패" in out
    assert "ValueError: 터졌다" in out
    assert "Traceback" in out


# ══════════════════════════════════════════════════════════════
# JSON
# ══════════════════════════════════════════════════════════════


def test_json_format_is_one_parsable_line_per_record():
    stream = apply(settings(log_format="json"))
    logging.getLogger("teamflow.api.main").warning("트랙 %s 없음", 3)

    lines = [ln for ln in stream.getvalue().splitlines() if ln.strip()]
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert record["message"] == "트랙 3 없음"
    assert record["levelname"] == "WARNING"
    assert record["name"] == "teamflow.api.main"
    assert record["ts"]


def test_json_keeps_korean_readable():
    """⭐ `\\uD68C\\uC758` 로 나가면 사람이 로그를 못 읽는다.

    json.dumps 의 기본값이 ensure_ascii=True 라, 그냥 두면 한국어 로그가
    전부 이스케이프된다. 로그를 읽는 목적이 사라진다.
    """
    stream = apply(settings(log_format="json"))
    logging.getLogger("teamflow.x").info("회의가 큐에서 멈췄습니다")

    raw = stream.getvalue()
    assert "회의가 큐에서 멈췄습니다" in raw
    assert "\\u" not in raw


def test_json_exception_goes_into_its_own_field():
    stream = apply(settings(log_format="json"))
    try:
        raise RuntimeError("bang")
    except RuntimeError:
        logging.getLogger("teamflow.x").exception("실패")

    record = json.loads(stream.getvalue().splitlines()[0])
    assert "RuntimeError: bang" in record["exc"]
    # message 에 스택이 섞이면 한 줄 JSON 이 깨진다.
    assert record["message"] == "실패"


def test_json_formatter_does_not_dump_arbitrary_record_attributes():
    """⭐ LogRecord 를 통째로 직렬화하면 개인정보가 새어 나간다.

    `record.args` 에는 회의 내용·사용자 이름이 들어 있다. 로그 수집기로
    보내는 JSON 에 그게 구조화된 필드로 실리면, 보존기간(P8) 밖으로
    개인정보가 복사된다. 포맷된 message 만 남긴다.
    """
    stream = apply(settings(log_format="json"))
    logging.getLogger("teamflow.x").info("사용자 %s", "김민수")

    record = json.loads(stream.getvalue().splitlines()[0])
    assert "args" not in record
    assert set(record) == {"ts", "message", "levelname", "name", "module", "funcName", "lineno"}


def test_unknown_format_falls_back_to_text_instead_of_crashing():
    stream = apply(settings(log_format="yaml-please"))
    logging.getLogger("teamflow.x").info("살아 있어야 한다")
    assert "살아 있어야 한다" in stream.getvalue()


def test_json_formatter_is_reachable_by_its_dotted_path():
    """dictConfig 는 문자열 경로로 포매터를 찾는다. 이름을 바꾸면 여기서 깨진다."""
    path = build_config(settings(log_format="json"))["formatters"]["json"]["()"]
    module_name, _, attr = path.rpartition(".")
    module = __import__(module_name, fromlist=[attr])
    assert getattr(module, attr) is JsonFormatter


# ══════════════════════════════════════════════════════════════
# 설정이 다른 것을 부수지 않는가
# ══════════════════════════════════════════════════════════════


def test_existing_loggers_are_not_disabled():
    """⭐ disable_existing_loggers 가 True 면 설정을 켠 순간 로그가 사라진다.

    `teamflow.*` 모듈들은 import 시점에 `getLogger(__name__)` 을 만든다.
    그 로거들은 configure_logging 보다 **먼저** 존재하므로, 이 값이 True 면
    전부 비활성화된다. "설정을 추가했더니 로그가 없어졌다" 가 된다.
    """
    early = logging.getLogger("teamflow.pipeline.meeting_pipeline")
    stream = apply(settings())

    assert early.disabled is False
    early.info("먼저 만들어진 로거도 살아 있어야 한다")
    assert "먼저 만들어진 로거" in stream.getvalue()


def test_sqlalchemy_queries_stay_quiet():
    """⭐ SQL INFO 를 켜면 회의 내용이 로그로 흘러나온다.

    쿼리 파라미터에 발화 텍스트와 사용자 이름이 들어 있다. 오디오는
    보존기간이 지나면 지우는데(P8) 로그에 복사돼 있으면 그 삭제가 무의미해진다.
    """
    stream = apply(settings(log_level="DEBUG"))
    logging.getLogger("sqlalchemy.engine.Engine").info(
        "SELECT text FROM utterances -- 김민수: 로그인 기능 맡을게요"
    )
    assert stream.getvalue() == ""


def test_uvicorn_and_celery_share_our_format():
    """형식이 갈리면 API 와 워커 로그를 같은 도구로 못 읽는다."""
    stream = apply(settings(log_format="json"))
    logging.getLogger("uvicorn.error").warning("uvicorn 쪽")
    logging.getLogger("celery.worker").warning("워커 쪽")

    lines = [ln for ln in stream.getvalue().splitlines() if ln.strip()]
    assert len(lines) == 2
    assert [json.loads(ln)["message"] for ln in lines] == ["uvicorn 쪽", "워커 쪽"]


def test_records_are_not_duplicated():
    """propagate 를 안 끄면 같은 줄이 두 번 찍힌다."""
    stream = apply(settings())
    logging.getLogger("teamflow.a.b.c").warning("한 번만")
    assert stream.getvalue().count("한 번만") == 1


def test_configure_logging_is_idempotent():
    configure_logging(settings())
    configure_logging(settings())
    handlers = logging.getLogger("teamflow").handlers
    assert len(handlers) == 1


def test_console_handler_writes_to_stdout_not_stderr():
    """stderr 로 보내면 컨테이너 로그에서 정상 동작이 전부 오류로 보인다."""
    assert build_config(settings())["handlers"]["console"]["stream"] == "ext://sys.stdout"


# ══════════════════════════════════════════════════════════════
# 배선
# ══════════════════════════════════════════════════════════════


def test_celery_takes_our_logging_instead_of_hijacking_the_root_logger():
    """⭐ setup_logging 시그널에 **연결하는 것 자체가** Celery 에게 넘기는 신호다.

    연결하지 않으면 Celery 가 루트 로거를 가로채고(worker_hijack_root_logger
    기본값 True) 우리 설정은 워커에서 무시된다. `log_format=json` 을 켜도
    워커만 텍스트로 나가는데, 그건 로그 수집기에서 워커 로그가 통째로
    파싱 실패로 떨어진다는 뜻이다.
    """
    from celery.signals import setup_logging

    import teamflow.tasks  # noqa: F401  — 시그널 연결이 import 부수효과다

    assert setup_logging.receivers, "setup_logging 시그널에 연결된 게 없습니다"


def test_api_configures_logging_when_it_starts():
    """import 가 아니라 **기동** 시점에 설정한다."""
    import inspect

    from teamflow.api.main import app, lifespan

    assert "configure_logging()" in inspect.getsource(lifespan)
    assert app.router.lifespan_context is not None


def test_log_settings_are_visible_on_health():
    """설정이 실제로 무엇인지 헬스체크에서 보여야 한다.

    "json 으로 켰는데 왜 텍스트가 나오지" 를 컨테이너에 들어가지 않고 본다.
    """
    assert {"log_level", "log_format"} <= TRUSTED_FIELDS


def test_env_example_documents_the_log_settings():
    text = (BACKEND.parent / ".env.example").read_text()
    assert "LOG_LEVEL" in text
    assert "LOG_FORMAT" in text
