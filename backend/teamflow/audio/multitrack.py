"""멀티트랙 오디오 정렬과 누출 제거.

docs/04-회의-처리-파이프라인.md §2

이 프로젝트에서 가장 가치 있는 설계 결정을 구현한 모듈이다.

    [단일 마이크]  혼합 오디오 → 화자 분리 AI → SPEAKER_00 → 사람이 이름 매핑
                   DER 17~20%, 동시 발언에서 급락

    [멀티트랙]     팀원 각자 폰으로 개별 트랙 녹음 → 트랙 = 사람
                   화자 라벨 정확도 100%

화자 분리 AI가 필요 없어지는 게 아니라 **역할이 바뀐다.**
각 트랙에는 본인 목소리와 함께 옆사람 목소리가 누출(cross-talk)되어 들어온다.
"이 목소리가 누구인가"를 맞히는 대신, "이 프레임에서 실제로 말한 사람은
어느 트랙의 주인인가"를 판정하면 된다. 그건 에너지 비교로 풀린다.

이 모듈은 순수 신호처리다. 모델도 GPU도 필요 없고, 합성 신호로 전부 검증된다.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

DEFAULT_SAMPLE_RATE = 16_000

# GCC-PHAT 신뢰도를 0~1로 사상하는 z-스코어 구간.
# 실측: 침묵 트랙 두 개 ≈ 5.7, 지연된 같은 신호 ≈ 115.
_Z_FLOOR = 8.0
_Z_CEILING = 48.0


# ══════════════════════════════════════════════════════════════
# 1. 시간 정렬
# ══════════════════════════════════════════════════════════════
#
# 각 기기가 녹음을 시작한 시각이 다르다. 서버 타임스탬프로 대략 맞춰지지만
# 수백 ms 오차가 남는다. 트랙에 섞여 들어온 서로의 목소리를 이용하면
# 실제 오프셋을 신호에서 직접 추정할 수 있다.


def gcc_phat(
    sig: np.ndarray,
    ref: np.ndarray,
    *,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    max_tau: float | None = None,
) -> tuple[float, float]:
    """GCC-PHAT로 두 신호의 시간차를 추정한다.

    일반 상호상관 대신 PHAT 가중을 쓰는 이유는 **잔향에 강하기 때문**이다.
    회의실은 반향이 심해서 일반 상관은 벽 반사에서 가짜 피크가 생긴다.
    PHAT은 크기를 정규화하고 위상만 남겨 첫 도달 시각을 뾰족하게 만든다.

    Args:
        sig: 지연을 측정할 신호
        ref: 기준 신호
        max_tau: 허용 최대 시간차(초). 좌석 간 거리를 고려해 제한하면
            엉뚱한 피크를 배제할 수 있다.

    Returns:
        ``(tau, confidence)``.
        ``tau > 0`` 이면 ``sig`` 가 ``ref`` 보다 늦게 도달했다는 뜻이다.
        confidence 는 최대 피크와 배경의 비(0~1). 낮으면 신뢰할 수 없다.
    """
    n = len(sig) + len(ref)
    fft_len = 1 << (n - 1).bit_length()  # 2의 거듭제곱으로 패딩

    SIG = np.fft.rfft(sig, n=fft_len)
    REF = np.fft.rfft(ref, n=fft_len)

    cross = SIG * np.conj(REF)
    magnitude = np.abs(cross)
    # PHAT 가중: 크기를 버리고 위상만 남긴다
    cross /= magnitude + 1e-12

    cc = np.fft.irfft(cross, n=fft_len)

    max_shift = fft_len // 2
    if max_tau is not None:
        max_shift = min(int(sample_rate * max_tau), max_shift)

    # 음수 지연(앞부분)과 양수 지연(뒷부분)을 이어 붙여 0을 가운데로
    cc = np.concatenate((cc[-max_shift:], cc[: max_shift + 1]))
    magnitude_cc = np.abs(cc)
    peak_index = int(np.argmax(magnitude_cc))
    shift = peak_index - max_shift

    # 신뢰도는 피크의 **z-스코어**로 잰다.
    #
    # 처음엔 `1 - mean/peak` 를 썼는데 무의미했다. PHAT은 스펙트럼 크기를
    # 정규화하므로 백색잡음끼리도 뾰족한 피크가 나오고, 그 지표는 0.81 을
    # 돌려줬다 (실측). z-스코어는 침묵 5.7 vs 상관 신호 114 로 확실히 갈린다.
    peak = float(magnitude_cc[peak_index])
    mean = float(magnitude_cc.mean())
    std = float(magnitude_cc.std())
    z_score = (peak - mean) / (std + 1e-12)

    confidence = float(np.clip((z_score - _Z_FLOOR) / (_Z_CEILING - _Z_FLOOR), 0.0, 1.0))
    return shift / sample_rate, confidence


@dataclass(frozen=True, slots=True)
class TrackOffset:
    track_index: int
    offset_sec: float
    confidence: float
    method: str  # gcc_phat | server_timestamp

    @property
    def offset_ms(self) -> int:
        # float() 로 감싸는 이유: numpy 스칼라가 들어와도 round 가 int 를 내도록.
        return round(float(self.offset_sec) * 1000)


# 이 값 미만이면 신호에서 추정한 오프셋을 믿지 않는다.
# 두 사람이 겹치는 구간에 아무 말도 안 했으면 상관이 무의미하다.
MIN_ALIGNMENT_CONFIDENCE = 0.30

# 사람이 한 방에 있을 때 물리적으로 가능한 최대 시간차(초).
# 음속 340m/s 기준 10m 떨어져도 30ms. 여기에 기기 버퍼링 여유를 더한다.
MAX_PLAUSIBLE_TAU = 0.5


def estimate_offsets(
    tracks: list[np.ndarray],
    *,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    reference: int = 0,
    server_offsets_sec: list[float] | None = None,
    max_tau: float = MAX_PLAUSIBLE_TAU,
) -> list[TrackOffset]:
    """모든 트랙을 기준 트랙에 맞추는 오프셋을 추정한다.

    신호 기반 추정의 신뢰도가 낮으면 **서버 타임스탬프로 폴백한다.**
    억지로 신호를 믿었다가 트랙을 몇백 ms 어긋나게 붙이면
    발언 순서가 뒤집혀서 "질문 후 응답" 분석이 통째로 망가진다.
    """
    offsets: list[TrackOffset] = []
    ref_signal = tracks[reference]

    for index, track in enumerate(tracks):
        if index == reference:
            offsets.append(TrackOffset(index, 0.0, 1.0, "gcc_phat"))
            continue

        tau, confidence = gcc_phat(
            track, ref_signal, sample_rate=sample_rate, max_tau=max_tau
        )

        if confidence < MIN_ALIGNMENT_CONFIDENCE and server_offsets_sec:
            fallback = server_offsets_sec[index] - server_offsets_sec[reference]
            offsets.append(TrackOffset(index, fallback, confidence, "server_timestamp"))
        else:
            # ⚠️ **부호를 뒤집는다.** 이게 없으면 정렬이 반대로 간다.
            #
            # `offset_sec` 의 규약은 `apply_offsets` 와 서버 타임스탬프 폴백이
            # 정하고 있다 — "이 트랙을 공통 시간축에서 얼마나 **뒤로** 밀어야
            # 하는가". 늦게 시작한 기기는 앞부분을 놓쳤으므로 양수다
            # (`started_at - earliest`).
            #
            # 그런데 `gcc_phat(track, ref)` 의 tau 는 "ref 대비 track 이 얼마나
            # 늦게 들리는가" 다. 늦게 시작한 기기는 앞을 놓쳐서 같은 소리가
            # **먼저** 나타나므로 tau 가 음수로 나온다. 규약과 정확히 반대다.
            #
            # 실측(백색잡음 5초, 0.1초 늦게 시작한 트랙, 잔차는 신호 전력 대비):
            #     정렬 전            1.9881
            #     뒤집지 않고 적용    1.9651   ← 전혀 정렬되지 않는다
            #     뒤집어서 적용       0.0380   ← 정렬된다
            #
            # 즉 이 한 글자가 없으면 GCC-PHAT 이 지연을 정확히 구해 놓고도
            # 트랙을 **더 어긋나게** 만든다. 그 위에서 도는 누출 제거와 주화자
            # 판정은 전부 무의미해진다 — 이 프로젝트의 핵심 설계가 통째로.
            #
            # 기존 테스트가 못 잡은 이유: `gcc_phat` 이 지연을 맞히는지(맞다),
            # `apply_offsets` 가 길이를 맞추는지(맞다)만 봤고 **왕복**을 본
            # 테스트가 없었다.
            offsets.append(TrackOffset(index, -tau, confidence, "gcc_phat"))

    return offsets


def apply_offsets(
    tracks: list[np.ndarray], offsets: list[TrackOffset], *, sample_rate: int = DEFAULT_SAMPLE_RATE
) -> list[np.ndarray]:
    """오프셋만큼 트랙을 밀어 길이를 맞춘다.

    앞은 0으로 패딩하고 뒤는 가장 긴 트랙에 맞춰 늘린다.
    잘라내지 않는 이유는 회의 앞뒤에 실제 발화가 있을 수 있어서다.
    """
    shifts = [round(float(o.offset_sec) * sample_rate) for o in offsets]
    # 가장 이른 트랙이 0이 되도록 정규화
    base = min(shifts)
    shifts = [s - base for s in shifts]

    total = max(len(t) + s for t, s in zip(tracks, shifts, strict=True))

    aligned: list[np.ndarray] = []
    for track, shift in zip(tracks, shifts, strict=True):
        buffer = np.zeros(total, dtype=np.float32)
        buffer[shift : shift + len(track)] = track
        aligned.append(buffer)
    return aligned


# ══════════════════════════════════════════════════════════════
# 2. 프레임 에너지
# ══════════════════════════════════════════════════════════════


def frame_rms(
    signal: np.ndarray, *, frame_len: int, hop: int
) -> np.ndarray:
    """프레임별 RMS. 벡터화해서 한 번에 계산한다."""
    if len(signal) < frame_len:
        signal = np.pad(signal, (0, frame_len - len(signal)))
    n_frames = 1 + (len(signal) - frame_len) // hop
    if n_frames <= 0:
        return np.zeros(0, dtype=np.float32)
    indices = np.arange(frame_len)[None, :] + hop * np.arange(n_frames)[:, None]
    frames = signal[indices]
    return np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1)).astype(np.float32)


#: dB 하한. 이 값에 붙어 있는 프레임은 **측정된 소리가 아니라 데이터가 없는 자리**다.
#: `assembly.render()` 가 녹음 공백을 정확한 0 으로 채우기 때문에 생긴다.
DB_FLOOR = -100.0


def to_db(rms: np.ndarray, *, floor: float = DB_FLOOR) -> np.ndarray:
    return np.maximum(20.0 * np.log10(rms + 1e-12), floor)


def estimate_noise_floor_db(
    energy_db: np.ndarray, *, percentile: float = 20.0, floor_db: float = DB_FLOOR
) -> float:
    """하위 백분위를 잡음 바닥으로 본다.

    회의는 대부분 침묵이거나 한 사람만 말하므로, 각 트랙에서 하위 구간은
    대체로 잡음이다. 고정 임계값을 쓰면 기기마다 마이크 감도가 달라 실패한다.

    ⚠️ **조립 공백은 백분위에서 뺀다.** 이게 없으면 정확히 뒤집힌 결과가 나온다.

    `assembly.render()` 는 녹음이 끊긴 구간을 **정확한 0** 으로 채운다. 그 0 은
    `to_db` 에서 하한 -100dB 에 붙는다. 트랙의 20% 넘게 공백이면 20백분위가
    통째로 -100dB 가 되고, 잡음 바닥이 실제 -40dB 에서 -100dB 로 붕괴한다.

    주화자는 `energy_db - noise_floor` 의 argmax 로 뽑으므로, 바닥이 60dB
    내려간 트랙은 **모든 프레임에서 이긴다.** 실측: 3인 회의에서 한 명의 폰이
    40% 끊기면 그 사람이 주화자 프레임의 **100%** 를 가져가고 나머지 두 명은
    0 이 된다 (`test_multitrack.py` 로 고정해 뒀다).

    측정 불가로 빠져야 할 사람이 오히려 나머지 전원을 "말 안 한 사람" 으로
    만드는 것이라, 이 프로젝트가 막으려는 결과 그 자체다 (docs/05 §4.1.1).

    바닥에 붙지 않은 프레임만 쓰면 해결된다 — 마이크가 살아 있으면 잡음이
    있으므로 정확한 0 이 나오지 않는다. 즉 하한에 붙은 프레임은 침묵이 아니라
    **데이터 없음**이고, 없는 데이터로 바닥을 추정하면 안 된다.
    """
    if energy_db.size == 0:
        return floor_db

    measured = energy_db[energy_db > floor_db]
    if measured.size == 0:
        # 트랙 전체가 공백이다. 바닥을 추정할 근거가 없으므로 하한을 그대로 쓴다 —
        # 이러면 relative 가 전부 0 이라 이 트랙은 어느 프레임에서도 이기지 못한다.
        return floor_db

    return float(np.percentile(measured, percentile))


# ══════════════════════════════════════════════════════════════
# 3. 주화자 판정 · 누출 제거 · 동시 발언
# ══════════════════════════════════════════════════════════════

FRAME_MS = 20
HOP_MS = 10

# 자기 트랙의 잡음 바닥보다 이만큼 위여야 발화로 본다.
VAD_MARGIN_DB = 8.0

# 1등과 2등 트랙의 에너지 차가 이보다 크면 1등이 확실한 주화자다.
# 작으면 동시 발언이거나 판정 불가.
#
# 본인 마이크는 입에서 30cm, 옆사람은 1.5m 정도다. 거리 제곱 감쇠만으로도
# 약 14dB 차이가 난다. 6dB는 보수적인 값이다.
PRIMARY_MARGIN_DB = 6.0


class SpeakerFrame:
    UNKNOWN = -1
    SILENCE = -2
    OVERLAP = -3


@dataclass(frozen=True, slots=True)
class SpeechSegment:
    """한 사람이 연속으로 말한 구간."""

    track_index: int
    start_ms: int
    end_ms: int
    is_overlap: bool = False

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


@dataclass
class TrackAnalysis:
    """프레임 단위 분석 결과."""

    energy_db: np.ndarray  # (n_tracks, n_frames)
    noise_floor_db: np.ndarray  # (n_tracks,)
    primary: np.ndarray  # (n_frames,) 각 프레임의 주화자 트랙 인덱스
    overlap: np.ndarray  # (n_frames,) bool
    frame_ms: int = FRAME_MS
    hop_ms: int = HOP_MS
    segments: list[SpeechSegment] = field(default_factory=list)

    @property
    def n_frames(self) -> int:
        return self.primary.shape[0]

    def speaking_ms(self, track_index: int, *, include_overlap: bool = True) -> int:
        """해당 트랙 주인이 말한 총 시간(ms).

        기여도 지표의 입력이 된다. 멀티트랙이라 이 값이 정확하다 —
        단일 마이크 + 화자분리로는 DER 오차가 그대로 섞여 들어간다.
        """
        mask = self.primary == track_index
        if not include_overlap:
            mask &= ~self.overlap
        return int(mask.sum() * self.hop_ms)


def analyze_tracks(
    tracks: list[np.ndarray],
    *,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    frame_ms: int = FRAME_MS,
    hop_ms: int = HOP_MS,
    vad_margin_db: float = VAD_MARGIN_DB,
    primary_margin_db: float = PRIMARY_MARGIN_DB,
    min_segment_ms: int = 200,
) -> TrackAnalysis:
    """정렬된 트랙들에서 프레임별 주화자를 판정한다.

    핵심 아이디어: **같은 시각에 여러 트랙이 활성이면, 에너지가 가장 큰
    트랙의 주인이 실제 발화자다.** 본인 마이크가 가장 가깝기 때문이다.

    AI가 "이 목소리가 누구인가"를 맞힐 필요가 없다.
    """
    frame_len = int(sample_rate * frame_ms / 1000)
    hop = int(sample_rate * hop_ms / 1000)

    energies = [frame_rms(t, frame_len=frame_len, hop=hop) for t in tracks]
    n_frames = min(len(e) for e in energies)
    energy_db = np.stack([to_db(e[:n_frames]) for e in energies])

    noise_floor = np.array([estimate_noise_floor_db(row) for row in energy_db])
    # 자기 잡음 바닥 대비 얼마나 큰가 — 기기별 감도 차이를 없앤다
    relative = energy_db - noise_floor[:, None]

    active = relative > vad_margin_db

    primary = np.full(n_frames, SpeakerFrame.SILENCE, dtype=np.int32)
    overlap = np.zeros(n_frames, dtype=bool)

    # 활성 트랙이 있는 프레임만 판정
    any_active = active.any(axis=0)
    if any_active.any():
        masked = np.where(active, relative, -np.inf)
        order = np.argsort(-masked, axis=0)
        top = order[0]
        top_value = masked[top, np.arange(n_frames)]

        if len(tracks) >= 2:
            second = order[1]
            second_value = masked[second, np.arange(n_frames)]
        else:
            second_value = np.full(n_frames, -np.inf)

        top_finite = np.isfinite(top_value)
        second_finite = np.isfinite(second_value)
        # -inf 끼리 빼면 nan 이 나온다. 유한한 쌍에서만 계산한다.
        margin = np.where(
            top_finite & second_finite,
            np.where(second_finite, top_value - np.where(second_finite, second_value, 0.0), 0.0),
            np.inf,
        )
        clear = top_finite & (margin >= primary_margin_db)
        contested = top_finite & second_finite & (margin < primary_margin_db)

        primary = np.where(any_active & clear, top, primary)
        # 동시 발언: 두 트랙 이상이 비슷한 세기로 활성.
        # 트랙이 분리돼 있으니 각자 잡히긴 하지만, 이 구간은 표시해 둔다.
        # 제안서 6.5의 "동시 발언·겹침 구간" 분석 입력이 된다.
        primary = np.where(any_active & contested, top, primary)
        overlap = any_active & contested

    analysis = TrackAnalysis(
        energy_db=energy_db,
        noise_floor_db=noise_floor,
        primary=primary,
        overlap=overlap,
        frame_ms=frame_ms,
        hop_ms=hop_ms,
    )
    analysis.segments = to_segments(analysis, min_segment_ms=min_segment_ms)
    return analysis


def to_segments(analysis: TrackAnalysis, *, min_segment_ms: int = 200) -> list[SpeechSegment]:
    """프레임 라벨을 연속 구간으로 합친다.

    짧은 구간은 버린다. 기침이나 문 닫는 소리가 발화로 잡히는 것을 막는다.
    """
    segments: list[SpeechSegment] = []
    primary = analysis.primary
    if primary.size == 0:
        return segments

    start = 0
    current = int(primary[0])
    current_overlap = bool(analysis.overlap[0])

    def close(end_index: int) -> None:
        if current < 0:
            return
        start_ms = start * analysis.hop_ms
        end_ms = end_index * analysis.hop_ms + analysis.frame_ms
        if end_ms - start_ms >= min_segment_ms:
            segments.append(
                SpeechSegment(
                    track_index=current,
                    start_ms=start_ms,
                    end_ms=end_ms,
                    is_overlap=current_overlap,
                )
            )

    for i in range(1, len(primary)):
        label = int(primary[i])
        is_overlap = bool(analysis.overlap[i])
        if label != current or is_overlap != current_overlap:
            close(i - 1)
            start = i
            current = label
            current_overlap = is_overlap

    close(len(primary) - 1)
    return segments


def suppress_crosstalk(
    tracks: list[np.ndarray],
    analysis: TrackAnalysis,
    *,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    attenuation_db: float = -40.0,
) -> list[np.ndarray]:
    """각 트랙에서 그 사람이 말하지 않은 구간을 감쇠시킨다.

    ASR에 넣기 전에 적용한다. 이렇게 하지 않으면 옆사람 목소리가 그대로
    전사되어 **같은 발언이 여러 트랙에서 중복 인식**된다.

    완전히 0으로 만들지 않고 감쇠만 하는 이유: 경계에서 딱 끊으면
    클릭 노이즈가 생기고 ASR이 오히려 더 헷갈려한다.
    """
    gain = 10 ** (attenuation_db / 20.0)
    hop = int(sample_rate * analysis.hop_ms / 1000)
    frame_len = int(sample_rate * analysis.frame_ms / 1000)

    out: list[np.ndarray] = []
    for index, track in enumerate(tracks):
        mask = np.full(len(track), gain, dtype=np.float32)
        for i in range(analysis.n_frames):
            if analysis.primary[i] == index:
                begin = i * hop
                mask[begin : begin + frame_len] = 1.0
        out.append((track * mask[: len(track)]).astype(np.float32))
    return out


# ══════════════════════════════════════════════════════════════
# 4. 요약 지표
# ══════════════════════════════════════════════════════════════


@dataclass(frozen=True, slots=True)
class TrackStats:
    """제안서 6.2의 "팀원별 발언 시간·횟수·평균 길이".

    멀티트랙이라 이 수치가 정확하다. 단일 마이크 + 화자분리로는
    DER 17~20% 가 그대로 이 값의 오차가 되고, 그게 기여도로 전파된다.
    """

    track_index: int
    speaking_ms: int
    exclusive_ms: int  # 동시 발언 제외
    turn_count: int
    mean_turn_ms: float
    overlap_ms: int

    @property
    def speaking_ratio(self) -> float:
        return 0.0


def track_stats(analysis: TrackAnalysis, n_tracks: int) -> list[TrackStats]:
    stats: list[TrackStats] = []
    for index in range(n_tracks):
        turns = [s for s in analysis.segments if s.track_index == index]
        speaking = analysis.speaking_ms(index)
        exclusive = analysis.speaking_ms(index, include_overlap=False)
        durations = [s.duration_ms for s in turns]
        stats.append(
            TrackStats(
                track_index=index,
                speaking_ms=speaking,
                exclusive_ms=exclusive,
                turn_count=len(turns),
                mean_turn_ms=float(np.mean(durations)) if durations else 0.0,
                overlap_ms=speaking - exclusive,
            )
        )
    return stats
