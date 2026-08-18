"""구간 재생 (`REVIEW-004`) — 발화 시각을 **저장된 소리 위의 위치**로 옮긴다.

## 왜 단순 뺄셈이 아닌가

재생하는 것은 트랙의 청크를 **이어 붙인** 원본(webm)이다. 이어 붙이는
순간 공백이 사라지고 뒤가 통째로 앞당겨진다 — `assembly.py` 머리말이
경고하는 바로 그 현상이다. 파이프라인은 그래서 무음을 채워 넣지만,
재생 경로에는 인코더가 없어 무음을 만들어 넣을 수 없다(FFmpeg 없음).
대신 **발화 시각에서 그 앞의 공백만큼을 빼면** 이어 붙인 소리 위의
위치가 된다. 그 계산이 여기 있다 — 순수 함수라 전부 검증된다.

## 두 번의 좌표 변환

발화 시각(`Utterance.start_ms`)은 **정렬된 공통 축** 위의 값이다
(ASR 이 `apply_offsets` 를 거친 신호를 읽으므로). 소리 위의 위치까지는
두 번 옮긴다:

    공통 축 ──(트랙 이동량을 뺌)──→ 트랙 축 ──(앞의 공백을 뺌)──→ 소리 위 위치

트랙 이동량은 `apply_offsets` 의 정규화 그대로다 — `offset_ms` 에서
회의 안 최솟값을 뺀 것(가장 이른 트랙이 0). ⚠️ 최솟값은 **소리가 있는
트랙들** 위에서 잡는다. 정렬에 참여하지 않은 트랙(청크 0개·unusable)은
`offset_ms` 가 기본값 0 으로 남아 있어, 섞으면 기준이 오염된다.

## 공백 안이면 `None` 이다

유실된 청크 위의 발화는 **들을 소리가 없다.** 가장 가까운 소리로
당겨 붙이면 엉뚱한 말이 나온다 — 없는 것은 없다고 답한다.
"""

from __future__ import annotations

from teamflow.audio.assembly import PlacedChunk


def track_shifts(offsets_ms: dict[int, int]) -> dict[int, int]:
    """트랙별 이동량 — `apply_offsets` 의 정규화를 그대로 재현한다.

    Args:
        offsets_ms: track_id → 저장된 `offset_ms`. **소리가 있는 트랙만**
            넣을 것 — 정렬에 참여 안 한 트랙의 0 이 섞이면 기준이 오염된다.
    """
    if not offsets_ms:
        return {}
    base = min(offsets_ms.values())
    return {track_id: off - base for track_id, off in offsets_ms.items()}


def track_axis_ms(common_ms: int, *, shift_ms: int) -> int:
    """정렬된 공통 축의 시각을 트랙 자신의 축으로 옮긴다."""
    return common_ms - shift_ms


def concat_position_ms(placements: list[PlacedChunk], track_ms: int) -> int | None:
    """트랙 축의 시각이 **이어 붙인 소리** 위 어디인가.

    이어 붙인 소리에서 청크 하나는 제 duration 만큼을 차지하고 공백은
    0 초를 차지한다. 그래서 위치 = 그 시각보다 앞에 놓인 청크 길이의 합
    (+ 그 시각이 청크 안이면 청크 안에서의 거리).

    Returns:
        소리 위 위치(ms). 그 시각이 공백 안이거나 녹음 범위 밖이면 `None`.
    """
    elapsed = 0
    for placement in sorted(placements, key=lambda p: (p.start_ms, p.seq)):
        if track_ms < placement.start_ms:
            # 앞선 청크들을 지나 공백에 들어섰다 — 들을 소리가 없다.
            return None
        if track_ms < placement.end_ms:
            return elapsed + (track_ms - placement.start_ms)
        elapsed += placement.duration_ms
    return None
