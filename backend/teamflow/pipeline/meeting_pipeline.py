"""회의 처리 파이프라인 오케스트레이션.

docs/03-시스템-아키텍처.md §3

    [회의 업로드/종료]
      ├─(CPU) 오디오 로드 · 트랙 정렬 · 주화자 판정 · 누출 제거
      ├─(GPU) ASR + 타임스탬프
      ├─(CPU) 발화 단위 결합
      ├─(GPU/CPU) LLM: 요약 · 결정 · 업무 후보
      └─→ [사람 확인 화면] → 승인된 것만 칸반에 등록

이 모듈은 **단계를 주입받는다.** 실제 모델 없이 오케스트레이션을 검증하기 위해서다.
진행률 보고, GPU 락 사용, 실패 격리, 멱등성은 GPU 없이도 테스트해야 하는 것들이다.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date

from teamflow.audio import multitrack as mt
from teamflow.jobs.gpu_lock import GpuBusy, LockBackend, gpu_lease
from teamflow.meeting.resolve import TeamMemberName
from teamflow.meeting.schema import format_transcript
from teamflow.meeting.validation import ValidationResult, validate_analysis
from teamflow.pipeline.steps import (
    AudioLoader,
    LoadedTrack,
    MeetingAnalyzer,
    NullProgress,
    ProgressReporter,
    TranscribedSegment,
    Transcriber,
)

logger = logging.getLogger(__name__)


class Stage:
    LOAD = "load"
    ALIGN = "align"
    TRANSCRIBE = "transcribe"
    ANALYZE = "analyze"
    VALIDATE = "validate"
    DONE = "done"
    FAILED = "failed"


# 각 단계의 **시작** 진행률. 상한이 아니다.
#
# 초기 구현은 상한으로 뒀다가 진행률이 80 → 15 → 47 로 역행했다.
# ASR 단계에 진입하면서 80을 보고한 뒤, 트랙별 세부 진행률이 15부터
# 다시 올라갔기 때문이다. 사용자 화면에서는 막대가 튀어 보인다.
#
# ASR이 압도적으로 오래 걸리므로 15~80 구간을 통째로 배정한다.
_STAGE_START = {
    Stage.LOAD: 0,
    Stage.ALIGN: 5,
    Stage.TRANSCRIBE: 15,
    Stage.ANALYZE: 80,
    Stage.VALIDATE: 95,
    Stage.DONE: 100,
}


@dataclass
class PipelineResult:
    meeting_id: int
    stage: str
    segments: list[TranscribedSegment] = field(default_factory=list)
    validation: ValidationResult | None = None
    track_stats: list[mt.TrackStats] = field(default_factory=list)
    alignment: list[mt.TrackOffset] = field(default_factory=list)
    # 로더가 준 순서 그대로의 track_id. `alignment` 와 `track_stats` 는
    # **번째**로 트랙을 가리키므로(TrackOffset.track_index), 이게 없으면
    # 결과를 DB 행에 되돌려 붙일 수 없다. 실제로 그래서 못 붙이고 있었다.
    track_ids: list[int] = field(default_factory=list)
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.stage == Stage.DONE and self.error is None

    @property
    def speaker_certainty(self) -> float:
        """화자가 확정된 발화 비율. 신뢰도 계산의 입력이 된다."""
        if not self.segments:
            return 0.0
        certain = sum(1 for s in self.segments if s.speaker_source in ("track", "manual"))
        return certain / len(self.segments)


def process_meeting(
    meeting_id: int,
    *,
    loader: AudioLoader,
    transcriber: Transcriber,
    analyzer: MeetingAnalyzer,
    members: list[TeamMemberName],
    meeting_date: date,
    lock_backend: LockBackend | None = None,
    progress: ProgressReporter | None = None,
    prior_decisions: list[str] | None = None,
    open_tasks: list[str] | None = None,
    existing_task_titles: list[str] | None = None,
    gpu_ttl: int = 1800,
) -> PipelineResult:
    """회의 하나를 끝까지 처리한다.

    GPU 단계는 배타 락 안에서 돈다. 락을 못 잡으면 `GpuBusy` 를 그대로 올려
    호출자(Celery 태스크)가 큐로 되돌리게 한다 — 워커 안에서 대기하면
    슬롯을 붙잡고 있게 되어 더 나쁘다.
    """
    reporter = progress or NullProgress()
    result = PipelineResult(meeting_id=meeting_id, stage=Stage.LOAD)

    def step(stage: str, detail: str = "") -> None:
        result.stage = stage
        reporter.report(meeting_id, stage, _STAGE_START.get(stage, 0), detail)

    try:
        # ── 1. 로드 (CPU) ──────────────────────────────────
        step(Stage.LOAD)
        tracks = loader.load(meeting_id)
        if not tracks:
            result.stage = Stage.FAILED
            result.error = "오디오 트랙이 없습니다"
            reporter.report(meeting_id, Stage.FAILED, 0, result.error)
            return result
        result.track_ids = [t.track_id for t in tracks]

        # ── 2. 정렬 · 주화자 판정 (CPU) ────────────────────
        step(Stage.ALIGN, f"트랙 {len(tracks)}개")
        aligned, analysis, offsets = _align_and_analyze(tracks)
        result.alignment = offsets
        result.track_stats = mt.track_stats(analysis, len(tracks))

        # ── 3. ASR (GPU) ──────────────────────────────────
        step(Stage.TRANSCRIBE)
        if lock_backend is not None:
            with gpu_lease(lock_backend, job_id=f"meeting:{meeting_id}", ttl=gpu_ttl) as lease:
                result.segments = _transcribe_tracks(
                    tracks, aligned, analysis, transcriber, reporter, meeting_id
                )
                # 긴 회의는 TTL을 넘길 수 있다. 다음 GPU 단계 전에 갱신한다.
                lease.extend()
        else:
            result.segments = _transcribe_tracks(
                tracks, aligned, analysis, transcriber, reporter, meeting_id
            )

        if not result.segments:
            result.stage = Stage.FAILED
            result.error = "인식된 발화가 없습니다"
            reporter.report(meeting_id, Stage.FAILED, 0, result.error)
            return result

        # ── 4. LLM 분석 ───────────────────────────────────
        step(Stage.ANALYZE, f"발화 {len(result.segments)}개")
        by_user = {m.user_id: m.name for m in members}
        utterances = [
            (index, by_user.get(seg.user_id, f"화자{seg.user_id}"), seg.text)
            for index, seg in enumerate(result.segments, start=1)
        ]
        analysis_out = analyzer.analyze(
            utterances, prior_decisions=prior_decisions, open_tasks=open_tasks
        )

        # ── 5. 검증 (환각 방어) ────────────────────────────
        step(Stage.VALIDATE)
        result.validation = validate_analysis(
            analysis_out,
            known_utterance_ids=set(range(1, len(result.segments) + 1)),
            members=members,
            meeting_date=meeting_date,
            existing_task_titles=existing_task_titles,
        )
        if result.validation.rejection_rate > 0.5:
            logger.warning(
                "meeting=%s 폐기율이 높습니다 (%.0f%%). 모델·프롬프트 점검이 필요합니다.",
                meeting_id,
                result.validation.rejection_rate * 100,
            )

        step(Stage.DONE)
        return result

    except GpuBusy:
        # 큐로 되돌린다. 워커 안에서 대기하지 않는다.
        raise
    except Exception as exc:
        logger.exception("meeting=%s 처리 실패", meeting_id)
        result.stage = Stage.FAILED
        result.error = str(exc)
        reporter.report(meeting_id, Stage.FAILED, 0, str(exc))
        return result


def _align_and_analyze(
    tracks: list[LoadedTrack],
) -> tuple[list, mt.TrackAnalysis, list[mt.TrackOffset]]:
    sample_rate = tracks[0].sample_rate
    signals = [t.samples for t in tracks]

    offsets = mt.estimate_offsets(
        signals,
        sample_rate=sample_rate,
        server_offsets_sec=[t.started_at_offset_sec for t in tracks],
    )
    aligned = mt.apply_offsets(signals, offsets, sample_rate=sample_rate)
    analysis = mt.analyze_tracks(aligned, sample_rate=sample_rate)
    cleaned = mt.suppress_crosstalk(aligned, analysis, sample_rate=sample_rate)
    return cleaned, analysis, offsets


def _transcribe_tracks(
    tracks: list[LoadedTrack],
    cleaned: list,
    analysis: mt.TrackAnalysis,
    transcriber: Transcriber,
    reporter: ProgressReporter,
    meeting_id: int,
) -> list[TranscribedSegment]:
    """트랙별로 ASR을 돌리고 시간순으로 합친다.

    누출을 제거한 신호를 넣기 때문에 같은 발언이 여러 트랙에서
    중복 인식되지 않는다.
    """
    sample_rate = tracks[0].sample_rate
    segments: list[TranscribedSegment] = []

    overlap_spans = [
        (s.start_ms, s.end_ms) for s in analysis.segments if s.is_overlap
    ]

    for index, (track, signal) in enumerate(zip(tracks, cleaned, strict=True)):
        # 이 트랙 주인이 실제로 말한 구간이 없으면 ASR을 돌리지 않는다.
        # 무음에 ASR을 돌리면 환청(hallucinated transcript)이 나온다.
        if analysis.speaking_ms(index) <= 0:
            continue

        base = _STAGE_START[Stage.TRANSCRIBE]
        span = _STAGE_START[Stage.ANALYZE] - base
        percent = base + int(span * index / max(1, len(tracks)))
        reporter.report(
            meeting_id, Stage.TRANSCRIBE, percent, f"트랙 {index + 1}/{len(tracks)}"
        )

        for start_ms, end_ms, text, confidence in transcriber.transcribe(
            signal, sample_rate
        ):
            if not text.strip():
                continue
            segments.append(
                TranscribedSegment(
                    user_id=track.user_id,
                    track_id=track.track_id,
                    start_ms=start_ms,
                    end_ms=end_ms,
                    text=text.strip(),
                    confidence=confidence,
                    is_overlap=_overlaps(start_ms, end_ms, overlap_spans),
                    speaker_source="track",
                )
            )

    segments.sort(key=lambda s: (s.start_ms, s.user_id))
    return segments


def _overlaps(start_ms: int, end_ms: int, spans: list[tuple[int, int]]) -> bool:
    return any(start_ms < span_end and end_ms > span_start for span_start, span_end in spans)


def transcript_text(segments: list[TranscribedSegment], members: list[TeamMemberName]) -> str:
    """LLM 입력용 전사 텍스트. 발화 ID가 앞에 붙는다."""
    by_user = {m.user_id: m.name for m in members}
    return format_transcript(
        [
            (index, by_user.get(seg.user_id, f"화자{seg.user_id}"), seg.text)
            for index, seg in enumerate(segments, start=1)
        ]
    )
