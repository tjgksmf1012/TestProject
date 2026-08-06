"""FastAPI 애플리케이션.

docs/03-시스템-아키텍처.md §1 — Spring Boot 없이 FastAPI 단일 백엔드.
"""

from __future__ import annotations

import logging
import re
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response, status
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import event, func, select
from sqlalchemy.orm import Session

from teamflow.audio.chunk_store import ChunkStore
from teamflow.auth import passwords
from teamflow.config import Settings, get_settings, safe_dump
from teamflow.db import models as m
from teamflow.db.session import get_db
from teamflow.github import webhook as gh
from teamflow.logging_config import configure_logging
from teamflow.meeting.approval import ApprovalRequest
from teamflow.projects import invites
from teamflow.services import (
    approval_service,
    auth_service,
    recording_service,
    task_service,
)
from teamflow.tasks import dispatch

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncIterator[None]:
    """서버가 실제로 뜰 때 로깅을 설정한다.

    import 시점이 아니라 여기서 하는 이유: 이 모듈을 import 하는 것만으로
    프로세스 전체의 로깅을 갈아엎으면, 이 앱을 라이브러리처럼 가져다 쓰는
    쪽(테스트·스크립트)의 로깅까지 우리 마음대로 바꾸게 된다.

    uvicorn 은 자기 로깅 설정을 **먼저** 적용하고 그 다음에 lifespan 을
    돌린다. 그래서 여기서 덮어써야 우리 형식이 남는다.
    """
    configure_logging()
    settings = get_settings()
    logger.info(
        "TeamFlow API 시작 — env=%s asr=%s llm=%s",
        settings.environment,
        settings.asr_backend,
        settings.llm_backend,
    )
    yield


app = FastAPI(
    title="TeamFlow AI",
    description="회의에서 나온 결정을 실제 업무와 코드 활동까지 연결한다",
    version="0.1.0",
    lifespan=lifespan,
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
# 시각 동기화
# ══════════════════════════════════════════════════════════════
#
# 멀티트랙 녹음은 팀원 각자의 폰이 개별 트랙을 만든다. 기기 시계가 서로
# 다르면 트랙 정렬이 GCC-PHAT 탐색창(±500ms) 밖으로 나가 정렬 자체가 실패한다.
#
# NTP 와 같은 방식으로 왕복을 재려면 서버가 **받은 시각과 보낸 시각**을
# 둘 다 알려줘야 한다. 그래야 클라이언트가 서버 처리 시간을 왕복에서 빼고
# 순수 네트워크 지연만 남길 수 있다.
#   → frontend/src/lib/recording/clock.ts


class ServerTime(BaseModel):
    """epoch 밀리초. 클라이언트는 이 둘로 오차 상한을 계산한다."""

    t1: int = Field(description="서버가 요청을 받은 시각")
    t2: int = Field(description="서버가 응답을 보낸 시각")


@app.get("/api/time", response_model=ServerTime)
def server_time(response: Response) -> ServerTime:
    t1 = time.time_ns() // 1_000_000
    # 여기서 아무것도 하지 않는 게 중요하다. DB 를 건드리거나 로그를 쓰면
    # 그 시간이 t2-t1 로 잡히고, 지연이 큰 표본으로 보여 버려진다.
    t2 = time.time_ns() // 1_000_000
    # 캐시되면 동기화가 통째로 무의미해진다. 프록시가 끼어도 막는다.
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    return ServerTime(t1=t1, t2=t2)


# ══════════════════════════════════════════════════════════════
# 인증
# ══════════════════════════════════════════════════════════════
#
# 이 구간이 생기기 전까지 서버는 **요청 본문에 적힌 `user_id` 를 그대로
# 믿었습니다.** 누구나 남의 번호를 적어 동의를 제출하고, 남의 트랙에
# 오디오를 올리고, 남의 이름으로 업무를 승인할 수 있었습니다. 기여도를
# 산정하는 시스템에서 그건 기능 하나가 빠진 게 아니라 **산출물 전체가
# 근거를 잃는** 문제입니다.
#
# 범위는 최소입니다 — 이메일·비밀번호 로그인과 세션 쿠키까지. 비밀번호
# 재설정·이메일 인증·OAuth·권한 등급은 넣지 않았습니다.


class SignupIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    email: str = Field(min_length=3, max_length=255)
    password: str


class LoginIn(BaseModel):
    email: str
    password: str


class MeOut(BaseModel):
    user_id: int
    name: str
    email: str


def _set_session_cookie(response: Response, token: str, settings: Settings) -> None:
    response.set_cookie(
        auth_service.COOKIE_NAME,
        token,
        max_age=auth_service.SESSION_DAYS * 24 * 3600,
        # httponly: 스크립트가 토큰을 읽지 못하게 합니다. 이 앱은 회의
        # 발화에서 뽑은 LLM 출력을 화면에 그리므로, XSS 가 하나라도 남아
        # 있으면 토큰이 곧바로 새어 나갑니다.
        httponly=True,
        # samesite=lax: 다른 사이트에서 온 POST 에는 쿠키가 실리지 않습니다.
        # 이 앱은 API 와 화면이 같은 오리진이라 이것으로 CSRF 가 막힙니다.
        samesite="lax",
        # 운영에서는 HTTPS 로만 보냅니다. 개발에서 True 로 두면 localhost
        # (http) 에서 쿠키가 아예 저장되지 않아 로그인이 안 됩니다.
        secure=settings.is_production,
        path="/",
    )


@app.post("/api/auth/signup", response_model=MeOut, status_code=status.HTTP_201_CREATED)
def signup(
    payload: SignupIn, response: Response, session: DbSession, settings: AppSettings
) -> MeOut:
    """가입하고 곧바로 로그인 상태가 됩니다."""
    try:
        user = auth_service.register(
            session, name=payload.name, email=payload.email, password=payload.password
        )
    except auth_service.EmailTaken as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except passwords.WeakPassword as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    token, _ = auth_service.issue_session(session, user_id=user.id)
    _set_session_cookie(response, token, settings)
    return MeOut(user_id=user.id, name=user.name, email=user.email)


@app.post("/api/auth/login", response_model=MeOut)
def login(
    payload: LoginIn,
    request: Request,
    response: Response,
    session: DbSession,
    settings: AppSettings,
) -> MeOut:
    try:
        user = auth_service.authenticate(
            session, email=payload.email, password=payload.password
        )
    except auth_service.AuthError as exc:
        # 이메일이 없는 것과 비밀번호가 틀린 것을 **같은 문구**로 답합니다.
        # 구분해 주면 누가 가입돼 있는지 알아낼 수 있습니다.
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc

    token, _ = auth_service.issue_session(
        session, user_id=user.id, user_agent=request.headers.get("user-agent")
    )
    _set_session_cookie(response, token, settings)
    return MeOut(user_id=user.id, name=user.name, email=user.email)


@app.post("/api/auth/logout")
def logout(request: Request, response: Response, session: DbSession) -> dict[str, str]:
    """세션을 **서버에서** 끊습니다.

    쿠키만 지우면 토큰은 살아 있습니다. 그 토큰이 어딘가에 복사돼 있으면
    로그아웃한 줄 알고 있는 동안 남이 그 계정으로 들어옵니다.
    """
    auth_service.revoke(session, request.cookies.get(auth_service.COOKIE_NAME))
    response.delete_cookie(auth_service.COOKIE_NAME, path="/")
    return {"status": "logged_out"}


def optional_user(request: Request, session: DbSession) -> m.User | None:
    return auth_service.resolve_session(
        session, request.cookies.get(auth_service.COOKIE_NAME)
    )


def require_user(request: Request, session: DbSession) -> m.User:
    user = optional_user(request, session)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "로그인이 필요합니다")
    return user


CurrentUser = Annotated[m.User, Depends(require_user)]


@app.get("/api/auth/me", response_model=MeOut)
def read_me(user: CurrentUser) -> MeOut:
    """화면이 "나는 누구인가" 를 서버에 묻는 자리.

    이게 없던 동안 화면은 주소창의 `?me=1` 을 읽었습니다. 즉 **자기가
    누구인지 스스로 선언**했고, 서버는 그걸 그대로 믿었습니다.
    """
    return MeOut(user_id=user.id, name=user.name, email=user.email)


def _require_project_member(session: Session, project_id: int, user: m.User) -> None:
    """이 프로젝트 사람인가.

    회의 내용·기여도는 팀 내부 자료입니다. 로그인만 확인하고 통과시키면,
    가입만 하면 남의 팀 회의록을 읽을 수 있습니다.
    """
    member = session.scalars(
        select(m.Member).where(
            m.Member.project_id == project_id, m.Member.user_id == user.id
        )
    ).first()
    if member is None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "이 프로젝트의 구성원이 아닙니다"
        )


def _load_meeting_for(session: Session, meeting_id: int, user: m.User) -> m.Meeting:
    meeting = _load_meeting(session, meeting_id)
    _require_project_member(session, meeting.project_id, user)
    return meeting


# ══════════════════════════════════════════════════════════════
# 회의 업무 후보 검토
# ══════════════════════════════════════════════════════════════


class CandidateOut(BaseModel):
    id: int
    title: str
    # 회의에서 실제로 불린 이름. assignee_id 가 None 일 때 사람이
    # 누구를 골라야 할지 아는 유일한 단서다.
    assignee_hint: str | None = None
    assignee_id: int | None
    deadline: date | None
    confidence: float
    evidence_utterance_ids: list[int]
    review_status: str
    # 확신도를 깎은 이유. 숫자만으로는 무엇을 확인해야 할지 알 수 없다.
    warnings: list[str] = []

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
    # `reviewer_id` 는 없습니다. 승인은 **이 시스템에서 사람이 개입하는
    # 유일한 지점**이고, 승인된 업무는 칸반에 올라 기여도에 들어갑니다.
    # 검토자를 요청 본문으로 받으면 남의 이름으로 승인 기록이 남습니다.
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


# ══════════════════════════════════════════════════════════════
# 녹음 트랙 수집
# ══════════════════════════════════════════════════════════════
#
# frontend/src/lib/recording/ 의 서버 쪽 짝이다.
#   ① POST   …/tracks              트랙 참가 (멱등)
#   ② PUT    …/tracks/{tid}/chunks/{seq}   청크 (멱등)
#   ③ GET    …/tracks/{tid}/chunks         재개용 seq 목록
#   ④ POST   …/tracks/{tid}/complete       종료 요약


def _chunk_store(settings: Settings) -> ChunkStore:
    return ChunkStore(root=settings.audio_storage_root)


class TrackJoin(BaseModel):
    # `user_id` 는 없습니다. **트랙 = 사람**이 이 시스템의 화자 라벨 근거라,
    # 남의 번호로 트랙을 만들 수 있으면 기여도가 통째로 조작 가능해집니다.
    started_at: datetime
    device_label: str | None = Field(default=None, max_length=100)
    sample_rate: int | None = Field(default=None, gt=0)


def _enqueue_after_commit(session: Session, meeting_id: int) -> None:
    """커밋이 끝난 **뒤에** 큐에 넣는다.

    ⚠️ 순서가 뒤집히면 마지막에 녹음을 끝낸 사람의 트랙이 조용히 사라진다.

    커밋은 이 함수가 아니라 FastAPI 의존성 teardown 에서 일어난다
    (`db/session.py` 의 `session_scope` 가 yield 뒤에 commit 한다).
    그래서 엔드포인트 본문에서 바로 큐에 넣으면 **항상 커밋보다 먼저**다.

    워커가 그 사이에 도착하면 방금 `/complete` 를 호출해 큐잉을 촉발한 바로
    그 트랙이 아직 `ended_at IS NULL` 로 보인다. 그러면
    `pipeline/runtime.py` 의 `ChunkAudioLoader.load` 가

        tracks = [t for t in tracks if t.ended_at is not None]

    에서 그 트랙을 **예외도 경고도 없이** 버린다. 회의는 N-1 트랙으로 멀쩡히
    처리되고, 빠진 사람은 발화 0건 — 즉 "말을 안 한 사람" 이 된다.
    이 프로젝트가 막으려는 결과 그 자체다 (docs/05 §4.1.1).

    `after_commit` 은 커밋이 성공한 뒤에만 불린다. 롤백되면 큐에 들어가지
    않는다 — 그것도 맞는 동작이다. 없던 일이 처리될 이유가 없다.
    """

    @event.listens_for(session, "after_commit", once=True)
    def _fire(_session: Session) -> None:  # pragma: no cover - 커밋 시점에 실행된다
        dispatch.enqueue_meeting_processing(meeting_id)


def _enqueue_github_after_commit(session: Session, event_id: int) -> None:
    """커밋이 끝난 **뒤에** GitHub 수집을 큐에 넣는다.

    `_enqueue_after_commit` 과 같은 이유입니다 — 커밋은 엔드포인트 본문이
    아니라 의존성 teardown 에서 일어나므로, 본문에서 큐에 넣으면 항상
    커밋보다 먼저입니다. 워커가 그 사이에 도착하면 `GithubEvent` 행을
    찾지 못하고 `not_found` 로 끝납니다 — 예외도 로그도 없이 그 PR 의
    기여가 사라집니다.
    """

    @event.listens_for(session, "after_commit", once=True)
    def _fire(_session: Session) -> None:  # pragma: no cover - 커밋 시점에 실행된다
        dispatch.enqueue_github_ingest(event_id)


# ══════════════════════════════════════════════════════════════
# 프로젝트·회의 생성
# ══════════════════════════════════════════════════════════════
#
# 이게 없어서 지금까지 DB 를 손으로 건드리지 않으면 회의를 만들 수 없었다.
#
# ⚠️ 인증이 아직 없다. `owner_id`·`user_id` 를 요청 본문으로 받는다는 뜻이고,
# 이건 **누구나 남을 사칭할 수 있다**는 뜻이다. 시연 단계라 이렇게 두지만
# 배포 전에 반드시 세션에서 꺼내야 한다. 여기 적어 두는 이유는, 이런 것이
# 조용히 남아 있는 게 이 저장소에서 반복해서 나온 결함이기 때문이다.


class ProjectIn(BaseModel):
    """만드는 사람 자신 외에는 아무도 넣을 수 없습니다.

    ⚠️ 예전에는 `member_ids: list[int]` 를 받아 **그대로 믿었습니다.** 그건
    두 가지를 동시에 열어 놓은 것이었습니다.

      · **남을 내 팀에 강제로 넣을 수 있었습니다.** 이 시스템에서 `Member`
        행은 곧 권한입니다 — 모든 조회가 `_require_project_member` 를
        지나고, 동의 분모(`consent_status.total`)와 기여도 산정 대상이
        전부 그 표에서 나옵니다. 넣는 데 본인 동의가 필요 없다면 그
        위에 세운 접근 통제 전체가 신청제입니다. 실제로 가입만 한
        외부인이 남을 넣어 프로젝트를 만들고, 회의를 열고,
        `GET /api/meetings/{id}/members` 로 **가입자 실명**을 받아 갈 수
        있었습니다.
      · **가입자 명단을 뽑을 수 있었습니다.** 없는 id 만 골라
        `없는 사용자입니다: [4, 5, …]` 로 돌려줬으므로, 목록에서 빠진
        것이 곧 "존재하는 사용자" 였습니다. 로그인 화면이 일부러 감춘
        것을 여기서 열어 주는 셈이었습니다.

    팀원은 초대 코드로 **스스로** 들어옵니다 (`projects/invites.py`).
    """

    title: str = Field(min_length=1, max_length=200)
    github_repo: str | None = None


class ProjectOut(BaseModel):
    project_id: int
    title: str
    member_ids: list[int]
    #: 팀원에게 알려 줄 코드. 화면은 `ABCD-EFGH` 로 끊어 보여줍니다.
    invite_code: str


class ProjectSummary(BaseModel):
    project_id: int
    title: str
    member_count: int
    meeting_count: int
    #: 아직 사람이 검토하지 않은 회의 수. 0 이 아니면 할 일이 있다.
    needs_review: int


@app.get("/api/projects", response_model=list[ProjectSummary])
def list_my_projects(session: DbSession, user: CurrentUser) -> list[ProjectSummary]:
    """내가 속한 프로젝트.

    ⭐ **이게 없어서 로그인해도 갈 곳이 없었습니다.**

    `POST /api/projects` 는 있었는데 목록이 없었습니다. 그래서 화면을 열려면
    `?project=1&meeting=1` 을 주소에 직접 적어야 했고, 그 숫자를 알 방법은
    `seed_demo.py` 의 출력뿐이었습니다. 만들 수는 있는데 다시 찾을 수 없는
    상태였습니다 — 이 저장소에서 반복된 "만들어 놓고 잇지 않은" 것의
    화면 쪽 형태입니다.

    남의 프로젝트는 나오지 않습니다. 목록 자체가 권한 경계입니다.
    """
    project_ids = list(
        session.scalars(select(m.Member.project_id).where(m.Member.user_id == user.id)).all()
    )
    if not project_ids:
        return []

    projects = session.scalars(
        select(m.Project).where(m.Project.id.in_(project_ids)).order_by(m.Project.id)
    ).all()

    # 한 번에 세어 둡니다. 프로젝트마다 쿼리를 돌면 N+1 입니다.
    member_counts = dict(
        session.execute(
            select(m.Member.project_id, func.count())
            .where(m.Member.project_id.in_(project_ids))
            .group_by(m.Member.project_id)
        ).all()
    )
    meeting_rows = session.execute(
        select(m.Meeting.project_id, m.Meeting.status).where(
            m.Meeting.project_id.in_(project_ids)
        )
    ).all()

    totals: dict[int, int] = {}
    reviews: dict[int, int] = {}
    for project_id, meeting_status in meeting_rows:
        totals[project_id] = totals.get(project_id, 0) + 1
        if meeting_status == "needs_review":
            reviews[project_id] = reviews.get(project_id, 0) + 1

    return [
        ProjectSummary(
            project_id=project.id,
            title=project.title,
            member_count=member_counts.get(project.id, 0),
            meeting_count=totals.get(project.id, 0),
            needs_review=reviews.get(project.id, 0),
        )
        for project in projects
    ]


def _fresh_invite_code(session: Session, attempts: int = 8) -> str:
    """아직 안 쓰인 코드를 만든다.

    유니크 제약이 최종 방어선이지만, 충돌하면 **요청 전체가 IntegrityError**
    로 실패합니다. 30^8 에서 충돌은 사실상 안 나지만, 안 나는 것과 안 나게
    만든 것은 다릅니다.
    """
    for _ in range(attempts):
        code = invites.generate_code()
        exists = session.scalar(
            select(m.Project.id).where(m.Project.invite_code == code)
        )
        if not exists:
            return code
    raise HTTPException(
        status.HTTP_503_SERVICE_UNAVAILABLE, "초대 코드를 만들지 못했습니다"
    )


@app.post("/api/projects", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
def create_project(payload: ProjectIn, session: DbSession, user: CurrentUser) -> ProjectOut:
    project = m.Project(
        title=payload.title,
        started_at=datetime.now(UTC),
        github_repo=payload.github_repo,
        invite_code=_fresh_invite_code(session),
    )
    session.add(project)
    session.flush()

    # 만든 사람만 구성원입니다. 나머지는 초대 코드로 스스로 들어옵니다.
    #
    # 만든 사람을 빠뜨리면 자기가 만든 프로젝트를 자기가 못 봅니다 —
    # 모든 조회가 구성원 확인을 지나기 때문입니다.
    session.add(
        m.Member(project_id=project.id, user_id=user.id, role_shares={"developer": 1.0})
    )
    session.flush()

    return ProjectOut(
        project_id=project.id,
        title=project.title,
        member_ids=[user.id],
        invite_code=project.invite_code or "",
    )


class ProjectDetail(BaseModel):
    project_id: int
    title: str
    github_repo: str | None
    github_connected: bool
    #: 화면에 보여줄 형태(`ABCD-EFGH`). 코드가 없으면 빈 문자열.
    invite_code: str
    member_count: int


@app.get("/api/projects/{project_id}", response_model=ProjectDetail)
def get_project(project_id: int, session: DbSession, user: CurrentUser) -> ProjectDetail:
    """프로젝트 설정 화면이 읽는 것. **초대 코드는 구성원에게만.**"""
    project = session.get(m.Project, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "프로젝트를 찾을 수 없습니다")
    _require_project_member(session, project_id, user)

    count = session.scalar(
        select(func.count()).select_from(m.Member).where(m.Member.project_id == project_id)
    )
    return ProjectDetail(
        project_id=project.id,
        title=project.title,
        github_repo=project.github_repo,
        # 설치 id 자체는 내보내지 않습니다 — 화면이 쓸 일이 없고,
        # 연결 여부만 알면 됩니다.
        github_connected=project.github_installation_id is not None,
        invite_code=invites.format_code(project.invite_code or ""),
        member_count=int(count or 0),
    )


class ProjectPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    #: `owner/repo`. 빈 문자열이면 연결을 끊습니다.
    github_repo: str | None = Field(default=None, max_length=255)
    github_installation_id: int | None = None


_REPO_PATTERN = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")


@app.patch("/api/projects/{project_id}", response_model=ProjectDetail)
def patch_project(
    project_id: int, payload: ProjectPatch, session: DbSession, user: CurrentUser
) -> ProjectDetail:
    """제목과 GitHub 연결.

    ⚠️ 저장소 형식을 검사합니다. 웹훅은 `repository.full_name` 으로 프로젝트를
    찾으므로, 여기에 `https://github.com/team/repo` 같은 걸 넣으면 **웹훅이
    영원히 이 프로젝트를 못 찾습니다** — 오류도 안 나고 기여도만 비어 있습니다.
    """
    project = session.get(m.Project, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "프로젝트를 찾을 수 없습니다")
    _require_project_member(session, project_id, user)

    if payload.title is not None:
        project.title = payload.title

    if payload.github_repo is not None:
        repo = payload.github_repo.strip()
        if repo and not _REPO_PATTERN.match(repo):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "저장소는 `owner/repo` 형식이어야 합니다 (주소 전체가 아니라)",
            )
        taken = session.scalar(
            select(m.Project.id).where(
                m.Project.github_repo == repo, m.Project.id != project_id
            )
        )
        if repo and taken:
            # 웹훅은 저장소로 프로젝트를 찾습니다. 둘이 같은 저장소를 가리키면
            # 한쪽만 이벤트를 받고 다른 쪽은 이유 없이 빕니다.
            raise HTTPException(
                status.HTTP_409_CONFLICT, "다른 프로젝트가 이미 이 저장소를 쓰고 있습니다"
            )
        project.github_repo = repo or None
        project.github_connected_at = datetime.now(UTC) if repo else None

    if payload.github_installation_id is not None:
        project.github_installation_id = payload.github_installation_id or None

    session.flush()
    return get_project(project_id, session, user)


class JoinIn(BaseModel):
    #: `ABCD-EFGH` 도 `abcdefgh` 도 받습니다.
    invite_code: str = Field(min_length=1, max_length=32)


class JoinOut(BaseModel):
    project_id: int
    title: str
    already_member: bool


@app.post("/api/projects/join", response_model=JoinOut)
def join_project(payload: JoinIn, session: DbSession, user: CurrentUser) -> JoinOut:
    """초대 코드로 팀에 들어간다.

    형식이 틀린 코드와 없는 코드를 **다르게** 답합니다. 사람이 고쳐야 할
    것이 다르기 때문입니다 — 앞은 오타이고 뒤는 상대에게 다시 물어야
    합니다. 둘 다 "코드가 없습니다" 로 답하면 사람은 상대를 의심합니다.
    """
    code = invites.normalize_code(payload.invite_code)
    if not invites.looks_like_code(code):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "코드 형식이 올바르지 않습니다 — 8자이고 0·O·1·I·L 은 쓰지 않습니다",
        )

    project = session.scalars(
        select(m.Project).where(m.Project.invite_code == code)
    ).first()
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "그런 초대 코드가 없습니다")

    existing = session.scalars(
        select(m.Member).where(
            m.Member.project_id == project.id, m.Member.user_id == user.id
        )
    ).first()
    if existing is not None:
        # 두 번 눌러도 오류가 아닙니다. 이미 팀원인 게 원하던 결과입니다.
        return JoinOut(project_id=project.id, title=project.title, already_member=True)

    session.add(
        m.Member(
            project_id=project.id, user_id=user.id, role_shares={"developer": 1.0}
        )
    )
    session.flush()
    return JoinOut(project_id=project.id, title=project.title, already_member=False)


@app.post("/api/projects/{project_id}/invite/rotate", response_model=ProjectDetail)
def rotate_invite_code(
    project_id: int, session: DbSession, user: CurrentUser
) -> ProjectDetail:
    """코드를 새로 만든다. 옛 코드는 그 즉시 통하지 않습니다.

    코드는 카톡·메신저로 돌아다니므로 **새어 나갑니다.** 회수할 방법이
    없으면 한 번 새면 그 프로젝트는 영영 열려 있습니다.
    """
    project = session.get(m.Project, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "프로젝트를 찾을 수 없습니다")
    _require_project_member(session, project_id, user)

    project.invite_code = _fresh_invite_code(session)
    session.flush()
    return get_project(project_id, session, user)


class MeetingIn(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    # `started_by` 는 없습니다. 녹음을 시작한 사람은 **세션에서** 나옵니다 —
    # 통신비밀보호법상 녹음 개시자는 회의 당사자여야 하는데(L1), 그걸
    # 요청 본문으로 받으면 아무나 남의 이름으로 회의를 열 수 있습니다.
    #: multitrack 만 받는다. 단일 마이크(모드 B)는 화자 분리 구현이 없어
    #: 만들어 두면 처리 단계에서 빈 결과가 나온다 — 만들 수 없게 막는다.
    capture_mode: str = "multitrack"


class MeetingOut(BaseModel):
    meeting_id: int
    project_id: int
    status: str
    consent_url: str


@app.post(
    "/api/projects/{project_id}/meetings",
    response_model=MeetingOut,
    status_code=status.HTTP_201_CREATED,
)
def create_meeting(
    project_id: int, payload: MeetingIn, session: DbSession, user: CurrentUser
) -> MeetingOut:
    """회의를 연다. 아직 녹음은 시작되지 않는다 — 동의가 먼저다."""
    project = session.get(m.Project, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "프로젝트를 찾을 수 없습니다")

    if payload.capture_mode != "multitrack":
        # 모드 B 는 화자 분리(`build_diarizer`)가 미구현이다. 만들 수 있게
        # 두면 녹음은 되는데 처리에서 조용히 빈 결과가 나온다.
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "지금은 멀티트랙(각자 폰으로 녹음)만 지원합니다. "
            "단일 마이크는 화자 분리 구현 후에 열립니다 (docs/04 §2).",
        )

    # 통신비밀보호법 L1 — 녹음을 시작하는 사람은 회의 당사자여야 한다.
    _require_project_member(session, project_id, user)

    meeting = m.Meeting(
        project_id=project_id,
        title=payload.title,
        started_at=datetime.now(UTC),
        started_by=user.id,
        capture_mode=payload.capture_mode,
    )
    session.add(meeting)
    session.flush()

    return MeetingOut(
        meeting_id=meeting.id,
        project_id=project_id,
        status=meeting.status,
        consent_url=f"/api/meetings/{meeting.id}/consent",
    )


# ══════════════════════════════════════════════════════════════
# 동의 — 법적 방어선
# ══════════════════════════════════════════════════════════════


class ConsentIn(BaseModel):
    # `user_id` 는 없습니다. **동의는 본인만 할 수 있습니다** — 남의 번호를
    # 적어 동의를 대신 제출할 수 있으면 이 게이트는 법적 방어선이 아닙니다.
    #: recording | raw_audio_retention | voiceprint_storage
    consent_type: str = "recording"
    consented: bool


class ConsentOut(BaseModel):
    meeting_id: int
    roster: list[dict[str, Any]]
    all_confirmed: bool
    message: str


@app.post("/api/meetings/{meeting_id}/consent", response_model=ConsentOut)
def submit_consent(
    meeting_id: int,
    payload: ConsentIn,
    request: Request,
    session: DbSession,
    user: CurrentUser,
) -> ConsentOut:
    """동의를 제출하거나 철회한다.

    **철회는 소급하지 않는다.** `consented=false` 는 이후 청크만 막고,
    이미 받은 오디오는 보존기간까지 남는다. 삭제는 별도 절차다 (docs/07 P6).
    """
    _load_meeting_for(session, meeting_id, user)
    try:
        recording_service.submit_consent(
            session,
            meeting_id=meeting_id,
            user_id=user.id,
            consent_type=payload.consent_type,
            consented=payload.consented,
            ip_address=request.client.host if request.client else None,
        )
    except recording_service.ConsentError as exc:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    status_ = recording_service.consent_status(session, meeting_id)
    return ConsentOut(
        meeting_id=meeting_id,
        roster=recording_service.consent_roster(session, meeting_id),
        all_confirmed=status_.all_confirmed,
        message="전원 동의했습니다. 녹음을 시작할 수 있습니다"
        if status_.all_confirmed
        else status_.describe(),
    )


@app.get("/api/meetings/{meeting_id}/consent", response_model=ConsentOut)
def read_consent(meeting_id: int, session: DbSession, user: CurrentUser) -> ConsentOut:
    """동의 현황. **아직 응답하지 않은 사람도 보인다.**

    동의 행이 있는 사람만 보여주면 기다려야 할 대상이 화면에서 사라진다.
    """
    _load_meeting_for(session, meeting_id, user)
    status_ = recording_service.consent_status(session, meeting_id)
    return ConsentOut(
        meeting_id=meeting_id,
        roster=recording_service.consent_roster(session, meeting_id),
        all_confirmed=status_.all_confirmed,
        message="전원 동의했습니다. 녹음을 시작할 수 있습니다"
        if status_.all_confirmed
        else status_.describe(),
    )


class TrackOut(BaseModel):
    track_id: int
    meeting_id: int
    user_id: int
    status: str
    # 재개용. 새로 만든 트랙이면 빈 목록이다.
    stored_seqs: list[int]


@app.post(
    "/api/meetings/{meeting_id}/tracks",
    response_model=TrackOut,
    status_code=status.HTTP_201_CREATED,
)
def join_track(
    meeting_id: int,
    payload: TrackJoin,
    session: DbSession,
    settings: AppSettings,
    user: CurrentUser,
) -> TrackOut:
    """회의에 트랙으로 참가한다. 새로고침해도 같은 트랙으로 이어붙는다."""
    _load_meeting_for(session, meeting_id, user)
    try:
        track = recording_service.join_track(
            session,
            meeting_id=meeting_id,
            user_id=user.id,
            started_at=payload.started_at,
            device_label=payload.device_label,
            sample_rate=payload.sample_rate,
        )
    except recording_service.ConsentError as exc:
        # 403 이다. 인증 문제가 아니라 "동의가 없어서 안 된다"는 뜻이다.
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from exc
    except recording_service.TrackError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc

    return TrackOut(
        track_id=track.id,
        meeting_id=meeting_id,
        user_id=track.user_id,
        status=track.status,
        stored_seqs=recording_service.stored_seqs(
            _chunk_store(settings), meeting_id=meeting_id, track_id=track.id
        ),
    )


def _own_track(session: Session, meeting_id: int, track_id: int, user: m.User) -> m.MeetingTrack:
    """이 트랙이 **내 트랙인가**.

    트랙 = 사람이 이 시스템의 화자 라벨 근거입니다. 남의 트랙에 오디오를
    올릴 수 있으면 "이 목소리는 이 사람" 이라는 전제가 무너지고, 그 위에
    쌓인 발언량·기여도가 전부 근거를 잃습니다.

    404 를 쓰는 이유: "그 트랙은 남의 것" 이라고 알려 주면 트랙 id 를
    훑어 누가 참가했는지 알아낼 수 있습니다. 없는 것과 남의 것을 구분해
    답하지 않습니다.
    """
    track = session.get(m.MeetingTrack, track_id)
    if track is None or track.meeting_id != meeting_id or track.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "트랙을 찾을 수 없습니다")
    return track


class ChunkAck(BaseModel):
    seq: int
    bytes: int


@app.put(
    "/api/meetings/{meeting_id}/tracks/{track_id}/chunks/{seq}",
    response_model=ChunkAck,
)
async def put_chunk(
    meeting_id: int,
    track_id: int,
    seq: int,
    request: Request,
    session: DbSession,
    settings: AppSettings,
    user: CurrentUser,
    x_client_at_ms: Annotated[int | None, Header()] = None,
) -> ChunkAck:
    """청크 하나를 받는다.

    PUT 이라 같은 seq 를 다시 받으면 덮어쓴다 — 업로드 큐가 재시도하기 때문이다.
    `X-Client-At-Ms` 는 클라이언트가 **동기화된 서버 시각**으로 찍은 도착
    시각이다. 이게 없으면 공백을 절대 시각으로 복원할 수 없다 (docs/04 §2.6).
    """
    if seq < 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "seq 는 0 이상이어야 합니다")
    if x_client_at_ms is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "X-Client-At-Ms 헤더가 필요합니다 (동기화된 청크 도착 시각)",
        )

    _own_track(session, meeting_id, track_id, user)

    data = await request.body()
    try:
        chunk = recording_service.store_chunk(
            session,
            _chunk_store(settings),
            meeting_id=meeting_id,
            track_id=track_id,
            seq=seq,
            client_at_ms=x_client_at_ms,
            data=data,
        )
    except recording_service.ConsentError as exc:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from exc
    except recording_service.TrackError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    return ChunkAck(seq=chunk.seq, bytes=chunk.bytes)


class StoredChunks(BaseModel):
    track_id: int
    seqs: list[int]
    total_bytes: int


@app.get(
    "/api/meetings/{meeting_id}/tracks/{track_id}/chunks",
    response_model=StoredChunks,
)
def list_chunks(
    meeting_id: int,
    track_id: int,
    session: DbSession,
    settings: AppSettings,
    user: CurrentUser,
) -> StoredChunks:
    """재연결 후 "어디까지 올렸나"를 묻는 엔드포인트.

    이게 없으면 클라이언트가 매번 처음부터 다시 올려 영영 못 따라잡는다
    (`UploadQueue.resumeWith`).
    """
    _load_meeting_for(session, meeting_id, user)
    _own_track(session, meeting_id, track_id, user)
    store = _chunk_store(settings)
    return StoredChunks(
        track_id=track_id,
        seqs=store.stored_seqs(meeting_id, track_id),
        total_bytes=store.total_bytes(meeting_id, track_id),
    )


class TrackComplete(BaseModel):
    ended_at: datetime
    coverage: float = Field(ge=0, le=1)
    total_gap_ms: int = Field(ge=0)
    longest_gap_ms: int = Field(default=0, ge=0)
    gaps: list[dict[str, Any]] = Field(default_factory=list)
    capture_confidence: float = Field(default=1.0, ge=0, le=1)
    capture_warnings: list[dict[str, Any]] = Field(default_factory=list)
    stop_reason: str | None = None
    # 서버가 배치를 다시 계산할 때 필요하다 (MediaRecorder.start(timeslice))
    timeslice_ms: int = Field(default=5_000, gt=0)


class TrackCompleteOut(BaseModel):
    track_id: int
    status: str
    coverage: float
    usable: bool
    message: str
    #: 전원이 끝나 회의 처리가 큐에 들어갔는가
    meeting_queued: bool = False
    #: 아직 녹음 중인 사람이 있으면 그 안내
    meeting_status: str = ""


@app.post(
    "/api/meetings/{meeting_id}/tracks/{track_id}/complete",
    response_model=TrackCompleteOut,
)
def complete_track(
    meeting_id: int,
    track_id: int,
    payload: TrackComplete,
    session: DbSession,
    settings: AppSettings,
    user: CurrentUser,
) -> TrackCompleteOut:
    """녹음 종료. 클라이언트가 계산한 품질 정보를 받아 저장한다.

    보고된 커버리지를 그대로 믿지 않는다 — 서버가 실제로 받은 청크 수와
    대조해서 더 나쁜 쪽을 쓴다.
    """
    _load_meeting_for(session, meeting_id, user)
    _own_track(session, meeting_id, track_id, user)
    try:
        track = recording_service.complete_track(
            session,
            _chunk_store(settings),
            meeting_id=meeting_id,
            track_id=track_id,
            summary=recording_service.TrackSummary(
                ended_at=payload.ended_at,
                coverage=payload.coverage,
                total_gap_ms=payload.total_gap_ms,
                longest_gap_ms=payload.longest_gap_ms,
                gaps=payload.gaps,
                capture_confidence=payload.capture_confidence,
                capture_warnings=payload.capture_warnings,
                stop_reason=payload.stop_reason,
                timeslice_ms=payload.timeslice_ms,
            ),
        )
    except recording_service.TrackError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc

    # 전원이 끝났으면 여기서 처리를 시작한다.
    # 이 연결이 없으면 녹음은 저장만 되고 아무 일도 일어나지 않는다.
    finalize = recording_service.try_finalize_meeting(session, meeting_id)
    if finalize.should_enqueue:
        _enqueue_after_commit(session, meeting_id)

    usable = track.status == "completed"
    coverage = float(track.coverage or 0.0)
    return TrackCompleteOut(
        meeting_queued=finalize.should_enqueue,
        meeting_status=finalize.reason,
        track_id=track.id,
        status=track.status,
        coverage=coverage,
        usable=usable,
        message=(
            "녹음이 정상 저장됐습니다"
            if usable
            else f"커버리지 {coverage:.0%} — 이 트랙으로는 발화량을 판단할 수 없습니다. "
            "회의록에서 이 팀원의 발언은 확인이 필요합니다"
        ),
    )


class FinishMeetingOut(BaseModel):
    meeting_queued: bool
    aborted_track_ids: list[int]
    message: str


@app.post("/api/meetings/{meeting_id}/finish", response_model=FinishMeetingOut)
def finish_meeting(
    meeting_id: int, session: DbSession, settings: AppSettings, user: CurrentUser
) -> FinishMeetingOut:
    """회의를 강제로 종료한다.

    브라우저를 그냥 닫은 사람이 있으면 그 트랙은 영원히 `recording` 으로 남고,
    회의는 **영영 처리되지 않는다.** 사람이 그 상태를 풀 수 있어야 한다.

    강제 종료한 트랙은 `aborted` 로 남는다 — `completed` 로 두면 커버리지를
    계산한 적이 없는데 정상 종료로 보이고, 그 사람의 발언량을 측정한 것처럼
    취급된다 (docs/05 §4.1.1).
    """
    _load_meeting_for(session, meeting_id, user)
    aborted = recording_service.force_finish_tracks(
        session, meeting_id, ended_at=datetime.now(UTC)
    )
    # force=True — 참가하지 않은 사람을 더 기다리지 않는다. 그게 이 엔드포인트의 존재 이유다.
    finalize = recording_service.try_finalize_meeting(session, meeting_id, force=True)
    if finalize.should_enqueue:
        _enqueue_after_commit(session, meeting_id)

    return FinishMeetingOut(
        meeting_queued=finalize.should_enqueue,
        aborted_track_ids=aborted,
        message=(
            f"{len(aborted)}개 트랙을 강제 종료했습니다. {finalize.reason}"
            if aborted
            else finalize.reason
        ),
    )


@app.get("/api/meetings/{meeting_id}/tracks")
def list_tracks(
    meeting_id: int, session: DbSession, user: CurrentUser
) -> dict[str, Any]:
    """트랙별 상태. 승인 화면이 "이 트랙은 못 씁니다"를 띄우는 근거."""
    _load_meeting_for(session, meeting_id, user)
    consent = recording_service.consent_status(session, meeting_id)
    return {
        "meeting_id": meeting_id,
        "consent": {
            "total": consent.total,
            "granted": consent.granted,
            "refused": consent.refused,
            "all_confirmed": consent.all_confirmed,
        },
        "tracks": recording_service.track_health(session, meeting_id),
    }


class MeetingSummary(BaseModel):
    meeting_id: int
    title: str | None
    status: str
    started_at: datetime
    #: 이 회의에서 사람이 아직 결정하지 않은 업무 후보 수
    pending_candidates: int


@app.get("/api/projects/{project_id}/meetings", response_model=list[MeetingSummary])
def list_project_meetings(
    project_id: int, session: DbSession, user: CurrentUser
) -> list[MeetingSummary]:
    """이 프로젝트의 회의. **최근 것부터.**

    오래된 것부터 두면 회의가 쌓일수록 지금 볼 것이 아래로 밀립니다.
    """
    if session.get(m.Project, project_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "프로젝트를 찾을 수 없습니다")
    _require_project_member(session, project_id, user)

    meetings = session.scalars(
        select(m.Meeting)
        .where(m.Meeting.project_id == project_id)
        .order_by(m.Meeting.started_at.desc(), m.Meeting.id.desc())
    ).all()
    if not meetings:
        return []

    pending = dict(
        session.execute(
            select(m.MeetingTaskCandidate.meeting_id, func.count())
            .where(
                m.MeetingTaskCandidate.meeting_id.in_([x.id for x in meetings]),
                m.MeetingTaskCandidate.review_status == "pending",
            )
            .group_by(m.MeetingTaskCandidate.meeting_id)
        ).all()
    )

    return [
        MeetingSummary(
            meeting_id=meeting.id,
            title=meeting.title,
            status=meeting.status,
            started_at=meeting.started_at,
            pending_candidates=pending.get(meeting.id, 0),
        )
        for meeting in meetings
    ]


class MeetingDetail(BaseModel):
    id: int
    project_id: int
    title: str | None
    status: str
    started_at: datetime
    capture_mode: str
    # 처리가 끝나기 전에는 None. 실패한 회의도 None 이다 —
    # 빈 문자열로 내려보내면 화면이 "요약이 없는 회의" 로 그린다.
    summary: str | None


@app.get("/api/meetings/{meeting_id}", response_model=MeetingDetail)
def get_meeting(meeting_id: int, session: DbSession, user: CurrentUser) -> MeetingDetail:
    """회의 하나. 승인 화면이 회의 요약을 보여주려면 이게 필요하다.

    요약은 이 시스템이 회의에서 만들어 내는 대표 산출물인데, 이 엔드포인트가
    생기기 전까지는 **DB 에 저장조차 되지 않았다.** 파이프라인이 만들어
    Celery 페이로드에 실어 보낸 뒤 저장 태스크가 읽지 않고 버렸다.
    """
    meeting = _load_meeting_for(session, meeting_id, user)
    return MeetingDetail(
        id=meeting.id,
        project_id=meeting.project_id,
        title=meeting.title,
        status=meeting.status,
        started_at=meeting.started_at,
        capture_mode=meeting.capture_mode,
        summary=meeting.summary,
    )


# ══════════════════════════════════════════════════════════════
# 회의 업무 후보 검토 (이어서)
# ══════════════════════════════════════════════════════════════


class MemberOut(BaseModel):
    user_id: int
    name: str
    role_shares: dict[str, float]


def _project_members(session: Session, project_id: int) -> list[MemberOut]:
    rows = session.execute(
        select(m.Member, m.User)
        .join(m.User, m.User.id == m.Member.user_id)
        .where(m.Member.project_id == project_id)
        .order_by(m.Member.id)
    ).all()
    return [
        MemberOut(
            user_id=member.user_id,
            name=user.name,
            role_shares={k: float(v) for k, v in (member.role_shares or {}).items()},
        )
        for member, user in rows
    ]


@app.get("/api/projects/{project_id}/members", response_model=list[MemberOut])
def list_project_members(
    project_id: int, session: DbSession, user: CurrentUser
) -> list[MemberOut]:
    """이 프로젝트의 팀원.

    ⭐ **이름은 프로젝트 속성이지 회의 속성이 아닙니다.**

    처음에는 명단 API 가 회의 단위뿐이었습니다(승인 화면이 담당자를 고르려고
    만든 것). 그래서 칸반·기여도 화면을 `?project=N` 만으로 열면 명단을 받을
    길이 없어 **모든 이름이 `사용자 #3` 으로** 떴습니다.

    기여도 화면에서는 특히 나쁩니다 — 사람별 기여를 보여주는 화면인데 이름이
    없고, 이름 순 정렬이 `사용자 #N` 문자열 순으로 바뀝니다.
    """
    if session.get(m.Project, project_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "프로젝트를 찾을 수 없습니다")
    _require_project_member(session, project_id, user)
    return _project_members(session, project_id)


@app.get("/api/meetings/{meeting_id}/members", response_model=list[MemberOut])
def list_meeting_members(
    meeting_id: int, session: DbSession, user: CurrentUser
) -> list[MemberOut]:
    """이 회의가 속한 프로젝트의 팀원.

    승인 화면이 담당자를 고르려면 명단이 필요하다. 명단 없이 담당자 id 를
    직접 입력하게 하면 오타 하나로 엉뚱한 사람에게 업무가 붙는다 —
    서버가 `unknown_assignee` 로 막긴 하지만, 애초에 고를 수 있게 하는 게 맞다.
    """
    meeting = _load_meeting_for(session, meeting_id, user)
    # 프로젝트 단위 조회에 위임합니다. 두 곳에 같은 쿼리를 두면 반드시
    # 갈라지고, 갈라지면 화면마다 다른 명단을 보게 됩니다.
    return _project_members(session, meeting.project_id)


@app.get("/api/meetings/{meeting_id}/candidates", response_model=list[CandidateOut])
def list_candidates(
    meeting_id: int, session: DbSession, user: CurrentUser
) -> list[CandidateOut]:
    """검토 대기 중인 업무 후보. 확신도가 낮은 것부터 나온다."""
    _load_meeting_for(session, meeting_id, user)
    rows = approval_service.pending_candidates(session, meeting_id)
    return [
        CandidateOut(
            id=r.id,
            title=r.title,
            assignee_hint=r.assignee_hint,
            assignee_id=r.assignee_id,
            deadline=r.deadline.date() if isinstance(r.deadline, datetime) else r.deadline,
            confidence=float(r.confidence),
            evidence_utterance_ids=list(r.evidence_utterance_ids or []),
            review_status=r.review_status,
            warnings=list(r.warnings or []),
        )
        for r in rows
    ]


@app.post("/api/meetings/{meeting_id}/candidates/review", response_model=ReviewResult)
def review(
    meeting_id: int, payload: ReviewPayload, session: DbSession, user: CurrentUser
) -> ReviewResult:
    """후보 승인/거절.

    **승인된 것만 칸반에 등록된다.** AI가 만든 업무가 사람을 거치지 않고
    tasks 로 가는 경로는 존재하지 않는다.
    """
    meeting = _load_meeting_for(session, meeting_id, user)

    requests = [
        ApprovalRequest(
            candidate_id=item.candidate_id,
            reviewer_id=user.id,
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

    # 병합된 PR 만 기여 이벤트가 됩니다. 나머지는 원본만 남깁니다.
    #
    # ⚠️ **커밋 뒤에** 큐에 넣습니다. 여기서 바로 넣으면 워커가 그 사이에
    # 도착해 아직 없는 행을 찾습니다 — 회의 처리에서 이미 한 번 당한
    # 결함입니다(`_enqueue_after_commit` 의 주석). 커밋은 이 함수가 아니라
    # FastAPI 의존성 teardown 에서 일어납니다.
    queued = False
    if normalized.event_type == "pull_request.merged":
        _enqueue_github_after_commit(session, row.id)
        queued = True

    return {
        "status": "accepted",
        "event_id": row.id,
        "event_type": normalized.event_type,
        "linked_user": actor_user_id,
        "queued": queued,
    }


# ══════════════════════════════════════════════════════════════
# 칸반 업무
# ══════════════════════════════════════════════════════════════
#
# 승인하면 `tasks` 에 들어가는데 **그걸 읽는 엔드포인트가 없었습니다.**
# 그리고 업무를 완료해도 기여도에 아무 일도 일어나지 않았습니다 —
# 자세한 것은 `services/task_service.py` 의 모듈 주석에 있습니다.


class TaskOriginOut(BaseModel):
    """이 업무가 어느 회의에서 나왔는가. 손으로 만든 업무면 없다."""

    candidate_id: int
    meeting_id: int
    meeting_title: str | None
    evidence_utterance_ids: list[int]


class TaskOut(BaseModel):
    id: int
    title: str
    assignee_id: int | None
    status: str
    deadline: date | None
    completed_at: datetime | None
    origin: TaskOriginOut | None


class TaskBoardOut(BaseModel):
    project_id: int
    statuses: list[str]
    tasks: list[TaskOut]


@app.get("/api/projects/{project_id}/tasks", response_model=TaskBoardOut)
def list_tasks(project_id: int, session: DbSession, user: CurrentUser) -> TaskBoardOut:
    """칸반 보드가 읽는 목록.

    **어느 회의에서 나왔는지를 같이 싣습니다.** 그게 없으면 이 화면은 그냥
    할 일 목록이고, 이 프로젝트의 주장(회의 결정 → 칸반 업무)을 화면에서
    확인할 방법이 없습니다.
    """
    if session.get(m.Project, project_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "프로젝트를 찾을 수 없습니다")
    _require_project_member(session, project_id, user)

    return TaskBoardOut(
        project_id=project_id,
        statuses=list(task_service.STATUSES),
        tasks=[TaskOut(**row) for row in task_service.list_tasks(session, project_id)],
    )


class TaskPatch(BaseModel):
    status: str | None = None
    # `deadline` 은 None 이 두 뜻이라 따로 받는다 — 아래 엔드포인트 주석 참조.
    deadline: date | None = None
    reason: str | None = Field(default=None, max_length=300)


@app.patch("/api/projects/{project_id}/tasks/{task_id}", response_model=TaskOut)
async def patch_task(
    project_id: int,
    task_id: int,
    payload: TaskPatch,
    request: Request,
    session: DbSession,
    user: CurrentUser,
) -> TaskOut:
    """상태·마감일 변경.

    ⚠️ `deadline: null` 이 **"마감일을 지운다"** 인지 **"마감일은 안
    건드린다"** 인지 본문만으로는 알 수 없습니다. pydantic 은 둘 다 None 으로
    만듭니다. 그래서 원본 JSON 에 키가 있었는지를 직접 봅니다 — 이걸 구분하지
    않으면 상태만 바꾸려는 요청이 마감일을 **조용히 지웁니다.**
    """
    if session.get(m.Project, project_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "프로젝트를 찾을 수 없습니다")
    _require_project_member(session, project_id, user)

    try:
        raw = await request.json()
    except Exception:
        raw = {}
    deadline_provided = isinstance(raw, dict) and "deadline" in raw

    try:
        task = task_service.change_task(
            session,
            project_id=project_id,
            task_id=task_id,
            actor_id=user.id,
            status=payload.status,
            deadline=payload.deadline,
            deadline_provided=deadline_provided,
            reason=payload.reason,
        )
    except task_service.TaskError as exc:
        code = (
            status.HTTP_404_NOT_FOUND
            if "찾을 수 없습니다" in str(exc)
            else status.HTTP_400_BAD_REQUEST
        )
        raise HTTPException(code, str(exc)) from exc

    rows = task_service.list_tasks(session, project_id)
    updated = next(row for row in rows if row["id"] == task.id)
    return TaskOut(**updated)


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
    # 측정하지 못한 영역. 0점과 다르다는 걸 화면이 반드시 구분해서 보여야 한다.
    measurement_gaps: list[dict[str, Any]] = Field(default_factory=list)


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
def contributions(
    project_id: int, session: DbSession, settings: AppSettings, user: CurrentUser
) -> ScoreOut:
    """기여도 조회.

    저장된 점수를 읽는 게 아니라 **이벤트 로그에서 매번 재계산한다.**
    그래야 가중치를 바꿔도 과거가 오염되지 않고, 모든 숫자에 근거가 붙는다.
    docs/05 §1
    """
    from teamflow.services import scoring_service

    # ⚠️ 없는 프로젝트를 200 으로 돌려주면 안 된다.
    #
    # 재계산 방식이라 없는 프로젝트도 "이벤트 0건 → 빈 결과" 로 멀쩡히
    # 계산된다. 화면은 그걸 **"기여도가 없는 프로젝트"** 로 그린다 —
    # 오타 하나로 팀 전체가 0점인 것처럼 보이고, 아무 오류도 나지 않는다.
    if session.get(m.Project, project_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "프로젝트를 찾을 수 없습니다")

    # 기여도는 성적에 반영될 수 있는 값입니다. 남의 팀 점수를 볼 이유가 없습니다.
    _require_project_member(session, project_id, user)

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
                measurement_gaps=[
                    {
                        "category": g.category.value,
                        "reason": g.reason,
                        "detail": g.detail,
                    }
                    for g in ms.measurement_gaps
                ],
            )
            for ms in result.members.values()
        ],
        skipped_categories=[c.value for c in result.skipped_categories],
    )


# ══════════════════════════════════════════════════════════════
# 정적 파일 — **반드시 맨 마지막이다**
# ══════════════════════════════════════════════════════════════
#
# `/` 마운트는 앞의 모든 경로를 삼키므로 API 라우트를 전부 정의한 뒤에 온다.
# 위에 새 엔드포인트를 추가하되 이 아래에는 넣지 말 것.
#
# 왜 필요한가 — `getUserMedia()` 는 보안 컨텍스트에서만 동작한다. 폰이
# 페이지와 API 를 **둘 다** HTTPS 로 잡아야 하는데, 화면을 별도 서버
# (`python3 -m http.server:3000`)에 두면 터널이 둘이 되고 CORS 설정이
# 필요하다. 한 오리진으로 합치면 터널 하나, CORS 0줄로 끝난다.
#
# 그래서 CORSMiddleware 를 넣지 않는다. 넣어야 한다면 그건 배치가
# 잘못됐다는 신호다.


def _mount_frontend(application: FastAPI) -> Path | None:
    """`frontend/public` 이 있으면 `/` 에 붙인다.

    없어도 API 는 정상 동작한다 — 백엔드만 띄우는 배포와 테스트가 있다.
    """
    candidate = Path(__file__).resolve().parents[3] / "frontend" / "public"
    if not candidate.is_dir():
        logger.info("정적 파일 디렉터리가 없어 마운트하지 않습니다: %s", candidate)
        return None

    application.mount("/", StaticFiles(directory=candidate, html=True), name="web")
    return candidate


FRONTEND_DIR = _mount_frontend(app)
