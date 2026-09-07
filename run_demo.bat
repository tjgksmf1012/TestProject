@echo off
cd /d "%~dp0"
setlocal

echo ============================================================
echo   TeamFlow AI - Local Server Launcher
echo ============================================================
echo.

if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] .venv was not found in this directory.
    pause
    exit /b 1
)

.venv\Scripts\python.exe -X utf8 scripts\run_app.py

endlocal
pause
