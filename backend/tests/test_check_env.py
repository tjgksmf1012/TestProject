"""`scripts/check_env.py` 테스트.

이 스크립트는 **사용자가 실제 머신에서 가장 먼저 실행하는 것**입니다
(docs/01·02·03·08·09 다섯 군데에서 첫 단계로 지시합니다). 여기서 잘못
말해 주면 사용자는 잘못된 전제로 며칠을 씁니다.

특히 조심하는 것: **"설치돼 있음"과 "쓸 수 있음"은 다릅니다.**
transformers 4.x 에 초록 체크를 찍어주면 사용자는 준비가 끝난 줄 알고,
Qwen3-ASR 을 로딩하는 순간에야 막힙니다.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "check_env.py"


def load_check_env():
    """패키지가 아니라 스크립트라 경로로 읽어들인다.

    `sys.modules` 에 먼저 넣어야 한다 — `@dataclass` 가 애너테이션을 풀 때
    자기 모듈을 되찾아 보기 때문이다. 안 넣으면 `Gpu` 정의에서 터진다.
    """
    spec = importlib.util.spec_from_file_location("check_env", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["check_env"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def env():
    return load_check_env()


def test_script_exists():
    """문서 다섯 군데가 이 경로를 지시한다."""
    assert SCRIPT.is_file()


# ══════════════════════════════════════════════════════════════
# 버전 파싱 — 진단 도구가 진단 대상 때문에 죽으면 안 된다
# ══════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("4.0.1", (4, 0, 1)),
        ("5.13", (5, 13)),
        ("12.8", (12, 8)),
        ("5.13.0.dev0", (5, 13, 0)),
        ("2.7.1+cu128", (2, 7, 1)),
        ("4.0.0rc1", (4, 0, 0)),
    ],
)
def test_parse_version(env, raw: str, expected: tuple[int, ...]):
    assert env.parse_version(raw) == expected


@pytest.mark.parametrize("raw", ["", "unknown", "?", "N/A", "..", "cu128"])
def test_parse_version_never_raises(env, raw: str):
    """`tuple(map(int, s.split(".")))` 이었을 때는 여기서 전부 터졌다."""
    assert isinstance(env.parse_version(raw), tuple)


def test_version_comparison_is_numeric_not_lexical(env):
    """문자열 비교면 '4.10' < '4.9' 가 된다. 이게 버전 게이트의 핵심."""
    assert env.parse_version("4.10") > env.parse_version("4.9")
    assert env.parse_version("5.13") >= (5, 13)
    assert env.parse_version("5.9") < (5, 13)


def test_minimum_versions_match_the_documented_reasons(env):
    """docs/01 §검증 결과와 같은 숫자여야 한다."""
    assert env.MIN_VERSIONS["transformers"] == (5, 13)  # Qwen3-ASR 네이티브 지원
    assert env.MIN_VERSIONS["pyannote.audio"] == (4, 0)  # community-1


def test_transformers_4x_would_fail_the_gate(env):
    """⭐ 예전에는 4.x 에도 초록 체크가 나갔다.

    사용자는 준비 완료로 읽고, Qwen3-ASR 로딩에서 처음 막힌다.
    """
    assert env.parse_version("4.57.1") < env.MIN_VERSIONS["transformers"]
    assert env.parse_version("5.13.0") >= env.MIN_VERSIONS["transformers"]


# ══════════════════════════════════════════════════════════════
# GPU 판정
# ══════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    ("capability", "arch"),
    [
        ((7, 5), "Turing"),
        ((8, 6), "Ampere"),
        ((8, 9), "Ada Lovelace"),
        ((9, 0), "Hopper"),
        ((12, 0), "Blackwell"),
        ((10, 3), "sm_103"),
        (None, "unknown"),
    ],
)
def test_arch_names(env, capability, arch: str):
    assert env.Gpu(name="x", vram_gb=16, capability=capability).arch == arch


@pytest.mark.parametrize(
    ("capability", "fp8"),
    [((8, 0), False), ((8, 6), False), ((8, 9), True), ((9, 0), True), ((12, 0), True)],
)
def test_fp8_support(env, capability, fp8: bool):
    """FP8 미지원이면 KV 캐시를 INT8 로 내려야 한다 — VRAM 예산이 달라진다."""
    assert env.Gpu(name="x", vram_gb=16, capability=capability).supports_fp8 is fp8


def test_only_blackwell_needs_cu128(env):
    """원본 자료의 RTX 5080 전제가 틀렸으므로 대부분 해당 없다 (docs/01 #10)."""
    assert env.Gpu(name="x", vram_gb=16, capability=(12, 0)).needs_cu128 is True
    assert env.Gpu(name="x", vram_gb=16, capability=(8, 9)).needs_cu128 is False
    assert env.Gpu(name="x", vram_gb=16, capability=None).needs_cu128 is False


# ══════════════════════════════════════════════════════════════
# 구성 추천 — 티어 경계
# ══════════════════════════════════════════════════════════════


def tier_of(env, vram: float, ram: float | None) -> str:
    head = env.recommend(vram, ram)[0]
    return head.split("—")[0].strip()


@pytest.mark.parametrize(
    ("vram", "tier"),
    [(0, "티어 0"), (6, "티어 1"), (8, "티어 2"), (12, "티어 2"), (14, "티어 3"), (24, "티어 3")],
)
def test_tier_boundaries(env, vram: float, tier: str):
    """docs/02 의 티어 표와 같은 경계여야 한다."""
    assert tier_of(env, vram, 32) == tier


def test_users_actual_hardware_gets_the_cpu_offload_advice(env):
    """이 프로젝트의 실제 전제: 중급 GPU 10~16GB + RAM 32GB.

    RAM 32GB 덕에 LLM 을 CPU 로 내리는 전략이 1순위가 됐다 (docs/01 #10).
    그 권고가 실제로 나와야 한다.
    """
    lines = "\n".join(env.recommend(12, 32))
    assert "CPU로 내리면" in lines


def test_big_gpu_does_not_get_the_cpu_offload_advice(env):
    assert "CPU로 내리면" not in "\n".join(env.recommend(24, 32))


def test_low_ram_is_flagged(env):
    assert "빠듯" in "\n".join(env.recommend(8, 8))


def test_undetected_ram_is_reported_not_assumed(env):
    """⭐ 모르는 값을 16GB 로 메우고 넘어가면 안 된다.

    예전에는 `ram or 16.0` 이라 탐지 실패가 조용히 "16GB" 가 됐고,
    32GB 사용자가 가장 중요한 권고를 못 받았다.
    """
    lines = "\n".join(env.recommend(12, None))

    assert "탐지 실패" in lines
    assert "32GB 이상이면" in lines
    assert "빠듯" not in lines, "모르는데 부족하다고 단정하면 안 된다"


def test_no_gpu_still_gets_a_usable_plan(env):
    """GPU 가 없어도 '못 한다'로 끝내지 않는다 — 졸업작품이 멈추면 안 된다."""
    lines = "\n".join(env.recommend(0, None))

    assert "티어 0" in lines
    assert "CPU" in lines
    assert "Kaggle" in lines


# ══════════════════════════════════════════════════════════════
# 패키지·도구 탐지
# ══════════════════════════════════════════════════════════════


def test_module_version_reads_distribution_metadata(env):
    """`__import__("pyannote.audio")` 는 최상위 `pyannote` 를 돌려준다.

    그걸로 `__version__` 을 읽으면 엉뚱한 것을 보고, community-1 에 필요한
    v4.0 판정이 통째로 무의미해진다.
    """
    assert env.module_version("pytest") == pytest.__version__


def test_module_version_of_missing_package_is_none(env):
    assert env.module_version("teamflow_does_not_exist") is None


def test_module_version_distinguishes_missing_from_unknown(env):
    """None(미설치)과 ""(설치됐지만 버전 모름)은 화면에 다르게 나가야 한다.

    미설치는 `·  미설치`, 버전 미상은 `✓  ?` 로 나간다. 버전을 모른다고
    미설치로 보고하면 사용자는 이미 있는 것을 다시 깔러 간다.
    """
    assert env.module_version("posixpath") == ""  # 배포도 __version__ 도 없다


def test_ffmpeg_is_required_not_optional(env):
    """ffmpeg 이 없으면 청크를 하나도 디코딩할 수 없다.

    회의 전체가 "아무도 말하지 않았다"가 되므로 경고가 아니라 실패다.
    """
    source = SCRIPT.read_text(encoding="utf-8")
    assert '("ffmpeg", "오디오 전처리' in source
    assert "청크를 디코딩할 수 없습니다" in source


def test_nvidia_smi_output_is_parsed(env, monkeypatch):
    import subprocess

    class Result:
        stdout = "NVIDIA GeForce RTX 4070, 12282\nNVIDIA GeForce RTX 3060, 12288\n"

    monkeypatch.setattr(env.shutil, "which", lambda _cmd: "/usr/bin/nvidia-smi")
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: Result())

    gpus = env.detect_gpu_via_nvidia_smi()

    assert [g.name for g in gpus] == ["NVIDIA GeForce RTX 4070", "NVIDIA GeForce RTX 3060"]
    assert gpus[0].vram_gb == pytest.approx(11.99, abs=0.02)


def test_nvidia_smi_absent_is_not_an_error(env, monkeypatch):
    monkeypatch.setattr(env.shutil, "which", lambda _cmd: None)
    assert env.detect_gpu_via_nvidia_smi() == []


def test_nvidia_smi_garbage_is_ignored(env, monkeypatch):
    import subprocess

    class Result:
        stdout = "Failed to initialize NVML: Driver/library version mismatch\n"

    monkeypatch.setattr(env.shutil, "which", lambda _cmd: "/usr/bin/nvidia-smi")
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: Result())

    assert env.detect_gpu_via_nvidia_smi() == []


def test_two_small_cards_do_not_add_up(env, monkeypatch, capsys):
    """⭐ 8GB 두 장은 16GB 가 아니다.

    모델 하나는 카드 하나에 올라간다. 합으로 잡으면 티어를 한 칸 올려
    추천하고, 사용자는 안 올라가는 모델을 받는다.
    """
    monkeypatch.setattr(
        env,
        "detect_gpu_via_torch",
        lambda: ([env.Gpu("A", 8.0, (8, 6)), env.Gpu("B", 8.0, (8, 6))], "2.5.0", "12.4"),
    )
    monkeypatch.setattr(env, "detect_ram_gb", lambda: 32.0)

    vram, ram = env.check_hardware()
    capsys.readouterr()

    assert vram == 8.0
    assert ram == 32.0


# ══════════════════════════════════════════════════════════════
# 전체 실행 — 이 환경(GPU 없음, ffmpeg 없음)에서도 죽지 않아야 한다
# ══════════════════════════════════════════════════════════════


def test_main_runs_without_gpu_or_torch(env, capsys):
    code = env.main()
    out = capsys.readouterr().out

    assert code == 0, "Python 3.11+ 이므로 성공이어야 한다"
    assert "티어" in out
    assert "환경 점검" in out


def test_main_reports_this_environment_honestly(env, capsys):
    """GPU 도 ffmpeg 도 없는 이 컨테이너에서 무엇을 말하는지 고정한다."""
    env.main()
    out = capsys.readouterr().out

    assert "GPU 없음" in out
    assert "ffmpeg" in out
    assert "getUserMedia" in out, "실기기 녹음 전제조건 안내가 빠지면 안 된다"


def test_script_runs_as_a_subprocess():
    """import 로만 검증하면 `if __name__` 아래가 안 돈다."""
    import subprocess

    result = subprocess.run(
        [sys.executable, str(SCRIPT)],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
        env={"NO_COLOR": "1", "PATH": "/usr/bin:/bin"},
    )

    assert result.returncode == 0, result.stderr
    assert "TeamFlow AI" in result.stdout
