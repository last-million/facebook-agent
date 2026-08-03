<#
==============================================================================
 Facebook Agent - bare-machine bootstrap
==============================================================================
 Brings a Windows box with NOTHING installed to a running dashboard:
   Node.js -> Git -> repo -> npm deps -> data dir -> watchdog -> WSL -> Hermes.

 Run it from deploy.bat (which elevates), or directly:
     powershell -NoProfile -ExecutionPolicy Bypass -File deployment\bootstrap.ps1
     powershell -NoProfile -ExecutionPolicy Bypass -File deployment\bootstrap.ps1 -CheckOnly

 DESIGN NOTES
 - IDEMPOTENT. Every step detects what is already there and skips it, so this is
   safe to re-run any number of times - which matters because WSL needs a reboot
   on a bare machine and you must re-run afterwards to finish Hermes.
 - NO winget DEPENDENCY. Windows Server 2022 (this project's platform) ships
   without winget, so installers are fetched directly from the vendors.
 - NO PLAYWRIGHT BROWSER DOWNLOAD. package.json pins playwright-core, and the
   connector only ever calls chromium.connectOverCDP() against ixBrowser's own
   Chrome - it never launches a bundled browser. That saves a ~400MB step that
   older setup notes implied was needed.
 - ASCII ONLY, deliberately. This file has no BOM, and Windows PowerShell 5.1
   decodes a BOM-less script with the system ANSI code page - so a single smart
   quote or box-drawing character turns into mojibake and can break parsing on a
   machine with a different locale. Keep every character in this file 7-bit.
 - It NEVER edits secrets, state, or the ledger. Nothing here can disturb a
   machine that is already running production.
#>
[CmdletBinding()]
param(
  # Report what WOULD be installed and exit non-zero if anything is missing.
  # Used to validate this script on a working machine without touching it.
  [switch]$CheckOnly,
  # Where the agent lives. Kept identical to the historical path (note the
  # long-standing "facbeook" spelling - it is load-bearing for existing installs).
  [string]$Target = (Join-Path $env:USERPROFILE 'Desktop\facbeook agent'),
  [string]$RepoUrl = 'https://github.com/last-million/facebook-agent.git'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'   # keeps Invoke-WebRequest fast on Server Core
$script:Missing        = @()

function Say  ($m) { Write-Host $m }
function Step ($n, $m) { Write-Host ""; Write-Host ("[$n] $m") -ForegroundColor Cyan }
function OK   ($m) { Write-Host ("    OK    " + $m) -ForegroundColor Green }
function Info ($m) { Write-Host ("          " + $m) -ForegroundColor DarkGray }
function Warn ($m) { Write-Host ("    WARN  " + $m) -ForegroundColor Yellow }
function Fail ($m) { Write-Host ("    FAIL  " + $m) -ForegroundColor Red }

function Have-Cmd ($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# PATH inside this process goes stale the moment an installer adds to it, so
# re-read the machine+user PATH after every install instead of asking for a reboot.
function Refresh-Path {
  $env:Path = ([Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
               [Environment]::GetEnvironmentVariable('Path','User'))
}

# wsl.exe writes UTF-16, so its output arrives with embedded NUL bytes. Every
# -match against it silently fails unless they are stripped first.
function Clean-Wsl ($s) { return (($s | Out-String) -replace "`0", '') }

function Download-File ($url, $outFile) {
  Info "downloading $url"
  # TLS 1.2 must be forced on older Server images or every vendor download fails.
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
  Invoke-WebRequest -Uri $url -OutFile $outFile -UseBasicParsing -TimeoutSec 300
}

function Need ($what, $how) {
  $script:Missing += $what
  Fail "$what is missing"
  if ($how) { Info $how }
}

Say "=============================================================="
if ($CheckOnly) { Say " Facebook Agent - bootstrap (CHECK ONLY, installs nothing)" }
else            { Say " Facebook Agent - bootstrap" }
Say " Target: $Target"
Say "=============================================================="

# --- 0. Administrator ---------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $CheckOnly) {
  Fail "This must run as Administrator (installers + scheduled tasks need it)."
  Info "Right-click deploy.bat -> Run as administrator."
  exit 1
}

# --- 1. Node.js ---------------------------------------------------------------
Step 1 "Node.js"
if (Have-Cmd node) {
  OK ("node " + (& node -v))
} elseif ($CheckOnly) {
  Need "Node.js" "https://nodejs.org (LTS x64 MSI)"
} else {
  # Resolve the current LTS dynamically from the official index so this script
  # does not rot as versions move.
  $msi = $null
  try {
    $idx = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing -TimeoutSec 60
    $lts = $idx | Where-Object { $_.lts } | Select-Object -First 1
    if ($lts) { $msi = "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-x64.msi" }
  } catch { Warn ("could not read nodejs.org index: " + $_.Exception.Message) }
  if (-not $msi) {
    $msi = 'https://nodejs.org/dist/v22.11.0/node-v22.11.0-x64.msi'
    Warn "falling back to a pinned Node MSI"
  }
  $tmp = Join-Path $env:TEMP 'node-lts-x64.msi'
  Download-File $msi $tmp
  Info "installing silently (this takes a minute)"
  $p = Start-Process msiexec.exe -ArgumentList @('/i', ('"' + $tmp + '"'), '/qn', '/norestart') -Wait -PassThru
  if ($p.ExitCode -ne 0) { Fail ("Node MSI exit code " + $p.ExitCode); exit 1 }
  Refresh-Path
  if (Have-Cmd node) { OK ("node " + (& node -v)) }
  else { Fail "Node installed but not on PATH - reboot and re-run."; exit 1 }
}

# --- 2. Git -------------------------------------------------------------------
# Needed to clone/update the repo. (The repo also vendors a portable git under
# .tooling\mingit for the auto-sync task, but you need a real git to get the repo
# in the first place.)
Step 2 "Git for Windows"
# The repo vendors a portable git at .tooling\mingit (used by the auto-sync task),
# so a machine can be perfectly healthy with no system-wide git. Only the CLONE
# needs a real one - if the checkout already exists, the vendored copy is enough
# and reporting "Git is missing" would be a false alarm.
$vendoredGit = Join-Path $Target '.tooling\mingit\cmd\git.exe'
$repoPresent = Test-Path (Join-Path $Target 'server.js')
if (Have-Cmd git) {
  OK (& git --version)
} elseif ($repoPresent -and (Test-Path $vendoredGit)) {
  OK ("no system git, but the repo is present and vendors one: " + ((& $vendoredGit --version) -join ''))
  Info "a system-wide git is only needed to clone a fresh copy"
} elseif ($CheckOnly) {
  Need "Git" "https://git-scm.com/download/win"
} else {
  $exe = $null
  try {
    $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' `
                             -Headers @{ 'User-Agent' = 'fb-agent-bootstrap' } -UseBasicParsing -TimeoutSec 60
    $asset = $rel.assets | Where-Object { $_.name -match '^Git-.*-64-bit\.exe$' } | Select-Object -First 1
    if ($asset) { $exe = $asset.browser_download_url }
  } catch { Warn ("GitHub API unreachable: " + $_.Exception.Message) }
  if (-not $exe) {
    Fail "Could not resolve a Git installer automatically."
    Info "Install Git from https://git-scm.com/download/win then re-run this script."
    exit 1
  }
  $tmp = Join-Path $env:TEMP 'git-setup-64.exe'
  Download-File $exe $tmp
  Info "installing silently"
  $p = Start-Process $tmp -ArgumentList @('/VERYSILENT','/NORESTART','/NOCANCEL','/SP-') -Wait -PassThru
  if ($p.ExitCode -ne 0) { Warn ("Git installer exit code " + $p.ExitCode) }
  Refresh-Path
  if (Have-Cmd git) { OK (& git --version) }
  else { Fail "Git installed but not on PATH - reboot and re-run."; exit 1 }
}

# --- 3. The repo --------------------------------------------------------------
Step 3 "Repository"
if (Test-Path (Join-Path $Target 'server.js')) {
  OK "already present at $Target"
} elseif ($CheckOnly) {
  Need "repo checkout" "git clone $RepoUrl into $Target"
} else {
  $parent = Split-Path $Target -Parent
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  & git clone $RepoUrl $Target
  if ($LASTEXITCODE -ne 0) { Fail "git clone failed"; exit 1 }
  OK "cloned"
}

# --- 4. npm dependencies ------------------------------------------------------
# Only cheerio + playwright-core. playwright-core deliberately ships NO browsers:
# the connector attaches to ixBrowser's Chrome over CDP, so there is nothing else
# to download here.
Step 4 "npm dependencies"
$hasPw = Test-Path (Join-Path $Target 'node_modules\playwright-core')
$hasCh = Test-Path (Join-Path $Target 'node_modules\cheerio')
if (-not (Test-Path (Join-Path $Target 'package.json'))) {
  Warn "no package.json yet (repo step did not complete) - skipping"
} elseif ($hasPw -and $hasCh) {
  OK "already installed (cheerio + playwright-core)"
} elseif ($CheckOnly) {
  Need "node_modules" "npm install (in $Target)"
} else {
  Push-Location $Target
  try {
    & cmd /c "npm install --no-audit --no-fund"
    if ($LASTEXITCODE -ne 0) { Fail "npm install failed"; exit 1 }
    OK "installed"
  } finally { Pop-Location }
}

# --- 5. Runtime data dir ------------------------------------------------------
Step 5 "Runtime data directory"
$dataDir = Join-Path $Target 'data'
if (Test-Path $dataDir) { OK "data directory exists" }
elseif ($CheckOnly) { Need "data directory" "created by this script" }
else { New-Item -ItemType Directory -Force -Path $dataDir | Out-Null; OK "created" }

# --- 6. Keep-alive watchdog ---------------------------------------------------
# IMPORTANT: this registers FacebookAgentWatchdog -> tools\fb-watchdog.ps1, which
# is the watchdog this project actually maintains. An older revision of deploy.bat
# registered "FB-Server-Watchdog" -> data\fb-server-watchdog.ps1 instead; that one
# predates the 2026-07 hardening (identify the server ONLY by port-9317 ownership
# so the co-resident Pinterest agent is never killed, a 30s probe timeout so a
# merely-busy server is not force-killed, and timestamped stdout/stderr logs so a
# fatal line survives the next restart). A new machine must get the maintained one.
Step 6 "Keep-alive watchdog (every minute)"
$wdScript = Join-Path $Target 'tools\fb-watchdog.ps1'
$existing = Get-ScheduledTask -TaskName 'FacebookAgentWatchdog' -ErrorAction SilentlyContinue
if ($existing) {
  OK ("FacebookAgentWatchdog already registered (" + $existing.State + ")")
} elseif ($CheckOnly) {
  Need "FacebookAgentWatchdog scheduled task" "registered by this script"
} elseif (-not (Test-Path $wdScript)) {
  Warn "tools\fb-watchdog.ps1 not found - skipping (repo incomplete?)"
} else {
  $act  = New-ScheduledTaskAction -Execute 'powershell.exe' `
            -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $wdScript + '"')
  $trg  = New-ScheduledTaskTrigger -Once -At (Get-Date) `
            -RepetitionInterval (New-TimeSpan -Minutes 1)
  # Runs as the logged-in user, NOT SYSTEM: the watchdog starts node server.js,
  # which drives ixBrowser - and ixBrowser's local API and browser profiles live
  # in the interactive user's session. A SYSTEM-owned server cannot reach them.
  $prin = New-ScheduledTaskPrincipal -UserId ($env:USERDOMAIN + '\' + $env:USERNAME) `
            -LogonType Interactive -RunLevel Highest
  Register-ScheduledTask -TaskName 'FacebookAgentWatchdog' -Action $act -Trigger $trg -Principal $prin -Force | Out-Null
  OK "registered"
}

# --- 7. WSL + Ubuntu ----------------------------------------------------------
# Hermes (the image-review LLM CLI the dashboard shells out to) runs in Linux.
Step 7 "WSL + Ubuntu"
$wslOk = $false
if (Have-Cmd wsl) {
  $status = Clean-Wsl (& wsl.exe --status 2>&1)
  if ($status -match 'Default\s*Distribution') {
    $wslOk = $true
    $line = ($status -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
    OK $line.Trim()
  }
}
if (-not $wslOk) {
  if ($CheckOnly) {
    Need "WSL + a Linux distro" "wsl --install -d Ubuntu   (then REBOOT and re-run)"
  } else {
    Warn "WSL not ready - installing (a REBOOT will be required)"
    & wsl.exe --install -d Ubuntu
    Say ""
    Warn "=================================================================="
    Warn " REBOOT NOW, then run deploy.bat again to finish Hermes."
    Warn " (Ubuntu asks you to create a UNIX user on its first launch.)"
    Warn "=================================================================="
    exit 0
  }
}

# --- 8. Hermes agent (inside WSL) ---------------------------------------------
# server.js calls it at exactly /root/.local/bin/hermes (see HERMES_BIN), so that
# is what we verify - being on some other PATH is not good enough.
Step 8 "Hermes agent (WSL)"
$hermesOk = $false
if ($wslOk) {
  $probe = Clean-Wsl (& wsl.exe -u root bash -lc "test -x /root/.local/bin/hermes && echo HERMES_OK || echo HERMES_MISSING" 2>&1)
  $hermesOk = ($probe -match 'HERMES_OK')
}
if ($hermesOk) {
  OK "/root/.local/bin/hermes present (where server.js expects it)"
} elseif (-not $wslOk) {
  Warn "skipped - WSL not ready"
} elseif ($CheckOnly) {
  Need "Hermes agent" "installed by this script via deployment/deploy.sh"
} else {
  # THE BUG THIS SCRIPT EXISTS TO FIX: the old deploy.bat passed a *Windows* path
  # into WSL ("C:/Users/.../deploy.sh"), which does not exist inside Linux, so its
  # last step silently did nothing on every machine it ever ran on. Convert it.
  $shWin = Join-Path $Target 'deployment\deploy.sh'
  if (-not (Test-Path $shWin)) { Fail "deployment\deploy.sh missing"; exit 1 }
  $shWsl = (Clean-Wsl (& wsl.exe wslpath -a "$shWin" 2>&1)).Trim()
  if (-not $shWsl -or -not $shWsl.StartsWith('/')) {
    # Fallback conversion if wslpath is unavailable for any reason.
    $drive = $Target.Substring(0,1).ToLower()
    $shWsl = '/mnt/' + $drive + ($Target.Substring(2) -replace '\\','/') + '/deployment/deploy.sh'
    Info "wslpath unavailable, using $shWsl"
  }
  Info "running deploy.sh in WSL as root (installs git/python/uv, clones Hermes, builds the CLI)"
  # -u root: HERMES_BIN lives under /root and deploy.sh writes ~/.hermes, so both
  # must resolve to root's HOME regardless of which UNIX user Ubuntu created.
  # sed strips CR first: a Windows-line-ending checkout otherwise makes bash die
  # with an unreadable "\r: command not found".
  $cmd = "sed -i 's/\r`$//' '$shWsl' 2>/dev/null; bash '$shWsl'"
  & wsl.exe -u root bash -lc $cmd
  $rc = $LASTEXITCODE
  $probe2 = Clean-Wsl (& wsl.exe -u root bash -lc "test -x /root/.local/bin/hermes && echo HERMES_OK || echo HERMES_MISSING" 2>&1)
  if ($probe2 -match 'HERMES_OK') {
    OK "Hermes installed"
  } else {
    Fail ("Hermes still not at /root/.local/bin/hermes (deploy.sh exit " + $rc + ")")
    Info "Run it by hand to see the error:"
    Info ("  wsl -u root bash -lc " + [char]34 + "bash '" + $shWsl + "'" + [char]34)
    $script:Missing += 'Hermes agent'
  }
}

# --- 9. What a human still has to do ------------------------------------------
# These genuinely cannot be scripted - they need a person, a browser, credentials.
$manual = @(
  'ixBrowser desktop app: install from https://www.ixbrowser.com, sign in, enable its Local API.',
  'ixBrowser profiles: log into each Facebook account you post/comment with.',
  'Dashboard > Integrations: enter OpenAI / OpenRouter keys and Webshare proxy credentials.',
  'Dashboard > Prod > Step 3: tick which profiles serve which group.',
  'Inside WSL, edit ~/.hermes/.env and add your OpenRouter/OpenAI keys.',
  '(optional) Log ChatGPT into a persistent Edge profile for HD image upgrades.'
)

Say ""
Say "=============================================================="
if ($script:Missing.Count -eq 0) {
  Write-Host " ALL AUTOMATED PREREQUISITES ARE IN PLACE" -ForegroundColor Green
} else {
  Write-Host (" STILL MISSING: " + ($script:Missing -join ', ')) -ForegroundColor Yellow
}
Say "=============================================================="
Say ""
Say " Manual steps (cannot be automated - they need your accounts):"
$i = 1
foreach ($m in $manual) { Say ("   " + $i + ") " + $m); $i++ }
Say ""
Say " Then start it:   run-facebook-agent.bat     (opens http://127.0.0.1:9317)"
Say ""

if ($CheckOnly -and $script:Missing.Count -gt 0) { exit 2 }
exit 0
