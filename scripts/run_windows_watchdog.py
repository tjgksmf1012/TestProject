"""Windows 예약 작업으로 운영 서버와 워커를 실행합니다."""

from __future__ import annotations

import ctypes
import os
import subprocess
import time
import traceback
from ctypes import wintypes
from datetime import datetime
from pathlib import Path
from typing import BinaryIO

ROOT = Path(__file__).resolve().parents[1]
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000


class BasicLimitInformation(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class ExtendedLimitInformation(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", BasicLimitInformation),
        ("IoInfo", ctypes.c_uint64 * 6),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def contain_process_tree() -> None:
    """이 프로세스가 죽으면 모든 자식도 함께 정리합니다."""
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
    ]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.GetCurrentProcess.argtypes = []
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL

    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    limits = ExtendedLimitInformation()
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not kernel.SetInformationJobObject(
        job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ctypes.byref(limits), ctypes.sizeof(limits)
    ) or not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
        error = ctypes.get_last_error()
        kernel.CloseHandle(job)
        raise ctypes.WinError(error)
    # 자식은 이 핸들을 상속하지 않습니다. 실행기 종료 시 Windows가 마지막 핸들을 닫습니다.


def supervise_watchdog(command: list[str], log: BinaryIO) -> int:
    while True:
        result = subprocess.run(
            command,
            cwd=ROOT,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW,
            check=False,
        )
        # 정상 종료 또는 운영 DB 경로 오류는 예약 작업에 결과를 돌려줍니다.
        if result.returncode in {0, 78}:
            return result.returncode
        message = f"워치독 종료(코드 {result.returncode}). 5초 뒤 다시 시작합니다.\n"
        log.write(message.encode("utf-8"))
        log.flush()
        time.sleep(5)


def main() -> int:
    log_root = Path(os.environ["LOCALAPPDATA"]) / "TeamFlow" / "logs"
    log_root.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    with (log_root / f"{stamp}-{os.getpid()}-scheduled.log").open("xb") as log:
        try:
            contain_process_tree()
            return supervise_watchdog(
                [
                    str(ROOT / ".venv" / "Scripts" / "python.exe"), "-X", "utf8",
                    str(ROOT / "scripts" / "watchdog.py"), "--no-tunnel", "--managed-windows",
                ],
                log,
            )
        except Exception:
            log.write(traceback.format_exc().encode("utf-8"))
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
