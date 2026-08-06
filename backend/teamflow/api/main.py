"""FastAPI 애플리케이션.

docs/03-시스템-아키텍처.md §1 — Spring Boot 없이 FastAPI 단일 백엔드.
"""

from __future__ import annotations

import logging
import time
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response, status
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import event, select
from sqlalchemy.orm import Session

from teamflow.audio.chunk_store import ChunkStore
from teamflow.config import Settings, get_settings, safe_dump
from teamflow.db import models as m
from teamflow.db.session import get_db
from teamflow.github import webhook as gh
from teamflow.meeting.approval import ApprovalRequest
from teamflow.services import approval_service, recording_service
from teamflow.tasks import dispatch

logger = logging.getLogger(__name__)

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
    user_id: int = Field(gt=0)
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
    title: str = Field(min_length=1, max_length=200)
    github_repo: str | None = None
    member_ids: list[int] = Field(min_length=1)


class ProjectOut(BaseModel):
    project_id: int
    title: str
    member_ids: list[int]


@app.post("/api/projects", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
def create_project(payload: ProjectIn, session: DbSession) -> ProjectOut:
    known = set(
        session.scalars(select(m.User.id).where(m.User.id.in_(payload.member_ids))).all()
    )
    missing = set(payload.member_ids) - known
    if missing:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"없는 사용자입니다: {sorted(missing)}"
        )

    project = m.Project(
        title=payload.title,
        started_at=datetime.now(UTC),
        github_repo=payload.github_repo,
    )
    session.add(project)
    session.flush()

    for user_id in dict.fromkeys(payload.member_ids):  # 순서 유지 + 중복 제거
        session.add(
            m.Member(
                project_id=project.id, user_id=user_id, role_shares={"developer": 1.0}
            )
        )
    session.flush()

    return ProjectOut(
        project_id=project.id, title=project.title, member_ids=list(payload.member_ids)
    )


class MeetingIn(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    started_by: int
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
    project_id: int, payload: MeetingIn, session: DbSession
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

    member = session.scalars(
        select(m.Member).where(
            m.Member.project_id == project_id, m.Member.user_id == payload.started_by
        )
    ).one_or_none()
    if member is None:
        # 통신비밀보호법 L1 — 녹음을 시작하는 사람은 회의 당사자여야 한다.
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "이 프로젝트의 구성원만 회의를 시작할 수 있습니다"
        )

    meeting = m.Meeting(
        project_id=project_id,
        title=payload.title,
        started_at=datetime.now(UTC),
        started_by=payload.started_by,
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
    user_id: int
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
    meeting_id: int, payload: ConsentIn, request: Request, session: DbSession
) -> ConsentOut:
    """동의를 제출하거나 철회한다.

    **철회는 소급하지 않는다.** `consented=false` 는 이후 청크만 막고,
    이미 받은 오디오는 보존기간까지 남는다. 삭제는 별도 절차다 (docs/07 P6).
    """
    _load_meeting(session, meeting_id)
    try:
        recording_service.submit_consent(
            session,
            meeting_id=meeting_id,
            user_id=payload.user_id,
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
def read_consent(meeting_id: int, session: DbSession) -> ConsentOut:
    """동의 현황. **아직 응답하지 않은 사람도 보인다.**

    동의 행이 있는 사람만 보여주면 기다려야 할 대상이 화면에서 사라진다.
    """
    _load_meeting(session, meeting_id)
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
    meeting_id: int, payload: TrackJoin, session: DbSession, settings: AppSettings
) -> TrackOut:
    """회의에 트랙으로 참가한다. 새로고침해도 같은 트랙으로 이어붙는다."""
    _load_meeting(session, meeting_id)
    try:
        track = recording_service.join_track(
            session,
            meeting_id=meeting_id,
            user_id=payload.user_id,
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
    meeting_id: int, track_id: int, session: DbSession, settings: AppSettings
) -> StoredChunks:
    """재연결 후 "어디까지 올렸나"를 묻는 엔드포인트.

    이게 없으면 클라이언트가 매번 처음부터 다시 올려 영영 못 따라잡는다
    (`UploadQueue.resumeWith`).
    """
    _load_meeting(session, meeting_id)
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
) -> TrackCompleteOut:
    """녹음 종료. 클라이언트가 계산한 품질 정보를 받아 저장한다.

    보고된 커버리지를 그대로 믿지 않는다 — 서버가 실제로 받은 청크 수와
    대조해서 더 나쁜 쪽을 쓴다.
    """
    _load_meeting(session, meeting_id)
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
    meeting_id: int, session: DbSession, settings: AppSettings
) -> FinishMeetingOut:
    """회의를 강제로 종료한다.

    브라우저를 그냥 닫은 사람이 있으면 그 트랙은 영원히 `recording` 으로 남고,
    회의는 **영영 처리되지 않는다.** 사람이 그 상태를 풀 수 있어야 한다.

    강제 종료한 트랙은 `aborted` 로 남는다 — `completed` 로 두면 커버리지를
    계산한 적이 없는데 정상 종료로 보이고, 그 사람의 발언량을 측정한 것처럼
    취급된다 (docs/05 §4.1.1).
    """
    _load_meeting(session, meeting_id)
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
def list_tracks(meeting_id: int, session: DbSession) -> dict[str, Any]:
    """트랙별 상태. 승인 화면이 "이 트랙은 못 씁니다"를 띄우는 근거."""
    _load_meeting(session, meeting_id)
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


# ══════════════════════════════════════════════════════════════
# 회의 업무 후보 검토 (이어서)
# ══════════════════════════════════════════════════════════════


class MemberOut(BaseModel):
    user_id: int
    name: str
    role_shares: dict[str, float]


@app.get("/api/meetings/{meeting_id}/members", response_model=list[MemberOut])
def list_meeting_members(meeting_id: int, session: DbSession) -> list[MemberOut]:
    """이 회의가 속한 프로젝트의 팀원.

    승인 화면이 담당자를 고르려면 명단이 필요하다. 명단 없이 담당자 id 를
    직접 입력하게 하면 오타 하나로 엉뚱한 사람에게 업무가 붙는다 —
    서버가 `unknown_assignee` 로 막긴 하지만, 애초에 고를 수 있게 하는 게 맞다.
    """
    meeting = _load_meeting(session, meeting_id)
    rows = session.execute(
        select(m.Member, m.User)
        .join(m.User, m.User.id == m.Member.user_id)
        .where(m.Member.project_id == meeting.project_id)
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
def contributions(project_id: int, session: DbSession, settings: AppSettings) -> ScoreOut:
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
