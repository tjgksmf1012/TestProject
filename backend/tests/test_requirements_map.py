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
    """❌ 로 적은 것이 진짜 없는지 확인합니다.

    ⚠️ 여기 있다가 빠진 것들: `channels`·`messages`(§6·§7 을 만들면서),
    `notifications`(§19 를 만들면서). **이 검사가 그때마다 잡아 줘서**
    문서를 같이 고쳤습니다. 이 목록에서 무언가를 뺄 때는 `docs/20` 을
    반드시 같이 고치십시오.

    ⚠️ `calendar_events` 는 다릅니다 — 만들 수 있었는데 **일부러 안
    만들었습니다.** 달력은 이미 있는 행에서 읽어서 만듭니다. 그래서 이
    표가 생기는 것은 §16 이 구현된 신호가 아니라 **베끼기가 시작된**
    신호이고, 그때는 `docs/20` §5 를 다시 읽어야 합니다.
    """
    tables = set(m.Base.metadata.tables)
    for absent in ("calendar_events",):
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


def test_the_doc_no_longer_says_the_labels_are_short_of_the_spec():
    """§10 — 문서가 **낡은 불평을 계속 하고 있지 않은가.**

    ⚠️ 이 검사는 방향이 뒤집힌 것입니다. 예전에는 "라벨 8개 ↔ 요구 10개"
    라는 문구가 문서에 **있는지**를 지켰습니다(어긋남을 잊지 않으려고).
    이제 갈랐으니, 그 문구가 **남아 있으면** 안 됩니다 — 남아 있으면
    문서가 이미 고친 것을 아직 못 했다고 말합니다.

    ⚠️ 갈랐다고 `REVIEW-005` 가 저절로 되는 건 아닙니다. 셀 수 있게 됐을
    뿐이고 **세는 화면**은 따로 만들어야 합니다.
    """
    from teamflow.meeting import utterance_types

    covered = {"agreement", "objection", "refinement", "request", "confirmation"}
    missing = covered - set(utterance_types.LABELS)
    assert missing == set(), f"§10 이 요구하는 라벨이 아직 없습니다: {sorted(missing)}"

    assert "라벨 8개 ↔ 요구 10개" not in _doc(), (
        "`docs/20` 이 아직 '라벨 8개 ↔ 요구 10개' 라고 말합니다 — 갈랐으니 "
        "§10 표와 §1 요약을 고치십시오"
    )


def test_the_task_statuses_are_the_four_the_spec_asks_for():
    """§15 TASK-004 — 요구는 넷입니다.

    ⚠️ **이 검사도 방향이 뒤집혔습니다.** 예전에는 "지금 셋" 을 지켰고
    `review` 가 없는 것을 고정했습니다. 넷이 됐으니 이제 넷을 지킵니다.

    ⚠️ **순서가 곧 칸반 열 순서입니다.** `review` 가 `done` 뒤로 가면
    화면에서 검토가 완료 다음에 오는 이상한 판이 됩니다.
    """
    from teamflow.services import task_service

    assert task_service.STATUSES == ("todo", "in_progress", "review", "done"), (
        f"업무 상태가 {task_service.STATUSES} 가 됐습니다 — "
        "`docs/20` TASK-004 줄과 칸반 열 순서를 같이 보십시오"
    )
    # ⚠️ 검토 중인 일을 완료로 세면 진행률이 실제보다 높게 나옵니다.
    assert {str(s) for s in vocab.TASK_FINISHED} == {"done"}


def test_every_meeting_event_the_vocabulary_names_is_actually_produced():
    """§12 — 어휘에 있는 값은 **전부 만들어지는가.**

    ⚠️ 이 검사는 방향이 뒤집힌 것입니다. 예전에는 "다섯 중 하나만" 을
    지켰습니다 — 넷이 어휘에만 있고 만드는 코드가 0곳이라는 사실을
    잊지 않으려고요(결함 122). 이제 넷 다 붙었으니 **비어 있으면**
    안 됩니다.

    숫자를 손으로 안 적고 `vocab` 을 읽습니다.
    """
    from teamflow.services import inefficiency_service

    assert not vocab.EVENT_NOT_PRODUCED_YET, (
        f"아직 안 만들어지는 이벤트가 있습니다: "
        f"{sorted(str(e) for e in vocab.EVENT_NOT_PRODUCED_YET)}"
    )

    # ⚠️ 어휘와 **탐지기 목록**이 갈리면, 어휘에는 있는데 아무도 안
    #    만드는 값이 다시 생깁니다. 그게 결함 122 였습니다.
    produced = {str(e) for e in vocab.EVENT_PRODUCED}
    wired = set(inefficiency_service.DETECTED) | {"unanswered_question"}
    assert produced == wired, (
        f"어휘({sorted(produced)})와 실제로 만드는 것({sorted(wired)})이 다릅니다"
    )

    assert "다섯 중 하나만" not in _doc(), (
        "`docs/20` 이 아직 '다섯 중 하나만' 이라고 말합니다 — §12 표와 "
        "§1 요약을 고치십시오"
    )


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
    from teamflow.meeting import speaking as meeting_speaking

    # ⚠️ **가리키는 자리를 옮겼습니다** (결함 172). 예전에는
    #    `multitrack.speaking_ratios` 를 가리켰는데 그건 **부르는 곳이
    #    0곳**이었습니다 — 요구가 충족됐다고 말하면서 아무도 안 쓰는
    #    함수를 가리키고 있었던 것입니다. 화면이 실제로 부르는 것은
    #    `meeting/speaking.py` 입니다.
    assert hasattr(meeting_speaking, "shares"), (
        "`speaking.shares` 가 없어졌습니다 — `docs/20` §3·§4 를 고치십시오"
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


def test_the_audit_log_is_now_read_somewhere():
    """§21 — 예전에는 "쓰기만 하고 읽는 곳이 0곳" 이었습니다.

    ⚠️ **이 검사는 방향이 뒤집혔습니다.** 예전에는 "읽는 곳이 없다" 를
    지켰고, 주석에 "읽는 곳이 생기면 터집니다. 그게 맞습니다 — 그때
    `docs/20` 의 🟡 를 ✅ 로 바꾸라는 뜻입니다" 라고 적어 뒀습니다.
    실제로 그렇게 됐고, 그래서 지금은 **읽는 곳이 있는지**를 지킵니다.

    다시 0곳이 되면 열두 곳에서 쌓기만 하고 볼 방법이 없던 그 상태로
    돌아간 것입니다.

    ⚠️ **쓰기와 읽기를 갈라서 재야 합니다.** 처음에 `"AuditLog" in main.py`
    로 쟀다가 틀렸습니다 — 그 파일은 감사 로그를 **쓰는** 곳이라 문자열이
    당연히 있고, 검사는 "읽는 곳이 생겼다" 고 잘못 말했습니다. 이 저장소가
    여덟 번째로 당한 "자를 잘못 든" 경우입니다.
    """
    reads: list[str] = []
    writes = 0
    for path in (REPO_ROOT / "backend" / "teamflow").rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        if re.search(r"select\(\s*(?:m\.)?AuditLog", text):
            reads.append(str(path.relative_to(REPO_ROOT)))
        writes += len(re.findall(r"\bm\.AuditLog\(", text))

    assert reads, (
        "감사 로그를 읽는 곳이 0곳이 됐습니다 — 열두 곳에서 쌓기만 하고 "
        "볼 방법이 없던 상태로 돌아갔습니다 (`docs/20` ACTIVITY-001)"
    )
    # 쓰는 곳이 0이 되면 그건 반대쪽 결함입니다 — 기록이 끊긴 것입니다.
    assert writes > 0, "감사 로그를 쓰는 곳이 0곳이 됐습니다 — 기록이 끊겼습니다"
    # 문서가 적어 둔 개수도 같이 봅니다. ⚠️ 처음에 "다섯 곳" 이라고 적었는데
    # 실제로는 열한 곳이었습니다 — 세지 않고 눈대중으로 적은 것입니다.
    assert writes == 13, (
        f"감사 로그를 쓰는 곳이 {writes}곳입니다 — `docs/20` ACTIVITY-001 의 "
        "개수를 고치십시오"
    )
    assert "쓰기는 열세 곳" in _doc(), (
        "문서에서 쓰기 개수를 적은 자리를 못 찾았습니다 — 문구가 바뀌었으면 "
        "이 검사도 같이 고치십시오"
    )


def test_the_action_labels_cover_every_action_the_code_writes():
    """⭐ 화면이 **원문 그대로** 보여 주는 행동이 없어야 합니다.

    ⚠️ 새 감사 행동을 추가하고 표에 안 넣으면, 화면에 `score_adjusted`
    같은 영어 식별자가 그대로 뜹니다. 이 저장소는 보고서에서 같은 부류를
    이미 한 번 냈습니다 (`상태: processing`).
    """
    from teamflow.services import activity_service

    written: set[str] = set()
    for path in (REPO_ROOT / "backend" / "teamflow").rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        written |= set(re.findall(r'action="([a-z_]+)"', text))

    assert written, "감사 행동을 하나도 못 찾았습니다 — 정규식이 낡았습니다"
    missing = sorted(written - set(activity_service.ACTION_LABEL))
    assert not missing, (
        f"사람 말이 없는 감사 행동입니다: {missing} — "
        "`activity_service.ACTION_LABEL` 에 넣으십시오"
    )


def test_the_doc_does_not_call_a_finished_requirement_a_next_step():
    """⭐ `docs/20` 의 「다음에 할 일」이 **§5 가 ✅ 로 적은 요구**를 다시
    남은 일로 부르지 않는가.

    2026-08-13 전수 조사에서 나온 어긋남 71건 중 **13건이 이 한 파일 안의
    자기모순**이었습니다 — §5 표는 채팅·활동 기록·`TASK-004`·발언 통계를
    전부 ✅ 로 적어 두고, 같은 파일의 §1 요약과 §6 「다음에 할 일」은 그
    넷을 아직 안 한 것으로 적고 있었습니다. 그리고 `docs/08` 이 그 틀린
    문장을 **복사해 갔습니다.**

    이 저장소의 대표 실패 ② (두 벌이 있으면 한쪽만 고쳐진다)가 표 하나와
    그 아래 문단 사이에서 일어난 것입니다. **§5 가 기준이고 나머지가
    따릅니다.**

    ⚠️ 인용 블록(4칸 들여쓴 줄)은 봅니다 — 옛 진단을 **인용으로 보존**한
    자리는 지금을 주장하는 것이 아니기 때문입니다.
    """
    import re

    doc = (REPO_ROOT / "docs" / "20-요구사항-대조.md").read_text(encoding="utf-8")

    # §5 표에서 ✅ 인 요구 ID 를 모읍니다.
    done = set()
    for line in doc.splitlines():
        m = re.match(r"\|\s*([A-Z][A-Z-]+-\d+)[^|]*\|\s*✅", line)
        if m:
            done.add(m.group(1))
    assert done, "§5 표에서 ✅ 인 요구를 하나도 못 찾았습니다 — 파서가 낡았습니다"

    # 「다음에 할 일」절만 봅니다.
    tail = doc.partition("## 6. 다음에 할 만한 것")[2]
    assert tail, "§6 절을 못 찾았습니다"

    # ⚠️ **낱말이 아니라 절 구조로 거릅니다.** 처음엔 "끝났습니다" 가 든
    #    줄만 건너뛰게 했는데, 끝난 것을 **여러 줄에 걸쳐** 나열하면 둘째
    #    줄부터 다시 잡힙니다 — 실제로 그렇게 잘못 잡았습니다. `###` 소절
    #    제목에 ✅ 가 있으면 그 소절 전체가 "끝난 것" 입니다.
    offenders = []
    in_done_section = False
    for line_no, line in enumerate(tail.splitlines(), 1):
        if line.startswith("###"):
            in_done_section = "✅" in line or "끝났" in line
            continue
        if in_done_section or line.startswith("    "):
            continue  # 끝난 것을 적는 소절 · 인용으로 보존한 옛 문장
        for rid in re.findall(r"`([A-Z][A-Z-]+-\d+)", line):
            if rid in done:
                offenders.append(f"§6 +{line_no}: {rid} — §5 는 ✅ 인데 남은 일로 적혀 있습니다")

    assert not offenders, "\n  " + "\n  ".join(offenders)


def test_the_summary_table_agrees_with_the_audit_log_count():
    """⭐ `docs/20` §1 요약표의 **감사 로그 쓰기 개수**가 코드와 맞는가.

    위 `test_the_audit_log_is_now_read_somewhere` 가 이미 코드를 세어
    `writes == 13` 을 단언하는데, **문서는 12곳이라고 적고 있었습니다.**
    코드만 재고 문서를 안 재면 이런 어긋남이 그대로 남습니다.
    """
    import re

    doc = (REPO_ROOT / "docs" / "20-요구사항-대조.md").read_text(encoding="utf-8")
    m = re.search(r"쓰기 (\d+)곳", doc)
    assert m, "§1 요약표에서 '쓰기 N곳' 을 못 찾았습니다"

    writes = 0
    for path in (REPO_ROOT / "backend" / "teamflow").rglob("*.py"):
        writes += len(re.findall(r"\bm\.AuditLog\(", path.read_text(encoding="utf-8")))

    assert int(m.group(1)) == writes, (
        f"`docs/20` 은 쓰기 {m.group(1)}곳이라는데 코드에는 {writes}곳입니다"
    )


def test_the_finding_screen_tables_agree_with_the_detectors():
    """⭐ `review/findings.ts` 의 세 표가 **서로도, 백엔드 어휘와도** 맞는가.

    그 파일에는 종류마다 세 가지가 있습니다 — 이름(`TITLE`) · 무슨 뜻인지
    (`WHAT`) · 늘어놓을 순서(`KIND_ORDER`). 셋이 손으로 적혀 있고 **아무도
    묶어 두지 않아서** 하나만 늘어나 있었습니다: `TITLE` 에 다섯 개,
    나머지 둘에 네 개.

    다섯째(`unanswered_question`)는 애초에 이 화면으로 오지 않습니다 —
    LLM 이 만든 회의록의 일부라 서버가 `unresolved_issues` 로 따로
    내려보냅니다. 즉 **이름만 남아 다섯 종류를 그리는 것처럼 보였고**,
    실제로는 설명도 순서도 없는 반쪽이었습니다.

    ⚠️ 반대 방향이 더 위험합니다. 탐지기를 하나 더 만들어 `DETECTED` 에
    넣으면 화면은 **이름도 설명도 없이** 그 구간을 그립니다. 오류는 안
    납니다 — 이 저장소가 제일 자주 당하는 부류입니다.
    """
    import re

    from teamflow.services import inefficiency_service

    src = (
        REPO_ROOT / "frontend" / "src" / "lib" / "review" / "findings.ts"
    ).read_text(encoding="utf-8")

    def keys_of(name: str) -> set[str]:
        block = re.search(rf"const {name}: Record<string, string> = \{{(.*?)\}};", src, re.S)
        assert block, f"{name} 표를 못 찾았습니다 — 검사가 낡았습니다"
        return set(re.findall(r"^\s*([a-z_]+):", block.group(1), re.M))

    order = re.search(r"KIND_ORDER: readonly string\[\] = \[(.*?)\];", src, re.S)
    assert order, "KIND_ORDER 를 못 찾았습니다 — 검사가 낡았습니다"

    titles = keys_of("TITLE")
    whats = keys_of("WHAT")
    ordered = set(re.findall(r"'([a-z_]+)'", order.group(1)))
    detected = set(inefficiency_service.DETECTED)

    assert titles == detected, (
        f"`TITLE` 과 백엔드 `DETECTED` 가 다릅니다. "
        f"이름 없는 탐지기: {sorted(detected - titles)} · "
        f"안 오는데 이름만 있는 것: {sorted(titles - detected)}"
    )
    assert whats == detected, (
        f"`WHAT` 과 `DETECTED` 가 다릅니다: {sorted(detected ^ whats)}"
    )
    assert ordered == detected, (
        f"`KIND_ORDER` 와 `DETECTED` 가 다릅니다: {sorted(detected ^ ordered)}"
    )
