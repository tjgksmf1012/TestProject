@echo off
cd /d "%~dp0"
setlocal

echo ====================================================================
echo   TeamFlow AI - GitHub Anti-Gaming Demo Launcher
echo ====================================================================
echo.

set ROOT=%~dp0
set VENV_PYTHON=%ROOT%.venv\Scripts\python.exe

if not exist "%VENV_PYTHON%" (
    echo [ERROR] Python environment (%VENV_PYTHON%) not found.
    pause
    exit /b 1
)

echo [*] Injecting GitHub events and calculating Anti-Gaming defense...
echo.
"%VENV_PYTHON%" -X utf8 "%ROOT%scripts\run_github_demo.py" --reset

echo.
echo ====================================================================
echo View results in browser:
echo   Contributions: http://127.0.0.1:8811/app/project/1/contributions
echo ====================================================================
choice /m "Open contributions page in browser?"
if errorlevel 2 goto done
if errorlevel 1 start http://127.0.0.1:8811/app/project/1/contributions

:done
echo.
echo Demo completed.
pause
endlocal
