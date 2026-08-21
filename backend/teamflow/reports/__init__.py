"""보고서 — 회의록 · 주간 · 최종 (docs/08 §2 "반드시 구현").

## 왜 이 패키지가 늦게 생겼는가

`reports` 표는 처음부터 스키마에 있었고 **쓰는 코드가 0곳**이었습니다.
로드맵의 자기 진단표도 그렇게 적고 있었습니다 — `보고서 | ❌ | reports 표만
있고 쓰는 코드 없음`. 이 저장소의 대표 실패 ①("만들어 놓고 아무도 안 부름")이
스키마 수준에서 남아 있던 자리입니다.

## ⚠️ 여기가 불변식이 가장 위험한 자리입니다

보고서는 **앱 밖으로 나가는 문서**입니다. 복사돼서 제출물이 되고 메일이 되고
발표 자료가 됩니다. 화면이라면 CSS 가드가 막고 렌더 검사가 다시 재지만,
**글자가 되어 나간 뒤에는 아무 가드도 안 닿습니다.**

그래서 순위 금지·구간·측정 불가 표시를 화면이 아니라 **생성기 자체**에
박았습니다. 화면은 만들어진 블록을 그리기만 합니다.

* 사람은 **이름 순**입니다. 값으로 정렬하는 길이 아예 없습니다 —
  `people_block()` 이 받는 즉시 이름으로 다시 세웁니다.
* **단일 점수를 안 싣습니다.** 계산값은 구간(`range_low`~`range_high`) +
  신뢰도 + 사유 + 근거 건수로만 나갑니다. `share` 하나를 실으면 복사한
  사람 손에 "홍길동 34%" 가 남고, 그게 곧 단일 점수입니다.
* 팀이 **확정한** 값은 단일 숫자로 나갑니다 — 그건 시스템의 판정이 아니라
  사람의 합의이기 때문입니다. 계산값과 다르면 **이유가 반드시 따라갑니다.**
* 못 잰 것은 0이 아니라 **못 쟀다고** 적습니다.

## 블록

내용을 자유 서식 문자열로 만들지 않습니다. 문자열로 만들면 화면이 그걸
다시 파싱해야 하고, 그 순간 "무엇이 결측인가" 같은 판단이 화면으로 새어
검증 밖으로 나갑니다. 대신 **블록 목록**을 만들고 화면은 종류별로 그립니다.

    heading    절 제목
    paragraph  문단 (없으면 만들지 않습니다 — 빈 문단은 빈 줄이 됩니다)
    facts      이름=값 목록. 못 잰 값은 `gap: true`
    list       줄 목록. 비어 있으면 `empty_note` 를 대신 그립니다
    people     사람별 기여 — 불변식이 사는 곳
    gap        못 잰 것을 통째로 말하는 자리
"""

from __future__ import annotations

from datetime import datetime

from teamflow.db.vocab import REPORT_SCOPE, ReportScope, ReportType

#: 내용 구조가 바뀌면 올립니다. 화면이 모르는 판을 만나면 그렇다고 말할 수
#: 있어야 합니다 — 조용히 빈 화면을 그리면 "보고서가 비었다" 로 읽힙니다.
SCHEMA_VERSION = 1


def scope_key(
    report_type: ReportType,
    *,
    meeting_id: int | None = None,
    period_start: datetime | None = None,
    period_end: datetime | None = None,
) -> str:
    """이 보고서가 **무엇 하나에 매여 있는지**를 한 문자열로.

    `reports.scope_key` 열에 그대로 들어가고, `uq_report_scope` 유일 제약이
    이걸 씁니다. 즉 **다시 만들었을 때 무엇을 갈아끼우는지**가 여기서
    정해집니다.

    ⚠️ 만드는 곳은 여기 하나뿐입니다. 두 곳에서 만들면 한쪽만 고쳐지고, 그
    순간 같은 보고서가 서로 다른 열쇠를 갖게 되어 유일 제약이 **아무것도 안
    막습니다** — 오류는 안 나고 그냥 최종 보고서가 두 벌이 됩니다.

    ⚠️ 필요한 값이 없으면 **터집니다.** 조용히 기본값을 쓰면 서로 다른
    보고서가 같은 열쇠를 갖게 되어 이번에는 반대로 **멀쩡한 것을 덮어씁니다.**
    """
    scope = REPORT_SCOPE[report_type]

    if scope is ReportScope.MEETING:
        if meeting_id is None:
            raise ValueError(
                f"{report_type} 는 회의 하나에 매입니다 — meeting_id 가 필요합니다"
            )
        return f"meeting:{meeting_id}"

    if scope is ReportScope.PERIOD:
        if period_start is None or period_end is None:
            raise ValueError(
                f"{report_type} 는 기간에 매입니다 — period_start·period_end 가 "
                "필요합니다"
            )
        if period_end < period_start:
            raise ValueError("기간의 끝이 시작보다 앞섭니다")
        # ⚠️ 여기만 **UTC 로 찍습니다.** 이 글자는 사람이 읽는 것이 아니라
        #    `uq_report_scope` 가 쓰는 **열쇠**입니다 (결함 290). 열쇠는
        #    시간대를 안 타야 합니다 — 팀 달력으로 찍으면 설정이 바뀌는
        #    순간 같은 보고서가 다른 열쇠를 갖고, 유일 제약이 아무것도 안
        #    막습니다. 사람에게 보이는 기간은 `period.py` 가 팀 달력으로
        #    따로 만듭니다. (표시가 아니라 열쇠 — `teamtz-ok`)
        return f"{period_start:%Y-%m-%d}..{period_end:%Y-%m-%d}"  # teamtz-ok

    return "project"
