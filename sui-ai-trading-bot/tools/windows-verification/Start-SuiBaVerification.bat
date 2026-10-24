@echo off
setlocal
title SuiBa Windows Verification
rem SuiBa unattended Docker verification (PAPER, stopped-state observation).
rem No AI agent is contacted while this runs.
rem Default menu choice is 30 minutes; completed is not a quality PASS.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Invoke-SuiBaVerification.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" echo Verification finished. See the run folder under tools\windows-verification\runs for reports.
if "%RC%"=="2" echo Verification was stopped by a safety condition. See the run reports for details.
if not "%RC%"=="0" if not "%RC%"=="2" echo Verification ended with an error (code %RC%). See the run folder logs.
pause
endlocal
