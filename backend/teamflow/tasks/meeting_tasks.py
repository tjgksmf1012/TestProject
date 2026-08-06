"""회의 처리 Celery 태스크.

오케스트레이션 자체는 `pipeline/meeting_pipeline.py` 에 있고, 이 모듈은
**얇은 래퍼**다. 그래야 GPU 없이 파이프라인을 테스트할 수 있다.

여기서 하는 일:
    1. DB에서 회의·팀원·맥락을 읽어 파이프라인에 넘긴다
    2. GpuBusy 면 큐로 되돌린다 (워커 안에서 대기하지 않는다)
    3. 결과를 발화·업무후보로 저장한다
"""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime, time

from celery import Task
from sqlalchemy import select

from teamflow.config import get_settings
from teamflow.db import models as m
from teamflow.db.session import session_scope
from teamflow.jobs.gpu_lock import GpuBusy
from teamflow.meeting.resolve import TeamMemberName
from teamflow.pipeline.meeting_pipeline import PipelineResult, Stage, process_meeting
from teamflow.tasks import app

logger = logging.getLogger(__name__)

# GPU가 바쁘면 이 간격으로 재시도한다.
# 회의 처리가 보통 5~15분이라 30초 간격이면 과하지 않다.
GPU_RETRY_COUNTDOWN = 30
GPU_MAX_RETRIES = 120  # 최대 1시간 대기


def _build_steps(capture_mode: str):
    """설정과 **회의의 녹음 방식**에 맞는 구현을 고른다.

    `capture_mode` 를 받는 게 중요하다. 멀티트랙(모드 A)은 청크에서
    복원해야 하고, 단일 파일(모드 B)은 WAV 를 읽는다. 이 인자가 없던
    동안에는 청크 경로가 만들어져 있는데도 한 번도 실행되지 않았다.

    ⚠️ ASR·화자분리 실제 구현은 이 개발 환경에 모델도 GPU도 없어 아직 없습니다.
    `scripts/check_env.py` 로 환경을 확인한 뒤 실제 머신에서 붙입니다.
    """
    settings = get_settings()

    from teamflow.meeting.llm import FakeLLMClient, LlamaCppClient, VLLMClient
    from teamflow.meeting.schema import MeetingAnalysis

    if settings.llm_backend == "vllm":
        client = VLLMClient(base_url=settings.llm_base_url, model=settings.llm_model)
    elif settings.llm_backend == "llamacpp":
        client = LlamaCppClient(base_url=settings.llm_base_url, model=settings.llm_model)
    else:
        client = FakeLLMClient(MeetingAnalysis(summary="", decisions=[], tasks=[]))

    class _Analyzer:
        def analyze(self, utterances, *, prior_decisions=None, open_tasks=None):
            from teamflow.meeting.schema import format_transcript

            return client.analyze_meeting(
                format_transcript(utterances),
                prior_decisions=prior_decisions,
                open_tasks=open_tasks,
            )

    # 로더·전사기는 실제 머신에서 주입한다.
    from teamflow.pipeline import runtime

    return (
        runtime.build_audio_loader(settings, capture_mode),
        runtime.build_transcriber(settings),
        _Analyzer(),
    )


@app.task(
    bind=True,
    name="teamflow.tasks.meeting_tasks.process_meeting_task",
    autoretry_for=(),
    max_retries=GPU_MAX_RETRIES,
)
def process_meeting_task(self: Task, meeting_id: int) -> dict:
    """회의 하나를 처리한다. GPU 큐에서 동시성 1로 돈다."""
    settings = get_settings()

    with session_scope() as session:
        meeting = session.get(m.Meeting, meeting_id)
        if meeting is None:
            return {"meeting_id": meeting_id, "status": "not_found"}

        # 이미 끝난 회의를 다시 처리하지 않는다 (멱등성).
        if meeting.status == "confirmed":
            return {"meeting_id": meeting_id, "status": "already_done"}

        meeting.status = "processing"
        project_id = meeting.project_id
        capture_mode = meeting.capture_mode
        meeting_date = meeting.started_at.date()

        members = [
            TeamMemberName(user_id=user_id, name=name)
            for user_id, name in session.execute(
                select(m.Member.user_id, m.User.name)
                .join(m.User, m.User.id == m.Member.user_id)
                .where(m.Member.project_id == project_id)
            ).all()
        ]
        prior_decisions = list(
            session.scalars(
                select(m.Decision.content).where(
                    m.Decision.project_id == project_id,
                    m.Decision.status == "active",
                )
            ).all()
        )
        open_tasks = list(
            session.scalars(
                select(m.Task.title).where(
                    m.Task.project_id == project_id,
                    m.Task.status.in_(("todo", "in_progress")),
                )
            ).all()
        )

    loader, transcriber, analyzer = _build_steps(capture_mode)

    try:
        import redis as redis_lib

        lock_backend = redis_lib.Redis.from_url(settings.redis_url, decode_responses=True)
    except Exception:
        logger.warning("Redis 연결 실패. GPU 락 없이 진행합니다.")
        lock_backend = None

    from teamflow.pipeline.steps import RedisProgress

    progress = RedisProgress(lock_backend) if lock_backend else None

    try:
        result = process_meeting(
            meeting_id,
            loader=loader,
            transcriber=transcriber,
            analyzer=analyzer,
            members=members,
            meeting_date=meeting_date,
            lock_backend=lock_backend,
            progress=progress,
            prior_decisions=prior_decisions,
            open_tasks=open_tasks,
            existing_task_titles=open_tasks,
            gpu_ttl=settings.gpu_lock_ttl,
        )
    except GpuBusy as exc:
        # 워커 슬롯을 붙잡고 대기하지 않는다. 큐로 되돌린다.
        logger.info("meeting=%s GPU 대기 중 (%s). 재시도합니다.", meeting_id, exc.holder)
        raise self.retry(countdown=GPU_RETRY_COUNTDOWN, exc=exc) from exc

    persist_results_task.delay(meeting_id, _serialize(result))
    return {
        "meeting_id": meeting_id,
        "status": result.stage,
        "segments": len(result.segments),
        "candidates": len(result.validation.candidates) if result.validation else 0,
    }


def _serialize(result: PipelineResult) -> dict:
    """Celery 로 넘길 수 있게 직렬화한다. numpy 배열은 넘기지 않는다."""
    validation = result.validation
    return {
        "stage": result.stage,
        "error": result.error,
        "speaker_certainty": result.speaker_certainty,
        "segments": [
            {
                "user_id": s.user_id,
                "track_id": s.track_id,
                "start_ms": s.start_ms,
                "end_ms": s.end_ms,
                "text": s.text,
                "confidence": s.confidence,
                "is_overlap": s.is_overlap,
                "speaker_source": s.speaker_source,
            }
            for s in result.segments
        ],
        "summary": validation.summary if validation else "",
        "candidates": [
            {
                "title": c.title,
                # 전사에 등장한 이름 그대로. `assignee_id` 가 None 일 때
                # 사람이 누구를 골라야 하는지 아는 유일한 단서다.
                "assignee_hint": c.assignee_hint,
                "assignee_id": c.assignee.user_id,
                "deadline": c.deadline.value.isoformat() if c.deadline.value else None,
                "confidence": c.overall_confidence,
                "evidence": list(c.evidence_utterance_ids),
                "warnings": list(c.warnings),
            }
            for c in (validation.candidates if validation else [])
        ],
        # 트랙 번째가 아니라 track_id 로 바꿔서 넘긴다. 저장 태스크는
        # 파이프라인이 트랙을 어떤 순서로 로드했는지 알 수 없다.
        "alignment": [
            {
                "track_id": result.track_ids[o.track_index],
                "offset_ms": o.offset_ms,
                "confidence": round(float(o.confidence), 3),
                "method": o.method,
            }
            for o in result.alignment
            if 0 <= o.track_index < len(result.track_ids)
        ],
        "decisions": [
            {"content": content, "evidence": list(evidence), "supersedes": supersedes}
            for content, evidence, supersedes in (validation.decisions if validation else [])
        ],
        "rejected": len(validation.rejected) if validation else 0,
    }


def _parse_deadline(value: str | None) -> datetime | None:
    """ISO 날짜 문자열을 datetime 으로.

    Celery 는 JSON 직렬화를 쓰므로 date 객체가 문자열로 넘어온다.
    그대로 DB에 넣으면 "SQLite DateTime type only accepts Python datetime"
    같은 오류가 난다 — PostgreSQL 에서도 타입 불일치로 실패한다.
    """
    if not value:
        return None
    try:
        parsed = date.fromisoformat(value)
    except (ValueError, TypeError):
        logger.warning("마감일 파싱 실패: %r", value)
        return None
    return datetime.combine(parsed, time.min, tzinfo=UTC)


@app.task(name="teamflow.tasks.meeting_tasks.persist_results_task")
def persist_results_task(meeting_id: int, payload: dict) -> dict:
    """파이프라인 결과를 DB에 쓴다. CPU 큐에서 돈다.

    발화를 먼저 저장해야 업무 후보의 `evidence_utterance_ids` 가
    실제 행을 가리킬 수 있다.
    """
    with session_scope() as session:
        meeting = session.get(m.Meeting, meeting_id)
        if meeting is None:
            return {"meeting_id": meeting_id, "status": "not_found"}

        if payload["stage"] == Stage.FAILED:
            meeting.status = "failed"
            return {"meeting_id": meeting_id, "status": "failed", "error": payload.get("error")}

        # ── 재처리 정리 ────────────────────────────────────────
        #
        # 예전에는 발화만 지웠다. 그러면 후보와 결정이 **중복 생성**되고,
        # 더 나쁘게는 1회차 후보의 근거 발화 ID 가 삭제된 행을 가리킨다.
        # SQLite 는 rowid 를 재사용해 우연히 맞지만 PostgreSQL 시퀀스는
        # 재사용하지 않으므로 근거가 통째로 고아가 된다 — "근거를 클릭하면
        # 원문으로" 가 끊기고, 근거 없는 후보를 막는 방어가 무력해진다.
        #
        # 재실행 경로는 실재한다: task_acks_late=True + reject_on_worker_lost
        # 이라 워커가 죽으면 같은 회의가 다시 돈다.
        reviewed = session.scalars(
            select(m.MeetingTaskCandidate).where(
                m.MeetingTaskCandidate.meeting_id == meeting_id,
                m.MeetingTaskCandidate.review_status != "pending",
            )
        ).all()
        if reviewed:
            # ⚠️ 사람이 이미 판단한 회의는 다시 쓰지 않는다.
            #
            # 발화를 지우고 새로 만들면 승인된 후보(이미 칸반의 업무가 된 것)의
            # 근거가 끊어진다. 그건 데이터 정정이 아니라 **분쟁 근거의 훼손**이다.
            # 다시 처리해야 한다면 사람이 먼저 승인을 되돌려야 한다.
            logger.warning(
                "meeting=%s 는 이미 검토된 후보가 %d건 있어 재처리를 건너뜁니다",
                meeting_id,
                len(reviewed),
            )
            return {
                "meeting_id": meeting_id,
                "status": "already_reviewed",
                "reviewed": len(reviewed),
            }

        for model in (m.Utterance, m.MeetingTaskCandidate, m.Decision):
            for row in session.scalars(
                select(model).where(model.meeting_id == meeting_id)
            ).all():
                session.delete(row)
        session.flush()

        utterance_ids: list[int] = []
        for seg in payload["segments"]:
            row = m.Utterance(
                meeting_id=meeting_id,
                speaker_id=seg["user_id"],
                track_id=seg["track_id"],
                start_ms=seg["start_ms"],
                end_ms=seg["end_ms"],
                text=seg["text"],
                speaker_source=seg["speaker_source"],
                speaker_confidence=seg["confidence"],
                is_overlap=seg["is_overlap"],
            )
            session.add(row)
            session.flush()
            utterance_ids.append(row.id)

        # 파이프라인은 1부터 시작하는 순번으로 근거를 매긴다.
        # 저장된 실제 행 ID로 바꿔준다.
        def to_real_ids(indices: list[int]) -> list[int]:
            return [utterance_ids[i - 1] for i in indices if 1 <= i <= len(utterance_ids)]

        for candidate in payload["candidates"]:
            session.add(
                m.MeetingTaskCandidate(
                    meeting_id=meeting_id,
                    title=candidate["title"],
                    assignee_hint=candidate.get("assignee_hint"),
                    assignee_id=candidate["assignee_id"],
                    deadline=_parse_deadline(candidate["deadline"]),
                    confidence=candidate["confidence"],
                    evidence_utterance_ids=to_real_ids(candidate["evidence"]),
                    warnings=list(candidate.get("warnings") or []),
                )
            )

        for decision in payload["decisions"]:
            session.add(
                m.Decision(
                    project_id=meeting.project_id,
                    meeting_id=meeting_id,
                    content=decision["content"],
                    evidence_utterance_ids=to_real_ids(decision["evidence"]),
                )
            )

        # 추정한 정렬 보정값을 트랙에 되돌려 쓴다.
        #
        # 이걸 안 쓰면 `offset_ms` 는 영원히 0 이다. 그러면 발화 시각이
        # 트랙마다 다른 기준에서 매겨진 채로 남고, 나중에 회의를 다시
        # 조립하거나 "이 발언이 저 발언에 대한 답인가" 를 보려면 정렬을
        # 처음부터 다시 추정해야 한다 — 원본 오디오는 보존기간이 지나면
        # 지워지므로(P8) 그때는 다시 구할 방법이 없다.
        for entry in payload.get("alignment", []):
            track = session.get(m.MeetingTrack, entry["track_id"])
            if track is None or track.meeting_id != meeting_id:
                # 재처리 중에 트랙이 지워졌거나 다른 회의의 id 가 섞인 경우.
                logger.warning(
                    "meeting=%s 정렬 결과의 track=%s 를 찾지 못해 건너뜁니다",
                    meeting_id,
                    entry["track_id"],
                )
                continue
            track.offset_ms = entry["offset_ms"]

        # 요약은 회의 행에 남는다. 근거 발화는 utterances 에 이미 있다.
        meeting.summary = payload.get("summary") or None

        # 사람이 검토해야 하므로 confirmed 가 아니라 needs_review 다.
        # 승인 전에는 절대 tasks 로 넘어가지 않는다.
        meeting.status = "needs_review"

    return {
        "meeting_id": meeting_id,
        "status": "needs_review",
        "utterances": len(payload["segments"]),
        "candidates": len(payload["candidates"]),
    }
