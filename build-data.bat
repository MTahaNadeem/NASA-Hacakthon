@echo off
REM Double-click to build all the real data (same as: python pipeline\run_all.py)
cd /d "%~dp0"
python pipeline\run_all.py
pause
