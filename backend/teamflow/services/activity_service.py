"""활동 기록 — `audit_logs` 를 **읽는** 쪽 (요구사항 정의서 §21 ACTIVITY-001).

## ⚠️ 이 파일이 생긴 이유

`audit_logs` 에는 **쓰는 곳이 열한 곳**이었고 **읽는 곳이 0곳**이었습니다.
기여도 가중치를 바꾼 것, AI 출력을 사람이 고친 것, 점수를 조정한 것,
오디오를 지운 것 — 전부 성실하게 쌓이고 있었는데 **볼 방법이 없었습니다.**

이 저장소가 대표 실패 ① 로 적어 둔 그것입니다 — "만들어 놓고 아무도
안 부름". 오류가 안 나니 아무도 몰랐고, `docs/20` 이 대조하다가
발견했습니다.

## ⚠️ 기록을 **고치거나 지우는 함수가 여기 없습니다**

감사 기록은 "누가 언제 무엇을 바꿨나" 를 나중에 확인하기 위한 것입니다.
고칠 수 있으면 그 목적이 통째로 사라집니다. 이 모듈은 읽기만 합니다.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from teamflow.clock import as_utc
from teamflow.db import models as m

#: 한 번에 돌려주는 최대 건수. 없으면 프로젝트 한 해치가 한 번에 옵니다.
MAX_ITEMS = 100

#: 행동 → 사람 말.
#:
#: ⚠️ **여기가 유일한 표입니다.** 화면이 자기 표를 만들면 두 벌이 되고,
#: 새 행동이 생겼을 때 한쪽만 고쳐집니다.
#:
#: ⚠️ 모르는 행동은 **원문 그대로** 내보냅니다. 그럴듯한 한국어를
#: 지어내면 읽는 사람이 틀린 뜻으로 믿습니다 — 감사 기록에서 그건
#: 특히 나쁩니다.
ACTION_LABEL: dict[str, str] = {
    "ai_output_corrected": "AI 결과를 사람이 고침",
    "audio_deleted": "오디오 원본 삭제",
    "candidate_approved": "업무 후보 승인",
    "candidate_rejected": "업무 후보 거절",
    "github_login_changed": "GitHub 계정 연결 변경",
    "meeting_reprocess_requested": "회의 재처리 요청",
    "score_adjusted": "기여도 확정값 조정",
    "task_completed": "업무 완료",
    "task_deleted": "업무 삭제",
    "task_reopened": "업무 다시 열기",
    "user_data_revoked": "개인 정보 파기",
    "voiceprint_revoked": "성문 폐기",
    "weights_changed": "역할 비중 변경",
}

#: ⚠️ **사람의 기여 숫자를 바꾼** 행동. 화면이 눈에 띄게 그릴 근거입니다.
#:
#: 이 제품에서 가장 되짚어 볼 일이 많은 기록입니다 — 누가 점수를
#: 조정했는지, 누가 가중치를 바꿨는지는 분쟁이 생겼을 때 제일 먼저
#: 확인할 것입니다.
TOUCHES_CONTRIBUTION: frozenset[str] = frozenset(
    {"score_adjusted", "weights_changed", "ai_output_corrected"}
)


def describe(action: str) -> str:
    """행동을 사람 말로. ⚠️ 모르는 것은 지어내지 않습니다."""
    return ACTION_LABEL.get(action, action)


@dataclass(frozen=True, slots=True)
class Entry:
    id: int
    at: datetime
    action: str
    label: str
    #: 한 사람. 없을 수 있습니다 — 시스템이 한 일(보존기간 만료 삭제)입니다.
    #: ⚠️ **"알 수 없음" 같은 글자를 여기서 만들지 않습니다.** 그건 화면이
    #: 할 말이고, 여기서 만들면 그 말이 두 벌이 됩니다.
    who: str | None
    target: str
    #: 기여 숫자를 건드린 기록인가.
    touches_contribution: bool


def recent(session: Session, project_id: int, *, limit: int = MAX_ITEMS) -> list[Entry]:
    """이 프로젝트의 활동 기록. **최근 것부터.**

    ⚠️ 오래된 것부터 두면 기록이 쌓일수록 방금 일어난 일이 아래로 밀립니다
    (`list_project_meetings` 가 같은 이유로 같은 결정을 했습니다).
    """
    capped = max(1, min(int(limit), MAX_ITEMS))
    rows = session.execute(
        select(m.AuditLog, m.User.name)
        .outerjoin(m.User, m.User.id == m.AuditLog.actor_id)
        .where(m.AuditLog.project_id == project_id)
        .order_by(m.AuditLog.id.desc())
        .limit(capped)
    ).all()

    return [
        Entry(
            id=row.id,
            at=as_utc(row.at),
            action=row.action,
            label=describe(row.action),
            who=who,
            target=row.target or "",
            touches_contribution=row.action in TOUCHES_CONTRIBUTION,
        )
        for row, who in rows
    ]
