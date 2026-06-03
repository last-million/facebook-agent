@echo off
REM ============================================================
REM  Facebook Agent - Windows deploy (Node dashboard side)
REM  Run from an ADMIN Command Prompt on the new machine.
REM  Pair: deploy.sh installs the Hermes CLI inside WSL.
REM ============================================================
setlocal EnableExtensions
set "REPO_URL=https://github.com/last-million/facebook-agent.git"
set "TARGET=%USERPROFILE%\Desktop\facbeook agent"

echo [1/6] Checking Node.js...
where node >nul 2>nul || (echo   ERROR: Node.js not found. Install from https://nodejs.org and re-run. & exit /b 1)
node -v

echo [2/6] Cloning repo (if not already present)...
if not exist "%TARGET%\server.js" (
  where git >nul 2>nul || (echo   ERROR: git not found. Install Git for Windows and re-run. & exit /b 1)
  git clone "%REPO_URL%" "%TARGET%"
) else (
  echo   Repo already present at "%TARGET%"
)
cd /d "%TARGET%" || (echo   ERROR: cannot cd to "%TARGET%" & exit /b 1)

echo [3/6] Installing npm dependencies...
call npm install || (echo   ERROR: npm install failed & exit /b 1)

echo [4/6] Ensuring runtime data dir...
if not exist "data" mkdir "data"

echo [5/6] Registering keep-alive watchdog (SYSTEM, every 3 min)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p='%TARGET%'; $a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File \"'+$p+'\data\fb-server-watchdog.ps1\"'); $t=New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 3); $pr=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest; Register-ScheduledTask -TaskName 'FB-Server-Watchdog' -Action $a -Trigger $t -Principal $pr -Force | Out-Null; Write-Host '   watchdog registered'"

echo [6/6] Installing Hermes inside WSL...
where wsl >nul 2>nul && (
  wsl bash -lc "bash '%TARGET:\=/%/deployment/deploy.sh'"
) || (
  echo   WSL not found. Install it ^(wsl --install^) then run deployment/deploy.sh inside WSL.
)

echo.
echo ============================================================
echo  NEXT STEPS (manual, one-time):
echo   1^) node server.js   then open http://127.0.0.1:9317
echo   2^) Integrations tab: re-enter API keys + proxy creds (writes data\secrets.local.json)
echo   3^) ixBrowser: log into your FB posting profiles; keep wise/moderator/shopyourlikes reserved
echo   4^) Restore memory: copy claude-memory\*.md into your Claude memory folder (see SETUP.md step 9)
echo   5^) (optional) auto-sync to GitHub: see deployment\README.md
echo ============================================================
endlocal
