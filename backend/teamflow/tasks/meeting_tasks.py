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
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from teamflow.clock import local_date
from teamflow.config import get_settings
from teamflow.db import live
from teamflow.db import models as m
from teamflow.db.session import session_scope
from teamflow.jobs import retention
from teamflow.jobs.gpu_lock import GpuBusy
from teamflow.meeting.resolve import TeamMemberName
from teamflow.pipeline.meeting_pipeline import PipelineResult, Stage, process_meeting
from teamflow.services import meeting_contribution_service
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
        # ⚠️ **팀 달력의 날짜여야 합니다** (결함 108). 이 값은 곧바로
        # `resolve_deadline` 의 기준일이 되어 "내일"·"다음 주 월요일" 같은
        # 표현을 실제 날짜로 바꿉니다. `.date()` 는 UTC 달력일이라 새벽에
        # 시작한 회의에서 하루가 어긋납니다 — 요일까지 어긋나면 주 단위로
        # 틀립니다.
        #
        #     회의 시작 2026-09-07 01:00 KST (월) = 09-06 16:00Z (일)
        #     "내일까지"        UTC기준 09-07  팀달력 09-08
        #     "다음 주 월요일"   UTC기준 09-07  팀달력 09-14
        #                       ↑ 회의 당일이 마감이 된다
        meeting_date = local_date(meeting.started_at)

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
                    live.not_deleted(),
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
        # ⚠️ 이 둘이 여기 없어서 **파이프라인 밖으로 나온 적이 없었다.**
        # 검증(`validation.py`)까지 통과한 산출물인데, 근거 발화 id 가
        # 실재하는지 확인까지 마친 것들이 그대로 버려졌다. 회의 재처리는
        # 사람이 검토한 뒤에는 거부되므로 **영구 손실**이었다.
        "unresolved_issues": [
            {"content": content, "evidence": list(evidence)}
            for content, evidence in (validation.unresolved_issues if validation else [])
        ],
        "next_agenda": list(validation.next_agenda) if validation else [],
        "rejected": len(validation.rejected) if validation else 0,
    }


def _span(session: Session, utterance_ids: list[int]) -> tuple[int, int]:
    """근거 발화들이 걸친 구간. 근거가 없으면 (0, 0).

    ⭐ **시각을 지어내지 않는다.** 없는 것을 0..회의끝 으로 채우면 화면이
    "회의 내내 해결되지 않았다" 로 읽는다.
    """
    if not utterance_ids:
        return (0, 0)
    rows = session.execute(
        select(func.min(m.Utterance.start_ms), func.max(m.Utterance.end_ms)).where(
            m.Utterance.id.in_(utterance_ids)
        )
    ).one()
    return (int(rows[0] or 0), int(rows[1] or 0))


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

        # ⚠️ **발화를 지우기 전에** 그 발화에서 나온 기여 이벤트를 지운다.
        #
        # 발화가 사라진 뒤에는 어떤 이벤트가 이 회의 것이었는지 알 방법이
        # 없다. 안 지우면 재처리할 때마다 같은 회의가 한 번씩 더 계산돼
        # **점수가 누적된다.**
        meeting_contribution_service.forget_meeting_events(session, meeting_id)

        # ⚠️ **`MeetingEvent` 도 여기 있어야 합니다** (결함 113). 미해결
        # 사안은 이 표에 들어가는데 정리 목록에 없어서, 재처리할 때마다
        # 같은 사안이 한 벌씩 더 쌓였습니다.
        #
        # 결함 111 **전에는 아무도 못 봤습니다** — 그 표를 읽는 화면이
        # 0곳이었기 때문입니다. 화면에 올리자 중복이 그대로 보이게
        # 됐습니다. **안 보이던 것이 안 틀렸던 것은 아닙니다.**
        for model in (m.Utterance, m.MeetingTaskCandidate, m.Decision, m.MeetingEvent):
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

        # 결정 번복 추적. 예전에는 `supersedes` 가 여기까지 실려 오는데
        # 쓰지 않아 `supersedes_id` 가 **영원히 NULL** 이었다.
        #
        # LLM 에게 넘긴 `prior_decisions` 는 우리가 준 원문 목록이라 대개
        # 정확히 일치한다. 그래서 **정확히 일치할 때만** 잇는다 —
        # 비슷한 것을 골라 주면 회의 기록이 틀려지고, 틀린 기록은
        # 조용하다. 못 찾으면 원문을 남겨 사람이 고치게 한다.
        active_by_content = {
            row.content: row
            for row in session.scalars(
                select(m.Decision).where(
                    m.Decision.project_id == meeting.project_id,
                    m.Decision.status == "active",
                )
            ).all()
        }

        for decision in payload["decisions"]:
            hint = decision.get("supersedes")
            superseded = active_by_content.get(hint) if hint else None

            row = m.Decision(
                project_id=meeting.project_id,
                meeting_id=meeting_id,
                content=decision["content"],
                evidence_utterance_ids=to_real_ids(decision["evidence"]),
                supersedes_id=superseded.id if superseded else None,
                # 찾았으면 힌트를 남기지 않는다 — id 가 있는데 원문까지
                # 두면 어느 쪽이 맞는지 다음 사람이 헷갈린다.
                supersedes_hint=None if superseded else hint,
            )
            session.add(row)

            if superseded is not None:
                # 뒤집힌 결정은 더 이상 활성이 아니다. 이걸 안 바꾸면
                # 다음 회의의 `prior_decisions` 에 **뒤집힌 결정이 계속
                # 들어가서** LLM 이 같은 번복을 매번 다시 보고한다.
                superseded.status = "superseded"
                active_by_content.pop(hint, None)
                logger.info(
                    "결정 번복: meeting=%s 가 decision=%s 를 뒤집음",
                    meeting_id,
                    superseded.id,
                )
            elif hint:
                logger.info(
                    "결정 번복 힌트를 이을 결정을 못 찾았습니다 "
                    "(사람이 확인해야 합니다): meeting=%s hint=%r",
                    meeting_id,
                    hint[:80],
                )

        # 미해결 사안 → `meeting_events` 의 `unanswered_question`.
        # 새 표가 필요 없다 — 그 자리가 원래 이것을 위한 자리다.
        for issue in payload.get("unresolved_issues", []):
            evidence = to_real_ids(issue["evidence"])
            session.add(
                m.MeetingEvent(
                    meeting_id=meeting_id,
                    event_type="unanswered_question",
                    severity="info",
                    # 근거 발화의 구간을 그대로 쓴다. 없으면 0 — 시각을
                    # 지어내지 않는다.
                    start_ms=_span(session, evidence)[0],
                    end_ms=_span(session, evidence)[1],
                    evidence_utterance_ids=evidence,
                    detail={"content": issue["content"]},
                )
            )

        meeting.next_agenda = list(payload.get("next_agenda") or [])

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

        # ── 회의 → 기여 이벤트 ────────────────────────────────
        #
        # 기여도의 세 다리 중 마지막. 그 전까지 **운영 코드에 0곳**이라
        # 운영에서 회의 기여도는 언제나 0이었다.
        #
        # 승인 전에 만드는 이유: 이건 **업무**가 아니라 **발언 기록**이다.
        # 업무 후보는 사람이 승인해야 칸반에 올라가지만, "누가 무엇을
        # 말했는가" 는 승인을 기다릴 성질이 아니다 — 회의록에 이미 있는
        # 사실이고, 틀린 라벨은 발화 자체를 고쳐서 바로잡는다.
        contribution = meeting_contribution_service.record_meeting(session, meeting)

        # ── ② 원본 보관을 거부한 사람의 녹음 삭제 ─────────────
        #
        # `docs/07` §2.3 — "② 거부 → **전사 완료 후 원본 즉시 삭제.**
        # 텍스트만 남김." 여기가 전사가 끝난 바로 그 지점입니다. 발화가
        # 이미 저장됐으므로 원본이 없어도 회의록은 남습니다.
        #
        # ⚠️ 실패해도 회의 처리를 되돌리지 않습니다. 파일 하나를 못 지웠다고
        # 방금 만든 회의록을 통째로 버리면 손해가 더 큽니다. 못 지운 것은
        # 보고서에 남고, 보존기간이 지나면 매일 도는 잡이 다시 집어갑니다.
        purged = retention.purge_unconsented_audio(
            session,
            meeting_id=meeting_id,
            storage_root=get_settings().audio_storage_root,
        )
        if purged.failed:
            logger.error(
                "meeting=%s 원본 보관 거부분을 못 지웠습니다: %s", meeting_id, purged.failed
            )

    return {
        "meeting_id": meeting_id,
        "status": "needs_review",
        "audio_purged": len(purged.deleted_assets),
        "utterances": len(payload["segments"]),
        "candidates": len(payload["candidates"]),
        "contribution": contribution,
    }
