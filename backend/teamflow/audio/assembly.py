"""트랙 재조립 — 청크를 절대 시각에 배치하고 공백을 무음으로 메운다.

docs/04-회의-처리-파이프라인.md §2.6

## 왜 이어 붙이면 안 되는가

`chunk_store.concatenate` 는 청크를 순서대로 붙이기만 한다. 중간이 비면
그 자리가 사라지고 **뒤가 통째로 앞당겨진다.**

```
  실제:  [0~10초 발화][─── 30초 공백 ───][40~50초 발화]
  이어붙임: [0~10초 발화][40~50초 발화]
                        ↑ 이 오디오가 10초 지점에 놓인다 (30초 어긋남)
```

트랙 하나가 30초 어긋나면 GCC-PHAT 탐색창(±500ms)의 60배라 정렬이
복구되지 않는다. 그러면 에너지 비교로 뽑는 주화자가 전부 틀리고,
엉뚱한 사람의 기여도가 된다.

## 서버가 클라이언트와 따로 계산하는 이유

프런트 `timeline.ts` 도 같은 일을 한다. 그런데 클라이언트는 자기가 **만든**
청크를 알고, 서버는 실제로 **받은** 청크를 안다. 둘은 다르다 — 업로드에
실패한 청크는 클라이언트 쪽 계산에만 존재한다.

오디오를 실제로 배치하는 건 서버이므로, 배치의 근거도 서버가 가진 사실이어야
한다. 클라이언트 보고는 참고용이고, 더 나쁜 쪽을 택한다
(`services/recording_service.complete_track`).

이 모듈은 순수 계산이다. 모델도 GPU도 디코더도 필요 없고 전부 검증된다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum

import numpy as np

# 이보다 짧은 공백은 보고하지 않는다. 브라우저 지터 수준이라 화자 판정에
# 영향이 없고, 목록만 지저분해진다. (프런트 timeline.ts 와 같은 값)
MIN_REPORTED_GAP_MS = 100

# 이만큼까지의 지연은 정상 지터로 본다. `dataavailable` 은 timeslice 를
# 정확히 지키지 않는다. (프런트 timeline.ts 의 stallToleranceMs 와 같은 값)
STALL_TOLERANCE_MS = 300


@dataclass(frozen=True, slots=True)
class ChunkRecord:
    """서버가 실제로 받은 청크 하나. `track_chunks` 행에 대응한다."""

    seq: int
    #: 클라이언트가 동기화된 서버 시각으로 찍은 도착 시각 (epoch ms)
    client_at_ms: int


@dataclass(frozen=True, slots=True)
class PlacedChunk:
    """이 청크의 오디오가 트랙 안 어느 위치에 놓이는가."""

    seq: int
    #: 트랙 시작 기준 상대 위치(ms)
    start_ms: int
    duration_ms: int

    @property
    def end_ms(self) -> int:
        return self.start_ms + self.duration_ms


class GapReason(StrEnum):
    """공백이 왜 생겼는가 — **여기가 유일한 출처다.**

    ⚠️ 예전에는 `#: recorder_stalled | chunk_lost` 라는 **주석**이었다.
    주석은 아무도 안 읽고 아무것도 못 막는다 — 값을 적어 놓고 읽는 곳이
    없는 것은 이 저장소가 반복해 당한 모양이다(결함 74 의 `--ico`,
    결함 84 의 `confirmed`). 화면(`lib/track/diagram.ts`)이 이 값마다
    사람 문장을 가지고 있어야 하고, 그걸 테스트가 확인한다.
    """

    #: 조각 자체가 안 왔다 — 서버가 본 것
    CHUNK_LOST = "chunk_lost"
    #: 조각은 왔는데 그 사이에 시간이 비었다 — 녹음기가 멈춰 있었다
    RECORDER_STALLED = "recorder_stalled"
    #: 마이크가 꺼져 있었다. **서버는 알 수 없어** 클라이언트만 보고한다
    TRACK_MUTED = "track_muted"


@dataclass(frozen=True, slots=True)
class Gap:
    start_ms: int
    end_ms: int
    #: 값의 뜻은 `GapReason` 참조. 그쪽이 유일한 출처다.
    reason: str

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


@dataclass(frozen=True, slots=True)
class TrackPlan:
    duration_ms: int
    placements: list[PlacedChunk] = field(default_factory=list)
    gaps: list[Gap] = field(default_factory=list)

    @property
    def total_gap_ms(self) -> int:
        return sum(g.duration_ms for g in self.gaps)

    @property
    def longest_gap_ms(self) -> int:
        return max((g.duration_ms for g in self.gaps), default=0)

    @property
    def coverage(self) -> float:
        if self.duration_ms <= 0:
            return 0.0
        return max(0.0, 1.0 - self.total_gap_ms / self.duration_ms)

    @property
    def lost_seqs(self) -> list[int]:
        """클라이언트가 만들었지만 서버에 도착하지 않은 seq.

        seq 는 0부터 빠짐없이 올라가므로(프런트 client.ts), 받은 것 중
        최댓값까지의 구멍이 곧 유실이다.
        """
        have = {p.seq for p in self.placements}
        if not have:
            return []
        return [seq for seq in range(max(have) + 1) if seq not in have]


def plan_track(
    chunks: list[ChunkRecord],
    *,
    timeslice_ms: int,
    started_at_ms: int,
    ended_at_ms: int,
) -> TrackPlan:
    """받은 청크들을 절대 시각에 배치하는 계획을 세운다.

    청크 하나는 도착 시각 **직전** ``timeslice_ms`` 구간의 오디오를 담는다
    (`MediaRecorder.start(timeslice)` 의 동작). 그래서 배치 위치는
    ``client_at_ms - timeslice_ms`` 다.

    Args:
        started_at_ms: 녹음 시작 시각 (동기화된 서버 시각)
        ended_at_ms: 녹음 종료 시각

    Raises:
        ValueError: 시간 범위나 timeslice 가 말이 안 될 때
    """
    if timeslice_ms <= 0:
        raise ValueError("timeslice_ms 는 양수여야 합니다")
    if ended_at_ms < started_at_ms:
        raise ValueError("종료 시각이 시작 시각보다 빠릅니다")

    duration_ms = ended_at_ms - started_at_ms
    ordered = sorted(chunks, key=lambda c: c.seq)

    placements: list[PlacedChunk] = []
    previous_end = 0
    # 정지 시각을 이만큼 넘겨 도착한 청크는 내용을 알 수 없으므로 버린다.
    # 살짝 늦은 건(마지막 flush) 잘라서 쓰고, 한참 늦은 건 쓰지 않는다 —
    # 어느 구간의 오디오인지 모르는 걸 끼워넣으면 그 자리가 통째로 거짓이 된다.
    latest_acceptable = duration_ms + timeslice_ms + STALL_TOLERANCE_MS

    for chunk in ordered:
        relative = chunk.client_at_ms - started_at_ms
        if relative > latest_acceptable:
            continue
        end = min(duration_ms, relative)
        # 레코더는 "지난 emit 이후의 오디오 전부"를 담는다. timeslice 는
        # 목표값일 뿐 정확히 지켜지지 않으므로, 정상 범위 안이면 앞 청크에
        # **이어 붙인다.** 고정 폭으로 자르면 지터마다 수십 ms 짜리 가짜
        # 공백이 생기고, 그게 그대로 커버리지를 갉아먹는다. (테스트로 잡힘)
        if end - previous_end <= timeslice_ms + STALL_TOLERANCE_MS:
            start = previous_end
        else:
            # 간격이 벌어졌다 — 레코더가 멈췄거나 중간 청크를 잃었다.
            # 이 청크에 실제로 담긴 건 마지막 timeslice 뿐이다.
            start = max(previous_end, end - timeslice_ms)

        start = max(0, start)
        if end <= start:
            # 녹음 범위 밖에서 온 청크. 버리지 않고 무시만 한다 —
            # 배치할 자리가 없으면 억지로 끼워넣는 것보다 없는 게 낫다.
            continue
        placements.append(PlacedChunk(seq=chunk.seq, start_ms=start, duration_ms=end - start))
        previous_end = end

    return TrackPlan(
        duration_ms=duration_ms,
        placements=placements,
        gaps=_find_gaps(placements, duration_ms),
    )


def _find_gaps(placements: list[PlacedChunk], duration_ms: int) -> list[Gap]:
    """배치된 구간의 여집합이 공백이다.

    원인을 둘로 나눈다 — seq 가 이어져 있는데 시간이 벌어졌으면 **레코더가
    멈춘 것**(폰 화면 잠금)이고, seq 가 건너뛰었으면 **업로드 유실**이다.
    seq 가 0부터 빽빽하게 올라간다는 성질 덕에 서버 혼자 구별할 수 있다.
    """
    have = {p.seq for p in placements}
    gaps: list[Gap] = []

    def add(start: int, end: int, before_seq: int | None, after_seq: int | None) -> None:
        if end - start < MIN_REPORTED_GAP_MS:
            return
        lost_between = (
            before_seq is not None
            and after_seq is not None
            and any(seq not in have for seq in range(before_seq + 1, after_seq))
        )
        reason = "chunk_lost" if lost_between else "recorder_stalled"
        gaps.append(Gap(start_ms=start, end_ms=end, reason=reason))

    cursor = 0
    previous_seq: int | None = None
    # 겹치는 배치가 있어도 커서는 뒤로 가지 않게 한다
    for placement in sorted(placements, key=lambda p: (p.start_ms, p.seq)):
        if placement.start_ms > cursor:
            add(cursor, placement.start_ms, previous_seq, placement.seq)
        cursor = max(cursor, placement.end_ms)
        previous_seq = placement.seq

    if cursor < duration_ms:
        # 마지막 청크와 종료 시각 사이. 뒤에 청크가 더 있었는지 알 방법이
        # 없으므로 "멈춘 것"으로 본다. 유실이었다면 다음 seq 가 왔을 것이다.
        add(cursor, duration_ms, previous_seq, None)

    return gaps


def render(
    plan: TrackPlan,
    decoded: dict[int, np.ndarray],
    *,
    sample_rate: int,
) -> np.ndarray:
    """계획대로 오디오를 배치한 단일 트랙을 만든다.

    공백은 0(무음)으로 남는다. **길이가 항상 ``plan.duration_ms`` 다** —
    이게 이 함수의 존재 이유다. 모든 트랙이 같은 시간축을 갖게 되므로
    이후 GCC-PHAT 미세 정렬이 의미를 가진다.

    Args:
        decoded: seq → PCM 샘플. 디코딩(FFmpeg)은 호출자가 한다.
            계획에 없는 seq 는 무시하고, 없는 seq 는 무음으로 남긴다.

    Note:
        디코딩된 길이가 계획된 길이와 다를 수 있다 (컨테이너 오버헤드,
        인코더 지연). 넘치면 자르고 모자라면 무음으로 채운다 — 배치 시각을
        지키는 쪽이 샘플 몇 개보다 중요하다.
    """
    total_samples = _ms_to_samples(plan.duration_ms, sample_rate)
    out = np.zeros(total_samples, dtype=np.float32)

    for placement in plan.placements:
        audio = decoded.get(placement.seq)
        if audio is None or len(audio) == 0:
            continue
        start = _ms_to_samples(placement.start_ms, sample_rate)
        if start >= total_samples:
            continue
        room = min(_ms_to_samples(placement.duration_ms, sample_rate), total_samples - start)
        take = min(len(audio), room)
        out[start : start + take] = audio[:take].astype(np.float32, copy=False)

    return out


def _ms_to_samples(ms: int, sample_rate: int) -> int:
    return round(ms * sample_rate / 1000)


def naive_concatenation_shift_ms(plan: TrackPlan) -> int:
    """이어 붙이기만 했을 때 트랙 끝이 앞당겨지는 양.

    "왜 무음 패딩이 필요한가"를 수치로 보여주기 위한 함수다.
    발표와 운영 화면 양쪽에서 쓸 수 있다.
    """
    return plan.total_gap_ms
