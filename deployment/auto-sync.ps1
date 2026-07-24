# ============================================================
#  Facebook Agent - auto-sync to GitHub
#  Refreshes the claude-memory copy from the live memory dir,
#  commits any changes to tracked files (workflow-state.json,
#  .hermes plans, claude-memory, code), and pushes to GitHub.
#  Intended to run on a schedule (see setup in deployment/README.md).
#  Token is read from data/.git-sync-token (gitignored) - NEVER committed.
#
#  2026-07-24 hardening: the original version never checked git's exit code
#  on commit/push and logged "committed+pushed" unconditionally, so a real
#  push failure (auth expiry, network blip, rejected non-fast-forward) would
#  look identical to success in the log forever. This version checks exit
#  codes, retries a transient push failure, verifies the push actually
#  landed by comparing local HEAD to the real GitHub tip (on EVERY cycle,
#  including when there were no local changes -- so a commit that succeeded
#  but never got pushed can't hide behind a later "no-changes" no-op), and
#  refuses to commit/push anything that looks like it escaped the data/*
#  gitignore (defense-in-depth against the 2GB+ ledger/browser-cache tree).
# ============================================================
$ErrorActionPreference = 'SilentlyContinue'
$repo = Split-Path $PSScriptRoot -Parent            # repo root = parent of deployment/
$git  = Join-Path $repo '.tooling\mingit\cmd\git.exe'
if (-not (Test-Path $git)) { $c = Get-Command git -ErrorAction SilentlyContinue; if ($c) { $git = $c.Source } }
if (-not (Test-Path $git)) { "no git available"; exit 1 }
$env:HOME = $repo
$log = Join-Path $repo 'data\auto-sync.log'

# Rotate the log before writing more to it -- uncapped growth guard (this project has
# prior documented incidents of unrotated files silently growing to 100+MB).
try {
  $logItem = Get-Item $log -ErrorAction SilentlyContinue
  if ($logItem -and $logItem.Length -gt 2MB) {
    Move-Item -Path $log -Destination "$log.old" -Force -ErrorAction SilentlyContinue
  }
} catch {}

function Write-SyncLog([string]$line) { Add-Content -Path $log -Value $line -ErrorAction SilentlyContinue }

# 1a) refresh the in-repo copy of the live Claude memory
$liveMem = Join-Path $env:USERPROFILE '.claude\projects\C--Users-Administrator\memory'
if (Test-Path $liveMem) {
  New-Item -ItemType Directory -Force -Path (Join-Path $repo 'claude-memory') | Out-Null
  Copy-Item (Join-Path $liveMem '*.md') (Join-Path $repo 'claude-memory') -Force
}

# 1b) refresh Hermes brain (SOUL.md + skills snapshot) out of WSL. NEVER copy ~/.hermes/.env (secrets).
if (Get-Command wsl -ErrorAction SilentlyContinue) {
  New-Item -ItemType Directory -Force -Path (Join-Path $repo 'hermes-config') | Out-Null
  $soul = wsl bash -lc "cat /root/.hermes/SOUL.md 2>/dev/null"
  if ($soul) { $soul | Set-Content (Join-Path $repo 'hermes-config\SOUL.md') -Encoding utf8 }
  $skills = wsl bash -lc "cat /root/.hermes/.skills_prompt_snapshot.json 2>/dev/null"
  if ($skills) { $skills | Set-Content (Join-Path $repo 'hermes-config\skills_prompt_snapshot.json') -Encoding utf8 }
}

# ── push helpers (defined before use; token never persisted anywhere but this in-memory URL) ──
$tf = Join-Path $repo 'data\.git-sync-token'
$pushUrl = $null
$t = $null
if (Test-Path $tf) {
  $t = (Get-Content $tf -Raw).Trim()
  $pushUrl = "https://$t@github.com/last-million/facebook-agent.git"
}

function Redact([string]$text) {
  if (-not $text) { return $text }
  if ($t) { return ($text -replace [regex]::Escape($t), '***TOKEN***') }
  return $text
}

function Do-Push([string]$stamp) {
  if (-not $pushUrl) {
    Write-SyncLog "$stamp`tcommitted-locally (no data/.git-sync-token -> push skipped)"
    return
  }
  $pushExit = 1
  $pushOutRedacted = ''
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $pushOut = & $git -C $repo push $pushUrl HEAD:main 2>&1
    $pushExit = $LASTEXITCODE
    $pushOutRedacted = Redact(($pushOut | Out-String).Trim())
    if ($pushExit -eq 0) { break }
    $rejected = ($pushOutRedacted -match '\[rejected\]' -or $pushOutRedacted -match 'non-fast-forward' -or $pushOutRedacted -match 'fetch first')
    if ($rejected) {
      if ($attempt -eq 1) {
        # Structural rejection (remote moved) -- a blind identical retry would never succeed.
        # Try ONE safe fast-forward-only merge (never auto-resolves conflicts) before retrying once.
        & $git -C $repo fetch origin main -q 2>$null
        & $git -C $repo merge --ff-only origin/main -q 2>$null
        if ($LASTEXITCODE -ne 0) { break }   # not a clean fast-forward -> stop, don't loop
        continue
      }
      break   # already tried the ff-only merge once and it's still rejected -> stop
    }
    if ($attempt -lt 3) { Start-Sleep -Seconds 5 }
  }
  if ($pushExit -eq 0) {
    $localSha  = (& $git -C $repo rev-parse HEAD).Trim()
    $remoteRef = & $git -C $repo ls-remote $pushUrl refs/heads/main 2>$null
    $remoteSha = if ($remoteRef) { ($remoteRef -split "`t")[0].Trim() } else { '' }
    if (-not $remoteRef) {
      Write-SyncLog "$stamp`tcommitted+pushed but VERIFY-INCONCLUSIVE (ls-remote returned nothing) sha=$localSha"
    } elseif ($remoteSha -eq $localSha) {
      & $git -C $repo update-ref refs/remotes/origin/main $localSha 2>$null   # keep local tracking ref honest
      Write-SyncLog "$stamp`tcommitted+pushed+verified sha=$localSha"
    } else {
      Write-SyncLog "$stamp`tcommitted+pushed but VERIFY-MISMATCH local=$localSha remote=$remoteSha"
    }
  } else {
    Write-SyncLog "$stamp`tPUSH-FAILED after $attempt attempt(s) (exit $pushExit): $pushOutRedacted"
    exit 1
  }
}

# Runs on EVERY cycle, including "no local changes" -- so a push that silently failed after
# a PRIOR cycle's successful commit can never hide behind a later no-op cycle forever.
function Verify-RemoteMatchesLocal([string]$stamp) {
  if (-not $pushUrl) { return }
  $localSha = (& $git -C $repo rev-parse HEAD).Trim()
  $remoteRefLine = & $git -C $repo ls-remote $pushUrl refs/heads/main 2>$null
  if (-not $remoteRefLine) {
    Write-SyncLog "$stamp`tVERIFY-INCONCLUSIVE (ls-remote returned nothing; local=$localSha)"
    return
  }
  $remoteSha = ($remoteRefLine -split "`t")[0].Trim()
  if ($remoteSha -eq $localSha) {
    & $git -C $repo update-ref refs/remotes/origin/main $localSha 2>$null
    return
  }
  Write-SyncLog "$stamp`tno-changes-but-UNPUSHED local=$localSha remote=$remoteSha -> pushing"
  Do-Push -stamp $stamp
}

# 2) stage + commit only if something changed
& $git -C $repo add -A
$changes = & $git -C $repo status --porcelain
$stamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')

if (-not $changes) {
  Write-SyncLog "$stamp`tno-changes"
  Verify-RemoteMatchesLocal -stamp $stamp
  exit 0
}

# Defense-in-depth size guard: refuse to commit/push if anything staged looks like it escaped
# the data/* gitignore -- the ONLY thing protecting the 2GB+ ledger/browser-cache tree from
# ever being swept in by `git add -A`. Catches a broken/edited .gitignore line immediately
# instead of silently pushing gigabytes on the next changed byte.
$MAX_FILE_BYTES = 40MB
$changedFiles = @()
foreach ($line in $changes) {
  $statusCode = $line.Substring(0, 2)
  $rest = $line.Substring(3)
  if ($rest -match '^(.*) -> (.*)$') { $rest = $matches[2] }   # rename: "old -> new" -> keep new path
  $rest = $rest.Trim('"')
  $changedFiles += $rest
  if ($statusCode.Trim() -eq 'D') { continue }   # deleted files have no size to check
  $full = Join-Path $repo $rest
  $item = Get-Item -LiteralPath $full -ErrorAction SilentlyContinue
  if ($item -and $item.Length -gt $MAX_FILE_BYTES) {
    Write-SyncLog "$stamp`tABORTED-OVERSIZED-FILE $rest ($([math]::Round($item.Length / 1MB, 1))MB) -> commit/push skipped, investigate .gitignore"
    & $git -C $repo reset -q   # unstage everything, leave working tree untouched
    exit 1
  }
}

& $git -C $repo commit -q -m "auto-sync $stamp"
if ($LASTEXITCODE -ne 0) {
  Write-SyncLog "$stamp`tCOMMIT-FAILED (exit $LASTEXITCODE) files=$($changedFiles -join ';')"
  exit 1
}

Do-Push -stamp $stamp
exit 0
