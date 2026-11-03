from datetime import date

from teamflow.meeting.resolve import grounded_deadline


def test_model_cannot_drop_next_week_from_evidence():
    meeting = date(2026, 11, 2)
    evidence = ["회원가입 화면을 맡겠습니다. 마감은 다음 주 화요일입니다."]
    assert grounded_deadline("화요일까지", evidence, meeting).value == date(2026, 11, 10)
    assert grounded_deadline(None, evidence, meeting).value == date(2026, 11, 10)


def test_ambiguous_or_invented_deadline_is_left_for_review():
    meeting = date(2026, 11, 2)
    evidence = ["API는 이번 주 금요일까지, 화면은 다음 주 화요일까지입니다."]
    assert grounded_deadline("금요일", evidence, meeting).value is None
    assert (
        grounded_deadline("다음 주 화요일", ["담당자를 정하지 않았습니다"], meeting).value is None
    )
