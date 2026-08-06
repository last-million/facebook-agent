# deployment/ — one-shot deploy + auto-sync

Scripts a future agent (or you) can run to stand the system up on a new machine,
and to keep the GitHub repo continuously in sync with the live machine.

## Files
| File | Runs on | Does |
|------|---------|------|
| `deploy.bat` | Windows | **Start here on Windows.** Self-elevates and runs `bootstrap.ps1`. |
| `bootstrap.ps1` | Windows | The real installer: Node.js, Git, repo, npm deps, data dir, keep-alive watchdog, WSL+Ubuntu, then Hermes inside WSL. |
| `deploy.sh` | Linux / WSL / macOS | **Start here on Linux.** Base packages, uv, Node.js, npm deps, Hermes, `~/.hermes/.env`, data dir. |
| `reapply-hermes-customizations.sh` | Linux / WSL | Re-applies our Hermes customizations (`SOUL.md`, config, custom tools, source patches) after a Hermes update wipes them. Idempotent; `deploy.sh` runs it automatically on every deploy. |
| `auto-sync.ps1` | Windows | Refreshes `claude-memory/` from the live memory, commits changed tracked files, pushes to GitHub. |

## Deploy on a brand-new machine

Both ways of getting the files are supported, and the installer works out which one
you used. You do **not** need to pre-install anything.

### A. You have the folder already (ZIP download, or a copy on a USB stick)

This is the flow to use when the repo is **private** — download the ZIP once, carry it
on a USB stick, and run it on any machine. **No Git needed, nothing is cloned.**

```cmd
:: Windows - extract anywhere (any folder name, any drive), then:
<extracted folder>\deployment\deploy.bat
```
```bash
# Linux / macOS
bash <extracted folder>/deployment/deploy.sh
```

The installer installs **in place**, into the folder you ran it from. It prints
`Mode: installing IN PLACE` so you can see it picked up your copy.

> Running from a USB stick works, but copy the folder to the local disk before running
> production — the watchdog keeps restarting the server, and that path disappears the
> moment you unplug the drive. The installer warns you if it sees a removable drive.

### B. You want it to download the project for you (public repo)

```cmd
git clone https://github.com/last-million/facebook-agent.git "%USERPROFILE%\Desktop\facbeook agent"
"%USERPROFILE%\Desktop\facbeook agent\deployment\deploy.bat"
```
```bash
git clone https://github.com/last-million/facebook-agent.git ~/facebook-agent
bash ~/facebook-agent/deployment/deploy.sh
```

You can also run `bootstrap.ps1` on its own with no project next to it; it falls back to
cloning into `%USERPROFILE%\Desktop\facbeook agent` and installs Git first if needed.

Both installers:
- **skip whatever is already installed** — safe to re-run as often as you like;
- **update the code on every re-run**: on a git clone they `git pull --ff-only`
  first (deploy.sh even re-execs itself so the rest of the run uses the new
  code), and if the dashboard is running code older than the files on disk they
  **restart it onto the current code** automatically. ZIP copies have no git —
  re-download the ZIP and re-run the installer over the folder instead;
- **report before they change anything** with `deploy.bat /check` or `deploy.sh --check`,
  which installs nothing and exits non-zero if something is missing;
- **end with the list of manual steps** that genuinely cannot be scripted (ixBrowser +
  Facebook logins, API keys, `~/.hermes/.env`).

On a bare Windows box WSL needs **one reboot**. The script tells you, then you run
`deploy.bat` again and it picks up where it left off.

### Notes
- **No Playwright browser download.** `package.json` pins `playwright-core`, and the
  connector only ever calls `chromium.connectOverCDP()` against ixBrowser's own Chrome —
  it never launches a bundled browser.
- **Hermes** is verified at exactly `/root/.local/bin/hermes`, because that is the path
  `server.js` shells out to (`HERMES_BIN`). Being elsewhere on `PATH` is not enough.
- `deploy.sh` is a full installer on its own; `bootstrap.ps1` calls it with
  `FB_HERMES_ONLY=1` so it does the Hermes half only (the dashboard runs on the Windows
  Node, so a second Node inside WSL would be waste).
- **ixBrowser has no Linux build.** A pure-Linux host can run the dashboard and Hermes,
  but the posting/commenting side needs ixBrowser reachable over its Local API.

## Hermes customizations (survive updates)
`hermes-config/` carries everything we changed on top of stock Hermes, so a fresh
deploy — or a Hermes update — never loses it:

| What | Where it lands | Notes |
|------|----------------|-------|
| `SOUL.md` | `~/.hermes/SOUL.md` | agent persona |
| `skills_prompt_snapshot.json` | `~/.hermes/.skills_prompt_snapshot.json` | skills prompt cache (auto-sync refreshes the repo copy from WSL every cycle) |
| `config.yaml` | `~/.hermes/config.yaml` | our model order/providers. **api_key fields are empty** — keys live in `~/.hermes/.env`, never here. Copied only when missing; `--force-config` overwrites. |
| `custom/facebook-agent/*` | `~/.hermes/custom/facebook-agent/` | humanize-browser prompt + pointer tools |
| `tools/*.py` | `hermes-agent/tools/` | pointer primitives registered inside Hermes |
| `patches/*.patch` | applied onto the `hermes-agent` checkout | websocket heartbeat/host fixes + SessionsPage tweak |

After any **manual** Hermes update, re-apply by hand (deploy does it for you):
```bash
bash deployment/reapply-hermes-customizations.sh
```
If a Hermes update changes the same upstream lines, the patch refuses to apply and
the script says so. Re-apply the intent by hand in `~/.hermes/hermes-agent`, then
regenerate the patch:
```bash
git -C ~/.hermes/hermes-agent diff > hermes-config/patches/hermes-local-fixes.patch
```
The pipx install is **editable**, so patched Python files are live immediately — no
reinstall. A patch that touches `web/` needs the Hermes web UI rebuilt if you use it.

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
