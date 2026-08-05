"""트랙 재조립 테스트.

핵심은 **길이가 항상 보존된다**는 것이다. 공백이 있든 없든, 유실이 있든
없든, 렌더 결과는 항상 녹음 구간 전체 길이다. 그래야 모든 트랙이 같은
시간축에 놓이고 GCC-PHAT 미세 정렬이 의미를 가진다.
"""

from __future__ import annotations

import numpy as np
import pytest

from teamflow.audio.assembly import (
    ChunkRecord,
    naive_concatenation_shift_ms,
    plan_track,
    render,
)

START = 1_700_000_000_000
TIMESLICE = 5_000
SR = 16_000


def chunks_every(*offsets_ms: int) -> list[ChunkRecord]:
    """녹음 시작 기준 오프셋 목록으로 청크를 만든다. seq 는 0부터."""
    return [ChunkRecord(seq=i, client_at_ms=START + off) for i, off in enumerate(offsets_ms)]


def perfect(count: int) -> list[ChunkRecord]:
    return chunks_every(*[TIMESLICE * (i + 1) for i in range(count)])


def plan(chunks, *, duration_ms: int):
    return plan_track(
        chunks,
        timeslice_ms=TIMESLICE,
        started_at_ms=START,
        ended_at_ms=START + duration_ms,
    )


# ══════════════════════════════════════════════════════════════
# 정상 녹음
# ══════════════════════════════════════════════════════════════


def test_continuous_recording_has_no_gaps():
    result = plan(perfect(12), duration_ms=60_000)

    assert result.gaps == []
    assert result.coverage == 1.0
    assert result.total_gap_ms == 0
    assert len(result.placements) == 12


def test_placements_are_contiguous():
    result = plan(perfect(4), duration_ms=20_000)

    assert [(p.start_ms, p.end_ms) for p in result.placements] == [
        (0, 5_000),
        (5_000, 10_000),
        (10_000, 15_000),
        (15_000, 20_000),
    ]


def test_jitter_is_not_reported_as_a_gap():
    """브라우저의 dataavailable 은 timeslice 를 정확히 지키지 않는다."""
    result = plan(chunks_every(5_040, 10_120, 15_060, 20_180), duration_ms=20_180)
    assert result.gaps == []


# ══════════════════════════════════════════════════════════════
# 공백 — 원인 구분
# ══════════════════════════════════════════════════════════════


def test_recorder_stall_is_detected():
    """seq 는 이어지는데 시간이 벌어졌다 = 폰이 녹음을 멈췄다."""
    # 0,1 은 정상 → 30초 잠금 → 2,3
    result = plan(chunks_every(5_000, 10_000, 45_000, 50_000), duration_ms=50_000)

    assert len(result.gaps) == 1
    gap = result.gaps[0]
    assert gap.reason == "recorder_stalled"
    assert gap.duration_ms == 30_000
    assert (gap.start_ms, gap.end_ms) == (10_000, 40_000)


def test_lost_chunk_is_distinguished_from_a_stall():
    """⭐ seq 가 건너뛰었으면 업로드 유실이다.

    seq 가 0부터 빽빽하게 올라간다는 성질 덕에 서버 혼자 구별할 수 있다.
    원인이 다르면 사용자에게 할 말도 다르다 — 한쪽은 "화면을 켜두세요",
    다른 쪽은 "네트워크가 불안정했습니다"다.
    """
    # seq 2 (10~15초) 가 서버에 도착하지 않았다
    received = [
        ChunkRecord(seq=0, client_at_ms=START + 5_000),
        ChunkRecord(seq=1, client_at_ms=START + 10_000),
        ChunkRecord(seq=3, client_at_ms=START + 20_000),
        ChunkRecord(seq=4, client_at_ms=START + 25_000),
    ]
    result = plan(received, duration_ms=25_000)

    assert len(result.gaps) == 1
    assert result.gaps[0].reason == "chunk_lost"
    assert result.gaps[0].duration_ms == 5_000
    assert result.lost_seqs == [2]


def test_trailing_gap_when_recording_dies_before_stop():
    result = plan(perfect(2), duration_ms=40_000)

    assert len(result.gaps) == 1
    assert result.gaps[0].reason == "recorder_stalled"
    assert (result.gaps[0].start_ms, result.gaps[0].end_ms) == (10_000, 40_000)


def test_no_chunks_at_all_is_one_big_gap():
    result = plan([], duration_ms=60_000)

    assert result.coverage == 0.0
    assert result.total_gap_ms == 60_000
    assert result.placements == []
    assert result.lost_seqs == []


def test_several_gaps_are_summed():
    result = plan(
        chunks_every(5_000, 10_000, 30_000, 35_000, 55_000, 60_000), duration_ms=60_000
    )

    assert len(result.gaps) == 2
    assert result.total_gap_ms == 30_000
    assert result.longest_gap_ms == 15_000
    assert result.coverage == 0.5


# ══════════════════════════════════════════════════════════════
# 렌더링 — 길이 보존이 핵심
# ══════════════════════════════════════════════════════════════


def tone(duration_ms: int, value: float) -> np.ndarray:
    return np.full(int(duration_ms * SR / 1000), value, dtype=np.float32)


def test_render_preserves_total_length_with_no_gaps():
    result = plan(perfect(4), duration_ms=20_000)
    decoded = {seq: tone(5_000, 0.5) for seq in range(4)}

    audio = render(result, decoded, sample_rate=SR)
    assert len(audio) == 20 * SR


def test_render_pads_gaps_with_silence():
    """⭐ 이 모듈의 존재 이유.

    30초를 잃었어도 그 뒤 오디오는 **원래 있던 자리에** 놓여야 한다.
    """
    result = plan(chunks_every(5_000, 10_000, 45_000, 50_000), duration_ms=50_000)
    decoded = {seq: tone(5_000, 0.5) for seq in range(4)}

    audio = render(result, decoded, sample_rate=SR)

    assert len(audio) == 50 * SR
    # 0~10초: 오디오
    assert np.all(audio[: 10 * SR] == 0.5)
    # 10~40초: 무음
    assert np.all(audio[10 * SR : 40 * SR] == 0.0)
    # 40~50초: 다시 오디오 — 여기가 핵심이다
    assert np.all(audio[40 * SR : 50 * SR] == 0.5)


def test_render_beats_naive_concatenation():
    """순진한 이어붙이기와 직접 비교한다."""
    result = plan(chunks_every(5_000, 10_000, 45_000, 50_000), duration_ms=50_000)
    decoded = {seq: tone(5_000, 0.5) for seq in range(4)}

    placed = render(result, decoded, sample_rate=SR)
    naive = np.concatenate([decoded[seq] for seq in sorted(decoded)])

    assert len(placed) == 50 * SR
    assert len(naive) == 20 * SR
    # 마지막 청크의 오디오가 놓인 위치가 30초 어긋난다
    shift = naive_concatenation_shift_ms(result)
    assert shift == 30_000
    # GCC-PHAT 탐색창은 ±500ms. 그 60배라 복구 자체가 불가능하다.
    assert shift / 500 == 60


def test_render_leaves_lost_chunks_silent():
    received = [
        ChunkRecord(seq=0, client_at_ms=START + 5_000),
        ChunkRecord(seq=2, client_at_ms=START + 15_000),
    ]
    result = plan(received, duration_ms=15_000)
    decoded = {0: tone(5_000, 0.5), 2: tone(5_000, 0.5)}

    audio = render(result, decoded, sample_rate=SR)

    assert np.all(audio[: 5 * SR] == 0.5)
    assert np.all(audio[5 * SR : 10 * SR] == 0.0), "유실 구간은 무음"
    assert np.all(audio[10 * SR : 15 * SR] == 0.5)


def test_render_truncates_overlong_decoded_audio():
    """디코딩 길이가 계획보다 길 수 있다 (컨테이너 오버헤드).

    배치 시각을 지키는 쪽이 샘플 몇 개보다 중요하다.
    """
    result = plan(perfect(2), duration_ms=10_000)
    decoded = {0: tone(7_000, 0.5), 1: tone(5_000, 0.3)}

    audio = render(result, decoded, sample_rate=SR)

    assert len(audio) == 10 * SR
    assert np.all(audio[: 5 * SR] == 0.5), "첫 청크는 자기 자리만 차지한다"
    assert np.all(audio[5 * SR :] == 0.3), "두 번째 청크가 밀려나지 않는다"


def test_render_pads_short_decoded_audio():
    result = plan(perfect(2), duration_ms=10_000)
    decoded = {0: tone(3_000, 0.5), 1: tone(5_000, 0.3)}

    audio = render(result, decoded, sample_rate=SR)

    assert np.all(audio[: 3 * SR] == 0.5)
    assert np.all(audio[3 * SR : 5 * SR] == 0.0), "모자란 만큼은 무음"
    assert np.all(audio[5 * SR :] == 0.3), "다음 청크 위치는 그대로"


def test_render_ignores_decoded_audio_for_unknown_seq():
    result = plan(perfect(2), duration_ms=10_000)
    decoded = {0: tone(5_000, 0.5), 1: tone(5_000, 0.3), 99: tone(5_000, 0.9)}

    audio = render(result, decoded, sample_rate=SR)
    assert not np.any(audio == 0.9)


def test_render_with_no_audio_is_all_silence():
    result = plan(perfect(2), duration_ms=10_000)
    audio = render(result, {}, sample_rate=SR)

    assert len(audio) == 10 * SR
    assert np.all(audio == 0.0)


def test_all_tracks_end_up_the_same_length():
    """⭐ 서로 다르게 망가진 트랙들이 같은 시간축에 놓인다.

    이게 보장돼야 GCC-PHAT 미세 정렬이 의미를 가진다.
    """
    duration = 60_000
    healthy = plan(perfect(12), duration_ms=duration)
    stalled = plan(chunks_every(5_000, 10_000, 45_000, 50_000), duration_ms=duration)
    empty = plan([], duration_ms=duration)

    lengths = {
        len(render(healthy, {s: tone(5_000, 0.5) for s in range(12)}, sample_rate=SR)),
        len(render(stalled, {s: tone(5_000, 0.5) for s in range(4)}, sample_rate=SR)),
        len(render(empty, {}, sample_rate=SR)),
    }
    assert lengths == {60 * SR}


# ══════════════════════════════════════════════════════════════
# 입력 검증
# ══════════════════════════════════════════════════════════════


def test_timeslice_must_be_positive():
    with pytest.raises(ValueError, match="양수"):
        plan_track([], timeslice_ms=0, started_at_ms=START, ended_at_ms=START + 1)


def test_end_before_start_is_rejected():
    with pytest.raises(ValueError, match="빠릅니다"):
        plan_track([], timeslice_ms=TIMESLICE, started_at_ms=START, ended_at_ms=START - 1)


def test_chunk_arriving_before_recording_started_is_clipped():
    """시계가 재동기화되면 시각이 뒤로 갈 수 있다."""
    result = plan([ChunkRecord(seq=0, client_at_ms=START + 2_000)], duration_ms=10_000)

    assert result.placements[0].start_ms == 0, "음수 위치로 놓지 않는다"
    assert result.placements[0].end_ms == 2_000


def test_chunk_arriving_long_after_stop_is_ignored():
    """어느 구간의 오디오인지 알 수 없는 건 끼워넣지 않는다."""
    late = [
        ChunkRecord(seq=0, client_at_ms=START + 5_000),
        ChunkRecord(seq=1, client_at_ms=START + 90_000),  # 정지 한참 뒤
    ]
    result = plan(late, duration_ms=10_000)

    assert [p.seq for p in result.placements] == [0]


def test_final_flush_slightly_after_stop_is_kept():
    """정지 버튼과 마지막 dataavailable 사이에는 항상 약간의 지연이 있다.

    이것까지 버리면 매 회의의 끝 몇 초가 사라진다.
    """
    flush = [
        ChunkRecord(seq=0, client_at_ms=START + 5_000),
        ChunkRecord(seq=1, client_at_ms=START + 10_120),  # 정지 직후 flush
    ]
    result = plan(flush, duration_ms=10_000)

    assert [p.seq for p in result.placements] == [0, 1]
    assert result.gaps == []
    assert result.coverage == 1.0


def test_jitter_does_not_erode_coverage_over_a_long_recording():
    """⭐ 고정 폭으로 자르면 지터가 누적돼 커버리지가 갉아먹힌다.

    레코더는 "지난 emit 이후 전부"를 담으므로 앞 청크에 이어 붙여야 한다.
    (이 테스트가 실제 모델링 오류를 잡았다.)
    """
    # 매 슬라이스마다 120ms 씩 늦게 도착하는 1시간짜리 녹음
    offsets = [TIMESLICE * (i + 1) + 120 * (i % 3) for i in range(720)]
    result = plan(chunks_every(*offsets), duration_ms=offsets[-1])

    assert result.gaps == [], "정상 지터는 공백이 아니다"
    assert result.coverage == 1.0


def test_chunks_out_of_order_are_sorted():
    shuffled = [
        ChunkRecord(seq=2, client_at_ms=START + 15_000),
        ChunkRecord(seq=0, client_at_ms=START + 5_000),
        ChunkRecord(seq=1, client_at_ms=START + 10_000),
    ]
    result = plan(shuffled, duration_ms=15_000)

    assert result.gaps == []
    assert [p.seq for p in result.placements] == [0, 1, 2]
