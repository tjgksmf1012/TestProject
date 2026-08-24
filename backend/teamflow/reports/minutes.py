"""회의록 — 회의 하나에 무슨 일이 있었나.

⚠️ **사람별 발언 수를 넣지 않습니다.** 넣으면 그 순간 순위표가 됩니다 —
"많이 말한 사람" 은 기여가 아니라 발언량이고, 그걸 회의마다 나란히 적으면
팀이 그걸로 서로를 봅니다. `db/vocab.py` 의 `CARRIES_CONTRIBUTION` 에
`meeting_minutes` 가 **일부러 빠져 있는** 이유이고, 테스트가 그것을 지킵니다.

회의록은 **무슨 일이 있었나**를 적지 **누가 얼마나**를 적지 않습니다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from teamflow import clock
from teamflow.db.vocab import ReportType
from teamflow.reports import SCHEMA_VERSION, blocks


@dataclass(frozen=True, slots=True)
class Issue:
    """미해결 사안 하나.

    ⚠️ `evidence_count` 를 같이 듭니다. 근거 건수 없이 "이게 미해결입니다"
    라고만 하면 읽는 사람이 확인할 방법이 없습니다 — 이 저장소는 후보
    승인에서 이미 같은 규칙을 씁니다.
    """

    content: str
    evidence_count: int = 0


@dataclass(frozen=True, slots=True)
class Candidate:
    """업무 후보와 **사람이 내린 결정**."""

    title: str
    #: approved | rejected | pending
    decision: str


@dataclass(frozen=True, slots=True)
class MinutesInput:
    meeting_title: str
    status: str
    capture_mode: str
    #: 회의를 **연** 시각. 아직 안 연 회의는 비어 있습니다.
    started_at: datetime | None = None
    #: **잡아 둔** 시각. 이미 연 회의는 비어 있습니다.
    #:
    #: ⚠️ 이게 없던 동안 회의록은 `started_at` 만 봤습니다 (결함 358).
    #: 달력에서 일정을 잡은 회의는 시각을 **알고 있는데** 회의록이
    #: 「일시 못 쟀습니다」라고 적었습니다 — 홈은 같은 회의를
    #: 「예정 09-15 10:00」이라고 부릅니다. 「못 쟀습니다」는 이 제품의
    #: 불변식(**측정 불가 ≠ 0점**)이 쓰는 말이라, 아는 값에 붙이면
    #: 그 말이 닳습니다.
    scheduled_at: datetime | None = None
    summary: str | None = None
    next_agenda: list[str] = field(default_factory=list)
    unresolved: list[Issue] = field(default_factory=list)
    candidates: list[Candidate] = field(default_factory=list)
    #: 트랙(사람별 녹음) 총 개수와 그중 **온전하지 않은** 것.
    tracks_total: int = 0
    tracks_broken: int = 0


_DECISION_LABEL = {
    "approved": "등록함",
    "rejected": "거절함",
    "pending": "아직 안 정함",
}

#: 회의가 아직 이 상태면 요약·안건·사안이 **없는 게 아니라 아직 안 나온** 것.
#:
#: ⚠️ **`pending` 이 여기가 아니라 「처리를 마친 것」에 있었습니다** (결함 289).
#: `pending` 은 「녹음 중이거나 아직 전원이 끝나지 않음」이라 아무것도 처리된
#: 적이 없는데, 녹음조차 시작 안 한 회의의 회의록이 「**처리를 마쳤습니다**」
#: 라고 나갔습니다 — 이 파일이 바로 아래에서 「보고서에서 그건 거짓말입니다」
#: 라고 적어 둔 그것입니다.
#:
#: ⚠️ 여기 있던 `recording`·`uploading`·`open` 과 「처리」쪽의 `done` 은
#: **회의 상태가 아닙니다** (`done` 은 업무 상태 — 결함 288 과 같은 뿌리).
#: 없는 값이 섞여 있어서 세 집합이 **꽉 찬 것처럼 보였고**, 그래서 잘못
#: 들어간 하나가 눈에 안 띄었습니다.
_UNPROCESSED = frozenset({"pending", "queued", "processing"})

#: 처리를 시도했다가 실패한 것. **아직 안 한 것과 다릅니다** — 기다려도
#: 안 바뀌고, 사람이 다시 돌려야 합니다.
_FAILED = frozenset({"failed"})

#: 처리를 마친 것. 요약·안건·사안이 있으면 그게 진짜 결과입니다.
_PROCESSED = frozenset({"needs_review", "confirmed"})

#: 상태 → 보고서에 적을 한 줄.
#:
#: ⚠️ **`MEETING_STATUS_LABEL` 의 두 번째 벌이 아닙니다.** 저쪽은 상태마다
#: 이름을 붙이는 표이고(화면용), 여기는 읽는 사람이 이 문서를 얼마나 믿을 수
#: 있는지를 세 갈래로 답합니다. 목적이 다르므로 값도 다릅니다.
#:
#: ⚠️ 조용히 어느 쪽으로도 안 떨어지게 **세 집합이 상태 전부를 덮는지**
#: 테스트가 봅니다. 새 상태가 생겼는데 분류를 안 하면, 처리에 실패한 회의가
#: "처리를 마쳤습니다" 로 나갈 수 있습니다 — 보고서에서 그건 거짓말입니다.
_STATE_LINE = {
    "unprocessed": "아직 처리하지 않았습니다",
    "failed": "처리하다 실패했습니다 — 다시 처리해야 합니다",
    "processed": "처리를 마쳤습니다",
}


def state_of(status: str) -> str:
    """이 회의가 처리 면에서 **어디에 있는가**. 셋 중 하나."""
    if status in _UNPROCESSED:
        return "unprocessed"
    if status in _FAILED:
        return "failed"
    if status in _PROCESSED:
        return "processed"
    # 모르는 상태를 조용히 "마쳤다" 로 세지 않습니다. 모르면 모른다고 합니다.
    return "unknown"


#: 녹음 방식 → 사람 말.
#:
#: ⚠️ 모르는 값은 **그대로 돌려줍니다.** 이 저장소의 `describeMeetingStatus`
#: 가 쓰는 것과 같은 규칙입니다 — 없는 이름을 지어내는 것보다 낫습니다.
_CAPTURE_LABEL = {"multitrack": "사람마다 따로 녹음 (트랙이 곧 사람)"}


def meeting_when(
    started_at: datetime | None, scheduled_at: datetime | None
) -> tuple[datetime | None, bool]:
    """이 회의는 **언제인가** — `(시각, 예정인가)`.

    ## ⚠️ 같은 규칙이 두 벌입니다 (결함 358)

    화면 쪽은 `frontend/src/lib/home/next.ts` 의 `meetingWhen` 입니다.
    보고서는 **기록**이라 만든 순간의 글자를 저장하므로 서버가 문장을
    만들어야 하고, 그래서 이 규칙이 파이썬에도 있어야 합니다.

    두 벌을 **알고** 둡니다 — `meeting_when_cases.json` 을 두 검사가 같이
    읽습니다. 한쪽만 고치면 **양쪽 다** 빨개집니다 (결함 345 의 방법).

    ⚠️ **둘 다 없으면 시각을 지어내지 않습니다.** 그때만 「못 잼」입니다.
    """
    if started_at is not None:
        return started_at, False
    # ⚠️ **둘 다 없어도 `planned` 는 참입니다.** 화면 쪽 `meetingWhen` 이
    #    그렇습니다 — 그 값의 뜻이 「예정 시각이 있다」가 아니라 **「아직 안
    #    연 회의인가」**이기 때문입니다. 시각이 없으면 두 자리 다 그 값을
    #    안 읽으므로(화면은 `—`, 회의록은 gap) 눈에 보이지는 않지만,
    #    **두 벌이 같은 답을 내야** 짝 검사가 뜻을 갖습니다.
    return scheduled_at, True


def build(data: MinutesInput) -> dict[str, Any]:
    """회의록 내용을 만든다. 순수 함수 — 데이터베이스를 모릅니다."""
    state = state_of(data.status)
    unprocessed = state == "unprocessed"

    # ⛔ 예전에는 `f"{data.started_at:%Y-%m-%d %H:%M}"` 였습니다 (결함 290).
    #    서버가 들고 있는 값은 UTC 라, 같은 회의를 화면은 19:00 · 문서는
    #    10:00 이라고 했습니다. 밖으로 나가는 쪽이 틀린 것이 더 나쁩니다.
    #
    # ⛔ 그리고 `started_at` **하나만** 봤습니다 (결함 358). 화면 쪽은
    #    결함 287 이 「화면마다 `started_at ?? scheduled_at` 를 적으면
    #    한쪽만 고쳐집니다」라고 적고 `meetingWhen` 한 벌로 모았는데,
    #    보고서 builder 가 그 표에 안 들어가 있었습니다.
    at, planned = meeting_when(data.started_at, data.scheduled_at)
    when = f"{clock.local_time(at):%Y-%m-%d %H:%M}" if at is not None else None
    # 「예정」은 홈이 쓰는 말과 같습니다 (`describeMeetingWhen`).
    if when is not None and planned:
        when = f"예정 {when}"
    body: list[dict[str, Any]] = [
        blocks.facts(
            [
                blocks.fact(
                    "일시",
                    when or "",
                    gap=when is None,
                    note="" if when else "연 시각도 잡아 둔 시각도 없습니다",
                ),
                # ⚠️ 여기에 `processing` 같은 **식별자를 그대로 적지 않습니다.**
                #    보고서는 밖으로 나가는 문서입니다 — 받는 사람에게 영어
                #    식별자는 아무 뜻이 없고, 있어 보이기만 합니다.
                # ⚠️ `gap=True` 를 주지 않습니다. 이건 **못 잰 값이 아니라
                #    사실**입니다 — 값이 있는데 gap 을 주면 글자로 복사할 때
                #    문장이 "못 쟀습니다" 로 바뀝니다 (`blocks.fact` 참고).
                blocks.fact("처리", _STATE_LINE.get(state, data.status)),
                blocks.fact(
                    "녹음 방식",
                    _CAPTURE_LABEL.get(data.capture_mode, data.capture_mode),
                ),
            ]
        )
    ]

    # ── 요약 ──────────────────────────────────────────────
    body.append(blocks.heading("요약"))
    if data.summary:
        body.append(blocks.paragraph(data.summary))
    elif unprocessed:
        body.append(blocks.gap("아직 회의를 처리하지 않아 요약이 없습니다."))
    else:
        body.append(blocks.gap("요약을 만들지 못했습니다."))

    # ── 다음 안건 ─────────────────────────────────────────
    body.append(blocks.heading("다음 안건"))
    body.append(
        blocks.bullets(
            data.next_agenda,
            empty_note=(
                "아직 회의를 처리하지 않았습니다."
                if unprocessed
                else "다음 안건으로 잡힌 것이 없습니다."
            ),
        )
    )

    # ── 미해결 사안 ───────────────────────────────────────
    body.append(blocks.heading("미해결 사안"))
    body.append(
        blocks.bullets(
            [
                f"{issue.content} (근거 {issue.evidence_count}건)"
                if issue.evidence_count
                else issue.content
                for issue in data.unresolved
            ],
            empty_note=(
                "아직 회의를 처리하지 않았습니다."
                if unprocessed
                else "미해결로 남은 사안이 없습니다."
            ),
        )
    )

    # ── 업무 후보 ─────────────────────────────────────────
    #
    # ⚠️ 여기가 이 제품의 대표 주장이 지나가는 자리입니다 — 회의에서 정한
    #    일이 칸반으로 갑니다. 그래서 후보만 적지 않고 **사람이 무엇을
    #    정했는지**까지 적습니다. 아직 안 정한 것도 그대로 적습니다.
    body.append(blocks.heading("업무 후보"))
    body.append(
        blocks.bullets(
            [
                f"{c.title} — {_DECISION_LABEL.get(c.decision, c.decision)}"
                for c in data.candidates
            ],
            empty_note=(
                "아직 회의를 처리하지 않았습니다."
                if unprocessed
                else "회의에서 뽑힌 업무 후보가 없습니다."
            ),
        )
    )

    # ── 못 잰 것 ──────────────────────────────────────────
    #
    # ⚠️ 끊긴 트랙은 고장도 잘못도 아니라 **"이 구간은 잴 수 없었다"** 입니다.
    #    회의록에 안 적으면 나중에 기여도에서 왜 구간이 넓은지 아무도 모릅니다.
    if data.tracks_broken:
        body.append(
            blocks.gap(
                f"트랙 {data.tracks_total}개 중 {data.tracks_broken}개가 온전하지 "
                "않습니다. 그 사람의 그 구간은 잴 수 없었습니다 — 말을 안 한 것과 "
                "다릅니다."
            )
        )

    return {
        "schema": SCHEMA_VERSION,
        "report_type": str(ReportType.MEETING_MINUTES),
        "title": f"회의록 — {data.meeting_title}",
        # ⚠️ 회의록에는 팀 경고를 안 붙입니다. 사람별 수치가 없으니 붙이면
        #    "여기 비교할 것이 있다" 는 잘못된 신호가 됩니다.
        "notices": [],
        "blocks": body,
    }
