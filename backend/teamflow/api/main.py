"""FastAPI 애플리케이션.

docs/03-시스템-아키텍처.md §1 — Spring Boot 없이 FastAPI 단일 백엔드.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from teamflow.config import Settings, get_settings, safe_dump
from teamflow.db import models as m
from teamflow.db.session import get_db
from teamflow.github import webhook as gh
from teamflow.meeting.approval import ApprovalRequest
from teamflow.services import approval_service

app = FastAPI(
    title="TeamFlow AI",
    description="회의에서 나온 결정을 실제 업무와 코드 활동까지 연결한다",
    version="0.1.0",
)

DbSession = Annotated[Session, Depends(get_db)]
AppSettings = Annotated[Settings, Depends(get_settings)]


# ══════════════════════════════════════════════════════════════
# 헬스체크
# ══════════════════════════════════════════════════════════════


@app.get("/health")
def health(settings: AppSettings) -> dict[str, Any]:
    # safe_dump 를 쓴다 — 시크릿이 헬스체크로 새는 사고가 흔하다
    return {"status": "ok", **safe_dump(settings)}


# ══════════════════════════════════════════════════════════════
# 회의 업무 후보 검토
# ══════════════════════════════════════════════════════════════


class CandidateOut(BaseModel):
    id: int
    title: str
    assignee_id: int | None
    deadline: date | None
    confidence: float
    evidence_utterance_ids: list[int]
    review_status: str

    @property
    def is_complete(self) -> bool:
        return self.assignee_id is not None and self.deadline is not None


class ReviewItem(BaseModel):
    candidate_id: int
    approve: bool
    title_override: str | None = None
    assignee_override: int | None = None
    deadline_override: date | None = None
    note: str | None = None


class ReviewPayload(BaseModel):
    reviewer_id: int = Field(gt=0)
    items: list[ReviewItem] = Field(min_length=1)


class ReviewResult(BaseModel):
    approved_task_ids: list[int]
    approved_count: int
    failures: dict[int, list[str]]


def _load_meeting(session: Session, meeting_id: int) -> m.Meeting:
    meeting = session.get(m.Meeting, meeting_id)
    if meeting is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "회의를 찾을 수 없습니다")
    return meeting


@app.get("/api/meetings/{meeting_id}/candidates", response_model=list[CandidateOut])
def list_candidates(meeting_id: int, session: DbSession) -> list[CandidateOut]:
    """검토 대기 중인 업무 후보. 확신도가 낮은 것부터 나온다."""
    _load_meeting(session, meeting_id)
    rows = approval_service.pending_candidates(session, meeting_id)
    return [
        CandidateOut(
            id=r.id,
            title=r.title,
            assignee_id=r.assignee_id,
            deadline=r.deadline.date() if isinstance(r.deadline, datetime) else r.deadline,
            confidence=float(r.confidence),
            evidence_utterance_ids=list(r.evidence_utterance_ids or []),
            review_status=r.review_status,
        )
        for r in rows
    ]


@app.post("/api/meetings/{meeting_id}/candidates/review", response_model=ReviewResult)
def review(meeting_id: int, payload: ReviewPayload, session: DbSession) -> ReviewResult:
    """후보 승인/거절.

    **승인된 것만 칸반에 등록된다.** AI가 만든 업무가 사람을 거치지 않고
    tasks 로 가는 경로는 존재하지 않는다.
    """
    meeting = _load_meeting(session, meeting_id)

    requests = [
        ApprovalRequest(
            candidate_id=item.candidate_id,
            reviewer_id=payload.reviewer_id,
            approve=item.approve,
            title_override=item.title_override,
            assignee_override=item.assignee_override,
            deadline_override=item.deadline_override,
            note=item.note,
        )
        for item in payload.items
    ]

    outcome = approval_service.review_candidates(
        session,
        project_id=meeting.project_id,
        meeting_id=meeting_id,
        requests=requests,
    )

    task_ids = session.scalars(
        select(m.Task.id).where(
            m.Task.origin_candidate_id.in_([t.origin_candidate_id for t in outcome.approved])
        )
    ).all() if outcome.approved else []

    return ReviewResult(
        approved_task_ids=list(task_ids),
        approved_count=len(outcome.approved),
        failures={cid: [e.value for e in errs] for cid, errs in outcome.failures.items()},
    )


# ══════════════════════════════════════════════════════════════
# GitHub 웹훅
# ══════════════════════════════════════════════════════════════


@app.post("/api/github/webhook", status_code=status.HTTP_202_ACCEPTED)
async def github_webhook(
    request: Request,
    session: DbSession,
    settings: AppSettings,
    x_github_event: Annotated[str | None, Header()] = None,
    x_github_delivery: Annotated[str | None, Header()] = None,
    x_hub_signature_256: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    """GitHub 웹훅 수신.

    서명 검증이 첫 번째 관문이다. 이게 없으면 누구나
    "내가 PR 50개를 병합했다"고 POST 할 수 있다.
    """
    body = await request.body()

    try:
        gh.verify_signature(body, x_hub_signature_256, settings.require_webhook_secret())
    except gh.WebhookError as exc:
        # 401. 무엇이 틀렸는지 자세히 알려주지 않는다.
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "서명 검증 실패") from exc
    except RuntimeError as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "웹훅이 설정되지 않았습니다"
        ) from exc

    if not x_github_event or not x_github_delivery:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "필수 헤더가 없습니다")

    payload = await request.json()
    normalized = gh.normalize(x_github_event, x_github_delivery, payload)
    if normalized is None:
        return {"status": "ignored", "event": x_github_event}

    project = session.scalar(
        select(m.Project).where(m.Project.github_repo == normalized.repo)
    )
    if project is None:
        # 연결되지 않은 저장소. 조용히 무시한다 — 존재 여부를 알려주지 않는다.
        return {"status": "ignored", "reason": "unlinked_repo"}

    # 중복 방어. 웹훅은 재전송되고 백필과 겹칠 수 있다.
    exists = session.scalar(
        select(m.GithubEvent.id).where(
            m.GithubEvent.repo == normalized.repo,
            m.GithubEvent.event_type == normalized.event_type,
            m.GithubEvent.delivery_id == normalized.delivery_id,
        )
    )
    if exists:
        return {"status": "duplicate", "event_id": exists}

    actor_user_id = session.scalar(
        select(m.Member.user_id).where(
            m.Member.project_id == project.id,
            m.Member.github_login == normalized.actor_login,
        )
    )

    row = m.GithubEvent(
        project_id=project.id,
        delivery_id=normalized.delivery_id,
        repo=normalized.repo,
        event_type=normalized.event_type,
        actor_login=normalized.actor_login,
        actor_user_id=actor_user_id,
        ref=normalized.ref,
        payload=normalized.payload,
        occurred_at=normalized.occurred_at,
    )
    session.add(row)
    session.flush()

    return {
        "status": "accepted",
        "event_id": row.id,
        "event_type": normalized.event_type,
        "linked_user": actor_user_id,
    }


# ══════════════════════════════════════════════════════════════
# 기여도
# ══════════════════════════════════════════════════════════════


class CategoryOut(BaseModel):
    category: str
    raw: float
    team_share: float
    weight: float
    event_count: int
    evidence_ids: list[int]


class MemberScoreOut(BaseModel):
    user_id: int
    role: str
    share: float
    range_low: float
    range_high: float
    confidence: float
    confidence_label: str
    confidence_reasons: list[str]
    categories: list[CategoryOut]
    integrity_flags: list[dict[str, Any]]


class ScoreOut(BaseModel):
    algo_version: str
    computed_at: datetime
    members: list[MemberScoreOut]
    skipped_categories: list[str]
    # ⚠️ 순위는 의도적으로 제공하지 않는다. docs/07 E2
    notice: str = (
        "이 수치는 활동 기록에 기반한 참고값입니다. 최종 기여도는 팀이 합의하여 확정합니다."
    )


@app.get("/api/projects/{project_id}/contributions", response_model=ScoreOut)
def contributions(project_id: int, session: DbSession, settings: AppSettings) -> ScoreOut:
    """기여도 조회.

    저장된 점수를 읽는 게 아니라 **이벤트 로그에서 매번 재계산한다.**
    그래야 가중치를 바꿔도 과거가 오염되지 않고, 모든 숫자에 근거가 붙는다.
    docs/05 §1
    """
    from teamflow.services import scoring_service

    result = scoring_service.compute(session, project_id)
    return ScoreOut(
        algo_version=settings.scoring_algo_version,
        computed_at=datetime.now(UTC),
        members=[
            MemberScoreOut(
                user_id=ms.user_id,
                role=ms.role,
                share=round(ms.share, 2),
                range_low=round(ms.range_low, 2),
                range_high=round(ms.range_high, 2),
                confidence=round(ms.confidence.value, 3),
                confidence_label=ms.confidence.label,
                confidence_reasons=ms.confidence.reasons,
                categories=[
                    CategoryOut(
                        category=cs.category.value,
                        raw=round(cs.raw, 3),
                        team_share=round(cs.team_share, 4),
                        weight=round(cs.weight, 4),
                        event_count=cs.event_count,
                        evidence_ids=cs.evidence_ids,
                    )
                    for cs in ms.categories.values()
                ],
                integrity_flags=[
                    {"code": f.code, "message": f.message, "detail": f.detail}
                    for f in ms.integrity_flags
                ],
            )
            for ms in result.members.values()
        ],
        skipped_categories=[c.value for c in result.skipped_categories],
    )
