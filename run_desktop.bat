@echo off
cd /d "%~dp0"
setlocal

echo ============================================================
echo   TeamFlow AI - Desktop Shell (Electron) Launcher
echo ============================================================
echo.
echo [1/2] Connecting to local server: http://127.0.0.1:8811/app/
echo       * Note: Please make sure 'run_demo.bat' is running in another window!
echo.
echo [2/2] Launching Electron desktop app...
echo.

set TEAMFLOW_SERVER_URL=http://127.0.0.1:8811/app/
call npm.cmd --prefix frontend run desktop

if errorlevel 1 (
    echo.
    echo [ERROR] Failed to start desktop app.
)

pause
endlocal
