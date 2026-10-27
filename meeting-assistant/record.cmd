@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" -Recorder
set "meetingExit=%errorlevel%"
if not "%meetingExit%"=="0" pause
exit /b %meetingExit%
