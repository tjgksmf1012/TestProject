"""GPU 배타 락.

docs/03-시스템-아키텍처.md §2.1

VRAM에 ASR + 화자분리 + LLM을 동시에 못 올린다 (docs/02 §3).
GPU 잡을 병렬로 돌리면 OOM 이 난다. 그래서 **동시에 하나만** 돌게 강제한다.

Celery GPU 큐를 `--concurrency=1` 로 띄우는 것과 별개로 이 락이 필요하다.
워커를 여러 대 띄우거나, 워커 밖에서 GPU를 쓰는 경로가 생길 수 있기 때문이다.

TTL이 핵심이다. 워커가 죽으면 락이 영구 점유되어 GPU 파이프라인 전체가 멈춘다.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Protocol

LOCK_KEY = "teamflow:gpu:lease"


class LockBackend(Protocol):
    """Redis 호환 최소 인터페이스."""

    def set(self, key: str, value: str, *, nx: bool, ex: int) -> bool | None: ...
    def get(self, key: str) -> str | bytes | None: ...
    def eval(self, script: str, numkeys: int, *args: str) -> int: ...


class GpuBusy(Exception):
    """다른 잡이 GPU를 쓰고 있다. 큐로 되돌려 재시도해야 한다."""

    def __init__(self, holder: str) -> None:
        super().__init__(f"GPU를 다른 잡이 점유 중입니다: {holder}")
        self.holder = holder


class GpuLeaseLost(RuntimeError):
    """작업 **도중에** 리스를 잃었다. GpuBusy 와 다르다.

    `GpuBusy` 는 시작도 못 한 것이라 그냥 다시 넣으면 됩니다. 이건 이미
    돌던 작업이 GPU 를 남과 나눠 쓰게 된 것이라, **그때까지 나온 결과를
    믿을 수 없습니다.** 조용히 이어 가면 두 ASR 이 다툰 결과가 멀쩡한
    회의록으로 저장됩니다.
    """

    def __init__(self, job_id: str) -> None:
        super().__init__(
            f"GPU 락을 작업 도중에 잃었습니다 ({job_id}). "
            "ASR 이 TTL 보다 오래 걸려 다른 잡이 같은 GPU 를 잡았을 수 있습니다."
        )
        self.job_id = job_id


# 소유자가 맞을 때만 해제한다.
# 확인 후 삭제를 두 번의 왕복으로 하면, 그 사이에 TTL 만료 + 다른 잡 획득이 일어나
# **남의 락을 지우는** 사고가 난다. Lua 로 원자적으로 처리한다.
_RELEASE_SCRIPT = """
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
else
    return 0
end
"""

_EXTEND_SCRIPT = """
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('expire', KEYS[1], ARGV[2])
else
    return 0
end
"""


@dataclass
class FakeRedis:
    """테스트용 인메모리 백엔드.

    Redis 서버 없이 락 의미론(TTL 만료, 소유권 검사)을 검증한다.
    """

    store: dict[str, tuple[str, float]] = field(default_factory=dict)
    now: float = 0.0

    def advance(self, seconds: float) -> None:
        self.now += seconds

    def _alive(self, key: str) -> tuple[str, float] | None:
        item = self.store.get(key)
        if item is None:
            return None
        if item[1] <= self.now:
            del self.store[key]
            return None
        return item

    def set(self, key: str, value: str, *, nx: bool, ex: int) -> bool | None:
        if nx and self._alive(key) is not None:
            return None
        self.store[key] = (value, self.now + ex)
        return True

    def get(self, key: str) -> str | None:
        item = self._alive(key)
        return item[0] if item else None

    def eval(self, script: str, numkeys: int, *args: str) -> int:
        key, token = args[0], args[1]
        current = self.get(key)
        if current != token:
            return 0
        if "expire" in script:
            self.store[key] = (token, self.now + int(args[2]))
            return 1
        del self.store[key]
        return 1


class GpuLease:
    """획득한 락. 만료 전에 갱신할 수 있다."""

    def __init__(self, backend: LockBackend, token: str, ttl: int, key: str) -> None:
        self._backend = backend
        self._token = token
        self._ttl = ttl
        self._key = key

    @property
    def token(self) -> str:
        return self._token

    def extend(self, ttl: int | None = None) -> bool:
        """긴 잡이 TTL을 넘길 것 같으면 갱신한다.

        1시간짜리 회의를 처리하다 TTL이 만료되면 다른 잡이 GPU를 잡아
        둘 다 OOM 으로 죽는다. 단계마다 갱신하는 게 안전하다.
        """
        seconds = ttl or self._ttl
        return bool(self._backend.eval(_EXTEND_SCRIPT, 1, self._key, self._token, str(seconds)))

    def release(self) -> bool:
        return bool(self._backend.eval(_RELEASE_SCRIPT, 1, self._key, self._token))


def acquire(
    backend: LockBackend, *, job_id: str, ttl: int = 1800, key: str = LOCK_KEY
) -> GpuLease:
    """GPU 락을 잡는다. 실패하면 GpuBusy 를 던진다."""
    # 토큰에 uuid 를 섞는다. job_id 만 쓰면 같은 잡을 재시도할 때
    # 이전 시도의 락을 자기 것으로 착각해 해제할 수 있다.
    token = f"{job_id}:{uuid.uuid4().hex[:12]}"
    if not backend.set(key, token, nx=True, ex=ttl):
        holder = backend.get(key)
        holder_str = holder.decode() if isinstance(holder, bytes) else (holder or "unknown")
        raise GpuBusy(holder_str)
    return GpuLease(backend, token, ttl, key)


@contextmanager
def gpu_lease(
    backend: LockBackend, *, job_id: str, ttl: int = 1800, key: str = LOCK_KEY
) -> Iterator[GpuLease]:
    """GPU 배타 구간.

        with gpu_lease(redis, job_id="meeting:42") as lease:
            run_diarization()
            lease.extend()
            run_asr()

    예외가 나도 반드시 해제된다. 해제에 실패해도 TTL 이 최후 안전장치다.
    """
    lease = acquire(backend, job_id=job_id, ttl=ttl, key=key)
    try:
        yield lease
    finally:
        lease.release()


def wait_for_gpu(
    backend: LockBackend,
    *,
    job_id: str,
    ttl: int = 1800,
    timeout: float = 0.0,
    poll_interval: float = 1.0,
    sleep=time.sleep,
) -> GpuLease:
    """락이 풀릴 때까지 기다린다.

    ⚠️ Celery 워커 안에서는 쓰지 마세요. 워커 슬롯을 붙잡고 대기하게 됩니다.
    큐로 되돌려 재시도(`Retry(countdown=...)`)하는 게 맞습니다.
    동기 스크립트나 테스트용입니다.
    """
    deadline = timeout
    waited = 0.0
    while True:
        try:
            return acquire(backend, job_id=job_id, ttl=ttl)
        except GpuBusy:
            if waited >= deadline:
                raise
            sleep(poll_interval)
            waited += poll_interval
