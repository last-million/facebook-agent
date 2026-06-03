# fb-server-watchdog.ps1
# Keeps the Facebook agent (node server.js on port 9317) alive for unattended 24/7 running.
#
# SAFE BY DESIGN:
#   * It ONLY checks whether port 9317 is listening and STARTS node server.js if it is not.
#   * It NEVER kills, stops, or signals any process.
#   * It NEVER touches the separate Pinterest agent on port 59812 (or anything else) —
#     starting node in the FB project dir affects only the FB agent, and if the port is
#     already held the new node simply fails to bind and exits (no harm).
$ErrorActionPreference = 'SilentlyContinue'
$proj    = 'C:\Users\Administrator\Desktop\facbeook agent'
$node    = 'C:\Program Files\nodejs\node.exe'
$logFile = Join-Path $proj 'data\server-watchdog.log'
$now = Get-Date

$listening = $false
try { $listening = [bool](Get-NetTCPConnection -LocalPort 9317 -State Listen -ErrorAction SilentlyContinue) } catch {}

if (-not $listening) {
    if (-not (Test-Path $node)) {
        $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($cmd) { $node = $cmd.Source }
    }
    if ($node -and (Test-Path $node)) {
        Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $proj -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $proj 'data\server-stdout.log') `
            -RedirectStandardError  (Join-Path $proj 'data\server-stderr.log')
        $line = "{0}`tserver_watchdog`taction=restarted`treason=port_9317_not_listening" -f $now.ToString('o')
        Add-Content -Path $logFile -Value $line
    } else {
        $line = "{0}`tserver_watchdog`taction=skipped`treason=node_not_found" -f $now.ToString('o')
        Add-Content -Path $logFile -Value $line
    }
}
