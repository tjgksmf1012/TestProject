@echo off
setlocal
cd /d "%~dp0"
title TeamFlow AI - Auto Recovery Live Server
echo Starting TeamFlow Watchdog (Auto-Recovery Supervisor)...
.\.venv\Scripts\python.exe -X utf8 scripts\watchdog.py
pause
