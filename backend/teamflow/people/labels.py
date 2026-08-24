"""목록 안에서 사람을 **가리키는 이름** (결함 345).

## 왜 서버에도 있는가 — 두 벌인 것을 알고 둡니다

같은 판단이 두 곳에 있으면 반드시 갈라집니다(이 저장소의 대표 실패 ②).
그래도 여기 한 벌을 두는 이유는 **보고서가 기록**이기 때문입니다 —
`reports.body` 는 만든 순간의 글자를 저장하고, 화면은 그것을 그대로
그립니다(「글자로 복사」도 같은 글자입니다). 화면에서 이름표를 붙이면
저장된 기록과 사람이 읽는 글이 갈라집니다.

**갈라지지 않게 하는 방법**은 `people/label_cases.json` 입니다 — 같은
입력·같은 기대값을 두 검사가 읽습니다:

    backend/tests/test_people_labels.py         (파이썬 쪽)
    frontend/src/lib/people/labels.test.ts      (화면 쪽)

한쪽 규칙만 고치면 그 파일 때문에 **양쪽 다** 빨개집니다.

규칙과 그 근거는 `frontend/src/lib/people/labels.ts` 의 머리말에 길게
적어 뒀습니다. 요약하면: 이름은 유일하지 않고, `github_login` 은
프로젝트 안에서 유일하며, 겹칠 때만 붙입니다.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class PersonRef:
    user_id: int
    name: str | None = None
    #: 프로젝트 안에서 **유일**합니다 (서버가 막습니다).
    github_login: str | None = None


def _name_of(person: PersonRef) -> str:
    name = (person.name or "").strip()
    return name or f"사용자 #{person.user_id}"


def name_repeats_in_list(person: PersonRef, all_people: list[PersonRef]) -> bool:
    """이 목록 안에서 이 사람의 이름이 겹치는가. 자기 자신은 빼고 셉니다."""
    mine = _name_of(person)
    return any(
        other.user_id != person.user_id and _name_of(other) == mine
        for other in all_people
    )


def label_in_list(person: PersonRef, all_people: list[PersonRef]) -> str:
    """목록에서 이 사람을 부를 글자.

    겹치지 않으면 이름만. 겹치면 손잡이를 붙이되 **양쪽 다** 붙입니다 —
    한쪽만 붙이면 나머지 한 줄이 「이름표가 없는 쪽」이 되어 사람이
    소거법으로 읽어야 합니다.
    """
    name = _name_of(person)
    if not name_repeats_in_list(person, all_people):
        return name

    login = (person.github_login or "").strip()
    return f"{name} · GitHub 미연결" if not login else f"{name} · @{login}"


def tells_apart_in_list(person: PersonRef, all_people: list[PersonRef]) -> bool:
    """이름표를 붙여도 두 줄이 똑같지는 않은가."""
    if not name_repeats_in_list(person, all_people):
        return True

    label = label_in_list(person, all_people)
    return not any(
        other.user_id != person.user_id and label_in_list(other, all_people) == label
        for other in all_people
    )
