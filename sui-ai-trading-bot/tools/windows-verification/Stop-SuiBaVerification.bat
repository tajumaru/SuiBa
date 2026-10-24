@echo off
setlocal
title Stop SuiBa Verification
rem Stops ONLY the dedicated verification project recorded by the monitor.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Stop-SuiBaVerification.ps1" %*
echo.
pause
endlocal
