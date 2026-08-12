"""`docs/20` 요구사항 대조표가 **사실과 어긋나지 않는가.**

## 왜 이 파일이 필요한가

이 저장소는 문서가 사실과 다른 곳을 열세 군데 발견한 적이 있습니다. 그중
여럿은 "처음 적을 때는 맞았는데 코드가 움직인 뒤로 아무도 안 고친" 것이고,
**틀렸다는 사실 자체를 아무도 몰랐습니다.**

대조표는 그 위험이 특히 큽니다 — 상태 칸이 스무 개 넘게 있고, 하나가
❌ 에서 ✅ 로 바뀌어도 문서는 조용합니다. 그래서 여기서 다시 셉니다.

⚠️ **모든 칸을 검사하지는 않습니다.** "화면이 예쁜가" 같은 것은 글로만
판단할 수 있고, 그런 것까지 자동으로 재는 척하면 이 파일이 거짓말을 하게
됩니다. 여기서 재는 것은 **기계로 확인 가능한 사실**뿐입니다 —
표가 있는가 · 어휘가 몇 개인가 · 부르는 코드가 있는가.
"""

from __future__ import annotations

import re
from pathlib import Path

from teamflow.db import models as m
from teamflow.db import vocab

REPO_ROOT = Path(__file__).resolve().parents[2]
MAP_DOC = REPO_ROOT / "docs" / "20-요구사항-대조.md"


def _doc() -> str:
    assert MAP_DOC.exists(), f"{MAP_DOC.name} 이 없습니다"
    return MAP_DOC.read_text(encoding="utf-8")


# ══════════════════════════════════════════════════════════════
# 1. "표도 없다" 고 적은 것이 정말 없는가
# ══════════════════════════════════════════════════════════════
#
# ⚠️ 반대 방향이 위험합니다 — 누가 채팅을 만들었는데 문서는 계속 "없음"
#    이라고 말하면, 다음 사람이 **또 만듭니다.**


def test_the_tables_we_call_missing_are_actually_missing():
    """§16·§19 를 ❌ 로 적었습니다. 진짜 없는지 확인합니다.

    ⚠️ `channels`·`messages` 가 여기 있었습니다. 만들었으므로 뺐고,
    문서의 ❌ 도 같이 고쳤습니다 — **이 검사가 잡아 줘서** 고친 것입니다.
    이 목록에서 무언가를 뺄 때는 `docs/20` 을 반드시 같이 고치십시오.
    """
    tables = set(m.Base.metadata.tables)
    for absent in ("calendar_events", "notifications"):
        assert absent not in tables, (
            f"`{absent}` 표가 생겼습니다 — `docs/20` 에서 ❌ 를 고치십시오. "
            "문서가 계속 '없음' 이라고 말하면 다음 사람이 또 만듭니다"
        )


def test_the_tables_we_call_present_are_actually_present():
    """✅ 로 적은 것들의 뿌리가 실제로 있는가."""
    tables = set(m.Base.metadata.tables)
    for present in (
        "users",
        "projects",
        "meetings",
        "meeting_tracks",
        "tasks",
        "meeting_task_candidates",
        "decisions",
        "reports",
        "audit_logs",
    ):
        assert present in tables, f"`{present}` 표가 사라졌습니다 — `docs/20` 을 고치십시오"


# ══════════════════════════════════════════════════════════════
# 2. 개수를 손으로 적은 곳
# ══════════════════════════════════════════════════════════════


def test_the_speech_label_count_the_doc_claims_matches_the_code():
    """§10 — "라벨 8개 ↔ 요구 10개" 라고 적었습니다.

    ⚠️ 라벨을 갈라 놓고 문서를 안 고치면, `REVIEW-005`(동의 수·반대 의견
    수)가 **여전히 못 만든다고** 적혀 있게 됩니다.
    """
    from teamflow.meeting import utterance_types

    actual = len(utterance_types.LABELS)
    assert actual == 8, (
        f"발언 유형 라벨이 {actual}개가 됐습니다 — `docs/20` §10 표와 §1 요약을 "
        "고치고, `REVIEW-005` 상태도 다시 보십시오 (동의/반대를 셀 수 있게 "
        "됐을 수 있습니다)"
    )
    assert "라벨 8개 ↔ 요구 10개" in _doc(), (
        "문서에서 라벨 개수를 적은 자리를 못 찾았습니다 — 문구가 바뀌었으면 "
        "이 검사도 같이 고치십시오"
    )


def test_the_task_status_count_matches():
    """§15 TASK-004 — "지금 셋, 요구는 넷" 이라고 적었습니다."""
    from teamflow.services import task_service

    assert len(task_service.STATUSES) == 3, (
        f"업무 상태가 {len(task_service.STATUSES)}개가 됐습니다 — "
        "`docs/20` TASK-004 줄을 고치십시오"
    )
    assert "review" not in task_service.STATUSES


def test_the_meeting_event_gap_the_doc_describes_is_the_real_gap():
    """§12 — "다섯 중 하나만" 이라고 적었습니다.

    숫자를 손으로 안 적고 `vocab` 을 읽습니다 — 탐지기가 하나 붙으면
    이 검사가 문서를 고치라고 알려 줍니다.
    """
    produced = {str(e) for e in vocab.EVENT_PRODUCED}
    assert produced == {"unanswered_question"}, (
        f"만들어지는 이벤트가 {sorted(produced)} 로 바뀌었습니다 — "
        "`docs/20` §12 표와 §1 요약('다섯 중 하나만')을 고치십시오"
    )
    assert len(vocab.EVENT_NOT_PRODUCED_YET) == 4


# ══════════════════════════════════════════════════════════════
# 3. 문서가 가리키는 코드가 실제로 있는가
# ══════════════════════════════════════════════════════════════


def test_every_code_path_the_doc_points_at_exists():
    """⚠️ 근거로 적은 경로가 없어지면 그 줄은 **거짓말**이 됩니다.

    `docs/16` 이 저장소에 없는 `.mjs` 도구 셋을 근거로 삼고 있던 것과 같은
    부류입니다 — 읽는 사람이 찾다가 포기합니다.
    """
    text = _doc()
    # `backend/...` · `frontend/...` · `public/...` 꼴만 봅니다. `docs/NN` 은
    # 다른 가드가 이미 봅니다.
    paths = set(re.findall(r"`((?:backend|frontend|docs)/[\w/.-]+\.(?:py|ts|tsx|md))`", text))
    assert paths, "근거 경로를 하나도 못 찾았습니다 — 정규식이 낡았습니다"

    missing = sorted(p for p in paths if not (REPO_ROOT / p).exists())
    assert not missing, f"`docs/20` 이 없는 파일을 가리킵니다: {missing}"


def test_the_functions_the_doc_names_exist():
    """이름으로 가리킨 함수들이 실제로 있는가."""
    from teamflow.audio import multitrack

    assert hasattr(multitrack, "speaking_ratios"), (
        "`speaking_ratios` 가 없어졌습니다 — `docs/20` §3·§4 를 고치십시오"
    )
    assert hasattr(multitrack, "track_stats")
    # ⚠️ 결함 121 이 되살아나지 않게. `0.0` 을 돌려주던 property 입니다.
    assert not hasattr(multitrack.TrackStats, "speaking_ratio"), (
        "`speaking_ratio` property 가 돌아왔습니다 — 분모가 없는 자리라 "
        "언제나 0.0 이었고, 그건 '한마디도 안 했다' 로 읽힙니다 (결함 121)"
    )


# ══════════════════════════════════════════════════════════════
# 4. ⭐ 대표 실패 ① — 쓰기만 하고 읽는 곳이 없는 표
# ══════════════════════════════════════════════════════════════


def test_the_audit_log_is_still_write_only_as_the_doc_says():
    """§21 — "쓰기만 하고 읽는 곳이 0곳" 이라고 적었습니다.

    ⚠️ **쓰기와 읽기를 갈라서 재야 합니다.** 처음에 `"AuditLog" in main.py`
    로 쟀다가 틀렸습니다 — 그 파일은 감사 로그를 **쓰는** 곳이라 문자열이
    당연히 있고, 검사는 "읽는 곳이 생겼다" 고 잘못 말했습니다. 이 저장소가
    여덟 번째로 당한 "자를 잘못 든" 경우입니다.

    ⚠️ 이 검사는 **읽는 곳이 생기면 터집니다.** 그게 맞습니다 — 그때
    `docs/20` 의 🟡 를 ✅ 로 바꾸라는 뜻입니다. 문서가 "아직 안 읽는다" 로
    남아 있으면 다음 사람이 화면을 또 만듭니다.
    """
    reads: list[str] = []
    writes = 0
    for path in (REPO_ROOT / "backend" / "teamflow").rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        if re.search(r"select\(\s*(?:m\.)?AuditLog", text):
            reads.append(str(path.relative_to(REPO_ROOT)))
        writes += len(re.findall(r"\bm\.AuditLog\(", text))

    assert not reads, (
        f"감사 로그를 읽는 곳이 생겼습니다: {sorted(reads)} — "
        "`docs/20` ACTIVITY-001 을 ✅ 로 고치십시오"
    )
    # 쓰는 곳이 0이 되면 그건 반대쪽 결함입니다 — 기록이 끊긴 것입니다.
    assert writes > 0, "감사 로그를 쓰는 곳이 0곳이 됐습니다 — 기록이 끊겼습니다"
    # 문서가 적어 둔 개수도 같이 봅니다. ⚠️ 처음에 "다섯 곳" 이라고 적었는데
    # 실제로는 열한 곳이었습니다 — 세지 않고 눈대중으로 적은 것입니다.
    assert writes == 11, (
        f"감사 로그를 쓰는 곳이 {writes}곳입니다 — `docs/20` ACTIVITY-001 의 "
        "개수를 고치십시오"
    )
    assert "쓰기는 열한 곳" in _doc(), (
        "문서에서 쓰기 개수를 적은 자리를 못 찾았습니다 — 문구가 바뀌었으면 "
        "이 검사도 같이 고치십시오"
    )
