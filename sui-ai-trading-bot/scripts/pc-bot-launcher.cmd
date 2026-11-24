@echo off
rem POTARIO PC Bot launcher for Task Scheduler (runs with no window).
rem Starts the bot and appends all output to data\logs\bot-console.log.
setlocal
cd /d "%~dp0.."
if not exist "data\logs" mkdir "data\logs"
call pnpm dev >> "data\logs\bot-console.log" 2>&1
endlocal
