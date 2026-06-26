# FB Agent watchdog — restarts `node server.js` if the server process has died (crash / OOM / OS kill).
# Runs every ~1 min via the "FacebookAgentWatchdog" scheduled task (user session, so ixBrowser stays reachable).
# On restart, the server's detectIncompleteRunAtBoot + autopilotAutoResumeEnabled=true auto-continues the SAME run
# from where it stopped (same autopilotRunId -> no double-posting; crash-loop-capped). 2026-06-25.
$ErrorActionPreference = 'SilentlyContinue'
$proj = 'C:\Users\Administrator\Desktop\facbeook agent'
$node = 'C:\Program Files\nodejs\node.exe'
$log  = Join-Path $proj 'fb-watchdog.log'

# 1) Is the server responding on 9317?
$up = $false
try { if ((Invoke-WebRequest -Uri 'http://127.0.0.1:9317/' -UseBasicParsing -TimeoutSec 8).StatusCode -eq 200) { $up = $true } } catch {}
if ($up) { exit 0 }

# 2) Not responding — but is a `node server.js` process still alive (just slow to answer)? If so, don't double-start;
#    a transient slow response or the server's own internal watchdog handles it. Only a DEAD process is restarted.
$proc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'server\.js' } | Select-Object -First 1
if ($proc) { exit 0 }

# 3) Dead -> restart it exactly the way it is run manually (hidden, log redirects).
$out = Join-Path $proj 'server-stdout.log'
$err = Join-Path $proj 'server-stderr.log'
Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $proj -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
Add-Content -Path $log -Value ("{0}  watchdog: server was DOWN -> restarted node server.js" -f (Get-Date).ToString('s'))
exit 0
