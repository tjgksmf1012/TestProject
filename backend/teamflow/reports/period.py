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
    #: 가중치가 0이라 아예 계산에서 빠진 영역.
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
    body.append(blocks.heading("사람별 기여"))
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
            blocks.gap(
                "팀이 아직 기여도를 확정하지 않았습니다. 위 구간은 계산값이며 "
                "**확정된 기여도가 아닙니다.**"
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
        holes.append(
            "가중치가 0이라 계산에서 빠진 영역: " + ", ".join(data.skipped_categories)
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
