# ============================================================
#  Facebook Agent - auto-sync to GitHub
#  Refreshes the claude-memory copy from the live memory dir,
#  commits any changes to tracked files (workflow-state.json,
#  .hermes plans, claude-memory, code), and pushes to GitHub.
#  Intended to run on a schedule (see setup in deployment/README.md).
#  Token is read from data/.git-sync-token (gitignored) - NEVER committed.
# ============================================================
$ErrorActionPreference = 'SilentlyContinue'
$repo = Split-Path $PSScriptRoot -Parent            # repo root = parent of deployment/
$git  = Join-Path $repo '.tooling\mingit\cmd\git.exe'
if (-not (Test-Path $git)) { $c = Get-Command git -ErrorAction SilentlyContinue; if ($c) { $git = $c.Source } }
if (-not (Test-Path $git)) { "no git available"; exit 1 }
$env:HOME = $repo
$log = Join-Path $repo 'data\auto-sync.log'

# 1) refresh the in-repo copy of the live Claude/Hermes memory
$liveMem = Join-Path $env:USERPROFILE '.claude\projects\C--Users-Administrator\memory'
if (Test-Path $liveMem) {
  New-Item -ItemType Directory -Force -Path (Join-Path $repo 'claude-memory') | Out-Null
  Copy-Item (Join-Path $liveMem '*.md') (Join-Path $repo 'claude-memory') -Force
}

# 2) stage + commit only if something changed
& $git -C $repo add -A
$changes = & $git -C $repo status --porcelain
if (-not $changes) { Add-Content $log "$([DateTime]::UtcNow.ToString('o'))`tno-changes"; exit 0 }
$stamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
& $git -C $repo commit -q -m "auto-sync $stamp"

# 3) push using the dedicated token (data/.git-sync-token), if present
$tf = Join-Path $repo 'data\.git-sync-token'
if (Test-Path $tf) {
  $t = (Get-Content $tf -Raw).Trim()
  & $git -C $repo push "https://$t@github.com/last-million/facebook-agent.git" HEAD:main 2>$null
  Add-Content $log "$stamp`tcommitted+pushed"
} else {
  Add-Content $log "$stamp`tcommitted-locally (no data/.git-sync-token -> push skipped)"
}
