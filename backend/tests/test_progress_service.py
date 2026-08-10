"""회의 처리 진행률 — **모르는 것을 0% 로 답하지 않는가.**

`RedisProgress` 는 처음부터 있었고 docstring 에 "API가 SSE로 프런트에
흘린다" 고 적혀 있었는데, **읽는 곳이 0곳**이었습니다 (감사 #8).
1시간 회의는 처리에 10분이 걸릴 수 있고, 그동안 화면이 할 수 있는 말은
"처리 중입니다" 뿐이었습니다 — 멈춘 건지 도는 건지도 모릅니다.

이 파일이 고정하는 것은 그 반대쪽입니다. **진행률을 모를 때 아는 척하지
않는 것.** 0% 로 답하면 사람은 멈춰 있다고 읽습니다.
"""

from __future__ import annotations

from teamflow.pipeline.steps import RedisProgress
from teamflow.services import progress_service as svc


class FakeRedis:
    """`hset(mapping=...)` 과 `hgetall` 만 흉내 낸다."""

    def __init__(self) -> None:
        self.store: dict[str, dict[str, str]] = {}
        self.expires: dict[str, int] = {}

    def hset(self, key: str, mapping: dict) -> None:
        self.store[key] = {k: str(v) for k, v in mapping.items()}

    def expire(self, key: str, ttl: int) -> None:
        self.expires[key] = ttl

    def hgetall(self, key: str) -> dict[str, str]:
        return dict(self.store.get(key, {}))


class BrokenRedis:
    def hgetall(self, key: str) -> dict:
        raise ConnectionError("Redis 가 죽었습니다")


# ══════════════════════════════════════════════════════════════
# 쓰는 쪽과 읽는 쪽이 **같은 키**를 보는가
# ══════════════════════════════════════════════════════════════


def test_the_writer_and_the_reader_meet_at_the_same_key():
    """⭐⭐ 이게 이 파일의 핵심입니다.

    키 문자열이 두 파일에 손으로 적혀 있습니다. 한쪽만 바꾸면 읽는 쪽이
    **조용히 빈 값**을 받고, 화면은 영원히 "진행 상황을 알 수 없습니다"
    라고 말합니다. 오류는 어디에도 안 납니다.

    그래서 **실제로 쓰고 실제로 읽어** 봅니다.
    """
    redis = FakeRedis()
    RedisProgress(redis).report(42, "transcribe", 60, "3/5 트랙")

    got = svc.read_progress(redis, 42)

    assert got is not None, "쓰는 쪽과 읽는 쪽의 키가 어긋났습니다"
    assert got.stage == "transcribe"
    assert got.percent == 60
    assert got.detail == "3/5 트랙"


def test_another_meetings_progress_is_not_mixed_in():
    redis = FakeRedis()
    RedisProgress(redis).report(1, "align", 20)

    assert svc.read_progress(redis, 2) is None


# ══════════════════════════════════════════════════════════════
# 모르는 것을 0% 로 답하지 않는다
# ══════════════════════════════════════════════════════════════


def test_no_redis_means_unknown_not_zero():
    """⭐ 이 배포에 Redis 가 없으면 **모르는 것**입니다.

    0% 로 답하면 사람은 "처리가 시작도 안 됐다" 로 읽고, 실제로는 벌써
    끝났을 수도 있습니다.
    """
    assert svc.read_progress(None, 42) is None


def test_a_broken_redis_does_not_take_the_screen_down():
    """⭐ 진행률은 **보조 정보**다. 이것 때문에 로비가 죽으면 안 된다."""
    assert svc.read_progress(BrokenRedis(), 42) is None


def test_a_missing_key_is_unknown():
    assert svc.read_progress(FakeRedis(), 42) is None


def test_a_broken_value_is_unknown_not_zero():
    """단계 이름이 없으면 백분율만으로는 아무 뜻이 없다."""
    assert svc.parse_progress({"percent": "40"}) is None
    assert svc.parse_progress({"stage": "", "percent": "40"}) is None
    assert svc.parse_progress({}) is None
    assert svc.parse_progress(None) is None


def test_a_broken_percent_does_not_raise():
    got = svc.parse_progress({"stage": "align", "percent": "육십"})
    assert got is not None
    assert got.percent == 0


def test_percent_stays_inside_the_bar():
    """100 을 넘거나 음수인 값을 그대로 그리면 화면이 고장 나 보인다."""
    assert svc.parse_progress({"stage": "x", "percent": 250}).percent == 100
    assert svc.parse_progress({"stage": "x", "percent": -5}).percent == 0


# ══════════════════════════════════════════════════════════════
# 문구 — 상태에 따라 다른 말을 한다
# ══════════════════════════════════════════════════════════════


def test_a_known_stage_is_said_in_human_words():
    """⭐ 우리 용어(`transcribe`)를 화면에 내보내지 않는다."""
    line = svc.describe(svc.Progress("transcribe", 60), meeting_status="processing")
    assert "transcribe" not in line
    assert "말을 글로 옮기는 중" in line
    assert "60%" in line


def test_an_unknown_stage_still_becomes_a_sentence():
    line = svc.describe(svc.Progress("quantum_flux", 10), meeting_status="processing")
    assert "quantum_flux" not in line
    assert "처리 중" in line


def test_detail_is_appended_when_there_is_one():
    assert "3/5 트랙" in svc.describe(
        svc.Progress("align", 20, "3/5 트랙"), meeting_status="processing"
    )


def test_unknown_progress_while_processing_says_so_without_a_number():
    """⭐⭐ **0% 라고 하지 않는다.**

    처리 중인데 진행률을 못 받은 것과, 처리가 0% 인 것은 다릅니다.
    앞은 기다리면 되고 뒤는 멈춘 것입니다.
    """
    line = svc.describe(None, meeting_status="processing")
    assert "0%" not in line
    assert "알 수 없" in line


def test_unknown_progress_after_processing_says_nothing():
    """⭐ 끝난 회의에 "진행 상황을 알 수 없습니다" 라고 하면 사람은 계속
    기다립니다. 할 일이 없으면 아무 말도 안 하는 것이 맞습니다."""
    assert svc.describe(None, meeting_status="needs_review") == ""
    assert svc.describe(None, meeting_status="confirmed") == ""


def test_a_failed_meeting_says_it_failed():
    assert "실패" in svc.describe(None, meeting_status="failed")
