# deployment/ — one-shot deploy + auto-sync

Scripts a future agent (or you) can run to stand the system up on a new machine,
and to keep the GitHub repo continuously in sync with the live machine.

## Files
| File | Runs on | Does |
|------|---------|------|
| `deploy.bat` | Windows (admin cmd) | Installs the **Node dashboard** side: checks Node, clones the repo, `npm install`, registers the keep-alive watchdog, then calls `deploy.sh` in WSL. |
| `deploy.sh` | WSL / Linux | Installs the **Hermes CLI** (`/root/.local/bin/hermes`) + scaffolds `~/.hermes/.env`. **You must set `HERMES_INSTALL_CMD`** (see below). |
| `auto-sync.ps1` | Windows | Refreshes `claude-memory/` from the live memory, commits changed tracked files, pushes to GitHub. |

## Deploy on a new machine
1. Install **Node.js** + **Git for Windows** + **WSL** (`wsl --install`) + **ixBrowser**.
2. Open an **admin Command Prompt** and run:
   ```cmd
   git clone https://github.com/last-million/facebook-agent.git "%USERPROFILE%\Desktop\facbeook agent"
   "%USERPROFILE%\Desktop\facbeook agent\deployment\deploy.bat"
   ```
3. Follow the "NEXT STEPS" the script prints (re-enter secrets, log into ixBrowser, restore memory).

### Hermes install command
`deploy.sh` needs your Hermes install command. Either edit `HERMES_INSTALL_CMD` in the
file, or pass it in:
```bash
HERMES_INSTALL_CMD="<your hermes install command>" bash deployment/deploy.sh
```

## Auto-sync (keep GitHub up to date automatically)
`auto-sync.ps1` commits + pushes changes to `workflow-state.json`, `.hermes/` plans,
`claude-memory/`, and code. To enable pushing, drop a **dedicated fine-grained GitHub
token** (scope: *Contents: read/write* on `facebook-agent` only) into:
```
data\.git-sync-token        (gitignored — never committed)
```
Then register the scheduled task (runs every 30 min, as SYSTEM):
```powershell
$s = "$env:USERPROFILE\Desktop\facbeook agent\deployment\auto-sync.ps1"
$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "'+$s+'"')
$t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 30)
$p = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'FB-Agent-AutoSync' -Action $a -Trigger $t -Principal $p -Force
```
Without the token file it still **commits locally** every 30 min (you can push manually).

> Security: `data\.git-sync-token` and `data\secrets.local.json` are gitignored and
> never leave the machine. Use a fine-grained, repo-scoped token for auto-sync.
