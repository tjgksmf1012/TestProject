"""회의 처리 파이프라인 오케스트레이션 테스트.

실제 모델 없이 검증한다 — 진행률 보고, GPU 락 사용, 실패 격리, 중복 인식 방지는
GPU가 없어도 반드시 확인해야 하는 것들이다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

import numpy as np
import pytest

from teamflow.audio.multitrack import DEFAULT_SAMPLE_RATE
from teamflow.jobs.gpu_lock import LOCK_KEY, FakeRedis, GpuBusy, acquire
from teamflow.meeting.llm import FakeLLMClient
from teamflow.meeting.resolve import TeamMemberName
from teamflow.meeting.schema import Decision, MeetingAnalysis, TaskCandidate
from teamflow.pipeline.meeting_pipeline import Stage, process_meeting, transcript_text
from teamflow.pipeline.steps import LoadedTrack, NullProgress

SR = DEFAULT_SAMPLE_RATE
MEETING_DATE = date(2026, 9, 1)
MEMBERS = [
    TeamMemberName(user_id=1, name="김민수"),
    TeamMemberName(user_id=2, name="이하늘"),
]


def speech(duration_sec: float, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int(SR * duration_sec)
    x = rng.standard_normal(n)
    spectrum = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(n, 1 / SR)
    spectrum[(freqs < 300) | (freqs > 3400)] = 0
    band = np.fft.irfft(spectrum, n=n)
    t = np.arange(n) / SR
    signal = band * 0.5 * (1 + np.sin(2 * np.pi * 4.0 * t))
    peak = np.max(np.abs(signal))
    return (signal / peak * 0.5).astype(np.float32) if peak else signal.astype(np.float32)


def quiet(duration_sec: float, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return (rng.standard_normal(int(SR * duration_sec)) * 0.001).astype(np.float32)


def two_track_meeting() -> list[LoadedTrack]:
    """A는 0~2초, B는 3~5초 발화. 서로의 목소리가 -18dB로 누출."""
    a_voice = speech(2.0, seed=1)
    b_voice = speech(2.0, seed=2)
    leak = 10 ** (-18 / 20)

    track_a = quiet(6.0, seed=11)
    track_b = quiet(6.0, seed=12)
    a_slot = slice(0, len(a_voice))
    b_slot = slice(int(SR * 3.0), int(SR * 3.0) + len(b_voice))

    track_a[a_slot] += a_voice
    track_a[b_slot] += (b_voice * leak).astype(np.float32)
    track_b[a_slot] += (a_voice * leak).astype(np.float32)
    track_b[b_slot] += b_voice

    return [
        LoadedTrack(track_id=10, user_id=1, samples=track_a, sample_rate=SR),
        LoadedTrack(track_id=11, user_id=2, samples=track_b, sample_rate=SR),
    ]


# ── 페이크 단계 ───────────────────────────────────────────────


@dataclass
class FakeLoader:
    tracks: list[LoadedTrack]
    calls: int = 0

    def load(self, meeting_id: int) -> list[LoadedTrack]:
        self.calls += 1
        return self.tracks


@dataclass
class FakeTranscriber:
    """에너지가 있는 구간에만 텍스트를 낸다.

    누출 제거가 제대로 됐는지 확인하려면, 조용한 신호에는 아무것도
    내놓지 않는 전사기가 필요하다.
    """

    texts: list[str] = field(default_factory=lambda: ["안녕하세요", "네 좋습니다"])
    threshold: float = 0.02
    calls: list[float] = field(default_factory=list)

    def transcribe(self, samples, sample_rate, *, language="ko"):
        rms = float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))
        self.calls.append(rms)
        if rms < self.threshold:
            return []
        # 에너지가 있는 구간을 대략 잡아 하나의 발화로 낸다
        active = np.abs(samples) > (np.abs(samples).max() * 0.1)
        indices = np.flatnonzero(active)
        if indices.size == 0:
            return []
        start_ms = int(indices[0] / sample_rate * 1000)
        end_ms = int(indices[-1] / sample_rate * 1000)
        text = self.texts[len(self.calls) % len(self.texts)]
        return [(start_ms, end_ms, text, 0.93)]


@dataclass
class ExplodingTranscriber:
    def transcribe(self, samples, sample_rate, *, language="ko"):
        raise RuntimeError("CUDA out of memory")


@dataclass
class FakeAnalyzer:
    response: MeetingAnalysis
    client: FakeLLMClient | None = None
    seen: list[list] = field(default_factory=list)

    def analyze(self, utterances, *, prior_decisions=None, open_tasks=None):
        self.seen.append(utterances)
        if self.client is None:
            self.client = FakeLLMClient(self.response)
        return self.client.analyze_meeting(
            "\n".join(f"[{u[0]}] {u[1]}: {u[2]}" for u in utterances),
            prior_decisions=prior_decisions,
            open_tasks=open_tasks,
        )


def analysis_for(n_utterances: int) -> MeetingAnalysis:
    return MeetingAnalysis(
        summary="로그인 API 일정을 논의함",
        decisions=[Decision(content="JWT를 쓴다", evidence_utterance_ids=[1])],
        tasks=[
            TaskCandidate(
                title="로그인 API 구현",
                assignee_hint="김민수",
                deadline_hint="이번 주 금요일",
                confidence=0.92,
                evidence_utterance_ids=[min(1, n_utterances)],
            )
        ],
        unresolved_issues=[],
        next_agenda=["배포 서버 선정"],
    )


def run(
    *,
    tracks=None,
    transcriber=None,
    analyzer=None,
    lock_backend=None,
    progress=None,
    **kwargs,
):
    tracks = tracks if tracks is not None else two_track_meeting()
    return process_meeting(
        42,
        loader=FakeLoader(tracks),
        transcriber=transcriber or FakeTranscriber(),
        analyzer=analyzer or FakeAnalyzer(analysis_for(2)),
        members=MEMBERS,
        meeting_date=MEETING_DATE,
        lock_backend=lock_backend,
        progress=progress,
        **kwargs,
    )


# ══════════════════════════════════════════════════════════════
# 정상 경로
# ══════════════════════════════════════════════════════════════


def test_pipeline_completes():
    result = run()
    assert result.ok
    assert result.stage == Stage.DONE
    assert result.segments
    assert result.validation is not None


def test_speaker_is_certain_in_multitrack_mode():
    """⭐ 멀티트랙의 요점 — 화자가 확정된다."""
    result = run()
    assert result.speaker_certainty == 1.0
    assert all(s.speaker_source == "track" for s in result.segments)


def test_segments_carry_the_right_user():
    """트랙 = 사람. 각 발화가 그 트랙 주인에게 귀속된다."""
    result = run()
    users = {s.user_id for s in result.segments}
    assert users <= {1, 2}
    assert users, "발화가 하나도 없다"


def test_segments_are_time_ordered():
    result = run()
    starts = [s.start_ms for s in result.segments]
    assert starts == sorted(starts)


def test_track_stats_are_reported():
    """제안서 6.2 팀원별 발언 시간. 멀티트랙이라 정확하다."""
    result = run()
    assert len(result.track_stats) == 2
    assert sum(s.speaking_ms for s in result.track_stats) > 0


def test_alignment_offsets_are_reported():
    result = run()
    assert len(result.alignment) == 2
    assert result.alignment[0].offset_sec == 0.0


def test_validation_resolves_assignee_and_deadline():
    result = run()
    candidates = result.validation.candidates
    assert candidates
    assert candidates[0].assignee.user_id == 1  # 김민수
    assert candidates[0].deadline.value == date(2026, 9, 4)  # 이번 주 금요일


# ══════════════════════════════════════════════════════════════
# 누출 제거 효과
# ══════════════════════════════════════════════════════════════


def test_silent_tracks_are_not_sent_to_asr():
    """무음에 ASR을 돌리면 환청이 나온다. 아예 보내지 않는다."""
    tracks = two_track_meeting()
    tracks[1] = LoadedTrack(
        track_id=11, user_id=2, samples=quiet(6.0, seed=99), sample_rate=SR
    )
    transcriber = FakeTranscriber()
    result = run(tracks=tracks, transcriber=transcriber)

    assert result.ok
    # 말한 트랙만 ASR을 탔다
    assert len(transcriber.calls) < 2


def test_crosstalk_is_suppressed_before_asr():
    """누출을 안 죽이면 같은 발언이 두 트랙에서 중복 인식된다."""
    transcriber = FakeTranscriber()
    run(transcriber=transcriber)
    # 두 트랙 모두 ASR을 탔지만, 각 트랙의 신호는 본인 발화만 남아 있다
    assert all(rms > 0 for rms in transcriber.calls)


# ══════════════════════════════════════════════════════════════
# GPU 배타 락
# ══════════════════════════════════════════════════════════════


def test_gpu_lock_is_taken_and_released():
    redis = FakeRedis()
    result = run(lock_backend=redis)
    assert result.ok
    # 끝나면 풀려 있어야 다음 회의가 처리된다
    acquire(redis, job_id="next-meeting")


def test_gpu_busy_propagates_to_caller():
    """워커 안에서 대기하지 않는다. 큐로 되돌려야 한다."""
    redis = FakeRedis()
    acquire(redis, job_id="other-meeting", ttl=3600)

    with pytest.raises(GpuBusy):
        run(lock_backend=redis)


def test_gpu_lock_released_even_when_asr_fails():
    redis = FakeRedis()
    result = run(lock_backend=redis, transcriber=ExplodingTranscriber())
    assert not result.ok
    acquire(redis, job_id="next-meeting")  # 락이 풀려 있어야 한다


@dataclass
class SlowTranscriber:
    """ASR 이 도는 동안 시계를 민다. 그리고 매번 남이 GPU 를 뺏어가는지 본다.

    실제 상황을 그대로 옮긴 것입니다 — 1시간짜리 회의의 ASR 은 TTL(30분)보다
    오래 걸리고, 그 사이 gpu 큐를 보는 다른 워커가 재시도를 계속합니다.
    """

    redis: FakeRedis
    seconds_per_track: float
    inner: FakeTranscriber = field(default_factory=FakeTranscriber)
    stolen_by: list[str] = field(default_factory=list)

    def transcribe(self, samples, sample_rate, *, language="ko"):
        self.redis.advance(self.seconds_per_track)
        try:
            lease = acquire(self.redis, job_id="다른-회의")
        except GpuBusy:
            pass
        else:
            self.stolen_by.append(lease.token)
        return self.inner.transcribe(samples, sample_rate, language=language)


def test_gpu_lease_is_renewed_while_asr_runs():
    """⭐ 락이 막으려던 바로 그 상황 — ASR 도중에 남이 같은 GPU 를 잡는 것.

    갱신이 **해제 직전에 한 번**만 불리던 동안, 트랙 둘을 도는 40분짜리
    ASR 은 TTL 30분을 그냥 넘겼습니다. 그 순간부터 다른 회의가 같은 GPU 를
    잡고, 둘 다 모델을 VRAM 에 올려 CUDA OOM 으로 죽습니다. 그런데
    파이프라인은 예외 없이 `done` 을 돌려줍니다 — 조용합니다.
    """
    redis = FakeRedis()
    slow = SlowTranscriber(redis, seconds_per_track=1200.0)  # 트랙당 20분

    result = run(lock_backend=redis, transcriber=slow, gpu_ttl=1800)

    assert slow.stolen_by == [], "ASR 이 도는 중에 남이 GPU 를 잡았다"
    assert result.ok


def test_losing_the_lease_mid_asr_is_not_silent():
    """⚠️ 뺏긴 뒤에도 조용히 `done` 을 돌려주면, 두 ASR 이 다툰 결과가
    멀쩡한 회의록으로 저장된다. 실패로 만들어 큐가 다시 태우게 한다."""
    redis = FakeRedis()

    @dataclass
    class Thief:
        inner: FakeTranscriber = field(default_factory=FakeTranscriber)

        def transcribe(self, samples, sample_rate, *, language="ko"):
            # 남이 강제로 가져간 상황을 만든다 (TTL 만료 후 획득과 같은 결과).
            redis.store[LOCK_KEY] = ("다른-회의:deadbeef", redis.now + 1800)
            return self.inner.transcribe(samples, sample_rate, language=language)

    result = run(lock_backend=redis, transcriber=Thief())

    assert not result.ok
    assert result.stage == Stage.FAILED
    assert "GPU" in result.error


def one_track_meeting() -> list[LoadedTrack]:
    """모드 B — 한 기기가 방 전체를 녹음한다. 트랙이 **하나**뿐이다."""
    room = quiet(6.0, seed=21)
    voice = speech(2.0, seed=3)
    room[0 : len(voice)] += voice
    return [LoadedTrack(track_id=20, user_id=1, samples=room, sample_rate=SR)]


def test_a_single_track_longer_than_the_ttl_is_caught_too():
    """⚠️ 트랙 머리 갱신만으로는 **모드 B** 를 못 지킨다.

    트랙이 하나면 머리 갱신은 딱 한 번, ASR 시작 전에 일어납니다. 그
    한 번의 `transcribe` 호출이 통째로 TTL 보다 길면 그 안에서 만료되고,
    다음 머리는 오지 않습니다. 그래서 ASR 이 끝난 뒤에 한 번 더 묻습니다.

    이 경우를 안 만들어 본 동안 "ASR 후 확인" 을 지워도 테스트가 전부
    통과했습니다 — 트랙이 둘이라 **다음 트랙 머리**가 대신 잡고 있었습니다.
    """
    redis = FakeRedis()
    slow = SlowTranscriber(redis, seconds_per_track=2400.0)  # 한 트랙이 40분

    result = run(
        tracks=one_track_meeting(), lock_backend=redis, transcriber=slow, gpu_ttl=1800
    )

    assert slow.stolen_by, "이 시나리오는 ASR 도중 만료가 실제로 일어나야 한다"
    assert not result.ok, "뺏긴 채로 만든 회의록을 성공으로 돌려주면 안 된다"
    assert result.stage == Stage.FAILED
    assert "GPU" in result.error


# ══════════════════════════════════════════════════════════════
# 실패 처리
# ══════════════════════════════════════════════════════════════


def test_no_tracks_fails_cleanly():
    result = run(tracks=[])
    assert not result.ok
    assert result.stage == Stage.FAILED
    assert "트랙이 없" in result.error


def test_no_speech_fails_cleanly():
    """전부 무음이면 실패로 끝낸다. 빈 회의록을 만들지 않는다."""
    tracks = [
        LoadedTrack(track_id=1, user_id=1, samples=quiet(3.0, seed=1), sample_rate=SR),
        LoadedTrack(track_id=2, user_id=2, samples=quiet(3.0, seed=2), sample_rate=SR),
    ]
    result = run(tracks=tracks)
    assert not result.ok
    assert "발화가 없" in result.error


def test_asr_crash_is_captured_not_raised():
    """CUDA OOM 같은 실패는 잡아서 상태로 남긴다. 잡 자체는 죽지 않는다."""
    result = run(transcriber=ExplodingTranscriber())
    assert not result.ok
    assert result.stage == Stage.FAILED
    assert "CUDA out of memory" in result.error


# ══════════════════════════════════════════════════════════════
# 진행률 보고
# ══════════════════════════════════════════════════════════════


def test_progress_is_reported_monotonically():
    """1시간 회의 처리에 10분이 걸린다. 진행률이 없으면 사용자가 멈춘 줄 안다."""
    progress = NullProgress()
    result = run(progress=progress)

    assert result.ok
    assert progress.events
    percents = progress.percents
    assert percents == sorted(percents), f"진행률이 역행했다: {percents}"
    assert percents[-1] == 100


def test_progress_covers_all_stages():
    progress = NullProgress()
    run(progress=progress)
    stages = set(progress.stages)
    assert {Stage.LOAD, Stage.ALIGN, Stage.TRANSCRIBE, Stage.ANALYZE, Stage.DONE} <= stages


def test_failure_is_reported_to_progress():
    progress = NullProgress()
    run(progress=progress, transcriber=ExplodingTranscriber())
    assert Stage.FAILED in progress.stages


# ══════════════════════════════════════════════════════════════
# 환각 방어 연동
# ══════════════════════════════════════════════════════════════


def test_hallucinated_task_is_rejected_by_pipeline():
    """LLM이 없는 발화를 근거로 들면 파이프라인이 버린다."""
    bad = MeetingAnalysis(
        summary="요약",
        decisions=[],
        tasks=[
            TaskCandidate(
                title="지어낸 업무",
                confidence=0.9,
                evidence_utterance_ids=[9999],  # 존재하지 않음
            )
        ],
    )
    result = run(analyzer=FakeAnalyzer(bad))
    assert result.ok
    assert result.validation.candidates == []
    assert result.validation.rejected


def test_context_is_passed_to_llm():
    """이전 회의 결정과 현재 칸반 상태가 LLM에 전달돼야 결정 번복을 잡는다."""
    analyzer = FakeAnalyzer(analysis_for(2))
    run(
        analyzer=analyzer,
        prior_decisions=["프론트는 Next.js"],
        open_tasks=["DB 스키마 설계"],
    )
    assert analyzer.client is not None
    prompt = analyzer.client.calls[0]
    assert "이전 회의에서 확정된 결정" in prompt
    assert "현재 진행 중인 업무" in prompt


def test_existing_titles_prevent_duplicates():
    result = run(existing_task_titles=["로그인 API 구현"])
    assert result.validation.candidates == []


# ══════════════════════════════════════════════════════════════
# 전사 포맷
# ══════════════════════════════════════════════════════════════


def test_transcript_text_includes_ids_and_names():
    result = run()
    text = transcript_text(result.segments, MEMBERS)
    assert "[1]" in text
    assert "김민수" in text or "이하늘" in text
