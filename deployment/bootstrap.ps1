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
  # Finish without starting the dashboard / opening the browser.
  [switch]$NoStart,
  # Where the agent lives. Default is worked out at runtime just below, because
  # the right answer depends on how you got the files. Pass -Target to override.
  [string]$Target = '',
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

# Native commands that write to stderr become TERMINATING errors under
# $ErrorActionPreference='Stop' the moment their streams are merged (2>&1) -
# that is what killed the 2026-08-06 repair run mid-ladder ("wsl.exe: The
# parameter is incorrect" then exit 1). These two helpers never throw:
# streams are discarded, not merged, and everything is wrapped in try/catch.
function Invoke-Quiet {
  param([string]$Exe, [string[]]$Args)
  try { & $Exe @Args *> $null } catch {}
  return $LASTEXITCODE
}
function Test-WslReady {
  try {
    $probe = Clean-Wsl (& wsl.exe -e sh -c "echo WSL_READY" 2>$null)
    return ($probe -match 'WSL_READY')
  } catch { return $false }
}

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

# --- Where is the agent? ------------------------------------------------------
# INSTALL IN PLACE. The normal way this is used is: download the project (ZIP from
# GitHub, or a copy on a USB stick, because the repo may be PRIVATE), drop the
# folder on the machine, and run deploy.bat out of it. So the target is simply the
# folder this script lives in -- deployment\bootstrap.ps1 -> its parent.
#
# That matters for more than tidiness: a hardcoded "Desktop\facbeook agent" default
# made the installer ignore the very files the user had just unpacked and try to
# git-clone a second copy somewhere else. It also means the folder can be named
# anything (a GitHub ZIP unpacks as "facebook-agent-main") and can sit on any drive.
$RunningInPlace = $false
if (-not $Target) {
  $selfRepo = Split-Path $PSScriptRoot -Parent
  if (Test-Path (Join-Path $selfRepo 'server.js')) {
    $Target = $selfRepo
    $RunningInPlace = $true
  } else {
    # Not inside a copy of the project (someone ran bootstrap.ps1 on its own):
    # fall back to the historical location and clone into it.
    $Target = Join-Path $env:USERPROFILE 'Desktop\facbeook agent'
  }
}

# TRANSCRIPT. If a console window ever closes before it can be read - a wrong
# double-click, a machine policy killing the shell, an installer that reboots -
# there has to be something left behind to look at. Best-effort only: a copy on
# read-only media (a USB stick mounted read-only) must not stop the install, so
# it falls back to TEMP and then gives up silently.
$script:LogPath = ''
foreach ($cand in @((Join-Path $PSScriptRoot 'install-log.txt'), (Join-Path $env:TEMP 'fb-agent-install-log.txt'))) {
  try { Start-Transcript -Path $cand -Force -ErrorAction Stop | Out-Null; $script:LogPath = $cand; break } catch {}
}

Say "=============================================================="
if ($CheckOnly) { Say " Facebook Agent - bootstrap (CHECK ONLY, installs nothing)" }
else            { Say " Facebook Agent - bootstrap" }
Say " Target: $Target"
if ($script:LogPath) { Say " Log:    $script:LogPath" }
if ($RunningInPlace) { Say " Mode:   installing IN PLACE (the copy you ran this from)" }
Say "=============================================================="

# Files that arrived in a downloaded ZIP carry the Mark of the Web, which makes
# PowerShell refuse to run them on some machines. deploy.bat already passes
# -ExecutionPolicy Bypass, but clearing the mark stops any other prompt as well.
if ($RunningInPlace -and -not $CheckOnly) {
  try {
    Get-ChildItem -Path $Target -Recurse -Include *.ps1,*.bat,*.cmd,*.sh -ErrorAction SilentlyContinue |
      Unblock-File -ErrorAction SilentlyContinue
  } catch {}
}

# Running production off a USB stick works right up until the stick is removed --
# and this installs a watchdog that will keep trying to restart the server from a
# path that no longer exists. Say so plainly; do not block, it is the user's call.
try {
  $driveLetter = ($Target.Substring(0,2))
  $drv = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='" + $driveLetter + "'") -ErrorAction SilentlyContinue
  if ($drv -and $drv.DriveType -eq 2) {
    Say ""
    Warn "This folder is on a REMOVABLE drive ($driveLetter)."
    Info "Copy it to the local disk before running production - the watchdog and"
    Info "the run will break the moment the drive is unplugged."
  }
} catch {}

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
# Git is only ever needed to CLONE. Which of the two supported flows you are in
# decides whether that makes it optional or mandatory:
#   ZIP / USB copy  - the files are already here, nothing to clone -> OPTIONAL
#   clone from git  - there is no copy yet, so it must be installed -> REQUIRED
# The repo may also vendor a portable git at .tooling\mingit for the auto-sync
# task; that is untracked, so a GitHub ZIP legitimately has none either.
$vendoredGit = Join-Path $Target '.tooling\mingit\cmd\git.exe'
$repoPresent = Test-Path (Join-Path $Target 'server.js')
if ($repoPresent -or $RunningInPlace) { Step 2 "Git for Windows (optional here - the project files are already present)" }
else                                  { Step 2 "Git for Windows (required - needed to download the project)" }
if (Have-Cmd git) {
  OK (& git --version)
} elseif (Test-Path $vendoredGit) {
  OK ("no system git; the project vendors one: " + ((& $vendoredGit --version) -join ''))
} elseif ($repoPresent) {
  OK "not installed - and not needed: the project files are already here"
  Info "install Git only if you want 'git pull' updates or the auto-sync task"
} elseif ($CheckOnly) {
  Need "Git" "required in THIS flow: there is no copy of the project here to install from"
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
Step 3 "Project files"
if ($RunningInPlace) {
  OK "using the copy you ran this from (no download needed)"
} elseif (Test-Path (Join-Path $Target 'server.js')) {
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
# Re-running the installer must ALSO mean "get the newest code" - otherwise the
# dashboard keeps serving whatever was downloaded the first time (the 2026-08-06
# stale-server 404s came from exactly that: new files never pulled, old process
# never restarted). Fast-forward only: if local commits ever diverge from GitHub
# we warn and keep going instead of silently merging or destroying anything.
# ZIP copies have no .git, so for those the update path is a fresh ZIP - say so.
if ($CheckOnly) {
  # nothing to report: code freshness is not a prerequisite check
} elseif ((Test-Path (Join-Path $Target '.git')) -and (Have-Cmd git)) {
  Push-Location $Target
  try {
    $pullOut = & git pull --ff-only 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) {
      if ($pullOut -match 'Already up to date') { OK "code already up to date with GitHub" }
      else { OK "pulled the newest code from GitHub" }
    } else {
      Warn "git pull did not apply cleanly - keeping the local code as-is"
      Info "local commits diverged from GitHub; run 'git pull' by hand to see why"
    }
  } finally { Pop-Location }
} else {
  Info "ZIP copy (no git folder) - to update the code later, download a fresh ZIP and re-run this installer over it"
}

# --- 4. npm dependencies ------------------------------------------------------
# Only cheerio + playwright-core. playwright-core deliberately ships NO browsers:
# the connector attaches to ixBrowser's Chrome over CDP, so there is nothing else
# to download here.
Step 4 "npm dependencies"
$hasPw = Test-Path (Join-Path $Target 'node_modules\playwright-core')
$hasCh = Test-Path (Join-Path $Target 'node_modules\cheerio')
# A git pull can bring a NEWER package.json - "already installed" must mean
# "installed for the CURRENT package.json", not "some node_modules exists".
# Measure against node_modules\.package-lock.json (npm writes it LAST, at the
# end of an install) and allow a 5-minute skew: same-install timestamps differ
# by seconds, a real "pulled a newer package.json" gap is hours or days.
$depsStale = $false
try {
  $pkgTime = (Get-Item (Join-Path $Target 'package.json') -ErrorAction Stop).LastWriteTime
  $lockMarker = Join-Path $Target 'node_modules\.package-lock.json'
  $nmTime = if (Test-Path $lockMarker) { (Get-Item $lockMarker).LastWriteTime } else { (Get-Item (Join-Path $Target 'node_modules') -ErrorAction Stop).LastWriteTime }
  if (($pkgTime - $nmTime) -gt [TimeSpan]::FromMinutes(5)) { $depsStale = $true }
} catch {}
if (-not (Test-Path (Join-Path $Target 'package.json'))) {
  Warn "no package.json yet (repo step did not complete) - skipping"
} elseif ($hasPw -and $hasCh -and -not $depsStale) {
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
  # A SECOND COPY ON THE SAME MACHINE is easy to create by accident - unzip to
  # Downloads, run deploy.bat there, and now two folders both call themselves the
  # agent. They do NOT share anything: state, the ledger, secrets and logs all live
  # under each copy's own data\ directory, and only ONE of them can hold port 9317.
  # The watchdog points at exactly one of them, so say plainly which, rather than
  # letting someone configure the copy that is not the one actually running.
  try {
    $wdArg = ($existing.Actions | Select-Object -First 1).Arguments
    $m = [regex]::Match([string]$wdArg, '-File\s+"([^"]+)"')
    if ($m.Success) {
      $wdOwner = Split-Path (Split-Path $m.Groups[1].Value -Parent) -Parent
      if ($wdOwner -and ($wdOwner.TrimEnd('\') -ne $Target.TrimEnd('\'))) {
        Say ""
        Warn "ANOTHER COPY of the agent is already installed on this machine:"
        Info ("   running copy : " + $wdOwner)
        Info ("   this copy    : " + $Target)
        Info "They share nothing - separate state, ledger, secrets and logs, and only"
        Info "one can use port 9317. The watchdog keeps starting the RUNNING copy."
        Info "Configure that one, or delete it first if you meant to replace it."
      }
    }
  } catch {}
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
# DETECT BY EXECUTION, NOT BY PARSING TEXT.
# This used to decide from `wsl --status` matching the words "Default Distribution".
# That is fragile twice over: the text is LOCALIZED, and wsl.exe emits UTF-16, which
# decodes differently depending on the console code page of whatever shell launched
# us. It duly misfired on a live machine whose WSL was perfectly healthy - and the
# consequence was not a wrong message, it was running `wsl --install` against an
# already-working installation. Never risk that again: the only question that
# actually matters is "can I run a command inside WSL", so ask exactly that.
$wslOk = $false
$wslDistros = @()
if (Have-Cmd wsl) {
  $wslOk = Test-WslReady
  $wslDistros = @((Clean-Wsl (& wsl.exe -l -q 2>$null)) -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}
if ($wslOk) {
  if ($wslDistros.Count) { OK ("working - distro(s): " + ($wslDistros -join ', ')) } else { OK "working" }
  # server.js runs every job with -d Ubuntu-24.04 - that exact distro must exist,
  # even on a machine whose WSL was already healthy with some other distro.
  if (-not $CheckOnly -and ($wslDistros -notcontains 'Ubuntu-24.04')) {
    Info "adding the Ubuntu-24.04 distro (the one the agent runs jobs in)"
    Invoke-Quiet wsl.exe @('--install','-d','Ubuntu-24.04','--no-launch') | Out-Null
    Invoke-Quiet wsl.exe @('--set-default','Ubuntu-24.04') | Out-Null
    Invoke-Quiet wsl.exe @('--shutdown') | Out-Null
  }
} elseif (-not (Have-Cmd wsl)) {
  # wsl.exe genuinely absent -> a real install is warranted.
  if ($CheckOnly) {
    Need "WSL + a Linux distro" "wsl --install -d Ubuntu   (then REBOOT and re-run)"
  } else {
    Warn "WSL is not installed - installing it now (a REBOOT will be required)"
    & wsl.exe --install -d Ubuntu-24.04
    $rc = $LASTEXITCODE
    Say ""
    if ($rc -eq 0) {
      Warn "=================================================================="
      Warn " REBOOT NOW, then run deploy.bat again to finish Hermes."
      Warn " (Ubuntu asks you to create a UNIX user on its first launch.)"
      Warn "=================================================================="
    } else {
      # Do NOT tell someone to reboot when the install actually failed - rebooting
      # will not fix a component-store error and they will just run it again.
      Fail ("wsl --install failed (exit " + $rc + ") - see the message above")
      Info "Common causes: Windows needs updates, virtualization is off in the BIOS,"
      Info "or the machine is a VM without nested virtualization enabled."
      Info "Everything else is installed; only the Hermes half needs WSL."
      $script:Missing += 'WSL'
    }
    if ($rc -eq 0) { exit 0 }
  }
} else {
  # wsl.exe exists but commands do not run. AUTOMATIC REPAIR LADDER (2026-08-06,
  # operator: "the deployment files should do it") - every step is a safe,
  # standard WSL operation, and we re-probe by EXECUTION after each one. The old
  # behavior stopped here and printed manual terminal steps instead.
  if ($CheckOnly) {
    Need "working WSL" "automatic repair runs on a real install (wsl --update, shutdown, distro)"
  } else {
    Warn "WSL is present but not answering - attempting automatic repair"
    Info "step 1/4: wsl --shutdown (resets a hung WSL service/VM)"
    Invoke-Quiet wsl.exe @('--shutdown') | Out-Null
    Start-Sleep -Seconds 2
    if (Test-WslReady) { $wslOk = $true }
    if (-not $wslOk) {
      Info "step 2/4: wsl --update (repairs the WSL engine itself - the old INBOX build does not understand -e)"
      if ((Invoke-Quiet wsl.exe @('--update')) -ne 0) { Invoke-Quiet wsl.exe @('--update','--web-download') | Out-Null }
      Invoke-Quiet wsl.exe @('--shutdown') | Out-Null
      Start-Sleep -Seconds 2
      if (Test-WslReady) { $wslOk = $true }
    }
    if (-not $wslOk) {
      # "The parameter is incorrect" here means this wsl.exe does not know an
      # argument (older builds lack --no-launch) - so try every sane combo, and
      # both distro names, before giving up. Invoke-Quiet cannot abort the run.
      Info "step 3/4: install a Linux distro (Ubuntu-24.04 is the one server.js runs jobs in)"
      $installed = $false
      foreach ($distro in @('Ubuntu-24.04', 'Ubuntu')) {
        if ((Invoke-Quiet wsl.exe @('--install','-d',$distro,'--no-launch')) -eq 0) { $installed = $true; break }
        if ((Invoke-Quiet wsl.exe @('--install','-d',$distro)) -eq 0) { $installed = $true; break }
      }
      if (-not $installed) { Info "distro install did not go through - will retry after the reboot" }
      Invoke-Quiet wsl.exe @('--set-default','Ubuntu-24.04') | Out-Null
      Invoke-Quiet wsl.exe @('--shutdown') | Out-Null
      Start-Sleep -Seconds 2
      if (Test-WslReady) { $wslOk = $true }
    }
    if (-not $wslOk) {
      Info "step 4/4: enable the Windows features WSL needs (they take effect after a reboot)"
      Invoke-Quiet dism.exe @('/online','/enable-feature','/featurename:Microsoft-Windows-Subsystem-Linux','/all','/norestart') | Out-Null
      Invoke-Quiet dism.exe @('/online','/enable-feature','/featurename:VirtualMachinePlatform','/all','/norestart') | Out-Null
    }
    if ($wslOk) {
      OK "WSL repaired and answering"
      $wslDistros = @((Clean-Wsl (& wsl.exe -l -q 2>$null)) -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
      if ($wslDistros -notcontains 'Ubuntu-24.04') {
        Info "adding the Ubuntu-24.04 distro (the one the agent runs jobs in)"
        Invoke-Quiet wsl.exe @('--install','-d','Ubuntu-24.04','--no-launch') | Out-Null
        Invoke-Quiet wsl.exe @('--set-default','Ubuntu-24.04') | Out-Null
        Invoke-Quiet wsl.exe @('--shutdown') | Out-Null
      }
    } else {
      # The one thing automation cannot do for you: a kernel/feature change only
      # takes effect after a reboot. Say it loudly and offer to do it (see the
      # end of this script).
      Fail "WSL still not answering after automatic repair - one REBOOT is required"
      $script:Missing += 'WSL (needs one reboot)'
      $script:NeedsReboot = $true
    }
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
  # Work on a COPY in /tmp rather than sed -i on the checkout: the file may have
  # CRLF endings (bash then dies with an unreadable "\r: command not found"), but
  # rewriting it in place would dirty the git working tree on the user's machine.
  # FB_REPO_DIR tells the copy where the real repo is, since it can no longer
  # infer that from its own location.
  # FB_HERMES_ONLY=1: deploy.sh is a FULL installer when run on its own (it will
  # install Node and the npm deps for a Linux host). Here the dashboard runs on
  # the WINDOWS Node, so a second Node inside WSL would be pure waste - this flag
  # makes it do the Hermes half only.
  $repoWsl = (Clean-Wsl (& wsl.exe wslpath -a "$Target" 2>&1)).Trim()
  $cmd = "sed 's/\r`$//' '$shWsl' > /tmp/fb-deploy.sh && FB_HERMES_ONLY=1 FB_REPO_DIR='$repoWsl' bash /tmp/fb-deploy.sh"
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
  'Connect an LLM: open the dashboard - the "Agent LLM" button (top right) opens the setup popup for API keys or OAuth sign-in. (Manual fallback: edit ~/.hermes/.env inside WSL.)',
  'ixBrowser desktop app: install from https://www.ixbrowser.com, sign in, enable its Local API.',
  'ixBrowser profiles: log into each Facebook account you post/comment with.',
  'Dashboard > Integrations: Webshare proxy credentials.',
  'Dashboard > Prod > Step 3: tick which profiles serve which group.',
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

# --- 10. Start the dashboard ---------------------------------------------------
# The point of running an installer is to end up looking at the thing. Printing a
# URL on line 40 of a wall of text is not that - the operator reported finishing a
# run and never seeing an address at all. So: start the server, wait until it
# genuinely answers, open the browser, and print the URL where it cannot be missed.
# Starting the SERVER is not starting a posting run: a run is armed separately from
# the dashboard, so nothing here touches Facebook.
$dashUrl = 'http://127.0.0.1:9317/'
$serverUp = $false
# GATE ON WHAT THE DASHBOARD ACTUALLY NEEDS, not on a clean bill of health. Node,
# the project files and node_modules are what make `node server.js` run. WSL and
# Hermes are NOT: they only power the image-review step, so a machine where WSL
# refused to install still posts, comments and serves the dashboard perfectly well.
# Gating on $Missing being empty meant one failed optional component left the user
# with no dashboard at all and no idea why - which is exactly what happened on a
# fresh RDP box whose `wsl --install` died on a component-store error.
$canRunDashboard = (Have-Cmd node) -and
                   (Test-Path (Join-Path $Target 'server.js')) -and
                   (Test-Path (Join-Path $Target 'node_modules\playwright-core'))
if (-not $CheckOnly -and -not $NoStart -and $canRunDashboard) {
  Step 10 "Starting the dashboard"
  $owner = $null
  try { $owner = (Get-NetTCPConnection -LocalPort 9317 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess } catch {}
  if ($owner) {
    # A server started BEFORE the files on disk changed is serving OLD code - the
    # 2026-08-06 incident: the browser had the new app.js, the running node process
    # did not have the new routes, and this branch used to just say "already
    # running" and walk away. Compare timestamps and restart it onto current code.
    $restart = $true
    try {
      $procStart = (Get-Process -Id $owner -ErrorAction Stop).StartTime
      $codeTime = (Get-Item (Join-Path $Target 'server.js')).LastWriteTime
      if ($codeTime -le $procStart) { $restart = $false }
    } catch { $restart = $true }   # cannot tell -> restart to be safe
    if ($restart) {
      Info "running server (pid $owner) predates the files on disk - restarting it onto the current code"
      try { Stop-Process -Id $owner -Force -ErrorAction Stop; Start-Sleep -Seconds 2 } catch {}
      $owner = $null
    } else {
      OK "already running the current code (pid $owner)"
      $serverUp = $true
    }
  }
  if (-not $owner -and -not $serverUp) {
    if (-not (Test-Path (Join-Path $Target 'server.js'))) {
    Warn "server.js not found - skipping"
  } else {
    # Timestamped logs, matching tools\fb-watchdog.ps1: PowerShell's redirection
    # truncates rather than appends, so fixed names would destroy the previous
    # crash's output on every start.
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $outLog = Join-Path $dataDir ("server-stdout-" + $stamp + ".log")
    $errLog = Join-Path $dataDir ("server-stderr-" + $stamp + ".log")
    try {
      Start-Process -FilePath 'node.exe' -ArgumentList 'server.js' -WorkingDirectory $Target `
                    -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog | Out-Null
      Info "launched, waiting for it to answer..."
      for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Seconds 1
        try {
          if ((Invoke-WebRequest -Uri $dashUrl -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { $serverUp = $true; break }
        } catch {}
      }
      if ($serverUp) { OK "dashboard is up" }
      else {
        # SHOW THE REASON, do not post a file path and walk away. On a fresh machine
        # this is the single most likely thing to go wrong, and "check this log" just
        # moves the problem to someone who is already stuck. Node's own error is
        # almost always self-explanatory (a missing module, a port in use, a bad
        # path), so print it here.
        Fail "the dashboard did not answer within 40s"
        $died = $true
        try { $died = -not (Get-Process -Name node -ErrorAction SilentlyContinue) } catch {}
        if ($died) { Info "the node process is no longer running - it exited on startup" }
        foreach ($lg in @($errLog, $outLog)) {
          try {
            if ((Test-Path $lg) -and ((Get-Item $lg).Length -gt 0)) {
              Say ""
              Info ("---- " + (Split-Path $lg -Leaf) + " (last 15 lines) ----")
              Get-Content $lg -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Say ("      " + $_) }
            }
          } catch {}
        }
        Say ""
        Info "Common causes on a fresh machine:"
        Info "  - port 9317 already in use by something else"
        Info "  - npm install did not finish (delete node_modules and re-run this)"
        Info "  - the ZIP was extracted only partially (web\ or tools\ missing)"
        Info ("To see it live, run this in the folder:  node server.js")
        $script:Missing += 'dashboard did not start'
      }
    } catch { Fail ("could not start node: " + $_.Exception.Message); $script:Missing += 'dashboard did not start' }
  }
  }
  if ($serverUp) { try { Start-Process $dashUrl | Out-Null; Info "opened it in your browser" } catch {} }
}

Say ""
Say "  +----------------------------------------------------------+"
if ($serverUp) {
  Write-Host "  |   THE DASHBOARD IS RUNNING - OPEN THIS ADDRESS:           |" -ForegroundColor Green
  Say       "  |                                                          |"
  Write-Host "  |       http://127.0.0.1:9317                               |" -ForegroundColor Green
} else {
  Write-Host "  |   TO START IT:  double-click  run-facebook-agent.bat      |" -ForegroundColor Yellow
  Say       "  |                                                          |"
  Write-Host "  |   THEN OPEN:    http://127.0.0.1:9317                     |" -ForegroundColor Yellow
}
Say       "  |                                                          |"
Write-Host "  |   ON THIS MACHINE ONLY (" -NoNewline; Write-Host ($env:COMPUTERNAME.PadRight(24)) -NoNewline -ForegroundColor White; Write-Host ")        |"
Say       "  +----------------------------------------------------------+"
# 127.0.0.1 is LOOPBACK. server.js binds HOST = "127.0.0.1" deliberately, so the
# dashboard is not reachable from any other computer - typing this address on a
# different PC can only ever fail, and that has already confused someone once.
#
# So report what THIS machine actually is: its name and its real IPv4 addresses.
# That turns "why doesn't the URL work" into a concrete, checkable statement, and
# tells anyone who wants remote access exactly which address they would be asking
# for. Detected live rather than assumed, so it is correct on any machine.
Say ""
Say "  127.0.0.1 means THIS computer, so that address only works while you are"
Say "  sitting on it (console or RDP). This machine is:"
Say ""
Say ("    name : " + $env:COMPUTERNAME)
try {
  $addrs = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
             Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.IPAddress -ne '0.0.0.0' } |
             Select-Object -ExpandProperty IPAddress -Unique)
  if ($addrs.Count) {
    foreach ($a in $addrs) { Say ("    IPv4 : " + $a) }
    Say ""
    Say "  Those addresses do NOT serve the dashboard today - it is bound to loopback"
    Say "  ON PURPOSE. The page carries the API token inside it, so anyone who could"
    Say "  load it would control every Facebook account and every saved key. Opening"
    Say "  the port without adding a real login would hand that to the whole network."
    Say "  Use RDP for now; ask if you want proper remote access added."
  } else {
    Say "    IPv4 : (none detected)"
  }
} catch {}
Say ""

if ($script:LogPath) { Say " A full log of this run was saved to:"; Say ("   " + $script:LogPath); Say "" }
try { Stop-Transcript | Out-Null } catch {}

# WSL repair/first-install only takes effect after a reboot. Offer to do it -
# and register a RunOnce entry first, so after the reboot this installer
# continues BY ITSELF at login and finishes Hermes without the operator
# lifting a finger.
if ($script:NeedsReboot -and -not $CheckOnly) {
  Say ""
  Warn "Automatic repair is done, but WSL only starts working after ONE reboot."
  try {
    $resumeCmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Target "' + $Target + '"'
    Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce' -Name 'FacebookAgentBootstrap' -Value $resumeCmd -ErrorAction Stop
    Info "auto-resume registered - after the reboot this installer continues BY ITSELF at login"
  } catch { Warn "could not register auto-resume - just run deploy.bat again after the reboot" }
  if (-not [Environment]::UserInteractive) {
    # Remote/automated run (e.g. WMI): Read-Host would hang a session-0 console
    # forever. The caller drives the reboot instead.
    Warn "non-interactive session - skipping the prompt; reboot this machine, then re-run."
  } else {
    $answer = Read-Host "Reboot NOW? [Y/n]"
    if ($answer -notmatch '^[Nn]') {
      Warn "Rebooting in 15 seconds. After login the installer continues by itself."
      & shutdown.exe /r /t 15 | Out-Null
    } else {
      Warn "OK - reboot when you can; the installer will continue by itself at next login."
    }
  }
}

if ($CheckOnly -and $script:Missing.Count -gt 0) { exit 2 }
exit 0
