@echo off
REM ============================================================================
REM  Facebook Agent - one-click deploy for a BRAND NEW Windows machine
REM
REM  Installs everything the agent needs, in order, skipping whatever is already
REM  there: Node.js -> Git -> this repo -> npm deps -> data dir -> keep-alive
REM  watchdog -> WSL+Ubuntu -> the Hermes agent inside WSL.
REM
REM  Just double-click it (it will ask for Administrator), or run:
REM      deploy.bat            install everything that is missing
REM      deploy.bat /check     report what is missing, install NOTHING
REM
REM  Safe to run again as many times as you like. On a bare machine WSL needs one
REM  reboot - the script tells you, and you simply run it again afterwards.
REM
REM  WHY THIS IS A WRAPPER: the real work lives in deployment\bootstrap.ps1.
REM  The previous all-batch version silently failed at its last step because it
REM  handed WSL a Windows path ("C:/Users/.../deploy.sh"), which does not exist
REM  inside Linux - so Hermes was never installed on any machine it was used on.
REM  Batch also cannot reliably do HTTPS downloads, silent installers, scheduled
REM  tasks and WSL path conversion; PowerShell can, and can be tested.
REM ============================================================================
setlocal EnableExtensions

set "HERE=%~dp0"
set "PS1=%HERE%bootstrap.ps1"

if not exist "%PS1%" (
  echo ERROR: cannot find "%PS1%"
  echo        Run this from inside the repo's deployment\ folder.
  pause
  exit /b 1
)

REM --- /check just reports, so it never needs Administrator -------------------
if /I "%~1"=="/check" goto :check
if /I "%~1"=="-check" goto :check
if /I "%~1"=="--check" goto :check

REM --- Re-launch elevated if we are not already Administrator -----------------
net session >nul 2>nul
if errorlevel 1 (
  echo Requesting Administrator rights...
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-File','\"%PS1%\"'"
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%

:check
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -CheckOnly
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
