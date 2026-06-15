# fb-server-watchdog.ps1
# Keeps the Facebook agent (node server.js on port 9317) alive AND responsive for 24/7 running.
#
# SAFE BY DESIGN:
#   * If port 9317 is not listening -> start node server.js.
#   * If it IS listening, probe GET / (HTTP, 10s). A wedged-but-listening event loop is the real failure mode.
#   * TOLERANT OF BUSY POSTING: a posting batch makes the event loop busy for ~10-20s, which used to trip the
#     old 2-quick-probe restart and KILL the run mid-post. Now a restart requires the server to be unresponsive
#     across $RESTART_AFTER_FAILS CONSECUTIVE watchdog runs (~3 minutes) — a brief posting blip recovers on the
#     next run and resets the counter, so it NEVER restarts a healthy-but-busy server during a post.
#   * When it must restart, it kills ONLY the process that owns port 9317, and ONLY after confirming that PID is
#     NOT the Pinterest agent's (port 59812 owner). It never touches any other process.
$ErrorActionPreference = 'SilentlyContinue'
$proj          = 'C:\Users\Administrator\Desktop\facbeook agent'
$node          = 'C:\Program Files\nodejs\node.exe'
$logFile       = Join-Path $proj 'data\server-watchdog.log'
$failFile      = Join-Path $proj 'data\watchdog-fail-count.txt'
$port          = 9317
$pinterestPort = 59812
$RESTART_AFTER_FAILS = 3   # consecutive failed watchdog runs (~3 min) before a restart -> survives posting blips

function Write-WatchdogLog($msg) {
  $line = "{0}`tserver_watchdog`t{1}" -f (Get-Date).ToString('o'), $msg
  Add-Content -Path $logFile -Value $line
}
function Get-PortOwnerPid($p) {
  try { return (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess } catch { return $null }
}
function Get-FailCount { if (Test-Path $failFile) { try { return [int]((Get-Content $failFile -ErrorAction SilentlyContinue) | Select-Object -First 1) } catch { return 0 } } return 0 }
function Set-FailCount($n) { Set-Content -Path $failFile -Value ([string]$n) }
function Clear-FailCount { Remove-Item $failFile -ErrorAction SilentlyContinue }
function Start-FbServer($reason) {
  $exe = $node
  if (-not (Test-Path $exe)) { $c = Get-Command node.exe -ErrorAction SilentlyContinue; if ($c) { $exe = $c.Source } }
  if ($exe -and (Test-Path $exe)) {
    # DATE-STAMP stderr so a crash's fatal line (esp. "JavaScript heap out of memory", which bypasses the in-process
    # crash.log handler) is PRESERVED instead of truncated by the restart. Keep the last 15 to bound disk.
    try { Get-ChildItem (Join-Path $proj 'data') -Filter 'server-stderr-*.log' -EA SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -Skip 15 | Remove-Item -Force -EA SilentlyContinue } catch {}
    $errLog = Join-Path $proj ("data\server-stderr-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Start-Process -FilePath $exe -ArgumentList 'server.js' -WorkingDirectory $proj -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $proj 'data\server-stdout.log') `
      -RedirectStandardError  $errLog
    Write-WatchdogLog ("action=restarted`treason={0}`tstderr={1}" -f $reason, (Split-Path $errLog -Leaf))
  } else {
    Write-WatchdogLog "action=skipped`treason=node_not_found"
  }
}
function Test-FbHealthy() {
  try {
    $r = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/" -f $port) -TimeoutSec 10 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

# 1) Not listening at all -> start it (and reset the failure counter).
if (-not (Get-PortOwnerPid $port)) { Clear-FailCount; Start-FbServer 'port_9317_not_listening'; return }

# 2) Listening -> must also RESPOND. Two in-run probes (4s apart). Healthy -> reset counter + done.
if (Test-FbHealthy) { Clear-FailCount; return }
Start-Sleep -Seconds 4
if (Test-FbHealthy) { Clear-FailCount; return }

# 3) Unresponsive THIS run. Only restart after $RESTART_AFTER_FAILS consecutive failed runs (a posting batch
#    busies the loop for ~10-20s -> at most ONE failed run -> recovers next run -> counter resets, no restart).
$fails = (Get-FailCount) + 1
Set-FailCount $fails
if ($fails -lt $RESTART_AFTER_FAILS) { Write-WatchdogLog ("action=unhealthy_tolerating`tfails={0}/{1}" -f $fails, $RESTART_AFTER_FAILS); return }

# 3b) ALIVE-BUT-BUSY GUARD (operator 2026-06-15): a CPU-saturated run can make GET / time out for several checks even
#     while the server is WORKING — that is what got it killed + auto-resume-looped (4x). If events.log was written in
#     the last ~120s, the Node event loop IS alive (just CPU-starved on the HTTP probe) -> do NOT kill; tolerate + reset.
#     Only a TRULY frozen server (no event-log activity for >120s) falls through to the restart below.
$evLog = Join-Path $proj 'data\events.log'
$evFresh = $false
try { if (Test-Path $evLog) { $evFresh = ((New-TimeSpan -Start (Get-Item $evLog).LastWriteTime -End (Get-Date)).TotalSeconds -lt 120) } } catch {}
if ($evFresh) { Write-WatchdogLog ("action=tolerating_alive_busy`treason=events_log_fresh_not_frozen`tfails={0}" -f $fails); Clear-FailCount; return }

# 4) Sustained unresponsiveness AND no recent event-log activity (TRULY frozen) -> restart ONLY the 9317 owner.
$owner = Get-PortOwnerPid $port
$pin   = Get-PortOwnerPid $pinterestPort
if ($owner -and $owner -ne $pin) {
  Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
  Write-WatchdogLog ("action=killed_unresponsive`tpid={0}`tafter_fails={1}" -f $owner, $fails)
  Start-Sleep -Seconds 2
  Start-FbServer 'unresponsive_health_check'
  Clear-FailCount
} else {
  Write-WatchdogLog ("action=skipped_kill`treason=owner_missing_or_equals_pinterest`towner={0}`tpinterest={1}" -f $owner, $pin)
  Clear-FailCount
}
