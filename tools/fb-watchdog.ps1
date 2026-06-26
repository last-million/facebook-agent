# FB Agent watchdog — keeps `node server.js` alive. Runs every ~1 min via the "FacebookAgentWatchdog" task
# (user session, so ixBrowser stays reachable). On a restart, the server's detectIncompleteRunAtBoot +
# autopilotAutoResumeEnabled=true auto-continues the SAME run from where it stopped (same autopilotRunId ->
# no double-posting; crash-loop-capped). 2026-06-25.
#
# Logic (robust against orphan node procs + busy servers):
#   - HTTP 200 on 9317  -> healthy: reset miss-counter, KILL any orphan server.js node (not the port owner), exit.
#   - HTTP down + port NOT owned (process crashed/dead) -> clean restart immediately.
#   - HTTP down + port IS owned (alive but slow/wedged) -> count misses; only force-restart after 3 consecutive
#     (~3 min) so a momentarily-busy server during a heavy run is NOT killed.
$ErrorActionPreference = 'SilentlyContinue'
$proj     = 'C:\Users\Administrator\Desktop\facbeook agent'
$node     = 'C:\Program Files\nodejs\node.exe'
$log      = Join-Path $proj 'fb-watchdog.log'
$missFile = Join-Path $proj 'fb-watchdog-misses.txt'

function Get-ServerJsProcs { Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'server\.js' } }
function Get-PortOwner { (Get-NetTCPConnection -LocalPort 9317 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess }
function Kill-Procs($procs) { foreach ($p in $procs) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} } }

# 1) Healthy?
$up = $false
try { if ((Invoke-WebRequest -Uri 'http://127.0.0.1:9317/' -UseBasicParsing -TimeoutSec 10).StatusCode -eq 200) { $up = $true } } catch {}
if ($up) {
  Set-Content -Path $missFile -Value '0'
  $owner = Get-PortOwner
  if ($owner) { Kill-Procs (Get-ServerJsProcs | Where-Object { $_.ProcessId -ne $owner }) } # remove orphan duplicates
  exit 0
}

# 2) Down. Is the port owned (alive-but-slow) or not (crashed)?
$owner = Get-PortOwner
if ($owner) {
  $misses = 0; if (Test-Path $missFile) { $misses = [int]((Get-Content $missFile -ErrorAction SilentlyContinue) -as [int]) }
  $misses++
  Set-Content -Path $missFile -Value "$misses"
  if ($misses -lt 3) { exit 0 }   # busy/slow, not dead — wait (avoid killing a server mid-run)
  $reason = "wedged_${misses}_misses"
} else {
  $reason = "crashed_port_free"
}

# 3) Restart cleanly: kill ALL server.js node (clears orphans / a wedged proc), then start ONE fresh.
Kill-Procs (Get-ServerJsProcs)
Start-Sleep -Seconds 2
$out = Join-Path $proj 'server-stdout.log'
$err = Join-Path $proj 'server-stderr.log'
Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $proj -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
Set-Content -Path $missFile -Value '0'
Add-Content -Path $log -Value ("{0}  watchdog: server DOWN ({1}) -> restarted node server.js" -f (Get-Date).ToString('s'), $reason)
exit 0
