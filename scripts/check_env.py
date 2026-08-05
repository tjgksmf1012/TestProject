#!/usr/bin/env python3
"""0주차 환경 점검 — 이 PC에서 무엇이 돌아가는지 진단하고 구성을 추천한다.

    python3 scripts/check_env.py

torch 가 없어도 실행된다. 없으면 그 사실을 알려주고 설치 명령을 안내한다.
GPU가 없거나 작아도 실행된다. 그에 맞는 구성을 추천한다.

docs/09-리스크와-검증-실험.md 실험 0
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
from dataclasses import dataclass

GREEN, YELLOW, RED, DIM, BOLD, RESET = (
    "\033[32m",
    "\033[33m",
    "\033[31m",
    "\033[2m",
    "\033[1m",
    "\033[0m",
)
if not sys.stdout.isatty() or os.environ.get("NO_COLOR"):
    GREEN = YELLOW = RED = DIM = BOLD = RESET = ""

OK, WARN, FAIL, INFO = f"{GREEN}✓{RESET}", f"{YELLOW}!{RESET}", f"{RED}✗{RESET}", "·"


def h(title: str) -> None:
    print(f"\n{BOLD}{title}{RESET}\n{'─' * 62}")


# ══════════════════════════════════════════════════════════════
# 하드웨어 탐지
# ══════════════════════════════════════════════════════════════


@dataclass
class Gpu:
    name: str
    vram_gb: float
    capability: tuple[int, int] | None = None

    @property
    def arch(self) -> str:
        if not self.capability:
            return "unknown"
        major, minor = self.capability
        return {
            (7, 5): "Turing",
            (8, 0): "Ampere",
            (8, 6): "Ampere",
            (8, 9): "Ada Lovelace",
            (9, 0): "Hopper",
            (12, 0): "Blackwell",
        }.get((major, minor), f"sm_{major}{minor}")

    @property
    def supports_fp8(self) -> bool:
        """FP8 네이티브 지원 여부. KV 캐시 양자화에 영향."""
        return bool(self.capability and self.capability >= (8, 9))

    @property
    def needs_cu128(self) -> bool:
        """Blackwell(sm_120)은 PyTorch 2.7+ cu128 휠이 필수."""
        return bool(self.capability and self.capability[0] >= 12)


def detect_ram_gb() -> float | None:
    try:
        if hasattr(os, "sysconf") and "SC_PAGE_SIZE" in os.sysconf_names:
            pages = os.sysconf("SC_PHYS_PAGES")
            size = os.sysconf("SC_PAGE_SIZE")
            return pages * size / 1024**3
    except (ValueError, OSError):
        pass
    if platform.system() == "Windows":
        try:
            out = subprocess.run(
                ["wmic", "computersystem", "get", "TotalPhysicalMemory"],
                capture_output=True, text=True, timeout=10, check=False,
            ).stdout
            nums = [int(t) for t in out.split() if t.isdigit()]
            if nums:
                return nums[0] / 1024**3
        except (OSError, subprocess.SubprocessError):
            pass
    return None


def detect_gpu_via_nvidia_smi() -> list[Gpu]:
    if not shutil.which("nvidia-smi"):
        return []
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=15, check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    gpus = []
    for line in out.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 2 and parts[1].replace(".", "").isdigit():
            gpus.append(Gpu(name=parts[0], vram_gb=float(parts[1]) / 1024))
    return gpus


def detect_gpu_via_torch() -> tuple[list[Gpu], str | None, str | None]:
    """(GPU 목록, torch 버전, torch가 빌드된 CUDA 버전)"""
    try:
        import torch
    except ImportError:
        return [], None, None

    version = torch.__version__
    cuda_build = getattr(torch.version, "cuda", None)
    if not torch.cuda.is_available():
        return [], version, cuda_build

    gpus = []
    for i in range(torch.cuda.device_count()):
        props = torch.cuda.get_device_properties(i)
        gpus.append(
            Gpu(
                name=props.name,
                vram_gb=props.total_memory / 1024**3,
                capability=(props.major, props.minor),
            )
        )
    return gpus, version, cuda_build


# ══════════════════════════════════════════════════════════════
# 구성 추천
# ══════════════════════════════════════════════════════════════


def recommend(vram: float, ram: float | None) -> list[str]:
    """실제 하드웨어에 맞는 구성을 추천한다.

    docs/02-모델-선정과-VRAM-예산.md 의 티어 표와 같은 기준.
    """
    ram = ram or 16.0
    lines: list[str] = []

    if vram <= 0:
        lines += [
            f"{BOLD}티어 0 — GPU 없음 (CPU 전용){RESET}",
            "  ASR       Qwen3-ASR-0.6B (CPU). 1시간 회의 ≈ 20~40분 처리",
            "  화자분리  pyannote community-1 (CPU). 느리지만 동작",
            "  LLM       EXAONE-4.0-1.2B 또는 Qwen3 소형, llama.cpp Q4",
            "  전략      전부 CPU 배치. 실시간 불가, 배치는 충분",
            f"  {DIM}학습이 필요하면 Kaggle 무료 GPU (주 30시간) 사용{RESET}",
        ]
    elif vram < 8:
        lines += [
            f"{BOLD}티어 1 — 소형 GPU ({vram:.0f}GB){RESET}",
            "  ASR       Qwen3-ASR-0.6B (GPU)",
            "  화자분리  pyannote community-1 (GPU)",
            "  LLM       CPU로 내리기 (llama.cpp Q4) ← RAM 여유 활용",
            "  전략      순차 적재 필수. GPU 배타 락",
        ]
    elif vram < 14:
        lines += [
            f"{BOLD}티어 2 — 중급 GPU ({vram:.0f}GB){RESET}",
            "  ASR       Qwen3-ASR-1.7B (FP16)",
            "  화자분리  pyannote community-1",
            "  LLM       Qwen3 8B급 4bit, 컨텍스트 16K로 제한",
            "  전략      순차 적재. 또는 LLM만 CPU로 (RAM 32GB면 권장)",
        ]
    else:
        lines += [
            f"{BOLD}티어 3 — 중상급 GPU ({vram:.0f}GB){RESET}",
            "  ASR       Qwen3-ASR-1.7B (FP16)",
            "  화자분리  pyannote community-1",
            "  LLM       Qwen3 8~14B 4bit, 컨텍스트 32K",
            "  전략      순차 적재. ASR+화자분리 상주도 가능",
        ]

    if ram >= 32 and 0 < vram < 14:
        lines.append(
            f"  {GREEN}RAM {ram:.0f}GB{RESET} — LLM 단계를 CPU로 내리면 VRAM이 크게 여유로워집니다"
        )
    elif ram < 16:
        lines.append(f"  {YELLOW}RAM {ram:.0f}GB{RESET} — CPU 추론에 빠듯합니다. 소형 모델 위주로")

    return lines


# ══════════════════════════════════════════════════════════════
# 점검 항목
# ══════════════════════════════════════════════════════════════


def check_python() -> bool:
    h("1. Python")
    v = sys.version_info
    ok = (v.major, v.minor) >= (3, 11)
    mark = OK if ok else FAIL
    print(f"{mark} Python {v.major}.{v.minor}.{v.micro}  (필요: 3.11+)")
    print(f"{INFO} {platform.system()} {platform.machine()}")
    return ok


def check_hardware() -> tuple[float, float | None]:
    h("2. 하드웨어")

    ram = detect_ram_gb()
    if ram:
        mark = OK if ram >= 16 else WARN
        print(f"{mark} RAM {ram:.1f} GB")
    else:
        print(f"{INFO} RAM 탐지 실패")

    torch_gpus, torch_version, cuda_build = detect_gpu_via_torch()
    smi_gpus = detect_gpu_via_nvidia_smi()
    gpus = torch_gpus or smi_gpus

    if torch_version:
        print(f"{OK} torch {torch_version}  (CUDA 빌드: {cuda_build or '없음/CPU'})")
    else:
        print(f"{WARN} torch 미설치 — GPU 진단이 제한됩니다")
        print(f"  {DIM}pip install torch --index-url https://download.pytorch.org/whl/cu124{RESET}")

    if not gpus:
        if smi_gpus:
            print(f"{WARN} nvidia-smi는 GPU를 보는데 torch가 못 씁니다 → CUDA 빌드 불일치")
        else:
            print(f"{WARN} 사용 가능한 GPU 없음 — CPU 전용 구성으로 진행합니다")
        return 0.0, ram

    total = 0.0
    for i, g in enumerate(gpus):
        cap = f"sm_{g.capability[0]}{g.capability[1]}" if g.capability else "?"
        print(f"{OK} GPU {i}: {g.name}  {g.vram_gb:.1f}GB  [{g.arch} / {cap}]")
        total = max(total, g.vram_gb)

        if g.needs_cu128:
            need = cuda_build and tuple(map(int, cuda_build.split("."))) >= (12, 8)
            mark = OK if need else FAIL
            print(f"  {mark} Blackwell — PyTorch 2.7+ / cu128 휠 필수")
            if not need:
                print(
                    f"    {DIM}pip install torch "
                    f"--index-url https://download.pytorch.org/whl/cu128{RESET}"
                )
        if g.capability:
            print(
                f"  {INFO} FP8 {'지원' if g.supports_fp8 else '미지원'}"
                f"{'' if g.supports_fp8 else ' — KV 캐시는 INT8 양자화 사용'}"
            )
    return total, ram


def check_packages() -> None:
    h("3. 패키지")
    required = [
        ("fastapi", "백엔드"),
        ("sqlalchemy", "DB"),
        ("pydantic", "스키마"),
        ("celery", "작업 큐"),
    ]
    optional = [
        ("transformers", "ASR/LLM — v5.13+ 필요 (Qwen3-ASR 네이티브 지원)"),
        ("pyannote.audio", "화자 분리 — v4.0+ (community-1)"),
        ("vllm", "LLM 서빙 + guided decoding"),
        ("soundfile", "오디오 IO"),
    ]

    for mod, why in required:
        try:
            __import__(mod.replace("-", "_").replace(".", "_") if mod != "pyannote.audio" else mod)
            print(f"{OK} {mod:16} {DIM}{why}{RESET}")
        except ImportError:
            print(f"{FAIL} {mod:16} {DIM}{why}{RESET}")

    print()
    for mod, why in optional:
        try:
            m = __import__(mod)
            ver = getattr(m, "__version__", "?")
            print(f"{OK} {mod:16} {ver:10} {DIM}{why}{RESET}")
        except ImportError:
            print(f"{INFO} {mod:16} {'미설치':10} {DIM}{why}{RESET}")


def check_external() -> None:
    h("4. 외부 도구")
    tools = [
        ("ffmpeg", "오디오 전처리 — 필수"),
        ("cloudflared", "HTTPS 터널 — 멀티트랙 녹음에 필수"),
        ("docker", "인프라 (postgres/redis)"),
        ("psql", "DB 클라이언트"),
    ]
    for cmd, why in tools:
        path = shutil.which(cmd)
        mark = OK if path else WARN
        print(f"{mark} {cmd:14} {DIM}{why}{RESET}")

    print()
    if os.environ.get("HF_TOKEN"):
        print(f"{OK} HF_TOKEN 설정됨 {DIM}(pyannote community-1은 gated){RESET}")
    else:
        print(f"{WARN} HF_TOKEN 없음 — pyannote community-1 다운로드 불가")
        print(f"  {DIM}huggingface.co 에서 모델 사용 동의 후 토큰 발급{RESET}")


def check_https_note() -> None:
    h("5. 멀티트랙 녹음 전제조건")
    print(f"{INFO} 브라우저 getUserMedia()는 보안 컨텍스트에서만 동작합니다.")
    print(f"  http://192.168.x.x 로는 {BOLD}마이크 권한 요청이 뜨지 않습니다{RESET}.")
    print()
    print(f"  {BOLD}확인 절차{RESET}")
    print(f"  1. {DIM}cloudflared tunnel --url http://localhost:3000{RESET}")
    print(f"  2. 출력된 https://xxx.trycloudflare.com 주소를 폰 2대로 접속")
    print(f"  3. 마이크 권한 팝업이 뜨는지 확인")
    print()
    print(f"  {DIM}여기서 막히면 docs/04 멀티트랙 설계 전체를 다시 짜야 합니다.{RESET}")


def main() -> int:
    print(f"{BOLD}TeamFlow AI — 환경 점검{RESET}")

    py_ok = check_python()
    vram, ram = check_hardware()
    check_packages()
    check_external()
    check_https_note()

    h("추천 구성")
    for line in recommend(vram, ram):
        print(line)

    print()
    print(f"{DIM}자세한 근거: docs/02-모델-선정과-VRAM-예산.md{RESET}")
    return 0 if py_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
