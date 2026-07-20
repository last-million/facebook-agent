# FB Agent watchdog — keeps the FB server (port 9317) alive. Runs every ~1 min via the "FacebookAgentWatchdog" task
# (user session). On a restart, detectIncompleteRunAtBoot + autopilotAutoResumeEnabled=true auto-continues the SAME run.
#
# CRITICAL (2026-06-26): the FB server is identified STRICTLY by PORT 9317 ownership — NEVER by a 'server.js' command-line
# match. A broad 'server.js' match also hits the co-resident PINTEREST agent (server.js on port 59812) and the Pinterest
# thumb-server.js, and killing those (NSSM restarts them) caused churn + a false "orphan" chase. This watchdog only ever
# touches the process that owns port 9317. The FB server's own EADDRINUSE handler prevents duplicate FB instances.
$ErrorActionPreference = 'SilentlyContinue'
$proj     = 'C:\Users\Administrator\Desktop\facbeook agent'
$node     = 'C:\Program Files\nodejs\node.exe'
$log      = Join-Path $proj 'fb-watchdog.log'
$missFile = Join-Path $proj 'fb-watchdog-misses.txt'

function Get-Port9317Owner { (Get-NetTCPConnection -LocalPort 9317 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess }

# 1) Healthy?
$up = $false
try { if ((Invoke-WebRequest -Uri 'http://127.0.0.1:9317/' -UseBasicParsing -TimeoutSec 10).StatusCode -eq 200) { $up = $true } } catch {}
if ($up) { Set-Content -Path $missFile -Value '0'; exit 0 }   # healthy -> do NOTHING else (never touch other node procs / Pinterest)

# 2) Down. Is port 9317 owned (FB server alive-but-slow) or free (crashed)?
$owner = Get-Port9317Owner
if ($owner) {
  $misses = 0; if (Test-Path $missFile) { $misses = [int]((Get-Content $missFile -ErrorAction SilentlyContinue) -as [int]) }
  $misses++
  Set-Content -Path $missFile -Value "$misses"
  if ($misses -lt 3) { exit 0 }                 # busy/slow during a heavy run, not dead — wait (avoid killing mid-run)
  try { Stop-Process -Id $owner -Force } catch {}  # wedged ~3 min -> kill ONLY the FB port-9317 owner
  Start-Sleep -Seconds 2
  $reason = "wedged_${misses}_misses"
} else {
  $reason = "crashed_port_free"
}

# 3) Start ONE FB server (its EADDRINUSE handler makes it exit if 9317 is actually taken -> never a duplicate).
# STDERR/STDOUT (2026-07-20 fix, live incident): fixed filenames here used to get TRUNCATED (not appended) by
# Start-Process on every single restart -- PowerShell's redirect behaves like shell `>`, not `>>` -- so a fatal
# V8 line (e.g. "JavaScript heap out of memory", which bypasses server.js's own uncaughtException/unhandledRejection
# handler entirely) was destroyed before anyone could read it on every one of today's several restarts. Timestamp
# the filenames per restart (matching the already-proven pattern in data\fb-server-watchdog.ps1) so the NEXT crash's
# fatal output survives; prune to the last 15 to bound disk.
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outLog = Join-Path $proj "data\server-stdout-$stamp.log"
$errLog = Join-Path $proj "data\server-stderr-$stamp.log"
try {
  Get-ChildItem -Path (Join-Path $proj 'data') -Filter 'server-stdout-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -Skip 15 | Remove-Item -Force -ErrorAction SilentlyContinue
  Get-ChildItem -Path (Join-Path $proj 'data') -Filter 'server-stderr-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -Skip 15 | Remove-Item -Force -ErrorAction SilentlyContinue
} catch {}
Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $proj -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
Set-Content -Path $missFile -Value '0'
Add-Content -Path $log -Value ("{0}  watchdog: FB server (port 9317) DOWN ({1}) -> restarted (stderr: {2})" -f (Get-Date).ToString('s'), $reason, (Split-Path $errLog -Leaf))
exit 0
