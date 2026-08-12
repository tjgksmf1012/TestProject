"""멀티트랙 정렬·누출 제거 테스트.

합성 신호로 검증한다. 실제 회의 오디오 없이도 알고리즘의 정확성을
숫자로 확인할 수 있다 — 지연을 d 샘플 넣었으면 d 가 나와야 한다.
"""

from __future__ import annotations

import numpy as np
import pytest

from teamflow.audio.multitrack import (
    DEFAULT_SAMPLE_RATE,
    SpeakerFrame,
    analyze_tracks,
    apply_offsets,
    estimate_noise_floor_db,
    estimate_offsets,
    frame_rms,
    gcc_phat,
    speaking_ratios,
    suppress_crosstalk,
    to_db,
    track_stats,
)

SR = DEFAULT_SAMPLE_RATE
RNG = np.random.default_rng(20260901)


# ── 합성 신호 도구 ────────────────────────────────────────────


def speech_like(duration_sec: float, *, seed: int = 0) -> np.ndarray:
    """음성 비슷한 신호. 대역 제한된 잡음에 음절 포락선을 씌운다.

    순수 사인파를 쓰면 상관 함수에 주기적 피크가 생겨서
    지연 추정이 비현실적으로 쉬워진다. 실제 음성처럼 광대역이어야 한다.
    """
    rng = np.random.default_rng(seed)
    n = int(SR * duration_sec)
    noise = rng.standard_normal(n)

    # 대역 제한 (300~3400Hz, 전화 대역)
    spectrum = np.fft.rfft(noise)
    freqs = np.fft.rfftfreq(n, 1 / SR)
    spectrum[(freqs < 300) | (freqs > 3400)] = 0
    band = np.fft.irfft(spectrum, n=n)

    # 음절 포락선 (약 4Hz)
    t = np.arange(n) / SR
    envelope = 0.5 * (1 + np.sin(2 * np.pi * 4.0 * t))
    signal = band * envelope
    peak = np.max(np.abs(signal))
    return (signal / peak * 0.5).astype(np.float32) if peak > 0 else signal.astype(np.float32)


def silence(duration_sec: float, *, noise_db: float = -60.0) -> np.ndarray:
    n = int(SR * duration_sec)
    amp = 10 ** (noise_db / 20.0)
    return (RNG.standard_normal(n) * amp).astype(np.float32)


def delay_signal(signal: np.ndarray, samples: int) -> np.ndarray:
    if samples == 0:
        return signal.copy()
    if samples > 0:
        return np.concatenate([np.zeros(samples, dtype=np.float32), signal])
    return signal[-samples:].copy()


def attenuate(signal: np.ndarray, db: float) -> np.ndarray:
    return (signal * (10 ** (db / 20.0))).astype(np.float32)


def build_two_speaker_meeting(
    *, leak_db: float = -18.0, seed: int = 1
) -> tuple[np.ndarray, np.ndarray]:
    """A가 0~2초, B가 3~5초 말하는 회의를 2트랙으로 만든다.

    각 트랙에는 본인 목소리(크게)와 상대 목소리(누출, 작게)가 함께 들어간다.
    실제 회의실에서 벌어지는 일 그대로다.
    """
    a_voice = speech_like(2.0, seed=seed)
    b_voice = speech_like(2.0, seed=seed + 100)

    total = int(SR * 6.0)
    a_slot = slice(0, len(a_voice))
    b_slot = slice(int(SR * 3.0), int(SR * 3.0) + len(b_voice))

    track_a = silence(6.0)
    track_b = silence(6.0)

    track_a[a_slot] += a_voice
    track_a[b_slot] += attenuate(b_voice, leak_db)  # B의 누출

    track_b[a_slot] += attenuate(a_voice, leak_db)  # A의 누출
    track_b[b_slot] += b_voice

    assert len(track_a) == len(track_b) == total
    return track_a, track_b


# ══════════════════════════════════════════════════════════════
# 1. GCC-PHAT 시간 정렬
# ══════════════════════════════════════════════════════════════


@pytest.mark.parametrize("delay_samples", [0, 1, 16, 160, 800, -160, -800])
def test_gcc_phat_recovers_known_delay(delay_samples: int):
    """지연을 d 샘플 넣었으면 d 가 나와야 한다."""
    base = speech_like(1.0, seed=7)
    ref = np.concatenate([np.zeros(1000, dtype=np.float32), base])
    sig = delay_signal(ref, delay_samples) if delay_samples >= 0 else ref[-delay_samples:]

    length = min(len(sig), len(ref))
    tau, confidence = gcc_phat(sig[:length], ref[:length], sample_rate=SR, max_tau=0.5)

    recovered = round(tau * SR)
    assert abs(recovered - delay_samples) <= 1, (
        f"지연 {delay_samples} 샘플을 넣었는데 {recovered} 로 추정됨"
    )
    assert confidence > 0.3


def test_gcc_phat_is_robust_to_attenuation():
    """누출 신호는 크게 감쇠돼 있다. 그래도 지연은 잡혀야 한다."""
    base = speech_like(1.5, seed=11)
    ref = np.concatenate([np.zeros(500, dtype=np.float32), base])
    sig = attenuate(delay_signal(ref, 240), -20.0)

    length = min(len(sig), len(ref))
    tau, _ = gcc_phat(sig[:length], ref[:length], sample_rate=SR, max_tau=0.5)
    assert abs(round(tau * SR) - 240) <= 2


def test_gcc_phat_respects_max_tau():
    """물리적으로 불가능한 지연은 배제한다."""
    base = speech_like(1.0, seed=13)
    ref = np.concatenate([np.zeros(8000, dtype=np.float32), base])
    sig = delay_signal(ref, 6400)  # 400ms

    length = min(len(sig), len(ref))
    tau, _ = gcc_phat(sig[:length], ref[:length], sample_rate=SR, max_tau=0.05)
    assert abs(tau) <= 0.05


def test_gcc_phat_low_confidence_when_nobody_speaks():
    """아무도 말하지 않은 구간에서는 신뢰도가 낮아야 한다.

    이게 서버 타임스탬프 폴백을 결정하는 실제 판별 조건이다.

    ⚠️ "서로 다른 음성이면 신뢰도가 낮다"로 테스트하지 않는 이유:
    `speech_like` 가 만드는 신호는 시드가 달라도 같은 대역(300~3400Hz)과
    같은 음절 포락선(4Hz)을 공유해서 **구조적으로 상관**된다. 실측 z-스코어가
    82 나온다. 실제 사람 목소리도 스펙트럼 구조를 공유하므로 이건
    합성기의 결함이 아니라 음성 신호의 성질이다.

    폴백이 필요한 진짜 상황은 "겹치는 구간에 아무 발화도 없을 때"다.
    """
    quiet_a = silence(3.0)
    quiet_b = silence(3.0)
    _, quiet_confidence = gcc_phat(quiet_a, quiet_b, sample_rate=SR, max_tau=0.5)

    voice = speech_like(1.5, seed=21)
    delayed = delay_signal(voice, 320)[: len(voice)]
    _, voice_confidence = gcc_phat(delayed, voice, sample_rate=SR, max_tau=0.5)

    assert quiet_confidence < 0.3, f"침묵에서 신뢰도가 높게 나옴: {quiet_confidence:.3f}"
    assert voice_confidence > 0.8, f"발화에서 신뢰도가 낮게 나옴: {voice_confidence:.3f}"


def test_gcc_phat_confidence_survives_heavy_attenuation():
    """누출 신호는 -20dB 이상 감쇠돼 있다. PHAT은 크기를 정규화하므로
    감쇠가 신뢰도를 떨어뜨리지 않아야 한다 — 그게 PHAT을 쓰는 이유다."""
    voice = speech_like(1.5, seed=23)
    loud = delay_signal(voice, 160)[: len(voice)]
    quiet = attenuate(loud, -26.0)

    _, loud_conf = gcc_phat(loud, voice, sample_rate=SR, max_tau=0.5)
    _, quiet_conf = gcc_phat(quiet, voice, sample_rate=SR, max_tau=0.5)
    assert quiet_conf == pytest.approx(loud_conf, abs=0.05)


def test_estimate_offsets_reference_is_zero():
    track_a, track_b = build_two_speaker_meeting()
    offsets = estimate_offsets([track_a, track_b], sample_rate=SR)
    assert offsets[0].offset_sec == 0.0
    assert offsets[0].track_index == 0


def start_late(room: np.ndarray, samples: int) -> np.ndarray:
    """**늦게** 녹음을 시작한 기기 — 앞부분을 놓친다.

    앞에 0을 붙이는 `delay_signal` 은 반대다. 그건 소리가 나기 전부터 켜져
    있던 기기, 즉 **일찍** 시작한 쪽이다. 이 둘을 헷갈린 탓에 부호 규약이
    반대로 굳어 있었고, 테스트가 그 반대를 고정하고 있었다.
    """
    return room[samples:].copy()


#: `offset_sec` 의 규약 — "이 트랙을 공통 시간축에서 얼마나 뒤로 밀어야 하는가".
#: `apply_offsets` 가 앞을 그만큼 패딩하고, 서버 타임스탬프 폴백
#: (`started_at - earliest`)도 같은 부호다. 늦게 시작한 기기는 **양수**.


def test_estimate_offsets_recovers_late_start():
    """B 기기가 100ms **늦게** 시작한 상황 — 앞 100ms 를 놓쳤다."""
    room, _ = build_two_speaker_meeting(seed=31)
    skew = int(SR * 0.1)
    late_b = start_late(room, skew)

    offsets = estimate_offsets([room[: len(late_b)], late_b], sample_rate=SR)

    assert abs(offsets[1].offset_ms - 100) <= 15, (
        f"늦게 시작한 기기는 +100ms 여야 하는데 {offsets[1].offset_ms}ms"
    )


def test_estimate_offsets_recovers_early_start():
    """반대 방향도 맞아야 한다 — 일찍 시작한 기기는 음수."""
    room, _ = build_two_speaker_meeting(seed=31)
    skew = int(SR * 0.1)
    early_b = delay_signal(room, skew)[: len(room)]

    offsets = estimate_offsets([room, early_b], sample_rate=SR)

    assert abs(offsets[1].offset_ms + 100) <= 15, (
        f"일찍 시작한 기기는 -100ms 여야 하는데 {offsets[1].offset_ms}ms"
    )


@pytest.mark.parametrize("skew_ms", [-250, -100, -30, 30, 100, 250])
def test_estimate_then_apply_actually_aligns(skew_ms: int):
    """⭐ **왕복** 테스트 — 이게 없어서 정렬이 반대로 가는 걸 못 잡았다.

    기존 테스트는 `gcc_phat` 이 지연을 맞히는지(맞았다), `apply_offsets` 가
    길이를 맞추는지(맞았다)만 봤다. 둘을 이어 붙였을 때 실제로 겹치는지는
    아무도 확인하지 않았고, 실제로 겹치지 않았다.

    실측(수정 전): 잔차 1.9881 → 1.9651. 즉 **전혀 정렬되지 않았다.**
    """
    room, _ = build_two_speaker_meeting(seed=41)
    skew = int(SR * abs(skew_ms) / 1000)
    span = len(room) - skew

    reference = room[:span]
    shifted = (
        start_late(room, skew)[:span]
        if skew_ms > 0
        else delay_signal(room, skew)[:span]
    )

    offsets = estimate_offsets([reference, shifted], sample_rate=SR)
    aligned = apply_offsets([reference, shifted], offsets, sample_rate=SR)

    n = min(len(a) for a in aligned)
    power = float(np.mean(reference.astype(np.float64) ** 2))
    before = float(np.mean((reference[:n] - shifted[:n]).astype(np.float64) ** 2)) / power
    after = float(np.mean((aligned[0][:n] - aligned[1][:n]).astype(np.float64) ** 2)) / power

    assert after < before * 0.25, (
        f"정렬 후에도 어긋나 있습니다 (전 {before:.3f} → 후 {after:.3f}). "
        f"추정값 {offsets[1].offset_ms}ms 의 부호가 반대일 수 있습니다"
    )


def test_estimate_offsets_falls_back_to_server_timestamps():
    """신호가 무관하면 서버 타임스탬프를 쓴다.

    억지로 신호를 믿으면 트랙이 수백 ms 어긋나 발언 순서가 뒤집힌다.
    """
    a = silence(3.0)
    b = silence(3.0)  # 아무도 말하지 않음 → 상관 무의미

    offsets = estimate_offsets(
        [a, b], sample_rate=SR, server_offsets_sec=[0.0, 0.25]
    )
    assert offsets[1].method == "server_timestamp"
    assert offsets[1].offset_ms == 250


def test_apply_offsets_aligns_and_pads():
    a = speech_like(1.0, seed=41)
    b = speech_like(1.0, seed=42)
    from teamflow.audio.multitrack import TrackOffset

    offsets = [
        TrackOffset(0, 0.0, 1.0, "gcc_phat"),
        TrackOffset(1, 0.1, 0.9, "gcc_phat"),
    ]
    aligned = apply_offsets([a, b], offsets, sample_rate=SR)

    assert len({len(t) for t in aligned}) == 1, "정렬 후 길이가 같아야 한다"
    # 두 번째 트랙 앞부분은 패딩된 0
    assert np.allclose(aligned[1][: int(SR * 0.1)], 0.0)


def test_apply_offsets_handles_negative_offsets():
    from teamflow.audio.multitrack import TrackOffset

    a = speech_like(0.5, seed=51)
    b = speech_like(0.5, seed=52)
    offsets = [
        TrackOffset(0, 0.05, 1.0, "gcc_phat"),
        TrackOffset(1, -0.05, 1.0, "gcc_phat"),
    ]
    aligned = apply_offsets([a, b], offsets, sample_rate=SR)
    assert len(aligned[0]) == len(aligned[1])
    # 더 이른 쪽(b)이 0에서 시작
    assert not np.allclose(aligned[1][:10], 0.0) or np.allclose(aligned[0][:10], 0.0)


# ══════════════════════════════════════════════════════════════
# 2. 프레임 에너지
# ══════════════════════════════════════════════════════════════


def test_frame_rms_shape_and_values():
    signal = np.ones(1600, dtype=np.float32)
    rms = frame_rms(signal, frame_len=320, hop=160)
    assert rms.shape[0] == 1 + (1600 - 320) // 160
    assert np.allclose(rms, 1.0)


def test_frame_rms_pads_short_signal():
    rms = frame_rms(np.ones(100, dtype=np.float32), frame_len=320, hop=160)
    assert rms.shape[0] >= 1


def test_to_db_has_floor():
    assert to_db(np.array([0.0]))[0] == -100.0


def test_noise_floor_tracks_quiet_portion():
    """대부분 조용하고 일부만 큰 신호 → 잡음 바닥은 조용한 쪽."""
    quiet = np.full(80, -60.0)
    loud = np.full(20, -10.0)
    floor = estimate_noise_floor_db(np.concatenate([quiet, loud]))
    assert -65 < floor < -55


# ══════════════════════════════════════════════════════════════
# 3. 주화자 판정 — 핵심
# ══════════════════════════════════════════════════════════════


def test_primary_speaker_follows_the_loudest_track():
    """⭐ 멀티트랙의 핵심.

    본인 마이크가 가장 가까우므로, 에너지가 가장 큰 트랙의 주인이 발화자다.
    AI가 "이 목소리가 누구인가"를 맞힐 필요가 없다.
    """
    track_a, track_b = build_two_speaker_meeting(seed=61)
    analysis = analyze_tracks([track_a, track_b], sample_rate=SR)

    # A는 0~2초, B는 3~5초에 말했다
    hop = analysis.hop_ms
    a_window = analysis.primary[int(500 / hop) : int(1500 / hop)]
    b_window = analysis.primary[int(3500 / hop) : int(4500 / hop)]

    assert (a_window == 0).mean() > 0.8, f"A 구간에서 A가 주화자여야 함: {a_window[:20]}"
    assert (b_window == 1).mean() > 0.8, f"B 구간에서 B가 주화자여야 함: {b_window[:20]}"


def test_silence_is_labelled_silence():
    a = silence(2.0)
    b = silence(2.0)
    analysis = analyze_tracks([a, b], sample_rate=SR)
    assert (analysis.primary == SpeakerFrame.SILENCE).mean() > 0.9


def test_crosstalk_does_not_flip_the_speaker():
    """누출이 심해도(-12dB) 주화자가 바뀌면 안 된다."""
    track_a, track_b = build_two_speaker_meeting(leak_db=-12.0, seed=71)
    analysis = analyze_tracks([track_a, track_b], sample_rate=SR)
    hop = analysis.hop_ms
    a_window = analysis.primary[int(500 / hop) : int(1500 / hop)]
    assert (a_window == 0).mean() > 0.7


def test_speaking_time_is_measured_per_track():
    """제안서 6.2의 팀원별 발언 시간. 멀티트랙이라 정확하다."""
    track_a, track_b = build_two_speaker_meeting(seed=81)
    analysis = analyze_tracks([track_a, track_b], sample_rate=SR)

    a_ms = analysis.speaking_ms(0)
    b_ms = analysis.speaking_ms(1)
    # 각자 약 2초씩 말했다
    assert 1200 < a_ms < 2600, f"A 발언 시간 {a_ms}ms"
    assert 1200 < b_ms < 2600, f"B 발언 시간 {b_ms}ms"


def test_simultaneous_speech_is_flagged_as_overlap():
    """동시 발언 구간이 표시되어야 한다.

    멀티트랙이라 각자 잡히긴 하지만, 이 구간은 제안서 6.5의
    "동시 발언·겹침 구간" 분석 입력이 된다.
    """
    voice_a = speech_like(1.0, seed=91)
    voice_b = speech_like(1.0, seed=92)

    track_a = silence(2.0)
    track_b = silence(2.0)
    span = slice(int(SR * 0.5), int(SR * 0.5) + len(voice_a))
    # 같은 시각에 둘 다 비슷한 세기로 말한다
    track_a[span] += voice_a
    track_a[span] += attenuate(voice_b, -3.0)
    track_b[span] += voice_b
    track_b[span] += attenuate(voice_a, -3.0)

    analysis = analyze_tracks([track_a, track_b], sample_rate=SR)
    overlap_ms = int(analysis.overlap.sum() * analysis.hop_ms)
    assert overlap_ms > 300, f"동시 발언이 탐지되지 않음 ({overlap_ms}ms)"


def test_clear_single_speaker_is_not_flagged_as_overlap():
    track_a, track_b = build_two_speaker_meeting(leak_db=-20.0, seed=101)
    analysis = analyze_tracks([track_a, track_b], sample_rate=SR)
    speech_frames = analysis.primary >= 0
    if speech_frames.any():
        overlap_ratio = analysis.overlap[speech_frames].mean()
        assert overlap_ratio < 0.35, f"단독 발화가 겹침으로 잘못 표시됨 ({overlap_ratio:.2f})"


def test_different_mic_sensitivity_does_not_break_detection():
    """기기마다 마이크 감도가 다르다. 자기 잡음 바닥 기준으로 정규화해야 한다."""
    track_a, track_b = build_two_speaker_meeting(seed=111)
    quiet_b = attenuate(track_b, -12.0)  # B 기기가 전체적으로 작게 녹음

    analysis = analyze_tracks([track_a, quiet_b], sample_rate=SR)
    hop = analysis.hop_ms
    b_window = analysis.primary[int(3500 / hop) : int(4500 / hop)]
    assert (b_window == 1).mean() > 0.6, "감도 차 때문에 B를 놓침"


# ══════════════════════════════════════════════════════════════
# 4. 구간화
# ══════════════════════════════════════════════════════════════


def test_segments_cover_both_speakers():
    track_a, track_b = build_two_speaker_meeting(seed=121)
    analysis = analyze_tracks([track_a, track_b], sample_rate=SR)

    tracks_seen = {s.track_index for s in analysis.segments}
    assert tracks_seen == {0, 1}


def test_segments_are_ordered_and_non_negative():
    track_a, track_b = build_two_speaker_meeting(seed=131)
    analysis = analyze_tracks([track_a, track_b], sample_rate=SR)
    for segment in analysis.segments:
        assert segment.start_ms >= 0
        assert segment.end_ms > segment.start_ms


def test_short_blips_are_discarded():
    """기침·문 닫는 소리가 발화로 잡히면 안 된다."""
    track = silence(2.0)
    blip = speech_like(0.05, seed=141)  # 50ms
    track[int(SR * 1.0) : int(SR * 1.0) + len(blip)] += blip

    analysis = analyze_tracks([track, silence(2.0)], sample_rate=SR, min_segment_ms=200)
    assert all(s.duration_ms >= 200 for s in analysis.segments)


# ══════════════════════════════════════════════════════════════
# 5. 누출 제거
# ══════════════════════════════════════════════════════════════


def test_suppress_crosstalk_attenuates_other_speakers_span():
    """ASR에 넣기 전 누출을 죽인다.

    안 하면 같은 발언이 여러 트랙에서 중복 인식된다.
    """
    track_a, track_b = build_two_speaker_meeting(seed=151)
    analysis = analyze_tracks([track_a, track_b], sample_rate=SR)
    cleaned = suppress_crosstalk([track_a, track_b], analysis, sample_rate=SR)

    b_span = slice(int(SR * 3.2), int(SR * 4.5))
    before = float(np.sqrt(np.mean(track_a[b_span] ** 2)))
    after = float(np.sqrt(np.mean(cleaned[0][b_span] ** 2)))
    assert after < before * 0.2, "A 트랙에서 B의 누출이 충분히 줄지 않음"


def test_suppress_crosstalk_preserves_own_speech():
    track_a, track_b = build_two_speaker_meeting(seed=161)
    analysis = analyze_tracks([track_a, track_b], sample_rate=SR)
    cleaned = suppress_crosstalk([track_a, track_b], analysis, sample_rate=SR)

    a_span = slice(int(SR * 0.3), int(SR * 1.7))
    before = float(np.sqrt(np.mean(track_a[a_span] ** 2)))
    after = float(np.sqrt(np.mean(cleaned[0][a_span] ** 2)))
    assert after > before * 0.5, "본인 발화까지 깎였다"


def test_suppress_crosstalk_keeps_length():
    track_a, track_b = build_two_speaker_meeting(seed=171)
    analysis = analyze_tracks([track_a, track_b], sample_rate=SR)
    cleaned = suppress_crosstalk([track_a, track_b], analysis, sample_rate=SR)
    assert len(cleaned[0]) == len(track_a)
    assert len(cleaned[1]) == len(track_b)


# ══════════════════════════════════════════════════════════════
# 6. 통계
# ══════════════════════════════════════════════════════════════


def test_track_stats_reports_turns():
    track_a, track_b = build_two_speaker_meeting(seed=181)
    analysis = analyze_tracks([track_a, track_b], sample_rate=SR)
    stats = track_stats(analysis, 2)

    assert len(stats) == 2
    for stat in stats:
        assert stat.turn_count >= 1
        assert stat.mean_turn_ms > 0
        assert stat.exclusive_ms <= stat.speaking_ms


def test_track_stats_includes_silent_member():
    """말 안 한 팀원도 통계에 나와야 한다. 0으로."""
    track_a, _ = build_two_speaker_meeting(seed=191)
    silent = silence(6.0)
    analysis = analyze_tracks([track_a, silent], sample_rate=SR)
    stats = track_stats(analysis, 2)
    assert stats[1].speaking_ms == 0
    assert stats[1].turn_count == 0


def test_single_track_still_works():
    """혼자 녹음한 경우에도 동작해야 한다 (2등 트랙이 없음)."""
    voice = silence(2.0)
    voice[int(SR * 0.5) : int(SR * 1.5)] += speech_like(1.0, seed=201)
    analysis = analyze_tracks([voice], sample_rate=SR)
    assert analysis.speaking_ms(0) > 500
    assert not analysis.overlap.any()


# ══════════════════════════════════════════════════════════════
# 조립 공백이 잡음 바닥을 붕괴시키는 문제
#
# `assembly.render()` 는 녹음이 끊긴 구간을 **정확한 0** 으로 채운다.
# 그 0 은 `to_db` 의 하한 -100dB 에 붙는데, 잡음 바닥을 20백분위로 잡으면
# 공백이 20% 를 넘는 순간 바닥이 통째로 -100dB 가 된다.
#
# 주화자는 `energy_db - noise_floor` 의 argmax 로 뽑으므로, 바닥이 60dB
# 내려간 트랙이 **모든 프레임에서 이긴다.** 폰이 죽어 측정 불가로 빠져야 할
# 사람이 오히려 나머지 전원을 "말 안 한 사람" 으로 만든다 — 이 프로젝트가
# 막으려는 결과 그 자체다 (docs/05 §4.1.1).
#
# 실측(고치기 전): 3인 회의에서 한 명이 40% 끊기면 그 사람이 주화자 프레임의
# 100% 를 가져가고 나머지 두 명이 0 이 됐다.
# ══════════════════════════════════════════════════════════════


def track_with_gap(
    *, speech_amp: float, gap_fraction: float = 0.0, seed: int = 0, duration: float = 60.0
) -> np.ndarray:
    """뒤쪽 절반에 말소리가 있는 트랙. 앞부분 `gap_fraction` 은 조립 공백(정확한 0)."""
    rng = np.random.default_rng(seed)
    n = int(SR * duration)
    signal = rng.standard_normal(n).astype(np.float32) * 0.01  # 마이크 잡음
    signal[n // 2 :] += rng.standard_normal(n - n // 2).astype(np.float32) * speech_amp
    if gap_fraction:
        signal[: int(n * gap_fraction)] = 0.0
    return signal


def primary_share(analysis, track_index: int) -> float:
    counts = [int((analysis.primary == i).sum()) for i in range(analysis.energy_db.shape[0])]
    total = sum(counts)
    return counts[track_index] / total if total else 0.0


@pytest.mark.parametrize("gap_fraction", [0.25, 0.40, 0.60, 0.90])
def test_broken_track_does_not_steal_speaker_labels(gap_fraction: float):
    """⭐ 끊긴 트랙이 회의 전체의 화자 라벨을 가져가면 안 된다.

    공백이 백분위 안으로 들어오는 순간(20% 초과) 터지던 문제라
    경계 바로 위부터 훑는다.
    """
    healthy_a = track_with_gap(speech_amp=0.30, seed=1)
    healthy_b = track_with_gap(speech_amp=0.30, seed=2)
    broken = track_with_gap(speech_amp=0.05, gap_fraction=gap_fraction, seed=3)

    analysis = analyze_tracks([healthy_a, healthy_b, broken], sample_rate=SR)

    assert primary_share(analysis, 2) == 0.0, (
        f"공백 {gap_fraction:.0%} 인 트랙이 주화자를 가져갔습니다 "
        f"(바닥 {analysis.noise_floor_db})"
    )
    assert analysis.speaking_ms(0) > 0 and analysis.speaking_ms(1) > 0, (
        "정상 트랙 두 개가 침묵으로 처리됐습니다"
    )


def scattered_gaps(signal: np.ndarray, *, fraction: float, chunks: int = 12) -> np.ndarray:
    """공백을 트랙 전체에 흩어 놓는다.

    실제 공백은 폰이 잠기고 풀리는 대로 여기저기 생긴다. 앞쪽에 한 덩어리로
    몰아넣으면 조용한 구간만 통째로 지워져 잡음 표본이 남지 않는 인공적인
    신호가 된다.
    """
    out = signal.copy()
    n = len(out)
    hole = int(n * fraction / chunks)
    stride = n // chunks
    for k in range(chunks):
        start = k * stride
        out[start : start + hole] = 0.0
    return out


def test_gap_does_not_collapse_the_noise_floor():
    """공백이 있어도 잡음 바닥은 실제 잡음 수준에 머문다."""
    intact = track_with_gap(speech_amp=0.30, seed=11)
    gapped = scattered_gaps(intact, fraction=0.50)

    analysis = analyze_tracks([intact, gapped], sample_rate=SR)
    intact_floor, gapped_floor = analysis.noise_floor_db

    # 붕괴하면 -100dB 로 간다. 그게 이 테스트가 막는 것이다.
    assert gapped_floor > -80.0, f"바닥이 붕괴했습니다: {gapped_floor}"
    assert abs(gapped_floor - intact_floor) < 10.0


def test_floor_moving_up_is_the_safe_direction():
    """공백이 조용한 구간에만 몰리면 바닥 추정이 말소리 쪽으로 올라간다.

    막을 수 없는 일이고, 막을 필요도 없다 — 바닥이 **올라가면** 그 트랙은
    상대 에너지가 줄어 경쟁에서 진다. 위험한 건 내려가는 쪽뿐이다.
    """
    healthy = track_with_gap(speech_amp=0.30, seed=31)
    # 앞쪽 절반(=조용한 구간)이 통째로 공백인 최악의 배치
    lopsided = track_with_gap(speech_amp=0.30, gap_fraction=0.50, seed=31)

    analysis = analyze_tracks([healthy, lopsided], sample_rate=SR)

    assert analysis.noise_floor_db[1] > analysis.noise_floor_db[0], "올라가는 쪽이어야 한다"
    assert primary_share(analysis, 1) < 0.5, "바닥이 올라갔는데도 이겼습니다"


def test_fully_silent_track_never_wins():
    """트랙 전체가 공백이면 바닥을 추정할 근거가 없다. 이길 수 없어야 한다."""
    healthy = track_with_gap(speech_amp=0.30, seed=21)
    empty = np.zeros(int(SR * 60.0), dtype=np.float32)

    analysis = analyze_tracks([healthy, empty], sample_rate=SR)

    assert primary_share(analysis, 1) == 0.0
    assert analysis.speaking_ms(1) == 0


def test_noise_floor_ignores_synthetic_silence():
    """단위 수준 — 하한에 붙은 프레임은 측정값이 아니라 '데이터 없음' 이다."""
    from teamflow.audio.multitrack import DB_FLOOR, estimate_noise_floor_db

    measured = np.array([-45.0, -44.0, -43.0, -42.0, -20.0])
    padded = np.concatenate([np.full(20, DB_FLOOR), measured])

    assert estimate_noise_floor_db(padded) == pytest.approx(
        estimate_noise_floor_db(measured)
    )


def test_noise_floor_of_all_silence_is_the_floor():
    from teamflow.audio.multitrack import DB_FLOOR, estimate_noise_floor_db

    assert estimate_noise_floor_db(np.full(50, DB_FLOOR)) == DB_FLOOR
    assert estimate_noise_floor_db(np.zeros(0)) == DB_FLOOR


# ══════════════════════════════════════════════════════════════
# 7. 발언 비중 (AI-AUDIO-005) — ⚠️ 0.0 을 돌려주던 자리
# ══════════════════════════════════════════════════════════════
#
# ⚠️ 여기 `TrackStats.speaking_ratio` 라는 property 가 있었고 **언제나
#    `0.0`** 을 돌려줬습니다(결함 121). 부르는 곳은 0곳이었습니다.
#    비중에는 분모(팀 전체 발언 시간)가 필요한데 그 dataclass 는 자기
#    트랙만 아니까, 구조적으로 계산이 불가능한 자리에 스텁이 박혀 있던
#    것입니다.


def test_speaking_ratios_sum_to_one():
    track_a, track_b = build_two_speaker_meeting(seed=201)
    analysis = analyze_tracks([track_a, track_b], sample_rate=SR)
    ratios = speaking_ratios(track_stats(analysis, 2))

    assert all(r is not None for r in ratios)
    assert abs(sum(r for r in ratios if r is not None) - 1.0) < 1e-9
    assert all(0.0 <= r <= 1.0 for r in ratios if r is not None)


def test_a_member_who_said_nothing_gets_zero_not_none():
    """말을 **안 한** 것은 잰 것입니다 — 그건 진짜 0 입니다.

    아래 "아무도 말 안 함" 과 헷갈리면 안 됩니다. 여기서는 남이 말했으므로
    분모가 있고, 이 사람 몫이 0 이라는 것을 **쟀습니다.**
    """
    track_a, _ = build_two_speaker_meeting(seed=211)
    analysis = analyze_tracks([track_a, silence(6.0)], sample_rate=SR)
    ratios = speaking_ratios(track_stats(analysis, 2))

    assert ratios[0] is not None and ratios[0] > 0
    assert ratios[1] == 0.0


def test_nobody_spoke_is_none_not_zero():
    """⭐ **아무도 말하지 않으면 비중이 존재하지 않습니다.**

    분모가 0인데 0.0 을 돌려주면 "다들 0% 말했다" 는 **잰 값**처럼 보입니다.
    실제로는 잴 것이 없었던 것이고, 그 둘을 같게 만드는 것이 이 저장소가
    제일 하면 안 된다고 정한 것입니다 (측정 불가 ≠ 0점).
    """
    analysis = analyze_tracks([silence(4.0), silence(4.0)], sample_rate=SR)
    ratios = speaking_ratios(track_stats(analysis, 2))

    assert ratios == [None, None]
    assert 0.0 not in ratios


def test_ratios_come_back_in_track_order_never_sorted():
    """⚠️ **정렬해서 주지 않습니다.**

    요구사항 정의서 AI-AUDIO-005 의 예시가 내림차순 목록이라 그대로 따라
    하면 리더보드가 됩니다. 그런데 같은 문서의 AI-REVIEW-007·NFR-005 는
    반대로 말합니다 — 요구는 **값을 만들라**는 것이지 **줄을 세우라**는
    것이 아닙니다.

    정렬해서 주면 부르는 쪽은 그게 뜻있는 순서라고 믿습니다.
    """
    _, loud = build_two_speaker_meeting(seed=221)
    # 트랙 0 을 일부러 조용하게 만들어 "값 순서 ≠ 트랙 순서" 를 만듭니다.
    analysis = analyze_tracks([silence(6.0), loud], sample_rate=SR)
    stats = track_stats(analysis, 2)
    ratios = speaking_ratios(stats)

    assert [s.track_index for s in stats] == [0, 1]
    assert ratios[0] is not None and ratios[1] is not None
    assert ratios[0] < ratios[1], "표본이 잘못됐습니다 — 값 순서가 안 뒤집힙니다"
    # 값으로 정렬했다면 큰 것이 먼저 왔을 것입니다.
    assert ratios != sorted(ratios, reverse=True)
