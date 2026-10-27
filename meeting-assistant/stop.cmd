@echo off
setlocal
cd /d "%~dp0"
echo Export your meeting log before exiting. Unsaved meeting records will be lost.
echo To pause only, use Stop Session on the webpage instead.
choice /C NY /N /M "Exit the background service? [N/Y]: "
if errorlevel 3 exit /b 1
if errorlevel 2 goto stopService
exit /b 0
:stopService
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" -StopService -NoBrowser
set "meetingExit=%errorlevel%"
if not "%meetingExit%"=="0" pause
exit /b %meetingExit%
