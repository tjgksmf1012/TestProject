#!/usr/bin/env python3
"""TeamFlow AI - 자동 복구 및 항시 가동 워치독(Watchdog).

기능:
1. 백엔드 서버(FastAPI/Uvicorn) 및 Cloudflare Tunnel 상시 감시
2. 프로세스가 강제 종료되거나 충돌하면 즉시 자동 감지 및 재시작
3. 서버가 살아있으나 응답이 멈춘 상태(Deadlock/Hang) 감지 시 자동 복구
4. Ctrl+C 종료 시 자식 프로세스들까지 깔끔하게 정리
"""

from __future__ import annotations

import datetime
import argparse
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# UTF-8 출력 보장
try:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[1]
VENV_PYTHON = ROOT / ".venv" / "Scripts" / "python.exe"
if not VENV_PYTHON.exists():
    VENV_PYTHON = ROOT / ".venv" / "bin" / "python"

# 색상 토큰
C_RESET = "\033[0m"
C_BOLD = "\033[1m"
C_GREEN = "\033[32m"
C_YELLOW = "\033[33m"
C_RED = "\033[31m"
C_CYAN = "\033[36m"
C_GRAY = "\033[90m"


def log(level: str, msg: str) -> None:
    now = datetime.datetime.now().strftime("%H:%M:%S")
    color = C_GREEN if level == "OK" else (C_YELLOW if level == "WARN" else (C_RED if level == "ERR" else C_CYAN))
    print(f"{C_GRAY}[{now}]{C_RESET} {color}[{level}]{C_RESET} {msg}", flush=True)


def free_port(port: int = 8811) -> None:
    """남의 프로세스를 죽이지 않고 중복 기동을 알려 줍니다."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
        if connection.connect_ex(("127.0.0.1", port)) == 0:
            raise RuntimeError(f"포트 {port}가 사용 중입니다. 기존 서버를 확인해 주세요")


def check_health(url: str = "http://127.0.0.1:8811/health", timeout: float = 4.0) -> bool:
    """서버가 정상 응답하는지 확인합니다."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "TeamFlowWatchdog/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def stop_process(proc: subprocess.Popen) -> None:
    """Windows venv 실행기가 만든 실제 Python 자식도 함께 종료합니다."""
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            capture_output=True, check=False,
        )
    else:
        proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-tunnel", action="store_true", help="로컬 서버와 워커만 실행")
    args = parser.parse_args()
    print(f"\n{C_BOLD}{C_CYAN}==================================================================={C_RESET}")
    print(f"{C_BOLD}{C_CYAN}    TeamFlow AI - 자동 복구 및 무중단 가동 워치독(Watchdog)        {C_RESET}")
    print(f"{C_BOLD}{C_CYAN}==================================================================={C_RESET}")
    print(f" * 접속 주소 (모바일/PC) : {C_BOLD}https://teamflow-ai.stream/app{C_RESET}")
    print(f" * 로컬 개발 주소        : http://127.0.0.1:8811/app")
    print(f" * 감시 대상             : Backend Server(8811) + Cloudflare Tunnel")
    print(f" * 상태 정책             : 비정상 종료 / 응답 지연 발생 시 즉각 자동 복구")
    print(f"{C_GRAY}종료하려면 Ctrl+C 를 누르세요.{C_RESET}\n")

    free_port(8811)

    # DB 확인
    if not (ROOT / "demo.db").exists():
        log("WARN", "demo.db 가 없어 깨끗한 초기 워크스페이스를 생성합니다...")
        subprocess.run([str(VENV_PYTHON), "-X", "utf8", "scripts/init_clean_db.py"], cwd=ROOT, check=True)

    env = os.environ.copy()
    env["DATABASE_URL"] = "sqlite:///./demo.db"
    env["TEAMFLOW_DB_URL"] = "sqlite:///./demo.db"
    env["PYTHONPATH"] = "backend"
    env["PYTHONUTF8"] = "1"
    env["DEBUG"] = "false"
    env["LOCAL_PROCESSING"] = "true"

    backend_proc: subprocess.Popen | None = None
    tunnel_proc: subprocess.Popen | None = None
    maintenance_proc: subprocess.Popen | None = None
    worker_proc: subprocess.Popen | None = None
    github_proc: subprocess.Popen | None = None
    health_failures = 0

    def start_backend() -> subprocess.Popen:
        log("OK", "백엔드 서버(FastAPI/Uvicorn) 시작 중...")
        cmd = [
            str(VENV_PYTHON),
            "-X",
            "utf8",
            "-m",
            "uvicorn",
            "teamflow.api.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            "8811",
        ]
        proc = subprocess.Popen(cmd, cwd=ROOT, env=env)
        log("OK", f"백엔드 서버 기동 완료 (PID: {proc.pid})")
        return proc

    def start_tunnel() -> subprocess.Popen:
        log("OK", "Cloudflare Tunnel(https://teamflow-ai.stream) 시작 중...")
        cmd = ["cloudflared", "tunnel", "run", "teamflow"]
        proc = subprocess.Popen(cmd, cwd=ROOT)
        log("OK", f"Cloudflare Tunnel 기동 완료 (PID: {proc.pid})")
        return proc

    def start_maintenance() -> subprocess.Popen:
        log("OK", "보존기간 삭제·성문 폐기·알림 점검을 시작합니다")
        return subprocess.Popen(
            [str(VENV_PYTHON), "-m", "teamflow.jobs.local_maintenance"], cwd=ROOT, env=env,
        )

    def start_worker() -> subprocess.Popen:
        log("OK", "서버와 분리된 회의 처리 워커를 시작합니다")
        return subprocess.Popen(
            [str(VENV_PYTHON), "-m", "teamflow.jobs.local_worker"], cwd=ROOT, env=env,
        )

    def shutdown(signum=None, frame=None):
        print(f"\n{C_YELLOW}[!] 워치독 종료 신호를 수신했습니다. 프로세스들을 안전하게 정리합니다...{C_RESET}")
        for p, name in [(backend_proc, "백엔드"), (tunnel_proc, "터널"), (maintenance_proc, "유지보수"), (worker_proc, "회의 워커"), (github_proc, "GitHub 워커")]:
            if p and p.poll() is None:
                stop_process(p)
        log("OK", "모든 서비스가 안전하게 종료되었습니다.")
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    # 1. 초기 가동
    backend_proc = start_backend()
    time.sleep(2)
    tunnel_proc = None if args.no_tunnel else start_tunnel()
    maintenance_proc = start_maintenance()
    worker_proc = start_worker()
    github_proc = subprocess.Popen(
        [str(VENV_PYTHON), "-m", "teamflow.jobs.local_github"], cwd=ROOT, env=env,
    )

    last_health_check = time.time()

    # 2. 감시 루프
    try:
        while True:
            time.sleep(3)

            # A. 백엔드 종료 감지
            if backend_proc is None or backend_proc.poll() is not None:
                code = backend_proc.poll() if backend_proc else "None"
                log("ERR", f"백엔드 프로세스 비정상 종료 감지! (종료코드: {code})")
                log("WARN", "2초 후 백엔드 서버를 자동으로 다시 기동합니다...")
                time.sleep(2)
                backend_proc = start_backend()
                health_failures = 0

            # B. 터널 종료 감지
            if not args.no_tunnel and (tunnel_proc is None or tunnel_proc.poll() is not None):
                code = tunnel_proc.poll() if tunnel_proc else "None"
                log("ERR", f"Cloudflare 터널 비정상 종료 감지! (종료코드: {code})")
                log("WARN", "2초 후 터널을 자동으로 다시 기동합니다...")
                time.sleep(2)
                tunnel_proc = start_tunnel()

            if maintenance_proc is None or maintenance_proc.poll() is not None:
                log("WARN", "유지보수 실행기를 다시 시작합니다")
                maintenance_proc = start_maintenance()

            if worker_proc is None or worker_proc.poll() is not None:
                log("WARN", "회의 처리 워커를 다시 시작합니다")
                worker_proc = start_worker()

            if github_proc is None or github_proc.poll() is not None:
                log("WARN", "GitHub 수집 워커를 다시 시작합니다")
                github_proc = subprocess.Popen(
                    [str(VENV_PYTHON), "-m", "teamflow.jobs.local_github"], cwd=ROOT, env=env,
                )

            # C. 응답 상태(Health Check) 감시 (12초 주기)
            if time.time() - last_health_check >= 12:
                last_health_check = time.time()
                is_healthy = check_health()
                if is_healthy:
                    health_failures = 0
                else:
                    health_failures += 1
                    log("WARN", f"서버 무응답 감지 ({health_failures}/3 회)")
                    if health_failures >= 3:
                        log("ERR", "서버가 3회 연속 무응답(Freeze/Deadlock) 상태입니다! 프로세스를 강제 재시작합니다.")
                        try:
                            stop_process(backend_proc)
                        except Exception:
                            pass
                        backend_proc = start_backend()
                        health_failures = 0

    except KeyboardInterrupt:
        shutdown()


if __name__ == "__main__":
    main()
