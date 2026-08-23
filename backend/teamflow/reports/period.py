"""주간 · 최종 보고서 — 기간 동안 무슨 일이 있었나.

⚠️ **이 파일이 만드는 글자가 제출물이 됩니다.** 최종 보고서는 졸업작품에서
교수자가 읽는 바로 그 문서입니다. 그래서 기여도 불변식 넷을 화면이 아니라
여기서 지킵니다 — `blocks.people()` 이 이름 순을 강제하고, `blocks.person()`
은 애초에 단일 계산값을 **받는 통로가 없습니다.**
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from teamflow import clock
from teamflow.db.vocab import ReportType
from teamflow.reports import SCHEMA_VERSION, blocks


@dataclass(frozen=True, slots=True)
class Person:
    """한 사람의 몫.

    ⚠️ 계산된 단일 점수(`share`)는 **일부러 없습니다.** 구간으로만 옵니다.
    """

    name: str
    role: str
    #: 잴 수 있었는가. False 면 구간도 신뢰도도 뜻이 없습니다.
    measured: bool = True
    range_low: float | None = None
    range_high: float | None = None
    confidence: float | None = None
    confidence_label: str | None = None
    reasons: list[str] = field(default_factory=list)
    evidence_count: int = 0
    #: 이 사람의 **못 잰 영역**. 0점이 아니라 모르는 것입니다.
    gaps: list[str] = field(default_factory=list)
    #: 팀이 확정한 값. 확정 전이면 None.
    final_value: float | None = None
    final_reason: str | None = None


@dataclass(frozen=True, slots=True)
class PeriodInput:
    project_name: str
    people: list[Person]
    period_start: datetime | None = None
    period_end: datetime | None = None
    meetings_total: int = 0
    meetings_processed: int = 0
    tasks_done: int = 0
    tasks_open: int = 0
    github_events: int = 0
    #: 연결 **전** 활동을 훑었는가 (백필). 안 훑었으면 그만큼 안 보입니다.
    github_backfilled: bool = False
    #: 팀이 기여도를 확정했는가.
    confirmed: bool = False
    #: **팀 전체의 활동량이 0이라** 아예 계산에서 빠진 영역 (결함 311).
    #: 가중치와는 무관합니다 — 만드는 자는 `scoring.py` 의 `team_totals`.
    skipped_categories: list[str] = field(default_factory=list)


def build(data: PeriodInput, report_type: ReportType) -> dict[str, Any]:
    """주간·최종 내용을 만든다. 둘은 **기간과 제목만** 다릅니다.

    같은 판단을 두 벌 만들지 않으려고 한 함수로 둡니다 — 갈라 두면 한쪽에만
    불변식이 붙는 날이 옵니다.
    """
    if report_type not in (ReportType.WEEKLY, ReportType.FINAL):
        raise ValueError(f"이 생성기가 만들 수 있는 종류가 아닙니다: {report_type}")

    if report_type is ReportType.WEEKLY:
        # ⛔ 여기도 UTC 를 그대로 찍고 있었습니다 (결함 290). 주간 보고서의
        #    기간이 팀 달력과 하루 어긋날 수 있습니다.
        span = (
            f"{clock.local_date(data.period_start):%Y-%m-%d}"
            f" ~ {clock.local_date(data.period_end):%Y-%m-%d}"
        )
        title = f"주간 보고서 — {span}"
    else:
        title = f"최종 보고서 — {data.project_name}"

    body: list[dict[str, Any]] = []

    # ── 무슨 일이 있었나 ──────────────────────────────────
    unprocessed = data.meetings_total - data.meetings_processed
    body.append(blocks.heading("이 기간에 일어난 일"))
    body.append(
        blocks.facts(
            [
                blocks.fact("회의", f"{data.meetings_total}건"),
                blocks.fact(
                    "처리된 회의",
                    f"{data.meetings_processed}건",
                    note=(
                        f"{unprocessed}건은 아직 처리 전이라 그 회의의 발언은 "
                        "기여도에 안 들어갔습니다"
                        if unprocessed
                        else ""
                    ),
                ),
                blocks.fact("완료한 업무", f"{data.tasks_done}건"),
                blocks.fact("남은 업무", f"{data.tasks_open}건"),
                blocks.fact(
                    "GitHub 활동",
                    f"{data.github_events}건",
                    note=(
                        ""
                        if data.github_backfilled
                        else "연결 전 활동은 아직 안 훑었습니다"
                    ),
                ),
            ]
        )
    )

    # ── 사람별 ────────────────────────────────────────────
    #
    # ⚠️ **여기 숫자는 기간이 아니라 프로젝트 전체입니다** (결함 332).
    #    위 「이 기간에 일어난 일」의 숫자들(`counts`)은 기간으로 걸러
    #    오는데, 사람별 몫은 `_people(session, project_id)` 가 **기간을
    #    안 받습니다.** 그래서 한 문서 안에 축이 둘인데, 주간 보고서에서는
    #    바로 위 문단이 「이 기간」이라고 말해 놓은 뒤라 사람은 아래 값도
    #    그 주의 것으로 읽습니다.
    #
    #    재현: 아무 일도 없던 주에 만든 주간 보고서가 「회의 0건 · 완료한
    #    업무 0건 · GitHub 0건」이라고 적어 놓고, 바로 아래에서 세 사람에게
    #    30.5~53.9% · 18.0~31.7% · 23.8~42.1% 를 붙였습니다 — **최종
    #    보고서와 한 자도 다르지 않은 값**입니다.
    #
    #    기간별로 다시 계산하는 것은 산정 엔진에 기간 개념을 넣는 일이라
    #    여기서 고르지 않습니다. **무엇을 재고 있는지 말합니다** — 결함
    #    311·323·331 이 같은 자리에서 택한 방법입니다.
    cumulative = report_type is ReportType.WEEKLY
    body.append(
        blocks.heading("사람별 기여 — 프로젝트 전체 누적" if cumulative else "사람별 기여")
    )
    if cumulative:
        body.append(
            blocks.paragraph(
                # ⚠️ 별표를 쓰지 않습니다 — 보고서 블록은 마크다운이 아니라
                #    글자입니다(결함 292). 강조는 「」로 합니다.
                "아래 값은 이 주에 한 일이 아니라 「프로젝트를 시작한 뒤 지금까지」의 "
                "누적입니다. 이 주에 무슨 일이 있었는지는 위 「이 기간에 일어난 일」을 "
                "보십시오."
            )
        )
    body.append(
        blocks.people(
            [
                blocks.person(
                    name=p.name,
                    role=p.role,
                    measured=p.measured,
                    range_low=p.range_low,
                    range_high=p.range_high,
                    confidence=p.confidence,
                    confidence_label=p.confidence_label,
                    reasons=p.reasons,
                    evidence_count=p.evidence_count,
                    gaps=p.gaps,
                    final_value=p.final_value,
                    final_reason=p.final_reason,
                )
                for p in data.people
            ]
        )
    )

    if data.confirmed:
        body.append(
            blocks.paragraph(
                "위 확정값은 팀이 합의해 정한 것입니다. 계산 구간과 다른 값에는 "
                "그렇게 정한 이유가 함께 적혀 있습니다."
            )
        )
    else:
        body.append(
            # ⛔ 예전에는 「**확정된 기여도가 아닙니다.**」 였습니다 (결함 292).
            #    이 블록은 **마크다운이 아니라 글자**라, 화면에도 「글자로
            #    복사」한 결과에도 별표가 그대로 찍혔습니다. 강조하려던 것이
            #    오히려 문서를 어설프게 보이게 했습니다 — 이 저장소가 렌더해
            #    보고 한 번 잡은 부류인데 이 자리에 다시 있었습니다.
            blocks.gap(
                "팀이 아직 기여도를 확정하지 않았습니다. 위 구간은 계산값이며 "
                "확정된 기여도가 아닙니다."
            )
        )

    # ── 못 잰 것 ──────────────────────────────────────────
    #
    # ⚠️ 여기를 비워 두면 보고서가 "다 쟀다" 고 말하는 것과 같습니다.
    #    측정 불가는 0점이 아니라 **모르는 것**이고, 읽는 사람은 그 차이를
    #    알아야 숫자를 제대로 씁니다.
    holes: list[str] = []
    if unprocessed:
        holes.append(f"처리하지 않은 회의 {unprocessed}건 — 그 발언은 안 들어갔습니다")
    if not data.github_backfilled:
        holes.append("GitHub 연결 전 활동 — 아직 훑지 않아 보이지 않습니다")
    if data.skipped_categories:
        # ⛔ **여기서 이유를 지어내고 있었습니다** (결함 311). 예전 문장은
        #    「**가중치가 0이라** 계산에서 빠진 영역」이었는데, 이 목록을
        #    만드는 자는 `scoring.py` 의
        #        skipped = [c for c in Category if team_totals[c] <= 0]
        #    입니다 — 재는 것은 **가중치가 아니라 팀의 활동량**입니다.
        #    갓 만든 프로젝트에서 여섯 영역이 전부 여기 실렸고, 그중
        #    코드(35%)·업무(30%)는 그 사람의 가장 큰 가중치였습니다.
        #    **밖으로 나가는 문서**가 「네 코드는 0으로 쳤다」고 말한 셈입니다.
        #
        #    ⚠️ 불변식 ③ 과도 반대입니다 — 「측정 불가 ≠ 0점」인데 「가중치
        #    0」은 **일부러 안 세기로 했다**는 뜻으로 읽힙니다. 화면은 같은
        #    목록을 「이번 계산에서 빠졌습니다」라고만 적고 이유를 안 붙입니다
        #    (`contribution/view.ts`). 두 자리가 **같은 사실**을 말해야 합니다.
        holes.append(
            "팀 전체에 기록된 활동이 없어 계산에서 빠진 영역: "
            + ", ".join(data.skipped_categories)
            + " — 아무도 안 했다는 뜻이 아니라 이 계산에 잡힌 것이 없다는 뜻입니다"
        )
    for p in data.people:
        for hole in p.gaps:
            holes.append(f"{p.name} — {hole}")

    body.append(blocks.heading("못 잰 것"))
    body.append(
        blocks.bullets(
            holes,
            empty_note="이 기간에 측정하지 못한 것으로 기록된 항목이 없습니다.",
        )
    )

    return {
        "schema": SCHEMA_VERSION,
        "report_type": str(report_type),
        "title": title,
        # ⚠️ 사람별 수치를 이고 다니는 보고서에는 **반드시** 붙습니다.
        #    `CARRIES_CONTRIBUTION` 과 짝이고, 테스트가 둘을 묶어 둡니다.
        "notices": [blocks.TEAM_NOTICE, blocks.SYSTEM_NOTICE],
        "blocks": body,
    }
