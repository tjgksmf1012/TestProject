"""회의를 뭐라고 부를 것인가 — 서버 쪽 한 벌.

화면 쪽 한 벌은 ``frontend/src/lib/ui/naming.ts`` 의 ``meetingLabel`` 입니다.
언어가 달라 두 벌인데, **갈라지면 같은 회의가 화면과 회의록에서 다른
이름으로 불립니다** — 결함 285 가 정확히 그것이었습니다. 씨앗 회의 4번
하나를 두고 이름이 여덟 가지였고, 그중 넷이 서버에서 나왔습니다.

===========================  ==================
어디                          뭐라고 불렀나
===========================  ==================
회의록(``report_service``)    회의 #4
달력(``calendar_service``)    회의 4
검색(``search_service``)      회의 4
알림(``notification_service``) 이름 없는 회의
===========================  ==================

``제목 없는 회의``(화면) 와 ``이름 없는 회의``(알림)는 **낱말 하나가**
다릅니다. 사람은 그 둘을 다른 것으로 읽습니다.

번호를 붙이는 이유는 주소창의 그 번호이기 때문입니다
(``/meeting/4/review``) — 이름 없는 회의가 둘일 때 서로에게 가리킬 수
있는 유일한 값입니다.

⚠️ 이 문자열 모양은 ``backend/tests/test_naming.py`` 가 못 박습니다.
바꾸려면 **화면 쪽(`naming.ts`)과 같은 커밋에서** 바꾸십시오.
"""

from __future__ import annotations


def meeting_label(title: str | None, meeting_id: int | None) -> str:
    """회의에 붙일 이름. 이름이 없으면 **어느 회의인지**를 남긴다."""
    named = (title or "").strip()
    if named:
        return named
    if meeting_id is None:
        # 번호를 모르면 없는 값을 짓지 않습니다.
        return "제목 없는 회의"
    return f"제목 없는 회의 #{meeting_id}"
