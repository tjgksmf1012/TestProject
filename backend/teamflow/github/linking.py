"""PR ↔ 칸반 업무 잇기 — 무엇을 참조로 볼 것인가.

## 왜 이 모듈이 새로 생겼는가

`webhook.extract_task_refs` 가 이 일을 하도록 만들어져 있었는데 **호출자가
0곳**이었고, **테스트도 0개**였습니다. 그래서 아무도 이 사실을 몰랐습니다 —
그 함수는 세 가지를 한꺼번에 틀리고 있었습니다.

    extract_task_refs("2026-08-07 회의 정리")  → {2026}
    extract_task_refs("1000-line refactor")   → {1000}
    extract_task_refs("Closes #12")           → {12}    ← GitHub 이슈 번호
    extract_task_refs("TASK-12")              → {12}    ← 우리 업무 번호

앞의 둘은 **날짜와 줄 수가 업무 번호가 된** 것이고, 뒤의 둘은 **서로 다른
번호 체계가 같은 집합에 섞인** 것입니다. 이 상태로 배선했으면 회의록 PR
하나가 2026번 업무에 붙고, `Closes #12`(GitHub 이슈 12번)가 우리 12번
업무에 붙었을 겁니다.

## 무엇을 참조로 보는가

| 쓴 것 | 뜻 | 확실한가 |
|---|---|---|
| `TASK-12` `TF-12` | **우리 업무 12번** | ✅ 확정. GitHub 에서 다른 뜻이 없다 |
| 브랜치 `feat/12-login` | 아마 업무 12번 | 🟡 후보. 이슈 번호를 쓰는 팀도 많다 |
| `#12` | **GitHub 이슈 12번** | 🟠 후보. 이슈를 안 쓰는 팀은 업무 번호로 쓴다 |

⚠️ **`#12` 를 확정으로 보면 안 됩니다.** GitHub 은 `#12` 를 그 저장소의
이슈 링크로 렌더링합니다. 그러니 그렇게 쓴 사람은 대개 이슈를 가리킨
것이고, 우리 업무 12번과는 아무 상관이 없습니다.

그렇다고 버리지도 않습니다 — GitHub 이슈를 안 쓰는 팀은 `#12` 를 자연스럽게
업무 번호로 씁니다. 그래서 **후보로 남기고 사람이 확인**하게 합니다.
`task_github_links` 의 `relevance` 와 `confirmed_by` 컬럼이 처음부터 이걸
염두에 두고 만들어져 있었습니다.

## 숫자 하나만으로 판단하지 않는다

`_BRANCH_PATTERN` 은 **브랜치 이름에만** 적용합니다. 예전처럼 본문에도
적용하면 `2026-08-07` 의 `2026` 과 `1000-line` 의 `1000` 이 업무 번호가
됩니다. 자유 텍스트에서 "하이픈 앞의 숫자" 는 업무 번호라는 근거가
되기에 너무 약합니다.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# `TASK-12`, `TF_12`, `task12`. 대소문자 무관.
#
# 이 표식만 확정입니다. GitHub·Jira·그 무엇도 `TASK-` 를 이 뜻으로 쓰지
# 않으므로, 이걸 적었다면 우리 업무를 가리킨 것이 거의 확실합니다.
_EXPLICIT = re.compile(r"\b(?:TASK|TF)[-_]?(\d+)\b", re.IGNORECASE)

# `feat/12-login`, `12-login`, `fix/12_typo`.
# ⚠️ 브랜치 이름에**만** 씁니다.
_BRANCH = re.compile(r"(?:^|/)(\d+)[-_]")

# `#12`. GitHub 에서는 이슈 번호입니다.
_ISSUE = re.compile(r"#(\d+)\b")

#: 확정 — `TASK-12`
SOURCE_EXPLICIT = "explicit"
#: 후보 — 브랜치 이름의 숫자
SOURCE_BRANCH = "branch"
#: 후보 — `#12`. GitHub 이슈 번호일 가능성이 더 높다
SOURCE_ISSUE_REF = "issue_ref"

#: 이 값 미만이면 화면이 "확인 필요" 로 보여줍니다.
CONFIRMED_THRESHOLD = 1.0

_RELEVANCE: dict[str, float] = {
    SOURCE_EXPLICIT: 1.0,
    SOURCE_BRANCH: 0.6,
    SOURCE_ISSUE_REF: 0.3,
}

# 같은 업무를 여러 곳에서 가리키면 **가장 확실한 것**만 남깁니다.
_PRIORITY = [SOURCE_EXPLICIT, SOURCE_BRANCH, SOURCE_ISSUE_REF]


@dataclass(frozen=True, slots=True)
class TaskRef:
    """PR 이 업무 하나를 가리킨다는 주장과 그 근거."""

    task_id: int
    source: str
    relevance: float
    #: 어디에 적혀 있었는가. 화면이 "왜 이게 붙었는지" 를 말할 때 씁니다.
    where: str

    @property
    def is_confirmed(self) -> bool:
        return self.relevance >= CONFIRMED_THRESHOLD


def task_marker(task_id: int) -> str:
    """사람이 적어야 하는 표식.

    ⚠️ **화면이 이걸 보여주지 않으면 아무도 안 적습니다.** 자동 연결은
    사람이 무언가를 적어야 성립하는데, 무엇을 적어야 하는지 알려주는
    곳이 없으면 이 기능 전체가 죽은 코드가 됩니다.
    """
    return f"TASK-{task_id}"


def find_task_refs(
    *, title: str | None = None, body: str | None = None, branch: str | None = None
) -> list[TaskRef]:
    """PR 의 제목·본문·브랜치에서 업무 참조를 찾는다.

    같은 업무를 여러 곳에서 가리키면 **가장 확실한 근거 하나**만 돌려줍니다.
    `TASK-12` 를 본문에 적고 브랜치도 `feat/12-` 면 확정 하나입니다 —
    같은 업무에 확정과 후보를 둘 다 붙이면 화면이 모순된 말을 합니다.

    결과는 task_id 오름차순입니다. 순서가 흔들리면 같은 PR 을 두 번
    처리했을 때 결과를 비교할 수 없습니다.
    """
    found: dict[int, TaskRef] = {}

    def offer(task_id: int, source: str, where: str) -> None:
        # 0번 업무는 없습니다. `TASK-0` 이나 `#0` 은 사람의 오타입니다.
        if task_id <= 0:
            return
        current = found.get(task_id)
        if current is not None and _PRIORITY.index(current.source) <= _PRIORITY.index(
            source
        ):
            return
        found[task_id] = TaskRef(
            task_id=task_id,
            source=source,
            relevance=_RELEVANCE[source],
            where=where,
        )

    for text, where in ((title, "제목"), (body, "본문")):
        if not text:
            continue
        for match in _EXPLICIT.finditer(text):
            offer(int(match.group(1)), SOURCE_EXPLICIT, where)
        for match in _ISSUE.finditer(text):
            offer(int(match.group(1)), SOURCE_ISSUE_REF, where)

    # ⚠️ 브랜치 패턴은 여기서만. 자유 텍스트에 적용하면 날짜가 업무가 됩니다.
    if branch:
        for match in _BRANCH.finditer(branch):
            offer(int(match.group(1)), SOURCE_BRANCH, "브랜치")

    return sorted(found.values(), key=lambda ref: ref.task_id)


def describe_source(source: str) -> str:
    """왜 이 PR 이 이 업무에 붙었는가. 화면에 그대로 나갑니다."""
    return {
        SOURCE_EXPLICIT: "PR 에 TASK 번호가 적혀 있습니다",
        SOURCE_BRANCH: "브랜치 이름의 번호로 추정했습니다",
        SOURCE_ISSUE_REF: "PR 의 #번호로 추정했습니다 (GitHub 이슈 번호일 수 있습니다)",
    }.get(source, "근거를 알 수 없습니다")
