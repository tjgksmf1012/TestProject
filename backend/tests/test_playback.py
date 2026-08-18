"""구간 재생 좌표 변환 (`REVIEW-004`) — audio/playback.py.

이어 붙인 원본에는 공백이 없으므로, 발화 시각에서 앞의 공백만큼을
빼야 소리 위의 위치가 된다. 여기서 틀리면 **엉뚱한 말이 재생된다** —
근거를 들려주겠다는 화면이 다른 발언을 들려주는 것이라, 안 만드느니만
못한 실패다.
"""

from teamflow.audio.assembly import PlacedChunk
from teamflow.audio.playback import concat_position_ms, track_axis_ms, track_shifts


def _chunks(*spans: tuple[int, int]) -> list[PlacedChunk]:
    return [
        PlacedChunk(seq=i, start_ms=start, duration_ms=end - start)
        for i, (start, end) in enumerate(spans)
    ]


class TestConcatPosition:
    def test_공백이_없으면_그대로다(self):
        placements = _chunks((0, 5_000), (5_000, 10_000))
        assert concat_position_ms(placements, 7_300) == 7_300

    def test_앞의_공백만큼_당겨진다(self):
        # [0~10초] ── 30초 공백 ── [40~50초] : assembly.py 머리말의 예 그대로.
        placements = _chunks((0, 10_000), (40_000, 50_000))
        # 45초 지점의 발화는 이어 붙인 소리에서 15초 지점에 있다.
        assert concat_position_ms(placements, 45_000) == 15_000

    def test_공백_안이면_None_이다(self):
        # 유실된 구간의 발화를 가장 가까운 소리로 당겨 붙이면
        # **엉뚱한 말**이 나온다. 없는 것은 없다고 답한다.
        placements = _chunks((0, 10_000), (40_000, 50_000))
        assert concat_position_ms(placements, 20_000) is None

    def test_녹음_범위_밖이면_None_이다(self):
        placements = _chunks((0, 10_000))
        assert concat_position_ms(placements, 12_000) is None
        assert concat_position_ms(placements, -100) is None

    def test_청크가_없으면_None_이다(self):
        assert concat_position_ms([], 0) is None

    def test_경계값_청크의_시작은_소리가_있고_끝은_다음_몫이다(self):
        placements = _chunks((0, 5_000), (5_000, 10_000))
        assert concat_position_ms(placements, 0) == 0
        assert concat_position_ms(placements, 5_000) == 5_000
        # 마지막 청크의 끝 = 소리가 끝난 자리.
        assert concat_position_ms(placements, 10_000) is None


class TestTrackShifts:
    def test_가장_이른_트랙이_0_이_된다(self):
        # apply_offsets 의 min 정규화 그대로 — 검사가 그 함수와 갈라지면
        # 재생 위치가 정렬과 어긋난다.
        assert track_shifts({1: 200, 2: -300, 3: 0}) == {1: 500, 2: 0, 3: 300}

    def test_트랙이_없으면_빈_사전이다(self):
        assert track_shifts({}) == {}

    def test_공통_축에서_트랙_축으로(self):
        # 300ms 늦게 시작한 트랙: 공통 축 10초 = 트랙 축 9.7초.
        assert track_axis_ms(10_000, shift_ms=300) == 9_700
