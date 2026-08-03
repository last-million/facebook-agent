@echo off
REM ============================================================================
REM  Facebook Agent - one-click deploy for a BRAND NEW Windows machine
REM
REM  Just DOUBLE-CLICK this file. It installs everything the agent needs, in
REM  order, skipping whatever is already there: Node.js -> Git (only if it has
REM  to download the project) -> project files -> npm deps -> data dir ->
REM  keep-alive watchdog -> WSL+Ubuntu -> the Hermes agent inside WSL.
REM
REM  From a command prompt you can also run:
REM      deploy.bat            install everything that is missing
REM      deploy.bat /check     report what is missing, install NOTHING
REM
REM  Works both ways:
REM    - a ZIP you downloaded / a copy on a USB stick -> installs IN PLACE, no
REM      Git needed, nothing is cloned;
REM    - a git clone -> same thing, run it from inside the clone.
REM
REM  Safe to run again as many times as you like. On a bare machine WSL needs one
REM  reboot; the script says so, and you simply run this again afterwards.
REM
REM  THE WINDOW MUST NEVER JUST VANISH. Every exit path below pauses. An earlier
REM  version returned `exit /b 0` with no pause on the "not administrator" branch,
REM  so a double-click closed instantly and appeared to do nothing at all - while
REM  the elevated window it tried to open was itself failing on a mangled path.
REM ============================================================================
setlocal EnableExtensions

set "HERE=%~dp0"
set "PS1=%HERE%bootstrap.ps1"
set "MODE=%~1"

echo.
echo  Facebook Agent - deploy
echo  ----------------------------------------------------------------
echo.

if not exist "%PS1%" (
  echo  ERROR: cannot find:
  echo         %PS1%
  echo.
  echo  Run this from inside the project's deployment\ folder - the whole
  echo  folder must be extracted, not just this one file.
  echo.
  pause
  exit /b 1
)

REM --- PowerShell must exist (it is the actual installer) ----------------------
where powershell >nul 2>nul
if errorlevel 1 (
  echo  ERROR: Windows PowerShell was not found on this machine.
  echo         It ships with Windows; if it is missing or blocked by policy,
  echo         this installer cannot run.
  echo.
  pause
  exit /b 1
)

REM --- /check just reports, so it never needs Administrator --------------------
REM  The batch-side flag is /check (what a Windows user expects); the PowerShell
REM  script's own switch is -CheckOnly. Translate here rather than making the
REM  user remember two spellings.
set "PSARGS="
if /I "%MODE%"=="/check"  ( set "PSARGS=-CheckOnly" & goto :run )
if /I "%MODE%"=="-check"  ( set "PSARGS=-CheckOnly" & goto :run )
if /I "%MODE%"=="--check" ( set "PSARGS=-CheckOnly" & goto :run )

REM --- Re-launch ELEVATED if we are not already Administrator ------------------
REM  Relaunches THIS .bat (%~f0), not bootstrap.ps1 directly. Passing a quoted
REM  path through cmd -> powershell -Command -> Start-Process -ArgumentList is a
REM  quoting minefield, and the previous version lost to it: it produced a
REM  -File argument of \"C:\...\bootstrap.ps1\" - backslashes and all - which
REM  does not name any real file, so the elevated window died on the spot.
REM  Re-launching the .bat needs only ONE level of quoting and cannot mangle it.
net session >nul 2>nul
if not errorlevel 1 goto :run

echo  This needs Administrator rights (installers + scheduled tasks).
echo  A new elevated window will open - continue in THAT window.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Start-Process -FilePath '%~f0' -Verb RunAs -ErrorAction Stop } catch { exit 1 }"
if errorlevel 1 (
  echo  Elevation was cancelled or blocked, so nothing was installed.
  echo.
  echo  Right-click "deploy.bat" and choose "Run as administrator".
  echo.
  pause
  exit /b 1
)
echo  Elevated window opened. You can close this one.
echo.
pause
exit /b 0

:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %PSARGS%
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo  Finished.
) else (
  echo  Finished with exit code %RC% - see the messages above.
)
echo.
pause
exit /b %RC%
