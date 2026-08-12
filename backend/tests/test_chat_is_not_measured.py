"""⭐ 채팅은 기여도가 **아닙니다** (요구사항 정의서 §7 머리말).

> 채팅 내용에 대한 AI 분석, 업무 자동 생성, 프로젝트 분석 등의 기능은
> 제공하지 않는다.

그냥 안 만든 게 아니라 **만들면 안 되는** 것입니다.

## 왜 이게 테스트로 있어야 하는가

이 제품은 사람의 기여를 숫자로 말하고, 그 숫자가 성적에 쓰일 수 있습니다
(`docs/07`). `docs/05` §5 와 `test_anti_gaming.py` 는 "조작이 쉬운 양적
지표는 점수에 들어오지 않는다" 를 지키고 있습니다.

**채팅 메시지는 그중에서도 가장 조작하기 쉬운 것**입니다. 아무 때나,
아무나, 무한히 칠 수 있고, 회의 발언과 달리 트랙도 근거도 신뢰도도
붙지 않습니다. 메시지가 기여로 세어지는 순간 **도배가 기여도를 올리는
방법**이 됩니다.

## ⚠️ 이 경계는 "안 부르면 되는 것" 이라 조용히 무너집니다

`send_message` 에 `record_event(...)` 한 줄을 더하면 됩니다. 오류도 안
나고, 화면도 그대로 돌고, 다른 테스트도 전부 통과합니다. 그래서 규칙을
**코드에서** 잽니다.

⚠️ **여기서 "0건" 을 고칠 때는 위반을 하나 심어 보고 잡히는지 먼저
확인하십시오.** 이 저장소는 "검사가 다른 이유로 통과 중" 이던 적이
여러 번 있습니다.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
CHAT = BACKEND / "teamflow" / "chat"
MESSAGE_SERVICE = BACKEND / "teamflow" / "services" / "message_service.py"
CHANNEL_SERVICE = BACKEND / "teamflow" / "services" / "channel_service.py"

#: 채팅 쪽 파일 전부. 여기 있는 것은 기여도를 몰라야 합니다.
CHAT_SIDE = [*sorted(CHAT.glob("*.py")), MESSAGE_SERVICE, CHANNEL_SERVICE]

#: 닿으면 안 되는 것.
#:
#: ⚠️ 이름을 **표로** 둡니다. "contribution" 한 단어만 찾으면 주석의
#: 설명까지 걸려서, 사람이 규칙을 느슨하게 만들고 그 다음에 진짜를
#: 놓칩니다 (이 저장소가 실제로 그랬습니다).
FORBIDDEN_MODULES = (
    "teamflow.contribution",
    "teamflow.pipeline",
    "teamflow.meeting",
    "teamflow.audio",
)

FORBIDDEN_MODELS = (
    "ContributionEventRow",
    "ContributionSnapshot",
    "MeetingEvent",
)


def _imports_of(path: Path) -> list[str]:
    """이 파일이 **실제로 import 하는** 모듈 이름들.

    ⚠️ 글자로 찾지 않습니다. 주석에 `teamflow.contribution` 이라고 적어
    둔 것이 위반으로 잡히면, 이 파일들은 전부 자기 설명에 걸립니다 —
    여기 주석이 바로 그렇게 생겼습니다.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            names.append(node.module)
            names.extend(f"{node.module}.{alias.name}" for alias in node.names)
    return names


def test_the_files_this_guard_watches_actually_exist():
    """⚠️ 파일이 없으면 아래 검사는 **전부 조용히 통과**합니다.

    이 저장소가 반복해서 당한 그것입니다 — 찾는 자리가 낡아서 "0건" 이
    나오는 것. 화면을 옮겼거나 파일 이름을 바꿨다면 여기가 먼저 터집니다.
    """
    assert len(CHAT_SIDE) >= 4, [str(p) for p in CHAT_SIDE]
    for path in CHAT_SIDE:
        assert path.is_file(), path


def test_the_chat_side_does_not_import_the_contribution_side():
    """⭐ 채팅 코드가 기여도 코드를 **부르지 않는다.**"""
    offenders: list[str] = []
    for path in CHAT_SIDE:
        for name in _imports_of(path):
            if any(name.startswith(bad) for bad in FORBIDDEN_MODULES):
                offenders.append(f"{path.name} → {name}")
    assert offenders == [], (
        "채팅이 기여도·회의 분석을 부르고 있습니다. 정의서 §7 이 금지합니다 — "
        "메시지가 기여로 세어지면 도배가 기여도를 올리는 방법이 됩니다."
    )


def test_the_chat_side_does_not_write_contribution_rows():
    """⭐ import 를 피해 `m.ContributionEventRow(...)` 로 쓰는 길도 막는다.

    ⚠️ `models` 는 채팅도 정당하게 씁니다(`m.Message`). 그래서 모듈이
    아니라 **어떤 표를 만드는가**를 봅니다.
    """
    offenders: list[str] = []
    for path in CHAT_SIDE:
        code = re.sub(r"#.*", "", path.read_text(encoding="utf-8"))
        code = re.sub(r'"""[\s\S]*?"""', "", code)
        for model in FORBIDDEN_MODELS:
            if re.search(rf"\bm\.{model}\(", code) or re.search(
                rf"\b{model}\(", code
            ):
                offenders.append(f"{path.name} → {model}")
    assert offenders == []


def test_the_message_table_has_no_contribution_column():
    """⭐ 표 자체가 기여도를 가리키지 않는다.

    컬럼 하나만 있으면 나중에 누군가 "이미 있으니 채우자" 가 됩니다.
    """
    from teamflow.db import models as m

    for table in (m.Message, m.MessageReaction, m.MessageMention, m.Channel):
        names = set(table.__table__.columns.keys())
        assert not {"contribution_event_id", "score", "weight", "points"} & names, (
            f"{table.__tablename__} 에 기여도 냄새가 나는 칸이 있습니다: {names}"
        )


def test_the_scoring_side_does_not_read_messages():
    """⭐ 반대 방향도 막는다 — 기여도 코드가 `messages` 를 읽지 않는다.

    한쪽만 보면 "채팅은 기여도를 모르는데 기여도가 채팅을 안다" 가 되고,
    그건 같은 결과입니다.
    """
    scoring_side = [
        *sorted((BACKEND / "teamflow" / "contribution").glob("*.py")),
        *sorted((BACKEND / "teamflow" / "pipeline").glob("*.py")),
    ]
    assert len(scoring_side) >= 5, [str(p) for p in scoring_side]

    offenders: list[str] = []
    for path in scoring_side:
        code = re.sub(r"#.*", "", path.read_text(encoding="utf-8"))
        code = re.sub(r'"""[\s\S]*?"""', "", code)
        for model in ("Message", "MessageReaction", "MessageMention"):
            # `\b` 로는 `MeetingMessage` 같은 이름을 못 가릅니다 — 앞이
            # 글자가 아닌 것까지 봅니다.
            if re.search(rf"(?<![A-Za-z_])m\.{model}(?![A-Za-z_])", code):
                offenders.append(f"{path.name} → {model}")
    assert offenders == []


def test_the_api_does_not_turn_a_message_into_an_event():
    """⭐ 배선하는 자리(`api/main.py`)에서도 안 잇는다.

    ⚠️ 두 표를 아는 유일한 파일이라 여기가 가장 이어 붙이기 쉽습니다.
    """
    main = (BACKEND / "teamflow" / "api" / "main.py").read_text(encoding="utf-8")
    code = re.sub(r"#.*", "", main)
    code = re.sub(r'"""[\s\S]*?"""', "", code)

    # 채팅 엔드포인트들의 몸통만 떼어 봅니다 — 파일 전체를 보면 회의
    # 쪽의 정당한 기여도 배선이 걸립니다.
    tree = ast.parse(main)
    chat_functions = {
        "send_message",
        "edit_message",
        "delete_message",
        "set_reaction",
        "search_messages",
        "channel_stream",
    }
    found: list[str] = []
    seen: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            continue
        if node.name not in chat_functions:
            continue
        seen.add(node.name)
        body = ast.unparse(node)
        for model in FORBIDDEN_MODELS:
            if model in body:
                found.append(f"{node.name} → {model}")
        for bad in ("contribution", "record_event", "score"):
            if re.search(rf"(?<![A-Za-z_]){bad}(?![A-Za-z_])", body):
                found.append(f"{node.name} → {bad}")

    assert seen == chat_functions, f"못 찾은 채팅 엔드포인트: {chat_functions - seen}"
    assert found == []
