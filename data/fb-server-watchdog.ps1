# fb-server-watchdog.ps1
# Keeps the Facebook agent (node server.js on port 9317) alive AND responsive for 24/7 running.
#
# SAFE BY DESIGN:
#   * If port 9317 is not listening -> start node server.js (as before).
#   * If it IS listening, probe GET / (HTTP). A wedged-but-listening event loop (CPU spin /
#     saturation) is the real failure mode the old port-only check could never heal.
#   * Only restarts after TWO consecutive failed probes (a 4s apart re-check) so a single
#     transient slow moment never triggers a restart.
#   * When it must restart, it kills ONLY the process that currently owns port 9317, and ONLY
#     after confirming that PID is NOT the Pinterest agent's (port 59812 owner). It never touches
#     any other process.
$ErrorActionPreference = 'SilentlyContinue'
$proj          = 'C:\Users\Administrator\Desktop\facbeook agent'
$node          = 'C:\Program Files\nodejs\node.exe'
$logFile       = Join-Path $proj 'data\server-watchdog.log'
$port          = 9317
$pinterestPort = 59812

function Write-WatchdogLog($msg) {
  $line = "{0}`tserver_watchdog`t{1}" -f (Get-Date).ToString('o'), $msg
  Add-Content -Path $logFile -Value $line
}

function Get-PortOwnerPid($p) {
  try { return (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess } catch { return $null }
}

function Start-FbServer($reason) {
  $exe = $node
  if (-not (Test-Path $exe)) { $c = Get-Command node.exe -ErrorAction SilentlyContinue; if ($c) { $exe = $c.Source } }
  if ($exe -and (Test-Path $exe)) {
    Start-Process -FilePath $exe -ArgumentList 'server.js' -WorkingDirectory $proj -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $proj 'data\server-stdout.log') `
      -RedirectStandardError  (Join-Path $proj 'data\server-stderr.log')
    Write-WatchdogLog ("action=restarted`treason={0}" -f $reason)
  } else {
    Write-WatchdogLog "action=skipped`treason=node_not_found"
  }
}

function Test-FbHealthy() {
  try {
    $r = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/" -f $port) -TimeoutSec 6 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

# 1) Not listening at all -> start it.
if (-not (Get-PortOwnerPid $port)) {
  Start-FbServer 'port_9317_not_listening'
  return
}

# 2) Listening -> must also RESPOND. Two consecutive failures (4s apart) => wedged.
if (Test-FbHealthy) { return }
Start-Sleep -Seconds 4
if (Test-FbHealthy) { return }

# 3) Wedged. Restart ONLY the 9317 owner, and never the Pinterest agent.
$owner = Get-PortOwnerPid $port
$pin   = Get-PortOwnerPid $pinterestPort
if ($owner -and $owner -ne $pin) {
  Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
  Write-WatchdogLog ("action=killed_unresponsive`tpid={0}" -f $owner)
  Start-Sleep -Seconds 2
  Start-FbServer 'unresponsive_health_check'
} else {
  Write-WatchdogLog ("action=skipped_kill`treason=owner_missing_or_equals_pinterest`towner={0}`tpinterest={1}" -f $owner, $pin)
}
