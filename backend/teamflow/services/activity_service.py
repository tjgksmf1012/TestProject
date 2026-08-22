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

import re
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from teamflow.clock import as_utc
from teamflow.db import live
from teamflow.db import models as m
from teamflow.services.naming import meeting_label

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
    "task_assignees_changed": "업무 담당자 변경",
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
#: ⚠️ 담당자 변경이 여기 있는 이유: 업무를 **끝내기 전에** 담당자를 바꾸면
#: 그 업무의 완료 점수가 갈 사람이 바뀝니다 (`TASK-006`). 끝난 뒤에 바꾸면
#: 이미 쌓인 이벤트는 그대로라 점수가 안 움직이는데, 감사 로그는 둘을
#: 구분할 수 없습니다. **눈에 띄는 쪽으로 틀립니다** — 안 보이는 것보다
#: 한 번 더 보이는 것이 낫습니다.
TOUCHES_CONTRIBUTION: frozenset[str] = frozenset(
    {
        "score_adjusted",
        "weights_changed",
        "ai_output_corrected",
        "task_assignees_changed",
    }
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
    #: 기계가 가리키는 자리. `task:4` · `members/1` 처럼 **안 변하는 참조**라
    #: 감사 기록의 값 그대로입니다. 화면에 그대로 그리면 안 됩니다.
    target: str
    #: 사람이 읽을 이름 (결함 293).
    #:
    #: ⚠️ 화면이 `target` 을 그대로 그리고 있었습니다. 활동 기록은 스스로
    #: 「누가 언제 **무엇을** 바꿨는지」라고 말하는데, 「누가」와 「언제」는
    #: 맞고 **「무엇」만 `task:4`** 였습니다 — 그 업무 이름은 「접근성
    #: 점검」이고, `members/1` 은 「김민수」입니다.
    #:
    #: ⚠️ **못 찾으면 지어내지 않습니다.** 지운 업무·모르는 종류는 `target`
    #: 을 그대로 돌려줍니다 — 지어낸 한국어보다 식별자가 정직합니다
    #: (`describe_category`·`role_label` 과 같은 규칙).
    target_label: str
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

    labels = _target_labels(session, [row.target or "" for row, _ in rows])

    return [
        Entry(
            id=row.id,
            at=as_utc(row.at),
            action=row.action,
            label=describe(row.action),
            who=who,
            target=row.target or "",
            target_label=labels.get(row.target or "", row.target or ""),
            touches_contribution=row.action in TOUCHES_CONTRIBUTION,
        )
        for row, who in rows
    ]


#: `종류/번호` 또는 `종류:번호`. ⚠️ 이 저장소는 두 구분자를 **둘 다** 씁니다
#: (`task:4` · `members/1`) — 하나만 보면 절반을 못 읽습니다.
_TARGET = re.compile(r"^(?P<kind>[a-z_]+)[/:](?P<id>\d+)$")

#: `final_contributions/3:7` — **번호가 둘**입니다 (프로젝트:사람).
#: ⚠️ 위 정규식은 이 모양을 아예 못 읽습니다. 하나짜리 자로 재면 이
#: 기록만 통째로 이름 없이 나갑니다 — 하필 「기여도 확정값 조정」,
#: 분쟁에서 제일 먼저 볼 줄입니다.
_PAIR_TARGET = re.compile(r"^(?P<kind>[a-z_]+)/(?P<left>\d+):(?P<right>\d+)$")

#: 이름을 찾아 줄 수 있는 종류. ⚠️ **감사 기록에 쓰이는 종류와 짝**이어야
#: 합니다 — `test_activity_target_kinds` 가 백엔드에서 `target=` 을 쓰는
#: 곳을 전부 걷어서 여기 있는지 봅니다.
#:
#: 결함 293 은 씨앗 데이터에 있던 넷만 고쳤고, 실제로 「업무 후보 승인」을
#: 눌러 보니 다섯째(`meeting_task_candidates`)가 식별자 그대로 나왔습니다
#: (결함 297). 종류를 하나씩 더하는 대신 **짝을 재는 가드**를 뒀습니다.
KNOWN_TARGET_KINDS: frozenset[str] = frozenset(
    {
        "task",
        "members",
        "users",
        "meetings",
        "meeting_task_candidates",
        "final_contributions",
        "audio_assets",
        "voiceprints",
    }
)


def _target_labels(session: Session, targets: list[str]) -> dict[str, str]:
    """`task:4` → 「접근성 점검」. **한 번에** 찾습니다 (줄마다 질의 금지).

    ⚠️ 못 찾은 것은 **넣지 않습니다.** 부르는 쪽이 원래 값을 그대로 씁니다 —
    지운 업무를 「(없음)」 이라고 적으면 그건 지어낸 말이고, 감사 기록에서
    지어낸 말은 제일 나쁩니다.
    """
    by_kind: dict[str, set[int]] = {}
    for raw in targets:
        hit = _TARGET.match(raw)
        if hit is not None:
            by_kind.setdefault(hit["kind"], set()).add(int(hit["id"]))

    out: dict[str, str] = {}

    def _fill(kind: str, rows: list[tuple[int, str]]) -> None:
        found = dict(rows)
        for raw in targets:
            hit = _TARGET.match(raw)
            if hit is None or hit["kind"] != kind:
                continue
            name = found.get(int(hit["id"]))
            if name:
                out[raw] = name

    task_ids = by_kind.get("task", set())
    if task_ids:
        # ⚠️ **지운 업무는 이름이 안 나옵니다** — `db/live.py` 한 곳을
        #    거칩니다 (`TASK-003`). 이름이 없으면 `target` 이 그대로 남고,
        #    그건 「그 업무는 지워졌다」는 정직한 답입니다. 여기서 조건을
        #    직접 적으면 다음 사람이 빠뜨립니다.
        _fill("task", list(session.execute(
            select(m.Task.id, m.Task.title)
            .where(m.Task.id.in_(task_ids), live.not_deleted())
        ).all()))

    # ⚠️ `members/1` 과 `users/1` 은 **같은 사람**을 다르게 가리킵니다
    #    (한쪽은 프로젝트 구성원, 한쪽은 계정 삭제 기록). 한 번에 찾습니다.
    people_ids = by_kind.get("members", set()) | by_kind.get("users", set())
    if people_ids:
        people = list(session.execute(
            select(m.User.id, m.User.name).where(m.User.id.in_(people_ids))
        ).all())
        _fill("members", people)
        _fill("users", people)

    meeting_ids = by_kind.get("meetings", set())
    if meeting_ids:
        # 회의 이름은 한 벌에서 옵니다 (결함 285) — 제목이 없는 회의도
        # 「제목 없는 회의 #4」로 부릅니다.
        _fill("meetings", [
            (mid, meeting_label(title, mid))
            for mid, title in session.execute(
                select(m.Meeting.id, m.Meeting.title).where(m.Meeting.id.in_(meeting_ids))
            ).all()
        ])

    # ⭐ 업무 후보 — 「업무 후보 승인」·「거절」·「AI 결과를 사람이 고침」
    #    셋이 이 종류를 가리킵니다 (결함 297). 셋 다 사람이 AI 의 판단을
    #    뒤집은 기록이라, 무엇을 뒤집었는지가 안 보이면 읽을 수가 없습니다.
    candidate_ids = by_kind.get("meeting_task_candidates", set())
    if candidate_ids:
        _fill("meeting_task_candidates", list(session.execute(
            select(m.MeetingTaskCandidate.id, m.MeetingTaskCandidate.title)
            .where(m.MeetingTaskCandidate.id.in_(candidate_ids))
        ).all()))

    # 녹음 — 어느 회의의 것인가. ⚠️ 지운 뒤에도 행은 남습니다
    #    (`deleted_at` 만 찍습니다) 그래서 이름을 찾을 수 있습니다.
    asset_ids = by_kind.get("audio_assets", set())
    if asset_ids:
        _fill("audio_assets", [
            (aid, f"{meeting_label(title, mid)}의 녹음")
            for aid, mid, title in session.execute(
                select(m.AudioAsset.id, m.Meeting.id, m.Meeting.title)
                .join(m.Meeting, m.Meeting.id == m.AudioAsset.meeting_id)
                .where(m.AudioAsset.id.in_(asset_ids))
            ).all()
        ])

    # 성문 — 누구의 것인가. ⚠️ 폐기는 임베딩만 비우고 행은 남깁니다.
    print_ids = by_kind.get("voiceprints", set())
    if print_ids:
        _fill("voiceprints", [
            (vid, f"{name}의 성문")
            for vid, name in session.execute(
                select(m.Voiceprint.id, m.User.name)
                .join(m.User, m.User.id == m.Voiceprint.user_id)
                .where(m.Voiceprint.id.in_(print_ids))
            ).all()
        ])

    # ⭐ `final_contributions/3:7` — 번호가 둘이라 위 자로는 안 읽힙니다.
    #    가리키는 것은 **그 사람의 확정 기여도**입니다.
    pairs = [(raw, hit) for raw in targets if (hit := _PAIR_TARGET.match(raw)) is not None]
    user_ids = {
        int(hit["right"]) for _, hit in pairs if hit["kind"] == "final_contributions"
    }
    if user_ids:
        names = dict(session.execute(
            select(m.User.id, m.User.name).where(m.User.id.in_(user_ids))
        ).all())
        for raw, hit in pairs:
            if hit["kind"] != "final_contributions":
                continue
            name = names.get(int(hit["right"]))
            if name:
                out[raw] = f"{name}의 확정 기여도"

    return out
