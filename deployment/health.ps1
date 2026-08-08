<#
==============================================================================
 Facebook Agent - health / monitor report  (READ-ONLY)
==============================================================================
 One command to see, on ANY machine running the agent, what state it is in:
 server up, armed or not, per-group config (profiles / comments / harvest
 sources), and today's ledger tallies.

 Run it from the repo:
     powershell -NoProfile -ExecutionPolicy Bypass -File deployment\health.ps1

 It NEVER writes anything - no state, no ledger, no config is touched. Safe to
 run at any time, including mid-run on live production. ASCII-only, BOM-less,
 for the same locale reason as bootstrap.ps1.
#>
[CmdletBinding()]
param([string]$Target = '', [int]$Port = 9317)

$ErrorActionPreference = 'SilentlyContinue'
function Line($m){ Write-Host $m }
function Head($m){ Write-Host ""; Write-Host ("== " + $m + " ==") -ForegroundColor Cyan }

# --- locate the repo (run-in-place, or the two default install spots) ---
if (-not $Target) {
  $selfRepo = Split-Path $PSScriptRoot -Parent
  if (Test-Path (Join-Path $selfRepo 'server.js')) { $Target = $selfRepo }
  elseif (Test-Path (Join-Path $env:USERPROFILE 'Desktop\facbeook agent\server.js')) { $Target = Join-Path $env:USERPROFILE 'Desktop\facbeook agent' }
  elseif (Test-Path (Join-Path $env:USERPROFILE 'Desktop\facebook-agent-main\server.js')) { $Target = Join-Path $env:USERPROFILE 'Desktop\facebook-agent-main' }
}
if (-not $Target -or -not (Test-Path (Join-Path $Target 'server.js'))) {
  Write-Host "Could not find the agent. Pass -Target <repo folder>." -ForegroundColor Red
  exit 1
}

Head "Machine"
Line ("  host      : " + $env:COMPUTERNAME)
Line ("  repo      : " + $Target)
Line ("  time (UTC): " + [DateTime]::UtcNow.ToString('yyyy-MM-dd HH:mm:ss'))

# --- is the server answering on its port? ---
Head "Server (port $Port)"
$owner = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
$up = $false
try { if ((Invoke-WebRequest -Uri ("http://127.0.0.1:$Port/") -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200) { $up = $true } } catch {}
if ($up) { Line ("  HTTP 200  OK (PID " + $owner + ")") } elseif ($owner) { Line ("  owned by PID " + $owner + " but not answering - may be starting or wedged") } else { Line "  NOT listening - server is down" }

# --- watchdog task present? ---
$wd = Get-ScheduledTask -TaskName 'FacebookAgentWatchdog' -ErrorAction SilentlyContinue
Line ("  watchdog  : " + $(if ($wd) { "installed (" + $wd.State + ")" } else { "NOT installed - a crash will not auto-restart" }))

# --- state file: armed + per-group config ---
$stateFile = Join-Path $Target 'data\workflow-state.json'
if (Test-Path $stateFile) {
  try { $s = Get-Content $stateFile -Raw | ConvertFrom-Json } catch { $s = $null }
  if ($s) {
    $op = $s.operator
    Head "Autopilot"
    Line ("  enabled        : " + $op.autopilotEnabled)
    Line ("  paused         : " + $op.paused)
    Line ("  commentsEnabled: " + $op.commentsEnabled + "   (master switch)")
    Line ("  groupFallback  : " + $op.groupFallbackEnabled)
    Line ("  maxPostsPerRun : " + $op.autopilotMaxPostsPerRun + "   postsThisRun: " + $op.autopilotPostsThisRun)

    Head "Groups (Step 3)"
    $gad = @($s.posting.groupAssignmentData)
    if ($gad.Count -eq 0) { Line "  none configured" }
    foreach ($g in $gad) {
      $tail = ($g.url -replace '.*/groups/','')
      $src  = @($g.sourceGroups)
      $srcTxt = if ($src.Count -eq 0) { "all sources" } else { ($src | ForEach-Object { $_ -replace '.*/groups/','' }) -join ', ' }
      Line ("  " + $tail.PadRight(20) + " profiles=" + (@($g.profiles).Count) + "  comments=" + $g.commentsEnabled + "  copyFrom=" + $srcTxt)
    }

    Head "Harvest sources (Step 2)"
    $srcLines = @(($s.posting.contentSources.groupsText -split "`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($srcLines.Count -eq 0) { Line "  none configured" } else { $srcLines | ForEach-Object { Line ("  " + $_) } }
  } else { Line "  (could not parse workflow-state.json)" }
} else { Line "  (no workflow-state.json yet - never run)" }

# --- today's ledger tallies ---
Head "Ledger - today (UTC)"
$ledger = Join-Path $Target 'data\local-db\facebook-live-posts.jsonl'
if (Test-Path $ledger) {
  $today = [DateTime]::UtcNow.ToString('yyyy-MM-dd')
  $counts = @{}
  $lastAt = ''
  # tail the file: only the last ~6000 lines matter for "today"
  $tail = Get-Content $ledger -Tail 6000
  foreach ($ln in $tail) {
    if ($ln -notmatch [regex]::Escape($today)) { continue }
    try { $r = $ln | ConvertFrom-Json } catch { continue }
    $st = if ($r.status) { $r.status } elseif ($r.event) { $r.event } else { '?' }
    $counts[$st] = [int]$counts[$st] + 1
    if ($r.at) { $lastAt = $r.at }
  }
  if ($counts.Keys.Count -eq 0) { Line "  no ledger rows dated today" }
  else {
    $counts.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 12 | ForEach-Object {
      Line ("  " + ($_.Key.PadRight(34)) + $_.Value)
    }
    Line ("  last ledger row: " + $lastAt)
  }
} else { Line "  (no ledger file yet)" }

Head "Reminders (operator-only, no script fixes these)"
Line "  - ixBrowser profiles must be LOGGED IN to Facebook (posting/commenting profiles AND moderators)"
Line "  - a source group that harvests nothing feeds nothing - verify each Step-2 group has products"
Line "  - if the server is down and no watchdog is installed, re-run deployment\deploy.bat"
Write-Host ""
