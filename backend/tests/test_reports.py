"""보고서 생성기 — **앱 밖으로 나가는 글자**에 불변식이 남아 있는가.

이 파일이 다른 테스트보다 깐깐한 이유가 있습니다. 화면이라면 CSS 가드가
막고 렌더 검사가 다시 재지만, 보고서는 복사돼서 제출물·메일·발표 자료가
됩니다. **글자가 되어 나간 뒤에는 아무 가드도 안 닿습니다.**

그래서 여기서 재는 것은 "화면이 잘 그리는가" 가 아니라 **"만들어진 내용
자체가 불변식을 어기지 않는가"** 입니다.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from teamflow.db.vocab import CARRIES_CONTRIBUTION, ReportType
from teamflow.reports import blocks, minutes, period, scope_key

#: 저장소 뿌리 — 서버 문장과 화면 문장을 **나란히 놓고** 재기 위해 (결함 311).
ROOT = Path(__file__).resolve().parents[2]


def _find(content: dict, kind: str) -> list[dict]:
    return [b for b in content["blocks"] if b["kind"] == kind]


def _people_of(content: dict) -> list[dict]:
    found = _find(content, "people")
    assert len(found) == 1, "사람 블록이 하나가 아닙니다"
    return found[0]["people"]


def _sample_people() -> list[period.Person]:
    """⚠️ **일부러 점수가 큰 사람을 먼저** 넣습니다.

    부르는 쪽이 점수 순으로 넘겨도 이름 순으로 나와야 합니다.
    """
    return [
        period.Person(
            name="홍길동",
            role="backend",
            range_low=40.0,
            range_high=52.0,
            confidence=0.9,
            confidence_label="높음",
            reasons=["트랙이 온전합니다"],
            evidence_count=31,
        ),
        period.Person(
            name="김하늘",
            role="frontend",
            range_low=20.0,
            range_high=28.0,
            confidence=0.7,
            confidence_label="보통",
            evidence_count=12,
        ),
        period.Person(
            name="박바다",
            role="design",
            measured=False,
            gaps=["녹음이 끊겨 회의 기여를 못 쟀습니다"],
        ),
    ]


def _period_input(**kw) -> period.PeriodInput:
    base = dict(
        project_name="TeamFlow",
        people=_sample_people(),
        period_start=datetime(2026, 8, 3, tzinfo=UTC),
        period_end=datetime(2026, 8, 9, tzinfo=UTC),
        meetings_total=4,
        meetings_processed=3,
        tasks_done=7,
        tasks_open=5,
        github_events=42,
    )
    base.update(kw)
    return period.PeriodInput(**base)


# ══════════════════════════════════════════════════════════════
# 1. 순위·리더보드 금지
# ══════════════════════════════════════════════════════════════


@pytest.mark.parametrize("report_type", sorted(CARRIES_CONTRIBUTION))
def test_people_come_out_in_name_order_no_matter_how_they_went_in(report_type):
    """⚠️ **부르는 쪽이 점수 순으로 넘겨도** 이름 순으로 나옵니다.

    "부르는 쪽이 정렬해서 주겠지" 로 두면 언젠가 점수 순으로 넘어오고, 그때
    생성기에는 아무 잘못이 없어 보입니다. 순위표는 그렇게 생깁니다.
    """
    content = period.build(_period_input(), report_type)
    names = [p["name"] for p in _people_of(content)]
    assert names == sorted(names), f"이름 순이 아닙니다: {names}"
    assert names == ["김하늘", "박바다", "홍길동"]


def test_reversing_the_input_does_not_change_the_output_order():
    """넣는 순서를 뒤집어도 결과가 같아야 합니다 — 순서가 입력에 안 매입니다."""
    forward = period.build(_period_input(), ReportType.FINAL)
    backward = period.build(
        _period_input(people=list(reversed(_sample_people()))), ReportType.FINAL
    )
    assert _people_of(forward) == _people_of(backward)


def test_nothing_in_the_report_is_a_value_drawn_on_a_shared_axis():
    """⚠️ 값을 **폭이나 위치**로 그리라고 시키는 칸이 없어야 합니다.

    이 저장소는 같은 결함을 두 번 냈습니다(기여도 막대의 절대 위치 ·
    카테고리 막대). 보고서에서 그런 칸을 만들면 화면이 순순히 막대를
    그립니다. 값은 **글자로만** 나갑니다.
    """
    content = period.build(_period_input(), ReportType.FINAL)
    flat = json.dumps(content, ensure_ascii=False)
    for forbidden in ("percent_of_max", "bar", "width", "ratio_to_team", "rank"):
        assert forbidden not in flat, f"`{forbidden}` 이 내용에 있습니다"


# ══════════════════════════════════════════════════════════════
# 2. 단일 점수 금지
# ══════════════════════════════════════════════════════════════


def test_a_single_computed_score_never_reaches_the_document():
    """계산값은 **구간으로만** 나갑니다.

    `share` 하나를 실으면 복사한 사람 손에 "홍길동 34%" 가 남고, 그게 곧
    단일 점수입니다. 받는 통로 자체를 안 두었습니다.
    """
    content = period.build(_period_input(), ReportType.FINAL)
    for entry in _people_of(content):
        assert "share" not in entry
        if entry["measured"]:
            assert entry["range_low"] is not None
            assert entry["range_high"] is not None

    with pytest.raises(TypeError):
        blocks.person(name="홍길동", role="backend", measured=True, share=34.0)


def test_the_interval_comes_with_confidence_and_evidence():
    """구간만으로는 부족합니다 — 신뢰도 + 사유 + 근거 건수까지."""
    content = period.build(_period_input(), ReportType.FINAL)
    measured = [p for p in _people_of(content) if p["measured"]]
    assert measured
    for entry in measured:
        assert entry["confidence"] is not None
        assert entry["confidence_label"]
        assert "evidence_count" in entry


# ══════════════════════════════════════════════════════════════
# 3. 측정 불가 ≠ 0점
# ══════════════════════════════════════════════════════════════


def test_someone_we_could_not_measure_is_not_written_down_as_zero():
    """⚠️ 못 잰 사람은 **0 이 아니라 빈 값 + 이유**로 나갑니다.

    폰이 잠겨 녹음이 끊긴 사람을 "말을 안 한 사람" 으로 적으면 그건 측정이
    아니라 오답입니다.
    """
    content = period.build(_period_input(), ReportType.FINAL)
    unmeasured = [p for p in _people_of(content) if not p["measured"]]
    assert unmeasured, "표본에 못 잰 사람이 없습니다 — 테스트가 헛돕니다"
    for entry in unmeasured:
        assert entry["range_low"] is None
        assert entry["range_high"] is None
        assert entry["gaps"], "못 쟀는데 이유가 없습니다"


def test_what_we_could_not_measure_is_written_down_somewhere_readable():
    """못 잰 것이 **본문에** 적힙니다. 비워 두면 "다 쟀다" 로 읽힙니다."""
    content = period.build(_period_input(), ReportType.FINAL)
    text = json.dumps(content, ensure_ascii=False)
    assert "못 잰 것" in text
    assert "녹음이 끊겨" in text
    # 처리 안 한 회의 1건과 백필 안 함이 둘 다 적혀야 합니다.
    assert "처리하지 않은 회의 1건" in text
    assert "연결 전 활동" in text


def test_an_empty_list_says_which_kind_of_empty_it_is():
    """⚠️ "없었다" 와 "아직 안 나왔다" 는 완전히 다른 말입니다."""
    done = minutes.build(
        minutes.MinutesInput(
            meeting_title="기획", status="done", capture_mode="multitrack"
        )
    )
    todo = minutes.build(
        minutes.MinutesInput(
            meeting_title="기획", status="processing", capture_mode="multitrack"
        )
    )
    done_notes = [b["empty_note"] for b in _find(done, "list")]
    todo_notes = [b["empty_note"] for b in _find(todo, "list")]
    assert all("아직" not in n for n in done_notes), done_notes
    assert all("아직" in n for n in todo_notes), todo_notes


# ══════════════════════════════════════════════════════════════
# 4. 시스템은 판정하지 않는다
# ══════════════════════════════════════════════════════════════


def test_a_report_that_carries_numbers_always_carries_the_warning():
    """사람별 수치를 이고 다니는 보고서에는 팀 경고가 **반드시** 붙습니다."""
    for report_type in sorted(CARRIES_CONTRIBUTION):
        content = period.build(_period_input(), report_type)
        assert blocks.TEAM_NOTICE in content["notices"]
        assert blocks.SYSTEM_NOTICE in content["notices"]


def test_before_the_team_confirms_the_report_says_so():
    """확정 전이면 **확정된 것이 아니라고** 적습니다."""
    content = period.build(_period_input(confirmed=False), ReportType.FINAL)
    text = json.dumps(content, ensure_ascii=False)
    assert "확정하지 않았습니다" in text

    confirmed = period.build(_period_input(confirmed=True), ReportType.FINAL)
    assert "확정하지 않았습니다" not in json.dumps(confirmed, ensure_ascii=False)


def test_a_confirmed_value_outside_the_computed_range_must_carry_its_reason():
    """⚠️ 사람도 근거 없이 판정하면 안 됩니다.

    화면이 이미 막고 있지만 보고서는 화면을 안 거치는 경로(배치·API)로도
    만들어집니다. 그래서 생성기가 다시 막습니다.
    """
    people = [
        period.Person(
            name="홍길동",
            role="backend",
            range_low=40.0,
            range_high=52.0,
            final_value=70.0,  # 구간 밖
        )
    ]
    with pytest.raises(ValueError, match="이유가 없습니다"):
        period.build(_period_input(people=people), ReportType.FINAL)

    with_reason = [
        period.Person(
            name="홍길동",
            role="backend",
            range_low=40.0,
            range_high=52.0,
            final_value=70.0,
            final_reason="설계 문서를 혼자 맡았는데 기록에 안 남았습니다",
        )
    ]
    content = period.build(_period_input(people=with_reason), ReportType.FINAL)
    assert _people_of(content)[0]["final_reason"]


def test_a_confirmed_value_inside_the_range_needs_no_reason():
    """구간 안이면 이유를 강요하지 않습니다 — 그건 그냥 계산값에 동의한 것."""
    people = [
        period.Person(
            name="홍길동", role="backend", range_low=40.0, range_high=52.0,
            final_value=45.0,
        )
    ]
    content = period.build(_period_input(people=people), ReportType.FINAL)
    assert _people_of(content)[0]["final_value"] == 45.0


# ══════════════════════════════════════════════════════════════
# 5. 회의록은 누가 얼마나를 적지 않는다
# ══════════════════════════════════════════════════════════════


def test_meeting_minutes_carry_no_per_person_numbers():
    """⚠️ 발언 수를 넣으면 그 순간 순위표가 됩니다.

    "많이 말한 사람" 은 기여가 아니라 발언량이고, 회의마다 나란히 적으면
    팀이 그걸로 서로를 봅니다.
    """
    content = minutes.build(
        minutes.MinutesInput(
            meeting_title="기획",
            status="done",
            capture_mode="multitrack",
            summary="배포 일정을 다음 회의로 미뤘습니다",
            unresolved=[minutes.Issue(content="배포 일정", evidence_count=3)],
            candidates=[minutes.Candidate(title="스키마 확정", decision="approved")],
        )
    )
    assert content["report_type"] == str(ReportType.MEETING_MINUTES)
    assert not _find(content, "people"), "회의록에 사람 블록이 있습니다"
    assert ReportType.MEETING_MINUTES not in CARRIES_CONTRIBUTION
    # 팀 경고도 안 붙습니다 — 붙이면 "여기 비교할 것이 있다" 는 신호가 됩니다.
    assert content["notices"] == []


def test_minutes_record_what_the_person_decided_not_just_the_candidate():
    """이 제품의 대표 주장이 지나가는 자리 — 사람이 무엇을 정했는지까지."""
    content = minutes.build(
        minutes.MinutesInput(
            meeting_title="기획",
            status="done",
            capture_mode="multitrack",
            candidates=[
                minutes.Candidate(title="스키마 확정", decision="approved"),
                minutes.Candidate(title="배포 자동화", decision="rejected"),
                minutes.Candidate(title="로그 정리", decision="pending"),
            ],
        )
    )
    lines = [b["items"] for b in _find(content, "list")]
    flat = [line for group in lines for line in group]
    assert "스키마 확정 — 등록함" in flat
    assert "배포 자동화 — 거절함" in flat
    assert "로그 정리 — 아직 안 정함" in flat


def test_a_broken_track_is_reported_as_unmeasurable_not_as_a_fault():
    """끊긴 트랙은 고장도 잘못도 아니라 "이 구간은 잴 수 없었다" 입니다."""
    content = minutes.build(
        minutes.MinutesInput(
            meeting_title="기획",
            status="done",
            capture_mode="multitrack",
            tracks_total=3,
            tracks_broken=1,
        )
    )
    gaps = _find(content, "gap")
    assert any("잴 수 없었습니다" in g["text"] for g in gaps), gaps
    assert any("말을 안 한 것과 다릅니다" in g["text"] for g in gaps)


# ══════════════════════════════════════════════════════════════
# 6. 다시 만들어도 쌓이지 않는다 — 열쇠
# ══════════════════════════════════════════════════════════════


def test_the_scope_key_is_stable_for_the_same_thing():
    """같은 것을 두 번 만들면 **같은 열쇠**가 나옵니다 — 그래야 갈아끼워집니다."""
    a = scope_key(ReportType.MEETING_MINUTES, meeting_id=7)
    b = scope_key(ReportType.MEETING_MINUTES, meeting_id=7)
    assert a == b == "meeting:7"

    week = dict(
        period_start=datetime(2026, 8, 3, tzinfo=UTC),
        period_end=datetime(2026, 8, 9, tzinfo=UTC),
    )
    assert scope_key(ReportType.WEEKLY, **week) == "2026-08-03..2026-08-09"
    assert scope_key(ReportType.FINAL) == "project"


def test_different_things_get_different_keys():
    """다른 회의·다른 주는 서로를 **안 덮어씁니다.**"""
    assert scope_key(ReportType.MEETING_MINUTES, meeting_id=7) != scope_key(
        ReportType.MEETING_MINUTES, meeting_id=8
    )
    first = scope_key(
        ReportType.WEEKLY,
        period_start=datetime(2026, 8, 3, tzinfo=UTC),
        period_end=datetime(2026, 8, 9, tzinfo=UTC),
    )
    second = scope_key(
        ReportType.WEEKLY,
        period_start=datetime(2026, 8, 10, tzinfo=UTC),
        period_end=datetime(2026, 8, 16, tzinfo=UTC),
    )
    assert first != second


def test_a_missing_anchor_raises_instead_of_quietly_defaulting():
    """⚠️ 조용히 기본값을 쓰면 **멀쩡한 보고서를 덮어씁니다.**"""
    with pytest.raises(ValueError, match="meeting_id"):
        scope_key(ReportType.MEETING_MINUTES)
    with pytest.raises(ValueError, match="period_start"):
        scope_key(ReportType.WEEKLY)
    with pytest.raises(ValueError, match="끝이 시작보다"):
        scope_key(
            ReportType.WEEKLY,
            period_start=datetime(2026, 8, 9, tzinfo=UTC),
            period_end=datetime(2026, 8, 3, tzinfo=UTC),
        )


def test_the_period_builder_refuses_a_type_it_does_not_make():
    """회의록을 이 생성기로 만들려 하면 터집니다 — 조용히 이상한 걸 내지 않게."""
    with pytest.raises(ValueError, match="만들 수 있는 종류가 아닙니다"):
        period.build(_period_input(), ReportType.MEETING_MINUTES)


# ══════════════════════════════════════════════════════════════
# 7. 문서에 영어 식별자를 남기지 않는다
# ══════════════════════════════════════════════════════════════


def test_every_meeting_status_is_classified():
    """⚠️ 새 상태가 생겼는데 분류를 안 하면 **거짓말이 나갑니다.**

    조용히 "처리를 마쳤습니다" 쪽으로 떨어지면, 처리에 실패한 회의의
    회의록이 "마쳤다" 고 말합니다. 보고서는 밖으로 나가는 문서라 그 거짓이
    그대로 제출물이 됩니다.
    """
    from teamflow.db.models import MeetingStatus

    unclassified = [
        s.value for s in MeetingStatus if minutes.state_of(s.value) == "unknown"
    ]
    assert not unclassified, (
        "처리 면에서 어디에 속하는지 안 정한 회의 상태입니다 — "
        f"`reports/minutes.py` 의 세 집합에 넣으십시오: {sorted(unclassified)}"
    )


def test_every_meeting_status_is_classified_into_the_right_one():
    """⭐ **덮는 것만으로는 모자랍니다** — 맞는 칸에 들어가야 합니다 (결함 289).

    위 검사는 「어디에도 안 떨어지는가」만 봤습니다. 그래서 `pending` 이
    **「처리를 마친 것」**에 들어가 있어도 초록이었고, 녹음조차 시작 안 한
    회의(발화 0 · 오디오 없음)의 회의록이 이렇게 나갔습니다 —

        처리: 처리를 마쳤습니다

    보고서는 밖으로 나가는 문서라 그 거짓이 그대로 제출물이 됩니다.
    """
    from teamflow.db.models import MeetingStatus

    expected = {
        # 아직 아무것도 안 나온 것 — 기다리면 바뀝니다.
        MeetingStatus.PENDING: "unprocessed",  # 녹음 전·녹음 중
        MeetingStatus.QUEUED: "unprocessed",
        MeetingStatus.PROCESSING: "unprocessed",
        # 사람이 다시 돌려야 하는 것.
        MeetingStatus.FAILED: "failed",
        # 요약·안건·사안이 나온 것.
        MeetingStatus.NEEDS_REVIEW: "processed",
        MeetingStatus.CONFIRMED: "processed",
    }
    assert set(expected) == set(MeetingStatus), (
        "회의 상태가 늘거나 줄었습니다 — 이 표에도 넣으십시오"
    )
    wrong = {
        s.value: (minutes.state_of(s.value), want)
        for s, want in expected.items()
        if minutes.state_of(s.value) != want
    }
    assert not wrong, f"엉뚱한 칸에 들어간 회의 상태입니다 (지금→맞는 것): {wrong}"


def test_the_three_sets_hold_no_status_that_does_not_exist():
    """⚠️ 없는 값이 섞이면 세 집합이 **꽉 찬 것처럼 보입니다** (결함 289).

    `recording`·`uploading`·`open` 과 `done` 이 들어 있었습니다. `done` 은
    **업무** 상태입니다 (결함 288 과 같은 뿌리). 그 덕에 잘못 들어간 하나가
    눈에 안 띄었습니다.
    """
    from teamflow.db.models import MeetingStatus

    known = {s.value for s in MeetingStatus}
    strays = sorted(
        (minutes._UNPROCESSED | minutes._FAILED | minutes._PROCESSED) - known
    )
    assert not strays, f"회의 상태가 아닌 값이 분류표에 있습니다: {strays}"


def test_the_document_does_not_leak_english_identifiers():
    """⚠️ `processing`·`multitrack` 을 그대로 적지 않습니다.

    받는 사람에게 영어 식별자는 아무 뜻이 없고, 있어 보이기만 합니다.
    (렌더해서 보고 찾았습니다 — 회의록에 `상태: processing` 이 떠 있었습니다.)
    """
    content = minutes.build(
        minutes.MinutesInput(
            meeting_title="기획", status="processing", capture_mode="multitrack"
        )
    )
    flat = json.dumps(content, ensure_ascii=False)
    assert "processing" not in flat, flat
    assert "multitrack" not in flat, flat
    assert "아직 처리하지 않았습니다" in flat
    assert "트랙이 곧 사람" in flat


def test_the_period_report_does_not_leak_an_english_role():
    """⭐ **역할도 영어 식별자를 남기지 않습니다** (결함 291).

    이 검사는 회의록의 `processing`·`multitrack` 만 보고 있었고, 사람별
    기여가 들어가는 주간·최종 보고서는 안 보고 있었습니다 — 그래서 최종
    보고서가 `developer` 를 그대로 싣고 화면에 그대로 떴습니다.

    ⚠️ **값만 봅니다.** JSON 의 열쇠(`role`·`blocks` …)는 구조라 영어가
    맞습니다 — 열쇠까지 세면 이 검사는 영원히 빨갛습니다.
    """
    from teamflow.contribution.profiles import Role
    from teamflow.reports import period as period_builder

    content = period_builder.build(
        period_builder.PeriodInput(
            project_name="팀",
            people=[
                period_builder.Person(
                    name="김민수",
                    role="개발 60% · 디자인 40%",
                    measured=True,
                    range_low=10.0,
                    range_high=20.0,
                    confidence=0.5,
                    confidence_label="낮음",
                    reasons=[],
                    evidence_count=3,
                    gaps=[],
                    final_value=None,
                    final_reason=None,
                )
            ],
        ),
        ReportType.FINAL,
    )
    values = _string_values(content)
    leaked = sorted({v for v in values if v in {str(r) for r in Role}})
    assert not leaked, f"문서에 영어 역할 식별자가 남았습니다: {leaked}"


def _string_values(node, out=None):
    """JSON 에서 **값**인 문자열만 모은다 (열쇠는 뺀다)."""
    out = [] if out is None else out
    if isinstance(node, dict):
        for v in node.values():
            _string_values(v, out)
    elif isinstance(node, list):
        for v in node:
            _string_values(v, out)
    elif isinstance(node, str):
        out.append(node)
    return out


def test_a_failed_meeting_is_not_reported_as_finished():
    """실패는 **아직 안 한 것과도, 마친 것과도** 다릅니다."""
    failed = minutes.build(
        minutes.MinutesInput(
            meeting_title="기획", status="failed", capture_mode="multitrack"
        )
    )
    text = json.dumps(failed, ensure_ascii=False)
    assert "처리하다 실패했습니다" in text
    assert "다시 처리해야 합니다" in text
    # 실패한 회의에서 "아직 처리하지 않았습니다" 로 안내하면 사람은 기다립니다.
    assert "아직 처리하지 않았습니다" not in text


def test_an_unknown_status_is_shown_as_is_not_guessed():
    """모르는 값에 이름을 지어내지 않습니다 — 이 저장소의 기존 규칙과 같습니다."""
    content = minutes.build(
        minutes.MinutesInput(
            meeting_title="기획", status="teleported", capture_mode="hologram"
        )
    )
    flat = json.dumps(content, ensure_ascii=False)
    assert "teleported" in flat
    assert "hologram" in flat


def test_a_gap_and_a_value_cannot_be_given_together():
    """⚠️ 둘은 모순입니다 — 못 잰 것에는 값이 없습니다.

    이 규칙이 없던 동안 회의록의 `처리` 줄이 상태 문장 + `gap=True` 였고,
    화면에서는 멀쩡했는데 **글자로 복사하면 문장이 "못 쟀습니다" 로 바뀌어**
    나갔습니다. 복사 버튼을 실제로 눌러 보고서야 찾았습니다.
    """
    with pytest.raises(ValueError, match="같이 줬습니다"):
        blocks.fact("처리", "처리를 마쳤습니다", gap=True)
    # 값이 없으면 gap 은 정상입니다 — 그게 원래 뜻입니다.
    assert blocks.fact("커버리지", "", gap=True)["gap"] is True


def test_the_processing_line_keeps_its_sentence():
    """`처리` 는 못 잰 값이 아니라 사실이라 문장이 그대로 남습니다."""
    content = minutes.build(
        minutes.MinutesInput(
            meeting_title="기획", status="failed", capture_mode="multitrack"
        )
    )
    facts = _find(content, "facts")[0]["items"]
    processing = next(f for f in facts if f["label"] == "처리")
    assert processing["gap"] is False
    assert processing["value"] == "처리하다 실패했습니다 — 다시 처리해야 합니다"


# ══════════════════════════════════════════════════════════════
# 문서의 시각도 팀 달력이다 (결함 290)
# ══════════════════════════════════════════════════════════════


def test_the_minutes_print_the_team_calendar_not_utc():
    """⭐ 밖으로 나가는 문서가 화면과 **다른 시각**을 적으면 안 된다.

    같은 회의를 홈 화면은 `09-08 19:00`, 회의록은 `2026-09-08 10:00` 이라고
    했습니다 — 서버가 들고 있는 UTC 를 그대로 찍었기 때문입니다. 아홉
    시간이 어긋난 쪽이 **제출물**이었습니다.

    ⚠️ **자정을 넘는 순간**으로 잽니다. `10:00Z` 로 재면 날짜가 안 넘어가
    UTC 든 팀 달력이든 날짜가 같아, 그 자는 아무것도 안 가릅니다.
    """
    from datetime import UTC, datetime

    content = minutes.build(
        minutes.MinutesInput(
            meeting_title="자정 넘는 회의",
            status="needs_review",
            capture_mode="multitrack",
            started_at=datetime(2026, 8, 25, 16, 30, tzinfo=UTC),
        )
    )
    flat = json.dumps(content, ensure_ascii=False)
    assert "2026-08-26 01:30" in flat, flat
    assert "2026-08-25 16:30" not in flat, "UTC 를 그대로 찍었습니다"


def test_no_report_module_formats_a_datetime_by_hand():
    """⚠️ 시각을 손으로 찍으면 그 자리는 **팀 달력 밖**입니다 (결함 290).

    `f"{...:%Y-%m-%d ...}"` 는 datetime 을 그대로 찍습니다. 서버가 들고
    있는 값은 UTC 이므로, `clock.local_time`·`clock.local_date` 를 거치지
    않은 자리는 전부 아홉 시간 어긋납니다.
    """
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parents[1] / "teamflow" / "reports"
    bad: list[str] = []
    for path in root.rglob("*.py"):
        source = path.read_text(encoding="utf-8")
        code = re.sub(r'"""[\s\S]*?"""', "", source)
        code = re.sub(r"^\s*#.*$", "", code, flags=re.M)
        for m in re.finditer(r"\{([^{}]*?):%[YmdHM][^{}]*\}", code):
            inner = m.group(1)
            if "clock.local_time" in inner or "clock.local_date" in inner:
                continue
            # 사람이 읽는 글자가 아니라 **열쇠**인 자리 하나만 예외입니다.
            # 열쇠는 시간대를 타면 안 됩니다 — 표시는 `period.py` 가 따로
            # 만듭니다. 예외는 그 줄에 `# teamtz-ok` 로 적어 둡니다.
            line = code[: m.start()].count("\n")
            if "teamtz-ok" in code.splitlines()[line]:
                continue
            bad.append(f"{path.name}: {m.group(0)}")
    assert not bad, (
        "보고서가 시각을 손으로 찍습니다 — `clock.local_time`/`local_date` 를 "
        "거치세요:\n  " + "\n  ".join(bad)
    )


def test_no_report_text_carries_markdown_syntax():
    """⭐ 보고서 블록은 **마크다운이 아니라 글자**입니다 (결함 292).

    최종 보고서에 이렇게 찍혀 있었습니다 —

        위 구간은 계산값이며 **확정된 기여도가 아닙니다.**

    화면에도, 「글자로 복사」한 결과에도 별표가 그대로 나갑니다. 강조하려던
    것이 오히려 문서를 어설프게 보이게 합니다. 렌더해서 눈으로 보고
    찾았습니다.
    """
    import re

    from teamflow.contribution.profiles import Role  # noqa: F401  (씨앗 대조용)

    made = [
        minutes.build(
            minutes.MinutesInput(
                meeting_title="회의",
                status="needs_review",
                capture_mode="multitrack",
                summary="요약",
            )
        ),
        period_builder_content(),
    ]
    bad: list[str] = []
    for content in made:
        for text in _string_values(content):
            if re.search(r"\*\*|__|\[[^\]]+\]\([^)]+\)", text):
                bad.append(text[:80])
    assert not bad, f"보고서 글자에 마크다운이 섞였습니다: {bad}"


def test_the_report_does_not_invent_a_reason_for_a_skipped_category():
    """⛔ 「가중치가 0이라 계산에서 빠진 영역」 — **지어낸 이유** (결함 311).

    이 목록을 만드는 자는 `scoring.py` 의

        skipped = [c for c in Category if team_totals[c] <= 0]

    입니다. 재는 것은 **가중치가 아니라 팀의 활동량**입니다. 갓 만든
    프로젝트에서 렌더해 보니 여섯 영역이 전부 실렸고, 그중 코드(35%)·
    업무(30%)는 그 사람의 **가장 큰 가중치**였습니다 — 밖으로 나가는
    문서가 「네 코드는 0으로 쳤다」고 말한 셈입니다.

    ⚠️ 불변식 ③(측정 불가 ≠ 0점) 과도 반대 방향입니다.
    """
    from teamflow.reports import period as period_builder

    content = period_builder.build(
        period_builder.PeriodInput(
            project_name="갓 만든 팀",
            people=[
                period_builder.Person(
                    name="김민수",
                    role="개발",  # 코드 35% · 업무 30% — 0 이 아닙니다
                    measured=False,
                    range_low=None,
                    range_high=None,
                    confidence=0.0,
                    confidence_label="매우 낮음",
                    reasons=[],
                    evidence_count=0,
                    gaps=["활동 기록이 없어 잴 수 없었습니다"],
                    final_value=None,
                    final_reason=None,
                )
            ],
            # 실기에서 나오는 모양 그대로 — 갓 만든 프로젝트는 여섯 다 실립니다
            skipped_categories=["업무", "코드", "회의", "문서", "일정 준수", "동료 평가"],
        ),
        ReportType.FINAL,
    )
    text = json.dumps(content, ensure_ascii=False)

    assert "가중치가 0" not in text, (
        "보고서가 이유를 지어냅니다 — 이 목록은 가중치가 아니라 활동량으로 만들어집니다"
    )
    assert "팀 전체에 기록된 활동이 없어" in text, text
    # ⚠️ 「없다」를 「0점」으로 읽히게 두지 않습니다 (불변식 ③).
    assert "이 계산에 잡힌 것이 없다는 뜻입니다" in text, text


def test_the_report_and_the_screen_say_the_same_thing_about_skipped_areas():
    """⚠️ **같은 사실을 말하는 두 자리를 나란히 놓습니다** (결함 290 의 교훈).

    화면(`lib/contribution/view.ts`)은 같은 목록을 「… 활동은 이번 계산에서
    빠졌습니다.」라고만 적고 **이유를 안 붙입니다.** 서버가 거기에 없는
    이유를 덧붙이면 두 자리가 갈라집니다 — 실제로 갈라져 있었습니다.
    """
    view = (ROOT / "frontend" / "src" / "lib" / "contribution" / "view.ts").read_text(
        encoding="utf-8"
    )
    assert "이번 계산에서 빠졌습니다" in view, "화면 쪽 문장을 못 찾았습니다"
    assert "가중치" not in view.split("이번 계산에서 빠졌습니다")[0][-400:], (
        "화면이 이유를 붙이기 시작했으면 서버 문장과 맞춰야 합니다"
    )

    period_src = (
        ROOT / "backend" / "teamflow" / "reports" / "period.py"
    ).read_text(encoding="utf-8")
    body = "\n".join(
        line for line in period_src.splitlines() if not line.strip().startswith("#")
    )
    assert "가중치가 0이라 계산에서 빠진" not in body, (
        "보고서가 아직 가중치를 이유로 댑니다"
    )


def period_builder_content():
    from teamflow.reports import period as period_builder

    return period_builder.build(
        period_builder.PeriodInput(
            project_name="팀",
            people=[
                period_builder.Person(
                    name="김민수",
                    role="개발",
                    measured=True,
                    range_low=10.0,
                    range_high=20.0,
                    confidence=0.5,
                    confidence_label="낮음",
                    reasons=["근거가 적습니다"],
                    evidence_count=3,
                    gaps=["녹음이 끊겼습니다"],
                    final_value=None,
                    final_reason=None,
                )
            ],
            skipped_categories=["문서"],
        ),
        ReportType.FINAL,
    )
