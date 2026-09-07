#!/usr/bin/env python3
"""TeamFlow AI 원클릭 로컬 서버 기동 런처.

사용법:
    .venv\\Scripts\\python -X utf8 scripts/run_app.py
"""

from __future__ import annotations

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENV_PYTHON = ROOT / ".venv" / "Scripts" / "python.exe"

if not VENV_PYTHON.exists():
    VENV_PYTHON = ROOT / ".venv" / "bin" / "python"


def main():
    print("=" * 60)
    print("TeamFlow AI — 로컬 통합 개발 서버 런처")
    print("=" * 60)

    # 1. DB 파일 존재 확인 (없으면 시드 실행)
    db_path = ROOT / "demo.db"
    if not db_path.exists():
        print("[*] demo.db 가 없어 시연 데이터를 초기화합니다...")
        subprocess.run(
            [str(VENV_PYTHON), "-X", "utf8", "scripts/seed_demo.py"],
            cwd=ROOT,
            check=True,
        )

    print("\n[*] 서버를 기동합니다...")
    print("• 모던 리디자인 SPA : http://127.0.0.1:8811/app/")
    print("• 시연 계정 로그인  : http://127.0.0.1:8811/login.html")
    print("  (계정: minsu@example.com / 암호: teamflow-demo)")
    print("• AI E2E 검토 화면  : http://127.0.0.1:8811/app/meeting/6/review")
    print("=" * 60)
    print("서버를 종료하려면 Ctrl+C 를 누르세요.\n")

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
    try:
        subprocess.run(cmd, cwd=ROOT)
    except KeyboardInterrupt:
        print("\n[*] 서버가 종료되었습니다.")


if __name__ == "__main__":
    main()
