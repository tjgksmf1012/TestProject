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
from uuid import uuid4

from fastapi import (
    Depends,
    FastAPI,
    Header,
    HTTPException,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import event, func, select
from sqlalchemy.orm import Session

from teamflow.audio.chunk_store import ChunkStore
from teamflow.auth import passwords
from teamflow.call import rooms as call_rooms
from teamflow.call import signaling as call_signaling_module
from teamflow.chat import hub as chat_hub
from teamflow.config import Settings, get_settings, safe_dump
from teamflow.db import models as m
from teamflow.db import session as db_session
from teamflow.db import vocab
from teamflow.db.session import get_db
from teamflow.github import backfill as gh_backfill
from teamflow.github import connection as gh_connection
from teamflow.github import linking as gh_linking
from teamflow.github import webhook as gh
from teamflow.jobs import retention
from teamflow.logging_config import configure_logging
from teamflow.meeting.approval import ApprovalRequest
from teamflow.projects import invites
from teamflow.services import (
    activity_service,
    approval_service,
    auth_service,
    calendar_service,
    channel_service,
    github_connection_service,
    message_service,
    notification_service,
    progress_service,
    recording_service,
    report_service,
    task_link_service,
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
    # ⚠️ 화면이 없으면 **여기서** 말한다.
    #
    # `_mount_frontend` 는 import 시점에 돌고, 로깅은 방금 위에서야
    # 설정된다. 그래서 거기서 찍은 안내는 `logging.lastResort`(WARNING)
    # 에 걸려 사라졌다 — 즉 컨테이너에서 모든 화면이 404 인데 그 사실을
    # 알리는 유일한 로그가 버려지고 있었다.
    if FRONTEND_DIR is None:
        logger.warning(
            "정적 파일 디렉터리가 없어 화면을 서빙하지 않습니다: %s — "
            "이 서버로 열면 모든 화면이 404 입니다",
            FRONTEND_EXPECTED_AT,
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


def should_mark_cookie_secure(
    *, is_production: bool, scheme: str, forwarded_proto: str | None
) -> bool:
    """세션 쿠키에 `Secure` 를 붙일 것인가.

    ⚠️ 예전에는 `settings.is_production` 하나만 봤습니다. 그런데 **그
    "운영" 을 만드는 방법이 저장소에 없었습니다** — `.env.example` 은
    `ENVIRONMENT=development` 로 고정이고 docker-compose 도 덮어쓰지
    않습니다. 즉 이 코드가 실제로 뜨는 모든 경우에 `Secure` 가 빠졌고,
    14일짜리 세션 토큰이 평문으로 나갈 수 있었습니다. `httponly` 로 XSS
    를 막아 둔 바로 그 토큰인데 전송 구간만 벗겨져 있었습니다.

    설정값 하나에 안전이 걸려 있고 그 값을 켜는 경로가 없으면, 그건
    안전장치가 아니라 장식입니다. 그래서 **실제 연결을 봅니다.**

    이 프로젝트의 배포는 Cloudflare Tunnel 이라 앱이 보는 스킴은 http
    입니다. 터널이 붙여 주는 `X-Forwarded-Proto` 가 진짜 스킴입니다.
    그 헤더를 믿어도 되는 이유: 공격자가 헤더를 넣어도 결과는 쿠키가
    **더** 엄격해지는 것뿐입니다(브라우저가 http 로는 안 보냄). 반대로
    느슨해지게 만들 수는 없습니다 — 진짜 HTTPS 면 프록시가 이 헤더를
    자기 값으로 덮어씁니다.

    localhost 개발에서는 붙이지 않습니다. 붙이면 http 라 브라우저가
    쿠키를 아예 저장하지 않아 로그인이 안 됩니다.
    """
    if is_production:
        return True
    if scheme == "https":
        return True
    if forwarded_proto:
        # `X-Forwarded-Proto: https, http` 처럼 여러 개가 올 수 있다.
        # 클라이언트에 가장 가까운 것이 맨 앞이다.
        return forwarded_proto.split(",")[0].strip().lower() == "https"
    return False


def _set_session_cookie(
    response: Response, token: str, settings: Settings, request: Request | None = None
) -> None:
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
        secure=should_mark_cookie_secure(
            is_production=settings.is_production,
            scheme=request.url.scheme if request else "http",
            forwarded_proto=(
                request.headers.get("x-forwarded-proto") if request else None
            ),
        ),
        path="/",
    )


@app.post("/api/auth/signup", response_model=MeOut, status_code=status.HTTP_201_CREATED)
def signup(
    payload: SignupIn,
    request: Request,
    response: Response,
    session: DbSession,
    settings: AppSettings,
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

    token, _ = auth_service.issue_session(
        session, user_id=user.id, user_agent=request.headers.get("user-agent")
    )
    _set_session_cookie(response, token, settings, request)
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
    _set_session_cookie(response, token, settings, request)
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

    # ⚠️ 여기 `is_complete` 프로퍼티가 있었습니다 (결함 116). Pydantic 은
    # 프로퍼티를 **직렬화하지 않으므로** 화면은 그 값을 받은 적이 없고,
    # 서버 안에서도 부르는 곳이 0곳이었습니다. "담당자·마감일이 다 찼는가"
    # 를 실제로 판정하는 것은 화면의 `approvalBlockers` 입니다 — 그쪽은
    # 사람이 고른 값(`draft`)까지 보므로 여기서는 애초에 같은 답을 낼 수
    # 없습니다. 셋째 사본을 두면 언젠가 서로 다른 답을 냅니다.


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


def _enqueue_backfill_after_commit(
    session: Session, project_id: int, limit: int
) -> None:
    """커밋 뒤에 백필을 큐에 넣는다.

    같은 이유입니다 — 워커가 커밋보다 먼저 도착하면 방금 정한 상한도,
    저장소 이름 변경도 못 본 채로 시작합니다.
    """

    @event.listens_for(session, "after_commit", once=True)
    def _fire(_session: Session) -> None:  # pragma: no cover - 커밋 시점에 실행된다
        dispatch.enqueue_github_backfill(project_id, limit)


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
        # PATCH 와 **같은 문**을 지난다 (`_checked_repo` 주석 참고).
        github_repo=_checked_repo(session, payload.github_repo),
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
        # ⚠️ "연결됨" 은 **서명된 배달이 실제로 도착했다** 는 뜻입니다.
        #
        # 예전에는 설치 id 가 있으면 참이었는데, 그 id 는 화면에서 아무
        # 숫자나 보내면 채워졌습니다. 즉 아무것도 확인하지 않고 "연결됨" 을
        # 보여 주고 있었습니다. 설치 id 자체는 여전히 내보내지 않습니다.
        github_connected=project.github_verified_at is not None,
        invite_code=invites.format_code(project.invite_code or ""),
        member_count=int(count or 0),
    )


class ProjectPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    #: `owner/repo`. 빈 문자열이면 연결을 끊습니다.
    github_repo: str | None = Field(default=None, max_length=255)

    # ⚠️ `github_installation_id` 는 **일부러 없습니다.**
    #
    # 예전에는 여기 있었고, 화면에서 아무 숫자나 보내면 그대로 저장됐습니다.
    # 워커는 그 값으로 `build_client()` 를 불러 **그 설치의 액세스 토큰을
    # 발급**합니다. 즉 이 팀과 아무 상관 없는 설치의 권한으로 GitHub API 를
    # 부르게 만들 수 있었습니다.
    #
    # 지금은 서명이 검증된 웹훅 본문의 `installation.id` 로만 채웁니다
    # (`services/github_connection_service.record_delivery`). 요청 본문의
    # id 를 FK 나 권한에 그대로 쓰던 결함(`member_ids`)과 같은 부류입니다.
    model_config = {"extra": "forbid"}


_REPO_PATTERN = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")


def _checked_repo(session: Session, repo: str | None, *, exclude: int | None = None) -> str | None:
    """저장소 값을 받아들이기 전에 거치는 **한 개의** 문.

    ⚠️ 이 검사 둘이 PATCH 에만 있었습니다. 만들기(`POST /api/projects`)는
    같은 값을 그냥 저장했고, 화면이 마침 만들 때 저장소를 안 보내서 아무도
    몰랐습니다 — **API 는 화면보다 오래 삽니다.**

    그래서 두 경로가 같은 함수를 지나게 했습니다. 한쪽에만 검사를 더하면
    다음 사람이 또 한쪽을 빠뜨립니다.
    """
    if repo is None:
        return None
    repo = repo.strip()
    if not repo:
        return ""

    # 웹훅은 `repository.full_name` 으로 프로젝트를 찾습니다. 주소 전체를
    # 넣으면 **영원히 못 찾습니다** — 오류도 안 나고 기여도만 비어 있습니다.
    if not _REPO_PATTERN.match(repo):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "저장소는 `owner/repo` 형식이어야 합니다 (주소 전체가 아니라)",
        )

    # ⚠️ 대조는 **대소문자를 무시하고** 합니다. `team/x` 와 `team/X` 를
    # 다른 저장소로 보면, 웹훅이 왔을 때 어느 프로젝트에 붙을지 정해지지
    # 않습니다. DB 의 유니크 제약이 최종 방어이고 이건 사람에게 이유를
    # 말해 주기 위한 검사입니다.
    query = select(m.Project.id).where(
        m.Project.github_repo_key == gh_connection.repo_key(repo)
    )
    if exclude is not None:
        query = query.where(m.Project.id != exclude)
    if session.scalar(query):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "다른 프로젝트가 이미 이 저장소를 쓰고 있습니다"
        )
    return repo


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
        repo = _checked_repo(session, payload.github_repo, exclude=project_id) or ""

        # 저장소를 바꾸면 확인도 없던 일이 됩니다. 앞 저장소에서 배달이 왔다는
        # 사실이 **새 저장소가 연결됐다는 근거가 되지는 않습니다.**
        if not gh_connection.same_repo(project.github_repo, repo):
            project.github_verified_at = None
            project.github_installation_id = None

        project.github_repo = repo or None
        project.github_connected_at = datetime.now(UTC) if repo else None

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
            "코드 형식이 올바르지 않습니다 — 8자이고 0·O·1·I·L은 쓰지 않습니다",
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


class GithubHealthOut(BaseModel):
    """GitHub 연결 진단. docs/15 §4.2 의 1번.

    "틀리면 오류 없이 기여도만 빕니다" 를 없애기 위한 화면입니다. 그래서
    상태만이 아니라 **왜 그렇게 봤는지(detail)** 와 **지금 할 일(next_step)**
    을 같이 내보냅니다. 상태만 보여 주면 사람은 못 고칩니다.
    """

    code: str
    headline: str
    detail: str
    severity: str
    next_step: str | None
    warnings: list[str]

    repo: str | None
    #: 서명된 배달이 처음 도착한 시각. None 이면 **아직 확인되지 않았습니다.**
    verified_at: datetime | None
    delivery_count: int
    last_delivery_at: datetime | None

    #: "이 수치는 언제부터의 활동인가" 한 줄. 범위를 안 밝힌 숫자는
    #: **전부를 센 것처럼** 읽힙니다.
    coverage: str
    backfilled_at: datetime | None
    backfilled_to: datetime | None


@app.get("/api/projects/{project_id}/github", response_model=GithubHealthOut)
def github_health(
    project_id: int, session: DbSession, user: CurrentUser, settings: AppSettings
) -> GithubHealthOut:
    """이 프로젝트의 GitHub 연결이 실제로 살아 있는가.

    구성원만 볼 수 있습니다. 안 붙은 배달(오타 후보)이 여기 섞여 나가므로,
    아무나 부를 수 있으면 **App 이 설치된 저장소를 캐내는 도구**가 됩니다.
    무엇을 보여 주고 무엇을 감추는지는 `github/connection.looks_like_typo_of`
    에 적어 두었습니다.
    """
    if session.get(m.Project, project_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "프로젝트를 찾을 수 없습니다")
    _require_project_member(session, project_id, user)

    facts = github_connection_service.collect_facts(
        session,
        project_id,
        app_credentials_present=bool(
            getattr(settings, "github_app_id", None)
            and getattr(settings, "github_private_key", None)
        ),
        webhook_secret_present=bool(getattr(settings, "github_webhook_secret", None)),
    )
    state = gh_connection.diagnose(facts)

    return GithubHealthOut(
        code=state.code,
        headline=state.headline,
        detail=state.detail,
        severity=state.severity,
        next_step=state.next_step,
        warnings=state.warnings,
        repo=facts.repo,
        verified_at=facts.verified_at,
        delivery_count=facts.delivery_count,
        last_delivery_at=facts.last_delivery_at,
        coverage=gh_connection.describe_coverage(facts),
        backfilled_at=facts.backfilled_at,
        backfilled_to=facts.backfilled_to,
    )


class BackfillIn(BaseModel):
    """가져올 상한. 안 주면 기본값(200)."""

    limit: int | None = Field(default=None, ge=1, le=gh_backfill.MAX_LIMIT)


@app.post(
    "/api/projects/{project_id}/github/backfill",
    status_code=status.HTTP_202_ACCEPTED,
)
def start_github_backfill(
    project_id: int,
    body: BackfillIn,
    session: DbSession,
    user: CurrentUser,
    settings: AppSettings,
) -> dict:
    """연결 **전**의 병합 PR 을 가져온다.

    ⚠️ 구성원만입니다. 아무나 부를 수 있으면 남의 저장소를 향해 GitHub
    API 를 대신 두들기게 만들 수 있고, 그건 그 팀의 rate limit 을 태웁니다.

    202 를 돌려주고 워커가 합니다. PR 하나에 API 를 네 번 부르므로 200건
    이면 800 요청이고, HTTP 요청 하나가 그걸 기다릴 수는 없습니다.
    """
    project = session.get(m.Project, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "프로젝트를 찾을 수 없습니다")
    _require_project_member(session, project_id, user)

    if not project.github_repo:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "저장소가 연결되지 않았습니다. 먼저 owner/repo를 저장하세요.",
        )
    # 자격 증명이 없으면 워커가 아무것도 못 합니다. 202 로 받아 두고
    # 조용히 아무 일도 안 일어나면, 사람은 화면만 보고 기다립니다.
    if not (
        getattr(settings, "github_app_id", None)
        and getattr(settings, "github_private_key", None)
        and project.github_installation_id
    ):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "서버에 GitHub App 자격 증명이 없거나 App이 아직 이 저장소에 "
            "설치되지 않았습니다. 지난 활동을 가져오려면 그것부터 필요합니다.",
        )

    limit = gh_backfill.clamp_limit(body.limit)
    _enqueue_backfill_after_commit(session, project_id, limit)
    return {"status": "queued", "project_id": project_id, "limit": limit}


# ══════════════════════════════════════════════════════════════
# 통화 시그널링 (docs/15 §3)
# ══════════════════════════════════════════════════════════════
#
# 목소리는 여기를 지나가지 않습니다. SDP·ICE 만 오가고, 그 다음부터
# 사람들끼리 직접 연결합니다. 막는 규칙은 `call/signaling.py` 에 있고
# 36개 테스트가 붙습니다.
#
# ⚠️ **이 환경에서 실제 통화를 해 볼 수 없습니다** — 네트워크가 없습니다.
# 여기서 확인되는 것은 주선 규칙까지이고, 목소리가 실제로 오가는지는
# `docs/09` 실험 6 에서 확인합니다.


@app.websocket("/api/meetings/{meeting_id}/call")
async def call_signaling(websocket: WebSocket, meeting_id: int) -> None:
    """통화 주선 통로.

    ⚠️ **인증과 구성원 확인을 `accept()` 앞에서** 합니다. 받아 놓고
    나중에 끊으면 그 사이에 명단이 이미 샙니다 — 이 소켓이 붙자마자
    받는 첫 메시지가 "지금 누가 회의에 있는가" 입니다.
    """
    with db_session.session_scope() as session:
        user = auth_service.resolve_session(
            session, websocket.cookies.get(auth_service.COOKIE_NAME)
        )
        if user is None:
            # 1008 = policy violation. WS 에는 401 이 없습니다.
            await websocket.close(code=1008, reason="로그인이 필요합니다")
            return

        meeting = session.get(m.Meeting, meeting_id)
        if meeting is None:
            await websocket.close(code=1008, reason="회의를 찾을 수 없습니다")
            return

        member = session.scalar(
            select(m.Member.id).where(
                m.Member.project_id == meeting.project_id,
                m.Member.user_id == user.id,
            )
        )
        if member is None:
            await websocket.close(code=1008, reason="이 프로젝트의 구성원이 아닙니다")
            return

        user_id, user_name = user.id, user.name

    # 헤드폰은 **자기 신고**입니다(docs/15 §2.3). 브라우저가 확인할 방법이
    # 없어서 막지는 못하고, 대신 방에 있는 전원이 지금 보게 합니다.
    headphones = websocket.query_params.get("headphones") != "no"

    await websocket.accept()
    peer = call_signaling_module.Peer(
        user_id=user_id,
        name=user_name,
        connection_id=uuid4().hex,
        joined_at=datetime.now(UTC),
        headphones=headphones,
    )

    async def send(body: dict[str, Any]) -> None:
        await websocket.send_json(body)

    decision = await call_rooms.rooms.try_join(peer, meeting_id, send)
    if not decision.allowed:
        await websocket.send_json(
            {"kind": "rejected", "code": decision.code, "reason": decision.reason}
        )
        await websocket.close(code=1008, reason=decision.code)
        return

    await call_rooms.rooms.announce(meeting_id)
    try:
        while True:
            message = await websocket.receive_json()
            if not isinstance(message, dict):
                continue
            current = call_rooms.rooms.state(meeting_id).by_connection(
                peer.connection_id
            )
            if current is None:
                # 다른 연결에 밀려났습니다(같은 사람이 새로고침). 조용히 끝냅니다.
                break
            outcome = await call_rooms.rooms.relay(meeting_id, current, message)
            if not outcome.allowed:
                # ⚠️ 조용히 버리면 화면은 상대가 안 받은 줄 모르고 기다립니다.
                await websocket.send_json(
                    {"kind": "refused", "code": outcome.code, "reason": outcome.reason}
                )
    except WebSocketDisconnect:
        pass
    finally:
        await call_rooms.rooms.part(meeting_id, peer.connection_id)
        await call_rooms.rooms.announce(meeting_id)


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


# ══════════════════════════════════════════════════════════════
# 개인 삭제 요청 (docs/07 P6)
# ══════════════════════════════════════════════════════════════


class RevokeOut(BaseModel):
    #: 지운 원본 오디오 자산 수
    deleted_assets: int
    #: 폐기한 성문 수
    revoked_voiceprints: int
    #: 확보한 디스크 (바이트)
    freed_bytes: int
    #: 지우지 못한 것. 비어 있지 않으면 **다시 요청해야 한다.**
    failed: dict[int, str]
    #: 남은 것과 그 이유. 사람이 "다 지워졌다" 고 오해하면 안 된다.
    kept: list[str]
    message: str


@app.post("/api/projects/{project_id}/me/data", response_model=RevokeOut)
def revoke_my_data(
    project_id: int, session: DbSession, settings: AppSettings, user: CurrentUser
) -> RevokeOut:
    """내 녹음 원본과 성문을 지운다 (docs/07 P6 — 개인 삭제 요청).

    ## 왜 이 엔드포인트가 필요했는가

    ⚠️ `revoke_user_data` 는 구현돼 있고 테스트도 있는데 **부르는 곳이
    한 곳도 없었습니다.** 즉 개인정보보호법상 삭제 요청권을 실행할 방법이
    시스템에 없었습니다 — 요청이 들어오면 사람이 DB 를 직접 손봐야 했습니다.

    ## 본인만

    남이 대신 요청할 수 없습니다. 이건 동의와 같은 성격입니다 —
    `ConsentIn` 에서 `user_id` 를 뺀 것과 같은 이유입니다. 남의 자료를
    지울 수 있으면 **기여도 근거를 남이 없앨 수 있습니다.**

    관리자 대행 경로도 두지 않습니다. 이 시스템에 관리자 등급이 없고,
    있는 척하면 그게 곧 우회로입니다.

    ## 무엇이 남는가

    전사 텍스트는 **남깁니다.** 그건 다른 참석자의 회의록이기도 합니다 —
    한 사람의 요청으로 팀 전체의 회의 기록이 사라지면 안 됩니다.
    발화에서 화자 연결만 끊는 것은 별도 정책이고, 지금은 하지 않습니다.

    ## ⚠️ 남은 문제 — 기여도 화면이 이 둘을 구분하지 못한다

    원본이 지워지면 그 사람의 회의 기여는 **측정 불가**가 됩니다
    (`docs/05` §5 — 측정 불가는 0점이 아니다). 그건 맞는 처리지만,
    화면에서 이게 **"폰이 죽어서 못 쟀다" 와 똑같이 보입니다.**

    그래서 이론상 "회의에서 말을 안 했다" 를 감추는 데 쓸 수 있습니다.
    삭제는 법적 권리라 막을 수 없고, 대신 **감사 로그에 남습니다**
    (`user_data_revoked`). 화면이 그 둘을 구분해 말하도록 만드는 것은
    아직 안 했습니다 — PR 본문 C 절에 적어 두었습니다.
    """
    _require_project_member(session, project_id, user)

    report = retention.revoke_user_data(
        session,
        user_id=user.id,
        project_id=project_id,
        storage_root=settings.audio_storage_root,
    )

    kept = [
        "전사 텍스트 — 다른 참석자의 회의록이기도 하므로 남깁니다",
        "칸반 업무와 GitHub 활동 기록 — 음성이 아니라 작업 기록입니다",
    ]

    if report.failed:
        message = (
            f"일부를 지우지 못했습니다 ({len(report.failed)}건). "
            "다시 요청해 주세요 — 남아 있는 것은 그대로입니다."
        )
    elif not report.deleted_assets and not report.revoked_voiceprints:
        # ⭐ "0건 삭제" 를 성공으로만 답하면 사람은 지워진 줄 압니다.
        message = "지울 녹음이 없습니다. 이 프로젝트에 남아 있던 음성 자료가 없습니다."
    else:
        message = (
            f"녹음 원본 {len(report.deleted_assets)}건과 "
            f"성문 {len(report.revoked_voiceprints)}건을 지웠습니다."
        )

    logger.info(
        "개인 삭제 요청 user=%s project=%s — 오디오 %d건, 성문 %d건, 실패 %d건",
        user.id,
        project_id,
        len(report.deleted_assets),
        len(report.revoked_voiceprints),
        len(report.failed),
    )

    return RevokeOut(
        deleted_assets=len(report.deleted_assets),
        revoked_voiceprints=len(report.revoked_voiceprints),
        freed_bytes=report.freed_bytes,
        failed=report.failed,
        kept=kept,
        message=message,
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
        session,
        meeting_id,
        ended_at=datetime.now(UTC),
        # 쓸 수 없는 녹음이어도 파일은 디스크에 있다. 보존 대상으로
        # 등록해야 삭제 잡이 닿는다.
        store=_chunk_store(settings),
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


class UnresolvedIssueOut(BaseModel):
    """회의에서 답이 안 난 것 하나.

    근거 발화를 같이 싣습니다 — 근거 없이 &#34;이게 미해결입니다&#34; 라고만
    하면 사람은 확인할 방법이 없고, 이 저장소는 그런 값을 화면에
    올리지 않기로 했습니다.
    """

    content: str
    #: 언제 나온 얘기인가. 근거가 없으면 둘 다 0 — 시각을 지어내지 않는다.
    start_ms: int
    end_ms: int
    evidence_utterance_ids: list[int]


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
    # 다음 회의에서 다룰 안건 (결함 110).
    #
    # ⚠️ 여기 없던 동안 이 값은 **DB 까지만 갔습니다.** LLM 이 만들고
    # `validation` 이 근거까지 확인한 산출물인데, 내보내는 코드가 저장소
    # 어디에도 없어서 **읽는 사람이 0명**이었습니다. 회의록의 절반이
    # 조용히 사라지고 있었고 오류는 안 났습니다.
    next_agenda: list[str] = []
    # 회의에서 답이 안 난 것 (결함 111). `meeting_events` 의
    # `unanswered_question` 행입니다 — 그 표도 **쓰기만 하고 읽는 곳이
    # 0곳**이었습니다.
    unresolved_issues: list[UnresolvedIssueOut] = []


@app.get("/api/meetings/{meeting_id}", response_model=MeetingDetail)
def get_meeting(meeting_id: int, session: DbSession, user: CurrentUser) -> MeetingDetail:
    """회의 하나. 승인 화면이 회의 요약을 보여주려면 이게 필요하다.

    요약은 이 시스템이 회의에서 만들어 내는 대표 산출물인데, 이 엔드포인트가
    생기기 전까지는 **DB 에 저장조차 되지 않았다.** 파이프라인이 만들어
    Celery 페이로드에 실어 보낸 뒤 저장 태스크가 읽지 않고 버렸다.
    """
    meeting = _load_meeting_for(session, meeting_id, user)

    # ⚠️ **회의록은 요약 하나가 아닙니다** (결함 110·111). 다음 안건과
    # 미해결 사안도 LLM 이 만들고 검증까지 통과한 산출물인데, 여기서
    # 안 실으면 DB 에만 남고 아무도 못 봅니다 — 위 docstring 이 말하는
    # 그 일이 **같은 회의의 다른 칸에서 그대로 반복되고 있었습니다.**
    issues = session.scalars(
        select(m.MeetingEvent)
        .where(
            m.MeetingEvent.meeting_id == meeting.id,
            m.MeetingEvent.event_type == "unanswered_question",
        )
        .order_by(m.MeetingEvent.start_ms, m.MeetingEvent.id)
    ).all()

    return MeetingDetail(
        id=meeting.id,
        project_id=meeting.project_id,
        title=meeting.title,
        status=meeting.status,
        started_at=meeting.started_at,
        capture_mode=meeting.capture_mode,
        summary=meeting.summary,
        next_agenda=list(meeting.next_agenda or []),
        unresolved_issues=[
            UnresolvedIssueOut(
                content=str(row.detail.get("content", "")),
                start_ms=row.start_ms,
                end_ms=row.end_ms,
                evidence_utterance_ids=list(row.evidence_utterance_ids or []),
            )
            for row in issues
        ],
    )


class MeetingProgressOut(BaseModel):
    """회의 처리가 어디까지 갔는가.

    ⚠️ `stage` 가 `None` 이면 **모르는 것**입니다. 0% 가 아닙니다 —
    아직 못 받았을 수도, 이미 끝났을 수도, 이 배포에 Redis 가 없을
    수도 있습니다. 화면이 그 셋을 "멈춰 있다" 로 읽으면 안 됩니다.
    """

    stage: str | None = None
    percent: int | None = None
    detail: str = ""
    #: 화면에 그대로 쓸 한 줄. 서버와 화면이 **같은 문장**을 씁니다.
    message: str
    #: 지금 다시 처리할 수 있는가 (결함 114).
    #
    # ⚠️ **판단을 서버가 합니다.** 화면이 상태를 보고 스스로 정하면
    # "언제 다시 처리할 수 있는가" 규칙이 두 곳에 생기고 한쪽만
    # 고쳐집니다 — `progress` 문구를 서버가 만드는 것과 같은 이유입니다.
    can_reprocess: bool = False


class ReprocessOut(BaseModel):
    meeting_id: int
    status: str
    #: 화면에 그대로 쓸 한 줄.
    message: str


@app.post("/api/meetings/{meeting_id}/reprocess", response_model=ReprocessOut)
def reprocess_meeting(
    meeting_id: int, session: DbSession, user: CurrentUser
) -> ReprocessOut:
    """실패한 회의를 **다시 처리한다** (결함 114).

    ⭐ `failed` 는 **막다른 길이었습니다.** 회의 상태를 쓰는 곳은 다섯인데
    (`queued`·`processing`·`failed`·`needs_review`·`confirmed`) **아무도
    `pending` 으로 되돌리지 않았고**, `try_finalize_meeting` 은
    `status != "pending"` 이면 큐에 넣지 않습니다.

    그런데 화면은 이렇게 말하고 있었습니다.

        처리에 실패했습니다 — 트랙이 온전한지 확인하세요   (actionable: true)

    사람이 가서 확인하고 **트랙이 멀쩡해도 할 수 있는 일이 없었습니다.**
    결함 112 와 같은 모양입니다 — 할 일을 알려 주고 그 일을 할 자리를
    안 주는 것.

    실패는 일시적인 이유로도 납니다(GPU 를 못 잡음·조각 하나가 깨짐·
    워커가 죽음). 그때마다 **그 회의의 기여가 전원에게 영영 빕니다.**

    ## 다시 도는 것이 안전한 이유

    `persist_results_task` 는 재처리 경로를 이미 갖고 있습니다 — 앞판의
    발화·후보·결정·회의 이벤트를 지우고, 발화를 지우기 **전에** 그
    발화에서 나온 기여 이벤트를 먼저 잊습니다. 안 그러면 다시 돌 때마다
    점수가 누적됩니다.

    ⚠️ **사람이 이미 판단한 회의는 거절합니다.** 태스크도 같은 이유로
    `already_reviewed` 를 돌려주지만, 그건 큐에 들어간 **뒤**라 화면에는
    &#34;다시 처리를 시작했습니다&#34; 로 보이고 아무 일도 안 일어납니다.
    여기서 미리 막고 이유를 말합니다.
    """
    meeting = _load_meeting_for(session, meeting_id, user)

    if meeting.status not in ("failed", "queued"):
        # ⚠️ 문구에 `meeting.status` 를 넣지 않습니다. 그건 내부 enum 이고,
        # 그대로 띄우면 결함 78·86 이 반복됩니다. 한국어 어휘표는 화면이
        # 들고 있으므로(`lib/home/next.ts`), 서버는 **조건**만 말합니다.
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "처리에 실패했거나 큐에 걸린 회의만 다시 처리할 수 있습니다",
        )

    reviewed = session.scalar(
        select(func.count())
        .select_from(m.MeetingTaskCandidate)
        .where(
            m.MeetingTaskCandidate.meeting_id == meeting_id,
            m.MeetingTaskCandidate.review_status != "pending",
        )
    )
    if reviewed:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"이미 검토한 업무 후보가 {reviewed}건 있습니다. "
            "다시 처리하면 그 근거가 끊어지므로, 먼저 검토를 되돌려야 합니다",
        )

    before = meeting.status
    meeting.status = "queued"
    session.add(
        m.AuditLog(
            project_id=meeting.project_id,
            actor_id=user.id,
            action="meeting_reprocess_requested",
            target=f"meetings/{meeting_id}",
            before={"status": before},
            after={"status": "queued"},
            at=datetime.now(UTC),
        )
    )
    _enqueue_after_commit(session, meeting_id)

    return ReprocessOut(
        meeting_id=meeting_id,
        status="queued",
        message="다시 처리를 시작했습니다. 잠시 뒤 이 화면을 새로고침하세요.",
    )


@app.get("/api/meetings/{meeting_id}/progress", response_model=MeetingProgressOut)
def get_meeting_progress(
    meeting_id: int, session: DbSession, user: CurrentUser
) -> MeetingProgressOut:
    """처리가 어디까지 갔는지 (감사 #8).

    `pipeline/steps.py` 의 `RedisProgress` 는 처음부터 진행률을 쓰고
    있었고 그 docstring 은 "API가 SSE로 프런트에 흘린다" 고 적어 두고
    있었습니다. **그 API 가 없었습니다.** 쓰기만 하고 읽는 곳이 0곳이라,
    1시간 회의를 10분 처리하는 동안 화면이 할 수 있는 말은 "처리 중"
    뿐이었습니다 — 멈춘 건지 도는 건지도 몰랐습니다.

    ⚠️ **SSE 가 아니라 읽기 엔드포인트입니다.** 로비는 이미 3초마다
    폴링하고, 이 저장소는 그 이유를 `lobby.ts` 에 적어 뒀습니다 —
    "SSE·WebSocket 을 붙이면 서버에 상태가 생기고, 그건 이 화면 하나
    때문에 지불하기엔 비쌉니다." 그 판단을 뒤집을 이유가 없습니다.
    """
    meeting = _load_meeting_for(session, meeting_id, user)
    client = progress_service.progress_client(get_settings().redis_url)
    progress = progress_service.read_progress(client, meeting_id)
    return MeetingProgressOut(
        stage=progress.stage if progress else None,
        percent=progress.percent if progress else None,
        detail=progress.detail if progress else "",
        message=progress_service.describe(progress, meeting_status=meeting.status),
        can_reprocess=meeting.status in ("failed", "queued"),
    )


# ══════════════════════════════════════════════════════════════
# 회의 업무 후보 검토 (이어서)
# ══════════════════════════════════════════════════════════════


class MemberOut(BaseModel):
    user_id: int
    name: str
    role_shares: dict[str, float]
    # 이 사람의 GitHub 아이디 (결함 112). 안 이었으면 None —
    # 화면이 "아직 연결 안 됨" 으로 그립니다.
    github_login: str | None = None


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
            github_login=member.github_login,
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


class RoleIn(BaseModel):
    """역할 비중. `{"developer": 0.7, "planner": 0.3}` 처럼 겸직도 된다."""

    role_shares: dict[str, float]

    model_config = {"extra": "forbid"}


class GithubLoginIn(BaseModel):
    """내 GitHub 아이디 (결함 112).

    빈 문자열은 **연결 해제**입니다 — 잘못 적었을 때 지울 방법이 있어야
    합니다. 그래서 `None`(안 건드림)과 `""`(지움)을 구분합니다.
    """

    github_login: str | None = None

    model_config = {"extra": "forbid"}


@app.patch("/api/projects/{project_id}/members/me", response_model=MemberOut)
def set_my_role(
    project_id: int, payload: RoleIn, session: DbSession, user: CurrentUser
) -> MemberOut:
    """**내** 역할을 정한다.

    ## 왜 필요한가

    가입도 초대도 `role_shares={"developer": 1.0}` 을 하드코딩하고 있었고,
    이걸 바꾸는 API 도 화면도 없었습니다. 그래서 `PLANNER`·`DESIGNER`
    프로파일과 `blended_profile` 은 **실사용 경로로 도달 불가**였고,
    기획자·디자이너 팀원의 기여도가 **개발자 가중치로** 계산됐습니다.

    기획자 프로파일은 코드 0% · 문서 30% 인데 개발자로 계산하면 코드 35% ·
    문서 5% 입니다. 문서만 쓴 사람이 이유 없이 낮게 나옵니다 — 그리고
    **오류는 어디에도 안 납니다.**

    ## ⚠️ 본인만 바꿉니다

    역할은 가중치를 바꾸고, 가중치는 점수를 바꿉니다. 남이 내 역할을
    바꿀 수 있으면 그건 **남의 점수를 바꾸는 일**입니다. 업무를 옮기는
    것(누구나 가능)과 다릅니다 — 업무는 사실의 기록이고 역할은 판단의
    전제입니다.

    그래서 경로가 `/members/me` 입니다. 남의 id 를 넣을 자리 자체가
    없습니다 — 요청 본문의 id 를 믿던 결함(`member_ids`)과 같은 부류를
    설계로 막습니다.

    바꾼 사실은 감사 로그에 남습니다. 역할을 유리한 쪽으로 옮겨 두는
    것도 조작이고, 그건 사람이 볼 수 있어야 합니다.
    """
    from teamflow.contribution.profiles import clean_role_shares

    if session.get(m.Project, project_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "프로젝트를 찾을 수 없습니다")
    _require_project_member(session, project_id, user)

    try:
        cleaned = clean_role_shares(payload.role_shares)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    member = session.scalars(
        select(m.Member).where(
            m.Member.project_id == project_id, m.Member.user_id == user.id
        )
    ).one()
    before = dict(member.role_shares or {})
    member.role_shares = cleaned

    if before != cleaned:
        session.add(
            m.AuditLog(
                project_id=project_id,
                actor_id=user.id,
                action="weights_changed",
                target=f"members/{user.id}",
                before={"role_shares": before},
                after={"role_shares": cleaned},
                at=datetime.now(UTC),
            )
        )
    session.flush()

    return MemberOut(
        user_id=user.id,
        name=user.name,
        role_shares={k: float(v) for k, v in cleaned.items()},
        github_login=member.github_login,
    )


@app.patch("/api/projects/{project_id}/members/me/github", response_model=MemberOut)
def set_my_github_login(
    project_id: int, payload: GithubLoginIn, session: DbSession, user: CurrentUser
) -> MemberOut:
    """내 GitHub 아이디를 이 프로젝트의 나에게 잇는다 (결함 112).

    ⭐ **이 칸에 값을 넣는 코드가 저장소에 0곳이었습니다.** 읽는 곳은
    넷인데(이벤트 배분·백필·업무↔PR·연결 진단) 쓰는 곳은 시드와
    테스트뿐이었습니다. 실제로 배포하면 이 칸은 영원히 NULL 이고,
    그러면 **아무의 PR 도 주인을 못 찾습니다** — 오류 없이 기여도만
    빕니다. 연결 진단은 이미 "GitHub 계정을 연결하지 않은 팀원이
    있습니다" 라고 경고하고 있었는데, **연결할 자리가 없었습니다.**

    ## 남의 아이디를 못 쓰게 한다

    ⚠️ 이건 예의 문제가 아니라 **점수 문제**입니다. 남의 로그인을 적으면
    그 사람의 PR·리뷰가 통째로 내 기여로 들어옵니다. 그래서 한 프로젝트
    안에서 같은 아이디를 둘이 쓸 수 없습니다 — **대소문자를 무시하고**
    비교합니다(`MinSu` 와 `minsu` 는 GitHub 에서 같은 사람입니다).

    ⚠️ 이 검사가 **소유 증명은 아닙니다.** 아무도 안 쓴 아이디라면 남의
    것이라도 적을 수 있습니다. 진짜 증명은 GitHub OAuth 가 필요한데
    이 환경에는 네트워크가 없습니다 — `docs/17` §C 에 적어 뒀습니다.
    대신 **바꿀 때마다 감사 로그에 남깁니다.** 기여도 분쟁에서 필요한
    것은 지금 값이 아니라 누가 언제 그렇게 적었는가입니다.

    경로가 `/members/me/...` 인 것은 역할 저장과 같은 이유입니다 —
    **남의 id 를 넣을 자리 자체를 안 만듭니다.**
    """
    from teamflow.github.identity import clean_github_login, same_login

    if session.get(m.Project, project_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "프로젝트를 찾을 수 없습니다")
    _require_project_member(session, project_id, user)

    try:
        cleaned = clean_github_login(payload.github_login)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    members = session.scalars(
        select(m.Member).where(m.Member.project_id == project_id)
    ).all()
    mine = next(row for row in members if row.user_id == user.id)

    if cleaned is not None:
        taken = any(
            row.user_id != user.id and same_login(row.github_login, cleaned)
            for row in members
        )
        if taken:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                # ⚠️ 조사를 붙이지 않는 문장으로 씁니다. 아이디는 영문·숫자로
                # 끝나 받침이 갈리는데, 서버에는 조사 계산기가 없습니다 —
                # 만들면 화면과 **두 벌**이 됩니다. `josa.ts` 가 스스로
                # 권하는 대로 문장을 바꾸는 쪽을 택했습니다.
                f"'{cleaned}' — 이 프로젝트의 다른 팀원이 이미 쓰고 있는 아이디입니다",
            )

    before = mine.github_login
    mine.github_login = cleaned

    if before != cleaned:
        # ⭐ **누가 어떤 GitHub 계정을 자기 것이라고 했는가**를 남긴다.
        # 이 한 줄이 바뀌면 그 사람의 기여도가 통째로 바뀝니다.
        session.add(
            m.AuditLog(
                project_id=project_id,
                actor_id=user.id,
                action="github_login_changed",
                target=f"members/{user.id}",
                before={"github_login": before},
                after={"github_login": cleaned},
                at=datetime.now(UTC),
            )
        )
    session.flush()

    return MemberOut(
        user_id=user.id,
        name=user.name,
        role_shares={k: float(v) for k, v in (mine.role_shares or {}).items()},
        github_login=mine.github_login,
    )


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


class UtteranceOut(BaseModel):
    """근거 발화 한 줄 — **원문과 그 원문을 얼마나 믿을 수 있는가**."""

    id: int
    start_ms: int
    end_ms: int
    text: str
    speaker_id: int | None
    # 이름을 같이 보냅니다. id 만 주면 화면이 명단을 또 받아 와야 하고,
    # 그 명단이 낡으면 같은 발화에 다른 이름이 붙습니다.
    speaker_name: str | None
    # ⚠️ **이 둘을 빼면 안 됩니다.** 화자가 어떻게 정해졌는지가
    # `track`(멀티트랙 확정)인지 `diarization`(미매핑)인지에 따라
    # "누가 말했다" 의 무게가 완전히 다릅니다. 원문만 보여 주고 출처를
    # 감추면, 추측한 화자를 사실처럼 읽게 됩니다.
    speaker_source: str
    speaker_confidence: float | None
    is_overlap: bool
    utterance_type: str | None


@app.get("/api/meetings/{meeting_id}/utterances", response_model=list[UtteranceOut])
def list_utterances(
    meeting_id: int,
    session: DbSession,
    user: CurrentUser,
    ids: str = "",
) -> list[UtteranceOut]:
    """근거 발화의 **원문**. 업무 후보의 `근거 #5` 를 눌렀을 때 펼칠 것.

    ## 왜 이 엔드포인트가 필요했나

    이 제품의 대표 주장은 "기여도 숫자에서 출발해 어느 회의 몇 번째
    발언까지 거슬러 올라갈 수 있다" 입니다. 그런데 발화 **번호**는
    후보에 실려 있었지만 그 번호로 **원문을 가져올 방법이 없었습니다** —
    화면은 `근거 #5` 라고 적어 놓고 눌러도 아무 데도 못 갔습니다.
    말은 하고 그 말을 지킬 자리를 안 준 것입니다.

    ## `ids` 로만 가져옵니다

    회의 전체 대본을 주지 않습니다. 40분 회의면 발화가 수백 개인데,
    지금 필요한 것은 **이 후보의 근거 두세 개**입니다. 전체 대본을 보는
    화면은 아직 없고, 없는 것을 위해 엔드포인트를 넓혀 두지 않습니다.

    ⚠️ **못 찾은 id 를 조용히 버립니다** — 대신 화면이 알 수 있게
    합니다. 셋을 물었는데 둘이 오면 하나는 이 회의에 없는 것이고,
    그건 후보가 남의 회의 발화를 가리키고 있다는 뜻이라 **숨기면 안 되는
    사실**입니다. 서버가 지어내서 채우지 않고, 화면이 세어서 말합니다.
    """
    _load_meeting_for(session, meeting_id, user)

    wanted: list[int] = []
    for raw in ids.split(","):
        raw = raw.strip()
        if not raw:
            continue
        try:
            wanted.append(int(raw))
        except ValueError:
            # 숫자가 아닌 것은 조용히 버리지 않고 막습니다. 오타 하나로
            # 엉뚱한 결과를 받아 들고 "근거가 없다" 고 읽으면 안 됩니다.
            raise HTTPException(
                status_code=400, detail="ids는 쉼표로 구분한 정수여야 합니다"
            ) from None
    if not wanted:
        return []
    # 상한. 근거는 보통 한둘이고, 목록이 길면 그건 대본 전체를 떠 가려는
    # 것입니다 — 그 화면은 아직 없습니다.
    if len(wanted) > 50:
        raise HTTPException(status_code=400, detail="한 번에 50개까지만 가져올 수 있습니다")

    rows = (
        session.query(m.Utterance)
        .filter(m.Utterance.meeting_id == meeting_id, m.Utterance.id.in_(wanted))
        .order_by(m.Utterance.start_ms, m.Utterance.id)
        .all()
    )

    speaker_ids = {r.speaker_id for r in rows if r.speaker_id is not None}
    names: dict[int, str] = {}
    if speaker_ids:
        names = {
            u.id: u.name
            for u in session.query(m.User).filter(m.User.id.in_(speaker_ids)).all()
        }

    return [
        UtteranceOut(
            id=r.id,
            start_ms=r.start_ms,
            end_ms=r.end_ms,
            text=r.text,
            speaker_id=r.speaker_id,
            speaker_name=names.get(r.speaker_id) if r.speaker_id is not None else None,
            speaker_source=r.speaker_source,
            speaker_confidence=(
                float(r.speaker_confidence) if r.speaker_confidence is not None else None
            ),
            is_overlap=r.is_overlap,
            utterance_type=r.utterance_type,
        )
        for r in rows
    ]


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

    # ── 연결 기록 ──────────────────────────────────────────────
    #
    # ⚠️ **저장할 이벤트인지 판단하기 전에** 합니다. 배달이 왔다는 사실
    # 자체가 "이 저장소에 App 이 설치돼 있다" 는 증거이고, 그 증거는
    # 우리가 그 이벤트를 쓰든 말든 똑같이 유효합니다.
    #
    # 특히 `ping` — App 을 설치하면 GitHub 이 **가장 먼저** 보내는 것이고
    # 아래 `normalize` 는 이걸 버립니다. 여기서 안 잡으면 방금 연결을 마친
    # 팀에게도 "아직 아무 배달도 없습니다" 가 나갑니다.
    delivered_repo = (payload.get("repository") or {}).get("full_name")
    project = None
    if delivered_repo:
        project = github_connection_service.record_delivery(
            session,
            repo=delivered_repo,
            installation_id=(payload.get("installation") or {}).get("id"),
        )

    normalized = gh.normalize(x_github_event, x_github_delivery, payload)
    if normalized is None:
        return {"status": "ignored", "event": x_github_event}

    if project is None:
        # 연결되지 않은 저장소. 조용히 무시한다 — 존재 여부를 알려주지 않는다.
        #
        # 다만 **흔적은 남겼습니다**(`record_delivery`). 그게 없으면 저장소
        # 이름 오타는 증거를 남기지 않고, 팀은 기여도가 왜 비는지 영원히
        # 알 수 없습니다. 남기는 것은 저장소 이름과 횟수뿐입니다.
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

    # ── 업무 ↔ PR 잇기 ────────────────────────────────────────
    #
    # docs/08 §5.1 필수 경로의 "관련 PR 병합 → 업무 카드에 수행 근거 표시".
    # `task_github_links` 표는 처음부터 있었는데 **행이 한 번도 쓰인 적이
    # 없었습니다** — 잇는 코드가 0곳이었습니다.
    #
    # ⚠️ 워커가 아니라 **여기서** 하는 이유는
    # `services/task_link_service.py` 모듈 주석에 있습니다. 요약하면
    # 워커 경로가 GitHub App 자격 증명이 없으면 통째로 건너뛰는데,
    # 연결에는 API 도 자격 증명도 필요 없기 때문입니다.
    linked = task_link_service.link_pull_request(session, row)

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
        "linked_tasks": [ref.task_id for ref in linked],
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


class TaskGithubOut(BaseModel):
    """이 업무로 이어진 GitHub 활동.

    ⚠️ **근거(`why`)를 같이 싣습니다.** 연결만 보여주면 사람은 그걸 믿을지
    말지 정할 수 없고, 틀린 연결을 고칠 수도 없습니다. `#12` 로 추정한
    것과 `TASK-12` 가 적혀 있던 것은 신뢰도가 다릅니다.
    """

    event_id: int
    repo: str
    #: PR 번호. 본문에서 못 읽으면 None.
    number: int | None
    title: str | None
    actor_login: str
    merged_at: datetime
    #: 1.0 이면 확정, 그 아래는 추정.
    relevance: float
    confirmed: bool
    why: str


class TaskOut(BaseModel):
    id: int
    title: str
    assignee_id: int | None
    status: str
    deadline: date | None
    completed_at: datetime | None
    origin: TaskOriginOut | None
    #: 사람이 PR 에 적어야 하는 표식. 안 보여주면 아무도 안 적습니다.
    marker: str = ""
    github: list[TaskGithubOut] = Field(default_factory=list)


class TaskBoardOut(BaseModel):
    project_id: int
    statuses: list[str]
    tasks: list[TaskOut]


def _github_for_tasks(
    session: Session, task_ids: list[int]
) -> dict[int, list[TaskGithubOut]]:
    out: dict[int, list[TaskGithubOut]] = {}
    for task_id, pairs in task_link_service.links_for_tasks(session, task_ids).items():
        # `event` 로 이름 짓지 않습니다 — 이 모듈은 sqlalchemy 의 `event` 를
        # import 하고 있어서 조용히 가려집니다.
        for link, row in pairs:
            pull = (row.payload or {}).get("pull_request") or {}
            relevance = float(link.relevance)
            out.setdefault(task_id, []).append(
                TaskGithubOut(
                    event_id=row.id,
                    repo=row.repo,
                    number=pull.get("number"),
                    title=pull.get("title"),
                    actor_login=row.actor_login,
                    merged_at=row.occurred_at,
                    relevance=relevance,
                    confirmed=relevance >= gh_linking.CONFIRMED_THRESHOLD,
                    why=gh_linking.describe_source(link.link_source),
                )
            )
    return out


@app.get("/api/projects/{project_id}/tasks", response_model=TaskBoardOut)
def list_tasks(project_id: int, session: DbSession, user: CurrentUser) -> TaskBoardOut:
    """칸반 보드가 읽는 목록.

    **어느 회의에서 나왔는지와 어느 PR 로 끝났는지를 같이 싣습니다.** 그게
    없으면 이 화면은 그냥 할 일 목록이고, 이 프로젝트의 주장
    (회의 결정 → 칸반 업무 → GitHub 활동)을 화면에서 확인할 방법이 없습니다.
    """
    if session.get(m.Project, project_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "프로젝트를 찾을 수 없습니다")
    _require_project_member(session, project_id, user)

    rows = task_service.list_tasks(session, project_id)
    github = _github_for_tasks(session, [row["id"] for row in rows])

    return TaskBoardOut(
        project_id=project_id,
        statuses=list(task_service.STATUSES),
        tasks=[
            TaskOut(
                **row,
                marker=gh_linking.task_marker(row["id"]),
                github=github.get(row["id"], []),
            )
            for row in rows
        ],
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


class FinalIn(BaseModel):
    """확정 한 건. `final_value` 를 안 보내면 시스템 값을 그대로 받아들인다."""

    user_id: int
    final_value: float | None = None
    reason: str | None = None

    model_config = {"extra": "forbid"}


class FinalsIn(BaseModel):
    finals: list[FinalIn]

    model_config = {"extra": "forbid"}


class FinalOut(BaseModel):
    user_id: int
    system_value: float
    final_value: float
    adjusted_by: int | None
    reason: str | None
    confirmed_at: datetime


class FinalsOut(BaseModel):
    run_id: int
    finals: list[FinalOut]
    notice: str = (
        "이 값은 사람이 확정한 것입니다. 시스템 값과 다르면 그 이유가 함께 남습니다."
    )


@app.get("/api/projects/{project_id}/contributions/final", response_model=FinalsOut)
def read_final_contributions(
    project_id: int, session: DbSession, user: CurrentUser
) -> FinalsOut:
    """확정된 기여도. 아직 확정 전이면 `run_id: 0` 에 빈 목록."""
    if session.get(m.Project, project_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "프로젝트를 찾을 수 없습니다")
    _require_project_member(session, project_id, user)

    rows = session.scalars(
        select(m.FinalContribution).where(m.FinalContribution.project_id == project_id)
    ).all()
    return FinalsOut(
        run_id=rows[0].run_id if rows else 0,
        finals=[
            FinalOut(
                user_id=r.user_id,
                system_value=float(r.system_value),
                final_value=float(r.final_value),
                adjusted_by=r.adjusted_by,
                reason=r.reason,
                confirmed_at=r.confirmed_at,
            )
            for r in sorted(rows, key=lambda r: r.user_id)
        ],
    )


@app.post(
    "/api/projects/{project_id}/contributions/final",
    response_model=FinalsOut,
    status_code=status.HTTP_201_CREATED,
)
def confirm_contributions(
    project_id: int, payload: FinalsIn, session: DbSession, user: CurrentUser
) -> FinalsOut:
    """**사람이** 기여도를 확정한다.

    `docs/05` §5 는 "최종 점수를 시스템이 확정" 을 ❌ 로 금지합니다. 그런데
    확정을 남길 자리가 API 에도 화면에도 없어서, 배포 상태에서 존재하는
    값은 시스템이 계산한 숫자뿐이었습니다 — 금지한 쪽으로 실제 동작한
    것입니다.

    ## 여기서 지키는 것

    · **시스템 값을 지우지 않습니다.** `system_value` 와 `final_value` 를
      나란히 남깁니다. 둘이 다르면 나중에 "왜 달랐나" 를 물을 수 있습니다
    · **누가 바꿨는지 남깁니다** (`adjusted_by`). 조정은 판단이고, 판단에는
      주체가 있어야 이의를 제기할 상대가 생깁니다
    · **바꿨으면 이유를 받습니다.** 시스템 값과 다른데 이유가 없으면
      거절합니다 — 근거 없는 조정은 근거 없는 점수와 같습니다
    · 확정 시점의 계산을 `score_runs`·`score_results` 로 **못 박습니다**.
      안 그러면 확정 뒤에 이벤트가 하나 더 들어오는 것만으로 확정값이
      가리키던 근거가 달라집니다

    ⚠️ **누가 확정할 수 있는가** — 지금은 **구성원 누구나**입니다. 이
    저장소에 팀장·교수 역할 개념이 아직 없습니다. 남의 업무를 옮기는 것도
    같은 규칙이고(그리고 감사 로그에 남고), 여기도 `adjusted_by` 로
    남습니다. 역할이 생기면 여기부터 좁혀야 합니다.
    """
    from teamflow.services import scoring_service

    if session.get(m.Project, project_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "프로젝트를 찾을 수 없습니다")
    _require_project_member(session, project_id, user)

    result = scoring_service.compute(session, project_id)
    if not result.members:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "확정할 기여도가 없습니다. 활동 기록이 하나도 없습니다",
        )

    members = {
        uid
        for uid in session.scalars(
            select(m.Member.user_id).where(m.Member.project_id == project_id)
        ).all()
    }
    unknown = sorted({f.user_id for f in payload.finals} - members)
    if unknown:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"이 프로젝트의 구성원이 아닙니다: {unknown}"
        )

    now = datetime.now(UTC)
    run = scoring_service.persist_run(session, project_id, result, now=now)

    # 확정은 **덮어쓴다**. 다시 확정하면 새 run 을 가리키게 된다 —
    # 이전 확정이 어떤 계산 위에서 이뤄졌는지는 감사 로그에 남는다.
    existing = {
        row.user_id: row
        for row in session.scalars(
            select(m.FinalContribution).where(
                m.FinalContribution.project_id == project_id
            )
        ).all()
    }

    for item in payload.finals:
        score = result.members.get(item.user_id)
        # 계산 결과에 없는 구성원 = 활동 기록이 0건. 시스템 값은 0 이지만
        # 그건 "안 했다" 가 아니라 "이 계산에 잡힌 게 없다" 다.
        system_value = round(score.share, 3) if score else 0.0
        final_value = system_value if item.final_value is None else item.final_value

        if abs(final_value - system_value) > 1e-9 and not (item.reason or "").strip():
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"시스템 값과 다르게 확정하려면 이유가 필요합니다 (user_id={item.user_id})",
            )

        row = existing.get(item.user_id)
        before = (
            {"final_value": float(row.final_value), "run_id": row.run_id} if row else None
        )
        if row is None:
            row = m.FinalContribution(project_id=project_id, user_id=item.user_id)
            session.add(row)
        row.run_id = run.id
        row.system_value = system_value
        row.final_value = final_value
        row.adjusted_by = user.id
        row.reason = (item.reason or "").strip() or None
        row.confirmed_at = now

        session.add(
            m.AuditLog(
                project_id=project_id,
                actor_id=user.id,
                action="score_adjusted",
                target=f"final_contributions/{project_id}:{item.user_id}",
                before=before,
                after={
                    "run_id": run.id,
                    "system_value": system_value,
                    "final_value": final_value,
                    "reason": row.reason,
                },
                at=now,
            )
        )

    session.flush()
    return read_final_contributions(project_id, session, user)


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
# 보고서 — 회의록 · 주간 · 최종
# ══════════════════════════════════════════════════════════════


class ReportOut(BaseModel):
    id: int
    report_type: str
    meeting_id: int | None
    period_start: datetime | None
    period_end: datetime | None
    generated_at: datetime
    #: 블록 목록. 구조는 `teamflow/reports/__init__.py` 머리말에 있습니다.
    content: dict[str, Any]


class ReportSummary(BaseModel):
    """목록용 — **내용은 안 실습니다.**

    보고서 하나가 꽤 큽니다. 목록에 전부 실으면 화면이 안 쓸 것을 다
    받습니다.
    """

    id: int
    report_type: str
    title: str
    meeting_id: int | None
    period_start: datetime | None
    period_end: datetime | None
    generated_at: datetime


class GenerateReportIn(BaseModel):
    """무엇을 만들 것인가.

    ⚠️ `report_type` 을 문자열로 받되 **어휘 밖이면 거절**합니다. 여기서
    느슨하게 받으면 CHECK 제약이 500 으로 튀어나옵니다 — 사용자에게는
    "서버가 고장 났다" 로 보이는데 실제로는 잘못된 요청입니다.
    """

    report_type: str
    period_start: datetime | None = None
    period_end: datetime | None = None

    model_config = {"extra": "forbid"}


def _report_summary(row: m.Report) -> ReportSummary:
    return ReportSummary(
        id=row.id,
        report_type=row.report_type,
        title=str(row.content.get("title", "")),
        meeting_id=row.meeting_id,
        period_start=row.period_start,
        period_end=row.period_end,
        generated_at=row.generated_at,
    )


@app.get("/api/projects/{project_id}/reports", response_model=list[ReportSummary])
def list_reports(
    project_id: int, session: DbSession, user: CurrentUser
) -> list[ReportSummary]:
    """이 프로젝트의 보고서 목록. 새것부터."""
    if session.get(m.Project, project_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "프로젝트를 찾을 수 없습니다")
    _require_project_member(session, project_id, user)
    return [_report_summary(row) for row in report_service.list_reports(session, project_id)]


@app.get("/api/reports/{report_id}", response_model=ReportOut)
def get_report(report_id: int, session: DbSession, user: CurrentUser) -> ReportOut:
    report = session.get(m.Report, report_id)
    if report is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "보고서를 찾을 수 없습니다")
    _require_project_member(session, report.project_id, user)
    return ReportOut(
        id=report.id,
        report_type=report.report_type,
        meeting_id=report.meeting_id,
        period_start=report.period_start,
        period_end=report.period_end,
        generated_at=report.generated_at,
        content=report.content,
    )


@app.post(
    "/api/projects/{project_id}/reports",
    response_model=ReportOut,
    status_code=status.HTTP_201_CREATED,
)
def generate_report(
    project_id: int, body: GenerateReportIn, session: DbSession, user: CurrentUser
) -> ReportOut:
    """주간·최종 보고서를 만든다.

    ⚠️ **다시 부르면 갈아끼웁니다.** 그래서 201 이지만 새 행이 안 생길 수
    있습니다 — 쌓이는 것보다 이쪽이 맞습니다. 최종 보고서가 여러 벌 있으면
    어느 것이 진짜인지 아무도 모릅니다.
    """
    if session.get(m.Project, project_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "프로젝트를 찾을 수 없습니다")
    _require_project_member(session, project_id, user)

    try:
        report_type = vocab.ReportType(body.report_type)
    except ValueError:
        allowed = ", ".join(vocab.report_values())
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"모르는 보고서 종류입니다: {body.report_type} (가능한 것: {allowed})",
        ) from None

    try:
        report = report_service.generate_period(
            session,
            project_id,
            report_type,
            period_start=body.period_start,
            period_end=body.period_end,
        )
    except (report_service.ReportError, ValueError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    session.commit()
    session.refresh(report)
    return ReportOut(
        id=report.id,
        report_type=report.report_type,
        meeting_id=report.meeting_id,
        period_start=report.period_start,
        period_end=report.period_end,
        generated_at=report.generated_at,
        content=report.content,
    )


@app.post(
    "/api/meetings/{meeting_id}/minutes",
    response_model=ReportOut,
    status_code=status.HTTP_201_CREATED,
)
def generate_minutes(
    meeting_id: int, session: DbSession, user: CurrentUser
) -> ReportOut:
    """회의록을 만든다. 회의에 매이므로 회의 쪽 주소입니다."""
    meeting = _load_meeting_for(session, meeting_id, user)
    try:
        report = report_service.generate_minutes(session, meeting.id)
    except report_service.ReportError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    session.commit()
    session.refresh(report)
    return ReportOut(
        id=report.id,
        report_type=report.report_type,
        meeting_id=report.meeting_id,
        period_start=report.period_start,
        period_end=report.period_end,
        generated_at=report.generated_at,
        content=report.content,
    )


# ══════════════════════════════════════════════════════════════
# 채널과 채팅 (요구사항 정의서 §6 · §7)
# ══════════════════════════════════════════════════════════════
#
# ⚠️ **글은 HTTP 로 쓰고, 소켓은 읽기 전용입니다.**
#
# 소켓으로 받은 것을 그대로 남에게 뿌리면 저장은 안 됐는데 화면에만 뜬
# 메시지가 생깁니다 — 새로고침하면 사라지고, 쓴 사람은 자기 말이 갔다고
# 믿습니다. 그래서 POST 가 저장하고, 저장된 뒤에 `chat_hub` 로 흘립니다.
#
# ⚠️ **기여도와 닿지 않습니다.** 정의서 §7 머리말이 채팅에 대한 AI 분석·
# 업무 자동 생성·프로젝트 분석을 금지합니다. 메시지가 기여로 세어지면
# 도배가 기여도를 올리는 방법이 됩니다 — `test_chat_is_not_measured.py`.


class ChannelIn(BaseModel):
    kind: str = Field(default="text")
    name: str = Field(min_length=1, max_length=100)


class ChannelPatch(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class ChannelOrderIn(BaseModel):
    #: ⚠️ **전체 순서**입니다. 한 칸씩 위/아래가 아닙니다 — 이유는
    #: `channel_service.reorder_channels` 머리말에.
    channel_ids: list[int]


class ChannelOut(BaseModel):
    id: int
    kind: str
    name: str
    position: int


class ReactionOut(BaseModel):
    mark: str
    #: 사람 말. ⚠️ 화면이 두 번째 표를 만들지 않게 서버가 같이 보냅니다.
    label: str
    count: int


class MessageOut(BaseModel):
    id: int
    channel_id: int
    author_id: int
    author_name: str
    #: ⚠️ 지워진 메시지는 **본문이 비어 옵니다.** 자리는 남습니다(답글이
    #: 가리키는 곳이라서) — `deleted` 를 보고 화면이 "지워진 메시지" 라고 씁니다.
    body: str
    reply_to_id: int | None
    created_at: datetime
    edited_at: datetime | None
    deleted: bool
    mentions: list[str]
    reactions: list[ReactionOut]
    #: 내가 단 반응. 없으면 `null`. 이게 없으면 누른 사람이 뗄 길을 못 찾습니다.
    my_reaction: str | None


class MessageIn(BaseModel):
    body: str = Field(min_length=1, max_length=message_service.MAX_BODY)
    reply_to_id: int | None = None


class MessageEditIn(BaseModel):
    """고칠 때는 **본문만** 받습니다.

    ⚠️ 처음에는 `MessageIn` 을 그대로 썼습니다. 그러면 화면이
    `reply_to_id` 를 같이 보낼 수 있는데 `edit_message` 는 그 칸을 안
    읽습니다 — 200 을 돌려주면서 아무 일도 안 하는 칸입니다.
    무엇에 단 답글인지는 애초에 고칠 수 있는 것이 아닙니다.
    """

    body: str = Field(min_length=1, max_length=message_service.MAX_BODY)


class ReactionIn(BaseModel):
    #: `null` 이면 뗍니다.
    mark: str | None = None


def _channel_out(channel: m.Channel) -> ChannelOut:
    return ChannelOut(
        id=channel.id,
        kind=channel.kind,
        name=channel.name,
        position=channel.position,
    )


def _messages_out(
    session: Session, rows: list[m.Message], viewer_id: int
) -> list[MessageOut]:
    """행 → 화면이 읽을 것. **한 번에 모아 옵니다.**

    ⚠️ 메시지마다 작성자·반응·멘션을 따로 물으면 50건에 150번을 묻습니다.
    """
    ids = [row.id for row in rows]
    authors = {
        int(user_id): str(name)
        for user_id, name in session.execute(
            select(m.User.id, m.User.name).where(
                m.User.id.in_({row.author_id for row in rows} or {0})
            )
        ).all()
    }
    reactions = message_service.reactions_for(session, ids)
    mine = message_service.mine_for(session, ids, viewer_id)
    mentions = message_service.mentioned_names(session, ids)

    return [
        MessageOut(
            id=row.id,
            channel_id=row.channel_id,
            author_id=row.author_id,
            author_name=authors.get(row.author_id, "알 수 없음"),
            # ⚠️ 지운 글의 본문은 **서버에서** 뺍니다. 화면에 보내 놓고
            #    화면이 가리게 하면, 개발자 도구를 열면 그대로 보입니다.
            body="" if row.deleted_at is not None else row.body,
            reply_to_id=row.reply_to_id,
            created_at=row.created_at,
            edited_at=row.edited_at,
            deleted=row.deleted_at is not None,
            mentions=mentions.get(row.id, []),
            reactions=[ReactionOut(**r) for r in reactions.get(row.id, [])],
            my_reaction=mine.get(row.id),
        )
        for row in rows
    ]


def _load_channel_for(session: Session, channel_id: int, user: m.User) -> m.Channel:
    """채널을 가져오고 **구성원인지 확인한다.**

    ⚠️ 없는 채널과 남의 채널에 **같은 404** 를 줍니다. 403 으로 나누면
    번호를 훑어 "저 팀에 이런 채널이 있다" 를 알아낼 수 있습니다.
    """
    channel = session.get(m.Channel, channel_id)
    if channel is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "채널을 찾을 수 없습니다")
    member = session.scalar(
        select(m.Member.id).where(
            m.Member.project_id == channel.project_id,
            m.Member.user_id == user.id,
        )
    )
    if member is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "채널을 찾을 수 없습니다")
    return channel


class ReactionChoice(BaseModel):
    mark: str
    label: str


@app.get("/api/chat/reactions", response_model=list[ReactionChoice])
def list_reaction_choices(user: CurrentUser) -> list[ReactionChoice]:
    """고를 수 있는 반응 전부 (CHAT-008).

    ⚠️ **화면이 이 표를 자기 안에 두면 안 됩니다.** 메시지에 딸려 오는
    `label` 은 **이미 달린** 반응에만 있어서, 아직 아무도 안 단 것은 화면이
    이름을 알 방법이 없습니다. 거기서 화면이 자기 표를 만들면 서버의
    `REACTION_LABEL` 과 두 벌이 되고, 반드시 한쪽만 고쳐집니다.

    ⚠️ 순서는 **어휘 순서**입니다. 개수 순으로 세우면 그 순간 순위표입니다.
    """
    return [
        ReactionChoice(mark=str(mark), label=vocab.REACTION_LABEL[mark])
        for mark in vocab.ReactionMark
    ]


@app.get("/api/projects/{project_id}/channels", response_model=list[ChannelOut])
def list_channels(
    project_id: int, session: DbSession, user: CurrentUser
) -> list[ChannelOut]:
    """CHANNEL-005 — 자리 순으로."""
    _require_project_member(session, project_id, user)
    return [_channel_out(c) for c in channel_service.list_channels(session, project_id)]


@app.post(
    "/api/projects/{project_id}/channels",
    response_model=ChannelOut,
    status_code=status.HTTP_201_CREATED,
)
def create_channel(
    project_id: int, payload: ChannelIn, session: DbSession, user: CurrentUser
) -> ChannelOut:
    """CHANNEL-001·002."""
    _require_project_member(session, project_id, user)
    try:
        kind = vocab.ChannelKind(payload.kind)
    except ValueError:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "채널 종류는 텍스트 아니면 음성입니다",
        ) from None
    try:
        channel = channel_service.create_channel(
            session, project_id, kind=kind, name=payload.name, created_by=user.id
        )
    except channel_service.ChannelError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    session.commit()
    return _channel_out(channel)


@app.patch("/api/channels/{channel_id}", response_model=ChannelOut)
def rename_channel(
    channel_id: int, payload: ChannelPatch, session: DbSession, user: CurrentUser
) -> ChannelOut:
    """CHANNEL-003."""
    channel = _load_channel_for(session, channel_id, user)
    try:
        channel_service.rename_channel(session, channel, payload.name)
    except channel_service.ChannelError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    session.commit()
    return _channel_out(channel)


@app.delete("/api/channels/{channel_id}", response_model=ChannelOut)
def archive_channel(
    channel_id: int, session: DbSession, user: CurrentUser
) -> ChannelOut:
    """CHANNEL-004 — **행을 지우지 않습니다.** 메시지가 딸려 있습니다."""
    channel = _load_channel_for(session, channel_id, user)
    channel_service.archive_channel(session, channel)
    session.commit()
    return _channel_out(channel)


@app.put("/api/projects/{project_id}/channels/order", response_model=list[ChannelOut])
def reorder_channels(
    project_id: int, payload: ChannelOrderIn, session: DbSession, user: CurrentUser
) -> list[ChannelOut]:
    """CHANNEL-005."""
    _require_project_member(session, project_id, user)
    try:
        ordered = channel_service.reorder_channels(
            session, project_id, payload.channel_ids
        )
    except channel_service.ChannelError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    session.commit()
    return [_channel_out(c) for c in ordered]


@app.get("/api/channels/{channel_id}/messages", response_model=list[MessageOut])
def list_messages(
    channel_id: int,
    session: DbSession,
    user: CurrentUser,
    before_id: int | None = None,
    limit: int = message_service.MAX_PAGE,
) -> list[MessageOut]:
    """CHAT-009 — 오래된 것 → 새것 순. `before_id` 로 거슬러 올라갑니다."""
    _load_channel_for(session, channel_id, user)
    rows = message_service.history(
        session, channel_id, before_id=before_id, limit=limit
    )
    return _messages_out(session, rows, user.id)


@app.post(
    "/api/channels/{channel_id}/messages",
    response_model=MessageOut,
    status_code=status.HTTP_201_CREATED,
)
async def send_message(
    channel_id: int, payload: MessageIn, session: DbSession, user: CurrentUser
) -> MessageOut:
    """CHAT-001·004·005 — 쓰고, **저장된 뒤에** 보고 있는 사람들에게 흘린다."""
    _load_channel_for(session, channel_id, user)
    try:
        channel = channel_service.load_for_message(session, channel_id)
        message = message_service.send_message(
            session,
            channel,
            author_id=user.id,
            body=payload.body,
            reply_to_id=payload.reply_to_id,
        )
    except (channel_service.ChannelError, message_service.MessageError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    # NOTIFICATION-001 — 부른 사람들에게. ⚠️ 누구를 불렀는지는 서버가
    # 본문에서 뽑아 이미 저장했습니다. 여기서 다시 뽑지 않습니다.
    notification_service.record_mentions(
        session, message, project_id=channel.project_id, author_id=user.id
    )
    out = _messages_out(session, [message], user.id)[0]
    session.commit()
    # ⚠️ 커밋 **뒤에** 흘립니다. 앞에서 흘리면 롤백된 메시지가 남의 화면에
    #    남고, 그 사람이 새로고침하기 전까지는 있는 말로 보입니다.
    await chat_hub.hub.publish(
        channel_id, {"kind": "message", "message": out.model_dump(mode="json")}
    )
    return out


@app.patch("/api/messages/{message_id}", response_model=MessageOut)
async def edit_message(
    message_id: int, payload: MessageEditIn, session: DbSession, user: CurrentUser
) -> MessageOut:
    """CHAT-002 — 쓴 사람만. `edited_at` 이 반드시 남습니다."""
    message = message_service.load_message(session, message_id)
    _load_channel_for(session, message.channel_id, user)
    try:
        message_service.edit_message(
            session, message, editor_id=user.id, body=payload.body
        )
    except message_service.MessageError as exc:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from exc

    out = _messages_out(session, [message], user.id)[0]
    session.commit()
    await chat_hub.hub.publish(
        message.channel_id, {"kind": "edit", "message": out.model_dump(mode="json")}
    )
    return out


@app.delete("/api/messages/{message_id}", response_model=MessageOut)
async def delete_message(
    message_id: int, session: DbSession, user: CurrentUser
) -> MessageOut:
    """CHAT-003 — **행을 지우지 않습니다.** 답글이 가리킬 자리는 남습니다."""
    message = message_service.load_message(session, message_id)
    _load_channel_for(session, message.channel_id, user)
    try:
        message_service.delete_message(session, message, actor_id=user.id)
    except message_service.MessageError as exc:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from exc

    out = _messages_out(session, [message], user.id)[0]
    session.commit()
    await chat_hub.hub.publish(
        message.channel_id, {"kind": "delete", "message": out.model_dump(mode="json")}
    )
    return out


@app.put("/api/messages/{message_id}/reaction", response_model=MessageOut)
async def set_reaction(
    message_id: int, payload: ReactionIn, session: DbSession, user: CurrentUser
) -> MessageOut:
    """CHAT-008 — **한 사람당 하나.** `mark: null` 이면 뗍니다."""
    message = message_service.load_message(session, message_id)
    _load_channel_for(session, message.channel_id, user)
    try:
        message_service.set_reaction(
            session, message, user_id=user.id, mark=payload.mark
        )
    except message_service.MessageError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    out = _messages_out(session, [message], user.id)[0]
    session.commit()
    # ⚠️ 남에게 보낼 때 `my_reaction` 은 **내 것**입니다. 그대로 뿌리면
    #    남의 화면에 내가 누른 것이 자기가 누른 것으로 그려집니다.
    body = out.model_dump(mode="json")
    body["my_reaction"] = None
    await chat_hub.hub.publish(message.channel_id, {"kind": "reaction", "message": body})
    return out


class MessageSearchOut(BaseModel):
    channel_id: int
    channel_name: str
    message: MessageOut


@app.get("/api/projects/{project_id}/messages/search")
def search_messages(
    project_id: int, q: str, session: DbSession, user: CurrentUser
) -> list[MessageSearchOut]:
    """CHAT-010 — 이 프로젝트 안에서만. 지워진 것은 안 나옵니다."""
    _require_project_member(session, project_id, user)
    rows = message_service.search(session, project_id, q)
    names = {
        c.id: c.name
        for c in channel_service.list_channels(session, project_id, include_archived=True)
    }
    return [
        MessageSearchOut(
            channel_id=row.channel_id,
            channel_name=names.get(row.channel_id, "지워진 채널"),
            message=out,
        )
        for row, out in zip(rows, _messages_out(session, rows, user.id), strict=True)
    ]


@app.get("/api/projects/{project_id}/mentions")
def my_mentions(project_id: int, session: DbSession, user: CurrentUser) -> dict[str, int]:
    """나를 부른 메시지 건수 (CHAT-005).

    ⚠️ 이름이 `mention_total` 입니다 — **안 읽은 것이 아니라 전부**입니다.
    읽음 표시는 표가 하나 더 필요하고 아직 없습니다. `unread` 라고 부르면
    화면이 "읽으면 준다" 고 믿고 안 줄어드는 배지를 그립니다.
    """
    _require_project_member(session, project_id, user)
    return {
        "mention_total": message_service.unread_mentions(session, user.id, project_id)
    }


@app.websocket("/api/channels/{channel_id}/stream")
async def channel_stream(websocket: WebSocket, channel_id: int) -> None:
    """새 메시지를 실시간으로 받는 통로 (CHAT-001).

    ⚠️ **인증과 구성원 확인을 `accept()` 앞에서** 합니다. 받아 놓고 나중에
    끊으면 그 사이에 남의 팀 대화가 이미 샙니다.

    ⚠️ **읽기 전용입니다.** 소켓으로 오는 것은 전부 버립니다 — 글을 여기로
    받으면 저장 안 된 메시지가 남의 화면에만 뜹니다.
    """
    with db_session.session_scope() as session:
        user = auth_service.resolve_session(
            session, websocket.cookies.get(auth_service.COOKIE_NAME)
        )
        if user is None:
            # 1008 = policy violation. WS 에는 401 이 없습니다.
            await websocket.close(code=1008, reason="로그인이 필요합니다")
            return

        channel = session.get(m.Channel, channel_id)
        if channel is None:
            await websocket.close(code=1008, reason="채널을 찾을 수 없습니다")
            return

        member = session.scalar(
            select(m.Member.id).where(
                m.Member.project_id == channel.project_id,
                m.Member.user_id == user.id,
            )
        )
        if member is None:
            # 없는 채널과 같은 말입니다 — 여기서 존재 여부를 흘리지 않습니다.
            await websocket.close(code=1008, reason="채널을 찾을 수 없습니다")
            return

    await websocket.accept()
    connection_id = uuid4().hex

    async def send(body: dict[str, Any]) -> None:
        await websocket.send_json(body)

    await chat_hub.hub.join(channel_id, connection_id, send)
    try:
        while True:
            # ⚠️ 받은 것을 **쓰지 않습니다.** 소켓을 살려 두기 위해 읽을 뿐입니다.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await chat_hub.hub.part(channel_id, connection_id)


# ══════════════════════════════════════════════════════════════
# 일정 (요구사항 정의서 §16)
# ══════════════════════════════════════════════════════════════
#
# ⚠️ **달력 표를 만들지 않았습니다.** 요구하는 다섯 중 넷은 이미 있는
# 행에서 나옵니다 — 베껴 담으면 업무 마감일을 고쳤을 때 달력만 옛 날짜를
# 말합니다. 자세한 것은 `services/calendar_service.py` 머리말에.


class CalendarItemOut(BaseModel):
    kind: str
    #: ⚠️ **자르지 않은 순간**입니다. 어느 날인지는 화면이 팀 달력으로
    #: 정합니다 — 여기서 또 자르면 시간대 계산이 두 벌이 됩니다.
    at: datetime
    title: str
    task_id: int | None
    meeting_id: int | None
    who: str | None
    done: bool


class ScheduleIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    at: datetime
    channel_id: int | None = None


class RescheduleIn(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    at: datetime | None = None


class ScheduledOut(BaseModel):
    meeting_id: int
    title: str | None
    scheduled_at: datetime | None
    started_at: datetime | None
    channel_id: int | None


def _scheduled_out(meeting: m.Meeting) -> ScheduledOut:
    return ScheduledOut(
        meeting_id=meeting.id,
        title=meeting.title,
        scheduled_at=meeting.scheduled_at,
        started_at=meeting.started_at,
        channel_id=meeting.channel_id,
    )


@app.get("/api/projects/{project_id}/calendar", response_model=list[CalendarItemOut])
def read_calendar(
    project_id: int,
    since: datetime,
    until: datetime,
    session: DbSession,
    user: CurrentUser,
) -> list[CalendarItemOut]:
    """CALENDAR-001·002·005 — 이 기간에 놓이는 것 전부.

    ⚠️ 범위를 **반드시 받습니다.** 전부 주면 3년치가 한 번에 오고 화면은
    그중 한 달만 씁니다.
    """
    _require_project_member(session, project_id, user)
    try:
        items = calendar_service.collect(session, project_id, since=since, until=until)
    except calendar_service.CalendarError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return [
        CalendarItemOut(
            kind=item.kind,
            at=item.at,
            title=item.title,
            task_id=item.task_id,
            meeting_id=item.meeting_id,
            who=item.who,
            done=item.done,
        )
        for item in items
    ]


@app.post(
    "/api/projects/{project_id}/scheduled-meetings",
    response_model=ScheduledOut,
    status_code=status.HTTP_201_CREATED,
)
def schedule_meeting(
    project_id: int, payload: ScheduleIn, session: DbSession, user: CurrentUser
) -> ScheduledOut:
    """CALENDAR-003 — 일정을 잡는다. **아직 회의를 여는 것이 아닙니다.**"""
    _require_project_member(session, project_id, user)
    try:
        meeting = calendar_service.schedule_meeting(
            session,
            project_id,
            title=payload.title,
            at=payload.at,
            created_by=user.id,
            channel_id=payload.channel_id,
        )
    except calendar_service.CalendarError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    session.commit()
    return _scheduled_out(meeting)


@app.patch("/api/scheduled-meetings/{meeting_id}", response_model=ScheduledOut)
def reschedule_meeting(
    meeting_id: int, payload: RescheduleIn, session: DbSession, user: CurrentUser
) -> ScheduledOut:
    """CALENDAR-004."""
    meeting = _load_meeting_for(session, meeting_id, user)
    try:
        calendar_service.reschedule_meeting(
            session, meeting, at=payload.at, title=payload.title
        )
    except calendar_service.CalendarError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    session.commit()
    return _scheduled_out(meeting)


@app.delete("/api/scheduled-meetings/{meeting_id}", status_code=status.HTTP_204_NO_CONTENT)
def cancel_scheduled_meeting(
    meeting_id: int, session: DbSession, user: CurrentUser
) -> Response:
    """잡아 둔 일정을 무른다. **아직 안 연 회의만.**"""
    meeting = _load_meeting_for(session, meeting_id, user)
    try:
        calendar_service.cancel_meeting(session, meeting)
    except calendar_service.CalendarError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ══════════════════════════════════════════════════════════════
# 알림 (요구사항 정의서 §19)
# ══════════════════════════════════════════════════════════════
#
# ⚠️ **여섯 중 넷만 저장돼 있습니다.** 마감 임박·지연은 지금 상태에서
# 만들어 붙입니다 — 행으로 쌓으면 마감일을 미뤘을 때 "곧 마감" 이 남고,
# 끝냈을 때 "지연" 이 남습니다. 자세한 것은 `notification_service` 머리말에.


class NoticeOut(BaseModel):
    kind: str
    at: datetime
    #: ⚠️ 저장된 글자가 아니라 **지금 만든** 문장입니다. 업무 이름을 고치면
    #: 이 문장도 따라옵니다.
    text: str
    task_id: int | None
    meeting_id: int | None
    message_id: int | None
    #: 저장된 알림만 번호가 있습니다. 파생(마감)은 `null` —
    #: ⚠️ 읽었다고 마감이 사라지지 않습니다.
    notification_id: int | None
    read: bool


class ReadIn(BaseModel):
    notification_ids: list[int]


@app.get("/api/projects/{project_id}/notifications", response_model=list[NoticeOut])
def read_notifications(
    project_id: int, session: DbSession, user: CurrentUser
) -> list[NoticeOut]:
    """NOTIFICATION-001~005 — 저장된 사건 + 지금 상태에서 나오는 마감."""
    _require_project_member(session, project_id, user)
    notices = notification_service.collect(
        session, user.id, project_id, now=datetime.now(UTC)
    )
    return [
        NoticeOut(
            kind=n.kind,
            at=n.at,
            text=n.text,
            task_id=n.task_id,
            meeting_id=n.meeting_id,
            message_id=n.message_id,
            notification_id=n.notification_id,
            read=n.read,
        )
        for n in notices
    ]


@app.get("/api/projects/{project_id}/notifications/unread")
def read_unread_count(
    project_id: int, session: DbSession, user: CurrentUser
) -> dict[str, int]:
    """배지에 쓸 수.

    ⚠️ **마감은 안 셉니다.** 읽어도 안 없어지므로 영영 안 줄어드는 숫자가
    되고, 그러면 사람은 배지를 아예 안 봅니다.
    """
    _require_project_member(session, project_id, user)
    return {
        "unread": notification_service.unread_count(
            session, user.id, project_id, now=datetime.now(UTC)
        )
    }


@app.post("/api/projects/{project_id}/notifications/read")
def mark_notifications_read(
    project_id: int, payload: ReadIn, session: DbSession, user: CurrentUser
) -> dict[str, int]:
    """읽음 표시. ⚠️ **남의 알림은 못 읽습니다** — 서비스가 한 번 더 거릅니다."""
    _require_project_member(session, project_id, user)
    marked = notification_service.mark_read(session, user.id, payload.notification_ids)
    session.commit()
    return {"marked": marked}


# ══════════════════════════════════════════════════════════════
# 활동 기록 (요구사항 정의서 §21 ACTIVITY-001)
# ══════════════════════════════════════════════════════════════
#
# ⚠️ **이 엔드포인트가 생기기 전까지 `audit_logs` 는 쓰기만 하고 읽는 곳이
# 0곳이었습니다.** 열한 곳에서 성실하게 쌓고 있었는데 볼 방법이 없었습니다 —
# 이 저장소가 대표 실패 ① 로 적어 둔 그것입니다.


class ActivityOut(BaseModel):
    id: int
    at: datetime
    action: str
    #: 사람 말. ⚠️ 서버가 줍니다 — 화면이 두 번째 표를 만들지 않습니다.
    label: str
    who: str | None
    target: str
    #: 사람의 기여 숫자를 건드린 기록인가. 분쟁에서 제일 먼저 볼 것입니다.
    touches_contribution: bool


@app.get("/api/projects/{project_id}/activity", response_model=list[ActivityOut])
def read_activity(
    project_id: int, session: DbSession, user: CurrentUser, limit: int = 100
) -> list[ActivityOut]:
    """ACTIVITY-001 — 이 프로젝트에서 일어난 일. 최근 것부터.

    ⚠️ **구성원만** 볼 수 있습니다. 감사 기록에는 누가 무엇을 고쳤는지가
    그대로 있어서, 남에게 보이면 팀 내부 사정이 통째로 새어 나갑니다.
    """
    _require_project_member(session, project_id, user)
    return [
        ActivityOut(
            id=entry.id,
            at=entry.at,
            action=entry.action,
            label=entry.label,
            who=entry.who,
            target=entry.target,
            touches_contribution=entry.touches_contribution,
        )
        for entry in activity_service.recent(session, project_id, limit=limit)
    ]


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
    if not FRONTEND_EXPECTED_AT.is_dir():
        # 여기서 로그를 찍지 않는다 — 이 함수는 import 시점에 돌고
        # 로깅은 lifespan 에서 설정된다. 지금 찍으면 사라진다.
        return None

    application.mount(
        "/", StaticFiles(directory=FRONTEND_EXPECTED_AT, html=True), name="web"
    )
    return FRONTEND_EXPECTED_AT


#: 화면이 있어야 할 자리. 없을 때 **어디를 봐야 하는지** 말해 주려고 둔다.
FRONTEND_EXPECTED_AT = Path(__file__).resolve().parents[3] / "frontend" / "public"

FRONTEND_DIR = _mount_frontend(app)
