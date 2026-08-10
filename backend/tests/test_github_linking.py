"""PR ↔ 업무 참조 찾기.

이 파일이 고정하는 것: **엉뚱한 숫자를 업무 번호로 읽지 않는가.**

앞선 구현(`webhook.extract_task_refs`)은 호출자도 테스트도 0이었고, 그래서
날짜와 줄 수를 업무 번호로 읽는다는 사실이 드러난 적이 없었습니다.
"""

from __future__ import annotations

import pytest

from teamflow.github.linking import (
    SOURCE_BRANCH,
    SOURCE_EXPLICIT,
    SOURCE_ISSUE_REF,
    describe_source,
    find_task_refs,
    task_marker,
)


def ids(refs) -> list[int]:
    return [ref.task_id for ref in refs]


# ══════════════════════════════════════════════════════════════
# 확정 — TASK-12
# ══════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    "text",
    ["TASK-12", "task-12", "TASK_12", "TASK12", "TF-12", "tf12", "구현 완료 (TASK-12)"],
)
def test_the_explicit_marker_is_recognized(text):
    refs = find_task_refs(body=text)
    assert ids(refs) == [12]
    assert refs[0].source == SOURCE_EXPLICIT
    assert refs[0].is_confirmed


def test_the_marker_the_screen_tells_people_to_write_is_the_one_we_read():
    """⭐ 화면이 알려주는 표식과 서버가 읽는 표식이 다르면 **아무것도 안 붙습니다.**

    사람은 시킨 대로 적었는데 연결이 안 되고, 어디에도 오류가 안 납니다.
    """
    refs = find_task_refs(body=f"{task_marker(77)} 완료")
    assert ids(refs) == [77]
    assert refs[0].is_confirmed


# ══════════════════════════════════════════════════════════════
# ⭐ 엉뚱한 숫자를 읽지 않는다
# ══════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    "text",
    [
        "2026-08-07 회의 정리",  # 날짜 → 예전엔 2026번 업무
        "1000-line refactor",  # 줄 수 → 예전엔 1000번 업무
        "ISO 8601-1 적용",
        "로그인 API 3-단계 구현",
        "v2-release 준비",
        "타임아웃을 30-60초로",
    ],
)
def test_numbers_in_ordinary_text_are_not_task_numbers(text):
    """⭐ **여기가 예전 구현이 무너지던 곳입니다.**

    "하이픈 앞의 숫자" 는 브랜치 이름에서나 업무 번호이지, 자유 텍스트에서는
    날짜이거나 줄 수이거나 버전입니다. 그걸 업무 번호로 읽으면 회의록 PR
    하나가 2026번 업무에 붙습니다.
    """
    assert find_task_refs(title=text, body=text) == []


def test_the_branch_pattern_still_works_on_branches():
    """자유 텍스트에서 뺐다고 브랜치에서까지 못 읽으면 안 됩니다."""
    refs = find_task_refs(branch="feat/12-login")
    assert ids(refs) == [12]
    assert refs[0].source == SOURCE_BRANCH
    assert not refs[0].is_confirmed


@pytest.mark.parametrize(
    ("branch", "expected"),
    [
        ("feat/12-login", [12]),
        ("12-login", [12]),
        ("fix/7_typo", [7]),
        ("main", []),
        ("feat/login", []),
        ("release/v2", []),  # 하이픈 뒤 숫자가 아니면 안 잡는다
    ],
)
def test_branch_shapes(branch, expected):
    assert ids(find_task_refs(branch=branch)) == expected


# ══════════════════════════════════════════════════════════════
# ⭐ #12 는 GitHub 이슈 번호다
# ══════════════════════════════════════════════════════════════


def test_a_hash_number_is_a_candidate_not_a_confirmed_link():
    """⭐ GitHub 은 `#12` 를 그 저장소의 **이슈** 링크로 렌더링합니다.

    그렇게 쓴 사람은 대개 이슈를 가리킨 것이고 우리 업무와 상관없습니다.
    확정으로 처리하면 `Closes #12`(이슈 12번 닫기)가 우리 12번 업무에
    붙습니다 — 예전 구현이 그랬습니다.
    """
    refs = find_task_refs(body="Closes #12")
    assert ids(refs) == [12]
    assert refs[0].source == SOURCE_ISSUE_REF
    assert not refs[0].is_confirmed


def test_the_explicit_marker_beats_the_hash_number_for_the_same_task():
    """같은 업무에 확정과 후보를 둘 다 붙이면 화면이 모순된 말을 합니다."""
    refs = find_task_refs(body="TASK-12 를 끝냈습니다. Closes #12")
    assert len(refs) == 1
    assert refs[0].source == SOURCE_EXPLICIT


def test_the_explicit_marker_beats_the_branch_for_the_same_task():
    refs = find_task_refs(body="TASK-12 완료", branch="feat/12-login")
    assert len(refs) == 1
    assert refs[0].source == SOURCE_EXPLICIT


def test_the_branch_beats_the_hash_number():
    refs = find_task_refs(body="관련 #12", branch="feat/12-login")
    assert len(refs) == 1
    assert refs[0].source == SOURCE_BRANCH


# ══════════════════════════════════════════════════════════════
# 여러 개 · 경계
# ══════════════════════════════════════════════════════════════


def test_several_tasks_in_one_pull_request():
    refs = find_task_refs(body="TASK-3 과 TASK-1 을 함께 처리", branch="feat/9-batch")
    assert ids(refs) == [1, 3, 9]


def test_the_order_is_stable():
    """순서가 흔들리면 같은 PR 을 두 번 처리했을 때 결과를 비교할 수 없습니다."""
    a = find_task_refs(body="TASK-9 TASK-2 TASK-5")
    b = find_task_refs(body="TASK-5 TASK-9 TASK-2")
    assert ids(a) == ids(b) == [2, 5, 9]


def test_zero_is_not_a_task():
    """0번 업무는 없습니다. `TASK-0` 은 사람의 오타입니다."""
    assert find_task_refs(body="TASK-0", branch="feat/0-x") == []


def test_nothing_in_nothing_out():
    assert find_task_refs() == []
    assert find_task_refs(title=None, body="", branch=None) == []


def test_the_title_counts_too():
    refs = find_task_refs(title="TASK-42 로그인 API")
    assert ids(refs) == [42]
    assert refs[0].where == "제목"


def test_where_it_was_found_is_recorded():
    """화면이 "왜 이게 붙었는지" 를 말하려면 근거가 필요합니다."""
    assert find_task_refs(body="TASK-1")[0].where == "본문"
    assert find_task_refs(branch="feat/1-x")[0].where == "브랜치"


def test_every_source_has_a_human_explanation():
    """근거 없이 연결만 보여주면 사람은 그걸 믿을지 말지 정할 수 없습니다."""
    for source in (SOURCE_EXPLICIT, SOURCE_BRANCH, SOURCE_ISSUE_REF):
        assert describe_source(source) != "근거를 알 수 없습니다"


def test_an_unknown_source_does_not_pretend_to_know():
    assert describe_source("무엇인가") == "근거를 알 수 없습니다"
