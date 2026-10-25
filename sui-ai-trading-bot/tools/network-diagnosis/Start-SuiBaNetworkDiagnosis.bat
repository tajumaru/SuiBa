@echo off
setlocal
title SuiBa 30 minute read-only network diagnosis
where pwsh.exe >nul 2>&1
if errorlevel 1 (
  echo PowerShell 7 is required. Install it and run this file again.
  pause
  exit /b 1
)
if /I "%~1"=="--plan" goto plan
if not "%~1"=="" (
  echo Usage: Start-SuiBaNetworkDiagnosis.bat [--plan]
  exit /b 2
)
rem Double-clicking this BAT is the explicit manual live-diagnosis action.
rem Override the Node executable with SUIBA_DIAGNOSTIC_NODE if needed.
if not defined SUIBA_DIAGNOSTIC_NODE (
  set "SUIBA_DIAGNOSTIC_NODE=node"
  if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "SUIBA_DIAGNOSTIC_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)
echo Starting a read-only diagnosis for up to 30 minutes. No trading.
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Invoke-NetworkDiagnosis.ps1" -ExecuteLive -NodePath "%SUIBA_DIAGNOSTIC_NODE%"
set "RC=%ERRORLEVEL%"
echo.
echo Diagnosis exited with code %RC%. Check the reports under:
echo %~dp0results
echo A zero exit code alone does not mean evidenceComplete or a quality PASS.
pause
endlocal & exit /b %RC%

:plan
rem No live flag, no Node selection, no Docker invocation, no pause.
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Invoke-NetworkDiagnosis.ps1"
exit /b %ERRORLEVEL%
